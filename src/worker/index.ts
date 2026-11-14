import { Hono } from "hono";
import type { Exposure, Overview, Run, WatchStatus } from "@shared/types";
import { MissingKeyError, now, shortId, type AppEnv } from "./env";
import { getIncident, getRepoById, getRun, INCIDENT_SELECT, REPO_SELECT, RUN_SELECT, rowToExposure, rowToIncident, rowToRepo, rowToRun } from "./db";
import { planPackages, type Incident } from "@shared/types";
import { pickFromPlan, planRepoFix } from "./fix/plan";
import { addRepo, scanRepo } from "./scan";
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
    integrations: {
      you: !!env.YOU_API_KEY,
      clonvo: !!env.CLONVO_API_KEY,
      daytona: !!env.DAYTONA_API_KEY,
      github: !!env.GITHUB_TOKEN,
      opencrawl: !!env.OPENCRAWL_TOKEN,
      claudeCode: !!env.CLAUDE_CODE_OAUTH_TOKEN,
    },
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
  const [exposures, deps, runs] = await Promise.all([
    exposuresFor(c.env, "e.repo_id", repo.id),
    c.env.DB.prepare("SELECT ecosystem, name, version, lockfile, direct FROM deps WHERE repo_id = ? AND direct = 1 ORDER BY name LIMIT 300").bind(repo.id).all(),
    c.env.DB.prepare(`${RUN_SELECT} WHERE ru.repo_id = ? ORDER BY ru.started_at DESC LIMIT 20`).bind(repo.id).all(),
  ]);
  return c.json({ repo, exposures, directDeps: deps.results, runs: runs.results.map(rowToRun) });
});

// Every exposed package in the repo with the version Firebreak would move it to. Reads the registries; changes nothing.
app.get("/repos/:id/fix-plan", async (c) => {
  const repo = await getRepoById(c.env, c.req.param("id"));
  if (!repo) return c.json({ error: "Repo not found" }, 404);
  return c.json(await planRepoFix(c.env, repo.id));
});

// Starts one fix run for the checked packages: one sandbox, one set of checks, one PR.
app.post("/repos/:id/fix", async (c) => {
  const env = c.env;
  const repo = await getRepoById(env, c.req.param("id"));
  if (!repo) return c.json({ error: "Repo not found" }, 404);
  const { keys } = await c.req.json<{ keys: string[] }>();
  for (const key of ["DAYTONA_API_KEY", "GITHUB_TOKEN"] as const) if (!env[key]) throw new MissingKeyError(key);
  const plan = pickFromPlan(await planRepoFix(env, repo.id), keys ?? []);
  const packages = planPackages(plan);
  if (!packages.length) return c.json({ error: "None of the picked packages can be fixed any more. Rescan the repo." }, 400);

  const incidentIds = [...new Set(packages.flatMap((p) => p.incidents.map((i) => i.id)))];
  const incidents = (await Promise.all(incidentIds.map((id) => getIncident(env, id)))).filter((i): i is Incident => !!i);
  // The sandbox's lockfile check rejects any version flagged by any known advisory for each bumped package.
  const avoid: StartRun["avoid"] = {};
  for (const t of plan.targets) {
    for (const p of t.packages) {
      const all = await env.DB.prepare(`${INCIDENT_SELECT} WHERE i.ecosystem = ? AND i.package = ?`).bind(t.ecosystem, p.package).all();
      avoid[`${t.ecosystem}:${p.package}`] = all.results.map(rowToIncident).map((i) => i.affected);
    }
  }

  const id = shortId();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO runs (id, repo_id, status, step, plan, started_at) VALUES (?, ?, 'queued', 'plan', ?, ?)").bind(id, repo.id, JSON.stringify(plan), now()),
    ...incidentIds.map((iid) => env.DB.prepare("INSERT INTO run_incidents (run_id, incident_id) VALUES (?, ?)").bind(id, iid)),
  ]);
  const start: StartRun = {
    runId: id,
    fullName: repo.fullName,
    defaultBranch: repo.defaultBranch,
    plan,
    avoid,
    incidents: incidents.map((i) => ({ id: i.id, kind: i.kind, title: i.title, severity: i.severity, sources: i.sources })),
  };
  const stub = env.FIX_RUN.get(env.FIX_RUN.idFromName(id));
  await stub.fetch("https://run/start", { method: "POST", body: JSON.stringify(start) });
  return c.json((await getRun(env, id)) as Run);
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
    c.env.DB.prepare(`${RUN_SELECT} WHERE ru.id IN (SELECT run_id FROM run_incidents WHERE incident_id = ?) ORDER BY ru.started_at DESC`).bind(incident.id).all(),
  ]);
  return c.json({ incident, exposures, runs: runs.results.map(rowToRun) });
});

// ── fix runs ────────────────────────────────────────────────────────────────────────────────────────

app.get("/runs", async (c) => {
  const rows = await c.env.DB.prepare(`${RUN_SELECT} ORDER BY ru.started_at DESC LIMIT 50`).all();
  return c.json(rows.results.map(rowToRun));
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
