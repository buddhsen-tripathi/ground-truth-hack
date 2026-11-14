import { ArrowRight, ArrowsClockwise, CheckCircle, FolderSimple, Lightning, Package, ShieldCheck, ShieldWarning } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { motion } from "motion/react";
import { AddRepoForm } from "@/components/add-repo";
import { ErrorNote, IncidentRow, MetricTile, RunRow } from "@/components/bits";
import { useCheckNow } from "@/components/shell";
import { Badge, Button, buttonVariants, Card, CardHeader, Empty, RowsSkeleton, Skeleton, Spinner } from "@/components/ui";
import { api } from "@/lib/api";
import { cn, nf, timeAgo } from "@/lib/utils";

export const Route = createFileRoute("/")({ component: OverviewPage });

function OverviewSkeleton() {
  return (
    <div aria-busy>
      <Skeleton className="mb-6 h-56 rounded-lg" />
      <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-[108px] rounded-lg" />
        ))}
      </div>
      <Card className="overflow-hidden">
        <RowsSkeleton />
      </Card>
    </div>
  );
}

function OverviewPage() {
  const { data, isLoading, error } = useQuery({ queryKey: ["overview"], queryFn: api.overview, refetchInterval: 15_000 });
  const check = useCheckNow();

  if (isLoading) return <OverviewSkeleton />;
  if (error || !data) return <ErrorNote error={error} />;

  const exposed = data.incidents.filter((i) => i.exposureCount > 0);
  const verified = data.runs.filter((r) => r.status === "passed" || r.status === "pr_opened").length;
  const allClear = data.repos > 0 && exposed.length === 0;
  const exposedPackages = new Set(exposed.map((i) => `${i.ecosystem}:${i.package}`)).size;
  const tone = exposed.length ? "danger" : allClear ? "success" : "neutral";

  const checkButton = (
    <Button variant="outline" size="lg" onClick={() => check.mutate()} disabled={check.isPending}>
      {check.isPending ? <Spinner /> : <ArrowsClockwise />} Check now
    </Button>
  );

  return (
    <div>
      <motion.section
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
        className="relative mb-6 overflow-hidden rounded-lg border border-border bg-card p-6 shadow-2xs md:p-8"
      >
        {/* Soft status wash from the top-right corner; the card itself stays neutral like nimu-outreach. */}
        <div
          aria-hidden
          className={cn(
            "pointer-events-none absolute inset-0",
            tone === "danger" && "bg-[radial-gradient(120%_90%_at_100%_0%,var(--danger-soft),transparent_60%)]",
            tone === "success" && "bg-[radial-gradient(120%_90%_at_100%_0%,var(--success-soft),transparent_60%)]",
          )}
        />
        <ShieldGlyph className="pointer-events-none absolute -right-8 -bottom-12 hidden size-60 text-foreground/[0.035] md:block" danger={exposed.length > 0} />

        <div className="relative">
          <div className="mb-4 flex flex-wrap items-center gap-2">
            <Badge tone={tone === "neutral" ? "success" : tone} dot pulse>
              {exposed.length ? "Exposed" : allClear ? "All clear" : "Live"}
            </Badge>
            <span className="text-xs text-muted-foreground">Watching every 10 min · last check {timeAgo(data.watch.lastRun?.at)}</span>
          </div>

          {data.repos === 0 ? (
            <>
              <h1 className="max-w-2xl text-[1.875rem] leading-[1.15] font-semibold tracking-[-0.025em] text-balance md:text-display-md">
                From disclosure to a tested hotfix PR in minutes.
              </h1>
              <p className="mt-3 max-w-xl text-[15px] leading-6 text-pretty text-muted-foreground">
                Watch a repo. Firebreak reads every lockfile, checks each resolved version against OSV and fresh security news, and when you're hit, fixes it in a
                Daytona sandbox until your own checks pass.
              </p>
              <div className="mt-6">
                <AddRepoForm autoFocus />
              </div>
            </>
          ) : exposed.length ? (
            <>
              <h1 className="max-w-3xl text-[1.875rem] leading-[1.15] font-semibold tracking-[-0.025em] text-balance md:text-display-md">
                <span className="text-danger">
                  {data.exposedRepos} repo{data.exposedRepos === 1 ? "" : "s"} exposed
                </span>
                {exposedPackages > 1 ? ` across ${exposedPackages} packages.` : ` through ${exposed[0]!.package}.`}
              </h1>
              <p className="mt-3 max-w-xl text-[15px] leading-6 text-pretty text-muted-foreground">
                {exposed.length} advisor{exposed.length === 1 ? "y matches" : "ies match"} versions you ship. Open one to see where the bad version sits, which CI runs pulled it in,
                and to generate a hotfix that's tested before you see it.
              </p>
              <div className="mt-6 flex flex-wrap gap-2">
                <Link to="/incidents/$id" params={{ id: exposed[0]!.id }} className={buttonVariants({ variant: "destructive", size: "lg" })}>
                  Triage {exposed[0]!.package} <ArrowRight />
                </Link>
                {checkButton}
              </div>
            </>
          ) : (
            <>
              <h1 className="max-w-3xl text-[1.875rem] leading-[1.15] font-semibold tracking-[-0.025em] text-balance md:text-display-md">
                All clear across {data.repos} repo{data.repos === 1 ? "" : "s"}.
              </h1>
              <p className="mt-3 max-w-xl text-[15px] leading-6 text-pretty text-muted-foreground">
                {nf.format(data.deps)} resolved dependencies checked against OSV{data.watch.integrations.you ? " and today's security news" : ""}. Nothing you ship matches a
                known bad version.
              </p>
              <div className="mt-6">{checkButton}</div>
            </>
          )}
        </div>
      </motion.section>

      <div className="mb-6 grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        <MetricTile label="Repos watched" value={data.repos} icon={<FolderSimple />} />
        <MetricTile label="Dependencies" value={data.deps} icon={<Package />} hint="resolved across lockfiles" />
        <MetricTile label="Repos exposed" value={data.exposedRepos} icon={<ShieldWarning />} tone={data.exposedRepos ? "danger" : undefined} />
        <MetricTile label="Fixes verified" value={verified} icon={<CheckCircle />} tone={verified ? "success" : undefined} />
      </div>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
        <Card className="overflow-hidden">
          <CardHeader
            title="Incident feed"
            description="OSV advisories for versions you resolve, plus early signals from security news"
            action={
              <Link to="/incidents" className={buttonVariants({ variant: "ghost", size: "sm" })}>
                View all <ArrowRight />
              </Link>
            }
          />
          {data.incidents.length ? (
            data.incidents.slice(0, 10).map((i) => <IncidentRow key={i.id} incident={i} />)
          ) : (
            <Empty icon={<ShieldCheck />} title="No incidents yet">
              {data.repos ? "Nothing on OSV or in today's news touches your dependencies." : "Watch a repo to start."}
            </Empty>
          )}
        </Card>
        <Card className="h-fit overflow-hidden">
          <CardHeader
            title="Recent fix runs"
            action={
              data.runs.length ? (
                <Link to="/runs" className={buttonVariants({ variant: "ghost", size: "sm" })}>
                  View all <ArrowRight />
                </Link>
              ) : undefined
            }
          />
          {data.runs.length ? (
            data.runs.map((r) => <RunRow key={r.id} run={r} />)
          ) : (
            <Empty icon={<Lightning />} title="No fixes yet">
              Runs show up here when you generate a hotfix from an incident.
            </Empty>
          )}
        </Card>
      </div>
    </div>
  );
}

function ShieldGlyph({ className, danger }: { className?: string; danger: boolean }) {
  return (
    <svg viewBox="0 0 100 100" className={className} aria-hidden>
      <path d="M50 6 88 20v28c0 24-17 40-38 46C29 88 12 72 12 48V20Z" fill="currentColor" />
      {danger ? (
        <path d="M50 30v24M50 66v2" stroke="var(--card)" strokeWidth="8" strokeLinecap="round" />
      ) : (
        <path d="m34 50 11 11 21-23" stroke="var(--card)" strokeWidth="8" fill="none" strokeLinecap="round" />
      )}
    </svg>
  );
}
