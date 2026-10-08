import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

export const MONOLITH_CONFIG_FILE_NAME = ".t3/monolith.json";
export const LEGACY_MONOLITH_CONFIG_FILE_NAME = "t3.monolith.json";

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

export const MonolithMagoDocker = Schema.Struct({
  service: TrimmedNonEmptyString.check(
    Schema.isMaxLength(100),
    Schema.makeFilter((value: string) => /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(value), {
      expected: "a Docker Compose service name",
    }),
  ),
  composeDirectory: Schema.optional(MonolithAreaPath),
  composeFiles: Schema.optional(
    Schema.Array(MonolithAreaPath).check(Schema.isMinLength(1), Schema.isMaxLength(32)),
  ),
  containerPath: Schema.optional(
    TrimmedNonEmptyString.check(
      Schema.isMaxLength(1024),
      Schema.makeFilter(
        (value: string) =>
          value === "/" ||
          (value.startsWith("/") &&
            !value.includes("\\") &&
            !value.includes("\0") &&
            value
              .slice(1)
              .split("/")
              .every((part) => part.length > 0 && part !== "." && part !== "..")),
        { expected: "an absolute POSIX container directory without traversal" },
      ),
    ),
  ),
  binary: Schema.optional(
    TrimmedNonEmptyString.check(
      Schema.isMaxLength(1024),
      Schema.makeFilter(
        (value: string) =>
          /^[a-zA-Z0-9_/.][a-zA-Z0-9_./-]*$/.test(value) &&
          value
            .replace(/^\//, "")
            .split("/")
            .every((part) => part.length > 0 && part !== "." && part !== ".."),
        { expected: "a POSIX executable path without shell syntax or traversal" },
      ),
    ),
  ),
});
export type MonolithMagoDocker = typeof MonolithMagoDocker.Type;

export const MonolithDoctrineQueryThresholds = Schema.Struct({
  warning: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  error: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
}).check(
  Schema.makeFilter((value) => value.warning < value.error, {
    expected: "a query warning threshold below the error threshold",
  }),
);
export type MonolithDoctrineQueryThresholds = typeof MonolithDoctrineQueryThresholds.Type;

export const MonolithCommentMarker = Schema.Struct({
  marker: TrimmedNonEmptyString.check(
    Schema.isMaxLength(128),
    Schema.makeFilter(
      (value: string) =>
        !Array.from(value).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127),
      {
        expected: "a single-line comment marker",
      },
    ),
  ),
  severity: Schema.Literals(["info", "warning", "error", "reference"]),
});
export type MonolithCommentMarker = typeof MonolithCommentMarker.Type;
export const MonolithCommentMarkers = Schema.Array(MonolithCommentMarker).check(
  Schema.isMaxLength(32),
  Schema.makeFilter((rules) => new Set(rules.map((rule) => rule.marker)).size === rules.length, {
    expected: "unique comment markers",
  }),
);

export const MonolithArea = Schema.Struct({
  id: TrimmedNonEmptyString.check(Schema.isMaxLength(1100)),
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  path: MonolithAreaPath,
  kind: Schema.Literals(["php", "react", "folder"]),
  enabled: Schema.optional(Schema.Boolean),
  magoDocker: Schema.optional(MonolithMagoDocker),
  doctrineQueryThresholds: Schema.optional(MonolithDoctrineQueryThresholds),
  commentMarkers: Schema.optional(MonolithCommentMarkers),
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

export const MonolithAnalyzerTool = Schema.Literals(["mago", "biome", "eslint", "depcruise"]);
export const MonolithAnalyzerOperation = Schema.Literals(["format", "analyze", "guard", "check"]);
export const MonolithAnalyzerDiagnostic = Schema.Struct({
  path: Schema.String,
  line: Schema.optional(Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1))),
  column: Schema.optional(Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1))),
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
export const MonolithSourceAnnotation = Schema.Struct({
  marker: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  severity: Schema.Literals(["info", "warning", "error", "reference"]),
  message: Schema.String.check(Schema.isMaxLength(4096)),
  path: MonolithAreaPath,
  line: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1)),
  column: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1)),
});
export type MonolithSourceAnnotation = typeof MonolithSourceAnnotation.Type;
export const MonolithSymbolMetadata = Schema.Struct({
  symbol: TrimmedNonEmptyString.check(Schema.isMaxLength(4096)),
  kind: Schema.Literals(["class", "interface", "trait", "enum", "method"]),
  path: MonolithAreaPath,
  line: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1)),
  column: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1)),
  annotations: Schema.Array(MonolithSourceAnnotation).check(Schema.isMaxLength(128)),
});
export type MonolithSymbolMetadata = typeof MonolithSymbolMetadata.Type;
export const MonolithAnnotationSite = Schema.Struct({
  symbol: TrimmedNonEmptyString.check(Schema.isMaxLength(4096)),
  targetSymbol: TrimmedNonEmptyString.check(Schema.isMaxLength(4096)),
  kind: Schema.Literals([
    "declaration",
    "implementation",
    "call",
    "new",
    "extends",
    "implements",
    "type",
  ]),
  path: MonolithAreaPath,
  line: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1)),
  column: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1)),
  endLine: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1)),
  endColumn: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1)),
  annotations: Schema.Array(MonolithSourceAnnotation).check(Schema.isMaxLength(128)),
});
export type MonolithAnnotationSite = typeof MonolithAnnotationSite.Type;
export const MonolithEntryChains = Schema.Struct({
  commentColumnEncoding: Schema.optional(Schema.Literal("utf8_bytes")),
  symbolMetadata: Schema.optional(
    Schema.Array(MonolithSymbolMetadata).check(Schema.isMaxLength(4096)),
  ),
  annotationSites: Schema.optional(
    Schema.Array(MonolithAnnotationSite).check(Schema.isMaxLength(4096)),
  ),
  status: MonolithInsightStatus,
  message: Schema.optional(Schema.String),
  targets: Schema.Array(MonolithEntryTarget),
});
export type MonolithEntryChains = typeof MonolithEntryChains.Type;

export const MonolithEffectiveDoctrineQueryThresholds = Schema.Struct({
  warning: Schema.Number.check(
    Schema.isInt(),
    Schema.isGreaterThanOrEqualTo(0),
    Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
  ),
  error: Schema.Number.check(
    Schema.isInt(),
    Schema.isGreaterThanOrEqualTo(0),
    Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
  ),
}).check(
  Schema.makeFilter((value) => value.warning <= value.error, {
    expected: "ordered query thresholds",
  }),
);
export const MonolithDoctrineQueryThresholdsSource = Schema.Struct({
  kind: Schema.Literals(["extension", "default", "override", "unresolved"]),
  path: Schema.optional(MonolithAreaPath),
  message: Schema.optional(Schema.String.check(Schema.isMaxLength(4096))),
});
export type MonolithDoctrineQueryThresholdsSource =
  typeof MonolithDoctrineQueryThresholdsSource.Type;
export const MonolithCheckFileResult = Schema.Struct({
  doctrineQueryThresholds: Schema.optional(MonolithEffectiveDoctrineQueryThresholds),
  doctrineQueryThresholdsSource: Schema.optional(MonolithDoctrineQueryThresholdsSource),
  areaId: Schema.NullOr(Schema.String),
  diagnostics: Schema.Array(MonolithAnalyzerDiagnostic),
  runs: Schema.Array(MonolithAnalyzerRun),
  queryBudget: Schema.optional(MonolithQueryBudget),
  entryChains: Schema.optional(MonolithEntryChains),
  revision: Schema.String,
});
export type MonolithCheckFileResult = typeof MonolithCheckFileResult.Type;
export const MonolithIndexInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  areaId: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(1100))),
  force: Schema.optional(Schema.Boolean),
});
export type MonolithIndexInput = typeof MonolithIndexInput.Type;
export const MonolithIndexStatusInput = Schema.Struct({ cwd: TrimmedNonEmptyString });
export type MonolithIndexStatusInput = typeof MonolithIndexStatusInput.Type;
export const MonolithIndexStatus = Schema.Struct({
  areas: Schema.Array(
    Schema.Struct({
      areaId: TrimmedNonEmptyString,
      status: Schema.Literals(["idle", "indexing", "ready", "stale", "failed"]),
      fileCount: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
      revision: Schema.optional(Schema.String),
      message: Schema.optional(Schema.String),
    }),
  ),
});
export type MonolithIndexStatus = typeof MonolithIndexStatus.Type;

export const MonolithAnalyzerScript = Schema.Struct({
  name: Schema.String,
  operation: Schema.Literals(["format", "analyze", "guard", "lint", "check", "references"]),
  command: Schema.String,
  configPath: Schema.optional(Schema.String),
  sourcePaths: Schema.optional(Schema.Array(Schema.String)),
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
