-- Fix runs are per repo now: one run bumps every chosen package across the repo's lockfiles and clears several advisories.
-- runs loses incident_id; run_incidents links a run to every advisory it clears.
PRAGMA defer_foreign_keys = true;

CREATE TABLE run_links_tmp AS SELECT id AS run_id, incident_id FROM runs;

CREATE TABLE runs_new (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  status TEXT NOT NULL,                      -- 'queued' | 'running' | 'passed' | 'failed' | 'pr_opened'
  step TEXT NOT NULL,
  plan TEXT,                                 -- JSON FixPlan (repo-level)
  result TEXT,                               -- JSON RunResult
  pr_url TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT
);
INSERT INTO runs_new (id, repo_id, status, step, plan, result, pr_url, started_at, finished_at)
  SELECT id, repo_id, status, step, plan, result, pr_url, started_at, finished_at FROM runs;
DROP TABLE runs;
ALTER TABLE runs_new RENAME TO runs;
CREATE INDEX runs_repo ON runs (repo_id, started_at);

CREATE TABLE run_incidents (
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  incident_id TEXT NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  PRIMARY KEY (run_id, incident_id)
);
CREATE INDEX run_incidents_incident ON run_incidents (incident_id);
INSERT INTO run_incidents (run_id, incident_id) SELECT run_id, incident_id FROM run_links_tmp;
DROP TABLE run_links_tmp;
