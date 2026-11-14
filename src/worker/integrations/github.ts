import type { CiRun } from "@shared/types";
import { requireKey, type AppEnv } from "../env";

const API = "https://api.github.com";

export class GitHubError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

async function gh<T>(env: AppEnv, path: string, init: RequestInit & { raw?: boolean } = {}): Promise<T> {
  const token = requireKey(env, "GITHUB_TOKEN");
  const req = () => fetch(`${API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: init.raw ? "application/vnd.github.raw+json" : "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "firebreak",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...init.headers,
    },
  });
  let res: Response;
  try {
    res = await req();
  } catch (err) {
    // Reads are safe to retry once when the connection drops mid-request; writes are not (a PR could be created twice).
    if (init.method && init.method !== "GET") throw err;
    await new Promise((r) => setTimeout(r, 400));
    res = await req();
  }
  if (!res.ok) {
    const body = await res.text();
    let message = body;
    try {
      message = (JSON.parse(body) as { message?: string }).message ?? body;
    } catch {
      // keep the raw body
    }
    if (res.status === 403 && init.method && init.method !== "GET" && /not accessible by (personal access|integration)/i.test(message)) {
      throw new GitHubError(
        403,
        "The GitHub token can read this repo but can't write to it. Give it Contents and Pull requests: Read and write on this repo, then open the PR again. The verified fix is kept, so nothing reruns.",
      );
    }
    throw new GitHubError(res.status, `GitHub ${res.status} on ${path}: ${message.slice(0, 300)}`);
  }
  return (init.raw ? await res.text() : await res.json()) as T;
}

const enc = (fullName: string) => fullName.split("/").map(encodeURIComponent).join("/");

export async function getRepo(env: AppEnv, fullName: string) {
  return gh<{ full_name: string; default_branch: string; private: boolean; html_url: string }>(env, `/repos/${enc(fullName)}`);
}

export async function getBranchSha(env: AppEnv, fullName: string, branch: string): Promise<string> {
  const ref = await gh<{ object: { sha: string } }>(env, `/repos/${enc(fullName)}/git/ref/heads/${encodeURIComponent(branch)}`);
  return ref.object.sha;
}

export async function getTree(env: AppEnv, fullName: string, sha: string): Promise<{ path: string; type: string; size?: number }[]> {
  const tree = await gh<{ tree: { path: string; type: string; size?: number }[]; truncated: boolean }>(env, `/repos/${enc(fullName)}/git/trees/${sha}?recursive=1`);
  return tree.tree;
}

export async function getFile(env: AppEnv, fullName: string, path: string, ref: string): Promise<string | null> {
  try {
    return await gh<string>(env, `/repos/${enc(fullName)}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(ref)}`, { raw: true });
  } catch (e) {
    if (e instanceof GitHubError && e.status === 404) return null;
    throw e;
  }
}

/** Workflow runs created since `since` (ISO). Used to tell whether CI could have installed a bad version. */
export async function listRunsSince(env: AppEnv, fullName: string, since: string): Promise<CiRun[]> {
  const day = since.slice(0, 10);
  const data = await gh<{ workflow_runs: { id: number; name: string; html_url: string; created_at: string; conclusion: string | null }[] }>(
    env,
    `/repos/${enc(fullName)}/actions/runs?per_page=50&created=${encodeURIComponent(`>=${day}`)}`,
  );
  return data.workflow_runs
    .filter((r) => r.created_at >= since)
    .map((r) => ({ id: r.id, name: r.name, url: r.html_url, createdAt: r.created_at, conclusion: r.conclusion }));
}

/** Commits `files` on a new branch off `base` and opens a pull request. Returns the PR URL. */
export async function openPullRequest(
  env: AppEnv,
  args: { fullName: string; base: string; branch: string; title: string; body: string; message: string; files: { path: string; content: string }[] },
): Promise<string> {
  const repo = enc(args.fullName);
  const baseSha = await getBranchSha(env, args.fullName, args.base);
  const baseCommit = await gh<{ tree: { sha: string } }>(env, `/repos/${repo}/git/commits/${baseSha}`);
  const tree = await Promise.all(
    args.files.map(async (f) => {
      const blob = await gh<{ sha: string }>(env, `/repos/${repo}/git/blobs`, {
        method: "POST",
        body: JSON.stringify({ content: f.content, encoding: "utf-8" }),
      });
      return { path: f.path, mode: "100644", type: "blob", sha: blob.sha };
    }),
  );
  const newTree = await gh<{ sha: string }>(env, `/repos/${repo}/git/trees`, {
    method: "POST",
    body: JSON.stringify({ base_tree: baseCommit.tree.sha, tree }),
  });
  const commit = await gh<{ sha: string }>(env, `/repos/${repo}/git/commits`, {
    method: "POST",
    body: JSON.stringify({ message: args.message, tree: newTree.sha, parents: [baseSha] }),
  });
  await gh(env, `/repos/${repo}/git/refs`, { method: "POST", body: JSON.stringify({ ref: `refs/heads/${args.branch}`, sha: commit.sha }) });
  const pr = await gh<{ html_url: string }>(env, `/repos/${repo}/pulls`, {
    method: "POST",
    body: JSON.stringify({ title: args.title, head: args.branch, base: args.base, body: args.body }),
  });
  return pr.html_url;
}
