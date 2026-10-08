import { describe, expect, it } from "vite-plus/test";
import {
  buildPhpQueryAnnotations,
  queryAnnotationSeverity,
  type PhpQueryMethod,
} from "./phpQueryAnnotations";

const method = (lowerBound: number, upperBound: number | null): PhpQueryMethod => ({
  symbol: "App\\Queries::load",
  path: "src/Queries.php",
  line: 8,
  lowerBound,
  upperBound,
  unknown: upperBound === null ? ["dynamic receiver"] : [],
  cycles: [],
});

describe("inline Doctrine query estimates", () => {
  it("uses extension thresholds with their provenance and does not classify counts using unresolved limits", () => {
    const input = { path: "src/Queries.php", lineCount: 20, methods: [method(40, 40)] };
    const resolved = buildPhpQueryAnnotations({
      ...input,
      thresholds: { warning: 10, error: 25 },
      thresholdSource: { kind: "extension", path: ".mago/extension.php" },
    });
    expect(resolved[0]?.severity).toBe("error");
    expect(resolved[0]?.thresholds).toEqual({ warning: 10, error: 25 });
    expect(resolved[0]?.thresholdSource?.path).toBe(".mago/extension.php");
    const unresolved = buildPhpQueryAnnotations({
      ...input,
      methods: [method(500, 500)],
      thresholdSource: { kind: "unresolved", path: ".mago/extension.php" },
    });
    expect(unresolved[0]?.severity).toBe("warning");
    expect(unresolved[0]?.thresholds).toBeUndefined();
  });
  it.each([
    [0, "info"],
    [9, "info"],
    [10, "warning"],
    [49, "warning"],
    [50, "error"],
    [51, "error"],
  ] as const)("uses inclusive configured boundaries at %s queries", (count, severity) => {
    expect(queryAnnotationSeverity(method(count, count))).toBe(severity);
  });
  it("uses the upper bound of ranges and configurable limits without summing methods", () => {
    expect(queryAnnotationSeverity(method(1, 50))).toBe("error");
    expect(queryAnnotationSeverity(method(1, 4), { warning: 3, error: 6 })).toBe("warning");
    expect(queryAnnotationSeverity(method(2, 2), { warning: 3, error: 6 })).toBe("info");
    expect(queryAnnotationSeverity(method(6, 6), { warning: 3, error: 6 })).toBe("error");
  });
  it("preserves unknown estimates and marks them incomplete rather than displaying a safe zero", () => {
    expect(queryAnnotationSeverity(method(0, null))).toBe("warning");
    expect(queryAnnotationSeverity(method(60, null))).toBe("error");
  });
  it("omits proven zero-query methods but retains unknown and positive estimates", () => {
    const unknown = method(0, null);
    const annotations = buildPhpQueryAnnotations({
      path: "src/Queries.php",
      lineCount: 20,
      methods: [method(0, 0), unknown, method(0, 3), method(1, 1)],
    });
    expect(annotations.map(({ method }) => method.upperBound)).toEqual([null, 3, 1]);
    expect(annotations[0]?.severity).toBe("warning");
  });
  it("anchors boxes immediately above each method, including a method on the first source line", () => {
    const methods = [method(2, 2), { ...method(1, 3), symbol: "first", line: 1 }];
    const annotations = buildPhpQueryAnnotations({
      path: "src/Queries.php",
      methods,
      lineCount: 20,
    });
    expect(annotations.map((annotation) => annotation.lineNumber)).toEqual([7, 0]);
    expect(annotations[0]?.method.line).toBe(8);
  });
  it("does not attach foreign, external, missing or obsolete source locations to nearby methods", () => {
    const methods = [
      { ...method(1, 1), path: "src/Other.php" },
      { ...method(1, 1), path: "../Queries.php" },
      { ...method(1, 1), line: undefined },
      { ...method(1, 1), line: 21 },
      { ...method(1, 1), line: 0 },
    ];
    expect(buildPhpQueryAnnotations({ path: "src/Queries.php", methods, lineCount: 20 })).toEqual(
      [],
    );
  });
});
