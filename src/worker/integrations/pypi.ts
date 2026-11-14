import type { Packument } from "./npm-registry";

/** Release list from PyPI's JSON API. Yanked releases (every file yanked) count as deprecated; releases with no files are dropped. */
export async function getPypiReleases(name: string): Promise<Packument> {
  const res = await fetch(`https://pypi.org/pypi/${encodeURIComponent(name)}/json`, { headers: { Accept: "application/json", "User-Agent": "firebreak" } });
  if (!res.ok) throw new Error(`PyPI ${res.status} for ${name}`);
  const data = (await res.json()) as { info?: { version?: string }; releases?: Record<string, { yanked?: boolean }[]> };
  const versions: string[] = [];
  const deprecated = new Set<string>();
  for (const [version, files] of Object.entries(data.releases ?? {})) {
    if (!files.length) continue;
    versions.push(version);
    if (files.every((f) => f.yanked)) deprecated.add(version);
  }
  return { versions, deprecated, latest: data.info?.version ?? null };
}
