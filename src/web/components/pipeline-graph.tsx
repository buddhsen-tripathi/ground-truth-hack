import { motion } from "motion/react";
import { useEffect, useState } from "react";
import type { Run, RunEvent, RunStep } from "@shared/types";
import { cn } from "@/lib/utils";

/* Live graph of a fix run: the main pipeline left to right, with the agent repair loop hanging off Checks. */

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
const H = 206;
const Y = 64;
const R = 13;
const X0 = 60;
const DX = (W - 2 * X0) / (MAIN.length - 1);
const xOf = (i: number) => X0 + i * DX;
const TEST_X = xOf(MAIN.findIndex((m) => m.step === "test"));
const REPAIR = { x: TEST_X, y: 154 };

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

function Edge({ d, state, label, lx, ly, anchor }: { d: string; state: "done" | "flow" | "pending"; label?: string; lx?: number; ly?: number; anchor?: "start" | "end" }) {
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
      {label ? (
        <text x={lx} y={ly} textAnchor={anchor} className="fill-muted-foreground text-[11px]">
          {label}
        </text>
      ) : null}
    </g>
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
  const attempts = run.result?.attempts.length ?? events.filter((e) => e.type === "step" && e.step === "test").length;
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

  return (
    <div className="no-scrollbar overflow-x-auto" role="img" aria-label={`Fix pipeline, currently at ${run.step}, status ${run.status}`}>
      <svg viewBox={`0 0 ${W} ${H}`} className="block h-auto w-full min-w-[720px]">
        {MAIN.slice(0, -1).map((_, i) => {
          const next = mainState(i + 1);
          const state = next === "done" || next === "failed" ? "done" : next === "active" ? "flow" : "pending";
          return <Edge key={i} d={`M${xOf(i) + R + 5} ${Y} L${xOf(i + 1) - R - 5} ${Y}`} state={state} />;
        })}
        {/* Repair loop: Checks → agent repair → Checks */}
        <Edge
          d={`M${TEST_X - 9} ${Y + R - 2} C ${TEST_X - 46} ${Y + 40}, ${REPAIR.x - 46} ${REPAIR.y - 30}, ${REPAIR.x - 9} ${REPAIR.y - R + 2}`}
          state={repairState === "active" ? "flow" : repairState === "done" || repairState === "failed" ? "done" : "pending"}
          label="checks fail"
          lx={TEST_X - 42}
          ly={(Y + REPAIR.y) / 2 + 4}
          anchor="end"
        />
        <Edge
          d={`M${REPAIR.x + 9} ${REPAIR.y - R + 2} C ${REPAIR.x + 46} ${REPAIR.y - 30}, ${TEST_X + 46} ${Y + 40}, ${TEST_X + 9} ${Y + R - 2}`}
          state={repairState === "done" ? "done" : "pending"}
          label="re-run"
          lx={TEST_X + 42}
          ly={(Y + REPAIR.y) / 2 + 4}
          anchor="start"
        />
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
        <Node x={REPAIR.x} y={REPAIR.y} state={repairState} label="Agent repair" sub={repairState === "idle" ? "only if checks fail" : sub("repair", repairState)} count={repairs} />
      </svg>
    </div>
  );
}
