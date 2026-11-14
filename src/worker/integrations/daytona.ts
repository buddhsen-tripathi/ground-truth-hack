import { requireKey, type AppEnv } from "../env";

interface SandboxInfo {
  id: string;
  state?: string;
  errorReason?: string;
  toolboxProxyUrl: string;
}

const b64 = (s: string) => {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
};

/** Thin REST client for one Daytona sandbox (the Node SDK isn't used: the Worker runtime calls the API directly). */
export class Sandbox {
  private constructor(
    private env: AppEnv,
    public id: string,
    private toolbox: string,
  ) {}

  private static headers(env: AppEnv) {
    return { Authorization: `Bearer ${requireKey(env, "DAYTONA_API_KEY")}`, "Content-Type": "application/json" };
  }

  private static async api<T>(env: AppEnv, path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(`${env.DAYTONA_API_URL}${path}`, { ...init, headers: { ...Sandbox.headers(env), ...init.headers } });
    if (!res.ok) throw new Error(`Daytona ${init.method ?? "GET"} ${path} ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const text = await res.text();
    return (text ? JSON.parse(text) : {}) as T;
  }

  static async create(env: AppEnv, labels: Record<string, string>): Promise<Sandbox> {
    const info = await Sandbox.api<SandboxInfo>(env, "/sandbox", {
      method: "POST",
      body: JSON.stringify({ snapshot: env.DAYTONA_SNAPSHOT || undefined, labels: { app: "firebreak", ...labels }, autoStopInterval: 30, autoDeleteInterval: 60 }),
    });
    return new Sandbox(env, info.id, info.toolboxProxyUrl);
  }

  static async attach(env: AppEnv, id: string): Promise<Sandbox> {
    const info = await Sandbox.api<SandboxInfo>(env, `/sandbox/${id}`);
    const sb = new Sandbox(env, info.id, info.toolboxProxyUrl);
    if (info.state !== "started") {
      await Sandbox.api(env, `/sandbox/${id}/start`, { method: "POST" });
      await sb.waitStarted();
    }
    return sb;
  }

  async waitStarted(timeoutMs = 180_000): Promise<void> {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      const info = await Sandbox.api<SandboxInfo>(this.env, `/sandbox/${this.id}`);
      if (info.toolboxProxyUrl) this.toolbox = info.toolboxProxyUrl;
      if (info.state === "started") return;
      if (info.state === "error" || info.state === "build_failed") throw new Error(`Sandbox failed to start: ${info.errorReason ?? info.state}`);
      await new Promise((r) => setTimeout(r, 2000));
    }
    throw new Error("Sandbox did not start within 3 minutes");
  }

  /** A URL for one port with the access token embedded: no headers needed, expires, can't reach other ports. */
  async signedPreviewUrl(port: number, expiresInSeconds: number): Promise<{ url: string; token: string }> {
    return Sandbox.api<{ url: string; token: string }>(this.env, `/sandbox/${this.id}/ports/${port}/signed-preview-url?expiresInSeconds=${expiresInSeconds}`);
  }

  async delete(): Promise<void> {
    await Sandbox.api(this.env, `/sandbox/${this.id}`, { method: "DELETE" }).catch(() => undefined);
  }

  private async tb<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(`${this.toolbox.replace(/\/$/, "")}/${this.id}${path}`, { ...init, headers: { ...Sandbox.headers(this.env), ...init.headers } });
    const text = await res.text();
    if (!res.ok) throw new Error(`Daytona toolbox ${path} ${res.status}: ${text.slice(0, 300)}`);
    try {
      return JSON.parse(text) as T;
    } catch {
      return text as T;
    }
  }

  /** Runs a short shell command and waits for it. */
  async exec(command: string, opts: { cwd?: string; timeoutSec?: number } = {}): Promise<{ exitCode: number; output: string }> {
    const r = await this.tb<{ exitCode?: number; result?: string }>("/process/execute", {
      method: "POST",
      body: JSON.stringify({ command: `sh -c "echo ${b64(command)} | base64 -d | sh"`, cwd: opts.cwd, timeout: opts.timeoutSec ?? 60 }),
    });
    return { exitCode: r.exitCode ?? 0, output: r.result ?? "" };
  }

  async clone(url: string, path: string, opts: { branch?: string; token?: string } = {}): Promise<void> {
    await this.tb("/git/clone", {
      method: "POST",
      body: JSON.stringify({ url, path, branch: opts.branch, depth: 1, ...(opts.token ? { username: "x-access-token", password: opts.token } : {}) }),
    });
  }

  async writeFile(path: string, content: string): Promise<void> {
    const data = b64(content);
    const chunk = 60_000;
    await this.exec(`: > '${path}.b64'`);
    for (let i = 0; i < data.length; i += chunk) await this.exec(`printf '%s' '${data.slice(i, i + chunk)}' >> '${path}.b64'`);
    const r = await this.exec(`base64 -d '${path}.b64' > '${path}' && rm '${path}.b64'`);
    if (r.exitCode !== 0) throw new Error(`Could not write ${path}: ${r.output}`);
  }

  /** Exact file contents (base64 round trip, so trailing newlines survive). */
  async readFile(path: string): Promise<string | null> {
    const r = await this.exec(`base64 -w0 '${path}'`, { timeoutSec: 60 });
    if (r.exitCode !== 0) return null;
    const bin = atob(r.output.replace(/\s+/g, ""));
    return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
  }

  // Sessions keep shell state (PATH, cwd) between commands and let long commands stream their logs.
  async createSession(sessionId: string): Promise<void> {
    await this.tb("/process/session", { method: "POST", body: JSON.stringify({ sessionId }) });
  }

  async startCommand(sessionId: string, command: string): Promise<string> {
    const r = await this.tb<{ cmdId: string }>(`/process/session/${sessionId}/exec`, {
      method: "POST",
      body: JSON.stringify({ command, runAsync: true, async: true }),
    });
    return r.cmdId;
  }

  async commandStatus(sessionId: string, cmdId: string): Promise<number | null> {
    const r = await this.tb<{ exitCode?: number | null }>(`/process/session/${sessionId}/command/${cmdId}`);
    return typeof r.exitCode === "number" ? r.exitCode : null;
  }

  async commandLogs(sessionId: string, cmdId: string): Promise<string> {
    const r = await this.tb<{ output?: string; stdout?: string; stderr?: string } | string>(`/process/session/${sessionId}/command/${cmdId}/logs`);
    if (typeof r === "string") return r;
    return r.output ?? `${r.stdout ?? ""}${r.stderr ?? ""}`;
  }
}
