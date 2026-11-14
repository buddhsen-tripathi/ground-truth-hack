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
