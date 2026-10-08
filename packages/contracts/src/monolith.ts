import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

export const MONOLITH_CONFIG_FILE_NAME = "t3.monolith.json";

const MonolithAreaPath = TrimmedNonEmptyString.check(
  Schema.isMaxLength(1024),
  Schema.makeFilter(
    (value: string) =>
      value === "." ||
      (!value.startsWith("/") &&
        !value.includes("\\") &&
        !value.includes(":") &&
        !value.includes("\0") &&
        value.split("/").every((part) => part.length > 0 && part !== "." && part !== "..")),
    { expected: "a repository-relative path without traversal" },
  ),
);

export const MonolithArea = Schema.Struct({
  id: TrimmedNonEmptyString.check(Schema.isMaxLength(1100)),
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  path: MonolithAreaPath,
  kind: Schema.Literals(["php", "react", "folder"]),
  enabled: Schema.optional(Schema.Boolean),
  entrypointPaths: Schema.optional(Schema.Array(MonolithAreaPath).check(Schema.isMaxLength(100))),
});
export type MonolithArea = typeof MonolithArea.Type;

export const MonolithConfig = Schema.Struct({
  version: Schema.Literal(1),
  initialized: Schema.Literal(true),
  areas: Schema.Array(MonolithArea),
  defaultBaseBranch: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(200))),
});
export type MonolithConfig = typeof MonolithConfig.Type;

export const MonolithSnapshot = Schema.Struct({
  config: MonolithConfig,
  configPath: TrimmedNonEmptyString,
  source: Schema.Literals(["discovered", "config"]),
});
export type MonolithSnapshot = typeof MonolithSnapshot.Type;

export const MonolithGetInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  initialize: Schema.optional(Schema.Boolean),
});
export type MonolithGetInput = typeof MonolithGetInput.Type;

export const MonolithSaveInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  config: MonolithConfig,
});
export type MonolithSaveInput = typeof MonolithSaveInput.Type;

export class MonolithRequestError extends Schema.TaggedError<MonolithRequestError>()(
  "MonolithRequestError",
  {
    operation: Schema.Literals(["get", "discover", "save"]),
    cwd: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to ${this.operation} monolith areas.`;
  }
}

export const MonolithAnalyzerTool = Schema.Literals(["mago", "biome"]);
export const MonolithAnalyzerOperation = Schema.Literals(["format", "analyze", "guard", "check"]);
export const MonolithAnalyzerDiagnostic = Schema.Struct({
  path: Schema.String,
  line: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1)),
  column: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1)),
  endLine: Schema.optional(Schema.Number),
  endColumn: Schema.optional(Schema.Number),
  severity: Schema.Literals(["error", "warning", "info"]),
  message: Schema.String,
  ruleId: Schema.String,
  tool: MonolithAnalyzerTool,
  operation: MonolithAnalyzerOperation,
});
export type MonolithAnalyzerDiagnostic = typeof MonolithAnalyzerDiagnostic.Type;
export const MonolithAnalyzerRun = Schema.Struct({
  tool: MonolithAnalyzerTool,
  operation: MonolithAnalyzerOperation,
  status: Schema.Literals(["passed", "findings", "unavailable", "failed"]),
  diagnosticCount: Schema.Number,
  message: Schema.optional(Schema.String),
});
export type MonolithAnalyzerRun = typeof MonolithAnalyzerRun.Type;
export const MonolithCheckFileInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  path: MonolithAreaPath,
});
export type MonolithCheckFileInput = typeof MonolithCheckFileInput.Type;
export const MonolithInsightStatus = Schema.Literals([
  "complete",
  "incomplete",
  "unavailable",
  "unsupported",
  "failed",
]);
export const MonolithInsightLocation = Schema.Struct({
  id: Schema.optional(Schema.String),
  serviceId: Schema.optional(Schema.String),
  symbol: Schema.String,
  path: Schema.String,
  line: Schema.optional(Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1))),
  column: Schema.optional(Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1))),
});
export const MonolithQueryMethod = Schema.Struct({
  ...MonolithInsightLocation.fields,
  lowerBound: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  upperBound: Schema.NullOr(Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))),
  unknown: Schema.Array(Schema.String),
  cycles: Schema.Array(Schema.String),
});
export const MonolithQueryBudget = Schema.Struct({
  status: MonolithInsightStatus,
  message: Schema.optional(Schema.String),
  methods: Schema.Array(MonolithQueryMethod),
});
export type MonolithQueryBudget = typeof MonolithQueryBudget.Type;
export const MonolithEntryTarget = Schema.Struct({
  ...MonolithInsightLocation.fields,
  directCallers: Schema.Array(MonolithInsightLocation),
  entries: Schema.Array(
    Schema.Struct({
      entry: MonolithInsightLocation,
      chain: Schema.Array(MonolithInsightLocation),
      evidence: Schema.Literals(["call", "wiring"]),
      complete: Schema.Boolean,
    }),
  ),
  unknown: Schema.Array(Schema.String),
  truncated: Schema.Boolean,
  cycles: Schema.optional(Schema.Array(Schema.String)),
});
export const MonolithEntryChains = Schema.Struct({
  status: MonolithInsightStatus,
  message: Schema.optional(Schema.String),
  targets: Schema.Array(MonolithEntryTarget),
});
export type MonolithEntryChains = typeof MonolithEntryChains.Type;

export const MonolithCheckFileResult = Schema.Struct({
  areaId: Schema.NullOr(Schema.String),
  diagnostics: Schema.Array(MonolithAnalyzerDiagnostic),
  runs: Schema.Array(MonolithAnalyzerRun),
  queryBudget: Schema.optional(MonolithQueryBudget),
  entryChains: Schema.optional(MonolithEntryChains),
  revision: Schema.String,
});
export type MonolithCheckFileResult = typeof MonolithCheckFileResult.Type;
export const MonolithAnalyzerScript = Schema.Struct({
  name: Schema.String,
  operation: Schema.Literals(["format", "analyze", "guard", "lint", "check", "references"]),
  command: Schema.String,
  configPath: Schema.optional(Schema.String),
});
export const MonolithAnalyzerInstallation = Schema.Struct({
  tool: MonolithAnalyzerTool,
  manifestPath: Schema.String,
  workingDirectory: Schema.String,
  binaryPath: Schema.String,
  available: Schema.Boolean,
  configPath: Schema.optional(Schema.String),
  scripts: Schema.Array(MonolithAnalyzerScript),
  symfonyWiring: Schema.Boolean,
  doctrineQueryBudget: Schema.optional(
    Schema.Struct({ autoloadPath: Schema.String, available: Schema.Boolean }),
  ),
  architectureGraph: Schema.optional(
    Schema.Struct({ autoloadPath: Schema.String, available: Schema.Boolean }),
  ),
  symfonyWiringReference: Schema.optional(
    Schema.Struct({
      generatorPath: Schema.String,
      generatorAvailable: Schema.Boolean,
      referencePath: Schema.String,
      referenceAvailable: Schema.Boolean,
      autoloadPath: Schema.String,
      autoloadAvailable: Schema.Boolean,
    }),
  ),
});
export const MonolithAnalyzerArea = Schema.Struct({
  areaId: Schema.String,
  tools: Schema.Array(MonolithAnalyzerInstallation),
  warnings: Schema.Array(
    Schema.Struct({
      path: Schema.String,
      reason: Schema.Literals(["invalid_manifest", "unsafe_path", "unsupported_script"]),
    }),
  ),
});
export const MonolithAnalyzersResult = Schema.Array(MonolithAnalyzerArea);
export type MonolithAnalyzersResult = typeof MonolithAnalyzersResult.Type;
export class MonolithAnalyzerRequestError extends Schema.TaggedError<MonolithAnalyzerRequestError>()(
  "MonolithAnalyzerRequestError",
  {
    operation: Schema.Literals(["discover", "check", "references"]),
    cwd: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to ${this.operation} monolith analyzers.`;
  }
}

export const MonolithGenerateReferencesInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  areaId: TrimmedNonEmptyString,
});
export const MonolithGenerateReferencesResult = Schema.Struct({
  areaId: Schema.String,
  path: Schema.String,
});
