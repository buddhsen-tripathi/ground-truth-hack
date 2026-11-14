// Small Node scripts the fix loop runs inside the sandbox. Arguments arrive as one JSON file so nothing needs shell quoting.

/**
 * Sets the dependency spec in every package.json under the lockfile's directory that declares the package (workspaces declare
 * it in member packages, not the root). Specs using a pnpm catalog are reported back so the caller edits the catalog instead.
 * When nothing declares it (or the plan is an override) it writes the override, except pnpm >= 10 overrides, which the caller
 * writes to pnpm-workspace.yaml. Keeps each file's indentation. Prints a JSON report.
 */
export const PATCH_PACKAGE_JSON = String.raw`
const fs = require("fs");
const path = require("path");
const a = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const spec = a.exact ? a.to : "^" + a.to;
const report = { changed: [], catalogs: [], overrideNeeded: false };
const files = [];
(function walk(dir, depth) {
  if (depth > 6 || files.length > 300) return;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.isDirectory()) { if (e.name !== "node_modules" && !e.name.startsWith(".")) walk(path.join(dir, e.name), depth + 1); }
    else if (e.name === "package.json") files.push(path.join(dir, e.name));
  }
})(a.root, 0);
function load(file) {
  const raw = fs.readFileSync(file, "utf8");
  return { raw, pkg: JSON.parse(raw), indent: (/^([ 	]+)"/m.exec(raw) || [, "  "])[1] };
}
function save(file, f) { fs.writeFileSync(file, JSON.stringify(f.pkg, null, f.indent) + (f.raw.endsWith("\n") ? "\n" : "")); }
const rel = (file) => path.relative(a.root, file) || "package.json";
if (a.strategy !== "override") {
  for (const file of files) {
    let f;
    try { f = load(file); } catch { continue; }
    let touched = false;
    for (const field of ["dependencies", "devDependencies", "optionalDependencies"]) {
      const cur = f.pkg[field] && f.pkg[field][a.name];
      if (cur === undefined) continue;
      if (/^(workspace|link|file|npm):/.test(cur)) continue;
      if (cur.startsWith("catalog:")) { report.catalogs.push({ file: rel(file), catalog: cur.slice(8) || "default" }); continue; }
      f.pkg[field][a.name] = spec; touched = true;
      report.changed.push(rel(file) + " " + field + "." + a.name + " = " + spec);
    }
    if (touched) save(file, f);
  }
}
if (!report.changed.length && !report.catalogs.length) {
  const file = path.join(a.root, "package.json");
  const f = load(file);
  if (a.manager === "pnpm" && a.pnpmMajor >= 10) report.overrideNeeded = true;
  else if (a.manager === "pnpm") { f.pkg.pnpm = f.pkg.pnpm || {}; f.pkg.pnpm.overrides = f.pkg.pnpm.overrides || {}; f.pkg.pnpm.overrides[a.name] = a.to; report.changed.push("package.json pnpm.overrides." + a.name + " = " + a.to); }
  else if (a.manager === "yarn") { f.pkg.resolutions = f.pkg.resolutions || {}; f.pkg.resolutions[a.name] = a.to; report.changed.push("package.json resolutions." + a.name + " = " + a.to); }
  else { f.pkg.overrides = f.pkg.overrides || {}; f.pkg.overrides[a.name] = a.to; report.changed.push("package.json overrides." + a.name + " = " + a.to); }
  if (!report.overrideNeeded) save(file, f);
}
console.log(JSON.stringify(report));
`;

/** Applies model-proposed find/replace edits. Each `find` must match exactly once. Prints a JSON report. */
export const APPLY_EDITS = String.raw`
const fs = require("fs");
const path = require("path");
const a = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const report = [];
for (const e of a.edits) {
  const file = path.join(a.root, e.path);
  if (!file.startsWith(a.root) || file.includes("node_modules")) { report.push({ path: e.path, ok: false, error: "outside repo" }); continue; }
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch { report.push({ path: e.path, ok: false, error: "file not found" }); continue; }
  const count = text.split(e.find).length - 1;
  if (count !== 1) { report.push({ path: e.path, ok: false, error: count === 0 ? "find text not found" : "find text matched " + count + " times" }); continue; }
  fs.writeFileSync(file, text.replace(e.find, () => e.replace));
  report.push({ path: e.path, ok: true });
}
console.log(JSON.stringify(report));
`;

/**
 * Python version of PATCH_PACKAGE_JSON. For uv projects it edits requirement strings in every pyproject.toml under the
 * project only when their specifier excludes the target (otherwise `uv lock -P name==to` pins it), and adds packages
 * nothing declares to [tool.uv] constraint-dependencies. For pinned requirements files it rewrites the `==` pins, or
 * reports the .in file to recompile from when the file is pip-compile output. Prints a JSON report.
 */
export const PATCH_PYTHON = String.raw`
import json, os, re, sys
a = json.load(open(sys.argv[1]))
def norm(n): return re.sub(r"[-_.]+", "-", n).lower()
try:
    from packaging.specifiers import SpecifierSet
except Exception:
    try:
        from pip._vendor.packaging.specifiers import SpecifierSet
    except Exception:
        SpecifierSet = None
def allows(spec, version):
    if not spec.strip(): return True
    if SpecifierSet is None: return False
    try: return SpecifierSet(spec.replace(" ", "")).contains(version, prereleases=True)
    except Exception: return False
report = {"changed": [], "compile": None, "error": None}
root = a["root"]
pkgs = {norm(p["name"]): p for p in a["packages"]}
rel = lambda f: os.path.relpath(f, a["repo"])

if a["manager"] == "uv":
    files = []
    for d, dirs, fs in os.walk(root):
        dirs[:] = [x for x in dirs if not x.startswith(".") and x not in ("node_modules", "venv", "__pycache__")]
        if d[len(root):].count(os.sep) >= 4: dirs[:] = []
        if "pyproject.toml" in fs: files.append(os.path.join(d, "pyproject.toml"))
    declared = set()
    pat = re.compile(r"""(?P<pre>(?:^|[\[,])\s*)(?P<q>["'])(?P<name>[A-Za-z0-9][A-Za-z0-9._-]*)(?P<extras>\s*\[[^\]]*\])?(?P<spec>[^;"'\[\]]*)(?P<marker>;[^"']*)?(?P=q)""", re.M)
    for f in files:
        text = open(f).read()
        def sub(m):
            p = pkgs.get(norm(m.group("name")))
            if not p: return m.group(0)
            spec = m.group("spec").strip()
            if spec.startswith("@"): return m.group(0)
            declared.add(norm(m.group("name")))
            if allows(spec, p["to"]): return m.group(0)
            new = ("==" if p["exact"] else ">=") + p["to"]
            report["changed"].append(rel(f) + ": " + m.group("name") + " " + (spec or "(any)") + " -> " + new)
            return m.group("pre") + m.group("q") + m.group("name") + (m.group("extras") or "") + new + (m.group("marker") or "") + m.group("q")
        out = pat.sub(sub, text)
        if out != text: open(f, "w").write(out)
    need = [p for n, p in pkgs.items() if n not in declared]
    if need:
        f = os.path.join(root, "pyproject.toml")
        text = open(f).read()
        items = ['"' + p["name"] + ("==" if p["exact"] else ">=") + p["to"] + '"' for p in need]
        table = re.search(r"^\[tool\.uv\][ \t]*$", text, re.M)
        nxt = re.search(r"^\[", text[table.end():], re.M) if table else None
        end = table.end() + nxt.start() if nxt else len(text)
        key = re.search(r"^constraint-dependencies\s*=\s*\[", text[table.end():end], re.M) if table else None
        if key:
            at = table.end() + key.end()
            text = text[:at] + " " + ", ".join(items) + "," + text[at:]
        elif table:
            text = text[:table.end()] + "\nconstraint-dependencies = [" + ", ".join(items) + "]" + text[table.end():]
        else:
            text = text.rstrip("\n") + "\n\n[tool.uv]\nconstraint-dependencies = [" + ", ".join(items) + "]\n"
        open(f, "w").write(text)
        report["changed"].append(rel(f) + ": [tool.uv] constraint-dependencies += " + ", ".join(items))
else:
    req = a["file"]
    text = open(req).read()
    hashes = "--hash" in text
    infile = os.path.splitext(req)[0] + ".in"
    compiled = re.search(r"(uv pip compile|pip-compile)", text[:3000]) is not None
    if os.path.exists(infile) and (hashes or compiled):
        report["compile"] = {"in": infile, "hashes": hashes}
    elif hashes:
        report["error"] = rel(req) + " pins hashes but has no .in file to regenerate them from"
    else:
        lines = text.split("\n")
        for i, line in enumerate(lines):
            m = re.match(r"^(\s*)([A-Za-z0-9][A-Za-z0-9._-]*)(\s*\[[^\]]*\])?\s*===?\s*([^\s;#\\]+)(.*)$", line)
            if not m: continue
            p = pkgs.get(norm(m.group(2)))
            if not p: continue
            lines[i] = m.group(1) + m.group(2) + (m.group(3) or "") + "==" + p["to"] + m.group(5)
            report["changed"].append(rel(req) + ": " + m.group(2) + "==" + m.group(4) + " -> ==" + p["to"])
        open(req, "w").write("\n".join(lines))
print(json.dumps(report))
`;

/**
 * Reads `codex exec --json` events on stdin and prints one short JSON line per thing worth showing: each agent
 * message, command, file change, MCP or web call, errors and the final result. Command output and file contents stay
 * in the sandbox, so the Worker only polls a small log.
 */
export const CODEX_FILTER = String.raw`
const rl = require("readline").createInterface({ input: process.stdin, crlfDelay: Infinity });
const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const short = (s, n) => String(s == null ? "" : s).replace(/\s+/g, " ").trim().slice(0, n);
const describe = (input) => {
  let i = input || {};
  if (typeof i === "string") { try { i = JSON.parse(i); } catch { return i; } }
  if (i.query) return i.query;
  if (i.url) return i.url;
  if (i.topics) return [].concat(i.topics).join(", ") + (i.posts && i.posts.length ? " (+" + i.posts.length + " post)" : "");
  return JSON.stringify(i);
};
// "/bin/bash -lc 'npm test'" → "npm test"
const unwrap = (c) => { const m = /^\S*\/(?:ba|z)?sh -lc (.*)$/s.exec(String(c || "")); let x = m ? m[1] : String(c || ""); if (/^'.*'$/s.test(x)) x = x.slice(1, -1).replace(/'\\''/g, "'"); return x; };
let last = "", commands = 0, edits = 0;
rl.on("line", (line) => {
  let e;
  try { e = JSON.parse(line); } catch { if (line.trim()) out({ k: "raw", text: short(line, 300) }); return; }
  const it = e.item || {};
  if (e.type === "thread.started") out({ k: "init" });
  else if (e.type === "item.completed" && it.type === "agent_message") { last = it.text || ""; if (last.trim()) out({ k: "text", text: short(last, 600) }); }
  else if (e.type === "item.started" && it.type === "command_execution") { commands++; out({ k: "tool", tool: "Bash", text: short(unwrap(it.command), 240) }); }
  else if (e.type === "item.completed" && it.type === "file_change" && it.status !== "failed") {
    for (const c of it.changes || []) { edits++; out({ k: "tool", tool: "Edit", text: short(c.path + " (" + (c.kind || "update") + ")", 240) }); }
  }
  else if (e.type === "item.started" && it.type === "mcp_tool_call") out({ k: "tool", tool: "mcp__" + it.server + "__" + it.tool, text: short(describe(it.arguments), 240) });
  else if (e.type === "item.completed" && it.type === "mcp_tool_call" && it.status === "failed") out({ k: "toolerr", text: short((it.error && it.error.message) || it.tool, 200) });
  else if (e.type === "item.started" && it.type === "web_search") out({ k: "tool", tool: "WebSearch", text: short(it.query, 240) });
  else if (e.type === "error") out({ k: "error", text: short(e.message, 400) });
  else if (e.type === "turn.completed") out({ k: "result", ok: true, text: short(last, 800), commands, edits, tokens: e.usage ? (e.usage.input_tokens || 0) + (e.usage.output_tokens || 0) : 0 });
  else if (e.type === "turn.failed") out({ k: "result", ok: false, subtype: "error", text: short((e.error && e.error.message) || last, 800), commands, edits });
});
`;

/** Lists the project's packages (up to three levels down) with their scripts and the web-framework dependencies they use. */
export const SCAN_WORKSPACE = String.raw`
const fs = require("fs");
const path = require("path");
const ROOT = process.argv[2];
const WEB = /^(next|vite|astro|@remix-run\/dev|@react-router\/dev|nuxt|@sveltejs\/kit|expo|react-native-web|wrangler|vinext|react-scripts|@angular\/cli|gatsby|typescript)$/;
const out = [];
function walk(dir, depth) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  if (entries.some((e) => e.name === "package.json")) {
    try {
      const p = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
      const deps = Object.assign({}, p.dependencies, p.devDependencies);
      out.push({
        dir: path.relative(ROOT, dir),
        name: p.name || "",
        scripts: p.scripts || {},
        deps: Object.keys(deps).filter((k) => WEB.test(k)),
        tsconfig: entries.some((e) => e.name === "tsconfig.json"),
      });
    } catch {}
  }
  if (depth >= 3) return;
  for (const e of entries)
    if (e.isDirectory() && !e.name.startsWith(".") && !/^(node_modules|dist|build|out|ios|android|coverage)$/.test(e.name)) walk(path.join(dir, e.name), depth + 1);
}
walk(ROOT, 0);
console.log(JSON.stringify(out.slice(0, 60)));
`;
