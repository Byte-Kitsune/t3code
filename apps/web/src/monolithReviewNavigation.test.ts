// @vitest-environment jsdom
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, RunId, ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import { openMonolithReview, useMonolithReviewNavigation } from "./monolithReviewNavigation";
import { selectThreadDiffPanelSelection, useDiffPanelStore } from "./diffPanelStore";
import { selectThreadRightPanelState, useRightPanelStore } from "./rightPanelStore";

const draft = scopeThreadRef(EnvironmentId.make("local"), ThreadId.make("draft-thread"));
const saved = scopeThreadRef(EnvironmentId.make("local"), ThreadId.make("saved-thread"));
beforeEach(() => {
  useMonolithReviewNavigation.setState({ byThreadKey: {} });
  useDiffPanelStore.setState({ byThreadKey: {}, branchBaseRefByThreadKey: {} });
  useRightPanelStore.setState({
    byThreadKey: {},
    userActionRevisionByThreadKey: {},
    closeRevisionByThreadKey: {},
  });
});
describe("direct PR review navigation", () => {
  it("opens a draft workspace without needing a saved server thread and leaves other threads unchanged", () => {
    useRightPanelStore.getState().open(saved, "files");
    openMonolithReview(draft);
    const state = selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, draft);
    expect(state.isOpen).toBe(true);
    expect(state.activeSurfaceId).toBe("diff");
    expect(useMonolithReviewNavigation.getState().byThreadKey[scopedThreadKey(draft)]).toBe(true);
    expect(
      selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, saved).activeSurfaceId,
    ).toBe("files");
  });
  it("switches from an old turn or PR view back to Changes while preserving the configured comparison branch", () => {
    useDiffPanelStore.getState().selectBranchBaseRef(saved, "origin/release");
    useDiffPanelStore.getState().selectTurn(saved, RunId.make("old-turn"));
    openMonolithReview(saved);
    openMonolithReview(saved, false);
    expect(useMonolithReviewNavigation.getState().byThreadKey[scopedThreadKey(saved)]).toBe(false);
    expect(selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, saved)).toEqual(
      { kind: "branch", baseRef: "origin/release" },
    );
  });
});
