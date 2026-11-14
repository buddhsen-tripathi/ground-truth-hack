import { describe, expect, it } from "vitest";
import { lockfileDir, managerFor, parseBunLock, parseNpmLock, parsePnpmKey, parsePnpmLock, parseRequirements, parseUvLock, parseWorkflow, parseYarnLock, pyprojectDirectNames } from "./index";

const direct = new Set(["axios", "@tanstack/react-router"]);
const find = (deps: { name: string; version: string; direct: boolean }[], name: string) => deps.filter((d) => d.name === name);

describe("npm", () => {
  it("reads v3 packages and marks top-level direct deps", () => {
    const deps = parseNpmLock(
      JSON.stringify({
        lockfileVersion: 3,
        packages: {
          "": { name: "app", dependencies: { axios: "^1" } },
          "node_modules/axios": { version: "1.7.2" },
          "node_modules/follow-redirects": { version: "1.15.6" },
          "node_modules/foo/node_modules/axios": { version: "0.21.1" },
          "packages/web": { name: "web" },
          "node_modules/web": { link: true, resolved: "packages/web" },
        },
      }),
      direct,
    );
    expect(find(deps, "axios")).toEqual([
      { name: "axios", version: "1.7.2", direct: true },
      { name: "axios", version: "0.21.1", direct: false },
    ]);
    expect(find(deps, "follow-redirects")[0]?.direct).toBe(false);
    expect(find(deps, "web")).toEqual([]);
  });

  it("reads v1 nested dependencies", () => {
    const deps = parseNpmLock(JSON.stringify({ dependencies: { axios: { version: "0.19.0", dependencies: { "follow-redirects": { version: "1.5.10" } } } } }), direct);
    expect(deps).toContainEqual({ name: "follow-redirects", version: "1.5.10", direct: false });
    expect(deps).toContainEqual({ name: "axios", version: "0.19.0", direct: true });
  });
});

describe("pnpm", () => {
  it("parses keys from v5, v6 and v9", () => {
    expect(parsePnpmKey("/axios/1.7.2")).toEqual({ name: "axios", version: "1.7.2" });
    expect(parsePnpmKey("/@tanstack/react-router@1.120.3(react@19.0.0)")).toEqual({ name: "@tanstack/react-router", version: "1.120.3" });
    expect(parsePnpmKey("@tanstack/react-router@1.120.3")).toEqual({ name: "@tanstack/react-router", version: "1.120.3" });
    expect(parsePnpmKey("/@scope/pkg/2.0.0_react@18.0.0")).toEqual({ name: "@scope/pkg", version: "2.0.0" });
  });

  it("reads a v9 lockfile", () => {
    const deps = parsePnpmLock(
      `lockfileVersion: '9.0'
importers:
  .:
    dependencies:
      '@tanstack/react-router':
        specifier: ^1.120.0
        version: 1.120.3(react@19.0.0)
packages:
  '@tanstack/react-router@1.120.3':
    resolution: {integrity: sha512-x}
  react@19.0.0:
    resolution: {integrity: sha512-y}
snapshots:
  '@tanstack/react-router@1.120.3(react@19.0.0)':
    dependencies:
      react: 19.0.0
`,
      new Set(),
    );
    expect(deps).toContainEqual({ name: "@tanstack/react-router", version: "1.120.3", direct: true });
    expect(deps).toContainEqual({ name: "react", version: "19.0.0", direct: false });
    expect(deps).toHaveLength(2);
  });
});

describe("yarn", () => {
  it("reads classic lockfiles", () => {
    const deps = parseYarnLock(
      `# yarn lockfile v1

"@tanstack/react-router@^1.120.0", "@tanstack/react-router@^1.0.0":
  version "1.120.3"
  resolved "https://registry.yarnpkg.com/x"

axios@^1:
  version "1.7.2"
`,
      direct,
    );
    expect(deps).toEqual([
      { name: "@tanstack/react-router", version: "1.120.3", direct: true },
      { name: "axios", version: "1.7.2", direct: true },
    ]);
  });

  it("reads berry lockfiles and skips workspaces", () => {
    const deps = parseYarnLock(
      `__metadata:
  version: 8

"app@workspace:.":
  version: 0.0.0-use.local

"axios@npm:^1.7.0":
  version: 1.7.2
  resolution: "axios@npm:1.7.2"
`,
      direct,
    );
    expect(deps).toEqual([{ name: "axios", version: "1.7.2", direct: true }]);
  });
});

describe("bun", () => {
  it("reads bun.lock with trailing commas", () => {
    const deps = parseBunLock(
      `{
  "lockfileVersion": 1,
  "workspaces": {
    "": {
      "name": "app",
      "dependencies": {
        "axios": "^1.7.0",
      },
    },
  },
  "packages": {
    "axios": ["axios@1.7.2", "", { "dependencies": { "follow-redirects": "^1.15.6" } }, "sha512-a"],
    "follow-redirects": ["follow-redirects@1.15.6", "", {}, "sha512-b"],
    "foo/axios": ["axios@0.21.1", "", {}, "sha512-c"],
  }
}
`,
      new Set(),
    );
    expect(deps).toContainEqual({ name: "axios", version: "1.7.2", direct: true });
    expect(deps).toContainEqual({ name: "axios", version: "0.21.1", direct: false });
    expect(deps).toContainEqual({ name: "follow-redirects", version: "1.15.6", direct: false });
  });
});

describe("workflows", () => {
  it("finds action refs and secrets", () => {
    const { actions, secrets } = parseWorkflow(
      "ci.yml",
      `jobs:
  build:
    steps:
      - uses: actions/checkout@v4
      - uses: aquasecurity/trivy-action@0123456789abcdef0123456789abcdef01234567 # v0.30
      - uses: ./local-action
      - run: npm publish
        env:
          NODE_AUTH_TOKEN: \${{ secrets.NPM_TOKEN }}
          AWS: \${{ secrets.AWS_ACCESS_KEY_ID }}
`,
    );
    expect(actions).toEqual([
      { workflow: "ci.yml", uses: "actions/checkout", ref: "v4", pinned: false },
      { workflow: "ci.yml", uses: "aquasecurity/trivy-action", ref: "0123456789abcdef0123456789abcdef01234567", pinned: true },
    ]);
    expect(secrets).toEqual(["NPM_TOKEN", "AWS_ACCESS_KEY_ID"]);
  });
});

describe("python", () => {
  it("finds uv.lock and pinned requirements files", () => {
    expect(managerFor("uv.lock")).toBe("uv");
    expect(managerFor("api/requirements.txt")).toBe("pip");
    expect(managerFor("requirements-dev.txt")).toBe("pip");
    expect(managerFor("requirements/base.txt")).toBe("pip");
    expect(managerFor("docs/notes.txt")).toBeNull();
    expect(lockfileDir("svc/requirements/base.txt", "pip")).toBe("svc");
    expect(lockfileDir("svc/uv.lock", "uv")).toBe("svc");
  });

  it("reads registry packages from uv.lock", () => {
    const lock = [
      "version = 1",
      'requires-python = ">=3.11"',
      "",
      "[[package]]",
      'name = "app"',
      'version = "0.1.0"',
      'source = { editable = "." }',
      "dependencies = [",
      '    { name = "requests" },',
      "]",
      "",
      "[[package]]",
      'name = "requests"',
      'version = "2.31.0"',
      'source = { registry = "https://pypi.org/simple" }',
      "dependencies = [",
      '    { name = "urllib3" },',
      "]",
      "wheels = [",
      '    { url = "https://files.pythonhosted.org/x.whl", hash = "sha256:abc" },',
      "]",
      "",
      "[package.optional-dependencies]",
      'socks = [{ name = "pysocks" }]',
      "",
      "[[package]]",
      'name = "urllib3"',
      'version = "1.26.18"',
      'source = { registry = "https://pypi.org/simple" }',
    ].join("\n");
    const pyproject = '[project]\nname = "app"\ndependencies = [\n  "Requests>=2.28,<3",\n  "rich",\n]\n';
    expect(pyprojectDirectNames(pyproject)).toEqual(new Set(["requests", "rich"]));
    expect(parseUvLock(lock, pyprojectDirectNames(pyproject))).toEqual([
      { name: "requests", version: "2.31.0", direct: true },
      { name: "urllib3", version: "1.26.18", direct: false },
    ]);
  });

  it("reads == pins and skips everything else", () => {
    const deps = parseRequirements(
      ["# comment", "-r base.txt", "Django==4.2.1 ; python_version >= '3.10'", "requests[socks]==2.31.0 \\", "    --hash=sha256:abc", "flask>=2", "-e .", "PyYAML == 6.0.1  # yaml"].join("\n"),
    );
    expect(deps).toEqual([
      { name: "django", version: "4.2.1", direct: true },
      { name: "requests", version: "2.31.0", direct: true },
      { name: "pyyaml", version: "6.0.1", direct: true },
    ]);
  });
});
