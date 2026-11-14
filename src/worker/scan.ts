import type { ActionRef, LockfileSummary, Repo } from "@shared/types";
import { now, shortId, type AppEnv } from "./env";
import { getBranchSha, getFile, getRepo, getTree } from "./integrations/github";
import { managerFor, parseLockfile, parseWorkflow, type ResolvedDep } from "./lockfiles";
import { getRepoById } from "./db";

const MAX_LOCKFILES = 12;

/** Adds a repo (or refreshes it) and returns its id. Throws if GitHub can't see it. */
export async function addRepo(env: AppEnv, fullNameInput: string): Promise<string> {
  const fullName = fullNameInput
    .trim()
    .replace(/^https?:\/\/github\.com\//, "")
    .replace(/\.git$/, "")
    .replace(/\/$/, "");
  if (!/^[\w.-]+\/[\w.-]+$/.test(fullName)) throw new Error("Use the owner/name form, e.g. acme/web");
  const gh = await getRepo(env, fullName);
  const existing = await env.DB.prepare("SELECT id FROM repos WHERE full_name = ?").bind(gh.full_name).first<{ id: string }>();
  if (existing) return existing.id;
  const id = shortId();
  await env.DB.prepare("INSERT INTO repos (id, full_name, default_branch, private) VALUES (?, ?, ?, ?)")
    .bind(id, gh.full_name, gh.default_branch, gh.private ? 1 : 0)
    .run();
  return id;
}

/** Reads every lockfile and workflow on the default branch and replaces the repo's dependency rows. */
export async function scanRepo(env: AppEnv, repoId: string): Promise<Repo> {
  const repo = await getRepoById(env, repoId);
  if (!repo) throw new Error("Repo not found");
  try {
    const sha = await getBranchSha(env, repo.fullName, repo.defaultBranch);
    const tree = await getTree(env, repo.fullName, sha);
    const files = tree.filter((t) => t.type === "blob" && !t.path.includes("node_modules/"));
    const lockPaths = files.map((f) => f.path).filter((p) => managerFor(p)).slice(0, MAX_LOCKFILES);
    const workflowPaths = files.map((f) => f.path).filter((p) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(p));

    const lockfiles: LockfileSummary[] = [];
    const rows: { name: string; version: string; lockfile: string; direct: boolean; ecosystem: string }[] = [];
    for (const path of lockPaths) {
      const manager = managerFor(path)!;
      const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/") + 1) : "";
      try {
        if (path.endsWith(".lockb")) {
          // bun.lockb is binary; a text bun.lock next to it is read instead.
          if (lockPaths.includes(`${dir}bun.lock`)) continue;
          throw new Error("Binary bun.lockb can't be read. Run `bun install --save-text-lockfile` to add bun.lock.");
        }
        const [text, pkg] = await Promise.all([getFile(env, repo.fullName, path, sha), getFile(env, repo.fullName, `${dir}package.json`, sha)]);
        if (text === null) throw new Error("File not readable");
        const deps: ResolvedDep[] = parseLockfile(manager, path, text, pkg);
        lockfiles.push({ path, manager, packages: deps.length });
        for (const d of deps) rows.push({ ...d, lockfile: path, ecosystem: "npm" });
      } catch (e) {
        lockfiles.push({ path, manager, packages: 0, error: (e as Error).message });
      }
    }

    const actions: ActionRef[] = [];
    const secrets = new Set<string>();
    for (const path of workflowPaths) {
      const text = await getFile(env, repo.fullName, path, sha);
      if (!text) continue;
      const parsed = parseWorkflow(path.split("/").pop()!, text);
      actions.push(...parsed.actions);
      for (const s of parsed.secrets) secrets.add(s);
    }
    for (const a of actions) rows.push({ name: a.uses, version: a.ref.replace(/^v/, ""), lockfile: `.github/workflows/${a.workflow}`, direct: true, ecosystem: "GitHub Actions" });

    const stmts = [env.DB.prepare("DELETE FROM deps WHERE repo_id = ?").bind(repoId)];
    const insert = env.DB.prepare("INSERT OR IGNORE INTO deps (repo_id, ecosystem, name, version, lockfile, direct) VALUES (?, ?, ?, ?, ?, ?)");
    for (const r of rows) stmts.push(insert.bind(repoId, r.ecosystem, r.name, r.version, r.lockfile, r.direct ? 1 : 0));
    stmts.push(
      env.DB.prepare("UPDATE repos SET head_sha = ?, lockfiles = ?, actions = ?, secrets = ?, dep_count = ?, scan_error = NULL, scanned_at = ? WHERE id = ?").bind(
        sha,
        JSON.stringify(lockfiles),
        JSON.stringify(actions),
        JSON.stringify([...secrets]),
        rows.length,
        now(),
        repoId,
      ),
    );
    for (let i = 0; i < stmts.length; i += 400) await env.DB.batch(stmts.slice(i, i + 400));
  } catch (e) {
    await env.DB.prepare("UPDATE repos SET scan_error = ?, scanned_at = ? WHERE id = ?").bind((e as Error).message, now(), repoId).run();
  }
  return (await getRepoById(env, repoId))!;
}
