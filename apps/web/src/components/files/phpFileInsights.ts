import type { MonolithCheckFileResult } from "@t3tools/contracts";

type QueryMethod = NonNullable<MonolithCheckFileResult["queryBudget"]>["methods"][number];
type InsightStatus = NonNullable<MonolithCheckFileResult["queryBudget"]>["status"];

export function queryBudgetLabel(method: QueryMethod): string {
  if (method.upperBound === null) {
    return method.lowerBound === 0
      ? "Unknown query count"
      : `At least ${method.lowerBound} queries; upper bound unknown`;
  }
  if (method.upperBound === method.lowerBound) {
    return `${method.lowerBound} ${method.lowerBound === 1 ? "query" : "queries"}`;
  }
  return `${method.lowerBound}–${method.upperBound} queries`;
}

export function phpInsightStatusLabel(status: InsightStatus): string {
  switch (status) {
    case "complete":
      return "Complete";
    case "incomplete":
      return "Incomplete analysis";
    case "unavailable":
      return "Extension unavailable";
    case "unsupported":
      return "Unsupported extension output";
    case "failed":
      return "Analysis failed";
  }
}

/** Exported graphs can refer to external files; keep navigation within the workspace. */
export function phpInsightSourceTarget(source: { path: string; line?: number | undefined }) {
  const path = source.path.replace(/\\/g, "/").replace(/^\.\//, "");
  if (
    !path ||
    path.startsWith("/") ||
    /^[a-z]:/i.test(path) ||
    path.split("/").some((part) => part === ".." || part === "")
  )
    return null;
  return {
    path,
    line:
      source.line !== undefined && Number.isInteger(source.line) && source.line >= 1
        ? source.line
        : undefined,
  };
}
