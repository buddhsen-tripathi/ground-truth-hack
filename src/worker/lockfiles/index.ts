import { parse as parseYaml } from "yaml";
import type { ActionRef, Manager } from "@shared/types";

export interface ResolvedDep {
  name: string;
  version: string;
  direct: boolean;
}

export const LOCKFILE_NAMES: Record<string, Manager> = {
  "package-lock.json": "npm",
  "npm-shrinkwrap.json": "npm",
  "pnpm-lock.yaml": "pnpm",
  "yarn.lock": "yarn",
  "bun.lock": "bun",
  "bun.lockb": "bun",
};

export function managerFor(path: string): Manager | null {
  const base = path.split("/").pop() ?? "";
  return LOCKFILE_NAMES[base] ?? null;
}

/** Splits "name@version" (scoped names keep their leading "@"). */
export function splitSpec(spec: string): { name: string; rest: string } | null {
  const at = spec.lastIndexOf("@");
  if (at <= 0) return null;
  return { name: spec.slice(0, at), rest: spec.slice(at + 1) };
}

const SEMVERISH = /^\d+\.\d+\.\d+([-+][0-9A-Za-z.-]+)?$/;

function dedupe(deps: ResolvedDep[]): ResolvedDep[] {
  const map = new Map<string, ResolvedDep>();
  for (const d of deps) {
    const key = `${d.name}@${d.version}`;
    const prev = map.get(key);
    map.set(key, prev ? { ...prev, direct: prev.direct || d.direct } : d);
  }
  return [...map.values()];
}

/** Direct dependency names from a package.json (all dependency kinds). */
export function directNames(packageJson: string | null): Set<string> {
  const names = new Set<string>();
  if (!packageJson) return names;
  try {
    const pkg = JSON.parse(packageJson) as Record<string, Record<string, string> | undefined>;
    for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
      for (const name of Object.keys(pkg[field] ?? {})) names.add(name);
    }
  } catch {
    // An unparsable package.json only loses the direct/transitive distinction.
  }
  return names;
}

// ── npm ─────────────────────────────────────────────────────────────────────────────────────────────

interface NpmV1Dep {
  version?: string;
  dependencies?: Record<string, NpmV1Dep>;
}

export function parseNpmLock(text: string, direct: Set<string>): ResolvedDep[] {
  const lock = JSON.parse(text) as {
    packages?: Record<string, { version?: string; name?: string; link?: boolean }>;
    dependencies?: Record<string, NpmV1Dep>;
  };
  const out: ResolvedDep[] = [];
  if (lock.packages) {
    for (const [key, entry] of Object.entries(lock.packages)) {
      if (!key || entry.link || !entry.version) continue;
      const idx = key.lastIndexOf("node_modules/");
      if (idx === -1) continue; // workspace folders
      const name = entry.name ?? key.slice(idx + "node_modules/".length);
      const topLevel = key === `node_modules/${name}`;
      out.push({ name, version: entry.version, direct: topLevel && direct.has(name) });
    }
  } else if (lock.dependencies) {
    const walk = (deps: Record<string, NpmV1Dep>, depth: number) => {
      for (const [name, dep] of Object.entries(deps)) {
        if (dep.version && SEMVERISH.test(dep.version)) out.push({ name, version: dep.version, direct: depth === 0 && direct.has(name) });
        if (dep.dependencies) walk(dep.dependencies, depth + 1);
      }
    };
    walk(lock.dependencies, 0);
  }
  return dedupe(out);
}

// ── pnpm ────────────────────────────────────────────────────────────────────────────────────────────

/** "/name@1.0.0(peer@2)" | "name@1.0.0" | "/name/1.0.0" (v5) → { name, version }. */
export function parsePnpmKey(key: string): { name: string; version: string } | null {
  let k = key.startsWith("/") ? key.slice(1) : key;
  const paren = k.indexOf("(");
  if (paren !== -1) k = k.slice(0, paren);
  // v5: name/1.0.0 with an optional peer suffix (name/1.0.0_peer@2).
  const v5 = /^(.+)\/(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)(?:_.*)?$/.exec(k);
  if (v5?.[1] && v5[2]) return { name: v5[1], version: v5[2] };
  const spec = splitSpec(k);
  if (spec && SEMVERISH.test(spec.rest)) return { name: spec.name, version: spec.rest };
  return null;
}

export function parsePnpmLock(text: string, direct: Set<string>): ResolvedDep[] {
  const lock = parseYaml(text) as {
    importers?: Record<string, Record<string, Record<string, unknown>>>;
    packages?: Record<string, unknown>;
    snapshots?: Record<string, unknown>;
  };
  const directSet = new Set(direct);
  for (const importer of Object.values(lock.importers ?? {})) {
    for (const field of ["dependencies", "devDependencies", "optionalDependencies"]) {
      for (const name of Object.keys(importer?.[field] ?? {})) directSet.add(name);
    }
  }
  const out: ResolvedDep[] = [];
  for (const key of [...Object.keys(lock.packages ?? {}), ...Object.keys(lock.snapshots ?? {})]) {
    const parsed = parsePnpmKey(key);
    if (parsed) out.push({ ...parsed, direct: directSet.has(parsed.name) });
  }
  return dedupe(out);
}

// ── yarn (classic and berry) ────────────────────────────────────────────────────────────────────────

export function parseYarnLock(text: string, direct: Set<string>): ResolvedDep[] {
  const out: ResolvedDep[] = [];
  let names: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.startsWith("#")) continue;
    if (!line.startsWith(" ") && line.endsWith(":")) {
      // Header: `"a@^1", a@^2:` or `"a@npm:^1, a@npm:^2":`
      names = line
        .slice(0, -1)
        .split(",")
        .map((s) => s.trim().replace(/^"|"$/g, ""))
        .map((s) => splitSpec(s)?.name)
        .filter((n): n is string => !!n && n !== "__metadata");
      continue;
    }
    const m = /^ {2}version:? "?([^"\s]+)"?$/.exec(line);
    if (m && names.length && m[1] && SEMVERISH.test(m[1]) && !m[1].includes("use.local")) {
      for (const name of new Set(names)) out.push({ name, version: m[1], direct: direct.has(name) });
      names = [];
    }
  }
  return dedupe(out);
}

// ── bun (text lockfile) ─────────────────────────────────────────────────────────────────────────────

export function parseBunLock(text: string, direct: Set<string>): ResolvedDep[] {
  // bun.lock is JSON with trailing commas.
  const json = text.replace(/,(\s*[}\]])/g, "$1");
  const lock = JSON.parse(json) as {
    workspaces?: Record<string, Record<string, Record<string, string> | string | undefined>>;
    packages?: Record<string, unknown[]>;
  };
  const directSet = new Set(direct);
  for (const ws of Object.values(lock.workspaces ?? {})) {
    for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
      const deps = ws[field];
      if (deps && typeof deps === "object") for (const name of Object.keys(deps)) directSet.add(name);
    }
  }
  const out: ResolvedDep[] = [];
  for (const [key, entry] of Object.entries(lock.packages ?? {})) {
    const spec = typeof entry?.[0] === "string" ? splitSpec(entry[0]) : null;
    if (!spec || !SEMVERISH.test(spec.rest)) continue;
    // Nested keys look like "parent/child"; only top-level keys can be direct.
    const topLevel = key === spec.name;
    out.push({ name: spec.name, version: spec.rest, direct: topLevel && directSet.has(spec.name) });
  }
  return dedupe(out);
}

export function parseLockfile(manager: Manager, path: string, text: string, packageJson: string | null): ResolvedDep[] {
  const direct = directNames(packageJson);
  switch (manager) {
    case "npm":
      return parseNpmLock(text, direct);
    case "pnpm":
      return parsePnpmLock(text, direct);
    case "yarn":
      return parseYarnLock(text, direct);
    case "bun":
      if (path.endsWith(".lockb")) throw new Error("Binary bun.lockb can't be read. Run `bun install --save-text-lockfile` to add bun.lock.");
      return parseBunLock(text, direct);
  }
}

// ── GitHub Actions ──────────────────────────────────────────────────────────────────────────────────

export function parseWorkflow(workflow: string, text: string): { actions: ActionRef[]; secrets: string[] } {
  const actions: ActionRef[] = [];
  for (const m of text.matchAll(/^\s*-?\s*uses:\s*["']?([^\s"'#]+)["']?/gm)) {
    const value = m[1] ?? "";
    if (value.startsWith("./") || value.startsWith("docker://")) continue;
    const at = value.lastIndexOf("@");
    if (at <= 0) continue;
    const uses = value.slice(0, at);
    const ref = value.slice(at + 1);
    actions.push({ workflow, uses, ref, pinned: /^[0-9a-f]{40}$/.test(ref) });
  }
  const secrets = [...new Set([...text.matchAll(/secrets\.([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1] ?? ""))].filter(Boolean);
  return { actions, secrets };
}
