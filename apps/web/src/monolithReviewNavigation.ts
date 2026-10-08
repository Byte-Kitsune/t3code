import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { create } from "zustand";
import { useDiffPanelStore } from "./diffPanelStore";
import { useRightPanelStore } from "./rightPanelStore";

export const useMonolithReviewNavigation = create<{
  byThreadKey: Readonly<Record<string, boolean>>;
  setReview: (ref: ScopedThreadRef, enabled: boolean) => void;
}>((set) => ({
  byThreadKey: {},
  setReview: (ref, enabled) =>
    set((state) => ({ byThreadKey: { ...state.byThreadKey, [scopedThreadKey(ref)]: enabled } })),
}));

/** Opening a review selects the view; analysis still needs the explicit Start button. */
export function openMonolithReview(ref: ScopedThreadRef, review = true): void {
  useMonolithReviewNavigation.getState().setReview(ref, review);
  useDiffPanelStore.getState().selectGitScope(ref, "branch");
  useRightPanelStore.getState().open(ref, "diff");
}
