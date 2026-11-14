import { ArrowRight, WarningCircle } from "@phosphor-icons/react";
import { Link } from "@tanstack/react-router";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { planPackages, type FixIncidentRef, type Incident, type Run, type RunStatus } from "@shared/types";
import { Badge, Card } from "./ui";
import { cn, timeAgo } from "@/lib/utils";

/** Firebreak mark: a mint shield cut by a firebreak line. Glyph-only, like nimu-outreach's logo. */
export function Logo({ className }: { className?: string }) {
  const id = useId();
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden>
      <mask id={id}>
        <rect width="24" height="24" fill="white" />
        <path d="M5.5 16.5 18.5 7.5" stroke="black" strokeWidth="2.4" strokeLinecap="round" />
      </mask>
      <path d="M12 1.8 20.2 5v6.4c0 5.3-3.5 9.2-8.2 10.9-4.7-1.7-8.2-5.6-8.2-10.9V5Z" className="fill-primary" mask={`url(#${id})`} />
    </svg>
  );
}

export function KindBadge({ incident }: { incident: Pick<Incident, "kind" | "status"> }) {
  if (incident.status === "unconfirmed")
    return (
      <Badge tone="warning" dot>
        Early signal
      </Badge>
    );
  return incident.kind === "malicious" ? (
    <Badge tone="danger" dot>
      Malicious
    </Badge>
  ) : (
    <Badge tone="info" dot>
      Vulnerability
    </Badge>
  );
}

export function SeverityText({ severity }: { severity: Incident["severity"] }) {
  if (!severity) return null;
  const tone = severity === "critical" || severity === "high" ? "danger" : severity === "moderate" ? "warning" : "neutral";
  return (
    <Badge tone={tone} className="capitalize">
      {severity}
    </Badge>
  );
}

export function affectedLabel(i: Incident): string {
  if (i.affected.versions.length) {
    const v = i.affected.versions;
    return v.length > 3 ? `${v.slice(0, 3).join(", ")} +${v.length - 3}` : v.join(", ");
  }
  const r = i.affected.ranges[0];
  if (!r) return "all versions";
  const lo = r.introduced && r.introduced !== "0" ? `≥${r.introduced}` : "";
  const hi = r.fixed ? `<${r.fixed}` : r.lastAffected ? `≤${r.lastAffected}` : "";
  return [lo, hi].filter(Boolean).join(" ") || "all versions";
}

export function IncidentRow({ incident }: { incident: Incident }) {
  const exposed = incident.exposureCount > 0;
  return (
    <Link
      to="/incidents/$id"
      params={{ id: incident.id }}
      className="group relative flex items-center gap-4 border-b border-border px-5 py-3.5 transition-colors last:border-b-0 hover:bg-muted/50"
    >
      {exposed ? <span className="absolute inset-y-3 left-0 w-0.5 rounded-r-full bg-danger" aria-hidden /> : null}
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate font-mono text-[13px] font-medium text-foreground">{incident.package}</span>
          <span className="hidden shrink-0 font-mono text-xs text-muted-foreground sm:inline">{affectedLabel(incident)}</span>
          <KindBadge incident={incident} />
        </div>
        <p className="mt-1 truncate text-sm text-muted-foreground">{incident.title}</p>
      </div>
      <div className="hidden shrink-0 flex-col items-end gap-1 sm:flex">
        {exposed ? (
          <Badge tone="danger">
            {incident.exposureCount} repo{incident.exposureCount === 1 ? "" : "s"} exposed
          </Badge>
        ) : (
          <span className="text-xs text-muted-foreground">Not exposed</span>
        )}
        <span className="font-mono text-[11px] text-muted-foreground">
          {incident.id} · {timeAgo(incident.publishedAt ?? incident.detectedAt)}
        </span>
      </div>
      <ArrowRight className="hidden size-4 shrink-0 text-muted-foreground/50 transition-transform group-hover:translate-x-0.5 group-hover:text-foreground md:block" />
    </Link>
  );
}

const RUN_STATUS: Record<RunStatus, { label: string; tone: "neutral" | "danger" | "warning" | "success" | "info" }> = {
  queued: { label: "Queued", tone: "neutral" },
  running: { label: "Running", tone: "info" },
  passed: { label: "Verified", tone: "success" },
  failed: { label: "Failed", tone: "danger" },
  pr_opened: { label: "PR opened", tone: "success" },
};

export function RunStatusBadge({ status }: { status: RunStatus }) {
  const s = RUN_STATUS[status];
  return (
    <Badge tone={s.tone} dot pulse={status === "running" || status === "queued"}>
      {s.label}
    </Badge>
  );
}

export function RunRow({ run }: { run: Run }) {
  return (
    <Link to="/runs/$id" params={{ id: run.id }} className="group block border-b border-border px-5 py-3.5 transition-colors last:border-b-0 hover:bg-muted/50">
      <div className="flex items-baseline justify-between gap-3">
        <span className="min-w-0 truncate text-sm font-medium text-foreground">{run.repoFullName}</span>
        <span className="shrink-0 text-xs text-muted-foreground">{timeAgo(run.startedAt)}</span>
      </div>
      <div className="mt-1.5 flex min-w-0 items-center gap-2">
        <RunStatusBadge status={run.status} />
        <span className="min-w-0 truncate font-mono text-xs text-muted-foreground">
          <RunSummary run={run} />
        </span>
      </div>
    </Link>
  );
}

/** "lodash 4.17.20 → 4.17.21" for a one-package run, "3 packages · axios, debug +1" otherwise. */
export function RunSummary({ run }: { run: Run }) {
  const all = planPackages(run.plan);
  if (!all.length) return <>{run.incidentIds.join(", ")}</>;
  if (all.length === 1) {
    const p = all[0]!;
    return (
      <>
        {p.package} {p.from.join(", ")} <span className="text-muted-foreground/60">→</span> {p.to}
      </>
    );
  }
  const names = [...new Set(all.map((p) => p.package))];
  return (
    <>
      {all.length} packages · {names.slice(0, 2).join(", ")}
      {names.length > 2 ? ` +${names.length - 2}` : ""}
    </>
  );
}

/** Compact advisory chip for fix plans: malicious, or the severity. */
export function AdvisoryChip({ incident }: { incident: FixIncidentRef }) {
  const tone = incident.kind === "malicious" || incident.severity === "critical" || incident.severity === "high" ? "danger" : incident.severity === "moderate" ? "warning" : "neutral";
  return (
    <Link to="/incidents/$id" params={{ id: incident.id }} title={incident.title} className="shrink-0">
      <Badge tone={tone} className="font-mono hover:opacity-80">
        {incident.kind === "malicious" ? "malicious" : (incident.severity ?? "advisory")} · {incident.id}
      </Badge>
    </Link>
  );
}

export function ErrorNote({ error }: { error: unknown }) {
  if (!error) return null;
  return (
    <div role="alert" className="flex items-start gap-2 rounded-md border border-danger/25 bg-danger-soft px-3 py-2 text-sm text-danger">
      <WarningCircle weight="fill" className="mt-0.5 size-4 shrink-0" />
      <span className="min-w-0 break-words">{error instanceof Error ? error.message : String(error)}</span>
    </div>
  );
}

/** Count-up stat tile (nimu-outreach MetricTile): eyebrow label, large tabular value. */
export function MetricTile({ label, value, icon, tone, hint }: { label: string; value: number; icon?: ReactNode; tone?: "danger" | "success"; hint?: ReactNode }) {
  const [shown, setShown] = useState(0);
  const from = useRef(0);
  useEffect(() => {
    const start = performance.now();
    const base = from.current;
    let raf = 0;
    const tick = (now: number) => {
      const p = Math.min((now - start) / 900, 1);
      const v = Math.round(base + (value - base) * (1 - Math.pow(1 - p, 3)));
      setShown(v);
      if (p < 1) raf = requestAnimationFrame(tick);
      else from.current = value;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value]);
  return (
    <Card className="p-4 sm:p-5">
      <div className="flex items-center justify-between gap-2">
        <p className="truncate text-xs font-medium tracking-[0.03em] text-muted-foreground uppercase sm:text-eyebrow">{label}</p>
        {icon ? <span className={cn("hidden shrink-0 text-muted-foreground/70 sm:inline [&_svg]:size-4", tone === "danger" && "text-danger", tone === "success" && "text-success")}>{icon}</span> : null}
      </div>
      <p className={cn("mt-2 text-2xl font-bold sm:text-3xl tracking-tight tabular-nums", tone === "danger" ? "text-danger" : tone === "success" ? "text-success" : "text-foreground")}>
        {shown.toLocaleString("en-US")}
      </p>
      {hint ? <p className="mt-1 truncate text-xs text-muted-foreground">{hint}</p> : null}
    </Card>
  );
}
