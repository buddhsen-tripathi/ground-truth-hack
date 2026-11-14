import type { AppEnv } from "../env";

/**
 * OpenCrawl (https://getopencrawl.com): shared, searchable history of your coding agents' sessions plus a message board.
 * Called from the Worker over MCP (stateless Streamable HTTP) with an agent access token from `opencrawl token create`,
 * so the token never enters a sandbox from here. Every call is best effort: a board or search outage never fails a run.
 */

const DEFAULT_API = "https://app.getopencrawl.com";

export const opencrawlEnabled = (env: AppEnv) => !!env.OPENCRAWL_TOKEN;
export const opencrawlApi = (env: AppEnv) => (env.OPENCRAWL_API_URL || DEFAULT_API).replace(/\/$/, "");

let seq = 0;

async function rpc<T>(env: AppEnv, method: string, params: unknown): Promise<T> {
  const res = await fetch(`${opencrawlApi(env)}/mcp`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.OPENCRAWL_TOKEN}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2025-06-18",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++seq, method, params }),
  });
  if (!res.ok) throw new Error(`OpenCrawl ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const text = await res.text();
  // Streamable HTTP may answer as an SSE stream; the JSON-RPC response is in a data line.
  const body = res.headers.get("content-type")?.includes("event-stream")
    ? text
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trim())
        .reverse()
        .find((l) => l.includes('"result"') || l.includes('"error"')) ?? "{}"
    : text;
  const msg = JSON.parse(body) as { result?: T; error?: { message: string } };
  if (msg.error) throw new Error(`OpenCrawl: ${msg.error.message}`);
  return msg.result as T;
}

async function callTool<T = unknown>(env: AppEnv, name: string, args: Record<string, unknown>): Promise<T> {
  const result = await rpc<{ content?: { type: string; text?: string }[]; isError?: boolean }>(env, "tools/call", { name, arguments: args });
  const first = result.content?.find((c) => c.type === "text")?.text ?? "";
  if (result.isError) throw new Error(`OpenCrawl ${name}: ${first.slice(0, 200)}`);
  try {
    return JSON.parse(first) as T;
  } catch {
    return first as T;
  }
}

export interface HistoryHit {
  title: string;
  text: string;
  source: string;
}

/** Lexical search over the team's captured agent sessions and connected sources. */
export async function searchHistory(env: AppEnv, query: string, limit = 5): Promise<HistoryHit[]> {
  const data = await callTool<{ results?: Record<string, unknown>[]; data?: { results?: Record<string, unknown>[] } }>(env, "search", {
    query,
    limit,
    excerptChars: 500,
    select: ["title", "text", "provenance"],
  });
  const rows = (typeof data === "object" && data ? (data.results ?? data.data?.results) : null) ?? [];
  return rows.slice(0, limit).map((r) => {
    const prov = (r.provenance ?? {}) as Record<string, unknown>;
    return {
      title: String(r.title ?? prov.title ?? "Session"),
      text: String(r.text ?? r.excerpt ?? "").slice(0, 800),
      source: String(prov.harness ?? prov.source ?? prov.kind ?? "opencrawl"),
    };
  });
}

export interface BoardPost {
  id: string;
  topic: string;
  text: string;
}

export interface BoardMessage {
  name: string;
  topic: string;
  text: string;
  at?: string;
}

let workspace: string | null = null;

/** The workspace id board_sync needs; board_topics returns it. */
async function boardWorkspace(env: AppEnv): Promise<string> {
  if (workspace) return workspace;
  const data = await callTool<{ workspace?: string }>(env, "board_topics", {});
  if (!data || typeof data !== "object" || !data.workspace) throw new Error("OpenCrawl board returned no workspace");
  workspace = data.workspace;
  return workspace;
}

/** Posts (at most three, 512 chars each) and reads recent messages on the given topics, from the start of their history. */
export async function boardSync(env: AppEnv, agent: string, topics: string[], posts: BoardPost[] = []): Promise<BoardMessage[]> {
  const ws = await boardWorkspace(env);
  const data = await callTool<{ messages?: Record<string, unknown>[] }>(env, "board_sync", {
    workspace: ws,
    agent: agent.slice(0, 80),
    topics: topics.slice(0, 8).map((t) => t.slice(0, 80)),
    after: 0,
    posts: posts.slice(0, 3).map((p) => ({ id: p.id.slice(0, 80), topic: p.topic.slice(0, 80), text: p.text.slice(0, 512) })),
  });
  const messages = (typeof data === "object" && data ? data.messages : null) ?? [];
  return messages.map((m) => ({
    name: String(m.name ?? m.agent ?? "agent"),
    topic: String(m.topic ?? ""),
    text: String(m.preview ?? m.text ?? ""),
    at: m.at ? String(m.at) : m.timestamp ? String(m.timestamp) : undefined,
  }));
}

/** Board topics Firebreak uses: one per package, one per repo. */
export const packageTopic = (ecosystem: string, name: string) => `firebreak/${ecosystem.toLowerCase()}/${name}`;
export const repoTopic = (fullName: string) => `firebreak/repo/${fullName}`;
