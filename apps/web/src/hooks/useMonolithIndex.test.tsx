// @vitest-environment jsdom
import { EnvironmentId, type MonolithConfig } from "@t3tools/contracts";
import { act, useLayoutEffect } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
const doubles = vi.hoisted(() => ({
  allowed: true,
  index: vi.fn(),
  refresh: vi.fn(),
  invalidate: vi.fn(),
  data: { areas: [] } as { areas: { areaId: string; status: string; revision?: string }[] },
}));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: () => doubles.allowed,
  useAtomSet: () => doubles.invalidate,
}));
vi.mock("~/state/monolithAnalyzers", () => ({
  monolithAnalyzerEnvironment: {
    index: { permissionAtom: () => "permission" },
    indexStatus: () => "status",
    checkRevision: () => "revision",
  },
}));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => doubles.index }));
vi.mock("~/state/query", () => ({
  useEnvironmentQuery: () => ({ data: doubles.data, refresh: doubles.refresh }),
}));
import { useMonolithIndex } from "./useMonolithIndex";
const environmentId = EnvironmentId.make("local");
const config: MonolithConfig = {
  version: 1,
  initialized: true,
  areas: [{ id: "api", name: "API", path: "api", kind: "php" }],
};
let renderer: ReactTestRenderer | undefined;
function Probe({ mutation = null }: { mutation?: string | null }) {
  const state = useMonolithIndex(environmentId, "/repo", config, mutation);
  useLayoutEffect(() => void state);
  return null;
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  doubles.allowed = true;
  doubles.data = { areas: [] };
  doubles.index.mockReset().mockResolvedValue({ _tag: "Success" });
  doubles.refresh.mockReset();
  doubles.invalidate.mockReset();
});
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
describe("project indexing scheduling", () => {
  it("starts without waiting for analysis and debounces workspace updates", async () => {
    await act(async () => {
      renderer = create(<Probe />);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(doubles.index).toHaveBeenCalledTimes(1);
    await act(async () => renderer!.update(<Probe mutation="one" />));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
      renderer!.update(<Probe mutation="two" />);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(799);
    });
    expect(doubles.index).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(doubles.index).toHaveBeenCalledTimes(2);
  });
  it("does not execute tools when permission is missing and cancels retired timers", async () => {
    doubles.allowed = false;
    await act(async () => {
      renderer = create(<Probe />);
      await vi.advanceTimersByTimeAsync(31_000);
    });
    expect(doubles.index).not.toHaveBeenCalled();
    doubles.allowed = true;
    await act(async () => renderer!.update(<Probe />));
    act(() => renderer!.unmount());
    renderer = undefined;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(31_000);
    });
    expect(doubles.index).not.toHaveBeenCalled();
  });
  it("keeps open-file results through unchanged periodic index validation", async () => {
    doubles.data = { areas: [{ areaId: "api", status: "ready", revision: "same" }] };
    await act(async () => {
      renderer = create(<Probe />);
    });
    doubles.data = { areas: [{ areaId: "api", status: "indexing" }] };
    await act(async () => renderer!.update(<Probe />));
    doubles.data = { areas: [{ areaId: "api", status: "ready", revision: "same" }] };
    await act(async () => renderer!.update(<Probe />));
    expect(doubles.invalidate).not.toHaveBeenCalled();
    doubles.data = { areas: [{ areaId: "api", status: "stale", revision: "changed" }] };
    await act(async () => renderer!.update(<Probe />));
    doubles.data = { areas: [{ areaId: "api", status: "indexing" }] };
    await act(async () => renderer!.update(<Probe />));
    doubles.data = { areas: [{ areaId: "api", status: "ready", revision: "changed" }] };
    await act(async () => renderer!.update(<Probe />));
    expect(doubles.invalidate).toHaveBeenCalledTimes(1);
  });
  it("invalidates open-file results after a dependent source revision changes", async () => {
    doubles.data = { areas: [{ areaId: "api", status: "ready", revision: "old" }] };
    await act(async () => {
      renderer = create(<Probe />);
    });
    doubles.data = { areas: [{ areaId: "api", status: "ready", revision: "new" }] };
    await act(async () => renderer!.update(<Probe />));
    expect(doubles.invalidate).toHaveBeenCalledTimes(1);
  });
});
