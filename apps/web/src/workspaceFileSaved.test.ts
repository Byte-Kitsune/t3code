// @vitest-environment jsdom
import { EnvironmentId } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { notifyWorkspaceFileSaved, subscribeWorkspaceFileSaved } from "./workspaceFileSaved";
const workspace = { environmentId: EnvironmentId.make("local"), cwd: "/repo" };
afterEach(() => vi.unstubAllGlobals());
describe("saved workspace notifications", () => {
  it("delivers local writes when cross-window messaging is unavailable and unregisters listeners", () => {
    vi.stubGlobal("BroadcastChannel", undefined);
    const listener = vi.fn();
    const unsubscribe = subscribeWorkspaceFileSaved(listener);
    notifyWorkspaceFileSaved(workspace);
    expect(listener).toHaveBeenCalledWith(workspace);
    unsubscribe();
    notifyWorkspaceFileSaved(workspace);
    expect(listener).toHaveBeenCalledOnce();
  });
  it("receives a saved workspace from another renderer and rejects malformed messages", () => {
    let receive: ((event: MessageEvent<unknown>) => void) | undefined;
    const close = vi.fn();
    vi.stubGlobal(
      "BroadcastChannel",
      class {
        addEventListener(_type: string, listener: (event: MessageEvent<unknown>) => void) {
          receive = listener;
        }
        close = close;
      },
    );
    const listener = vi.fn();
    const unsubscribe = subscribeWorkspaceFileSaved(listener);
    receive!(new MessageEvent("message", { data: { cwd: "/repo" } }));
    expect(listener).not.toHaveBeenCalled();
    receive!(new MessageEvent("message", { data: workspace }));
    expect(listener).toHaveBeenCalledWith(workspace);
    unsubscribe();
    expect(close).toHaveBeenCalledOnce();
  });
  it("never turns a confirmed write into a failure when browser channel access is restricted", () => {
    vi.stubGlobal(
      "BroadcastChannel",
      class extends EventTarget {
        constructor() {
          super();
          throw new Error("restricted");
        }
      },
    );
    const listener = vi.fn();
    const unsubscribe = subscribeWorkspaceFileSaved(listener);
    expect(() => notifyWorkspaceFileSaved(workspace)).not.toThrow();
    expect(listener).toHaveBeenCalledOnce();
    unsubscribe();
    vi.stubGlobal(
      "BroadcastChannel",
      class {
        postMessage() {
          throw new Error("post restricted");
        }
        close() {
          throw new Error("close restricted");
        }
      },
    );
    expect(() => notifyWorkspaceFileSaved(workspace)).not.toThrow();
  });
});
