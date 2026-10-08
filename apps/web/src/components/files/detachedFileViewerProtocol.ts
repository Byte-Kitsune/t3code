import {
  EditorId,
  EnvironmentId,
  ResolvedKeybindingsConfig,
  ScopedThreadRef,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { DraftId, type ComposerContextAddOptions } from "~/composerDraftStore";
import { ReviewCommentContextSchema, type ReviewCommentContext } from "~/reviewCommentContext";
import type { ComponentProps } from "react";
import type FilePreviewPanel from "./FilePreviewPanel";
import type { RightPanelSurface } from "~/rightPanelStore";

export type DetachedFileViewerContext = Pick<
  ComponentProps<typeof FilePreviewPanel>,
  | "environmentId"
  | "cwd"
  | "projectName"
  | "threadRef"
  | "composerDraftTarget"
  | "keybindings"
  | "availableEditors"
  | "workspaceMutationId"
>;
export type DetachedFileSurface = Extract<RightPanelSurface, { kind: "file" | "files" }>;
export interface DetachedFileViewerSnapshot {
  surfaces: DetachedFileSurface[];
  activeSurfaceId: string | null;
  drafts: ReadonlyArray<{ relativePath: string; contents: string }>;
}
export type DetachedFileViewerMessage =
  | {
      type:
        | "t3-file-viewer:ready"
        | "t3-file-viewer:initialized"
        | "t3-file-viewer:snapshot-request"
        | "t3-file-viewer:dock-request"
        | "t3-file-viewer:allow-close"
        | "t3-file-viewer:resume";
    }
  | {
      type: "t3-file-viewer:initialize";
      context: DetachedFileViewerContext;
      snapshot: DetachedFileViewerSnapshot;
    }
  | { type: "t3-file-viewer:snapshot"; snapshot: DetachedFileViewerSnapshot }
  | { type: "t3-file-viewer:state"; snapshot: DetachedFileViewerSnapshot }
  | { type: "t3-file-viewer:open-file"; relativePath: string; line?: number }
  | { type: "t3-file-viewer:workspace-changed"; workspaceMutationId: string | null }
  | {
      type: "t3-file-viewer:add-review-comment";
      comment: ReviewCommentContext;
      options?: ComposerContextAddOptions;
    }
  | { type: "t3-file-viewer:remove-review-comment"; commentId: string };

const contextSchema = Schema.Struct({
  environmentId: EnvironmentId,
  cwd: Schema.String,
  projectName: Schema.String,
  threadRef: ScopedThreadRef,
  composerDraftTarget: Schema.Union([ScopedThreadRef, DraftId]),
  keybindings: ResolvedKeybindingsConfig,
  availableEditors: Schema.Array(EditorId),
  workspaceMutationId: Schema.NullOr(Schema.String),
});
const isContext = Schema.is(contextSchema);
const isReviewComment = Schema.is(ReviewCommentContextSchema);
const isCommentOptions = Schema.is(
  Schema.Struct({
    appendReference: Schema.optional(Schema.Boolean),
    allowDuplicateReference: Schema.optional(Schema.Boolean),
    insertAtCaret: Schema.optional(Schema.Boolean),
  }),
);
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

export function isDetachedFileViewerSnapshot(value: unknown): value is DetachedFileViewerSnapshot {
  if (!isRecord(value) || !Array.isArray(value.surfaces) || !Array.isArray(value.drafts))
    return false;
  if (value.activeSurfaceId !== null && typeof value.activeSurfaceId !== "string") return false;
  if (
    !value.surfaces.every(
      (surface: unknown) =>
        isRecord(surface) &&
        ((surface.kind === "files" && surface.id === "files") ||
          (surface.kind === "file" &&
            typeof surface.id === "string" &&
            surface.id === `file:${surface.relativePath}` &&
            typeof surface.relativePath === "string" &&
            surface.relativePath.length > 0 &&
            surface.attachment === undefined &&
            (surface.revealLine === null ||
              (typeof surface.revealLine === "number" &&
                Number.isInteger(surface.revealLine) &&
                surface.revealLine > 0)) &&
            typeof surface.revealRequestId === "number" &&
            Number.isSafeInteger(surface.revealRequestId) &&
            surface.revealRequestId >= 0)),
    )
  )
    return false;
  if (
    !value.drafts.every(
      (draft: unknown) =>
        isRecord(draft) &&
        typeof draft.relativePath === "string" &&
        draft.relativePath.length > 0 &&
        typeof draft.contents === "string",
    )
  )
    return false;
  const ids = value.surfaces.map((surface: Record<string, unknown>) => surface.id);
  return (
    new Set(ids).size === ids.length &&
    (value.activeSurfaceId === null || ids.includes(value.activeSurfaceId))
  );
}

export function isDetachedFileViewerMessage(value: unknown): value is DetachedFileViewerMessage {
  if (!isRecord(value)) return false;
  switch (value.type) {
    case "t3-file-viewer:ready":
    case "t3-file-viewer:initialized":
    case "t3-file-viewer:snapshot-request":
    case "t3-file-viewer:dock-request":
    case "t3-file-viewer:allow-close":
    case "t3-file-viewer:resume":
      return true;
    case "t3-file-viewer:initialize":
      return (
        isContext(value.context) &&
        value.context.cwd.length > 0 &&
        value.context.environmentId === value.context.threadRef.environmentId &&
        isDetachedFileViewerSnapshot(value.snapshot)
      );
    case "t3-file-viewer:snapshot":
      return isDetachedFileViewerSnapshot(value.snapshot);
    case "t3-file-viewer:state":
      return isDetachedFileViewerSnapshot(value.snapshot);
    case "t3-file-viewer:open-file":
      return (
        typeof value.relativePath === "string" &&
        value.relativePath.length > 0 &&
        (value.line === undefined ||
          (typeof value.line === "number" && Number.isInteger(value.line) && value.line > 0))
      );
    case "t3-file-viewer:workspace-changed":
      return value.workspaceMutationId === null || typeof value.workspaceMutationId === "string";
    case "t3-file-viewer:add-review-comment":
      return (
        isReviewComment(value.comment) &&
        (value.options === undefined || isCommentOptions(value.options))
      );
    case "t3-file-viewer:remove-review-comment":
      return typeof value.commentId === "string" && value.commentId.length > 0;
    default:
      return false;
  }
}

export function detachedFileViewerTargetOrigin(origin: string): string {
  return origin === "null" ? "*" : origin;
}
