import { describe, expect, it } from "vite-plus/test";
import type { MonolithAnalyzerDiagnostic } from "@t3tools/contracts";
import {
  analyzerContentRevision,
  fileAnalyzerDiagnostics,
  mergeFileAnalyzerAnnotations,
} from "./fileAnalyzerDiagnostics";

const finding: MonolithAnalyzerDiagnostic = {
  path: "app/src/File.php",
  line: 2,
  column: 4,
  severity: "error",
  message: "Unknown service",
  ruleId: "unknown-service",
  tool: "mago",
  operation: "analyze",
};

describe("file analyzer diagnostics", () => {
  it("uses the server's UTF-8 SHA-256 revision, including unicode and line endings", () => {
    expect(analyzerContentRevision("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(analyzerContentRevision("ä\r\n")).not.toBe(analyzerContentRevision("ä\n"));
    expect(analyzerContentRevision("ä")).not.toBe(analyzerContentRevision("a"));
  });

  it("keeps only findings for valid original source lines and the displayed file", () => {
    const normalized = { ...finding, path: ".\\app\\src\\File.php" };
    expect(
      fileAnalyzerDiagnostics(
        [
          normalized,
          { ...finding, path: "app/src/Other.php" },
          { ...finding, line: 0 },
          { ...finding, line: 3 },
          { ...finding, line: 1.5 },
        ],
        "app/src/File.php",
        "<?php\r\nerror();",
      ),
    ).toEqual([normalized]);
  });

  it("preserves multiple same-line findings and comments without mutating either", () => {
    const comment = {
      lineNumber: 2,
      metadata: {
        entries: [
          {
            id: "review",
            kind: "comment" as const,
            startLine: 1,
            endLine: 2,
            text: "Please check this",
          },
        ],
      },
    };
    const second = {
      ...finding,
      tool: "biome" as const,
      operation: "check" as const,
      message: "Second finding",
    };
    const result = mergeFileAnalyzerAnnotations(
      [comment],
      [{ ...finding, line: 1 }, finding, second],
    );
    expect(result.map((annotation) => annotation.lineNumber)).toEqual([1, 2]);
    expect(result[1]?.metadata.entries).toEqual(comment.metadata.entries);
    expect(result[1]?.metadata.diagnostics).toEqual([finding, second]);
    expect(comment.metadata).toEqual({ entries: comment.metadata.entries });
  });

  it("removes expired diagnostics while retaining editable review comments", () => {
    const comment = {
      lineNumber: 2,
      metadata: {
        entries: [{ id: "draft", kind: "draft" as const, startLine: 2, endLine: 2, text: "" }],
      },
    };
    expect(mergeFileAnalyzerAnnotations([comment], [])).toEqual([comment]);
    expect(mergeFileAnalyzerAnnotations([], [])).toEqual([]);
  });
});
