import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import type { ComponentProps } from "react";
import { FileAnalyzerStatus } from "./FileAnalyzerStatus";

describe("file-level analyzer status", () => {
  it("shows dependency findings below the file with no invented source location", () => {
    const finding = {
      path: "app/source.ts",
      tool: "depcruise" as const,
      operation: "check" as const,
      severity: "error" as const,
      ruleId: "no-cycle",
      message: "Forbidden dependency cycle",
    };
    const check: ComponentProps<typeof FileAnalyzerStatus>["check"] = {
      supported: true,
      canRun: true,
      status: "checked",
      result: {
        areaId: "ui",
        revision: "saved",
        diagnostics: [finding],
        runs: [{ tool: "depcruise", operation: "check", status: "findings", diagnosticCount: 1 }],
      },
      diagnostics: [finding],
    };
    const markup = renderToStaticMarkup(<FileAnalyzerStatus check={check} />);
    expect(markup).toContain("File-level analyzer findings");
    expect(markup).toContain("Forbidden dependency cycle");
    expect(markup).toContain("1 error");
    expect(markup).toContain("no-cycle · File");
    expect(markup).not.toContain("L1:");
    expect(markup).not.toContain("undefined");
    expect(
      renderToStaticMarkup(
        <FileAnalyzerStatus check={{ ...check, status: "stale", diagnostics: [] }} />,
      ),
    ).not.toContain("Forbidden dependency cycle");
  });
});
