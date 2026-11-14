import { ArrowLeft, ArrowSquareOut, Check, GitPullRequest, Robot, Sparkle, X } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { motion } from "motion/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { planPackages, type Run, type RunEvent, type RunStep } from "@shared/types";
import { AdvisoryChip, ErrorNote, RunStatusBadge } from "@/components/bits";
import { Highlight } from "@/components/highlight";
import { LivePreview } from "@/components/live-preview";
import { PipelineGraph } from "@/components/pipeline-graph";
import { Button, Card, CardHeader, LoadingState, Mono, Spinner, Tag } from "@/components/ui";
import { api } from "@/lib/api";
import { cn, duration } from "@/lib/utils";

export const Route = createFileRoute("/runs/$id")({ component: RunPage });

const STEP_NAMES: Record<RunStep, string> = {
  plan: "Plan",
  sandbox: "Sandbox",
  clone: "Clone",
  patch: "Patch",
  install: "Install",
  verify: "Verify lockfile",
  test: "Checks",
  repair: "Agent repair",
  ready: "Ready",
};

/** Live events over the run's WebSocket (backlog first, then new events). Falls back to polling. */
function useRunEvents(id: string, live: boolean) {
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const qc = useQueryClient();
  useEffect(() => {
    setEvents([]);
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/api/runs/${id}/ws`);
    ws.onopen = () => setConnected(true);
    ws.onclose = () => setConnected(false);
    ws.onmessage = (m) => {
      const ev = JSON.parse(m.data as string) as RunEvent;
      setEvents((prev) => [...prev, ev]);
      if (ev.type === "status" || ev.type === "preview") qc.invalidateQueries({ queryKey: ["run", id] });
    };
    return () => ws.close();
  }, [id, qc]);
  // Polling fallback when the socket isn't available.
  const { data } = useQuery({ queryKey: ["run-events", id], queryFn: () => api.run(id), enabled: !connected, refetchInterval: live ? 2500 : false });
  return connected || !data ? events : data.events;
}

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;

function Terminal({ events, live }: { events: RunEvent[]; live: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  useEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [events]);
  const lines = useMemo(() => {
    const out: { key: string; cls: string; text: string; prefix?: string }[] = [];
    events.forEach((ev, i) => {
      if (ev.type === "step") out.push({ key: `${i}`, cls: "text-term-muted pt-3", text: `── ${ev.label} ──` });
      else if (ev.type === "cmd") out.push({ key: `${i}`, cls: "text-term-accent font-semibold", prefix: "$", text: ev.command });
      else if (ev.type === "exit")
        out.push({ key: `${i}`, cls: ev.exitCode === 0 ? "text-term-success" : "text-term-danger", prefix: ev.exitCode === 0 ? "✓" : "✗", text: `exit ${ev.exitCode ?? "timeout"} · ${(ev.ms / 1000).toFixed(1)}s` });
      else if (ev.type === "agent") out.push({ key: `${i}`, cls: "text-term-warning", prefix: "◆", text: ev.text });
      else if (ev.type === "log") {
        const text = ev.text.replace(ANSI, "").replace(/\r/g, "");
        text.split("\n").forEach((line, j) => {
          if (line || j === 0) out.push({ key: `${i}.${j}`, cls: ev.stream === "err" ? "text-term-danger" : ev.stream === "info" ? "text-term-muted" : "text-term-foreground/85", prefix: ev.stream === "info" ? "›" : undefined, text: line });
        });
      }
    });
    return out.slice(-3000);
  }, [events]);
  return (
    <div className="overflow-hidden rounded-lg border border-term-border bg-term shadow-sm">
      <div className="flex h-10 items-center gap-2 border-b border-term-border px-4">
        <span className="size-2.5 rounded-full bg-term-border" />
        <span className="size-2.5 rounded-full bg-term-border" />
        <span className="size-2.5 rounded-full bg-term-border" />
        <span className="ml-2 font-mono text-xs text-term-muted">daytona sandbox</span>
        {live ? (
          <span className="ml-auto flex items-center gap-1.5 font-mono text-[11px] text-term-success">
            <span className="live-dot size-1.5 rounded-full bg-term-success text-term-success" /> live
          </span>
        ) : (
          <span className="ml-auto font-mono text-[11px] text-term-muted">{lines.length} lines</span>
        )}
      </div>
      <div
        ref={ref}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
        className="h-[460px] overflow-auto px-4 py-3 font-mono text-[12px] leading-[1.65] text-term-foreground"
      >
        {lines.length ? (
          lines.map((l) => (
            <div key={l.key} className={cn("break-words whitespace-pre-wrap", l.cls)}>
              {l.prefix ? <span className="mr-2 select-none opacity-80">{l.prefix}</span> : null}
              {l.text}
            </div>
          ))
        ) : (
          <div className="text-term-muted">{live ? "Waiting for the sandbox…" : "No log recorded for this run."}</div>
        )}
        {live ? <span className="inline-block h-4 w-2 animate-pulse bg-term-foreground/70 align-middle" /> : null}
      </div>
    </div>
  );
}

function Elapsed({ run }: { run: Run }) {
  const [now, setNow] = useState(Date.now());
  const live = run.status === "running" || run.status === "queued";
  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [live]);
  const ms = live ? now - new Date(run.startedAt).getTime() : (run.result?.durationMs ?? (run.finishedAt ? new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime() : 0));
  return (
    <div className="sm:text-right">
      <div className="text-eyebrow text-muted-foreground uppercase">{live ? "Elapsed" : "Start to finish"}</div>
      <div className="mt-1 font-mono text-[1.75rem] leading-none font-semibold tracking-tight tabular-nums">{duration(ms)}</div>
    </div>
  );
}

function Diff({ diff }: { diff: string }) {
  return (
    <pre className="max-h-[480px] overflow-auto py-3 font-mono text-xs leading-[1.6]">
      {diff.split("\n").map((l, i) => (
        <div
          key={i}
          className={cn(
            "px-5",
            l.startsWith("+") && !l.startsWith("+++") && "bg-success-soft text-success",
            l.startsWith("-") && !l.startsWith("---") && "bg-danger-soft text-danger",
            (l.startsWith("@@") || l.startsWith("diff --git")) && "text-info",
          )}
        >
          {l || " "}
        </div>
      ))}
    </pre>
  );
}

function RunPage() {
  const { id } = Route.useParams();
  const qc = useQueryClient();
  const { data, error } = useQuery({
    queryKey: ["run", id],
    queryFn: () => api.run(id),
    refetchInterval: (q) => (q.state.data && ["running", "queued"].includes(q.state.data.run.status) ? 3000 : false),
  });
  const run = data?.run;
  const live = !run || run.status === "running" || run.status === "queued";
  const events = useRunEvents(id, live);
  const pr = useMutation({
    mutationFn: () => api.openPr(id),
    onSuccess: (r) => {
      qc.invalidateQueries();
      toast.success("Pull request opened");
      window.open(r.url, "_blank", "noopener");
    },
    onError: (e) => toast.error((e as Error).message),
  });

  if (error) return <ErrorNote error={error} />;
  if (!run) return <LoadingState label="Loading run…" className="min-h-[60vh]" />;
  const plan = run.plan;
  const packages = planPackages(plan);
  const one = packages.length === 1 ? packages[0]! : null;
  const managers = [...new Set(plan?.targets.map((t) => t.manager) ?? [])];
  const verified = run.status === "passed" || run.status === "pr_opened";
  const npmOnly = !plan?.targets.some((t) => t.ecosystem === "PyPI");
  const result = run.result;
  const agentNotes = events.filter((e) => e.type === "agent") as Extract<RunEvent, { type: "agent" }>[];

  return (
    <div>
      <Link to="/repos/$id" params={{ id: run.repoId }} className="mb-5 inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-3.5" /> {run.repoFullName}
      </Link>
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <RunStatusBadge status={run.status} />
            {one ? <Tag>{one.strategy}</Tag> : null}
            {managers.map((m) => (
              <Tag key={m}>{m}</Tag>
            ))}
            <span className="font-mono text-xs text-muted-foreground">run {run.id}</span>
          </div>
          <h1 className="text-headline break-words text-foreground">
            {one ? (
              <>
                <span className="font-mono text-[0.85em]">{one.package}</span> <span className="text-danger line-through decoration-2 opacity-80">{one.from.join(", ")}</span>{" "}
                <span className="text-muted-foreground">→</span>{" "}
                {verified ? (
                  <Highlight tone="success" serif={false} className="font-mono text-[0.85em]">
                    {one.to}
                  </Highlight>
                ) : (
                  <span className="text-success">{one.to}</span>
                )}
              </>
            ) : (
              <>
                {verified ? "Bumped " : "Bumping "}
                {verified ? <Highlight tone="success">{packages.length} packages</Highlight> : `${packages.length} packages`}
              </>
            )}
          </h1>
          <div className="mt-2 text-sm text-muted-foreground">
            {run.repoFullName} · clears {run.incidentIds.length} advisor{run.incidentIds.length === 1 ? "y" : "ies"}
            {plan && plan.targets.length > 1 ? ` · ${plan.targets.length} lockfiles` : ""}
          </div>
        </div>
        <Elapsed run={run} />
      </div>

      <Card className="mb-6 px-2 py-1 sm:px-4">
        <PipelineGraph run={run} events={events} />
      </Card>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="min-w-0 space-y-6">
          <Terminal events={events} live={live} />
          {result?.preview ? <LivePreview runId={run.id} preview={result.preview} /> : null}
          {result?.diff ? (
            <Card className="overflow-hidden">
              <CardHeader title="Diff" description={`${result.changedFiles.length} file${result.changedFiles.length === 1 ? "" : "s"} changed · lockfile hunks hidden`} />
              <Diff diff={result.diff} />
            </Card>
          ) : null}
        </div>

        <div className="space-y-4">
          <motion.div layout>
            {run.status === "passed" ? (
              <Card className="relative overflow-hidden border-success/30 p-5">
                <div aria-hidden className="pointer-events-none absolute inset-0 bg-[radial-gradient(120%_100%_at_100%_0%,var(--success-soft),transparent_70%)]" />
                <div className="relative flex items-center gap-2 text-base font-semibold text-success">
                  <Check weight="bold" className="size-4" /> Fix verified
                </div>
                <p className="relative mt-1 text-sm leading-6 text-muted-foreground">Nothing has been pushed. Review the receipt and diff, then open the PR.</p>
                <Button size="lg" className="relative mt-4 w-full" onClick={() => pr.mutate()} disabled={pr.isPending}>
                  {pr.isPending ? <Spinner /> : <GitPullRequest weight="bold" />} Open pull request
                </Button>
              </Card>
            ) : run.status === "pr_opened" && run.prUrl ? (
              <Card className="relative overflow-hidden border-success/30 p-5">
                <div aria-hidden className="pointer-events-none absolute inset-0 bg-[radial-gradient(120%_100%_at_100%_0%,var(--success-soft),transparent_70%)]" />
                <div className="relative flex items-center gap-2 text-base font-semibold text-success">
                  <GitPullRequest weight="bold" className="size-4" /> PR opened
                </div>
                <a href={run.prUrl} target="_blank" rel="noreferrer" className="relative mt-2 flex items-center gap-1 font-mono text-xs font-medium break-all text-foreground hover:underline">
                  {run.prUrl.replace("https://github.com/", "")} <ArrowSquareOut className="size-3.5 shrink-0" />
                </a>
              </Card>
            ) : run.status === "failed" ? (
              <Card className="relative overflow-hidden border-danger/30 p-5">
                <div aria-hidden className="pointer-events-none absolute inset-0 bg-[radial-gradient(120%_100%_at_100%_0%,var(--danger-soft),transparent_70%)]" />
                <div className="relative flex items-center gap-2 text-base font-semibold text-danger">
                  <X weight="bold" className="size-4" /> No PR offered
                </div>
                <p className="relative mt-1 text-sm leading-6 break-words text-muted-foreground">{result?.error ?? "The run stopped."}</p>
              </Card>
            ) : (
              <Card className="p-5">
                <div className="flex items-center gap-2 text-base font-semibold text-foreground">
                  <Spinner className="text-info" /> {STEP_NAMES[run.step]}…
                </div>
                <p className="mt-1 text-sm leading-6 text-muted-foreground">You can leave this page; the run continues in its Durable Object.</p>
              </Card>
            )}
          </motion.div>

          {packages.length ? (
            <Card className="overflow-hidden">
              <CardHeader title={one ? "Why this version" : "Changes"} description={one ? undefined : "Each version clears every known advisory for its package"} />
              <ul>
                {packages.map((p) => (
                  <li key={p.key} className="border-b border-border px-5 py-3.5 last:border-b-0">
                    {one ? null : (
                      <div className="flex flex-wrap items-baseline gap-x-1.5 font-mono text-[13px]">
                        <span className="font-medium text-foreground">{p.package}</span>
                        <span className="text-danger line-through opacity-80">{p.from.join(", ")}</span>
                        <span className="text-muted-foreground">→</span>
                        <span className="text-success">{p.to}</span>
                      </div>
                    )}
                    <p className={cn("text-sm leading-6 text-muted-foreground", !one && "mt-1")}>{p.reason}</p>
                    <div className="mt-2 flex flex-wrap items-center gap-1.5">
                      <Mono>{p.lockfile}</Mono>
                      <Tag>{p.direct ? "direct" : "transitive"}</Tag>
                      {p.incidents.map((i) => (
                        <AdvisoryChip key={i.id} incident={i} />
                      ))}
                    </div>
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}

          <Card className="overflow-hidden">
            <CardHeader title="Receipt" description="What was actually checked" />
            <ul className="space-y-3 px-5 py-4 text-sm">
              <ReceiptLine ok={true} label="Ran in an isolated sandbox, no secrets passed in" />
              <ReceiptLine
                ok={run.step !== "plan" && run.step !== "sandbox" && run.step !== "clone" && run.step !== "patch" ? true : null}
                label={npmOnly ? "Installed with lifecycle scripts disabled" : "Resolved and checked before anything was installed"}
              />
              <ReceiptLine ok={result?.lockfileClean ?? null} label={one ? `Lockfile has no affected ${one.package} version` : "Lockfiles have no affected versions of the bumped packages"} />
              {(result?.attempts ?? []).map((a) => (
                <ReceiptLine
                  key={a.n}
                  ok={a.passed}
                  label={`Attempt ${a.n}${a.lockfile && plan && plan.targets.length > 1 ? ` (${a.lockfile})` : ""}: ${a.command}`}
                  detail={a.passed ? undefined : a.summary}
                />
              ))}
              {!result?.attempts.length ? <ReceiptLine ok={null} label="Project checks" /> : null}
            </ul>
          </Card>

          {agentNotes.length ? (
            <Card className="overflow-hidden">
              <CardHeader title={<span className="flex items-center gap-1.5"><Robot weight="bold" className="size-4" /> Agent</span>} description="Repairs proposed through Clonvo" />
              <ul className="space-y-2.5 px-5 py-4 text-sm">
                {agentNotes.map((n, i) => (
                  <li key={i} className="flex gap-2">
                    <Sparkle weight="fill" className="mt-0.5 size-3.5 shrink-0 text-warning" />
                    <span>{n.text}</span>
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function ReceiptLine({ ok, label, detail }: { ok: boolean | null; label: string; detail?: string }) {
  return (
    <li className="flex gap-2">
      <span
        className={cn(
          "mt-0.5 grid size-4 shrink-0 place-items-center rounded-full",
          ok === true && "bg-primary text-primary-foreground",
          ok === false && "bg-destructive text-destructive-foreground",
          ok === null && "border border-dashed border-muted-foreground/50",
        )}
      >
        {ok === true ? <Check weight="bold" className="size-2.5" /> : ok === false ? <X weight="bold" className="size-2.5" /> : null}
      </span>
      <span className="min-w-0">
        <span className={cn("break-words", ok === null && "text-muted-foreground")}>{label}</span>
        {detail ? <pre className="mt-1.5 max-h-28 overflow-auto rounded-md bg-muted px-2 py-1.5 font-mono text-[11px] whitespace-pre-wrap text-muted-foreground">{detail}</pre> : null}
      </span>
    </li>
  );
}
