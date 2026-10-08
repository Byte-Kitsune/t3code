import type { MonolithAnalyzerDiagnostic, MonolithAnalyzerRun } from "@t3tools/contracts";

const RULE = "byte-kitsune/symfony-wiring/no-hardcoded-secret";
export interface PhpSecurityInsights {
  readonly diagnostics: readonly MonolithAnalyzerDiagnostic[];
  readonly run?: MonolithAnalyzerRun;
}
const record = (value: unknown): Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid configuration security report.");
  return value as Record<string, unknown>;
};
const integer = (value: unknown): number => {
  if (!Number.isSafeInteger(value) || (value as number) < 1)
    throw new Error("Invalid configuration security span.");
  return value as number;
};
function utf16Column(lines: readonly string[], line: number, byteColumn: number): number {
  const text = lines[line - 1];
  if (text === undefined) throw new Error("Invalid configuration security line.");
  const bytes = Buffer.from(text, "utf8");
  if (byteColumn > bytes.length + 1) throw new Error("Invalid configuration security column.");
  const prefix = bytes.subarray(0, byteColumn - 1);
  const decoded = prefix.toString("utf8");
  if (!Buffer.from(decoded, "utf8").equals(prefix))
    throw new Error("Configuration security span splits a UTF-8 character.");
  return decoded.length + 1;
}
/** Never expose extension messages: diagnostics must not retain secret values. */
export function normalizePhpSecurityInsights(
  value: unknown,
  areaPath: string,
  sources: ReadonlyMap<string, string>,
): PhpSecurityInsights {
  const report = record(value);
  if (report.status === "inactive") return { diagnostics: [] };
  if (report.status === "unavailable" || report.status === "failed")
    return {
      diagnostics: [],
      run: {
        tool: "mago",
        operation: "check",
        status: report.status,
        diagnosticCount: 0,
        message:
          report.status === "unavailable"
            ? "Symfony configuration security could not be enabled safely. Update the extension or use a static SecurityExtension registration."
            : "Symfony configuration security could not inspect this source snapshot.",
      },
    };
  if (
    report.schema_version !== 1 ||
    report.column_encoding !== "utf8_bytes" ||
    !Array.isArray(report.issues) ||
    report.issues.length > 10_000 ||
    !Array.isArray(report.incomplete) ||
    report.incomplete.length > 2_000
  )
    throw new Error("Invalid configuration security report.");
  const sourceLines = new Map<string, readonly string[]>();
  const diagnostics: MonolithAnalyzerDiagnostic[] = report.issues.map((value) => {
    const issue = record(value);
    if (
      issue.code !== RULE ||
      issue.severity !== "error" ||
      typeof issue.path !== "string" ||
      issue.path.startsWith("/") ||
      issue.path.includes("\\") ||
      issue.path.split("/").some((part) => part === ".." || part === "." || part === "")
    )
      throw new Error("Invalid configuration security issue.");
    const path = areaPath === "." ? issue.path : `${areaPath}/${issue.path}`;
    const contents = sources.get(path);
    if (contents === undefined) throw new Error("Unexpected configuration security source.");
    let lines = sourceLines.get(path);
    if (!lines) {
      lines = contents.split("\n");
      sourceLines.set(path, lines);
    }
    const line = integer(issue.line),
      endLine = integer(issue.end_line);
    const column = utf16Column(lines, line, integer(issue.column));
    const endColumn = utf16Column(lines, endLine, integer(issue.end_column));
    if (endLine < line || (endLine === line && endColumn <= column))
      throw new Error("Invalid configuration security range.");
    return {
      path,
      line,
      column,
      endLine,
      endColumn,
      severity: "error",
      message:
        "Hardcoded secret in Symfony configuration. Use an environment variable or Symfony secret instead.",
      ruleId: RULE,
      tool: "mago",
      operation: "check",
    };
  });
  return {
    diagnostics,
    run: {
      tool: "mago",
      operation: "check",
      status: report.incomplete.length ? "failed" : diagnostics.length ? "findings" : "passed",
      diagnosticCount: diagnostics.length,
      ...(report.incomplete.length
        ? {
            message:
              "Symfony configuration security inspection was incomplete for one or more files.",
          }
        : {}),
    },
  };
}
