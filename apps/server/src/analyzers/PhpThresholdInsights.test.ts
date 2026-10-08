import { describe, expect, it } from "vite-plus/test";
import { normalizePhpThresholdInsights } from "./PhpThresholdInsights.ts";
describe("query threshold provenance", () => {
  it("keeps equal extension boundaries valid and UI defaults explicit", () => {
    expect(
      normalizePhpThresholdInsights({
        thresholds: { warning: 12, error: 12 },
        source: { kind: "extension", path: "api/.mago/extension.php" },
      }).doctrineQueryThresholds,
    ).toEqual({ warning: 12, error: 12 });
    expect(
      normalizePhpThresholdInsights({
        thresholds: { warning: 10, error: 50 },
        source: { kind: "default" },
      }).doctrineQueryThresholdsSource.kind,
    ).toBe("default");
  });
  it("does not supply guessed values for unresolved configuration", () => {
    expect(
      normalizePhpThresholdInsights({
        source: { kind: "unresolved", message: "Dynamic configuration" },
      }).doctrineQueryThresholds,
    ).toBeUndefined();
    expect(() =>
      normalizePhpThresholdInsights({
        thresholds: { warning: 10, error: 50 },
        source: { kind: "unresolved" },
      }),
    ).toThrow();
    expect(() => normalizePhpThresholdInsights({ source: { kind: "extension" } })).toThrow();
  });
  it("rejects escaped provenance and invalid thresholds", () => {
    expect(() =>
      normalizePhpThresholdInsights({
        thresholds: { warning: 12, error: 10 },
        source: { kind: "extension", path: "../outside.php" },
      }),
    ).toThrow();
  });
});
