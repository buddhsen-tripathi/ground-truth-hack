import type { AffectedRange, Incident, Severity, Source } from "@shared/types";

const OSV = "https://api.osv.dev/v1";

export interface OsvQuery {
  ecosystem: string;
  name: string;
  version: string;
}

/** Returns, for each query, the ids of the vulnerabilities that affect that exact version. */
export async function queryBatch(queries: OsvQuery[]): Promise<string[][]> {
  const out: string[][] = [];
  for (let i = 0; i < queries.length; i += 1000) {
    const chunk = queries.slice(i, i + 1000);
    const res = await fetch(`${OSV}/querybatch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ queries: chunk.map((q) => ({ package: { name: q.name, ecosystem: q.ecosystem }, version: q.version })) }),
    });
    if (!res.ok) throw new Error(`OSV querybatch ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = (await res.json()) as { results: { vulns?: { id: string }[] }[] };
    for (const r of data.results) out.push((r.vulns ?? []).map((v) => v.id));
  }
  return out;
}

interface OsvVuln {
  id: string;
  summary?: string;
  details?: string;
  aliases?: string[];
  published?: string;
  modified?: string;
  database_specific?: { severity?: string };
  references?: { type: string; url: string }[];
  affected?: {
    package?: { name: string; ecosystem: string };
    versions?: string[];
    ranges?: { type: string; events: Record<string, string>[] }[];
  }[];
}

export async function getVuln(id: string): Promise<OsvVuln> {
  const res = await fetch(`${OSV}/vulns/${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error(`OSV vulns/${id} ${res.status}`);
  return (await res.json()) as OsvVuln;
}

function rangesFrom(events: Record<string, string>[]): AffectedRange[] {
  const ranges: AffectedRange[] = [];
  let current: AffectedRange | null = null;
  for (const e of events) {
    if (e.introduced !== undefined) {
      if (current) ranges.push(current);
      current = { introduced: e.introduced };
    } else if (e.fixed !== undefined) {
      ranges.push({ ...(current ?? {}), fixed: e.fixed });
      current = null;
    } else if (e.last_affected !== undefined) {
      ranges.push({ ...(current ?? {}), lastAffected: e.last_affected });
      current = null;
    }
  }
  if (current) ranges.push(current);
  return ranges;
}

const SEVERITIES: Record<string, Severity> = { CRITICAL: "critical", HIGH: "high", MODERATE: "moderate", MEDIUM: "moderate", LOW: "low" };

/** Maps an OSV record to an incident about one package (an OSV record can cover several). */
export function toIncident(v: OsvVuln, ecosystem: string, name: string, detectedAt: string): Omit<Incident, "exposureCount"> {
  const malicious = v.id.startsWith("MAL-");
  const affected = (v.affected ?? []).filter((a) => a.package?.name === name && a.package?.ecosystem === ecosystem);
  const versions = affected.flatMap((a) => a.versions ?? []);
  const ranges = affected.flatMap((a) => (a.ranges ?? []).filter((r) => r.type !== "GIT").flatMap((r) => rangesFrom(r.events)));
  const sources: Source[] = [{ kind: "osv", title: `${v.id} on OSV`, url: `https://osv.dev/vulnerability/${v.id}`, publishedAt: v.published }];
  for (const ref of (v.references ?? []).slice(0, 8)) {
    sources.push({ kind: ref.type === "ADVISORY" ? "advisory" : "news", title: new URL(ref.url).hostname + new URL(ref.url).pathname.slice(0, 60), url: ref.url });
  }
  const title = v.summary?.trim() || (malicious ? `Malicious code in ${name}` : `Vulnerability in ${name}`);
  return {
    id: v.id,
    kind: malicious ? "malicious" : "vulnerability",
    status: "confirmed",
    ecosystem,
    package: name,
    title,
    summary: (v.details ?? "").slice(0, 2000),
    severity: malicious ? "critical" : (SEVERITIES[(v.database_specific?.severity ?? "").toUpperCase()] ?? null),
    aliases: v.aliases ?? [],
    affected: { versions, ranges },
    sources,
    publishedAt: v.published ?? null,
    detectedAt,
  };
}
