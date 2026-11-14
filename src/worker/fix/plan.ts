import { ecosystemOf, type FixEcosystem, type FixIncidentRef, type FixPlan, type Incident, type LockfileFix, type Manager, type PackageFix, type SkippedFix } from "@shared/types";
import type { AppEnv } from "../env";
import { INCIDENT_SELECT, rowToIncident } from "../db";
import { getPackument, type Packument } from "../integrations/npm-registry";
import { getPypiReleases } from "../integrations/pypi";
import { lockfileDir, managerFor } from "../lockfiles";
import { chooseTarget, schemeFor, type Affected } from "../versions";

type PlanIncident = Pick<Incident, "id" | "kind" | "severity" | "title" | "affected">;

const RANK: Record<string, number> = { critical: 0, high: 1, moderate: 2, low: 3 };
const urgency = (incidents: FixIncidentRef[]) => Math.min(...incidents.map((i) => (i.kind === "malicious" ? -1 : (RANK[i.severity ?? ""] ?? 4))));
const ref = (i: PlanIncident): FixIncidentRef => ({ id: i.id, kind: i.kind, severity: i.severity, title: i.title });

/**
 * Picks the version for one package in one lockfile. The target has to clear every advisory that hits the package here
 * (`incidents`) and every other known advisory for it (`others`).
 */
export function planPackage(args: {
  ecosystem: FixEcosystem;
  manager: Manager;
  lockfile: string;
  package: string;
  versions: string[];
  direct: boolean;
  incidents: PlanIncident[];
  others: Affected[];
  pack: Packument;
}): PackageFix | { skip: string } {
  const S = schemeFor(args.ecosystem);
  const from = [...args.versions].sort((a, b) => (S.valid(a) && S.valid(b) ? S.cmp(a, b) : 0)).at(-1)!;
  const malicious = args.incidents.some((i) => i.kind === "malicious");
  const merged = {
    kind: malicious ? ("malicious" as const) : ("vulnerability" as const),
    affected: { versions: args.incidents.flatMap((i) => i.affected.versions), ranges: args.incidents.flatMap((i) => i.affected.ranges) },
  };
  const target = chooseTarget(merged, from, args.pack, args.others, args.ecosystem);
  if (!target) return { skip: `No release of ${args.package} clears every known advisory.` };
  // Pinned requirements files list every package, so each pin is edited in place.
  const direct = args.direct || args.manager === "pip";
  const strategy = direct ? target.strategyHint : "override";
  const how = args.ecosystem === "PyPI" ? "a uv constraint" : "an override";
  const cleared = args.incidents.length + args.others.length;
  return {
    key: `${args.lockfile}::${args.package}`,
    package: args.package,
    from: args.versions,
    to: target.to,
    strategy,
    direct,
    exact: malicious || strategy === "pin-back",
    incidents: args.incidents.map(ref),
    reason:
      (direct ? target.reason : `${args.package} is a transitive dependency, so it's forced with ${how}. ${target.reason}`) +
      (cleared > 1 ? ` It clears all ${cleared} known advisories for ${args.package}.` : ""),
  };
}

const registry = (ecosystem: FixEcosystem, name: string) => (ecosystem === "PyPI" ? getPypiReleases(name) : getPackument(name));

/** Every exposure in the repo, grouped by lockfile and package, with a target version for each (or why there isn't one). */
export async function planRepoFix(env: AppEnv, repoId: string): Promise<FixPlan> {
  const rows = await env.DB.prepare(
    `SELECT e.version, e.lockfile, e.direct, i.* FROM exposures e JOIN incidents i ON i.id = e.incident_id WHERE e.repo_id = ?`,
  )
    .bind(repoId)
    .all<Record<string, unknown> & { version: string; lockfile: string; direct: number }>();

  const groups = new Map<string, { lockfile: string; ecosystem: string; package: string; versions: Set<string>; direct: boolean; incidents: Map<string, Incident> }>();
  for (const r of rows.results) {
    const incident = rowToIncident(r);
    const key = `${r.lockfile}::${incident.package}`;
    const g = groups.get(key) ?? { lockfile: r.lockfile, ecosystem: incident.ecosystem, package: incident.package, versions: new Set<string>(), direct: false, incidents: new Map() };
    g.versions.add(r.version);
    g.direct ||= !!r.direct;
    g.incidents.set(incident.id, incident);
    groups.set(key, g);
  }

  const targets = new Map<string, LockfileFix>();
  const skipped: SkippedFix[] = [];
  await Promise.all(
    [...groups].map(async ([key, g]) => {
      const incidents = [...g.incidents.values()];
      const skip = (reason: string) =>
        skipped.push({ key, package: g.package, ecosystem: g.ecosystem, lockfile: g.lockfile, versions: [...g.versions], incidents: incidents.map(ref), reason });
      const manager = managerFor(g.lockfile);
      if (g.ecosystem === "GitHub Actions") return skip("Pin the action to a full commit SHA in the workflow; Firebreak doesn't edit workflows.");
      if (!manager || (g.ecosystem !== "npm" && g.ecosystem !== "PyPI")) return skip(`Automatic fixes cover npm and PyPI; this is ${g.ecosystem}.`);
      const ecosystem = ecosystemOf(manager);
      if (ecosystem !== g.ecosystem) return skip(`${g.lockfile} is a ${ecosystem} lockfile, but the advisory is for ${g.ecosystem}.`);
      try {
        const [pack, others] = await Promise.all([
          registry(ecosystem, g.package),
          env.DB.prepare(`${INCIDENT_SELECT} WHERE i.ecosystem = ? AND i.package = ?`).bind(g.ecosystem, g.package).all(),
        ]);
        const rest = others.results.map(rowToIncident).filter((i) => !g.incidents.has(i.id)).map((i) => i.affected);
        const fix = planPackage({ ecosystem, manager, lockfile: g.lockfile, package: g.package, versions: [...g.versions], direct: g.direct, incidents, others: rest, pack });
        if ("skip" in fix) return skip(fix.skip);
        const t = targets.get(g.lockfile) ?? { lockfile: g.lockfile, dir: lockfileDir(g.lockfile, manager), manager, ecosystem, packages: [] };
        t.packages.push(fix);
        targets.set(g.lockfile, t);
      } catch (e) {
        skip(`Couldn't read ${g.package}'s releases: ${(e as Error).message}`);
      }
    }),
  );
  const list = [...targets.values()].sort((a, b) => a.lockfile.localeCompare(b.lockfile));
  for (const t of list) t.packages.sort((a, b) => urgency(a.incidents) - urgency(b.incidents) || a.package.localeCompare(b.package));
  skipped.sort((a, b) => urgency(a.incidents) - urgency(b.incidents) || a.package.localeCompare(b.package));
  return { targets: list, skipped };
}

/** Keeps only the checked packages; lockfiles left with nothing to change are dropped. */
export function pickFromPlan(plan: FixPlan, keys: string[]): FixPlan {
  const want = new Set(keys);
  const targets = plan.targets.map((t) => ({ ...t, packages: t.packages.filter((p) => want.has(p.key)) })).filter((t) => t.packages.length);
  return { targets, skipped: [] };
}
