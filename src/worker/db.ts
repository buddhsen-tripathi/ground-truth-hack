import type { Exposure, Incident, Repo, Run, RunStatus, RunStep } from "@shared/types";
import type { AppEnv } from "./env";

const json = <T>(s: unknown, fallback: T): T => {
  if (typeof s !== "string") return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
};

type Row = Record<string, unknown>;

export function rowToRepo(r: Row): Repo {
  return {
    id: r.id as string,
    fullName: r.full_name as string,
    defaultBranch: r.default_branch as string,
    headSha: (r.head_sha as string) ?? null,
    private: !!r.private,
    lockfiles: json(r.lockfiles, []),
    actions: json(r.actions, []),
    secrets: json(r.secrets, []),
    depCount: Number(r.dep_count ?? 0),
    scanError: (r.scan_error as string) ?? null,
    scannedAt: (r.scanned_at as string) ?? null,
    exposureCount: Number(r.exposure_count ?? 0),
  };
}

export function rowToIncident(r: Row): Incident {
  return {
    id: r.id as string,
    kind: r.kind as Incident["kind"],
    status: r.status as Incident["status"],
    ecosystem: r.ecosystem as string,
    package: r.package as string,
    title: r.title as string,
    summary: (r.summary as string) ?? "",
    severity: (r.severity as Incident["severity"]) ?? null,
    aliases: json(r.aliases, []),
    affected: json(r.affected, { versions: [], ranges: [] }),
    sources: json(r.sources, []),
    publishedAt: (r.published_at as string) ?? null,
    detectedAt: r.detected_at as string,
    exposureCount: Number(r.exposure_count ?? 0),
  };
}

export function rowToExposure(r: Row): Exposure {
  return {
    incidentId: r.incident_id as string,
    repoId: r.repo_id as string,
    repoFullName: (r.full_name as string) ?? "",
    version: r.version as string,
    lockfile: r.lockfile as string,
    direct: !!r.direct,
    ciRuns: json(r.ci_runs, []),
    secrets: json(r.secrets, []),
    detectedAt: r.detected_at as string,
  };
}

export function rowToRun(r: Row): Run {
  return {
    id: r.id as string,
    incidentId: r.incident_id as string,
    repoId: r.repo_id as string,
    repoFullName: (r.full_name as string) ?? "",
    incidentTitle: (r.title as string) ?? "",
    package: (r.package as string) ?? "",
    status: r.status as RunStatus,
    step: r.step as RunStep,
    plan: json(r.plan, null),
    result: json(r.result, null),
    prUrl: (r.pr_url as string) ?? null,
    startedAt: r.started_at as string,
    finishedAt: (r.finished_at as string) ?? null,
  };
}

export const INCIDENT_SELECT = `SELECT i.*, (SELECT COUNT(DISTINCT repo_id) FROM exposures e WHERE e.incident_id = i.id) AS exposure_count FROM incidents i`;
export const REPO_SELECT = `SELECT r.*, (SELECT COUNT(DISTINCT incident_id) FROM exposures e WHERE e.repo_id = r.id) AS exposure_count FROM repos r`;
export const RUN_SELECT = `SELECT ru.*, r.full_name, i.title, i.package FROM runs ru JOIN repos r ON r.id = ru.repo_id JOIN incidents i ON i.id = ru.incident_id`;

export async function getIncident(env: AppEnv, id: string): Promise<Incident | null> {
  const row = await env.DB.prepare(`${INCIDENT_SELECT} WHERE i.id = ?`).bind(id).first();
  return row ? rowToIncident(row) : null;
}

export async function getRepoById(env: AppEnv, id: string): Promise<Repo | null> {
  const row = await env.DB.prepare(`${REPO_SELECT} WHERE r.id = ?`).bind(id).first();
  return row ? rowToRepo(row) : null;
}

export async function getRun(env: AppEnv, id: string): Promise<Run | null> {
  const row = await env.DB.prepare(`${RUN_SELECT} WHERE ru.id = ?`).bind(id).first();
  return row ? rowToRun(row) : null;
}

export async function upsertIncident(env: AppEnv, i: Omit<Incident, "exposureCount">): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO incidents (id, kind, status, ecosystem, package, title, summary, severity, aliases, affected, sources, published_at, detected_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET status = excluded.status, title = excluded.title, summary = excluded.summary, severity = excluded.severity,
       aliases = excluded.aliases, affected = excluded.affected, sources = excluded.sources, published_at = excluded.published_at`,
  )
    .bind(i.id, i.kind, i.status, i.ecosystem, i.package, i.title, i.summary, i.severity, JSON.stringify(i.aliases), JSON.stringify(i.affected), JSON.stringify(i.sources), i.publishedAt, i.detectedAt)
    .run();
}
