import { describe, expect, it } from "vitest";
import { buildPlan, chooseTarget, isAffected } from "./versions";

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
    const plan = buildPlan({
      incident: { kind: "malicious", package: "debug", affected: { versions: ["4.4.2"], ranges: [] } },
      from: "4.4.2",
      lockfile: "apps/web/package-lock.json",
      manager: "npm",
      direct: false,
      pack: pack(["4.4.0", "4.4.1", "4.4.2"]),
    });
    expect(plan).toMatchObject({ strategy: "override", to: "4.4.1", dir: "apps/web" });
  });
});
