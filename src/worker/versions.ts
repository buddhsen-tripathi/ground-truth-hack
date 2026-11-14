import semver from "semver";
import type { Incident } from "@shared/types";
import type { Packument } from "./integrations/npm-registry";
import * as pep440 from "./pep440";

export type Affected = Incident["affected"];

/** Version rules per ecosystem: semver for npm (and anything else), PEP 440 for PyPI. */
interface Scheme {
  /** Normalized version, or null when the string isn't a version under this scheme. */
  valid(v: string): string | null;
  /** Like valid, but accepts loose bounds such as "1.2" (OSV "introduced" values). */
  loose(v: string): string | null;
  cmp(a: string, b: string): number;
  major(v: string): number | null;
  prerelease(v: string): boolean;
}

const SEMVER: Scheme = {
  valid: (v) => semver.valid(v),
  loose: (v) => semver.valid(semver.coerce(v)?.version ?? v),
  cmp: (a, b) => semver.compare(a, b),
  major: (v) => (semver.valid(v) ? semver.major(v) : null),
  prerelease: (v) => !!semver.prerelease(v),
};

const PEP440: Scheme = {
  valid: (v) => (pep440.valid(v) ? v : null),
  loose: (v) => (pep440.valid(v) ? v : null),
  cmp: pep440.compare,
  major: pep440.major,
  prerelease: pep440.isPrerelease,
};

export const schemeFor = (ecosystem = "npm"): Scheme => (ecosystem === "PyPI" ? PEP440 : SEMVER);

export function isAffected(version: string, affected: Affected, ecosystem = "npm"): boolean {
  if (affected.versions.includes(version)) return true;
  const S = schemeFor(ecosystem);
  const v = S.valid(version);
  if (!v) return false;
  // PEP 440 treats 1.0 and 1.0.0 as the same release.
  if (ecosystem === "PyPI" && affected.versions.some((a) => S.valid(a) && S.cmp(a, v) === 0)) return true;
  return affected.ranges.some((r) => {
    const intro = r.introduced && r.introduced !== "0" ? S.loose(r.introduced) : null;
    if (r.introduced && r.introduced !== "0" && !intro) return false;
    if (intro && S.cmp(v, intro) < 0) return false;
    if (r.fixed) {
      const fixed = S.valid(r.fixed);
      return fixed ? S.cmp(v, fixed) < 0 : false;
    }
    if (r.lastAffected) {
      const last = S.valid(r.lastAffected);
      return last ? S.cmp(v, last) <= 0 : false;
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
  ecosystem = "npm",
): { to: string; strategyHint: "upgrade" | "pin-back"; reason: string } | null {
  const S = schemeFor(ecosystem);
  const fromV = S.valid(from);
  const stable = pack.versions.filter((v) => S.valid(v) && !S.prerelease(v) && !pack.deprecated.has(v)).sort(S.cmp);
  const clean = stable.filter((v) => !isAffected(v, incident.affected, ecosystem) && !avoid.some((a) => isAffected(v, a, ecosystem)));
  if (!clean.length) return null;
  const major = fromV ? S.major(fromV) : null;
  const sameMajor = clean.filter((v) => major === null || S.major(v) === major);

  if (incident.kind === "vulnerability") {
    const fixedVersions = incident.affected.ranges.map((r) => r.fixed).filter((f): f is string => !!f && !!S.valid(f));
    const above = (vs: string[]) => vs.filter((v) => !fromV || S.cmp(v, fromV) > 0);
    const inMajor = above(sameMajor).filter((v) => fixedVersions.length === 0 || fixedVersions.some((f) => S.cmp(v, f) >= 0));
    if (inMajor[0]) return { to: inMajor[0], strategyHint: "upgrade", reason: `${inMajor[0]} is the first clean release in ${major}.x above ${from}.` };
    const anyAbove = above(clean);
    if (anyAbove[0]) return { to: anyAbove[0], strategyHint: "upgrade", reason: `No patched ${major}.x release; ${anyAbove[0]} is the first clean release, a major upgrade.` };
    return null;
  }

  // Malicious: avoid anything published alongside the bad versions unless a fixed bound says it's clean.
  const fixedAbove = incident.affected.ranges
    .map((r) => r.fixed)
    .filter((f): f is string => !!f && !!S.valid(f) && (!fromV || S.cmp(f, fromV) > 0))
    .sort(S.cmp);
  if (fixedAbove[0] && clean.includes(fixedAbove[0])) {
    return { to: fixedAbove[0], strategyHint: "upgrade", reason: `${fixedAbove[0]} is the maintainers' clean release after the compromise.` };
  }
  const badVersions = [...incident.affected.versions, ...incident.affected.ranges.map((r) => r.introduced).filter((v): v is string => !!v && v !== "0")]
    .filter((v) => S.valid(v))
    .sort(S.cmp);
  const firstBad = badVersions[0];
  const before = sameMajor.filter((v) => !firstBad || S.cmp(v, firstBad) < 0);
  const pick = before.at(-1) ?? clean.filter((v) => !firstBad || S.cmp(v, firstBad) < 0).at(-1);
  if (pick) return { to: pick, strategyHint: "pin-back", reason: `${pick} is the newest release published before the first compromised version${firstBad ? ` (${firstBad})` : ""}.` };
  return null;
}

