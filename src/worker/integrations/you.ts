import { requireKey, type AppEnv } from "../env";

export interface WebResult {
  url: string;
  title: string;
  description: string;
  snippets: string[];
  highlights: string[];
  pageAge: string | null;
}

/** Security research outlets that usually report package compromises before formal advisories. */
export const SECURITY_DOMAINS = [
  "socket.dev",
  "aikido.dev",
  "stepsecurity.io",
  "wiz.io",
  "snyk.io",
  "unit42.paloaltonetworks.com",
  "securitylabs.datadoghq.com",
  "blog.gitguardian.com",
  "thehackernews.com",
  "bleepingcomputer.com",
  "github.blog",
  "jfrog.com",
  "phylum.io",
  "checkmarx.com",
];

export async function search(
  env: AppEnv,
  query: string,
  opts: { freshness?: "day" | "week" | "month" | "year"; count?: number; boostDomains?: string[]; highlights?: boolean } = {},
): Promise<WebResult[]> {
  const key = requireKey(env, "YOU_API_KEY");
  const res = await fetch("https://ydc-index.io/v1/search", {
    method: "POST",
    headers: { "X-API-Key": key, "Content-Type": "application/json" },
    body: JSON.stringify({
      query,
      count: opts.count ?? 10,
      ...(opts.freshness ? { freshness: opts.freshness } : {}),
      ...(opts.boostDomains ? { boost_domains: opts.boostDomains } : {}),
      ...(opts.highlights ? { extraction: { extraction_mode: "highlights" } } : {}),
    }),
  });
  if (!res.ok) throw new Error(`You.com search ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = (await res.json()) as {
    results?: { web?: { url?: string; title?: string; description?: string; snippets?: string[]; page_age?: string; contents?: { highlights?: (string | { text?: string })[] } }[] };
  };
  return (data.results?.web ?? [])
    .filter((r) => r.url)
    .map((r) => ({
      url: r.url!,
      title: r.title ?? r.url!,
      description: r.description ?? "",
      snippets: r.snippets ?? [],
      highlights: (r.contents?.highlights ?? []).map((h) => (typeof h === "string" ? h : (h.text ?? ""))).filter(Boolean),
      pageAge: r.page_age ?? null,
    }));
}
