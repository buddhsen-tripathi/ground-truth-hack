import type { Exposure, FixPlan, Incident, Overview, Repo, Run, RunEvent } from "@shared/types";

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: { ...(init?.body ? { "Content-Type": "application/json" } : {}), ...init?.headers },
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new ApiError(res.status, data.error ?? `Request failed (${res.status})`);
  return data;
}

export const api = {
  overview: () => req<Overview>("/overview"),
  checkNow: () => req<{ osvChecked: number; newsChecked: number; newIncidents: number; newExposures: number; errors: string[] }>("/watch/run", { method: "POST" }),
  repos: () => req<Repo[]>("/repos"),
  repo: (id: string) =>
    req<{ repo: Repo; exposures: Exposure[]; directDeps: { name: string; version: string; lockfile: string; ecosystem: string }[]; runs: Run[] }>(`/repos/${id}`),
  fixPlan: (id: string) => req<FixPlan>(`/repos/${id}/fix-plan`),
  startFix: (id: string, keys: string[]) => req<Run>(`/repos/${id}/fix`, { method: "POST", body: JSON.stringify({ keys }) }),
  addRepo: (fullName: string) => req<Repo>("/repos", { method: "POST", body: JSON.stringify({ fullName }) }),
  rescan: (id: string) => req<Repo>(`/repos/${id}/scan`, { method: "POST" }),
  removeRepo: (id: string) => req<{ ok: true }>(`/repos/${id}`, { method: "DELETE" }),
  incidents: () => req<Incident[]>("/incidents"),
  incident: (id: string) => req<{ incident: Incident; exposures: Exposure[]; runs: Run[] }>(`/incidents/${encodeURIComponent(id)}`),
  runs: () => req<Run[]>("/runs"),
  run: (id: string) => req<{ run: Run; events: RunEvent[] }>(`/runs/${id}`),
  openPr: (id: string) => req<{ url: string }>(`/runs/${id}/pr`, { method: "POST" }),
  stopPreview: (id: string) => req<{ ok: true }>(`/runs/${id}/preview/stop`, { method: "POST" }),
};
