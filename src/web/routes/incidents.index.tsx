import { ShieldCheck } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import type { Incident } from "@shared/types";
import { ErrorNote, IncidentRow } from "@/components/bits";
import { Card, Empty, PageHeader, RowsSkeleton, SegmentedControl } from "@/components/ui";
import { api } from "@/lib/api";

export const Route = createFileRoute("/incidents/")({ component: IncidentsPage });

const FILTERS = [
  { id: "exposed", label: "Exposed" },
  { id: "all", label: "All" },
  { id: "malicious", label: "Malicious" },
  { id: "signals", label: "Early signals" },
] as const;

type Filter = (typeof FILTERS)[number]["id"];

function matches(f: Filter, i: Incident) {
  return f === "exposed" ? i.exposureCount > 0 : f === "malicious" ? i.kind === "malicious" && i.status === "confirmed" : f === "signals" ? i.status === "unconfirmed" : true;
}

function IncidentsPage() {
  const [filter, setFilter] = useState<Filter>("all");
  const { data, isLoading, error } = useQuery({ queryKey: ["incidents"], queryFn: api.incidents, refetchInterval: 20_000 });
  const list = (data ?? []).filter((i) => matches(filter, i));
  return (
    <div>
      <PageHeader eyebrow="Live wire" title="Incidents">
        Advisories that match a version you actually resolve, and early reports from security news that OSV hasn't confirmed yet.
      </PageHeader>
      <div className="mb-4">
        <SegmentedControl
          ariaLabel="Filter incidents"
          value={filter}
          onValueChange={setFilter}
          options={FILTERS.map((f) => ({ value: f.id, label: f.label, count: data ? data.filter((i) => matches(f.id, i)).length : undefined }))}
        />
      </div>
      <div className="mb-4 empty:hidden">
        <ErrorNote error={error} />
      </div>
      <Card className="overflow-hidden">
        {isLoading ? (
          <RowsSkeleton rows={8} />
        ) : list.length ? (
          list.map((i) => <IncidentRow key={i.id} incident={i} />)
        ) : (
          <Empty icon={<ShieldCheck />} title="Nothing here">
            No incidents match this filter.
          </Empty>
        )}
      </Card>
    </div>
  );
}
