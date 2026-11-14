import { Hono } from "hono";
import type { Exposure, Overview, Run, WatchStatus } from "@shared/types";
import { MissingKeyError, now, shortId, type AppEnv } from "./env";
import { getIncident, getRepoById, getRun, INCIDENT_SELECT, REPO_SELECT, RUN_SELECT, rowToExposure, rowToIncident, rowToRepo, rowToRun } from "./db";
import { getPackument } from "./integrations/npm-registry";
import { managerFor } from "./lockfiles";
import { addRepo, scanRepo } from "./scan";
import { buildPlan } from "./versions";
import { matchExposures, runWatch } from "./watch";
import type { StartRun } from "./fix/run";

export { FixRun } from "./fix/run";

const app = new Hono<{ Bindings: AppEnv }>().basePath("/api");

app.onError((err, c) => {
  const status = err instanceof MissingKeyError ? 412 : 500;
  console.error(err);
  return c.json({ error: err.message }, status);
});

async function watchStatus(env: AppEnv): Promise<WatchStatus> {
  const last = await env.DB.prepare("SELECT * FROM watch_log ORDER BY id DESC LIMIT 1").first<Record<string, unknown>>();
  return {
    lastRun: last
      ? {
          at: last.at as string,
          trigger: last.trigger as string,
          osvChecked: Number(last.osv_checked),
          newsChecked: Number(last.news_checked),
          newIncidents: Number(last.new_incidents),
          errors: JSON.parse((last.errors as string) || "[]") as string[],
        }
      : null,
    integrations: { you: !!env.YOU_API_KEY, clonvo: !!env.CLONVO_API_KEY, daytona: !!env.DAYTONA_API_KEY, github: !!env.GITHUB_TOKEN },
    models: { fix: env.FIX_MODEL, extract: env.EXTRACT_MODEL },
  };
}

async function exposuresFor(env: AppEnv, where: string, id: string): Promise<Exposure[]> {
  const rows = await env.DB.prepare(`SELECT e.*, r.full_name, r.secrets FROM exposures e JOIN repos r ON r.id = e.repo_id WHERE ${where} = ? ORDER BY e.detected_at DESC`)
    .bind(id)
    .all();
  return rows.results.map(rowToExposure);
}

// ── overview & watcher ──────────────────────────────────────────────────────────────────────────────

app.get("/overview", async (c) => {
  const env = c.env;
  const [watch, counts, incidents, runs, exposed] = await Promise.all([
    watchStatus(env),
    env.DB.prepare("SELECT (SELECT COUNT(*) FROM repos) AS repos, (SELECT COUNT(*) FROM deps) AS deps").first<{ repos: number; deps: number }>(),
    env.DB.prepare(`${INCIDENT_SELECT} ORDER BY exposure_count > 0 DESC, CASE i.severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'moderate' THEN 2 WHEN 'low' THEN 3 ELSE 4 END, i.detected_at DESC LIMIT 30`).all(),
    env.DB.prepare(`${RUN_SELECT} ORDER BY ru.started_at DESC LIMIT 8`).all(),
    env.DB.prepare("SELECT COUNT(DISTINCT repo_id) AS n FROM exposures").first<{ n: number }>(),
  ]);
  const body: Overview = {
    watch,
    repos: counts?.repos ?? 0,
    deps: counts?.deps ?? 0,
    incidents: incidents.results.map(rowToIncident),
    runs: runs.results.map(rowToRun),
    exposedRepos: exposed?.n ?? 0,
  };
  return c.json(body);
});

app.post("/watch/run", async (c) => c.json(await runWatch(c.env, "manual")));

// ── repos ───────────────────────────────────────────────────────────────────────────────────────────

app.get("/repos", async (c) => {
  const rows = await c.env.DB.prepare(`${REPO_SELECT} ORDER BY r.created_at DESC`).all();
  return c.json(rows.results.map(rowToRepo));
});

app.post("/repos", async (c) => {
  const { fullName } = await c.req.json<{ fullName: string }>();
  const id = await addRepo(c.env, fullName ?? "");
  const repo = await scanRepo(c.env, id);
  await runWatch(c.env, "manual", id);
  return c.json((await getRepoById(c.env, id)) ?? repo);
});

app.get("/repos/:id", async (c) => {
  const repo = await getRepoById(c.env, c.req.param("id"));
  if (!repo) return c.json({ error: "Repo not found" }, 404);
  const [exposures, deps] = await Promise.all([
    exposuresFor(c.env, "e.repo_id", repo.id),
    c.env.DB.prepare("SELECT ecosystem, name, version, lockfile, direct FROM deps WHERE repo_id = ? AND direct = 1 ORDER BY name LIMIT 300").bind(repo.id).all(),
  ]);
  return c.json({ repo, exposures, directDeps: deps.results });
});

app.post("/repos/:id/scan", async (c) => {
  const id = c.req.param("id");
  await scanRepo(c.env, id);
  await runWatch(c.env, "manual", id);
  return c.json(await getRepoById(c.env, id));
});

app.delete("/repos/:id", async (c) => {
  await c.env.DB.prepare("DELETE FROM repos WHERE id = ?").bind(c.req.param("id")).run();
  await matchExposures(c.env);
  return c.json({ ok: true });
});

// ── incidents ───────────────────────────────────────────────────────────────────────────────────────

app.get("/incidents", async (c) => {
  const rows = await c.env.DB.prepare(`${INCIDENT_SELECT} ORDER BY exposure_count > 0 DESC, CASE i.severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'moderate' THEN 2 WHEN 'low' THEN 3 ELSE 4 END, i.detected_at DESC LIMIT 200`).all();
  return c.json(rows.results.map(rowToIncident));
});

app.get("/incidents/:id", async (c) => {
  const incident = await getIncident(c.env, c.req.param("id"));
  if (!incident) return c.json({ error: "Incident not found" }, 404);
  const [exposures, runs] = await Promise.all([
    exposuresFor(c.env, "e.incident_id", incident.id),
    c.env.DB.prepare(`${RUN_SELECT} WHERE ru.incident_id = ? ORDER BY ru.started_at DESC`).bind(incident.id).all(),
  ]);
  return c.json({ incident, exposures, runs: runs.results.map(rowToRun) });
});

// ── fix runs ────────────────────────────────────────────────────────────────────────────────────────

app.get("/runs", async (c) => {
  const rows = await c.env.DB.prepare(`${RUN_SELECT} ORDER BY ru.started_at DESC LIMIT 50`).all();
  return c.json(rows.results.map(rowToRun));
});

app.post("/runs", async (c) => {
  const env = c.env;
  const body = await c.req.json<{ incidentId: string; repoId: string; lockfile: string; version: string }>();
  const [incident, repo] = await Promise.all([getIncident(env, body.incidentId), getRepoById(env, body.repoId)]);
  if (!incident || !repo) return c.json({ error: "Incident or repo not found" }, 404);
  if (incident.ecosystem !== "npm") return c.json({ error: `Automatic fixes cover npm packages; this incident is ${incident.ecosystem}.` }, 400);
  const exposure = await env.DB.prepare("SELECT * FROM exposures WHERE incident_id = ? AND repo_id = ? AND lockfile = ? AND version = ?")
    .bind(incident.id, repo.id, body.lockfile, body.version)
    .first<{ direct: number }>();
  if (!exposure) return c.json({ error: "That exposure no longer exists. Rescan the repo." }, 404);
  const manager = managerFor(body.lockfile);
  if (!manager) return c.json({ error: "Unknown lockfile" }, 400);
  for (const key of ["DAYTONA_API_KEY", "GITHUB_TOKEN"] as const) if (!env[key]) throw new MissingKeyError(key);

  // Every other advisory for the same package: the chosen version must clear all of them, not just this one.
  const others = (await env.DB.prepare(`${INCIDENT_SELECT} WHERE i.ecosystem = ? AND i.package = ? AND i.id != ?`).bind(incident.ecosystem, incident.package, incident.id).all()).results.map(rowToIncident);
  const avoid = others.map((o) => o.affected);
  const plan = buildPlan({ incident, from: body.version, lockfile: body.lockfile, manager, direct: !!exposure.direct, pack: await getPackument(incident.package), avoid });
  if (!plan) return c.json({ error: `No clean release of ${incident.package} was found to move to.` }, 422);

  const id = shortId();
  await env.DB.prepare("INSERT INTO runs (id, incident_id, repo_id, status, step, plan, started_at) VALUES (?, ?, ?, 'queued', 'plan', ?, ?)")
    .bind(id, incident.id, repo.id, JSON.stringify(plan), now())
    .run();
  const start: StartRun = {
    runId: id,
    fullName: repo.fullName,
    defaultBranch: repo.defaultBranch,
    // The sandbox's lockfile check rejects any version flagged by any advisory for the package.
    incident: {
      id: incident.id,
      kind: incident.kind,
      title: incident.title,
      package: incident.package,
      affected: { versions: [incident.affected.versions, ...avoid.map((a) => a.versions)].flat(), ranges: [incident.affected.ranges, ...avoid.map((a) => a.ranges)].flat() },
      sources: incident.sources,
      severity: incident.severity,
    },
    plan,
  };
  const stub = env.FIX_RUN.get(env.FIX_RUN.idFromName(id));
  await stub.fetch("https://run/start", { method: "POST", body: JSON.stringify(start) });
  return c.json((await getRun(env, id)) as Run);
});

app.get("/runs/:id", async (c) => {
  const run = await getRun(c.env, c.req.param("id"));
  if (!run) return c.json({ error: "Run not found" }, 404);
  const stub = c.env.FIX_RUN.get(c.env.FIX_RUN.idFromName(run.id));
  const events = await (await stub.fetch("https://run/events")).json();
  return c.json({ run, events });
});

app.get("/runs/:id/ws", async (c) => {
  const stub = c.env.FIX_RUN.get(c.env.FIX_RUN.idFromName(c.req.param("id")));
  return stub.fetch(new Request("https://run/ws", c.req.raw));
});

app.post("/runs/:id/pr", async (c) => {
  const stub = c.env.FIX_RUN.get(c.env.FIX_RUN.idFromName(c.req.param("id")));
  const res = await stub.fetch("https://run/pr", { method: "POST" });
  return c.json(await res.json(), res.status as 200 | 500);
});

app.post("/runs/:id/preview/stop", async (c) => {
  const stub = c.env.FIX_RUN.get(c.env.FIX_RUN.idFromName(c.req.param("id")));
  const res = await stub.fetch("https://run/preview/stop", { method: "POST" });
  return c.json(await res.json(), res.status as 200 | 500);
});

app.get("/health", (c) => c.json({ ok: true }));

export default {
  fetch: app.fetch,
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(runWatch(env as AppEnv, "cron"));
  },
} satisfies ExportedHandler<AppEnv>;
