import { Lightning } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { ErrorNote, RunRow } from "@/components/bits";
import { Card, Empty, PageHeader, RowsSkeleton } from "@/components/ui";
import { api } from "@/lib/api";

export const Route = createFileRoute("/runs/")({ component: RunsPage });

function RunsPage() {
  const { data, isLoading, error } = useQuery({ queryKey: ["runs"], queryFn: api.runs, refetchInterval: 10_000 });
  return (
    <div>
      <PageHeader eyebrow="Receipts" title="Fix runs">
        Every hotfix runs in its own Daytona sandbox: install with scripts disabled, prove the lockfile is clean, run your checks, repair, repeat.
      </PageHeader>
      <div className="mb-4 empty:hidden">
        <ErrorNote error={error} />
      </div>
      <Card className="overflow-hidden">
        {isLoading ? (
          <RowsSkeleton />
        ) : data?.length ? (
          data.map((r) => <RunRow key={r.id} run={r} />)
        ) : (
          <Empty icon={<Lightning />} title="No runs yet">
            Open an exposed incident and choose Generate hotfix.
          </Empty>
        )}
      </Card>
    </div>
  );
}
