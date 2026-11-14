import { ArrowClockwise, ArrowSquareOut, Browser, LockSimple, Stop } from "@phosphor-icons/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import type { RunPreview } from "@shared/types";
import { api } from "@/lib/api";
import { Button, Card, Mono, Spinner } from "./ui";

function useCountdown(until: string | undefined) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!until) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [until]);
  if (!until) return null;
  const s = Math.max(0, Math.round((Date.parse(until) - now) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** The patched app, served from the run's Daytona sandbox through a signed single-port URL. */
export function LivePreview({ runId, preview }: { runId: string; preview: RunPreview }) {
  const qc = useQueryClient();
  const frame = useRef<HTMLIFrameElement>(null);
  const left = useCountdown(preview.state === "live" ? preview.expiresAt : undefined);
  const stop = useMutation({
    mutationFn: () => api.stopPreview(runId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["run", runId] });
      toast.success("Preview stopped and the sandbox deleted");
    },
    onError: (e) => toast.error((e as Error).message),
  });

  if (preview.state === "unavailable" || preview.state === "ended") {
    return (
      <Card className="flex items-start gap-3 p-5">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border bg-muted/40 text-muted-foreground">
          <Browser className="size-4" />
        </span>
        <div className="min-w-0">
          <h3 className="text-base font-semibold tracking-tight text-foreground">{preview.state === "ended" ? "Preview ended" : "No live preview"}</h3>
          <p className="mt-0.5 text-sm leading-6 break-words text-muted-foreground">{preview.note}</p>
        </div>
      </Card>
    );
  }

  const host = preview.url ? new URL(preview.url).host : `localhost:${preview.port ?? 3000}`;

  return (
    <Card className="overflow-hidden">
      <div className="flex h-11 items-center gap-2 border-b border-border bg-muted/40 px-3">
        <div className="hidden items-center gap-1.5 pr-1 sm:flex" aria-hidden>
          <span className="size-2.5 rounded-full bg-border" />
          <span className="size-2.5 rounded-full bg-border" />
          <span className="size-2.5 rounded-full bg-border" />
        </div>
        <div className="flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-md border border-border bg-background px-2.5 font-mono text-xs text-muted-foreground">
          <LockSimple className="size-3 shrink-0" />
          <span className="truncate">{host}</span>
        </div>
        {preview.state === "live" ? (
          <>
            <span className="hidden shrink-0 font-mono text-xs text-muted-foreground tabular-nums sm:inline" title="The sandbox is deleted when this reaches zero">
              {left}
            </span>
            <Button variant="ghost" size="icon-sm" title="Reload" aria-label="Reload preview" onClick={() => frame.current && (frame.current.src = preview.url!)}>
              <ArrowClockwise />
            </Button>
            <a href={preview.url} target="_blank" rel="noreferrer" title="Open in a new tab" aria-label="Open preview in a new tab" className="inline-flex size-8 shrink-0 items-center justify-center rounded-md hover:bg-accent">
              <ArrowSquareOut className="size-4" />
            </a>
            <Button
              variant="ghost"
              size="icon-sm"
              title="Stop the preview and delete the sandbox"
              aria-label="Stop preview"
              className="hover:bg-destructive/10 hover:text-destructive"
              onClick={() => stop.mutate()}
              disabled={stop.isPending}
            >
              {stop.isPending ? <Spinner /> : <Stop weight="fill" />}
            </Button>
          </>
        ) : null}
      </div>
      {preview.state === "live" && preview.url ? (
        <iframe ref={frame} src={preview.url} title="Live preview of the patched app" className="block h-[560px] w-full bg-white" />
      ) : (
        <div className="flex h-[280px] flex-col items-center justify-center gap-3 px-6 text-center">
          <Spinner className="size-5 text-info" />
          <p className="text-sm font-medium text-foreground">Booting the patched app in the sandbox…</p>
          {preview.command ? <Mono className="max-w-full truncate">{preview.command}</Mono> : null}
        </div>
      )}
      <div className="flex items-center justify-between gap-3 border-t border-border px-4 py-2.5 text-xs text-muted-foreground">
        <span>Served from the run's Daytona sandbox through a signed, single-port link.</span>
        {left ? <span className="shrink-0 tabular-nums sm:hidden">{left} left</span> : null}
      </div>
    </Card>
  );
}
