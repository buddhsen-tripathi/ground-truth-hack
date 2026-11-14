-- Repos Firebreak watches. full_name is "owner/name".
CREATE TABLE repos (
  id TEXT PRIMARY KEY,
  full_name TEXT NOT NULL UNIQUE,
  default_branch TEXT NOT NULL,
  head_sha TEXT,
  private INTEGER NOT NULL DEFAULT 0,
  lockfiles TEXT NOT NULL DEFAULT '[]',      -- JSON: [{ path, manager, packages, error? }]
  actions TEXT NOT NULL DEFAULT '[]',        -- JSON: [{ workflow, uses, ref, pinned }]
  secrets TEXT NOT NULL DEFAULT '[]',        -- JSON: secret names referenced by workflows
  dep_count INTEGER NOT NULL DEFAULT 0,
  scan_error TEXT,
  scanned_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Resolved dependencies from every lockfile, plus GitHub Actions refs (ecosystem 'GitHub Actions').
CREATE TABLE deps (
  repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  ecosystem TEXT NOT NULL,
  name TEXT NOT NULL,
  version TEXT NOT NULL,
  lockfile TEXT NOT NULL,
  direct INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (repo_id, ecosystem, name, version, lockfile)
);
CREATE INDEX deps_pkg ON deps (ecosystem, name, version);

-- Advisories (OSV) and early signals (news). id is the OSV id, or "SIG-<hash>" for a news signal.
CREATE TABLE incidents (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,                        -- 'malicious' | 'vulnerability'
  status TEXT NOT NULL,                      -- 'confirmed' (OSV) | 'unconfirmed' (news only)
  ecosystem TEXT NOT NULL,
  package TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  severity TEXT,                             -- 'critical' | 'high' | 'moderate' | 'low' | null
  aliases TEXT NOT NULL DEFAULT '[]',
  affected TEXT NOT NULL DEFAULT '{}',       -- JSON: { versions: string[], ranges: [{ introduced, fixed?, lastAffected? }] }
  sources TEXT NOT NULL DEFAULT '[]',        -- JSON: [{ kind: 'osv'|'news'|'advisory', title, url, publishedAt? }]
  published_at TEXT,
  detected_at TEXT NOT NULL
);
CREATE INDEX incidents_pkg ON incidents (ecosystem, package);

-- Which repos an incident hits, and how.
CREATE TABLE exposures (
  incident_id TEXT NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  version TEXT NOT NULL,
  lockfile TEXT NOT NULL,
  direct INTEGER NOT NULL DEFAULT 0,
  ci_runs TEXT NOT NULL DEFAULT '[]',        -- JSON: workflow runs since the incident was published
  detected_at TEXT NOT NULL,
  PRIMARY KEY (incident_id, repo_id, version, lockfile)
);

-- One row per hotfix attempt; the live log lives in the FixRun Durable Object.
CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  incident_id TEXT NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  status TEXT NOT NULL,                      -- 'queued' | 'running' | 'passed' | 'failed' | 'pr_opened'
  step TEXT NOT NULL,
  plan TEXT,                                 -- JSON FixPlan
  result TEXT,                               -- JSON RunResult
  pr_url TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX runs_incident ON runs (incident_id);

-- News articles already processed by the watcher.
CREATE TABLE seen_articles (
  url TEXT PRIMARY KEY,
  seen_at TEXT NOT NULL
);

-- Watcher heartbeat for the UI.
CREATE TABLE watch_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  trigger TEXT NOT NULL,                     -- 'cron' | 'manual'
  osv_checked INTEGER NOT NULL DEFAULT 0,
  news_checked INTEGER NOT NULL DEFAULT 0,
  new_incidents INTEGER NOT NULL DEFAULT 0,
  errors TEXT NOT NULL DEFAULT '[]'
);
