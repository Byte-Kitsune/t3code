import { describe, expect, it } from "@effect/vitest";
import { normalizePhpSecurityInsights } from "./PhpSecurityInsights.ts";
const contents = "clé: secret\n";
const sources = new Map([["app/config/services.yaml", contents]]);
const report = (issue: object = {}) => ({
  schema_version: 1,
  column_encoding: "utf8_bytes",
  issues: [
    {
      code: "byte-kitsune/symfony-wiring/no-hardcoded-secret",
      severity: "error",
      path: "config/services.yaml",
      line: 1,
      column: 7,
      end_line: 1,
      end_column: 13,
      message: "DO NOT STORE raw secret",
      ...issue,
    },
  ],
  incomplete: [],
});
describe("Symfony configuration security normalization", () => {
  it("converts UTF8 positions and removes every extension-supplied secret-bearing text", () => {
    const result = normalizePhpSecurityInsights(report(), "app", sources);
    expect(result.diagnostics[0]).toMatchObject({
      path: "app/config/services.yaml",
      line: 1,
      column: 6,
      endColumn: 12,
      operation: "check",
    });
    expect(JSON.stringify(result)).not.toContain("DO NOT STORE");
    expect(result.run?.status).toBe("findings");
  });
  it("rejects escaping, unrelated sources and byte positions inside characters", () => {
    for (const issue of [
      { path: "../secret.yaml" },
      { path: "config/unknown.yaml" },
      { column: 4 },
      { end_column: 99 },
    ])
      expect(() => normalizePhpSecurityInsights(report(issue), "app", sources)).toThrow();
  });
  it("never treats incomplete or unresolved configuration inspection as passed", () => {
    expect(
      normalizePhpSecurityInsights(
        { ...report(), incomplete: [{ path: "x", reason: "secret" }] },
        "app",
        sources,
      ).run?.status,
    ).toBe("failed");
    expect(
      normalizePhpSecurityInsights({ status: "unavailable", message: "secret" }, "app", sources).run
        ?.status,
    ).toBe("unavailable");
    expect(normalizePhpSecurityInsights({ status: "inactive" }, "app", sources)).toEqual({
      diagnostics: [],
    });
  });
});
