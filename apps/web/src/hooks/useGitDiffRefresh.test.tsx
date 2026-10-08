// @vitest-environment jsdom
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { EnvironmentId, type VcsStatusResult } from "@t3tools/contracts";
import { beforeEach, afterEach, describe, expect, it, vi } from "vite-plus/test";
const doubles = vi.hoisted(() => ({
  listener: null as ((input: { environmentId: string; cwd: string }) => void) | null,
  unsubscribe: vi.fn(),
}));
vi.mock("../workspaceFileSaved", () => ({
  subscribeWorkspaceFileSaved: (listener: typeof doubles.listener) => {
    doubles.listener = listener;
    return doubles.unsubscribe;
  },
}));
import { useGitDiffRefresh } from "./useGitDiffRefresh";
const environmentId = EnvironmentId.make("local");
const status: VcsStatusResult = {
  isRepo: true,
  hasPrimaryRemote: true,
  isDefaultRef: true,
  refName: "main",
  hasWorkingTreeChanges: false,
  workingTree: { files: [], insertions: 0, deletions: 0 },
  hasUpstream: true,
  aheadCount: 0,
  behindCount: 0,
  pr: null,
};
const refresh = vi.fn();
let renderer: ReactTestRenderer | undefined;
function Probe({
  current = status,
  enabled = true,
}: {
  current?: VcsStatusResult;
  enabled?: boolean;
}) {
  useGitDiffRefresh({ enabled, environmentId, cwd: "/repo", status: current, refresh });
  return null;
}
async function tick(ms = 200) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  refresh.mockReset();
  doubles.unsubscribe.mockReset();
  doubles.listener = null;
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
});
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
describe("live diff invalidation", () => {
  it("refreshes on reopening and local status changes without polling unchanged snapshots", async () => {
    await act(async () => {
      renderer = create(<Probe />);
    });
    await tick();
    expect(refresh).toHaveBeenCalledOnce();
    await act(async () => {
      renderer!.update(<Probe current={{ ...status }} />);
    });
    await tick(5000);
    expect(refresh).toHaveBeenCalledOnce();
    await act(async () => {
      renderer!.update(<Probe current={{ ...status, aheadCount: 1 }} />);
    });
    await tick();
    expect(refresh).toHaveBeenCalledTimes(2);
    await act(async () => {
      renderer!.update(<Probe enabled={false} />);
    });
    await act(async () => {
      renderer!.update(<Probe />);
    });
    await tick();
    expect(refresh).toHaveBeenCalledTimes(3);
  });
  it("refreshes after matching confirmed saves even when diff line counts stay identical", async () => {
    await act(async () => {
      renderer = create(<Probe />);
    });
    await tick();
    refresh.mockClear();
    doubles.listener!({ environmentId: "other", cwd: "/repo" });
    doubles.listener!({ environmentId, cwd: "/another" });
    await tick();
    expect(refresh).not.toHaveBeenCalled();
    doubles.listener!({ environmentId, cwd: "/repo" });
    doubles.listener!({ environmentId, cwd: "/repo" });
    await tick();
    expect(refresh).toHaveBeenCalledOnce();
  });
  it("skips hidden-window work, catches up when visible and cancels retired refreshes", async () => {
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    await act(async () => {
      renderer = create(<Probe />);
    });
    await tick();
    expect(refresh).not.toHaveBeenCalled();
    visibility.mockReturnValue("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    await tick();
    expect(refresh).toHaveBeenCalledOnce();
    doubles.listener!({ environmentId, cwd: "/repo" });
    act(() => renderer!.unmount());
    renderer = undefined;
    await tick();
    expect(refresh).toHaveBeenCalledOnce();
    expect(doubles.unsubscribe).toHaveBeenCalledOnce();
  });
});
