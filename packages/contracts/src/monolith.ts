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
