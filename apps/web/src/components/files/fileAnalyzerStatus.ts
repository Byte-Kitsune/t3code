import type { useMonolithFileCheck } from "~/hooks/useMonolithFileCheck";

type FileCheck = Pick<
  ReturnType<typeof useMonolithFileCheck>,
  "canRun" | "status" | "result" | "diagnostics"
>;

export function fileCheckSummary(check: FileCheck): string | null {
  if (!check.canRun) return "Permission required";
  if (check.status === "unsaved") return "Unsaved changes";
  if (check.status === "checking") return "Checking…";
  if (check.status === "failed") return "Failed";
  if (check.status === "stale") return "Refreshing saved file…";
  if (!check.result) return null;
  const counts = { error: 0, warning: 0, info: 0 };
  for (const diagnostic of check.diagnostics) counts[diagnostic.severity]++;
  const parts = (Object.entries(counts) as Array<[keyof typeof counts, number]>)
    .filter(([, count]) => count > 0)
    .map(
      ([severity, count]) =>
        `${count} ${severity === "info" ? "note" : severity}${count === 1 ? "" : "s"}`,
    );
  const failed = check.result.runs.filter((run) => run.status === "failed").length;
  const unavailable = check.result.runs.filter((run) => run.status === "unavailable").length;
  if (failed) parts.push(`${failed} check${failed === 1 ? "" : "s"} failed`);
  if (unavailable) parts.push(`${unavailable} unavailable`);
  if (parts.length) return parts.join(" · ");
  return check.result.runs.length ? "No findings" : "No analyzer available";
}
