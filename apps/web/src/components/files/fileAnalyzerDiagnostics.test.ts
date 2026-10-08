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

it("keeps above-method estimates and declaration hints alongside existing review and analyzer findings", () => {
  const query = {
    lineNumber: 1,
    method: {
      symbol: "Service::load",
      path: "app/src/File.php",
      line: 2,
      lowerBound: 12,
      upperBound: 12,
      unknown: [],
      cycles: [],
    },
    severity: "warning" as const,
  };
  const dev = {
    lineNumber: 1,
    site: {
      symbol: "Service::load",
      targetSymbol: "Port::load",
      kind: "implementation" as const,
      path: "app/src/File.php",
      line: 2,
      column: 20,
      endLine: 2,
      endColumn: 24,
      annotations: [
        {
          marker: "@deprecated",
          severity: "warning" as const,
          message: "Use loadMany",
          path: "app/src/Port.php",
          line: 4,
          column: 1,
        },
      ],
    },
  };
  const rows = mergeFileAnalyzerAnnotations([], [{ ...finding, line: 1 }], [query], [dev]);
  expect(rows).toHaveLength(1);
  expect(rows[0]!.metadata.diagnostics).toEqual([{ ...finding, line: 1 }]);
  expect(rows[0]!.metadata.queries).toEqual([query]);
  expect(rows[0]!.metadata.devComments).toEqual([dev]);
});
