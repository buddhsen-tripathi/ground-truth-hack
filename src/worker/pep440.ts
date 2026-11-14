// PEP 440 version parsing and ordering for PyPI packages (the subset OSV ranges and the fix planner need).

const PATTERN =
  /^\s*v?(?:(\d+)!)?(\d+(?:\.\d+)*)(?:[-_.]?(a|b|c|rc|alpha|beta|pre|preview)[-_.]?(\d+)?)?(?:-(\d+)|[-_.]?(post|rev|r)[-_.]?(\d+)?)?(?:[-_.]?(dev)[-_.]?(\d+)?)?(?:\+([a-z0-9]+(?:[-_.][a-z0-9]+)*))?\s*$/i;

export interface Pep440 {
  epoch: number;
  release: number[];
  pre: [string, number] | null;
  post: number | null;
  dev: number | null;
  local: string | null;
}

const PRE_NAMES: Record<string, string> = { a: "a", alpha: "a", b: "b", beta: "b", c: "rc", rc: "rc", pre: "rc", preview: "rc" };
const PRE_RANK: Record<string, number> = { a: 0, b: 1, rc: 2 };

export function parse(version: string): Pep440 | null {
  const m = PATTERN.exec(version);
  if (!m) return null;
  return {
    epoch: m[1] ? Number(m[1]) : 0,
    release: m[2]!.split(".").map(Number),
    pre: m[3] ? [PRE_NAMES[m[3].toLowerCase()]!, Number(m[4] ?? 0)] : null,
    post: m[5] !== undefined ? Number(m[5]) : m[6] ? Number(m[7] ?? 0) : null,
    dev: m[8] ? Number(m[9] ?? 0) : null,
    local: m[10] ?? null,
  };
}

export const valid = (version: string) => parse(version) !== null;

/** Sort key per PEP 440: dev releases sort before pre-releases, which sort before the final release, then post releases. */
function key(v: Pep440): number[] {
  const release = [...v.release];
  while (release.length > 1 && release[release.length - 1] === 0) release.pop();
  const pre = v.pre ? [PRE_RANK[v.pre[0]]!, v.pre[1]] : v.post === null && v.dev !== null ? [-1, 0] : [3, 0];
  const post = v.post === null ? -1 : v.post;
  const dev = v.dev === null ? Number.POSITIVE_INFINITY : v.dev;
  return [v.epoch, release.length, ...release, ...pre, post, dev];
}

function compareReleases(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

export function compare(a: string, b: string): number {
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return a < b ? -1 : a > b ? 1 : 0;
  if (pa.epoch !== pb.epoch) return pa.epoch < pb.epoch ? -1 : 1;
  const r = compareReleases(pa.release, pb.release);
  if (r) return r;
  // Release segments are equal; the rest of the key is pre, post, dev.
  const ka = key(pa).slice(2 + trimmed(pa.release));
  const kb = key(pb).slice(2 + trimmed(pb.release));
  for (let i = 0; i < Math.max(ka.length, kb.length); i++) {
    const x = ka[i] ?? 0;
    const y = kb[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return (pa.local ?? "") < (pb.local ?? "") ? -1 : (pa.local ?? "") > (pb.local ?? "") ? 1 : 0;
}

function trimmed(release: number[]): number {
  let n = release.length;
  while (n > 1 && release[n - 1] === 0) n--;
  return n;
}

export const isPrerelease = (version: string) => {
  const p = parse(version);
  return !!p && (p.pre !== null || p.dev !== null);
};

export const major = (version: string) => parse(version)?.release[0] ?? null;

/** PEP 503 name normalization: PyPI treats "PyYAML", "pyyaml" and "py_yaml" as the same project. */
export const normalizeName = (name: string) => name.trim().toLowerCase().replace(/[-_.]+/g, "-");
