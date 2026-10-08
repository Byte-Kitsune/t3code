import * as Path from "effect/Path";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as ProcessRunner from "../processRunner.ts";

export interface AnalyzerExecutionInput {
  readonly tool: "mago" | "biome";
  readonly operation: "format" | "analyze" | "guard" | "check";
  readonly command: string;
  readonly cwd: string;
  readonly workspaceRoot: string;
  readonly filePath: string;
  readonly configPath?: string;
  readonly sourceText?: string;
}

export interface AnalyzerDiagnostic {
  readonly path: string;
  readonly line: number;
  readonly column: number;
  readonly endLine?: number;
  readonly endColumn?: number;
  readonly severity: "error" | "warning" | "info";
  readonly message: string;
  readonly ruleId: string;
  readonly tool: "mago" | "biome";
  readonly operation: AnalyzerExecutionInput["operation"];
}

export interface AnalyzerExecutionResult {
  readonly diagnostics: readonly AnalyzerDiagnostic[];
  readonly exitCode: number;
  readonly status: "passed" | "findings";
}

export class AnalyzerExecutionError extends Schema.TaggedError<AnalyzerExecutionError>()(
  "AnalyzerExecutionError",
  {
    tool: Schema.Literals(["mago", "biome"]),
    operation: Schema.String,
    category: Schema.Literals(["input", "spawn", "timeout", "output", "report", "exit"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `The ${this.tool} ${this.operation} check could not complete (${this.category}).`;
  }
}

export class AnalyzerExecution extends Context.Service<
  AnalyzerExecution,
  {
    readonly run: (
      input: AnalyzerExecutionInput,
    ) => Effect.Effect<AnalyzerExecutionResult, AnalyzerExecutionError>;
  }
>()("t3/analyzers/AnalyzerExecution") {}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected an object in analyzer report");
  }
  return value as Record<string, unknown>;
}

function integer(value: unknown, zeroBased = false): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < (zeroBased ? 0 : 1)) {
    throw new Error("Invalid analyzer source position");
  }
  return value + (zeroBased ? 1 : 0);
}

function text(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) throw new Error("Missing diagnostic text");
  return value;
}

function severity(value: unknown): AnalyzerDiagnostic["severity"] {
  switch (String(value).toLowerCase()) {
    case "error":
    case "fatal":
      return "error";
    case "warning":
    case "warn":
      return "warning";
    case "note":
    case "help":
    case "info":
    case "information":
      return "info";
    default:
      throw new Error("Unknown diagnostic severity");
  }
}

function relativeFile(
  input: AnalyzerExecutionInput,
  reportedPath: string,
  paths: Path.Path,
): string | null {
  const absolute = paths.resolve(input.cwd, reportedPath);
  const relative = paths.relative(input.workspaceRoot, absolute);
  if (relative === ".." || relative.startsWith(`..${paths.sep}`) || paths.isAbsolute(relative))
    return null;
  // PHP analysis and guard intentionally retain the complete project context, while
  // only diagnostics for the opened file are presented by this operation.
  if (absolute !== paths.resolve(input.filePath)) return null;
  return relative.split(paths.sep).join("/");
}

function bytePosition(sourceText: string, value: unknown): { line: number; column: number } {
  const bytes = Buffer.from(sourceText, "utf8");
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > bytes.length
  ) {
    throw new Error("Invalid diagnostic byte offset");
  }
  const before = bytes.subarray(0, value).toString("utf8");
  const lines = before.split("\n");
  return { line: lines.length, column: lines.at(-1)!.length + 1 };
}

function normalizeMago(
  input: AnalyzerExecutionInput,
  stdout: string,
  paths: Path.Path,
): AnalyzerDiagnostic[] {
  const report = record(JSON.parse(stdout));
  if (!Array.isArray(report.issues)) throw new Error("Mago report has no issues array");
  const diagnostics: AnalyzerDiagnostic[] = [];
  for (const value of report.issues) {
    const issue = record(value);
    const message = text(issue.message);
    const level = severity(issue.level);
    // The Symfony extension may emit successful execution evidence when an
    // inherited environment enables attestation. It is not a source diagnostic.
    if (level === "info" && issue.code === "byte-kitsune/symfony-wiring/analysis-attestation")
      continue;
    if (!Array.isArray(issue.annotations)) throw new Error("Mago issue has no annotations");
    // Project-wide notices have no source location and cannot be attached to a line.
    if (issue.annotations.length === 0) {
      if (level === "error") throw new Error("Mago reported an unlocated project error");
      continue;
    }
    const annotations = issue.annotations.map(record);
    const annotation =
      annotations.find((item) => String(item.kind).toLowerCase() === "primary") ?? annotations[0]!;
    const span = record(annotation.span);
    const file = record(span.file_id);
    const diagnosticPath = relativeFile(input, text(file.path), paths);
    if (diagnosticPath === null) continue;
    const start = record(span.start);
    const end = span.end === undefined ? undefined : record(span.end);
    const column = (position: Record<string, unknown>) =>
      position.column !== undefined
        ? integer(position.column, true)
        : input.sourceText !== undefined && position.offset !== undefined
          ? bytePosition(input.sourceText, position.offset).column
          : 1;
    diagnostics.push({
      path: diagnosticPath,
      line: integer(start.line, true),
      column: column(start),
      ...(end === undefined
        ? {}
        : {
            endLine: integer(end.line, true),
            endColumn: column(end),
          }),
      severity: level,
      message,
      ruleId: typeof issue.code === "string" ? issue.code : `mago/${input.operation}`,
      tool: input.tool,
      operation: input.operation,
    });
  }
  return diagnostics;
}

function normalizeBiome(
  input: AnalyzerExecutionInput,
  stdout: string,
  paths: Path.Path,
): AnalyzerDiagnostic[] {
  const report = record(JSON.parse(stdout));
  if (!Array.isArray(report.diagnostics)) throw new Error("Biome report has no diagnostics array");
  const diagnostics: AnalyzerDiagnostic[] = [];
  for (const value of report.diagnostics) {
    const issue = record(value);
    const location = record(issue.location);
    const rawPath = typeof location.path === "string" ? location.path : record(location.path).file;
    const diagnosticPath = relativeFile(input, text(rawPath), paths);
    if (diagnosticPath === null) continue;
    let start = location.start === undefined ? undefined : record(location.start);
    let end = location.end === undefined ? undefined : record(location.end);
    // Older Biome JSON reporters carry byte spans instead of source positions.
    if (start === undefined && Array.isArray(location.span)) {
      if (input.sourceText === undefined) throw new Error("Source text is needed for byte spans");
      start = bytePosition(input.sourceText, location.span[0]);
      end = bytePosition(input.sourceText, location.span[1]);
    }
    const position = (value: unknown) => (value === 0 ? 1 : integer(value));
    diagnostics.push({
      path: diagnosticPath,
      line: start === undefined ? 1 : position(start.line),
      column: start === undefined ? 1 : position(start.column),
      ...(end === undefined
        ? {}
        : { endLine: position(end.line), endColumn: position(end.column) }),
      severity: severity(issue.severity),
      message: text(issue.message),
      ruleId: typeof issue.category === "string" ? issue.category : "biome/check",
      tool: input.tool,
      operation: input.operation,
    });
  }
  return diagnostics;
}

function normalizeFormat(
  input: AnalyzerExecutionInput,
  stdout: string,
  paths: Path.Path,
): AnalyzerDiagnostic[] {
  const diagnosticPath = relativeFile(input, input.filePath, paths);
  if (diagnosticPath === null) throw new Error("File is outside the workspace");
  const lines = new Set<number>();
  let sourceLine = 1;
  let inHunk = false;
  let changedLine: number | undefined;
  for (const line of stdout.split("\n")) {
    const match = /^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/.exec(line);
    if (match) {
      sourceLine = Math.max(1, Number(match[1]));
      inHunk = true;
      changedLine = undefined;
    } else if (inHunk && line.startsWith("-")) {
      changedLine = sourceLine;
      lines.add(sourceLine++);
    } else if (inHunk && line.startsWith("+")) {
      lines.add(changedLine ?? sourceLine);
    } else if (inHunk && line.startsWith(" ")) {
      sourceLine++;
      changedLine = undefined;
    } else if (line.startsWith("diff ") || line.startsWith("--- ") || line.startsWith("+++ ")) {
      inHunk = false;
    }
  }
  if (stdout.trim().length > 0 && lines.size === 0)
    throw new Error("Unexpected Mago format output");
  return [...lines].map((line) => ({
    path: diagnosticPath,
    line,
    column: 1,
    severity: "warning",
    message: "Mago would format this line.",
    ruleId: "mago/format",
    tool: input.tool,
    operation: input.operation,
  }));
}

const make = Effect.gen(function* () {
  const runner = yield* ProcessRunner.ProcessRunner;
  const paths = yield* Path.Path;
  const run = Effect.fn("AnalyzerExecution.run")(function* (input: AnalyzerExecutionInput) {
    const validPair =
      input.tool === "biome" ? input.operation === "check" : input.operation !== "check";
    if (
      !validPair ||
      !paths.isAbsolute(input.command) ||
      !paths.isAbsolute(input.cwd) ||
      !paths.isAbsolute(input.workspaceRoot) ||
      !paths.isAbsolute(input.filePath) ||
      relativeFile(input, input.filePath, paths) === null
    ) {
      return yield* new AnalyzerExecutionError({
        ...input,
        category: "input",
        cause: new Error("Invalid analyzer invocation"),
      });
    }
    const args =
      input.tool === "biome"
        ? [
            "check",
            "--reporter=json",
            "--colors=off",
            "--max-diagnostics=none",
            ...(input.configPath ? [`--config-path=${input.configPath}`] : []),
            input.filePath,
          ]
        : [
            ...(input.configPath ? ["--config", input.configPath] : []),
            input.operation,
            ...(input.operation === "format"
              ? ["--dry-run", input.filePath]
              : [
                  "--reporting-format",
                  "json",
                  "--reporting-target",
                  "stdout",
                  "--minimum-report-level",
                  "note",
                ]),
          ];
    const result = yield* runner
      .run({
        command: input.command,
        args,
        cwd: input.cwd,
        env: { ...process.env, NO_COLOR: "1" },
        timeout: 60_000,
        maxOutputBytes: 4_000_000,
        outputMode: "error",
        timeoutBehavior: "error",
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new AnalyzerExecutionError({
              ...input,
              category:
                cause._tag === "ProcessTimeoutError"
                  ? "timeout"
                  : cause._tag === "ProcessOutputLimitError"
                    ? "output"
                    : "spawn",
              cause,
            }),
        ),
      );
    if (result.code === null || result.code > 1 || result.timedOut) {
      return yield* new AnalyzerExecutionError({
        ...input,
        category: "exit",
        cause: new Error("Analyzer did not finish successfully"),
      });
    }
    if (
      result.stdoutTruncated ||
      result.stderrTruncated ||
      result.stdoutInvalidUtf8 ||
      result.stderrInvalidUtf8
    ) {
      return yield* new AnalyzerExecutionError({
        ...input,
        category: "output",
        cause: new Error("Incomplete analyzer output"),
      });
    }
    const diagnostics = yield* Effect.try({
      try: () =>
        input.tool === "biome"
          ? normalizeBiome(input, result.stdout, paths)
          : input.operation === "format"
            ? normalizeFormat(input, result.stdout, paths)
            : normalizeMago(input, result.stdout, paths),
      catch: (cause) => new AnalyzerExecutionError({ ...input, category: "report", cause }),
    });
    if (input.operation === "format" && result.code !== 0 && diagnostics.length === 0) {
      return yield* new AnalyzerExecutionError({
        ...input,
        category: "exit",
        cause: new Error("Formatter failed without a formatting diff"),
      });
    }
    return {
      diagnostics,
      exitCode: result.code,
      status: diagnostics.length > 0 ? "findings" : "passed",
    } satisfies AnalyzerExecutionResult;
  });
  return AnalyzerExecution.of({ run });
});

export const layer = Layer.effect(AnalyzerExecution, make);
