import * as Schema from "effect/Schema";
import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { MonolithCheckFileResult } from "./monolith.ts";

export const MonolithReviewStartInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  baseRef: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(200))),
  includeWorkingTree: Schema.optional(Schema.Boolean),
});
export type MonolithReviewStartInput = typeof MonolithReviewStartInput.Type;

export const MonolithReviewGetInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  runId: TrimmedNonEmptyString.check(Schema.isMaxLength(100)),
  includeDetails: Schema.optional(Schema.Boolean),
});
export type MonolithReviewGetInput = typeof MonolithReviewGetInput.Type;
export const MonolithReviewCancelInput = MonolithReviewGetInput;
export type MonolithReviewCancelInput = typeof MonolithReviewCancelInput.Type;

export const MonolithReviewFile = Schema.Struct({
  path: TrimmedNonEmptyString,
  oldPath: Schema.optional(TrimmedNonEmptyString),
  status: Schema.Literals([
    "added",
    "modified",
    "deleted",
    "renamed",
    "copied",
    "typechanged",
    "untracked",
  ]),
  patch: Schema.String,
  patchHash: Schema.String,
  patchTruncated: Schema.Boolean,
  fileHash: Schema.optional(Schema.String),
  checkStatus: Schema.Literals(["pending", "running", "completed", "failed", "skipped", "stale"]),
  checks: Schema.optional(MonolithCheckFileResult),
  checksTruncated: Schema.optional(Schema.Boolean),
  message: Schema.optional(Schema.String),
});
export type MonolithReviewFile = typeof MonolithReviewFile.Type;

export const MonolithReviewAiPackage = Schema.Struct({
  prompt: Schema.String,
  text: Schema.String,
  omissions: Schema.Array(Schema.String),
  complete: Schema.Boolean,
});
export type MonolithReviewAiPackage = typeof MonolithReviewAiPackage.Type;

export const MonolithReviewGroup = Schema.Struct({
  areaId: Schema.NullOr(Schema.String),
  name: Schema.String,
  path: Schema.String,
  kind: Schema.Literals(["php", "react", "folder", "other"]),
  files: Schema.Array(MonolithReviewFile),
  aiPackage: Schema.optional(MonolithReviewAiPackage),
});
export type MonolithReviewGroup = typeof MonolithReviewGroup.Type;

export const MonolithReviewRun = Schema.Struct({
  runId: TrimmedNonEmptyString,
  cwd: TrimmedNonEmptyString,
  status: Schema.Literals(["queued", "running", "completed", "failed", "cancelled", "stale"]),
  // Git provenance is resolved by the worker; queued runs have empty commit fields.
  baseRef: Schema.String,
  baseCommit: Schema.String,
  mergeBase: Schema.String,
  headCommit: Schema.String,
  worktreeIdentity: Schema.String,
  includeWorkingTree: Schema.Boolean,
  revision: Schema.String,
  createdAt: Schema.String,
  updatedAt: Schema.String,
  groups: Schema.Array(MonolithReviewGroup),
  coverage: Schema.Struct({
    totalFiles: NonNegativeInt,
    checkedFiles: NonNegativeInt,
    omittedFiles: NonNegativeInt,
    truncatedPatches: NonNegativeInt,
  }),
  message: Schema.optional(Schema.String),
});
export type MonolithReviewRun = typeof MonolithReviewRun.Type;

export class MonolithReviewRequestError extends Schema.TaggedError<MonolithReviewRequestError>()(
  "MonolithReviewRequestError",
  {
    operation: Schema.Literals(["start", "get", "cancel"]),
    cwd: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to ${this.operation} monolith PR review.`;
  }
}
