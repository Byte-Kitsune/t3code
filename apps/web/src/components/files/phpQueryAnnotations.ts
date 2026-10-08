import type { MonolithCheckFileResult, MonolithDoctrineQueryThresholds } from "@t3tools/contracts";
import { phpInsightSourceTarget } from "./phpInsightTargets";

export type PhpQueryMethod = NonNullable<MonolithCheckFileResult["queryBudget"]>["methods"][number];
export type PhpQueryThresholdSource = NonNullable<
  MonolithCheckFileResult["doctrineQueryThresholdsSource"]
>;
export type PhpQueryAnnotation = {
  readonly lineNumber: number;
  readonly method: PhpQueryMethod;
  readonly severity: "info" | "warning" | "error";
  readonly thresholds?: MonolithDoctrineQueryThresholds;
  readonly thresholdSource?: PhpQueryThresholdSource;
};

export const DEFAULT_QUERY_THRESHOLDS: MonolithDoctrineQueryThresholds = { warning: 10, error: 50 };

export function queryAnnotationSeverity(
  method: PhpQueryMethod,
  thresholds: MonolithDoctrineQueryThresholds = DEFAULT_QUERY_THRESHOLDS,
): PhpQueryAnnotation["severity"] {
  const count = method.upperBound ?? method.lowerBound;
  if (count >= thresholds.error) return "error";
  if (method.upperBound === null || count >= thresholds.warning) return "warning";
  return "info";
}

/** Pierre places annotations after a row, so the preceding row anchors a method's box. */
export function buildPhpQueryAnnotations({
  path,
  methods,
  thresholds,
  thresholdSource,
  lineCount,
}: {
  readonly path: string;
  readonly methods: readonly PhpQueryMethod[];
  readonly thresholds?: MonolithDoctrineQueryThresholds;
  readonly thresholdSource?: PhpQueryThresholdSource;
  readonly lineCount: number;
}): readonly PhpQueryAnnotation[] {
  const normalizedPath = phpInsightSourceTarget({ path })?.path;
  if (!normalizedPath) return [];
  return methods.flatMap((method) => {
    if (
      method.lowerBound === 0 &&
      method.upperBound === 0 &&
      method.unknown.length === 0 &&
      method.cycles.length === 0
    )
      return [];
    const target = phpInsightSourceTarget(method);
    if (
      !target ||
      target.path !== normalizedPath ||
      target.line === undefined ||
      target.line > lineCount
    )
      return [];
    return [
      {
        lineNumber: target.line - 1,
        method,
        severity:
          thresholdSource?.kind === "unresolved"
            ? "warning"
            : queryAnnotationSeverity(method, thresholds),
        ...(thresholdSource?.kind === "unresolved"
          ? {}
          : { thresholds: thresholds ?? DEFAULT_QUERY_THRESHOLDS }),
        ...(thresholdSource ? { thresholdSource } : {}),
      },
    ];
  });
}
