// Types shared by the Worker API and the web app.

export type Manager = "npm" | "pnpm" | "yarn" | "bun" | "uv" | "pip";

/** Ecosystems Firebreak can fix automatically, named as OSV names them. */
export type FixEcosystem = "npm" | "PyPI";

export const ecosystemOf = (manager: Manager): FixEcosystem => (manager === "uv" || manager === "pip" ? "PyPI" : "npm");

export interface LockfileSummary {
  path: string;
  manager: Manager;
  packages: number;
  error?: string;
}

export interface ActionRef {
  workflow: string;
  uses: string;
  ref: string;
  /** True when the ref is a full 40-character commit SHA. */
  pinned: boolean;
}

export interface Repo {
  id: string;
  fullName: string;
  defaultBranch: string;
  headSha: string | null;
  private: boolean;
  lockfiles: LockfileSummary[];
  actions: ActionRef[];
  secrets: string[];
  depCount: number;
  scanError: string | null;
  scannedAt: string | null;
  exposureCount: number;
}

export type IncidentKind = "malicious" | "vulnerability";
export type IncidentStatus = "confirmed" | "unconfirmed";
export type Severity = "critical" | "high" | "moderate" | "low";

export interface AffectedRange {
  introduced?: string;
  fixed?: string;
  lastAffected?: string;
}

export interface Source {
  kind: "osv" | "news" | "advisory";
  title: string;
  url: string;
  publishedAt?: string;
}

export interface Incident {
  id: string;
  kind: IncidentKind;
  status: IncidentStatus;
  ecosystem: string;
  package: string;
  title: string;
  summary: string;
  severity: Severity | null;
  aliases: string[];
  affected: { versions: string[]; ranges: AffectedRange[] };
  sources: Source[];
  publishedAt: string | null;
  detectedAt: string;
  exposureCount: number;
}

export interface CiRun {
  id: number;
  name: string;
  url: string;
  createdAt: string;
  conclusion: string | null;
}

export interface Exposure {
  incidentId: string;
  repoId: string;
  repoFullName: string;
  version: string;
  lockfile: string;
  direct: boolean;
  ciRuns: CiRun[];
  secrets: string[];
  detectedAt: string;
}

export type RunStatus = "queued" | "running" | "passed" | "failed" | "pr_opened";

export const RUN_STEPS = ["plan", "sandbox", "clone", "patch", "install", "verify", "test", "repair", "ready"] as const;
export type RunStep = (typeof RUN_STEPS)[number];

export interface FixIncidentRef {
  id: string;
  kind: IncidentKind;
  severity: Severity | null;
  title: string;
}

/** One package bump inside a repo-level fix. */
export interface PackageFix {
  /** Stable id for the checklist: "<lockfile>::<package>". */
  key: string;
  package: string;
  /** Versions the lockfile resolves today (a lockfile can hold several copies). */
  from: string[];
  to: string;
  strategy: "upgrade" | "pin-back" | "override";
  direct: boolean;
  /** Pin exactly (malicious releases, pin-backs) instead of allowing compatible updates. */
  exact: boolean;
  incidents: FixIncidentRef[];
  reason: string;
}

/** All bumps for one lockfile; a run installs and checks each lockfile's project in turn. */
export interface LockfileFix {
  lockfile: string;
  /** Directory of the project the lockfile belongs to, relative to the repo root ("" for the root). */
  dir: string;
  manager: Manager;
  ecosystem: FixEcosystem;
  /** Expo SDK major when the project is an Expo app: Expo-managed packages stay in that SDK's supported range. */
  expoSdk?: number;
  packages: PackageFix[];
}

/** An exposure Firebreak can't fix automatically, with the reason. */
export interface SkippedFix {
  key: string;
  package: string;
  ecosystem: string;
  lockfile: string;
  versions: string[];
  incidents: FixIncidentRef[];
  reason: string;
}

/** A repo-level fix: every chosen package across the repo's lockfiles, verified in one sandbox and shipped as one PR. */
export interface FixPlan {
  targets: LockfileFix[];
  skipped: SkippedFix[];
}

export interface RunAttempt {
  n: number;
  /** Lockfile whose project these checks ran in. */
  lockfile?: string;
  passed: boolean;
  command: string;
  exitCode: number | null;
  summary: string;
}

/** Live preview of the patched app, served from the run's sandbox after checks pass. */
export interface RunPreview {
  state: "starting" | "live" | "unavailable" | "ended";
  /** Signed, single-port Daytona URL; only set while the preview is live. */
  url?: string;
  command?: string;
  port?: number;
  expiresAt?: string;
  note?: string;
}

export interface RunResult {
  attempts: RunAttempt[];
  diff: string;
  changedFiles: string[];
  lockfileClean: boolean | null;
  testCommand: string | null;
  durationMs: number;
  error?: string;
  preview?: RunPreview;
}

export interface Run {
  id: string;
  repoId: string;
  repoFullName: string;
  /** Every advisory the run's bumps clear. */
  incidentIds: string[];
  status: RunStatus;
  step: RunStep;
  plan: FixPlan | null;
  result: RunResult | null;
  prUrl: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export type RunEvent =
  | { t: number; type: "step"; step: RunStep; label: string }
  | { t: number; type: "log"; stream: "out" | "err" | "info"; text: string }
  | { t: number; type: "cmd"; command: string }
  | { t: number; type: "exit"; command: string; exitCode: number | null; ms: number }
  | { t: number; type: "agent"; text: string }
  | { t: number; type: "status"; status: RunStatus; step: RunStep }
  | { t: number; type: "preview"; preview: RunPreview };

export interface WatchStatus {
  lastRun: { at: string; trigger: string; osvChecked: number; newsChecked: number; newIncidents: number; errors: string[] } | null;
  integrations: { you: boolean; clonvo: boolean; daytona: boolean; github: boolean };
  models: { fix: string; extract: string };
}

export interface Overview {
  watch: WatchStatus;
  repos: number;
  deps: number;
  incidents: Incident[];
  runs: Run[];
  exposedRepos: number;
}

/** A RunEvent without its timestamp (distributes over the union). */
/** Every package bump in a plan, flattened. */
export const planPackages = (plan: FixPlan | null): (PackageFix & { lockfile: string; manager: Manager })[] =>
  plan ? plan.targets.flatMap((t) => t.packages.map((p) => ({ ...p, lockfile: t.lockfile, manager: t.manager }))) : [];

export type RunEventInput = RunEvent extends infer E ? (E extends RunEvent ? Omit<E, "t"> : never) : never;
