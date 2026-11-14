import { DurableObject } from "cloudflare:workers";
import type { FixPlan, Incident, RunAttempt, RunEvent, RunEventInput, RunResult, RunStatus, RunStep, Source } from "@shared/types";
import { now, type AppEnv } from "../env";
import { chat, parseJsonReply } from "../integrations/clonvo";
import { Sandbox } from "../integrations/daytona";
import { openPullRequest } from "../integrations/github";
import { search } from "../integrations/you";
import { parseLockfile } from "../lockfiles";
import { parseDocument } from "yaml";
import { isAffected } from "../versions";
import { APPLY_EDITS, PATCH_PACKAGE_JSON } from "./scripts";

const SESSION = "firebreak";
const MAX_REPAIRS = 3;
const INSTALL_TIMEOUT = 600;
const TEST_TIMEOUT = 600;

type Phase = "sandbox" | "clone" | "patch" | "install" | "verify" | "test" | "repair" | "ready" | "done";

export interface StartRun {
  runId: string;
  fullName: string;
  defaultBranch: string;
  incident: Pick<Incident, "id" | "kind" | "title" | "package" | "affected" | "sources" | "severity">;
  plan: FixPlan;
}

interface State extends StartRun {
  phase: Phase;
  status: RunStatus;
  step: RunStep;
  startedAt: number;
  sandboxId?: string;
  /** Home directory of the sandbox user; the repo is cloned to <home>/repo. */
  home?: string;
  yarnBerry?: boolean;
  testCommand: string | null;
  attempts: RunAttempt[];
  lastFailure?: string;
  repairs: number;
  lockfileClean: boolean | null;
  diff: string;
  changedFiles: string[];
  agentNotes: string[];
  migrationSources: Source[];
  error?: string;
  prUrl?: string;
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
    if (!this.st) this.st = (await this.ctx.storage.get<State>("state")) ?? null;
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
      testCommand: s.testCommand,
      durationMs: Date.now() - s.startedAt,
      error: s.error,
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
    const finished = status === "passed" || status === "failed" || status === "pr_opened";
    await this.env.DB.prepare("UPDATE runs SET status = ?, step = ?, result = ?, pr_url = ?, finished_at = COALESCE(finished_at, ?) WHERE id = ?")
      .bind(status, s.step, JSON.stringify(this.result(s)), s.prUrl ?? null, finished ? now() : null, s.runId)
      .run();
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
        testCommand: null,
        attempts: [],
        repairs: 0,
        lockfileClean: null,
        diff: "",
        changedFiles: [],
        agentNotes: [],
        migrationSources: [],
      };
      await this.save();
      this.emit({ type: "step", step: "plan", label: STEP_LABELS.plan });
      const p = start.plan;
      this.info(`${p.strategy === "pin-back" ? "Pin back" : p.strategy === "override" ? "Override" : "Upgrade"} ${p.package} ${p.from} → ${p.to} in ${p.lockfile} (${p.manager}).`);
      this.info(p.reason);
      await this.ctx.storage.setAlarm(Date.now());
      return Response.json({ ok: true });
    }
    if (req.method === "POST" && url.pathname.endsWith("/pr")) {
      try {
        return Response.json({ url: await this.openPr() });
      } catch (e) {
        return Response.json({ error: (e as Error).message }, { status: 500 });
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
    if (s.phase === "done" || s.phase === "ready") return;
    try {
      const next = await this.runPhase(s);
      s.phase = next;
      await this.save();
      if (next !== "done" && next !== "ready") await this.ctx.storage.setAlarm(Date.now());
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

  private dirPath(s: State, file = "") {
    return this.repoPath(s, [s.plan.dir, file].filter(Boolean).join("/"));
  }

  private async runPhase(s: State): Promise<Phase> {
    const p = s.plan;
    switch (s.phase) {
      case "sandbox": {
        await this.step("sandbox");
        const sb = await Sandbox.create(this.env, { run: s.runId });
        s.sandboxId = sb.id;
        await this.save();
        this.info(`Sandbox ${sb.id} created. No secrets are passed in.`);
        await sb.waitStarted();
        s.home = (await sb.exec("echo $HOME")).output.trim() || "/home/daytona";
        await this.save();
        await sb.createSession(SESSION);
        await this.run(
          sb,
          `export CI=true COREPACK_ENABLE_DOWNLOAD_PROMPT=0 PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH"; node -v && npm -v && git --version`,
          60,
          "node -v && npm -v && git --version",
        );
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
        if (p.manager === "yarn") s.yarnBerry = (await sb.exec(`grep -q __metadata ${this.repoPath(s, p.lockfile)}`)).exitCode === 0;
        return "patch";
      }

      case "patch": {
        await this.step("patch");
        const sb = await this.sandbox(s);
        let pnpmMajor = 0;
        if (p.manager !== "npm") {
          const tool = p.manager === "bun" ? "bun" : p.manager;
          const ensure =
            p.manager === "bun"
              ? `command -v bun || (curl -fsSL https://bun.sh/install | bash) || npm i -g --prefix ~/.local bun`
              : `command -v ${tool} || (mkdir -p ~/.local/bin && corepack enable --install-directory ~/.local/bin) || npm i -g --prefix ~/.local ${tool}`;
          const r = await this.run(sb, `cd ${this.dirPath(s)} && (${ensure}) >/dev/null 2>&1; ${tool} --version`, 180);
          if (r.exitCode !== 0) throw new Error(`Could not set up ${tool} in the sandbox`);
          if (p.manager === "pnpm") pnpmMajor = Number(/(\d+)\.\d+\.\d+\s*$/.exec(r.output.trim())?.[1] ?? 0);
        }
        const exact = s.incident.kind === "malicious" || p.strategy === "pin-back";
        await sb.writeFile("/tmp/fb-patch.cjs", PATCH_PACKAGE_JSON);
        await sb.writeFile(
          "/tmp/fb-patch.json",
          JSON.stringify({ root: this.dirPath(s), name: p.package, to: p.to, manager: p.manager, strategy: p.strategy, exact, pnpmMajor }),
        );
        // Short and output-critical, so it runs through the synchronous exec rather than the streamed session.
        this.emit({ type: "cmd", command: "patch package.json" });
        const r = await sb.exec("node /tmp/fb-patch.cjs /tmp/fb-patch.json", { timeoutSec: 60 });
        this.emit({ type: "exit", command: "patch package.json", exitCode: r.exitCode, ms: 0 });
        if (r.exitCode !== 0) throw new Error(`Could not edit package.json: ${r.output.slice(-500)}`);
        const report = JSON.parse(r.output.trim().split("\n").pop() ?? "{}") as { changed: string[]; catalogs: { file: string; catalog: string }[]; overrideNeeded: boolean };

        // pnpm catalogs and pnpm >= 10 overrides live in pnpm-workspace.yaml.
        if (report.catalogs.length || report.overrideNeeded) {
          const file = this.dirPath(s, "pnpm-workspace.yaml");
          const doc = parseDocument((await sb.readFile(file)) ?? "");
          const spec = exact ? p.to : `^${p.to}`;
          for (const c of new Set(report.catalogs.map((x) => x.catalog))) {
            const key = c === "default" && doc.hasIn(["catalog", p.package]) ? ["catalog", p.package] : ["catalogs", c, p.package];
            doc.setIn(key, spec);
            report.changed.push(`pnpm-workspace.yaml ${key.join(".")} = ${spec}`);
          }
          if (report.overrideNeeded) {
            doc.setIn(["overrides", p.package], p.to);
            report.changed.push(`pnpm-workspace.yaml overrides.${p.package} = ${p.to}`);
          }
          await sb.writeFile(file, doc.toString());
        }
        if (!report.changed.length) throw new Error(`Nothing in the repo declares ${p.package} in a form Firebreak can edit`);
        this.info(report.changed.join("\n"));
        return "install";
      }

      case "install": {
        await this.step("install");
        const sb = await this.sandbox(s);
        const cmd =
          p.manager === "npm"
            ? "npm install --ignore-scripts --no-audit --no-fund"
            : p.manager === "pnpm"
              ? "pnpm install --ignore-scripts --no-frozen-lockfile"
              : p.manager === "yarn"
                ? s.yarnBerry
                  ? "YARN_ENABLE_IMMUTABLE_INSTALLS=false yarn install --mode=skip-build"
                  : "yarn install --ignore-scripts --non-interactive --no-frozen-lockfile"
                : "bun install --ignore-scripts";
        let r = await this.run(sb, `cd ${this.dirPath(s)} && ${cmd}`, INSTALL_TIMEOUT);
        if (r.exitCode !== 0 && p.manager === "npm" && /ERESOLVE|peer dep/i.test(r.output)) {
          this.info("Peer dependency conflict; retrying with --legacy-peer-deps.");
          r = await this.run(sb, `cd ${this.dirPath(s)} && ${cmd} --legacy-peer-deps`, INSTALL_TIMEOUT);
        }
        if (r.exitCode !== 0) throw new Error(`Install failed (exit ${r.exitCode ?? "timeout"})`);
        return "verify";
      }

      case "verify": {
        await this.step("verify");
        const sb = await this.sandbox(s);
        const [lock, pkg] = await Promise.all([
          sb.readFile(this.repoPath(s, p.lockfile)),
          sb.readFile(this.dirPath(s, "package.json")),
        ]);
        if (lock === null) throw new Error(`Lockfile ${p.lockfile} missing after install`);
        const deps = parseLockfile(p.manager, p.lockfile, lock, pkg).filter((d) => d.name === p.package);
        const bad = deps.filter((d) => isAffected(d.version, s.incident.affected));
        this.info(`${p.package} in lockfile: ${deps.map((d) => d.version).join(", ") || "not present"}`);
        s.lockfileClean = bad.length === 0;
        if (!s.lockfileClean) {
          // Never run project code next to a known-bad version.
          throw new Error(`Lockfile still resolves an affected version (${bad.map((d) => d.version).join(", ")}). Stopping before any tests run.`);
        }
        this.info("Lockfile is clean: no affected versions remain.");
        return "test";
      }

      case "test": {
        await this.step("test");
        const sb = await this.sandbox(s);
        if (!s.testCommand) s.testCommand = await this.pickTestCommand(sb, s);
        const r = await this.run(sb, `cd ${this.dirPath(s)} && ${s.testCommand}`, TEST_TIMEOUT);
        const passed = r.exitCode === 0;
        s.attempts.push({
          n: s.attempts.length + 1,
          passed,
          command: s.testCommand,
          exitCode: r.exitCode,
          summary: passed ? "All checks passed" : r.output.trim().split("\n").slice(-6).join("\n").slice(0, 800),
        });
        if (passed) return this.finishReady(sb, s);
        s.lastFailure = r.output.slice(-8000);
        // An out-of-memory kill says nothing about the code; don't spend a repair round on it.
        if (/^Killed$|exit code 137|JavaScript heap out of memory/m.test(r.output.slice(-4000)))
          throw new Error("Checks were killed for running out of memory in the sandbox. Use a larger DAYTONA_SNAPSHOT. No PR will be offered.");
        if (s.repairs >= MAX_REPAIRS) throw new Error(`Checks still failing after ${MAX_REPAIRS} repair attempts. No PR will be offered.`);
        if (!this.env.CLONVO_API_KEY) throw new Error("Checks failed and CLONVO_API_KEY is not set, so the agent can't attempt a repair.");
        return "repair";
      }

      case "repair": {
        await this.step("repair");
        const sb = await this.sandbox(s);
        s.repairs++;
        await this.repair(sb, s);
        return "test";
      }

      default:
        return "done";
    }
  }

  private async pickTestCommand(sb: Sandbox, s: State): Promise<string> {
    const p = s.plan;
    const raw = await sb.readFile(this.dirPath(s, "package.json"));
    const scripts = (raw ? (JSON.parse(raw) as { scripts?: Record<string, string> }).scripts : undefined) ?? {};
    const runner = p.manager === "npm" ? "npm run" : `${p.manager} run`;
    const parts: string[] = [];
    for (const name of ["typecheck", "type-check"]) if (scripts[name]) { parts.push(`${runner} ${name}`); break; }
    if (scripts.test && !/no test specified/.test(scripts.test)) parts.push(p.manager === "npm" ? "npm test" : `${p.manager} run test`);
    else if (scripts.build) parts.push(`${runner} build`);
    if (parts.length) {
      this.info(`Checks: ${parts.join(" && ")}`);
      return parts.join(" && ");
    }
    this.info("No test, typecheck or build script found; confirming the installed version only.");
    return `node -p "require('./node_modules/${p.package}/package.json').version"`;
  }

  private async repair(sb: Sandbox, s: State): Promise<void> {
    const p = s.plan;
    const pkgRe = p.package.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
    const grep = await sb.exec(
      `cd ${this.repoPath(s)} && grep -rlE "(from ['\\"]${pkgRe}(/[^'\\"]*)?['\\"]|require\\(['\\"]${pkgRe})" --include=*.ts --include=*.tsx --include=*.js --include=*.jsx --include=*.mjs --include=*.cjs --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=.git . | head -8`,
    );
    const fromError = [...new Set([...(s.lastFailure ?? "").matchAll(/((?:\.\/)?(?:[\w.-]+\/)*[\w.-]+\.(?:tsx?|jsx?|mjs|cjs))[:(]\d+/g)].map((m) => m[1]!.replace(/^\.\//, "")))]
      .filter((f) => !f.includes("node_modules"))
      .slice(0, 6);
    const files = [...new Set([...grep.output.split("\n").map((f) => f.trim().replace(/^\.\//, "")).filter(Boolean), ...fromError.map((f) => (p.dir && !f.startsWith(p.dir) ? `${p.dir}/${f}` : f))])].slice(0, 10);
    const contents: string[] = [];
    for (const f of files) {
      const text = await sb.readFile(this.repoPath(s, f));
      if (text !== null) contents.push(`--- ${f}\n${text.slice(0, 15_000)}`);
    }
    this.emit({ type: "agent", text: `Reading ${contents.length} file${contents.length === 1 ? "" : "s"} that use ${p.package} or appear in the failure.` });

    let notes = "";
    if (this.env.YOU_API_KEY) {
      try {
        const results = await search(this.env, `${p.package} ${p.to} migration guide breaking changes upgrade from ${p.from}`, { count: 5, highlights: true });
        notes = results
          .map((r) => `Source: ${r.url}\n${(r.highlights.length ? r.highlights : r.snippets).slice(0, 4).join("\n")}`)
          .join("\n\n")
          .slice(0, 10_000);
        for (const r of results.slice(0, 3)) if (!s.migrationSources.some((m) => m.url === r.url)) s.migrationSources.push({ kind: "news", title: r.title, url: r.url });
        this.emit({ type: "agent", text: `Pulled migration notes from ${results.length} sources via You.com.` });
      } catch (e) {
        this.info(`Migration search skipped: ${(e as Error).message}`);
      }
    }

    const reply = await chat(
      this.env,
      this.env.FIX_MODEL,
      [
        {
          role: "system",
          content:
            "You repair a JavaScript/TypeScript codebase after a dependency version change. Make the smallest source edits that make the failing checks pass. Never edit lockfiles, package.json, node_modules, or tests' expectations to hide failures. Each edit's `find` must be copied exactly from the file and match once. Reply with JSON only.",
        },
        {
          role: "user",
          content: `Dependency change: ${p.package} ${p.from} → ${p.to} (${p.manager}).\nCommand: ${s.testCommand}\n\nFailure output (tail):\n${s.lastFailure}\n\nMigration notes:\n${notes || "(none)"}\n\nFiles (paths relative to the repo root):\n${contents.join("\n\n") || "(none found)"}\n\nReply as {"explanation":"one or two sentences","edits":[{"path":"src/file.ts","find":"exact old text","replace":"new text"}]}. Use an empty edits list if the failure is unrelated to the upgrade.`,
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
    await sb.writeFile("/tmp/fb-edits.json", JSON.stringify({ root: this.repoPath(s), edits }));
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

  private async finishReady(sb: Sandbox, s: State): Promise<Phase> {
    const status = await sb.exec(`cd ${this.repoPath(s)} && git status --porcelain`);
    s.changedFiles = status.output
      .split("\n")
      .map((l) => l.slice(3).trim())
      .filter((f) => f && !f.includes("node_modules"));
    const diff = await sb.exec(`cd ${this.repoPath(s)} && git diff --stat && echo && git diff -- . ':(exclude)*lock*' ':(exclude)*.lockb'`);
    s.diff = diff.output.slice(0, 30_000);
    // Keep the verified files here so the sandbox can go now; the PR doesn't depend on it staying alive.
    for (const path of s.changedFiles) {
      if (path.endsWith(".lockb")) continue;
      const content = await sb.readFile(this.repoPath(s, path));
      if (content !== null) this.storeFile(path, content);
    }
    await this.save();
    await this.setStatus("passed", "ready");
    await sb.delete().catch(() => undefined);
    s.sandboxId = undefined;
    await this.save();
    this.info("Fix verified and the sandbox deleted. Review the receipt, then open the PR when you're ready.");
    return "ready";
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
    const p = s.plan;
    const verb = p.strategy === "pin-back" ? "pin" : p.strategy === "override" ? "override" : "upgrade";
    const url = await openPullRequest(this.env, {
      fullName: s.fullName,
      base: s.defaultBranch,
      branch: `firebreak/${p.package.replace(/[@/]/g, "-").replace(/^-/, "")}-${p.to}-${s.runId.slice(0, 6)}`,
      title: `fix(deps): ${verb} ${p.package} ${p.from} → ${p.to} (${s.incident.id})`,
      message: `fix(deps): ${verb} ${p.package} ${p.from} → ${p.to}\n\n${s.incident.id}: ${s.incident.title}`,
      body: this.receipt(s),
      files,
    });
    s.prUrl = url;
    await this.save();
    this.emit({ type: "agent", text: `Pull request opened: ${url}` });
    await this.setStatus("pr_opened", "ready");
    if (s.sandboxId) {
      const sb = await Sandbox.attach(this.env, s.sandboxId).catch(() => null);
      await sb?.delete().catch(() => undefined);
      s.sandboxId = undefined;
      await this.save();
    }
    return url;
  }

  private receipt(s: State): string {
    const p = s.plan;
    const mins = Math.round((Date.now() - s.startedAt) / 1000);
    const lines = [
      `## Firebreak hotfix receipt`,
      ``,
      `**Incident:** ${s.incident.id} · ${s.incident.title}${s.incident.severity ? ` · ${s.incident.severity}` : ""}`,
      `**Change:** \`${p.package}\` ${p.from} → **${p.to}** (${p.strategy}, ${p.manager}, \`${p.lockfile}\`)`,
      `**Why this version:** ${p.reason}`,
      ``,
      `### Verified in an isolated Daytona sandbox`,
      `- Installed with lifecycle scripts disabled`,
      `- Lockfile clean: ${s.lockfileClean ? "yes, no affected versions of " + p.package + " remain" : "not verified"}`,
      `- Checks: \`${s.testCommand ?? "none"}\``,
      ...s.attempts.map((a) => `  - Attempt ${a.n}: ${a.passed ? "✅ passed" : `❌ failed (exit ${a.exitCode ?? "timeout"})`}`),
      ...(s.agentNotes.length ? [``, `### Agent repairs`, ...s.agentNotes.map((n) => `- ${n}`)] : []),
      ``,
      `### Sources`,
      ...s.incident.sources.slice(0, 6).map((src) => `- [${src.title}](${src.url})`),
      ...s.migrationSources.map((src) => `- Migration notes: [${src.title}](${src.url})`),
      ``,
      `Time from run start to verified fix: ${Math.floor(mins / 60)}m ${mins % 60}s.`,
      ``,
      `_Opened by Firebreak. Review the diff before merging._`,
    ];
    return lines.join("\n");
  }
}
