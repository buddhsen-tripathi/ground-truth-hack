export interface Packument {
  versions: string[];
  deprecated: Set<string>;
  latest: string | null;
}

/** Version list from the abbreviated packument (small even for huge packages). */
export async function getPackument(name: string): Promise<Packument> {
  const res = await fetch(`https://registry.npmjs.org/${name.replace("/", "%2F")}`, {
    headers: { Accept: "application/vnd.npm.install-v1+json" },
  });
  if (!res.ok) throw new Error(`npm registry ${res.status} for ${name}`);
  const data = (await res.json()) as { versions: Record<string, { deprecated?: string }>; "dist-tags"?: { latest?: string } };
  const deprecated = new Set(Object.entries(data.versions).filter(([, v]) => v.deprecated).map(([k]) => k));
  return { versions: Object.keys(data.versions), deprecated, latest: data["dist-tags"]?.latest ?? null };
}
