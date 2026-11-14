import semver from "semver";
import type { FixPlan, Incident, Manager } from "@shared/types";
import type { Packument } from "./integrations/npm-registry";

type Affected = Incident["affected"];

export function isAffected(version: string, affected: Affected): boolean {
  if (affected.versions.includes(version)) return true;
  const v = semver.valid(version);
  if (!v) return false;
  return affected.ranges.some((r) => {
    const intro = r.introduced && r.introduced !== "0" ? semver.valid(semver.coerce(r.introduced)?.version ?? r.introduced) : null;
    if (r.introduced && r.introduced !== "0" && !intro) return false;
    if (intro && semver.lt(v, intro)) return false;
    if (r.fixed) {
      const fixed = semver.valid(r.fixed);
      return fixed ? semver.lt(v, fixed) : false;
    }
    if (r.lastAffected) {
      const last = semver.valid(r.lastAffected);
      return last ? semver.lte(v, last) : false;
    }
    // Only an "introduced" bound: everything after it is affected.
    return affected.ranges.length > 0 && (!!intro || r.introduced === "0");
  });
}

/**
 * Picks the version to move to:
 *   vulnerability → the smallest fixed version above `from` (same major first; a major bump if that's the only fix).
 *   malicious     → a clean release after the bad ones if one exists, otherwise the newest clean release before them.
 */
export function chooseTarget(
  incident: Pick<Incident, "kind" | "affected">,
  from: string,
  pack: Packument,
  /** Every other known advisory for the package: the target must avoid these too. */
  avoid: Affected[] = [],
): { to: string; strategyHint: "upgrade" | "pin-back"; reason: string } | null {
  const fromV = semver.valid(from);
  const stable = pack.versions.filter((v) => semver.valid(v) && !semver.prerelease(v) && !pack.deprecated.has(v)).sort(semver.compare);
  const clean = stable.filter((v) => !isAffected(v, incident.affected) && !avoid.some((a) => isAffected(v, a)));
  if (!clean.length) return null;
  const major = fromV ? semver.major(fromV) : null;
  const sameMajor = clean.filter((v) => major === null || semver.major(v) === major);

  if (incident.kind === "vulnerability") {
    const fixedVersions = incident.affected.ranges.map((r) => r.fixed).filter((f): f is string => !!f && !!semver.valid(f));
    const above = (vs: string[]) => vs.filter((v) => !fromV || semver.gt(v, fromV));
    const inMajor = above(sameMajor).filter((v) => fixedVersions.length === 0 || fixedVersions.some((f) => semver.gte(v, f)));
    if (inMajor[0]) return { to: inMajor[0], strategyHint: "upgrade", reason: `${inMajor[0]} is the first clean release in ${major}.x above ${from}.` };
    const anyAbove = above(clean);
    if (anyAbove[0]) return { to: anyAbove[0], strategyHint: "upgrade", reason: `No patched ${major}.x release; ${anyAbove[0]} is the first clean release, a major upgrade.` };
    return null;
  }

  // Malicious: avoid anything published alongside the bad versions unless a fixed bound says it's clean.
  const fixedAbove = incident.affected.ranges
    .map((r) => r.fixed)
    .filter((f): f is string => !!f && !!semver.valid(f) && (!fromV || semver.gt(f, fromV)))
    .sort(semver.compare);
  if (fixedAbove[0] && clean.includes(fixedAbove[0])) {
    return { to: fixedAbove[0], strategyHint: "upgrade", reason: `${fixedAbove[0]} is the maintainers' clean release after the compromise.` };
  }
  const badVersions = [...incident.affected.versions, ...incident.affected.ranges.map((r) => r.introduced).filter((v): v is string => !!v && v !== "0")]
    .filter((v) => semver.valid(v))
    .sort(semver.compare);
  const firstBad = badVersions[0];
  const before = sameMajor.filter((v) => !firstBad || semver.lt(v, firstBad));
  const pick = before.at(-1) ?? clean.filter((v) => !firstBad || semver.lt(v, firstBad)).at(-1);
  if (pick) return { to: pick, strategyHint: "pin-back", reason: `${pick} is the newest release published before the first compromised version${firstBad ? ` (${firstBad})` : ""}.` };
  return null;
}

export function buildPlan(args: {
  incident: Pick<Incident, "kind" | "affected" | "package">;
  from: string;
  lockfile: string;
  manager: Manager;
  direct: boolean;
  pack: Packument;
  avoid?: Affected[];
}): FixPlan | null {
  const target = chooseTarget(args.incident, args.from, args.pack, args.avoid);
  if (!target) return null;
  const others = args.avoid?.length ?? 0;
  const dir = args.lockfile.includes("/") ? args.lockfile.slice(0, args.lockfile.lastIndexOf("/")) : "";
  return {
    strategy: args.direct ? target.strategyHint : "override",
    package: args.incident.package,
    from: args.from,
    to: target.to,
    manager: args.manager,
    lockfile: args.lockfile,
    dir,
    direct: args.direct,
    reason:
      (args.direct ? target.reason : `${args.incident.package} is a transitive dependency, so it's forced with an override. ${target.reason}`) +
      (others ? ` It also clears the ${others} other known advisor${others === 1 ? "y" : "ies"} for ${args.incident.package}.` : ""),
  };
}
