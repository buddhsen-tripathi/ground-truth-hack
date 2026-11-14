import { ArrowLeft, ArrowSquareOut, ArrowsClockwise, GithubLogo, Lightning, LockSimple, ShieldCheck, Wrench } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { planPackages, type FixPlan, type LockfileFix, type PackageFix } from "@shared/types";
import { AdvisoryChip, ErrorNote, RunRow } from "@/components/bits";
import { Highlight } from "@/components/highlight";
import { Badge, Button, Card, CardHeader, Empty, LoadingState, Mono, RowsSkeleton, Spinner, Tag } from "@/components/ui";
import { api } from "@/lib/api";
import { cn, nf, timeAgo } from "@/lib/utils";

export const Route = createFileRoute("/repos/$id")({ component: RepoPage });

function PackageRow({ p, checked, onToggle }: { p: PackageFix; checked: boolean; onToggle: () => void }) {
  return (
    <label className={cn("flex cursor-pointer gap-3 border-b border-border px-5 py-3.5 transition-colors last:border-b-0 hover:bg-muted/40", !checked && "opacity-60")}>
      <input type="checkbox" checked={checked} onChange={onToggle} className="mt-1 size-4 shrink-0 cursor-pointer accent-[var(--primary)]" />
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-baseline gap-x-1.5 gap-y-1 font-mono text-[13px]">
          <span className="font-medium text-foreground">{p.package}</span>
          <span className="text-danger line-through decoration-1 opacity-80">{p.from.join(", ")}</span>
          <span className="text-muted-foreground">→</span>
          <span className="font-medium text-success">{p.to}</span>
          <span className="ml-1 inline-flex gap-1 font-sans">
            <Tag>{p.strategy}</Tag>
            <Tag>{p.direct ? "direct" : "transitive"}</Tag>
          </span>
        </span>
        <span className="mt-1.5 flex flex-wrap gap-1.5">
          {p.incidents.slice(0, 3).map((i) => (
            <AdvisoryChip key={i.id} incident={i} />
          ))}
          {p.incidents.length > 3 ? (
            <span title={p.incidents.slice(3).map((i) => i.id).join(", ")}>
              <Tag>+{p.incidents.length - 3} more</Tag>
            </span>
          ) : null}
        </span>
        <span className="mt-1.5 line-clamp-2 block text-xs leading-5 text-muted-foreground">{p.reason}</span>
      </span>
    </label>
  );
}

function LockfileGroup({ t, picked, toggle }: { t: LockfileFix; picked: Set<string>; toggle: (key: string) => void }) {
  return (
    <div>
      <div className="flex items-center gap-2 border-y border-border bg-muted/40 px-5 py-2 first:border-t-0">
        <Tag>{t.manager}</Tag>
        <Mono className="min-w-0 truncate">{t.lockfile}</Mono>
        <span className="ml-auto shrink-0 text-xs text-muted-foreground">
          {t.packages.length} package{t.packages.length === 1 ? "" : "s"}
        </span>
      </div>
      {t.packages.map((p) => (
        <PackageRow key={p.key} p={p} checked={picked.has(p.key)} onToggle={() => toggle(p.key)} />
      ))}
    </div>
  );
}

function FixPlanCard({ repoId, plan, loading, error }: { repoId: string; plan: FixPlan | undefined; loading: boolean; error: unknown }) {
  const navigate = useNavigate();
  const all = useMemo(() => planPackages(plan ?? null), [plan]);
  // Everything starts checked; unticked keys are what the user left out.
  const [unticked, setUnticked] = useState<Set<string>>(new Set());
  const picked = useMemo(() => new Set(all.map((p) => p.key).filter((k) => !unticked.has(k))), [all, unticked]);
  const toggle = (key: string) =>
    setUnticked((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const start = useMutation({
    mutationFn: () => api.startFix(repoId, [...picked]),
    onSuccess: (run) => navigate({ to: "/runs/$id", params: { id: run.id } }),
    onError: (e) => toast.error((e as Error).message),
  });
  const advisories = new Set(all.filter((p) => picked.has(p.key)).flatMap((p) => p.incidents.map((i) => i.id))).size;

  return (
    <Card className="overflow-hidden">
      <CardHeader
        title="Fix plan"
        description="One sandbox run installs and checks every ticked package together, then offers one PR."
        action={
          all.length > 1 ? (
            <Button variant="ghost" size="sm" onClick={() => setUnticked(picked.size === all.length ? new Set(all.map((p) => p.key)) : new Set())}>
              {picked.size === all.length ? "Untick all" : "Tick all"}
            </Button>
          ) : undefined
        }
      />
      {loading ? (
        <div>
          <p className="border-b border-border px-5 py-2.5 text-xs text-muted-foreground">Looking up clean releases on npm and PyPI…</p>
          <RowsSkeleton rows={3} />
        </div>
      ) : error ? (
        <div className="p-5">
          <ErrorNote error={error} />
        </div>
      ) : !all.length ? (
        <Empty icon={<ShieldCheck />} title={plan?.skipped.length ? "Nothing Firebreak can fix automatically" : "Nothing to fix"}>
          {plan?.skipped.length ? "Every exposure below needs a manual change." : "No advisory hits a version this repo resolves."}
        </Empty>
      ) : (
        <>
          {plan!.targets.map((t) => (
            <LockfileGroup key={t.lockfile} t={t} picked={picked} toggle={toggle} />
          ))}
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border bg-muted/30 px-5 py-3.5">
            <span className="text-sm text-muted-foreground">
              <span className="font-medium text-foreground tabular-nums">{picked.size}</span> of {all.length} package{all.length === 1 ? "" : "s"} · clears{" "}
              <span className="font-medium text-foreground tabular-nums">{advisories}</span> advisor{advisories === 1 ? "y" : "ies"}
            </span>
            <Button onClick={() => start.mutate()} disabled={!picked.size || start.isPending}>
              {start.isPending ? <Spinner /> : <Lightning weight="fill" />} Fix repo
            </Button>
          </div>
        </>
      )}
    </Card>
  );
}

function RepoPage() {
  const { id } = Route.useParams();
  const qc = useQueryClient();
  const { data, isLoading, error } = useQuery({ queryKey: ["repo", id], queryFn: () => api.repo(id), refetchInterval: 15_000 });
  const exposed = (data?.repo.exposureCount ?? 0) > 0;
  const plan = useQuery({ queryKey: ["fix-plan", id, data?.repo.scannedAt], queryFn: () => api.fixPlan(id), enabled: exposed, staleTime: 60_000 });
  const rescan = useMutation({
    mutationFn: () => api.rescan(id),
    onSuccess: () => {
      qc.invalidateQueries();
      toast.success("Rescanned");
    },
    onError: (e) => toast.error((e as Error).message),
  });

  if (isLoading) return <LoadingState label="Loading repo…" className="min-h-[60vh]" />;
  if (error || !data) return <ErrorNote error={error} />;
  const { repo, runs } = data;
  const skipped = plan.data?.skipped ?? [];

  return (
    <div>
      <Link to="/repos" className="mb-5 inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-3.5" /> Repos
      </Link>
      <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <div className="mb-3 flex flex-wrap items-center gap-2">
            {exposed ? (
              <Badge tone="danger" dot>
                {repo.exposureCount} exposed
              </Badge>
            ) : (
              <Badge tone="success" dot>
                Clear
              </Badge>
            )}
            {repo.private ? (
              <Badge tone="neutral">
                <LockSimple className="size-3" /> Private
              </Badge>
            ) : null}
            <span className="font-mono text-xs text-muted-foreground">
              {repo.defaultBranch}
              {repo.headSha ? ` @ ${repo.headSha.slice(0, 7)}` : ""} · scanned {timeAgo(repo.scannedAt)}
            </span>
          </div>
          <h1 className="text-headline break-words text-foreground">
            {exposed ? (
              <>
                Fix <span className="font-mono text-[0.8em]">{repo.fullName.split("/")[1]}</span> in <Highlight>one PR</Highlight>
              </>
            ) : (
              <span className="font-mono text-[0.8em]">{repo.fullName}</span>
            )}
          </h1>
          <a href={`https://github.com/${repo.fullName}`} target="_blank" rel="noreferrer" className="mt-2 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
            <GithubLogo className="size-4" /> {repo.fullName} <ArrowSquareOut className="size-3.5" />
          </a>
        </div>
        <Button variant="outline" onClick={() => rescan.mutate()} disabled={rescan.isPending}>
          {rescan.isPending ? <Spinner /> : <ArrowsClockwise />} Rescan
        </Button>
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="min-w-0 space-y-6">
          {repo.scanError ? <ErrorNote error={repo.scanError} /> : null}
          {exposed ? (
            <FixPlanCard key={repo.scannedAt ?? ""} repoId={repo.id} plan={plan.data} loading={plan.isLoading} error={plan.error} />
          ) : (
            <Card>
              <Empty icon={<ShieldCheck />} title="Nothing to fix">
                No advisory hits a version this repo resolves. Firebreak checks again every 10 minutes.
              </Empty>
            </Card>
          )}
          {skipped.length ? (
            <Card className="overflow-hidden">
              <CardHeader title={<span className="flex items-center gap-1.5"><Wrench weight="bold" className="size-4" /> Needs a manual fix</span>} description="Exposures Firebreak can't change for you" />
              <ul>
                {skipped.map((x) => (
                  <li key={x.key} className="border-b border-border px-5 py-3.5 last:border-b-0">
                    <div className="flex flex-wrap items-baseline gap-x-1.5 font-mono text-[13px]">
                      <span className="font-medium text-foreground">{x.package}</span>
                      <span className="text-muted-foreground">{x.versions.join(", ")}</span>
                      <span className="font-sans">
                        <Tag>{x.ecosystem}</Tag>
                      </span>
                    </div>
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      {x.incidents.map((i) => (
                        <AdvisoryChip key={i.id} incident={i} />
                      ))}
                    </div>
                    <p className="mt-1.5 text-xs leading-5 text-muted-foreground">
                      <Mono>{x.lockfile}</Mono> · {x.reason}
                    </p>
                  </li>
                ))}
              </ul>
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
          <CardHeader title="Inventory" description={`${nf.format(repo.depCount)} resolved dependencies`} />
          <ul className="space-y-2 px-5 py-4 text-[13px]">
            {repo.lockfiles.length ? (
              repo.lockfiles.map((l) => (
                <li key={l.path} className="flex min-w-0 flex-wrap items-center gap-2">
                  <Tag>{l.manager}</Tag>
                  <Mono className="min-w-0 truncate">{l.path}</Mono>
                  {l.error ? <span className="text-danger">{l.error}</span> : <span className="text-muted-foreground">{nf.format(l.packages)}</span>}
                </li>
              ))
            ) : (
              <li className="text-muted-foreground">No lockfiles found.</li>
            )}
          </ul>
          <div className="border-t border-border px-5 py-3 text-xs text-muted-foreground">
            {repo.actions.length} GitHub Actions ref{repo.actions.length === 1 ? "" : "s"}, {repo.actions.filter((a) => !a.pinned).length} not pinned to a SHA
          </div>
        </Card>
      </div>
    </div>
  );
}
