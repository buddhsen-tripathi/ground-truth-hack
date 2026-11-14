import { describe, expect, it } from "vitest";
import { chooseTarget, isAffected } from "./versions";
import { planPackage } from "./fix/plan";
import { compare, normalizeName } from "./pep440";

const pack = (versions: string[]) => ({ versions, deprecated: new Set<string>(), latest: versions.at(-1) ?? null });

describe("isAffected", () => {
  it("handles explicit versions and ranges", () => {
    const affected = { versions: ["1.2.3"], ranges: [{ introduced: "2.0.0", fixed: "2.1.0" }, { introduced: "0", lastAffected: "0.9.0" }] };
    expect(isAffected("1.2.3", affected)).toBe(true);
    expect(isAffected("1.2.4", affected)).toBe(false);
    expect(isAffected("2.0.5", affected)).toBe(true);
    expect(isAffected("2.1.0", affected)).toBe(false);
    expect(isAffected("0.5.0", affected)).toBe(true);
  });
});

describe("chooseTarget", () => {
  it("upgrades a vulnerability within the major when possible", () => {
    const t = chooseTarget({ kind: "vulnerability", affected: { versions: [], ranges: [{ introduced: "0", fixed: "0.21.2" }] } }, "0.21.1", pack(["0.21.0", "0.21.1", "0.21.2", "0.21.4", "1.7.2"]));
    expect(t?.to).toBe("0.21.2");
  });

  it("falls back to a major upgrade", () => {
    const t = chooseTarget({ kind: "vulnerability", affected: { versions: [], ranges: [{ introduced: "0", fixed: "2.0.0" }] } }, "1.4.0", pack(["1.4.0", "1.5.0", "2.0.0", "2.1.0"]));
    expect(t?.to).toBe("2.0.0");
    expect(t?.reason).toMatch(/major/);
  });

  it("skips versions flagged by other advisories", () => {
    const t = chooseTarget(
      { kind: "vulnerability", affected: { versions: [], ranges: [{ introduced: "0", fixed: "0.21.2" }] } },
      "0.21.1",
      pack(["0.21.1", "0.21.2", "0.21.4", "1.7.2"]),
      [{ versions: [], ranges: [{ introduced: "0", fixed: "0.21.4" }] }],
    );
    expect(t?.to).toBe("0.21.4");
  });

  it("pins back below the first malicious version", () => {
    const t = chooseTarget({ kind: "malicious", affected: { versions: ["1.120.3", "1.120.4"], ranges: [] } }, "1.120.3", pack(["1.119.0", "1.120.2", "1.120.3", "1.120.4", "1.120.5"]));
    expect(t).toMatchObject({ to: "1.120.2", strategyHint: "pin-back" });
  });

  it("uses an override for transitive deps", () => {
    const fix = planPackage({
      ecosystem: "npm",
      manager: "npm",
      lockfile: "apps/web/package-lock.json",
      package: "debug",
      versions: ["4.4.2"],
      direct: false,
      incidents: [{ id: "MAL-1", kind: "malicious", severity: "critical", title: "x", affected: { versions: ["4.4.2"], ranges: [] } }],
      others: [],
      pack: pack(["4.4.0", "4.4.1", "4.4.2"]),
    });
    expect(fix).toMatchObject({ strategy: "override", to: "4.4.1", exact: true, key: "apps/web/package-lock.json::debug" });
  });

  it("clears every advisory hitting a package at once", () => {
    const fix = planPackage({
      ecosystem: "npm",
      manager: "pnpm",
      lockfile: "pnpm-lock.yaml",
      package: "axios",
      versions: ["0.21.1", "0.21.0"],
      direct: true,
      incidents: [
        { id: "GHSA-a", kind: "vulnerability", severity: "high", title: "a", affected: { versions: [], ranges: [{ introduced: "0", fixed: "0.21.2" }] } },
        { id: "GHSA-b", kind: "vulnerability", severity: "moderate", title: "b", affected: { versions: [], ranges: [{ introduced: "0", fixed: "0.21.4" }] } },
      ],
      others: [],
      pack: pack(["0.21.0", "0.21.1", "0.21.2", "0.21.4", "1.7.2"]),
    });
    expect(fix).toMatchObject({ strategy: "upgrade", to: "0.21.4", exact: false });
  });
});

describe("PyPI", () => {
  it("orders PEP 440 versions", () => {
    const sorted = ["1.0.post1", "1.0", "1.0rc1", "1.0.dev0", "1.0a1", "0.9", "1.0.1", "2!0.1"].sort(compare);
    expect(sorted).toEqual(["0.9", "1.0.dev0", "1.0a1", "1.0rc1", "1.0", "1.0.post1", "1.0.1", "2!0.1"]);
    expect(compare("1.0", "1.0.0")).toBe(0);
    expect(compare("2.10.0", "2.9.0")).toBe(1);
  });

  it("normalizes project names", () => {
    expect(normalizeName("PyYAML")).toBe("pyyaml");
    expect(normalizeName("zope.interface")).toBe("zope-interface");
    expect(normalizeName("typing_extensions")).toBe("typing-extensions");
  });

  it("matches OSV ranges with PEP 440 rules", () => {
    const affected = { versions: [], ranges: [{ introduced: "0", fixed: "2.32.0" }] };
    expect(isAffected("2.31.0", affected, "PyPI")).toBe(true);
    expect(isAffected("2.32.0", affected, "PyPI")).toBe(false);
    expect(isAffected("2.32.0rc1", affected, "PyPI")).toBe(true);
    expect(isAffected("2.4", { versions: [], ranges: [{ introduced: "2.3", fixed: "2.10" }] }, "PyPI")).toBe(true);
    expect(isAffected("2.10.1", { versions: [], ranges: [{ introduced: "2.3", fixed: "2.10" }] }, "PyPI")).toBe(false);
  });

  it("upgrades a PyPI package within the major", () => {
    const t = chooseTarget(
      { kind: "vulnerability", affected: { versions: [], ranges: [{ introduced: "0", fixed: "2.32.0" }] } },
      "2.31.0",
      { versions: ["2.30.0", "2.31.0", "2.32.0rc1", "2.32.0", "2.32.3", "3.0.0"], deprecated: new Set(["2.32.0"]), latest: "3.0.0" },
      [],
      "PyPI",
    );
    expect(t?.to).toBe("2.32.3");
  });
});
