import { DurableObject } from "cloudflare:workers";
import { planPackages, type RepairAgent, type FixPlan, type Incident, type LockfileFix, type RunAttempt, type RunEvent, type RunEventInput, type RunPreview, type RunResult, type RunStatus, type RunStep, type Source } from "@shared/types";
import { now, type AppEnv } from "../env";
import { normalizePlan } from "../db";
import { chat, parseJsonReply } from "../integrations/clonvo";
import { Sandbox } from "../integrations/daytona";
import { openPullRequest } from "../integrations/github";
import { search } from "../integrations/you";
import { boardSync, opencrawlApi, opencrawlEnabled, packageTopic, repoTopic, searchHistory } from "../integrations/opencrawl";
import { parseLockfile } from "../lockfiles";
import { parseDocument } from "yaml";
import { isAffected } from "../versions";
import { APPLY_EDITS, CODEX_FILTER, PATCH_PACKAGE_JSON, PATCH_PYTHON, SCAN_WORKSPACE } from "./scripts";

const SESSION = "firebreak";
const MAX_REPAIRS = 3;
const INSTALL_TIMEOUT = 600;
const TEST_TIMEOUT = 600;
/** The patched app is served on this port inside the sandbox. */
const PREVIEW_PORT = 3000;
/** How long the sandbox stays up for the live preview after a verified fix. */
const PREVIEW_TTL_SEC = 30 * 60;
const PREVIEW_BOOT_SEC = 150;
/** Codex gets one bounded session per repair round; the checks are re-run independently afterwards. */
const AGENT_TIMEOUT_SEC = 12 * 60;

type Phase = "sandbox" | "clone" | "patch" | "install" | "verify" | "test" | "repair" | "preview" | "previewing" | "ready" | "done";

export interface StartRun {
  runId: string;
  fullName: string;
  defaultBranch: string;
  plan: FixPlan;
  /** Every advisory the run clears (for the receipt and PR). */
  incidents: Pick<Incident, "id" | "kind" | "title" | "severity" | "sources">[];
  /** "<ecosystem>:<package>" → affected sets of every known advisory for it; the lockfile check rejects all of them. */
  avoid: Record<string, Incident["affected"][]>;
}

/** State saved by runs started before repo-level fixes. */
interface LegacyStart {
  incident?: Pick<Incident, "id" | "kind" | "title" | "package" | "affected" | "sources" | "severity">;
}

interface State extends StartRun {
  phase: Phase;
  status: RunStatus;
  step: RunStep;
  startedAt: number;
  sandboxId?: string;
  /** Home directory of the sandbox user; the repo is cloned to <home>/repo. */
  home?: string;
  /** Lockfile path → yarn berry (true) or classic. */
  yarnBerry: Record<string, boolean>;
  /** Index into plan.targets for the phases that work one lockfile per alarm (install, test, repair). */
  cursor: number;
  /** Lockfile path → check command picked for its project. */
  tests: Record<string, string>;
  /** Requirements file → the .in file it's recompiled from (pip-compile output). */
  pyCompile: Record<string, { in: string; hashes: boolean } | null>;
  uvReady?: boolean;
  attempts: RunAttempt[];
  /** Start to verified fix; the run's clock stops here even while a preview stays up. */
  verifiedMs?: number;
  lastFailure?: string;
  repairs: number;
  lockfileClean: boolean | null;
  diff: string;
  changedFiles: string[];
  agentNotes: string[];
  migrationSources: Source[];
  /** Notes other runs and agents left on this run's OpenCrawl board topics. */
  boardNotes: string[];
  history?: { found: number; board: number };
  agent?: RepairAgent;
  /** Lockfile → expo-doctor / `expo install --check` output: informs the agent, never gates the run. */
  expoNotes: Record<string, string>;
  error?: string;
  prUrl?: string;
  preview?: RunPreview;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const STEP_LABELS: Record<RunStep, string> = {
  plan: "Planned the fix",
  sandbox: "Starting an isolated Daytona sandbox",
  clone: "Cloning the repository",
  patch: "Applying the version change",
  install: "Installing with lifecycle scripts disabled",
  verify: "Checking the lockfile is clean",
  test: "Running the project's checks",
  repair: "Repairing breaking changes",
  ready: "Fix verified",
};

export class FixRun extends DurableObject<AppEnv> {
  private st: State | null = null;

  constructor(ctx: DurableObjectState, env: AppEnv) {
    super(ctx, env);
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, data TEXT NOT NULL)");
    // Verified file contents, kept so the PR can be opened after the sandbox is gone. Chunked: a row holds at most ~2 MB.
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS files (path TEXT NOT NULL, idx INTEGER NOT NULL, chunk TEXT NOT NULL, PRIMARY KEY (path, idx))");
  }

  private storeFile(path: string, content: string) {
    const size = 500_000;
    for (let i = 0, idx = 0; i < Math.max(content.length, 1); i += size, idx++)
      this.ctx.storage.sql.exec("INSERT OR REPLACE INTO files (path, idx, chunk) VALUES (?, ?, ?)", path, idx, content.slice(i, i + size));
  }

  private storedFiles(): { path: string; content: string }[] {
    const byPath = new Map<string, string>();
    for (const row of this.ctx.storage.sql.exec<{ path: string; chunk: string }>("SELECT path, chunk FROM files ORDER BY path, idx"))
      byPath.set(row.path, (byPath.get(row.path) ?? "") + row.chunk);
    return [...byPath].map(([path, content]) => ({ path, content }));
  }

  // ── storage, events, D1 mirror ────────────────────────────────────────────────────────────────────

  private async load(): Promise<State> {
    if (!this.st) {
      const raw = (await this.ctx.storage.get<State & LegacyStart & { testCommand?: string | null }>("state")) ?? null;
      if (raw && !("targets" in (raw.plan ?? {}))) {
        // A single-package run from before repo-level fixes: read it in the new shape.
        const i = raw.incident;
        raw.plan = normalizePlan(raw.plan)!;
        raw.incidents = i ? [i] : [];
        raw.avoid = i ? { [`npm:${i.package}`]: [i.affected] } : {};
        raw.tests = raw.testCommand ? { [raw.plan.targets[0]!.lockfile]: raw.testCommand } : {};
        raw.yarnBerry ??= {};
        raw.pyCompile ??= {};
        raw.cursor ??= 0;
      }
      if (raw) {
        raw.boardNotes ??= [];
        raw.expoNotes ??= {};
      }
      this.st = raw;
    }
    if (!this.st) throw new Error("Run not started");
    return this.st;
  }

  private async save(): Promise<void> {
    if (this.st) await this.ctx.storage.put("state", this.st);
  }

  private emit(ev: RunEventInput): void {
    const full = { t: Date.now(), ...ev } as RunEvent;
    const data = JSON.stringify(full);
    this.ctx.storage.sql.exec("INSERT INTO events (data) VALUES (?)", data);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(data);
      } catch {
        // closed sockets are cleaned up by the runtime
      }
    }
  }

  private events(): RunEvent[] {
    return this.ctx.storage.sql
      .exec<{ data: string }>("SELECT data FROM events ORDER BY seq")
      .toArray()
      .map((r) => JSON.parse(r.data) as RunEvent);
  }

  private result(s: State): RunResult {
    return {
      attempts: s.attempts,
      diff: s.diff,
      changedFiles: s.changedFiles,
      lockfileClean: s.lockfileClean,
      testCommand: Object.values(s.tests).join(" · ") || null,
      durationMs: s.verifiedMs ?? Date.now() - s.startedAt,
      error: s.error,
      preview: s.preview,
      agent: s.agent,
      history: s.history,
    };
  }

  private async setStatus(status: RunStatus, step?: RunStep): Promise<void> {
    const s = await this.load();
    s.status = status;
    if (step && step !== s.step) {
      s.step = step;
      this.emit({ type: "step", step, label: STEP_LABELS[step] });
    }
    this.emit({ type: "status", status, step: s.step });
    await this.save();
    await this.mirror(s);
  }

  /** Copies the run's state to its D1 row, which the list and detail APIs read. */
  private async mirror(s: State): Promise<void> {
    const finished = s.status === "passed" || s.status === "failed" || s.status === "pr_opened";
    await this.env.DB.prepare("UPDATE runs SET status = ?, step = ?, result = ?, pr_url = ?, finished_at = COALESCE(finished_at, ?) WHERE id = ?")
      .bind(s.status, s.step, JSON.stringify(this.result(s)), s.prUrl ?? null, finished ? now() : null, s.runId)
      .run();
  }

  private async setPreview(s: State, preview: RunPreview): Promise<void> {
    s.preview = preview;
    await this.save();
    this.emit({ type: "preview", preview });
    await this.mirror(s);
  }

  private async step(step: RunStep): Promise<void> {
    await this.setStatus("running", step);
  }

  private info(text: string) {
    this.emit({ type: "log", stream: "info", text });
  }

  // ── HTTP / WebSocket ──────────────────────────────────────────────────────────────────────────────

  override async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname.endsWith("/ws")) {
      if (req.headers.get("Upgrade") !== "websocket") return new Response("Expected WebSocket", { status: 426 });
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1]);
      for (const ev of this.events()) pair[1].send(JSON.stringify(ev));
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    if (url.pathname.endsWith("/events")) return Response.json(this.events());
    if (req.method === "POST" && url.pathname.endsWith("/start")) {
      const start = (await req.json()) as StartRun;
      this.st = {
        ...start,
        phase: "sandbox",
        status: "queued",
        step: "plan",
        startedAt: Date.now(),
        yarnBerry: {},
        cursor: 0,
        tests: {},
        pyCompile: {},
        attempts: [],
        repairs: 0,
        lockfileClean: null,
        diff: "",
        changedFiles: [],
        agentNotes: [],
        migrationSources: [],
        boardNotes: [],
        expoNotes: {},
      };
      await this.save();
      this.emit({ type: "step", step: "plan", label: STEP_LABELS.plan });
      const all = planPackages(start.plan);
      this.info(`${all.length} package${all.length === 1 ? "" : "s"} across ${start.plan.targets.length} lockfile${start.plan.targets.length === 1 ? "" : "s"}, clearing ${start.incidents.length} advisor${start.incidents.length === 1 ? "y" : "ies"}.`);
      for (const p of all) {
        const verb = p.strategy === "pin-back" ? "Pin back" : p.strategy === "override" ? "Override" : "Upgrade";
        this.info(`${verb} ${p.package} ${p.from.join(", ")} → ${p.to} in ${p.lockfile} (${p.manager}). ${p.reason}`);
      }
      await this.ctx.storage.setAlarm(Date.now());
      return Response.json({ ok: true });
    }
    if (req.method === "POST" && url.pathname.endsWith("/preview/stop")) {
      const s = await this.load();
      if (s.phase === "preview" || s.phase === "previewing") {
        await this.endPreview(s, "Preview stopped and the sandbox deleted.");
        s.phase = "ready";
        await this.save();
      }
      return Response.json({ ok: true });
    }
    if (req.method === "POST" && url.pathname.endsWith("/pr")) {
      try {
        return Response.json({ url: await this.openPr() });
      } catch (e) {
        const message = (e as Error).message;
        // Say why in the run's log too, so a retried click doesn't just repeat "Opening the pull request…".
        this.emit({ type: "log", stream: "err", text: `Pull request not opened: ${message}` });
        return Response.json({ error: message }, { status: 500 });
      }
    }
    return new Response("Not found", { status: 404 });
  }

  override async webSocketMessage(): Promise<void> {
    // The UI only listens.
  }

  override async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    ws.close(code, "closing");
  }

  // ── the fix loop: one phase per alarm ─────────────────────────────────────────────────────────────

  override async alarm(): Promise<void> {
    const s = await this.load();
    if (s.phase === "previewing") {
      const until = Date.parse(s.preview?.expiresAt ?? "") || 0;
      if (Date.now() >= until - 1000) {
        await this.endPreview(s, "Preview expired and the sandbox was deleted.");
        s.phase = "ready";
        await this.save();
      } else await this.ctx.storage.setAlarm(until);
      return;
    }
    if (s.phase === "done" || s.phase === "ready") return;
    try {
      const next = await this.runPhase(s);
      s.phase = next;
      await this.save();
      if (next === "previewing") await this.ctx.storage.setAlarm(Date.parse(s.preview?.expiresAt ?? "") || Date.now() + PREVIEW_TTL_SEC * 1000);
      else if (next !== "done" && next !== "ready") await this.ctx.storage.setAlarm(Date.now());
    } catch (e) {
      await this.fail((e as Error).message);
    }
  }

  private async fail(message: string): Promise<void> {
    const s = await this.load();
    s.error = message;
    s.phase = "done";
    this.emit({ type: "log", stream: "err", text: message });
    await this.setStatus("failed");
    await this.postBoard(s, false);
    if (s.sandboxId) {
      const sb = await Sandbox.attach(this.env, s.sandboxId).catch(() => null);
      await sb?.delete();
      this.info("Sandbox deleted.");
    }
  }

  private async sandbox(s: State): Promise<Sandbox> {
    if (!s.sandboxId) throw new Error("No sandbox");
    return Sandbox.attach(this.env, s.sandboxId);
  }

  /** Runs a command in the session and streams its output into the event log. */
  private async run(sb: Sandbox, command: string, timeoutSec: number, display = command): Promise<{ exitCode: number | null; output: string }> {
    this.emit({ type: "cmd", command: display });
    const started = Date.now();
    const cmdId = await sb.startCommand(SESSION, command);
    let printed = 0;
    let output = "";
    let exitCode: number | null = null;
    while (Date.now() - started < timeoutSec * 1000) {
      await sleep(1500);
      exitCode = await sb.commandStatus(SESSION, cmdId).catch(() => null);
      output = await sb.commandLogs(SESSION, cmdId).catch(() => output);
      if (output.length > printed) {
        const chunk = output.slice(printed);
        printed = output.length;
        for (let i = 0; i < chunk.length; i += 4000) this.emit({ type: "log", stream: "out", text: chunk.slice(i, i + 4000) });
      }
      if (exitCode !== null) break;
    }
    if (exitCode !== null) {
      // The exit status can land before the last log lines are flushed; read the log once more.
      await sleep(500);
      const last = await sb.commandLogs(SESSION, cmdId).catch(() => output);
      if (last.length > printed) {
        const chunk = last.slice(printed);
        for (let i = 0; i < chunk.length; i += 4000) this.emit({ type: "log", stream: "out", text: chunk.slice(i, i + 4000) });
        output = last;
      }
    }
    if (exitCode === null) this.emit({ type: "log", stream: "err", text: `Timed out after ${timeoutSec}s` });
    this.emit({ type: "exit", command: display, exitCode, ms: Date.now() - started });
    return { exitCode, output };
  }

  private repoPath(s: State, rel = "") {
    return `${s.home ?? "/home/daytona"}/repo${rel ? `/${rel}` : ""}`;
  }

  /** Absolute path inside a lockfile's project directory. */
  private dirPath(s: State, t: LockfileFix, file = "") {
    return this.repoPath(s, [t.dir, file].filter(Boolean).join("/"));
  }

  private target(s: State): LockfileFix {
    const t = s.plan.targets[s.cursor];
    if (!t) throw new Error("No lockfile left to work on");
    return t;
  }

  /** Each Python project gets its own virtualenv outside the repo, so it never shows up in the diff. */
  private venv(s: State, t: LockfileFix) {
    return `/tmp/fb-venv-${s.plan.targets.indexOf(t)}`;
  }

  private uv(s: State, t: LockfileFix, args: string) {
    return `UV_PROJECT_ENVIRONMENT=${this.venv(s, t)} uv ${args}`;
  }

  private async runPhase(s: State): Promise<Phase> {
    const targets = s.plan.targets;
    const python = targets.some((t) => t.ecosystem === "PyPI");
    switch (s.phase) {
      case "sandbox": {
        await this.readBoard(s);
        await this.step("sandbox");
        const sb = await Sandbox.create(this.env, { run: s.runId });
        s.sandboxId = sb.id;
        await this.save();
        this.info(
          `Sandbox ${sb.id} created. No secrets are passed in${this.env.CODEX_AUTH_JSON ? " unless checks fail: then Codex gets its own sign-in, after every lockfile is verified clean" : ""}.`,
        );
        await sb.waitStarted();
        s.home = (await sb.exec("echo $HOME")).output.trim() || "/home/daytona";
        await this.save();
        await sb.createSession(SESSION);
        const versions = `node -v && npm -v && git --version${python ? " && python3 --version" : ""}`;
        await this.run(sb, `export CI=true COREPACK_ENABLE_DOWNLOAD_PROMPT=0 UV_NO_PROGRESS=1 PATH="$HOME/.local/bin:$HOME/.bun/bin:$HOME/.cargo/bin:$PATH"; ${versions}`, 60, versions);
        return "clone";
      }

      case "clone": {
        await this.step("clone");
        const sb = await this.sandbox(s);
        // Sandbox networking can blip right after start (DNS, 502 from the daemon); retry the clone a few times.
        for (let attempt = 1; ; attempt++) {
          try {
            await sb.clone(`https://github.com/${s.fullName}.git`, this.repoPath(s), { branch: s.defaultBranch, token: this.env.GITHUB_TOKEN });
            break;
          } catch (err) {
            if (attempt >= 3 || !/50[234]|TRANSPORT|no such host|timeout/i.test(String(err))) throw err;
            this.info(`Clone failed (${String(err).slice(0, 120)}). Retrying in ${attempt * 3}s.`);
            await sb.exec(`rm -rf ${this.repoPath(s)}`);
            await sleep(attempt * 3000);
          }
        }
        // The token was only needed for the clone; strip it from the remote before any project code runs.
        await this.run(sb, `cd ${this.repoPath(s)} && git remote set-url origin https://github.com/${s.fullName}.git && git log -1 --oneline`, 60);
        for (const t of targets)
          if (t.manager === "yarn") s.yarnBerry[t.lockfile] = (await sb.exec(`grep -q __metadata ${this.repoPath(s, t.lockfile)}`)).exitCode === 0;
        return "patch";
      }

      case "patch": {
        await this.step("patch");
        const sb = await this.sandbox(s);
        for (const t of targets) {
          if (t.ecosystem === "PyPI") await this.patchPython(sb, s, t);
          else await this.patchNpm(sb, s, t);
        }
        s.cursor = 0;
        return "install";
      }

      case "install": {
        await this.step("install");
        const sb = await this.sandbox(s);
        const t = this.target(s);
        if (t.ecosystem === "PyPI") await this.installPython(sb, s, t);
        else await this.installNpm(sb, s, t);
        s.cursor++;
        if (s.cursor < targets.length) return "install";
        s.cursor = 0;
        return "verify";
      }

      case "verify": {
        await this.step("verify");
        const sb = await this.sandbox(s);
        for (const t of targets) await this.checkLockfile(sb, s, t);
        s.lockfileClean = true;
        this.info("Every lockfile is clean: no affected versions remain.");
        s.cursor = 0;
        return "test";
      }

      case "test": {
        await this.step("test");
        const sb = await this.sandbox(s);
        const t = this.target(s);
        s.tests[t.lockfile] ??= t.ecosystem === "PyPI" ? await this.pythonTestCommand(sb, s, t) : await this.npmTestCommand(sb, s, t);
        const command = s.tests[t.lockfile]!;
        const r = await this.run(sb, `cd ${this.dirPath(s, t)} && ${command}`, TEST_TIMEOUT);
        const passed = r.exitCode === 0;
        s.attempts.push({
          n: s.attempts.length + 1,
          lockfile: t.lockfile,
          passed,
          command,
          exitCode: r.exitCode,
          summary: passed ? "All checks passed" : r.output.trim().split("\n").slice(-6).join("\n").slice(0, 800),
        });
        if (passed) {
          s.cursor++;
          if (s.cursor < targets.length) return "test";
          return this.finishReady(sb, s);
        }
        s.lastFailure = r.output.slice(-8000);
        // An out-of-memory kill says nothing about the code; don't spend a repair round on it.
        if (/^Killed$|exit code 137|JavaScript heap out of memory|MemoryError/m.test(r.output.slice(-4000)))
          throw new Error("Checks were killed for running out of memory in the sandbox. Use a larger DAYTONA_SNAPSHOT. No PR will be offered.");
        if (s.repairs >= MAX_REPAIRS) throw new Error(`Checks still failing after ${MAX_REPAIRS} repair attempts. No PR will be offered.`);
        if (!this.env.CODEX_AUTH_JSON && !this.env.CLONVO_API_KEY)
          throw new Error("Checks failed and neither CODEX_AUTH_JSON nor CLONVO_API_KEY is set, so no agent can attempt a repair.");
        return "repair";
      }

      case "repair": {
        await this.step("repair");
        const sb = await this.sandbox(s);
        s.repairs++;
        await this.repair(sb, s, this.target(s));
        return "test";
      }

      case "preview": {
        // Best effort: the fix is already verified, so a preview that won't start never fails the run.
        try {
          return await this.startPreview(s);
        } catch (e) {
          await this.endPreview(s, `No live preview: ${(e as Error).message.slice(0, 300)}`, "unavailable");
          return "ready";
        }
      }

      default:
        return "done";
    }
  }

  // ── npm, pnpm, yarn, bun ──────────────────────────────────────────────────────────────────────────

  private async patchNpm(sb: Sandbox, s: State, t: LockfileFix): Promise<void> {
    let pnpmMajor = 0;
    if (t.manager !== "npm") {
      const tool = t.manager;
      const ensure =
        tool === "bun"
          ? `command -v bun || (curl -fsSL https://bun.sh/install | bash) || npm i -g --prefix ~/.local bun`
          : `command -v ${tool} || (mkdir -p ~/.local/bin && corepack enable --install-directory ~/.local/bin) || npm i -g --prefix ~/.local ${tool}`;
      const r = await this.run(sb, `cd ${this.dirPath(s, t)} && (${ensure}) >/dev/null 2>&1; ${tool} --version`, 180);
      if (r.exitCode !== 0) throw new Error(`Could not set up ${tool} in the sandbox`);
      if (tool === "pnpm") pnpmMajor = Number(/(\d+)\.\d+\.\d+\s*$/.exec(r.output.trim())?.[1] ?? 0);
    }
    await sb.writeFile("/tmp/fb-patch.cjs", PATCH_PACKAGE_JSON);
    const changed: string[] = [];
    let workspace: ReturnType<typeof parseDocument> | null = null;
    const workspaceFile = this.dirPath(s, t, "pnpm-workspace.yaml");
    for (const p of t.packages) {
      await sb.writeFile(
        "/tmp/fb-patch.json",
        JSON.stringify({ root: this.dirPath(s, t), name: p.package, to: p.to, manager: t.manager, strategy: p.strategy, exact: p.exact, pnpmMajor }),
      );
      // Short and output-critical, so it runs through the synchronous exec rather than the streamed session.
      this.emit({ type: "cmd", command: `patch package.json: ${p.package} → ${p.to}` });
      const r = await sb.exec("node /tmp/fb-patch.cjs /tmp/fb-patch.json", { timeoutSec: 60 });
      this.emit({ type: "exit", command: `patch package.json: ${p.package}`, exitCode: r.exitCode, ms: 0 });
      if (r.exitCode !== 0) throw new Error(`Could not edit package.json for ${p.package}: ${r.output.slice(-500)}`);
      const report = JSON.parse(r.output.trim().split("\n").pop() ?? "{}") as { changed: string[]; catalogs: { file: string; catalog: string }[]; overrideNeeded: boolean };

      // pnpm catalogs and pnpm >= 10 overrides live in pnpm-workspace.yaml.
      if (report.catalogs.length || report.overrideNeeded) {
        workspace ??= parseDocument((await sb.readFile(workspaceFile)) ?? "");
        const spec = p.exact ? p.to : `^${p.to}`;
        for (const c of new Set(report.catalogs.map((x) => x.catalog))) {
          const key = c === "default" && workspace.hasIn(["catalog", p.package]) ? ["catalog", p.package] : ["catalogs", c, p.package];
          workspace.setIn(key, spec);
          report.changed.push(`pnpm-workspace.yaml ${key.join(".")} = ${spec}`);
        }
        if (report.overrideNeeded) {
          workspace.setIn(["overrides", p.package], p.to);
          report.changed.push(`pnpm-workspace.yaml overrides.${p.package} = ${p.to}`);
        }
      }
      if (!report.changed.length) throw new Error(`Nothing in ${t.dir || "the repo root"} declares ${p.package} in a form Firebreak can edit`);
      changed.push(...report.changed);
    }
    if (workspace) await sb.writeFile(workspaceFile, workspace.toString());
    this.info(changed.join("\n"));
  }

  private async installNpm(sb: Sandbox, s: State, t: LockfileFix): Promise<void> {
    const cmd =
      t.manager === "npm"
        ? "npm install --ignore-scripts --no-audit --no-fund"
        : t.manager === "pnpm"
          ? "pnpm install --ignore-scripts --no-frozen-lockfile"
          : t.manager === "yarn"
            ? s.yarnBerry[t.lockfile]
              ? "YARN_ENABLE_IMMUTABLE_INSTALLS=false yarn install --mode=skip-build"
              : "yarn install --ignore-scripts --non-interactive --no-frozen-lockfile"
            : "bun install --ignore-scripts";
    let r = await this.run(sb, `cd ${this.dirPath(s, t)} && ${cmd}`, INSTALL_TIMEOUT);
    if (r.exitCode !== 0 && t.manager === "npm" && /ERESOLVE|peer dep/i.test(r.output)) {
      this.info("Peer dependency conflict; retrying with --legacy-peer-deps.");
      r = await this.run(sb, `cd ${this.dirPath(s, t)} && ${cmd} --legacy-peer-deps`, INSTALL_TIMEOUT);
    }
    if (r.exitCode !== 0) throw new Error(`Install failed in ${t.dir || "the repo root"} (exit ${r.exitCode ?? "timeout"})`);
  }

  /** Every package.json in a lockfile's project, with its scripts and web-framework dependencies. */
  private async workspace(sb: Sandbox, s: State, t: LockfileFix): Promise<WorkspacePackage[]> {
    await sb.writeFile("/tmp/fb-scan.cjs", SCAN_WORKSPACE);
    const r = await sb.exec(`node /tmp/fb-scan.cjs ${shq(this.dirPath(s, t))}`, { timeoutSec: 60 });
    try {
      return JSON.parse(r.output.trim().split("\n").pop() ?? "[]") as WorkspacePackage[];
    } catch {
      return [];
    }
  }

  private async npmTestCommand(sb: Sandbox, s: State, t: LockfileFix): Promise<string> {
    const raw = await sb.readFile(this.dirPath(s, t, "package.json"));
    const scripts = (raw ? (JSON.parse(raw) as { scripts?: Record<string, string> }).scripts : undefined) ?? {};
    const runner = t.manager === "npm" ? "npm run" : `${t.manager} run`;
    const expoApps = (await this.workspace(sb, s, t)).filter((p) => p.deps.includes("expo")).slice(0, 2);
    const parts: string[] = [];
    for (const name of ["typecheck", "type-check"]) if (scripts[name]) { parts.push(`${runner} ${name}`); break; }
    // Expo apps: a type check, a Metro bundle and the tests decide. Their `build` script is usually `eas build`, which needs an Expo login.
    if (!parts.length) for (const app of expoApps) if (app.tsconfig) parts.push(`(cd ${shq(app.dir || ".")} && npx tsc --noEmit)`);
    if (scripts.test && !/no test specified/.test(scripts.test)) {
      const base = t.manager === "npm" ? "npm test" : `${t.manager} run test`;
      // The Expo template's test script is `jest --watchAll`, which never exits.
      parts.push(/--watch(All)?\b/.test(scripts.test) ? `${base}${t.manager === "npm" ? " --" : ""} --watchAll=false` : base);
    } else if (scripts.build && !expoApps.length) parts.push(`${runner} build`);
    expoApps.forEach((app, i) => parts.push(`(cd ${shq(app.dir || ".")} && EXPO_NO_TELEMETRY=1 npx expo export --platform ios --output-dir /tmp/fb-export-${i})`));
    if (expoApps.length) await this.expoDoctor(sb, s, t, expoApps);
    if (parts.length) {
      this.info(`Checks for ${t.lockfile}: ${parts.join(" && ")}`);
      return parts.join(" && ");
    }
    this.info(`No test, typecheck or build script for ${t.lockfile}; confirming the installed versions only.`);
    const names = JSON.stringify(t.packages.map((p) => p.package));
    return `node -p ${shq(`${names}.map(n => n + " " + require("./node_modules/" + n + "/package.json").version).join("\\n")`)}`;
  }

  /** expo-doctor and `expo install --check`: reported and handed to the agent, never pass/fail. */
  private async expoDoctor(sb: Sandbox, s: State, t: LockfileFix, apps: WorkspacePackage[]): Promise<void> {
    const notes: string[] = [];
    for (const app of apps) {
      const dir = this.dirPath(s, t, app.dir);
      const where = app.dir || "the repo root";
      for (const [tool, cmd] of [
        ["expo.install", "npx expo install --check"],
        ["expo.doctor", "npx -y expo-doctor@latest"],
      ] as const) {
        const r = await sb.exec(`cd ${dir} && EXPO_NO_TELEMETRY=1 CI=1 timeout 150 ${cmd} 2>&1 | tail -c 2500`, { timeoutSec: 170 }).catch(() => null);
        if (!r) continue;
        const text = r.output.trim();
        const ok = r.exitCode === 0;
        const first = text.split("\n").find((l) => /\d+\/\d+ checks|up to date|should be updated|issues? (were )?found|checks? failed|Dependencies are up to date/i.test(l)) ?? (ok ? "No problems found" : text.split("\n").pop() ?? "");
        this.emit({ type: "tool", tool, text: `${app.name || where}: ${first.trim().slice(0, 200)}` });
        if (!ok && text) notes.push(`$ ${cmd} (in ${where})\n${text}`);
      }
    }
    s.expoNotes[t.lockfile] = notes.join("\n\n").slice(0, 5000);
    const sdk = t.expoSdk ? ` SDK ${t.expoSdk}` : "";
    this.info(`Expo${sdk} app${apps.length === 1 ? "" : "s"} found (${apps.map((a) => a.dir || ".").join(", ")}): checks are a type check, a Metro bundle and the tests. expo-doctor findings are passed to the agent, not counted as failures.`);
  }

  // ── Python: uv and pinned requirements ────────────────────────────────────────────────────────────

  private async ensureUv(sb: Sandbox, s: State): Promise<void> {
    if (s.uvReady) return;
    const r = await this.run(
      sb,
      `(command -v uv || (curl -LsSf https://astral.sh/uv/install.sh | sh) || python3 -m pip install --user -q uv) >/dev/null 2>&1; uv --version`,
      180,
      "uv --version",
    );
    if (r.exitCode !== 0) throw new Error("Could not set up uv in the sandbox");
    s.uvReady = true;
  }

  private async patchPython(sb: Sandbox, s: State, t: LockfileFix): Promise<void> {
    await this.ensureUv(sb, s);
    await sb.writeFile("/tmp/fb-patch.py", PATCH_PYTHON);
    await sb.writeFile(
      "/tmp/fb-patch-py.json",
      JSON.stringify({
        repo: this.repoPath(s),
        root: this.dirPath(s, t),
        manager: t.manager,
        file: this.repoPath(s, t.lockfile),
        packages: t.packages.map((p) => ({ name: p.package, to: p.to, exact: p.exact })),
      }),
    );
    const label = t.manager === "uv" ? "patch pyproject.toml" : `patch ${t.lockfile}`;
    this.emit({ type: "cmd", command: label });
    const r = await sb.exec("python3 /tmp/fb-patch.py /tmp/fb-patch-py.json", { timeoutSec: 60 });
    this.emit({ type: "exit", command: label, exitCode: r.exitCode, ms: 0 });
    if (r.exitCode !== 0) throw new Error(`Could not edit ${t.lockfile}: ${r.output.slice(-500)}`);
    const report = JSON.parse(r.output.trim().split("\n").pop() ?? "{}") as { changed: string[]; compile: { in: string; hashes: boolean } | null; error: string | null };
    if (report.error) throw new Error(report.error);
    s.pyCompile[t.lockfile] = report.compile;
    if (report.compile) this.info(`${t.lockfile} is compiled from ${report.compile.in.slice(this.repoPath(s).length + 1)}; it will be regenerated with the new pins.`);
    else if (report.changed.length) this.info(report.changed.join("\n"));
    else if (t.manager === "uv") this.info("pyproject.toml already allows every target version; uv lock pins them.");
    else throw new Error(`${t.lockfile} doesn't pin ${t.packages.map((p) => p.package).join(", ")}`);
  }

  private async installPython(sb: Sandbox, s: State, t: LockfileFix): Promise<void> {
    const dir = this.dirPath(s, t);
    const pins = (withVersion: boolean) => t.packages.map((p) => `-P ${shq(withVersion ? `${p.package}==${p.to}` : p.package)}`).join(" ");
    if (t.manager === "uv") {
      let r = await this.run(sb, `cd ${dir} && ${this.uv(s, t, `lock ${pins(true)}`)}`, INSTALL_TIMEOUT);
      if (r.exitCode !== 0) {
        this.info("uv couldn't lock the exact versions; letting it pick the newest allowed ones instead.");
        r = await this.run(sb, `cd ${dir} && ${this.uv(s, t, `lock ${pins(false)}`)}`, INSTALL_TIMEOUT);
      }
      if (r.exitCode !== 0) throw new Error(`uv lock failed in ${t.dir || "the repo root"} (exit ${r.exitCode ?? "timeout"})`);
      // Resolve first and check the result, so a known-bad release is never downloaded and built.
      await this.checkLockfile(sb, s, t);
      r = await this.run(sb, `cd ${dir} && (${this.uv(s, t, "sync --frozen --all-extras --all-groups")} || ${this.uv(s, t, "sync --frozen --all-extras")})`, INSTALL_TIMEOUT);
      if (r.exitCode !== 0) throw new Error(`uv sync failed in ${t.dir || "the repo root"} (exit ${r.exitCode ?? "timeout"})`);
      return;
    }
    const file = this.repoPath(s, t.lockfile);
    const fileDir = file.slice(0, file.lastIndexOf("/"));
    const compile = s.pyCompile[t.lockfile];
    if (compile) {
      const r = await this.run(
        sb,
        `cd ${fileDir} && uv pip compile ${shq(compile.in)} -o ${shq(file)} ${pins(true)}${compile.hashes ? " --generate-hashes" : ""}`,
        INSTALL_TIMEOUT,
      );
      if (r.exitCode !== 0) throw new Error(`Recompiling ${t.lockfile} failed (exit ${r.exitCode ?? "timeout"})`);
    }
    await this.checkLockfile(sb, s, t);
    const venv = this.venv(s, t);
    const r = await this.run(sb, `cd ${fileDir} && uv venv -q ${venv} && uv pip install --python ${venv} -r ${shq(file)}`, INSTALL_TIMEOUT);
    if (r.exitCode !== 0) throw new Error(`pip install failed for ${t.lockfile} (exit ${r.exitCode ?? "timeout"})`);
  }

  private async pythonTestCommand(sb: Sandbox, s: State, t: LockfileFix): Promise<string> {
    const dir = this.dirPath(s, t);
    const hasTests =
      (
        await sb.exec(
          `cd ${dir} && { ls -d pytest.ini conftest.py tests test 2>/dev/null | grep -q . || grep -qs '^\\[tool.pytest' pyproject.toml || grep -qs '^\\[tool:pytest\\]' setup.cfg || grep -qs '^\\[pytest\\]' tox.ini; }`,
        )
      ).exitCode === 0;
    const venv = this.venv(s, t);
    const py = t.manager === "uv" ? this.uv(s, t, "run --frozen python") : `${venv}/bin/python`;
    if (hasTests) {
      const pytest =
        t.manager === "uv"
          ? this.uv(s, t, "run --frozen --with pytest python -m pytest -q")
          : `{ ${venv}/bin/python -m pytest --version >/dev/null 2>&1 || uv pip install -q --python ${venv} pytest; } && ${venv}/bin/python -m pytest -q`;
      this.info(`Checks for ${t.lockfile}: pytest`);
      // pytest exits 5 when it collects no tests; that's not a failure of the upgrade.
      return `( ${pytest}; rc=$?; if [ $rc -eq 5 ]; then echo "pytest collected no tests"; rc=0; fi; exit $rc )`;
    }
    this.info(`No tests found for ${t.lockfile}; compiling every module and confirming the installed versions.`);
    const names = JSON.stringify(t.packages.map((p) => p.package));
    return `${py} -m compileall -q -x '(^|/)(\\.venv|venv|node_modules|\\.git)(/|$)' . && ${py} -c ${shq(`import importlib.metadata as m; [print(n, m.version(n)) for n in ${names}]`)}`;
  }

  // ── lockfile check (shared) ───────────────────────────────────────────────────────────────────────

  /** Fails the run if any bumped package still resolves a version flagged by any known advisory. */
  private async checkLockfile(sb: Sandbox, s: State, t: LockfileFix): Promise<void> {
    const lock = await sb.readFile(this.repoPath(s, t.lockfile));
    if (lock === null) throw new Error(`Lockfile ${t.lockfile} missing after install`);
    const manifest = t.manager === "pip" ? null : await sb.readFile(this.dirPath(s, t, t.manager === "uv" ? "pyproject.toml" : "package.json"));
    const deps = parseLockfile(t.manager, t.lockfile, lock, manifest);
    const bad: string[] = [];
    for (const p of t.packages) {
      const found = deps.filter((d) => d.name === p.package);
      const affected = s.avoid[`${t.ecosystem}:${p.package}`] ?? [];
      const hits = found.filter((d) => affected.some((a) => isAffected(d.version, a, t.ecosystem)));
      this.info(`${p.package} in ${t.lockfile}: ${found.map((d) => d.version).join(", ") || "not present"}`);
      if (hits.length) bad.push(`${p.package} ${hits.map((d) => d.version).join(", ")}`);
    }
    if (bad.length) {
      s.lockfileClean = false;
      // Never run project code next to a known-bad version.
      throw new Error(`${t.lockfile} still resolves affected versions (${bad.join("; ")}). Stopping before any tests run.`);
    }
  }

  // ── agent repair ──────────────────────────────────────────────────────────────────────────────────

  private async repair(sb: Sandbox, s: State, t: LockfileFix): Promise<void> {
    const python = t.ecosystem === "PyPI";
    const root = this.repoPath(s);
    const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
    let grepCmd: string;
    let fromError: string[];
    const failure = s.lastFailure ?? "";
    if (python) {
      const modules = t.packages.map((p) => esc(p.package.replace(/-/g, "_"))).join("|");
      grepCmd = `cd ${root} && grep -rliE "^\\s*(from|import)\\s+(${modules})\\b" --include=*.py --exclude-dir=.venv --exclude-dir=venv --exclude-dir=.git --exclude-dir=node_modules . | head -8`;
      fromError = [
        ...[...failure.matchAll(/File "([^"]+\.py)", line \d+/g)].map((m) => m[1]!),
        ...[...failure.matchAll(/(?:^|\s)((?:\.\/)?(?:[\w.-]+\/)*[\w.-]+\.py):\d+/gm)].map((m) => m[1]!),
      ]
        .filter((f) => !/site-packages|\/tmp\/|^\/usr\//.test(f))
        .map((f) => (f.startsWith(`${root}/`) ? f.slice(root.length + 1) : f.startsWith("/") ? "" : t.dir && !f.startsWith(t.dir) ? `${t.dir}/${f.replace(/^\.\//, "")}` : f.replace(/^\.\//, "")))
        .filter(Boolean);
    } else {
      const names = t.packages.map((p) => esc(p.package)).join("|");
      grepCmd = `cd ${root} && grep -rlE "(from ['\\"](${names})(/[^'\\"]*)?['\\"]|require\\(['\\"](${names}))" --include=*.ts --include=*.tsx --include=*.js --include=*.jsx --include=*.mjs --include=*.cjs --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=.git . | head -8`;
      fromError = [...failure.matchAll(/((?:\.\/)?(?:[\w.-]+\/)*[\w.-]+\.(?:tsx?|jsx?|mjs|cjs))[:(]\d+/g)]
        .map((m) => m[1]!.replace(/^\.\//, ""))
        .filter((f) => !f.includes("node_modules"))
        .map((f) => (t.dir && !f.startsWith(t.dir) ? `${t.dir}/${f}` : f));
    }
    const changes = t.packages.map((p) => `${p.package} ${p.from.join("/")} → ${p.to}`);

    // Migration notes for the bump most likely behind the failure: one named in the output, else the first.
    const suspect = t.packages.find((p) => failure.toLowerCase().includes(p.package.toLowerCase())) ?? t.packages[0]!;
    let notes = "";
    if (this.env.YOU_API_KEY) {
      try {
        const results = await search(this.env, `${suspect.package} ${suspect.to} migration guide breaking changes upgrade from ${suspect.from.at(-1)}`, { count: 5, highlights: true });
        notes = results
          .map((r) => `Source: ${r.url}\n${(r.highlights.length ? r.highlights : r.snippets).slice(0, 4).join("\n")}`)
          .join("\n\n")
          .slice(0, 10_000);
        for (const r of results.slice(0, 3)) if (!s.migrationSources.some((m) => m.url === r.url)) s.migrationSources.push({ kind: "news", title: r.title, url: r.url });
        this.emit({ type: "tool", tool: "you.search", text: `${suspect.package} ${suspect.to} migration notes: ${results.length} sources` });
      } catch (e) {
        this.info(`Migration search skipped: ${(e as Error).message}`);
      }
    }

    const history = await this.historyNotes(s, suspect, failure);
    const language = python ? "Python" : "JavaScript/TypeScript";
    const manifests = python ? "lockfiles, pyproject.toml, requirements files, virtualenvs" : "lockfiles, package.json, node_modules";
    if (this.env.CODEX_AUTH_JSON) {
      let edits = 0;
      let why = "";
      try {
        edits = await this.codexRepair(sb, s, t, { failure, notes, history, suspect: suspect.package, language, manifests });
        if (!edits) why = "Codex made no source change for this failure";
      } catch (e) {
        why = (e as Error).message;
      }
      // The agent had a shell: the lockfiles must still be exactly as verified before anything else runs.
      for (const target of s.plan.targets) await this.checkLockfile(sb, s, target);
      if (edits) return;
      if (!this.env.CLONVO_API_KEY) throw new Error(`${why}. No PR will be offered.`);
      this.emit({ type: "log", stream: "err", text: `Codex: ${why}.` });
      this.emit({ type: "tool", tool: "clonvo.fallback", text: "Falling back to Clonvo for this repair" });
    }
    s.agent = "clonvo";
    const grep = await sb.exec(grepCmd);
    const files = [...new Set([...grep.output.split("\n").map((f) => f.trim().replace(/^\.\//, "")).filter(Boolean), ...new Set(fromError.slice(0, 6))])].slice(0, 10);
    const contents: string[] = [];
    for (const f of files) {
      const text = await sb.readFile(this.repoPath(s, f));
      if (text !== null) contents.push(`--- ${f}\n${text.slice(0, 15_000)}`);
    }
    this.emit({ type: "agent", text: `Reading ${contents.length} file${contents.length === 1 ? "" : "s"} that use ${t.packages.map((p) => p.package).join(", ")} or appear in the failure.` });
    const reply = await chat(
      this.env,
      this.env.FIX_MODEL,
      [
        {
          role: "system",
          content: `You repair a ${language} codebase after dependency version changes. Make the smallest source edits that make the failing checks pass. Never edit ${manifests}, or tests' expectations to hide failures. Each edit's \`find\` must be copied exactly from the file and match once. Reply with JSON only.`,
        },
        {
          role: "user",
          content: `Dependency changes in ${t.lockfile} (${t.manager}):\n${changes.join("\n")}\nCommand: ${s.tests[t.lockfile]}\n\nFailure output (tail):\n${failure}\n\nMigration notes (${suspect.package}):\n${notes || "(none)"}\n\n${history ? `How earlier agent sessions handled this (OpenCrawl):\n${history}\n\n` : ""}${s.expoNotes[t.lockfile] ? `expo-doctor (informational):\n${s.expoNotes[t.lockfile]}\n\n` : ""}Files (paths relative to the repo root):\n${contents.join("\n\n") || "(none found)"}\n\nReply as {"explanation":"one or two sentences","edits":[{"path":"src/file.ext","find":"exact old text","replace":"new text"}]}. Use an empty edits list if the failure is unrelated to the upgrades.`,
        },
      ],
      { maxTokens: 6000 },
    );
    const plan = parseJsonReply<{ explanation?: string; edits?: { path: string; find: string; replace: string }[] }>(reply);
    if (plan.explanation) {
      s.agentNotes.push(plan.explanation);
      this.emit({ type: "agent", text: plan.explanation });
    }
    const edits = plan.edits ?? [];
    if (!edits.length) throw new Error("The agent found no safe source change for this failure. No PR will be offered.");
    await sb.writeFile("/tmp/fb-apply.cjs", APPLY_EDITS);
    await sb.writeFile("/tmp/fb-edits.json", JSON.stringify({ root, edits }));
    const r = await sb.exec("node /tmp/fb-apply.cjs /tmp/fb-edits.json");
    let report: { path: string; ok: boolean; error?: string }[] = [];
    try {
      report = JSON.parse(r.output.trim().split("\n").pop() ?? "[]");
    } catch {
      throw new Error(`Applying edits failed: ${r.output.slice(0, 300)}`);
    }
    for (const item of report) this.emit({ type: "agent", text: item.ok ? `Edited ${item.path}` : `Skipped ${item.path}: ${item.error}` });
    if (!report.some((i) => i.ok)) throw new Error("None of the agent's edits applied cleanly.");
  }

  // ── OpenCrawl: shared agent history and the board other runs post to ─────────────────────────────

  private boardTopics(s: State): string[] {
    const packages = s.plan.targets.flatMap((t) => t.packages.map((p) => packageTopic(t.ecosystem, p.package)));
    return [repoTopic(s.fullName), ...new Set(packages)].slice(0, 8);
  }

  private agentName(s: State) {
    return `firebreak-${s.runId}`;
  }

  /** Reads what other runs and agents posted about this repo and these packages, so this run starts from it. */
  private async readBoard(s: State): Promise<void> {
    if (!opencrawlEnabled(this.env)) return;
    const topics = this.boardTopics(s);
    try {
      const msgs = (await boardSync(this.env, this.agentName(s), topics)).filter((m) => m.name !== this.agentName(s));
      s.boardNotes = msgs.slice(-12).map((m) => `[${m.topic}] ${m.name}: ${m.text}`);
      s.history = { found: s.history?.found ?? 0, board: msgs.length };
      await this.save();
      this.emit({
        type: "tool",
        tool: "opencrawl.board",
        text: msgs.length
          ? `${msgs.length} note${msgs.length === 1 ? "" : "s"} from other runs on ${topics.length} topic${topics.length === 1 ? "" : "s"}`
          : `No notes yet on ${topics.length} topic${topics.length === 1 ? "" : "s"} (${topics[0]}…). This run will leave one.`,
      });
      for (const m of msgs.slice(-4)) this.emit({ type: "tool", tool: "opencrawl.board", text: `${m.name}: ${m.text.slice(0, 220)}` });
    } catch (e) {
      this.info(`OpenCrawl board skipped: ${(e as Error).message.slice(0, 200)}`);
    }
  }

  /** Leaves the outcome on the repo topic and the first package topics, for the next run or agent that touches them. */
  private async postBoard(s: State, ok: boolean): Promise<void> {
    if (!opencrawlEnabled(this.env)) return;
    const all = planPackages(s.plan);
    const bumps = all.map((p) => `${p.package} ${p.from.at(-1)}→${p.to}`).join(", ");
    const how = s.agentNotes.length ? ` Agent: ${s.agentNotes.at(-1)}` : s.repairs ? "" : " No source changes needed.";
    const summary = ok
      ? `${s.fullName}: verified ${bumps}. Checks: ${Object.values(s.tests).join(" · ") || "n/a"}.${how}`
      : `${s.fullName}: failed bumping ${bumps}. ${s.error ?? ""}${how}`;
    const posts = [
      { id: `${s.runId}-repo`, topic: repoTopic(s.fullName), text: summary },
      ...s.plan.targets
        .flatMap((t) => t.packages.map((p) => ({ t, p })))
        .slice(0, 2)
        .map(({ t, p }) => ({
          id: `${s.runId}-${p.package}`.slice(0, 80),
          topic: packageTopic(t.ecosystem, p.package),
          text: `${p.package} ${p.from.at(-1)}→${p.to} in ${s.fullName} (${t.manager}${t.expoSdk ? `, Expo SDK ${t.expoSdk}` : ""}): ${ok ? "checks pass" : "failed"}.${how}`,
        })),
    ];
    try {
      await boardSync(this.env, this.agentName(s), this.boardTopics(s), posts);
      this.emit({ type: "tool", tool: "opencrawl.board", text: `Posted the outcome to ${posts.length} topic${posts.length === 1 ? "" : "s"} for other runs and agents` });
    } catch (e) {
      this.info(`OpenCrawl post skipped: ${(e as Error).message.slice(0, 200)}`);
    }
  }

  /** Searches captured agent sessions for earlier work on this package and failure. */
  private async historyNotes(s: State, suspect: { package: string; to: string }, failure: string): Promise<string> {
    const board = s.boardNotes.length ? `Board notes from other runs:\n${s.boardNotes.join("\n")}` : "";
    if (!opencrawlEnabled(this.env)) return board;
    // Lexical search: a short, distinctive query works best; the error code if there is one, else the package.
    const code = /\b(TS\d{4}|ERR_[A-Z_]+|[A-Z][a-zA-Z]+Error)\b/.exec(failure)?.[1];
    const queries = [suspect.package, ...(code ? [`${suspect.package} ${code}`] : [])];
    const hits: string[] = [];
    for (const q of queries) {
      try {
        const found = await searchHistory(this.env, q, 4);
        this.emit({ type: "tool", tool: "opencrawl.search", text: `"${q}": ${found.length} passage${found.length === 1 ? "" : "s"} in agent history` });
        for (const h of found) if (h.text) hits.push(`- ${h.title} (${h.source}): ${h.text}`);
      } catch (e) {
        this.info(`OpenCrawl search skipped: ${(e as Error).message.slice(0, 200)}`);
        break;
      }
    }
    s.history = { found: (s.history?.found ?? 0) + hits.length, board: s.history?.board ?? 0 };
    return [hits.join("\n").slice(0, 6000), board].filter(Boolean).join("\n\n");
  }

  // ── Codex as the repair agent ─────────────────────────────────────────────────────────────────────

  private async ensureCodex(sb: Sandbox): Promise<void> {
    const r = await this.run(sb, `(command -v codex || npm i -g --prefix ~/.local @openai/codex) >/dev/null 2>&1; codex --version`, 240, "codex --version");
    if (r.exitCode !== 0) throw new Error("Could not install Codex in the sandbox");
  }

  /**
   * Runs Codex headless in the project with the failure, migration notes and OpenCrawl history. It can read, edit and
   * re-run the checks itself, and reach OpenCrawl over MCP. The ChatGPT sign-in goes into a private CODEX_HOME that is
   * deleted afterwards, and no token appears in the run log. Returns how many files it changed; throws when it couldn't run.
   */
  private async codexRepair(
    sb: Sandbox,
    s: State,
    t: LockfileFix,
    ctx: { failure: string; notes: string; history: string; suspect: string; language: string; manifests: string },
  ): Promise<number> {
    const raw = this.env.CODEX_AUTH_JSON!;
    let auth: Record<string, unknown>;
    try {
      auth = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      throw new Error("CODEX_AUTH_JSON is not valid JSON. Put the whole of ~/.codex/auth.json in the secret");
    }
    // Every token in the sign-in, so none of them can reach the run log.
    const tokens = auth.tokens && typeof auth.tokens === "object" ? Object.values(auth.tokens as Record<string, unknown>) : [];
    const oc = this.env.OPENCRAWL_TOKEN;
    const secrets = [...tokens, auth.OPENAI_API_KEY, oc].filter((x): x is string => typeof x === "string" && x.length > 8);
    const redact = (x: string) => secrets.reduce((acc, sec) => acc.split(sec).join("***"), x);

    await this.ensureCodex(sb);
    const home = "/tmp/fb-codex";
    await sb.exec(`rm -rf ${home} && mkdir -p ${home} && chmod 700 ${home}`);
    // A fresh last_refresh keeps Codex from refreshing the login up front, which would rotate the token you use locally.
    await sb.writeFile(`${home}/auth.json`, JSON.stringify({ ...auth, last_refresh: new Date().toISOString() }));
    await sb.writeFile(
      `${home}/config.toml`,
      [
        `cli_auth_credentials_store = "file"`,
        `check_for_update_on_startup = false`,
        ...(oc ? [``, `[mcp_servers.opencrawl]`, `url = "${opencrawlApi(this.env)}/mcp"`, `bearer_token_env_var = "OPENCRAWL_TOKEN"`] : []),
      ].join("\n") + "\n",
    );
    if (oc) await sb.writeFile("/tmp/fb-agent.env", `export OPENCRAWL_TOKEN=${shq(oc)}\n`);
    await sb.writeFile("/tmp/fb-codex-filter.cjs", CODEX_FILTER);
    const dir = this.dirPath(s, t);
    const command = s.tests[t.lockfile]!;
    const changes = t.packages.map((p) => `- ${p.package} ${p.from.join("/")} → ${p.to} (${p.strategy})`).join("\n");
    const topic = packageTopic(t.ecosystem, ctx.suspect);
    const prompt = [
      `Firebreak bumped dependencies in ${s.fullName} to clear security advisories, and the project's checks now fail. Make them pass.`,
      ``,
      `Project directory: ${dir} (lockfile ${t.lockfile}, ${t.manager}${t.expoSdk ? `, Expo SDK ${t.expoSdk} app` : ""}).`,
      `Dependency changes:\n${changes}`,
      `Failing check, run from the project directory: ${command}`,
      ``,
      `Failure output (tail):\n${ctx.failure.slice(-5000)}`,
      ...(ctx.notes ? [``, `Migration notes for ${ctx.suspect} (You.com):\n${ctx.notes.slice(0, 5000)}`] : []),
      ...(ctx.history ? [``, `Earlier agent work on this (OpenCrawl history and board):\n${ctx.history}`] : []),
      ...(s.expoNotes[t.lockfile] ? [``, `expo-doctor output (informational; fix only what the bump caused):\n${s.expoNotes[t.lockfile]}`] : []),
      ``,
      `Rules:`,
      `- Make the smallest ${ctx.language} source changes that make the check pass, and keep the new dependency versions.`,
      `- Don't edit ${ctx.manifests}. Don't install, add, remove or upgrade packages: dependencies are already installed with lifecycle scripts disabled.`,
      `- Don't delete, skip or loosen tests to hide a failure.`,
      `- Don't commit, push or touch git config. Leave the changes in the working tree.`,
      `- Don't read or print anything under ${home} or environment variables holding tokens.`,
      `- Re-run the failing check to confirm before you stop. If the failure has nothing to do with the bump, say so and change nothing.`,
      ...(oc
        ? [
            `- OpenCrawl tools are available (MCP server "opencrawl"). Search agent history for this package or error before guessing.`,
            `  When done, call board_topics for the workspace id and post one short board_sync note on topic "${topic}" (agent "${this.agentName(s)}") saying what broke and what you changed, so other runs fixing ${ctx.suspect} can reuse it.`,
          ]
        : []),
      ``,
      `End with one or two plain sentences: what broke and what you changed.`,
    ].join("\n");
    await sb.writeFile("/tmp/fb-prompt.md", prompt);

    const flags = `--json --ephemeral --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox -C ${shq(dir)}`;
    const display = `codex exec <repair brief> --json --dangerously-bypass-approvals-and-sandbox${oc ? " (MCP: opencrawl)" : ""}`;
    this.emit({ type: "cmd", command: display });
    this.emit({ type: "tool", tool: "codex.start", text: `Codex is repairing ${t.dir || "the repo root"} (up to ${AGENT_TIMEOUT_SEC / 60} min)` });
    const started = Date.now();
    const cmdId = await sb.startCommand(
      SESSION,
      `cd ${dir} && ${oc ? ". /tmp/fb-agent.env && rm -f /tmp/fb-agent.env && " : ""}CODEX_HOME=${home} codex exec ${flags} - < /tmp/fb-prompt.md 2>/tmp/fb-codex.err | node /tmp/fb-codex-filter.cjs`,
    );
    let consumed = 0;
    type AgentResult = { ok: boolean; subtype?: string; text: string; commands?: number; tokens?: number };
    let result: AgentResult | null = null;
    let exitCode: number | null = null;
    let edits = 0;
    const errors: string[] = [];
    const handle = (line: string) => {
      let e: { k: string; [k: string]: unknown };
      try {
        e = JSON.parse(line);
      } catch {
        return;
      }
      const text = redact(String(e.text ?? ""));
      if (e.k === "init") this.emit({ type: "tool", tool: "codex.init", text: `Codex session started${oc ? " · MCP opencrawl" : ""}` });
      else if (e.k === "text") this.emit({ type: "agent", text });
      else if (e.k === "tool") {
        const name = String(e.tool ?? "");
        const tool = name.startsWith("mcp__opencrawl__")
          ? `opencrawl.${name.slice("mcp__opencrawl__".length).replace(/^board_.*/, "board")}`
          : `codex.${name}`;
        if (name === "Edit") edits++;
        this.emit({ type: "tool", tool, text });
      } else if (e.k === "toolerr" || e.k === "error") {
        errors.push(text);
        this.emit({ type: "log", stream: "err", text: `codex: ${text}` });
      } else if (e.k === "result")
        result = { ok: !!e.ok, subtype: e.subtype as string | undefined, text, commands: e.commands as number, tokens: e.tokens as number };
    };
    while (Date.now() - started < AGENT_TIMEOUT_SEC * 1000) {
      await sleep(2500);
      exitCode = await sb.commandStatus(SESSION, cmdId).catch(() => null);
      const out = await sb.commandLogs(SESSION, cmdId).catch(() => null);
      if (out && out.length > consumed) {
        const end = exitCode !== null ? out.length : out.lastIndexOf("\n") + 1;
        if (end > consumed) {
          for (const line of out.slice(consumed, end).split("\n")) if (line.trim()) handle(line);
          consumed = end;
        }
      }
      if (exitCode !== null) break;
    }
    if (exitCode === null) {
      await sb.exec("pkill -f 'codex exec' || true").catch(() => undefined);
      this.emit({ type: "log", stream: "err", text: `Codex stopped after ${AGENT_TIMEOUT_SEC / 60} minutes.` });
    }
    const stderr = redact((await sb.exec("tail -c 1500 /tmp/fb-codex.err").catch(() => ({ output: "" }))).output.trim());
    await sb.exec(`rm -rf ${home} /tmp/fb-agent.env /tmp/fb-codex.err`).catch(() => undefined);
    const r = result as AgentResult | null;
    this.emit({ type: "exit", command: display, exitCode: r?.ok ? 0 : (exitCode ?? null), ms: Date.now() - started });
    const signIn = /401|unauthori[sz]ed|refresh.?token|log ?in again|token.*(expired|revoked|invalid)/i;
    if (!edits && (signIn.test(stderr) || errors.some((x) => signIn.test(x)) || (r && !r.ok && signIn.test(r.text))))
      throw new Error("Codex couldn't use the ChatGPT sign-in in CODEX_AUTH_JSON. Run `codex login` locally, then put ~/.codex/auth.json in the secret again");
    if (!r) {
      if (!edits) throw new Error(`Codex ${exitCode === null ? "timed out" : "exited"} without a result${stderr ? `: ${stderr.slice(-300)}` : ""}`);
    } else {
      const facts = [r.commands ? `${r.commands} commands` : "", edits ? `${edits} edit${edits === 1 ? "" : "s"}` : "", r.tokens ? `${Math.round(r.tokens / 1000)}k tokens` : ""].filter(Boolean).join(" · ");
      this.emit({ type: "tool", tool: "codex.result", text: `${r.ok ? "Finished" : `Stopped (${r.subtype ?? "error"})`}${facts ? ` · ${facts}` : ""}` });
      if (r.text) s.agentNotes.push(r.text.slice(0, 500));
    }
    if (edits) s.agent = "codex";
    return edits;
  }

  private async finishReady(sb: Sandbox, s: State): Promise<Phase> {
    const status = await sb.exec(`cd ${this.repoPath(s)} && git status --porcelain`);
    s.changedFiles = status.output
      .split("\n")
      .map((l) => l.slice(3).trim())
      .filter((f) => f && !/(^|\/)(node_modules|__pycache__|\.pytest_cache|\.mypy_cache|\.ruff_cache|\.venv|venv)(\/|$)|\.egg-info(\/|$)/.test(f));
    const diff = await sb.exec(`cd ${this.repoPath(s)} && git diff --stat && echo && git diff -- . ':(exclude)*lock*' ':(exclude)*.lockb'`);
    s.diff = diff.output.slice(0, 30_000);
    // Keep the verified files here so the sandbox can go now; the PR doesn't depend on it staying alive.
    for (const path of s.changedFiles) {
      if (path.endsWith(".lockb") || path.endsWith("/")) continue;
      const content = await sb.readFile(this.repoPath(s, path));
      if (content !== null) this.storeFile(path, content);
    }
    s.verifiedMs = Date.now() - s.startedAt;
    await this.save();
    await this.setStatus("passed", "ready");
    await this.postBoard(s, true);
    this.info("Fix verified. Review the receipt, then open the PR when you're ready. Starting a live preview of the patched app…");
    return "preview";
  }

  // ── live preview (after a verified fix) ───────────────────────────────────────────────────────────

  /** Finds a web app in the changed JS projects (workspace packages included) and the command that serves it on PREVIEW_PORT. */
  private async previewCommand(sb: Sandbox, s: State): Promise<{ command: string; dir: string; framework: string } | null> {
    const found: { command: string; dir: string; framework: string; score: number; depth: number }[] = [];
    for (const t of s.plan.targets) {
      if (t.ecosystem !== "npm") continue;
      for (const pkg of await this.workspace(sb, s, t)) {
        const pick = webCommand(pkg, t.manager);
        if (pick) found.push({ ...pick, dir: this.dirPath(s, t, pkg.dir), depth: pkg.dir ? pkg.dir.split("/").length : 0 });
      }
    }
    found.sort((a, b) => b.score - a.score || a.depth - b.depth);
    return found[0] ?? null;
  }

  private async startPreview(s: State): Promise<Phase> {
    const sb = await this.sandbox(s);
    const picked = await this.previewCommand(sb, s);
    if (!picked) {
      const note = s.plan.targets.some((t) => t.ecosystem === "npm")
        ? "No web app found to serve. Looked for Next.js, Vite, Astro, Remix, React Router, Nuxt, SvelteKit, Wrangler and Expo web (with react-native-web) dev scripts."
        : "Live preview covers JavaScript apps with a dev, start or preview script; this run only changed Python projects.";
      await this.endPreview(s, note, "unavailable");
      return "ready";
    }
    const { command, dir, framework } = picked;
    const rel = dir.slice(this.repoPath(s).length + 1);
    this.info(`Serving the ${framework} app${rel ? ` in ${rel}` : ""}.`);
    await this.setPreview(s, { state: "starting", command, port: PREVIEW_PORT, framework, dir: rel || undefined });
    const signed = await sb.signedPreviewUrl(PREVIEW_PORT, PREVIEW_TTL_SEC);
    const host = new URL(signed.url).hostname;
    // Vite refuses unknown Host headers in dev; allow the preview proxy's domain.
    const allowed = host.includes(".") ? host.slice(host.indexOf(".")) : host;
    this.emit({ type: "cmd", command });
    await sb.startCommand(
      SESSION,
      `cd ${dir} && EXPO_NO_TELEMETRY=1 PORT=${PREVIEW_PORT} HOST=0.0.0.0 HOSTNAME=0.0.0.0 BROWSER=none __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS=${allowed} nohup ${command} > /tmp/fb-preview.log 2>&1 &`,
    );
    const started = Date.now();
    let up = false;
    while (Date.now() - started < PREVIEW_BOOT_SEC * 1000) {
      await sleep(3000);
      const probe = await sb
        .exec(`node -e "fetch('http://127.0.0.1:${PREVIEW_PORT}/').then(r=>console.log(r.status)).catch(()=>console.log(0))"`, { timeoutSec: 15 })
        .catch(() => ({ exitCode: 1, output: "0" }));
      if (Number(probe.output.trim().split("\n").pop()) > 0) {
        up = true;
        break;
      }
    }
    const log = (await sb.exec("tail -c 3000 /tmp/fb-preview.log").catch(() => ({ exitCode: 1, output: "" }))).output;
    if (log.trim()) this.emit({ type: "log", stream: "out", text: log });
    if (!up) throw new Error(`the app did not answer on port ${PREVIEW_PORT} within ${PREVIEW_BOOT_SEC}s`);
    this.emit({ type: "exit", command, exitCode: 0, ms: Date.now() - started });
    const expiresAt = new Date(Date.now() + PREVIEW_TTL_SEC * 1000).toISOString();
    await this.setPreview(s, { state: "live", url: signed.url, command, port: PREVIEW_PORT, expiresAt, framework, dir: rel || undefined });
    this.info(`Live preview is up for ${PREVIEW_TTL_SEC / 60} minutes. The sandbox is deleted when it expires.`);
    return "previewing";
  }

  /** Deletes the sandbox and records why the preview isn't (or is no longer) available. */
  private async endPreview(s: State, note: string, state: RunPreview["state"] = "ended"): Promise<void> {
    if (s.sandboxId) {
      const sb = await Sandbox.attach(this.env, s.sandboxId).catch(() => null);
      await sb?.delete().catch(() => undefined);
      s.sandboxId = undefined;
    }
    this.info(note);
    await this.setPreview(s, { ...s.preview, state, url: undefined, expiresAt: undefined, note });
  }

  // ── PR (only when the user clicks) ────────────────────────────────────────────────────────────────

  private async openPr(): Promise<string> {
    const s = await this.load();
    if (s.prUrl) return s.prUrl;
    if (s.status !== "passed") throw new Error("Only a passing run can open a PR");
    this.info("Opening the pull request…");
    let files = this.storedFiles();
    // Runs verified before files were stored here still read them from their sandbox, if it's alive.
    if (!files.length && s.sandboxId) {
      const sb = await this.sandbox(s);
      for (const path of s.changedFiles) {
        if (path.endsWith(".lockb")) continue;
        const content = await sb.readFile(this.repoPath(s, path));
        if (content !== null) files.push({ path, content });
      }
    }
    if (!files.length) throw new Error("No changed files to commit");
    const all = planPackages(s.plan);
    const ids = s.incidents.map((i) => i.id);
    const one = all.length === 1 ? all[0]! : null;
    const verb = one ? (one.strategy === "pin-back" ? "pin" : one.strategy === "override" ? "override" : "upgrade") : "bump";
    const title = one
      ? `fix(deps): ${verb} ${one.package} ${one.from.join(", ")} → ${one.to}${ids.length === 1 ? ` (${ids[0]})` : ""}`
      : `fix(deps): bump ${all.length} packages to clear ${ids.length} advisor${ids.length === 1 ? "y" : "ies"}`;
    const url = await openPullRequest(this.env, {
      fullName: s.fullName,
      base: s.defaultBranch,
      branch: one
        ? `firebreak/${one.package.replace(/[@/]/g, "-").replace(/^-/, "")}-${one.to}-${s.runId.slice(0, 6)}`
        : `firebreak/fix-${all.length}-packages-${s.runId.slice(0, 6)}`,
      title,
      message: `${title}\n\n${all.map((p) => `- ${p.package} ${p.from.join(", ")} → ${p.to} (${p.lockfile})`).join("\n")}\n\n${s.incidents.map((i) => `${i.id}: ${i.title}`).join("\n")}`,
      body: this.receipt(s),
      files,
    });
    s.prUrl = url;
    await this.save();
    this.emit({ type: "agent", text: `Pull request opened: ${url}` });
    await this.setStatus("pr_opened", "ready");
    // A live preview keeps its sandbox until it expires or is stopped.
    if (s.sandboxId && s.phase !== "preview" && s.phase !== "previewing") {
      const sb = await Sandbox.attach(this.env, s.sandboxId).catch(() => null);
      await sb?.delete().catch(() => undefined);
      s.sandboxId = undefined;
      await this.save();
    }
    return url;
  }

  private receipt(s: State): string {
    const all = planPackages(s.plan);
    const secs = Math.round((s.verifiedMs ?? Date.now() - s.startedAt) / 1000);
    const python = s.plan.targets.some((t) => t.ecosystem === "PyPI");
    const npm = s.plan.targets.some((t) => t.ecosystem === "npm");
    const cell = (x: string) => x.replace(/\|/g, "\\|");
    const lines = [
      `## Firebreak hotfix receipt`,
      ``,
      `| Package | From | To | Change | Lockfile | Advisories |`,
      `| --- | --- | --- | --- | --- | --- |`,
      ...all.map(
        (p) =>
          `| \`${p.package}\` | ${p.from.join(", ")} | **${p.to}** | ${p.strategy} | \`${cell(p.lockfile)}\` | ${p.incidents.map((i) => `${i.id}${i.kind === "malicious" ? " (malicious)" : i.severity ? ` (${i.severity})` : ""}`).join(", ") || "n/a"} |`,
      ),
      ``,
      `**Why these versions**`,
      ...all.map((p) => `- \`${p.package}\`: ${p.reason}`),
      ``,
      `### Verified in an isolated Daytona sandbox`,
      ...(s.agent === "codex" ? [`- Repaired by Codex inside the sandbox; the checks were then re-run independently`] : []),
      ...(npm ? [`- npm installs ran with lifecycle scripts disabled`] : []),
      ...(python ? [`- Python lockfiles were resolved and checked before anything was installed`] : []),
      `- Lockfiles clean: ${s.lockfileClean ? "yes, no affected versions of the bumped packages remain" : "not verified"}`,
      `- Checks:`,
      ...s.attempts.map((a) => `  - Attempt ${a.n}${a.lockfile ? ` (\`${a.lockfile}\`)` : ""}: \`${a.command}\` ${a.passed ? "✅ passed" : `❌ failed (exit ${a.exitCode ?? "timeout"})`}`),
      ...(s.agentNotes.length
        ? [``, `### Agent repairs${s.agent === "codex" ? " (Codex)" : ""}`, ...s.agentNotes.map((n) => `- ${n}`)]
        : []),
      ...(s.history && (s.history.found || s.history.board)
        ? [``, `Coordinated through OpenCrawl: ${s.history.found} passage(s) from earlier agent sessions, ${s.history.board} board note(s) from other runs.`]
        : []),
      ``,
      `### Sources`,
      ...s.incidents.flatMap((i) => i.sources.slice(0, 3).map((src) => `- ${i.id}: [${src.title}](${src.url})`)),
      ...s.migrationSources.map((src) => `- Migration notes: [${src.title}](${src.url})`),
      ``,
      `Time from run start to verified fix: ${Math.floor(secs / 60)}m ${secs % 60}s.`,
      ``,
      `_Opened by Firebreak. Review the diff before merging._`,
    ];
    return lines.join("\n");
  }
}

interface WorkspacePackage {
  dir: string;
  name: string;
  scripts: Record<string, string>;
  deps: string[];
  tsconfig: boolean;
}

/** The command that serves a package's web app on PREVIEW_PORT, or null when it isn't a web app Firebreak can serve. */
function webCommand(pkg: WorkspacePackage, manager: string): { command: string; framework: string; score: number } | null {
  const port = String(PREVIEW_PORT);
  if (pkg.deps.includes("expo")) {
    // Native-only Expo apps have nothing to show in a browser.
    if (!pkg.deps.includes("react-native-web")) return null;
    return { command: `npx expo start --web --port ${port}`, framework: "Expo web", score: 1 };
  }
  const run = (name: string) => (manager === "npm" ? `npm run ${name} --` : `${manager} run ${name}`);
  for (const name of ["dev", "start", "preview"]) {
    const script = pkg.scripts[name];
    if (!script || /^\s*(echo|exit)\b/.test(script)) continue;
    if (/\bnext\b/.test(script)) return { command: `${run(name)} -H 0.0.0.0 -p ${port}`, framework: "Next.js", score: 3 };
    const m = /\b(vite|astro|react-router|remix|nuxt|svelte-kit|vinext)\b/.exec(script);
    if (m && !/\bvitest\b/.test(script)) {
      const names: Record<string, string> = { vite: "Vite", astro: "Astro", "react-router": "React Router", remix: "Remix", nuxt: "Nuxt", "svelte-kit": "SvelteKit", vinext: "vinext" };
      return { command: `${run(name)} --host 0.0.0.0 --port ${port}`, framework: names[m[1]!]!, score: 3 };
    }
    if (/\bng serve\b/.test(script)) return { command: `${run(name)} --host 0.0.0.0 --port ${port}`, framework: "Angular", score: 3 };
    if (/react-scripts start/.test(script)) return { command: manager === "npm" ? `npm run ${name}` : `${manager} run ${name}`, framework: "Create React App", score: 2 };
    if (/\bwrangler\b/.test(script)) return { command: `${run(name)} --ip 0.0.0.0 --port ${port}`, framework: "Wrangler", score: 2 };
  }
  return null;
}

/** Single-quotes a string for the shell. */
function shq(x: string): string {
  return `'${x.replace(/'/g, `'\\''`)}'`;
}
