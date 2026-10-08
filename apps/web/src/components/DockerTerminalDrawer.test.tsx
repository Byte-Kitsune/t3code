import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ThreadId, type MonolithArea } from "@t3tools/contracts";
import type { ThreadTerminalDrawerProps } from "./ThreadTerminalDrawer";
const state = vi.hoisted(() => ({ areas: [] as MonolithArea[], close: vi.fn(), allowed: true }));
vi.mock("~/hooks/useMonolithAreas", () => ({
  useMonolithAreas: () => ({ config: { areas: state.areas } }),
}));
vi.mock("~/state/session", () => ({ useEnvironmentScope: () => state.allowed }));
vi.mock("~/state/terminal", () => ({ terminalEnvironment: { close: "close" } }));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => state.close }));
vi.mock("~/hooks/useLocalStorage", async () => {
  const { useState } = await import("react");
  return { useLocalStorage: (_key: string, initial: readonly string[]) => useState(initial) };
});
vi.mock("./ThreadTerminalDrawer", () => ({
  TerminalViewport: (props: Record<string, unknown>) => <div data-viewport={props} />,
  NormalThreadTerminalDrawer: () => <div data-normal-terminal />,
}));
import DockerTerminalDrawer from "./DockerTerminalDrawer";
const props: ThreadTerminalDrawerProps = {
  threadRef: { environmentId: EnvironmentId.make("remote"), threadId: ThreadId.make("thread") },
  threadId: ThreadId.make("thread"),
  cwd: "/repo",
  height: 300,
  terminalIds: ["term-1"],
  activeTerminalId: "term-1",
  terminalGroups: [],
  activeTerminalGroupId: "group",
  focusRequestId: 0,
  keybindings: [],
  onSplitTerminal: () => {},
  onSplitTerminalVertical: () => {},
  onNewTerminal: () => {},
  onActiveTerminalChange: () => {},
  onCloseTerminal: () => {},
  onHeightChange: () => {},
  onAddTerminalContext: () => {},
};
let renderer: ReactTestRenderer | undefined;
afterEach(async () => {
  if (renderer) await act(async () => renderer!.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
  state.close.mockReset();
});
function button(label: string) {
  return renderer!.root.findAllByType("button").find((item) => item.props.children === label)!;
}
describe("Docker terminal selection", () => {
  it("preserves normal terminal, opens the chosen remote service, toggles read-only logs and releases owned sessions", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    state.allowed = true;
    state.close.mockResolvedValue({ _tag: "Success" });
    state.areas = [
      { id: "php", path: "php", name: "PHP", kind: "php", magoDocker: { service: "catalog-php" } },
    ];
    await act(async () => {
      renderer = create(<DockerTerminalDrawer {...props} />);
    });
    expect(renderer!.root.findAllByProps({ "data-normal-terminal": true })).toHaveLength(1);
    await act(async () => button("PHP · catalog-php").props.onClick());
    let views = renderer!.root.findAll(
      (node) => node.type === "div" && node.props["data-viewport"],
    );
    expect(views).toHaveLength(1);
    expect(views[0]!.props["data-viewport"].compose).toEqual({ areaId: "php", mode: "shell" });
    await act(async () => button("Live logs").props.onClick());
    views = renderer!.root.findAll((node) => node.type === "div" && node.props["data-viewport"]);
    const firstLog = views.find((node) => node.props["data-viewport"].readOnly)!.props[
      "data-viewport"
    ];
    expect(firstLog.compose).toEqual({ areaId: "php", mode: "logs" });
    await act(async () => button("Live logs").props.onClick());
    expect(
      state.close.mock.calls.some(
        ([value]) =>
          value.environmentId === "remote" && value.input.terminalId === firstLog.terminalId,
      ),
    ).toBe(true);
    await act(async () => button("Live logs").props.onClick());
    views = renderer!.root.findAll((node) => node.type === "div" && node.props["data-viewport"]);
    expect(
      views.find((node) => node.props["data-viewport"].readOnly)!.props["data-viewport"].terminalId,
    ).not.toBe(firstLog.terminalId);
    await act(async () => button("Terminal").props.onClick());
    expect(renderer!.root.findAllByProps({ "data-normal-terminal": true })).toHaveLength(1);
    expect(
      state.close.mock.calls.some(
        ([value]) => value.input.terminalId.startsWith("docker-") && value.input.deleteHistory,
      ),
    ).toBe(true);
  });
});
