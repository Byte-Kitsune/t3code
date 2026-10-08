// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { PhpCallGraphDialog, type PhpGraphSelection } from "./PhpCallGraphDialog";

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
const target: PhpGraphSelection["targets"][number] = {
  id: "Demo::run",
  symbol: "Demo::run",
  path: "Demo.php",
  line: 3,
  directCallers: Array.from({ length: 105 }, (_, i) => ({
    symbol: `Caller::method${i}`,
    path: "src/Caller.php",
    line: i + 10,
  })),
  entries: [],
  unknown: [],
  truncated: false,
};
describe("PHP call graph navigation", () => {
  it("bounds initial usages, reveals more and opens the exact source location after closing", async () => {
    const actions: unknown[] = [];
    await act(async () =>
      root.render(
        <PhpCallGraphDialog
          selection={{ kind: "method", symbol: target.symbol, targets: [target] }}
          incomplete={true}
          onClose={() => actions.push("close")}
          onOpenFile={(path, line) => actions.push([path, line])}
        />,
      ),
    );
    expect(document.querySelector('[role="dialog"]')?.getAttribute("aria-labelledby")).toBeTruthy();
    expect(document.body.textContent).toContain("call graph is incomplete");
    expect(document.body.textContent).toContain("Showing 100 of 105 usages");
    expect(document.body.textContent).not.toContain("Caller::method104");
    const more = Array.from(document.querySelectorAll("button")).find(
      (button) => button.textContent === "Show more usages",
    )!;
    await act(async () => more.click());
    const last = Array.from(document.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Caller::method104"),
    )!;
    await act(async () => last.click());
    expect(actions).toEqual(["close", ["src/Caller.php", 114]]);
  });
  it("defers class method usages until their method group is expanded", async () => {
    await act(async () =>
      root.render(
        <PhpCallGraphDialog
          selection={{ kind: "class", symbol: "Demo", targets: [target] }}
          incomplete={false}
          onClose={() => {}}
          onOpenFile={() => {}}
        />,
      ),
    );
    expect(document.body.textContent).not.toContain("Caller::method0");
    const details = document.querySelector("details")!;
    await act(async () => {
      details.open = true;
      details.dispatchEvent(new Event("toggle"));
    });
    expect(document.body.textContent).toContain("Caller::method0");
  });
});
