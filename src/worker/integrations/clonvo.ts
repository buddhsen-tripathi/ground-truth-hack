import { requireKey, type AppEnv } from "../env";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** One chat completion through the Clonvo gateway (OpenAI-compatible). */
export async function chat(env: AppEnv, model: string, messages: ChatMessage[], opts: { maxTokens?: number } = {}): Promise<string> {
  const key = requireKey(env, "CLONVO_API_KEY");
  const res = await fetch(`${env.CLONVO_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages, max_tokens: opts.maxTokens ?? 4000, temperature: 0 }),
  });
  if (!res.ok) throw new Error(`Clonvo ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = (await res.json()) as { choices?: { message?: { content?: string | null } }[] };
  return data.choices?.[0]?.message?.content ?? "";
}

/** Pulls the first JSON object out of a model reply (tolerates ```json fences and prose around it). */
export function parseJsonReply<T>(text: string): T {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const body = fenced?.[1] ?? text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("Model reply had no JSON object");
  return JSON.parse(body.slice(start, end + 1)) as T;
}
