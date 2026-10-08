// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { beforeEach, afterEach, describe, expect, it, vi } from "vite-plus/test";
vi.mock("../../state/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/session")>()),
  useEnvironmentScope: () => false,
  readEnvironmentScope: () => false,
}));
vi.mock("../../state/use-orchestration-command", () => ({
  useOrchestrationCommand: () => vi.fn(),
}));
vi.mock("~/hooks/useThreadActionMenu", () => ({
  useThreadActionMenu: () => ({ openMenu: vi.fn(), closeMenu: vi.fn() }),
}));
import { ChatHeader } from "./ChatHeader";
import { openMonolithReview, useMonolithReviewNavigation } from "../../monolithReviewNavigation";
import { selectThreadRightPanelState, useRightPanelStore } from "../../rightPanelStore";

const environmentId = EnvironmentId.make("local");
const ref = scopeThreadRef(environmentId, ThreadId.make("draft-thread"));
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  useMonolithReviewNavigation.setState({ byThreadKey: {} });
  useRightPanelStore.setState({ byThreadKey: {} });
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
describe("PR review entry in chat header", () => {
  it("opens review directly from an unsent draft header", async () => {
    await act(async () => {
      root.render(
        <ChatHeader
          activeThreadEnvironmentId={environmentId}
          activeThreadId={ref.threadId}
          activeThreadTitle="New chat"
          activeProject={null}
          isServerThread={false}
          rightPanelOpen={false}
          onNewThreadInProject={() => undefined}
          onOpenPrReview={() => openMonolithReview(ref)}
        />,
      );
    });
    const entry = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "PR review",
    );
    expect(entry).toBeDefined();
    await act(async () => {
      entry!.click();
    });
    expect(useMonolithReviewNavigation.getState().byThreadKey[scopedThreadKey(ref)]).toBe(true);
    expect(
      selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, ref).activeSurfaceId,
    ).toBe("diff");
  });
});
