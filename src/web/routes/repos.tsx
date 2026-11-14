import { ArrowsClockwise, FolderSimple, GithubLogo, LockSimple, Trash, Warning } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { toast } from "sonner";
import type { Repo } from "@shared/types";
import { AddRepoForm } from "@/components/add-repo";
import { ErrorNote } from "@/components/bits";
import { Badge, Button, Card, Empty, Mono, PageHeader, Skeleton, Spinner, Tag } from "@/components/ui";
import { api } from "@/lib/api";
import { nf, timeAgo } from "@/lib/utils";

export const Route = createFileRoute("/repos")({ component: ReposPage });

function RepoCard({ repo }: { repo: Repo }) {
  const qc = useQueryClient();
  const rescan = useMutation({
    mutationFn: () => api.rescan(repo.id),
    onSuccess: () => {
      qc.invalidateQueries();
      toast.success(`${repo.fullName} rescanned`);
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const remove = useMutation({
    mutationFn: () => api.removeRepo(repo.id),
    onSuccess: () => qc.invalidateQueries(),
    onError: (e) => toast.error((e as Error).message),
  });
  const unpinned = repo.actions.filter((a) => !a.pinned);
  return (
    <Card className="overflow-hidden">
      <div className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
        <div className="min-w-0">
          <a href={`https://github.com/${repo.fullName}`} target="_blank" rel="noreferrer" className="flex min-w-0 items-center gap-2 text-sm font-semibold text-foreground hover:underline">
            <GithubLogo className="size-4 shrink-0 text-muted-foreground" /> <span className="truncate">{repo.fullName}</span>
            {repo.private ? <LockSimple className="size-3.5 shrink-0 text-muted-foreground" /> : null}
          </a>
          <div className="mt-1 truncate font-mono text-xs text-muted-foreground">
            {repo.defaultBranch}
            {repo.headSha ? ` @ ${repo.headSha.slice(0, 7)}` : ""} · scanned {timeAgo(repo.scannedAt)}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {repo.exposureCount ? (
            <Badge tone="danger" dot>
              {repo.exposureCount} exposed
            </Badge>
          ) : (
            <Badge tone="success" dot>
              Clear
            </Badge>
          )}
          <Button variant="ghost" size="icon-sm" title="Rescan" className="ml-1 text-muted-foreground hover:text-foreground" onClick={() => rescan.mutate()} disabled={rescan.isPending} aria-label="Rescan">
            {rescan.isPending ? <Spinner /> : <ArrowsClockwise />}
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            title="Stop watching"
            className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
            onClick={() => {
              if (confirm(`Stop watching ${repo.fullName}? This removes its scan data from Firebreak only.`)) remove.mutate();
            }}
            aria-label="Stop watching"
          >
            <Trash />
          </Button>
        </div>
      </div>
      <div className="space-y-4 px-5 py-4 text-[13px]">
        {repo.scanError ? <ErrorNote error={repo.scanError} /> : null}
        <div>
          <div className="text-eyebrow mb-2 text-muted-foreground uppercase">Lockfiles · {nf.format(repo.depCount)} resolved</div>
          {repo.lockfiles.length ? (
            <ul className="space-y-1.5">
              {repo.lockfiles.map((l) => (
                <li key={l.path} className="flex flex-wrap items-center gap-2">
                  <Tag>{l.manager}</Tag>
                  <Mono>{l.path}</Mono>
                  {l.error ? <span className="text-danger">{l.error}</span> : <span className="text-muted-foreground">{nf.format(l.packages)} packages</span>}
                </li>
              ))}
            </ul>
          ) : (
            <span className="text-muted-foreground">No npm, pnpm, yarn or bun lockfile found.</span>
          )}
        </div>
        <div>
          <div className="text-eyebrow mb-2 text-muted-foreground uppercase">GitHub Actions · {repo.actions.length} refs</div>
          {unpinned.length ? (
            <div className="flex items-start gap-1.5 text-warning">
              <Warning weight="fill" className="mt-0.5 size-4 shrink-0" />
              <span>
                {unpinned.length} action{unpinned.length === 1 ? "" : "s"} use a movable tag instead of a commit SHA (
                {[...new Set(unpinned.map((a) => `${a.uses}@${a.ref}`))].slice(0, 3).join(", ")}
                {unpinned.length > 3 ? "…" : ""}). Tag hijacks hit Trivy and tj-actions this way.
              </span>
            </div>
          ) : repo.actions.length ? (
            <span className="text-success">All actions pinned to commit SHAs.</span>
          ) : (
            <span className="text-muted-foreground">No workflows.</span>
          )}
          {repo.secrets.length ? <div className="mt-1 text-muted-foreground">Workflows reference {repo.secrets.length} secret{repo.secrets.length === 1 ? "" : "s"}.</div> : null}
        </div>
      </div>
    </Card>
  );
}

function ReposPage() {
  const { data, isLoading, error } = useQuery({ queryKey: ["repos"], queryFn: api.repos });
  return (
    <div>
      <PageHeader eyebrow="Inventory" title="Repos" action={<AddRepoForm />}>
        Firebreak reads lockfiles and workflows from the default branch through your GitHub token. Nothing is installed or run during a scan.
      </PageHeader>
      <div className="mb-4 empty:hidden">
        <ErrorNote error={error} />
      </div>
      {isLoading ? (
        <div className="grid gap-4 lg:grid-cols-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-56 rounded-lg" />
          ))}
        </div>
      ) : data?.length ? (
        <div className="grid gap-4 lg:grid-cols-2">
          {data.map((r) => (
            <RepoCard key={r.id} repo={r} />
          ))}
        </div>
      ) : (
        <Card>
          <Empty icon={<FolderSimple />} title="No repos yet">
            Add a repo your GitHub token can read, as owner/name.
          </Empty>
        </Card>
      )}
    </div>
  );
}
