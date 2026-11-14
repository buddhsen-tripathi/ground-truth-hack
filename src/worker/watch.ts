import type { Incident, Source } from "@shared/types";
import { now, type AppEnv } from "./env";
import { getIncident, rowToIncident, upsertIncident } from "./db";
import { chat, parseJsonReply } from "./integrations/clonvo";
import { listRunsSince } from "./integrations/github";
import { getVuln, queryBatch, toIncident } from "./integrations/osv";
import { search, SECURITY_DOMAINS } from "./integrations/you";
import { isAffected } from "./versions";

const NEWS_QUERIES = [
  "npm packages compromised malicious versions published supply chain attack",
  "GitHub Actions tag hijacked supply chain compromise",
];
const MAX_NEW_VULNS = 40;
const MAX_NEW_ARTICLES = 8;

export interface WatchSummary {
  osvChecked: number;
  newsChecked: number;
  newIncidents: number;
  newExposures: number;
  errors: string[];
}

async function hash(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 10);
}

/** OSV: every resolved dependency version is checked; new advisories become incidents. */
async function syncOsv(env: AppEnv, repoId?: string): Promise<{ checked: number; added: number }> {
  const deps = await env.DB.prepare(
    `SELECT DISTINCT ecosystem, name, version FROM deps ${repoId ? "WHERE repo_id = ?" : ""}`,
  )
    .bind(...(repoId ? [repoId] : []))
    .all<{ ecosystem: string; name: string; version: string }>();
  const queries = deps.results;
  if (!queries.length) return { checked: 0, added: 0 };
  const ids = await queryBatch(queries);
  const known = new Set((await env.DB.prepare("SELECT id FROM incidents").all<{ id: string }>()).results.map((r) => r.id));
  const todo = new Map<string, { ecosystem: string; name: string }>();
  ids.forEach((list, i) => {
    for (const id of list) if (!known.has(id) && !todo.has(id)) todo.set(id, { ecosystem: queries[i]!.ecosystem, name: queries[i]!.name });
  });
  let added = 0;
  for (const [id, pkg] of [...todo].slice(0, MAX_NEW_VULNS)) {
    const vuln = await getVuln(id);
    await upsertIncident(env, toIncident(vuln, pkg.ecosystem, pkg.name, now()));
    added++;
  }
  return { checked: queries.length, added };
}

interface Extracted {
  incidents: { article: number; ecosystem: string; package: string; versions: string[]; kind: "malicious" | "vulnerability" }[];
}

/** You.com news: early reports, before OSV has an entry. A model pulls out named packages and versions. */
async function syncNews(env: AppEnv): Promise<{ checked: number; added: number }> {
  const seen = new Set((await env.DB.prepare("SELECT url FROM seen_articles").all<{ url: string }>()).results.map((r) => r.url));
  const results = (await Promise.all(NEWS_QUERIES.map((q) => search(env, q, { freshness: "day", count: 10, boostDomains: SECURITY_DOMAINS })))).flat();
  const fresh = [...new Map(results.filter((r) => !seen.has(r.url)).map((r) => [r.url, r])).values()].slice(0, MAX_NEW_ARTICLES);
  if (!fresh.length) return { checked: 0, added: 0 };

  const list = fresh.map((r, i) => `[${i}] ${r.title}\n${r.url}\n${r.description}\n${r.snippets.slice(0, 3).join("\n")}`).join("\n\n");
  const reply = await chat(env, env.EXTRACT_MODEL, [
    {
      role: "system",
      content:
        "You extract software supply-chain incidents from news snippets. Only report a package when the text names it AND names specific affected versions. Never guess versions. Ecosystem is one of npm, PyPI, GitHub Actions, RubyGems, crates.io. Reply with JSON only.",
    },
    {
      role: "user",
      content: `Articles:\n\n${list}\n\nReply as {"incidents":[{"article":0,"ecosystem":"npm","package":"name","versions":["1.2.3"],"kind":"malicious"|"vulnerability"}]}. Use an empty list when no article names both a package and versions.`,
    },
  ]);
  let extracted: Extracted = { incidents: [] };
  try {
    extracted = parseJsonReply<Extracted>(reply);
  } catch {
    // An unreadable reply only means no signals this round.
  }

  let added = 0;
  for (const x of extracted.incidents ?? []) {
    const article = fresh[x.article];
    if (!article || !x.package || !x.versions?.length) continue;
    const source: Source = { kind: "news", title: article.title, url: article.url, publishedAt: article.pageAge ?? undefined };
    const confirmed = await env.DB.prepare("SELECT * FROM incidents WHERE ecosystem = ? AND package = ? AND status = 'confirmed'").bind(x.ecosystem, x.package).all();
    const match = confirmed.results.map(rowToIncident).find((i) => x.versions.some((v) => isAffected(v, i.affected)));
    if (match) {
      if (!match.sources.some((s) => s.url === source.url)) await upsertIncident(env, { ...match, sources: [...match.sources, source] });
      continue;
    }
    const id = `SIG-${await hash(`${x.ecosystem}:${x.package}`)}`;
    const prev = await getIncident(env, id);
    const versions = [...new Set([...(prev?.affected.versions ?? []), ...x.versions])];
    const incident: Omit<Incident, "exposureCount"> = {
      id,
      kind: x.kind === "vulnerability" ? "vulnerability" : "malicious",
      status: "unconfirmed",
      ecosystem: x.ecosystem,
      package: x.package,
      title: prev?.title ?? `Reported ${x.kind === "vulnerability" ? "vulnerability" : "compromise"} in ${x.package}`,
      summary: prev?.summary || article.description,
      severity: x.kind === "vulnerability" ? null : "critical",
      aliases: [],
      affected: { versions, ranges: [] },
      sources: prev?.sources.some((s) => s.url === source.url) ? prev.sources : [...(prev?.sources ?? []), source],
      publishedAt: prev?.publishedAt ?? now(),
      detectedAt: prev?.detectedAt ?? now(),
    };
    await upsertIncident(env, incident);
    if (!prev) added++;
  }
  const ins = env.DB.prepare("INSERT OR IGNORE INTO seen_articles (url, seen_at) VALUES (?, ?)");
  await env.DB.batch(fresh.map((r) => ins.bind(r.url, now())));
  return { checked: fresh.length, added };
}

/** Recomputes which repos each incident hits. New exposures to malicious versions get the CI runs since disclosure. */
export async function matchExposures(env: AppEnv): Promise<number> {
  const incidents = (await env.DB.prepare("SELECT * FROM incidents").all()).results.map(rowToIncident);
  const existing = new Set(
    (await env.DB.prepare("SELECT incident_id, repo_id, version, lockfile FROM exposures").all<Record<string, string>>()).results.map(
      (e) => `${e.incident_id}|${e.repo_id}|${e.version}|${e.lockfile}`,
    ),
  );
  const desired = new Map<string, { incident: Incident; repoId: string; fullName: string; version: string; lockfile: string; direct: boolean }>();
  for (const incident of incidents) {
    const deps = await env.DB.prepare("SELECT d.*, r.full_name FROM deps d JOIN repos r ON r.id = d.repo_id WHERE d.ecosystem = ? AND d.name = ?")
      .bind(incident.ecosystem, incident.package)
      .all<{ repo_id: string; full_name: string; version: string; lockfile: string; direct: number }>();
    for (const d of deps.results) {
      if (!isAffected(d.version, incident.affected)) continue;
      desired.set(`${incident.id}|${d.repo_id}|${d.version}|${d.lockfile}`, { incident, repoId: d.repo_id, fullName: d.full_name, version: d.version, lockfile: d.lockfile, direct: !!d.direct });
    }
  }
  const stale = [...existing].filter((k) => !desired.has(k));
  const stmts = stale.map((k) => {
    const [i, r, v, l] = k.split("|");
    return env.DB.prepare("DELETE FROM exposures WHERE incident_id = ? AND repo_id = ? AND version = ? AND lockfile = ?").bind(i, r, v, l);
  });
  let added = 0;
  for (const [key, e] of desired) {
    if (existing.has(key)) continue;
    let ciRuns: unknown[] = [];
    if (e.incident.kind === "malicious") {
      const since = e.incident.publishedAt ?? e.incident.detectedAt;
      ciRuns = await listRunsSince(env, e.fullName, since).catch(() => []);
    }
    stmts.push(
      env.DB.prepare("INSERT INTO exposures (incident_id, repo_id, version, lockfile, direct, ci_runs, detected_at) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(
        e.incident.id,
        e.repoId,
        e.version,
        e.lockfile,
        e.direct ? 1 : 0,
        JSON.stringify(ciRuns),
        now(),
      ),
    );
    added++;
  }
  if (stmts.length) await env.DB.batch(stmts);
  return added;
}

export async function runWatch(env: AppEnv, trigger: "cron" | "manual", repoId?: string): Promise<WatchSummary> {
  const summary: WatchSummary = { osvChecked: 0, newsChecked: 0, newIncidents: 0, newExposures: 0, errors: [] };
  try {
    const osv = await syncOsv(env, repoId);
    summary.osvChecked = osv.checked;
    summary.newIncidents += osv.added;
  } catch (e) {
    summary.errors.push(`OSV: ${(e as Error).message}`);
  }
  if (!repoId && env.YOU_API_KEY && env.CLONVO_API_KEY) {
    try {
      const news = await syncNews(env);
      summary.newsChecked = news.checked;
      summary.newIncidents += news.added;
    } catch (e) {
      summary.errors.push(`News: ${(e as Error).message}`);
    }
  }
  try {
    summary.newExposures = await matchExposures(env);
  } catch (e) {
    summary.errors.push(`Matching: ${(e as Error).message}`);
  }
  if (!repoId) {
    await env.DB.prepare("INSERT INTO watch_log (at, trigger, osv_checked, news_checked, new_incidents, errors) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(now(), trigger, summary.osvChecked, summary.newsChecked, summary.newIncidents, JSON.stringify(summary.errors))
      .run();
  }
  return summary;
}
