import type { MonolithAnalyzerDiagnostic, MonolithCheckFileResult } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { fileCheckSummary } from "./fileAnalyzerStatus";

const result: MonolithCheckFileResult = {
  areaId: "api",
  revision: "saved",
  diagnostics: [],
  runs: [{ tool: "mago", operation: "analyze", status: "passed", diagnosticCount: 0 }],
};
const check = { canRun: true, status: "checked" as const, result, diagnostics: [] };
const diagnostic = (
  severity: MonolithAnalyzerDiagnostic["severity"],
): MonolithAnalyzerDiagnostic => ({
  severity,
  path: "src/File.php",
  line: 1,
  column: 1,
  message: "Finding",
  ruleId: "example",
  tool: "mago",
  operation: "analyze",
});

describe("fileCheckSummary", () => {
  it("counts visible diagnostic severities rather than aggregated run findings", () => {
    expect(
      fileCheckSummary({
        ...check,
        diagnostics: [
          diagnostic("error"),
          diagnostic("error"),
          diagnostic("warning"),
          diagnostic("info"),
        ],
        result: {
          ...result,
          runs: [{ tool: "mago", operation: "analyze", status: "findings", diagnosticCount: 99 }],
        },
      }),
    ).toBe("2 errors · 1 warning · 1 note");
  });
  it("shows incomplete execution alongside findings without calling missing tools successful", () => {
    expect(
      fileCheckSummary({
        ...check,
        diagnostics: [diagnostic("warning")],
        result: {
          ...result,
          runs: [
            { tool: "mago", operation: "guard", status: "failed", diagnosticCount: 0 },
            { tool: "mago", operation: "format", status: "unavailable", diagnosticCount: 0 },
          ],
        },
      }),
    ).toBe("1 warning · 1 check failed · 1 unavailable");
    expect(fileCheckSummary({ ...check, result: { ...result, runs: [] } })).toBe(
      "No analyzer available",
    );
    expect(fileCheckSummary(check)).toBe("No findings");
  });
  it("hides old diagnostic counts while waiting for fresh saved results", () => {
    const old = { ...check, diagnostics: [diagnostic("error")] };
    expect(fileCheckSummary({ ...old, status: "unsaved" })).toBe("Unsaved changes");
    expect(fileCheckSummary({ ...old, status: "checking" })).toBe("Checking…");
    expect(fileCheckSummary({ ...old, status: "stale" })).toBe("Refreshing saved file…");
    expect(fileCheckSummary({ ...old, canRun: false })).toBe("Permission required");
    expect(fileCheckSummary({ ...check, status: "idle", result: null })).toBeNull();
  });
});
