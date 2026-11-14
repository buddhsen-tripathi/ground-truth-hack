import { motion } from "motion/react";
import { useEffect, useState } from "react";
import { planPackages, type Run, type RunEvent, type RunStep } from "@shared/types";
import { checkLogos, frameworkLogo, Logo, LOGO_NAMES, managerLogo, type LogoId } from "@/components/logos";
import { cn } from "@/lib/utils";

/* Live graph of a fix run: the main pipeline left to right, the agent repair loop hanging off Checks, and under each
   step the tools it used and what it found. */

const MAIN: { step: RunStep; label: string }[] = [
  { step: "plan", label: "Plan" },
  { step: "sandbox", label: "Sandbox" },
  { step: "clone", label: "Clone" },
  { step: "patch", label: "Patch" },
  { step: "install", label: "Install" },
  { step: "verify", label: "Verify lockfile" },
  { step: "test", label: "Checks" },
  { step: "ready", label: "Ready" },
];

type NodeState = "done" | "active" | "failed" | "pending" | "idle";

const W = 960;
const H = 252;
const Y = 64;
const R = 13;
const X0 = 60;
const DX = (W - 2 * X0) / (MAIN.length - 1);
const xOf = (i: number) => X0 + i * DX;
const TEST_X = xOf(MAIN.findIndex((m) => m.step === "test"));
const REPAIR = { x: TEST_X, y: 162 };
/** Step details sit in a column under each node (except Checks, which has the repair loop under it). */
const DETAIL_Y = Y + R + 12;
const DETAIL_W = DX - 10;

function fmt(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

/** Time spent in each step, from the step events (Checks can run several times, so durations add up). */
function stepDurations(events: RunEvent[], end: number) {
  const steps = events.filter((e): e is Extract<RunEvent, { type: "step" }> => e.type === "step");
  const out = new Map<RunStep, number>();
  steps.forEach((e, i) => {
    const until = steps[i + 1]?.t ?? end;
    out.set(e.step, (out.get(e.step) ?? 0) + Math.max(0, until - e.t));
  });
  return out;
}

/** Events grouped by the step they happened in. */
function eventsByStep(events: RunEvent[]) {
  const out = new Map<RunStep, RunEvent[]>();
  let step: RunStep = "plan";
  for (const e of events) {
    if (e.type === "step") step = e.step;
    out.set(step, [...(out.get(step) ?? []), e]);
  }
  return out;
}

interface Detail {
  logos: LogoId[];
  lines: string[];
}

const plural = (n: number, word: string, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;

/** What each step used and found, from the run and its events. Steps that haven't started have only their tools. */
function stepDetails(run: Run, events: RunEvent[]): Partial<Record<RunStep, Detail>> {
  const by = eventsByStep(events);
  const logs = (step: RunStep) => (by.get(step) ?? []).filter((e): e is Extract<RunEvent, { type: "log" }> => e.type === "log");
  const tools = (step: RunStep, prefix: string) => (by.get(step) ?? []).filter((e): e is Extract<RunEvent, { type: "tool" }> => e.type === "tool" && e.tool.startsWith(prefix));
  const exits = (step: RunStep) => (by.get(step) ?? []).filter((e): e is Extract<RunEvent, { type: "exit" }> => e.type === "exit");
  const plan = run.plan;
  const packages = planPackages(plan);
  const managers = [...new Set(plan?.targets.map((t) => t.manager) ?? [])];
  const mLogos = managers.map(managerLogo);
  const expo = plan?.targets.find((t) => t.expoSdk);
  const result = run.result;

  const board = tools("plan", "opencrawl.");
  const boardNotes = result?.history?.board ?? 0;
  const sandboxLog = logs("sandbox").map((l) => l.text).join("\n");
  const sandboxId = /Sandbox (\S+) created/.exec(sandboxLog)?.[1];
  const node = /^v(\d+\.\d+)\.\d+$/m.exec(sandboxLog)?.[1];
  const python = /Python (\d+\.\d+)/.exec(sandboxLog)?.[1];
  const commit = /^([0-9a-f]{7,12}) (.+)$/m.exec(logs("clone").map((l) => l.text).join("\n"));
  const installMs = exits("install").reduce((a, e) => a + e.ms, 0);
  const preview = result?.preview;
  const fw = frameworkLogo(preview?.framework);

  return {
    plan: {
      logos: ["osv", ...(board.length || boardNotes ? (["opencrawl"] as LogoId[]) : [])],
      lines: [
        plural(packages.length, "package"),
        plural(run.incidentIds.length, "advisory", "advisories"),
        ...(board.length ? [boardNotes ? `${plural(boardNotes, "board note")} read` : "board checked"] : []),
        ...(expo ? [`Expo SDK ${expo.expoSdk}`] : []),
      ],
    },
    sandbox: {
      logos: ["daytona"],
      lines: [sandboxId ? sandboxId.slice(0, 8) : "isolated", node ? `node ${node}` : "", python ? `python ${python}` : "", "no secrets in"].filter(Boolean).slice(0, 3),
    },
    clone: {
      logos: ["github"],
      lines: commit ? [commit[1]!.slice(0, 7), commit[2]!.slice(0, 22)] : ["default branch"],
    },
    patch: {
      logos: mLogos,
      lines: [plural(packages.length, "bump"), plural(plan?.targets.length ?? 0, "lockfile")],
    },
    install: {
      logos: mLogos,
      lines: [installMs ? fmt(installMs) : "", managers.some((m) => m !== "uv" && m !== "pip") ? "scripts off" : "resolve first"].filter(Boolean),
    },
    verify: {
      logos: ["osv"],
      lines:
        result?.lockfileClean === true ? ["no affected", "versions left"] : result?.lockfileClean === false ? ["affected version", "still resolves"] : ["every advisory", "re-checked"],
    },
    ready: {
      logos: ["github", ...(fw ? [fw] : [])],
      lines: [
        run.status === "pr_opened" ? "PR opened" : run.status === "passed" ? "PR ready" : "PR on approval",
        ...(preview?.state === "live" ? [`${preview.framework ?? "app"} preview live`] : preview?.framework ? [`${preview.framework} preview`] : []),
      ],
    },
  };
}

function Node({ x, y, state, label, sub, count, emphasis }: { x: number; y: number; state: NodeState; label: string; sub?: string; count?: number; emphasis?: boolean }) {
  const stroke =
    state === "done" ? "var(--primary)" : state === "active" ? "var(--info)" : state === "failed" ? "var(--destructive)" : "var(--border)";
  const fill = state === "done" ? "var(--primary)" : state === "failed" ? "var(--destructive)" : "var(--card)";
  return (
    <g>
      {state === "active" ? (
        <motion.circle
          cx={x}
          cy={y}
          r={R}
          fill="none"
          stroke="var(--info)"
          strokeWidth={2}
          initial={{ r: R, opacity: 0.6 }}
          animate={{ r: R + 11, opacity: 0 }}
          transition={{ duration: 1.4, repeat: Infinity, ease: "easeOut" }}
        />
      ) : null}
      {emphasis && state === "done" ? <circle cx={x} cy={y} r={R + 6} fill="var(--primary)" opacity={0.15} /> : null}
      <circle cx={x} cy={y} r={R} fill={fill} stroke={stroke} strokeWidth={state === "pending" || state === "idle" ? 1.5 : 2} strokeDasharray={state === "idle" ? "3 3" : undefined} />
      {state === "done" ? <path d={`M${x - 5} ${y} l3.5 3.5 l6.5 -7`} stroke="var(--primary-foreground)" strokeWidth={2.2} fill="none" strokeLinecap="round" strokeLinejoin="round" /> : null}
      {state === "failed" ? <path d={`M${x - 4} ${y - 4} l8 8 M${x + 4} ${y - 4} l-8 8`} stroke="var(--destructive-foreground)" strokeWidth={2.2} strokeLinecap="round" /> : null}
      {state === "active" ? <circle cx={x} cy={y} r={4.5} fill="var(--info)" /> : null}
      {count && count > 1 ? (
        <g>
          <circle cx={x + R} cy={y - R} r={8} fill="var(--foreground)" />
          <text x={x + R} y={y - R + 3.5} textAnchor="middle" className="fill-background font-mono text-[10px] font-semibold">
            {count}
          </text>
        </g>
      ) : null}
      <text
        x={x}
        y={y === Y ? y - R - 22 : y + R + 18}
        textAnchor="middle"
        className={cn("text-[13px] font-medium", state === "pending" || state === "idle" ? "fill-muted-foreground" : state === "failed" ? "fill-destructive" : "fill-foreground")}
      >
        {label}
      </text>
      {sub ? (
        <text x={x} y={y === Y ? y - R - 8 : y + R + 32} textAnchor="middle" className="fill-muted-foreground font-mono text-[11px]">
          {sub}
        </text>
      ) : null}
    </g>
  );
}

function Edge({ d, state }: { d: string; state: "done" | "flow" | "pending" }) {
  return (
    <g>
      <path d={d} fill="none" stroke="var(--border)" strokeWidth={2} strokeLinecap="round" />
      {state !== "pending" ? (
        <motion.path
          d={d}
          fill="none"
          stroke={state === "flow" ? "var(--info)" : "var(--primary)"}
          strokeWidth={2}
          strokeLinecap="round"
          className={state === "flow" ? "edge-flow" : undefined}
          initial={{ pathLength: 0 }}
          animate={{ pathLength: 1 }}
          transition={{ duration: 0.5, ease: "easeOut" }}
        />
      ) : null}
    </g>
  );
}

/** Logos plus a few short facts, laid out as HTML inside the SVG so it scales with the graph. */
function Details({ x, y, width, detail, dim }: { x: number; y: number; width: number; detail: Detail; dim: boolean }) {
  return (
    <foreignObject x={x - width / 2} y={y} width={width} height={H - y}>
      <div className={cn("flex flex-col items-center gap-1.5 text-center transition-opacity", dim && "opacity-45")}>
        <div className="flex items-center justify-center gap-1">
          {detail.logos.map((id) => (
            <span key={id} title={LOGO_NAMES[id]} className="grid size-[22px] place-items-center rounded-md border border-border bg-background text-foreground">
              <Logo id={id} size={13} />
            </span>
          ))}
        </div>
        <div className="w-full min-w-0 px-1 font-mono text-[10.5px] leading-[1.45] text-muted-foreground">
          {detail.lines.map((l, i) => (
            <div key={i} className={cn("truncate", i === 0 && "text-foreground/80")}>
              {l}
            </div>
          ))}
        </div>
      </div>
    </foreignObject>
  );
}

export function PipelineGraph({ run, events }: { run: Run; events: RunEvent[] }) {
  const live = run.status === "running" || run.status === "queued";
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [live]);

  const verified = run.status === "passed" || run.status === "pr_opened";
  const lastT = events.length ? events[events.length - 1]!.t : now;
  const durations = stepDurations(events, live ? now : lastT);
  const seen = new Set<RunStep>(events.filter((e) => e.type === "step").map((e) => (e as { step: RunStep }).step));
  seen.add(run.step);
  const repairs = events.filter((e) => e.type === "step" && e.step === "repair").length;
  // A repo run checks each lockfile's project once, so only repairs make Checks run again.
  const attempts = repairs + 1;
  const current = run.step === "repair" ? MAIN.findIndex((m) => m.step === "test") : MAIN.findIndex((m) => m.step === run.step);

  const mainState = (i: number): NodeState => {
    if (verified) return "done";
    if (i < current) return "done";
    if (i === current && run.step !== "repair") return run.status === "failed" ? "failed" : "active";
    if (i === current) return "done"; // Checks while the agent repairs
    return "pending";
  };
  const repairState: NodeState =
    run.step === "repair" ? (run.status === "failed" ? "failed" : "active") : seen.has("repair") ? "done" : "idle";

  const sub = (step: RunStep, state: NodeState) => {
    const ms = durations.get(step);
    if (state === "active") return ms !== undefined ? fmt(ms) : "starting";
    if ((state === "done" || state === "failed") && ms !== undefined && step !== "ready") return fmt(ms);
    return undefined;
  };

  const details = stepDetails(run, events);
  const toolEvents = events.filter((e): e is Extract<RunEvent, { type: "tool" }> => e.type === "tool");
  const checkTools = checkLogos([...new Set((run.result?.attempts ?? []).map((a) => a.command)), ...events.filter((e): e is Extract<RunEvent, { type: "cmd" }> => e.type === "cmd").map((e) => e.command)]);
  const agent: LogoId | null =
    run.result?.agent === "codex" || toolEvents.some((e) => e.tool.startsWith("codex.")) ? "codex" : run.result?.agent === "clonvo" || seen.has("repair") ? "clonvo" : null;
  const repairLogos: LogoId[] = [
    ...(agent ? [agent] : (["codex"] as LogoId[])),
    ...(toolEvents.some((e) => e.tool.startsWith("opencrawl.search") || e.tool === "opencrawl.board") ? (["opencrawl"] as LogoId[]) : []),
    ...(toolEvents.some((e) => e.tool.startsWith("you.")) ? (["you"] as LogoId[]) : []),
  ];
  const agentCalls = toolEvents.filter((e) => e.tool.startsWith("codex.") && !/^codex\.(init|start|result)$/.test(e.tool)).length;

  return (
    <div className="no-scrollbar overflow-x-auto" role="img" aria-label={`Fix pipeline, currently at ${run.step}, status ${run.status}`}>
      <svg viewBox={`0 0 ${W} ${H}`} className="block h-auto w-full min-w-[720px]">
        {MAIN.slice(0, -1).map((_, i) => {
          const next = mainState(i + 1);
          const state = next === "done" || next === "failed" ? "done" : next === "active" ? "flow" : "pending";
          return <Edge key={i} d={`M${xOf(i) + R + 5} ${Y} L${xOf(i + 1) - R - 5} ${Y}`} state={state} />;
        })}
        {/* Repair loop: Checks → agent repair → Checks, with the check tools inside it */}
        <Edge
          d={`M${TEST_X - 9} ${Y + R - 2} C ${TEST_X - 50} ${Y + 44}, ${REPAIR.x - 50} ${REPAIR.y - 34}, ${REPAIR.x - 9} ${REPAIR.y - R + 2}`}
          state={repairState === "active" ? "flow" : repairState === "done" || repairState === "failed" ? "done" : "pending"}
        />
        <Edge
          d={`M${REPAIR.x + 9} ${REPAIR.y - R + 2} C ${REPAIR.x + 50} ${REPAIR.y - 34}, ${TEST_X + 50} ${Y + 44}, ${TEST_X + 9} ${Y + R - 2}`}
          state={repairState === "done" ? "done" : "pending"}
        />
        {checkTools.length ? (
          <foreignObject x={TEST_X - 30} y={(Y + REPAIR.y) / 2 - 12} width={60} height={24}>
            <div className="flex h-full items-center justify-center gap-0.5">
              {checkTools.slice(0, 3).map((id) => (
                <span key={id} title={LOGO_NAMES[id]} className="grid size-[18px] place-items-center rounded-[5px] border border-border bg-background text-foreground">
                  <Logo id={id} size={11} />
                </span>
              ))}
            </div>
          </foreignObject>
        ) : null}
        {MAIN.map((m, i) => {
          const state = mainState(i);
          return (
            <Node
              key={m.step}
              x={xOf(i)}
              y={Y}
              state={state}
              label={m.label}
              sub={m.step === "ready" && verified ? "verified" : sub(m.step, state)}
              count={m.step === "test" ? attempts : undefined}
              emphasis={m.step === "ready"}
            />
          );
        })}
        {MAIN.map((m, i) => {
          const d = details[m.step];
          if (!d || m.step === "test") return null;
          return <Details key={`d-${m.step}`} x={xOf(i)} y={DETAIL_Y} width={DETAIL_W} detail={d} dim={mainState(i) === "pending"} />;
        })}
        <Node
          x={REPAIR.x}
          y={REPAIR.y}
          state={repairState}
          label="Agent repair"
          sub={repairState === "idle" ? "only if checks fail" : [sub("repair", repairState), agentCalls ? `${agentCalls} tool calls` : ""].filter(Boolean).join(" · ")}
          count={repairs}
        />
        <foreignObject x={REPAIR.x - 60} y={REPAIR.y + R + 40} width={120} height={28}>
          <div className={cn("flex items-center justify-center gap-1", repairState === "idle" && "opacity-45")}>
            {repairLogos.map((id) => (
              <span key={id} title={LOGO_NAMES[id]} className="grid size-[22px] place-items-center rounded-md border border-border bg-background text-foreground">
                <Logo id={id} size={13} />
              </span>
            ))}
          </div>
        </foreignObject>
      </svg>
    </div>
  );
}
