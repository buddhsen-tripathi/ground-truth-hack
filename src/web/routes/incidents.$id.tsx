import { ArrowLeft, ArrowSquareOut, Database, GithubLogo, Key, Lightning, Newspaper, ShieldCheck, Warning } from "@phosphor-icons/react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import type { Exposure, Incident } from "@shared/types";
import { affectedLabel, ErrorNote, KindBadge, RunRow, SeverityText } from "@/components/bits";
import { Button, Card, CardHeader, Empty, LoadingState, Mono, Spinner, Tag } from "@/components/ui";
import { api } from "@/lib/api";
import { cn, timeAgo } from "@/lib/utils";

export const Route = createFileRoute("/incidents/$id")({ component: IncidentPage });

function SourceIcon({ kind }: { kind: string }) {
  if (kind === "osv") return <Database className="size-3.5" />;
  if (kind === "advisory") return <ShieldCheck className="size-3.5" />;
  return <Newspaper className="size-3.5" />;
}

function hostname(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function ExposureCard({ incident, exposure }: { incident: Incident; exposure: Exposure }) {
  const navigate = useNavigate();
  const start = useMutation({
    mutationFn: () => api.startRun({ incidentId: incident.id, repoId: exposure.repoId, lockfile: exposure.lockfile, version: exposure.version }),
    onSuccess: (run) => navigate({ to: "/runs/$id", params: { id: run.id } }),
    onError: (e) => toast.error((e as Error).message),
  });
  const malicious = incident.kind === "malicious";
  const ciHit = exposure.ciRuns.length > 0;
  const fixable = incident.ecosystem === "npm";
  return (
    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-start justify-between gap-3 px-5 py-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <GithubLogo className="size-4 shrink-0 text-muted-foreground" /> <span className="truncate">{exposure.repoFullName}</span>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
            <Mono>
              {incident.package}@{exposure.version}
            </Mono>
            <span>in</span>
            <Mono>{exposure.lockfile}</Mono>
            <Tag>{exposure.direct ? "direct" : "transitive"}</Tag>
          </div>
        </div>
        {fixable ? (
          <Button onClick={() => start.mutate()} disabled={start.isPending}>
            {start.isPending ? <Spinner /> : <Lightning weight="fill" />} Generate hotfix
          </Button>
        ) : (
          <Tag>Manual fix · {incident.ecosystem}</Tag>
        )}
      </div>
      {malicious ? (
        <div className={cn("border-t border-border px-5 py-4 text-sm", ciHit ? "bg-danger-soft" : "bg-muted/40")}>
          {ciHit ? (
            <>
              <div className="flex items-center gap-1.5 font-semibold text-danger">
                <Warning weight="fill" className="size-4" /> {exposure.ciRuns.length} CI run{exposure.ciRuns.length === 1 ? "" : "s"} since disclosure may have installed it
              </div>
              <ul className="mt-2 space-y-1 text-[13px]">
                {exposure.ciRuns.slice(0, 4).map((r) => (
                  <li key={r.id}>
                    <a href={r.url} target="_blank" rel="noreferrer" className="text-foreground/80 hover:text-foreground hover:underline">
                      {r.name} · {timeAgo(r.createdAt)} · {r.conclusion ?? "running"}
                    </a>
                  </li>
                ))}
              </ul>
              {exposure.secrets.length ? (
                <div className="mt-4">
                  <div className="flex items-center gap-1.5 font-semibold text-foreground">
                    <Key weight="bold" className="size-4" /> Rotate these secrets
                  </div>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {exposure.secrets.map((s) => (
                      <label key={s} className="flex cursor-pointer items-center gap-1.5 rounded-md border border-border bg-card px-2 py-1 font-mono text-xs shadow-2xs has-checked:text-muted-foreground has-checked:line-through">
                        <input type="checkbox" className="accent-[var(--primary)]" /> {s}
                      </label>
                    ))}
                  </div>
                </div>
              ) : null}
            </>
          ) : (
            <div className="text-muted-foreground">No CI runs since disclosure, so CI secrets were likely not exposed. Check developer machines that installed it.</div>
          )}
        </div>
      ) : null}
    </Card>
  );
}

function IncidentPage() {
  const { id } = Route.useParams();
  const { data, isLoading, error } = useQuery({ queryKey: ["incident", id], queryFn: () => api.incident(id), refetchInterval: 15_000 });
  const [expanded, setExpanded] = useState(false);
  if (isLoading) return <LoadingState label="Loading incident…" className="min-h-[60vh]" />;
  if (error || !data) return <ErrorNote error={error} />;
  const { incident, exposures, runs } = data;
  return (
    <div>
      <Link to="/incidents" className="mb-5 inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-3.5" /> Incidents
      </Link>
      <div className="mb-8">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <KindBadge incident={incident} />
          <SeverityText severity={incident.severity} />
          <span className="font-mono text-xs text-muted-foreground">{incident.id}</span>
          {incident.aliases.slice(0, 3).map((a) => (
            <span key={a} className="font-mono text-xs text-muted-foreground">
              · {a}
            </span>
          ))}
        </div>
        <h1 className="max-w-4xl text-headline text-balance text-foreground">{incident.title}</h1>
        <div className="mt-3 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <Mono>{incident.package}</Mono>
          <span>affected: {affectedLabel(incident)}</span>
          <span>· published {timeAgo(incident.publishedAt)}</span>
          <span>· {incident.ecosystem}</span>
        </div>
        {incident.status === "unconfirmed" ? (
          <div className="mt-5 flex max-w-3xl items-start gap-2 rounded-md border border-warning/30 bg-warning-soft px-3 py-2.5 text-sm text-warning">
            <Warning weight="fill" className="mt-0.5 size-4 shrink-0" />
            Reported in security news but not on OSV yet. The package and versions were pulled from the sources below; check them before acting.
          </div>
        ) : null}
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="min-w-0 space-y-4">
          <div className="flex items-baseline justify-between gap-3">
            <h2 className="text-lg font-semibold tracking-tight text-foreground">Exposure</h2>
            <span className="text-sm text-muted-foreground">
              {exposures.length ? `${new Set(exposures.map((e) => e.repoId)).size} repo${new Set(exposures.map((e) => e.repoId)).size === 1 ? "" : "s"}` : "none"}
            </span>
          </div>
          {exposures.length ? (
            exposures.map((e) => <ExposureCard key={`${e.repoId}${e.lockfile}${e.version}`} incident={incident} exposure={e} />)
          ) : (
            <Card>
              <Empty icon={<ShieldCheck />} title="None of your repos resolve an affected version" />
            </Card>
          )}
          {incident.summary ? (
            <Card className="p-5">
              <h3 className="mb-2 text-base font-semibold tracking-tight text-foreground">Details</h3>
              <p className={cn("text-sm leading-6 whitespace-pre-line text-muted-foreground", !expanded && "line-clamp-5")}>{incident.summary}</p>
              {incident.summary.length > 400 ? (
                <button type="button" onClick={() => setExpanded((x) => !x)} className="mt-2 text-sm font-medium text-foreground underline-offset-4 hover:underline">
                  {expanded ? "Show less" : "Show more"}
                </button>
              ) : null}
            </Card>
          ) : null}
          {runs.length ? (
            <Card className="overflow-hidden">
              <CardHeader title="Fix runs" />
              {runs.map((r) => (
                <RunRow key={r.id} run={r} />
              ))}
            </Card>
          ) : null}
        </div>
        <Card className="h-fit overflow-hidden">
          <CardHeader title="Sources" description="Every claim links back to where it came from" />
          <ul>
            {incident.sources.map((s) => (
              <li key={s.url} className="border-b border-border last:border-b-0">
                <a href={s.url} target="_blank" rel="noreferrer" className="group flex items-start gap-3 px-5 py-3 transition-colors hover:bg-muted/50">
                  <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md border border-border bg-muted/40 text-muted-foreground">
                    <SourceIcon kind={s.kind} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-foreground">{s.title}</span>
                    <span className="block truncate text-xs text-muted-foreground">{hostname(s.url)}</span>
                  </span>
                  <ArrowSquareOut className="mt-1 size-3.5 shrink-0 text-muted-foreground/60 group-hover:text-foreground" />
                </a>
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </div>
  );
}
