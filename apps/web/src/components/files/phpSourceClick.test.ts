// @vitest-environment jsdom
import { describe, expect, it, vi } from "vite-plus/test";
import { InteractionManager } from "@pierre/diffs";
import type { PhpEntryTarget } from "./phpSourceSymbols";
import { isPhpGraphGesture, openPhpSourceCallGraph } from "./phpSourceClick";

const ordinary = { button: 0, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false };
describe("PHP call graph source gesture", () => {
  it("supports Ctrl navigation and macOS Command navigation", () => {
    expect(isPhpGraphGesture({ ...ordinary, ctrlKey: true })).toBe(true);
    expect(isPhpGraphGesture({ ...ordinary, metaKey: true })).toBe(true);
  });
  it("preserves ordinary, secondary and range-selection clicks", () => {
    expect(isPhpGraphGesture(ordinary)).toBe(false);
    expect(isPhpGraphGesture({ ...ordinary, ctrlKey: true, button: 2 })).toBe(false);
    expect(isPhpGraphGesture({ ...ordinary, ctrlKey: true, shiftKey: true })).toBe(false);
    expect(isPhpGraphGesture({ ...ordinary, metaKey: true, altKey: true })).toBe(false);
  });
});

// Exercise the installed editor's actual bubbling token interaction across its shadow boundary.
describe("native source token navigation", () => {
  const contents = "<?php\nclass Demo {\n public function run() {}\n}";
  const targets: PhpEntryTarget[] = [
    {
      id: "Demo::run",
      symbol: "Demo::run",
      path: "Demo.php",
      line: 3,
      directCallers: [],
      entries: [],
      unknown: [],
      truncated: false,
    },
  ];
  function mount(tokenText: string, offset: number, editable: boolean) {
    const host = document.createElement("div");
    document.body.append(host);
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `<pre><code data-code><span data-column-number="3" data-line-index="2" data-line-type="context">3</span><div data-line="3" data-line-index="2" data-line-type="context"><span data-char="${offset}"></span></div></code></pre>`;
    const pre = shadow.querySelector("pre")!;
    pre.contentEditable = String(editable);
    const token = shadow.querySelector<HTMLSpanElement>("[data-char]")!;
    token.textContent = tokenText;
    const opened = vi.fn();
    const manager = new InteractionManager("file", {
      onTokenClick: (token, event) => {
        openPhpSourceCallGraph({ token, event, contents, targets, onOpen: opened });
      },
    });
    manager.setup(pre);
    return {
      token,
      opened,
      dispose: () => {
        manager.cleanUp();
        host.remove();
      },
    };
  }
  it.each([false, true])(
    "opens the modeled method from real token clicks (editable=%s)",
    (editable) => {
      const mounted = mount("run", 17, editable);
      try {
        const normal = new MouseEvent("click", { bubbles: true, composed: true, cancelable: true });
        mounted.token.dispatchEvent(normal);
        expect(mounted.opened).not.toHaveBeenCalled();
        expect(normal.defaultPrevented).toBe(false);
        const ctrl = new MouseEvent("click", {
          bubbles: true,
          composed: true,
          cancelable: true,
          ctrlKey: true,
        });
        mounted.token.dispatchEvent(ctrl);
        expect(mounted.opened).toHaveBeenCalledWith({
          kind: "method",
          symbol: "Demo::run",
          targets,
        });
        expect(ctrl.defaultPrevented).toBe(true);
      } finally {
        mounted.dispose();
      }
    },
  );
  it("does not guess a symbol from a plain-text token containing multiple identifiers", () => {
    const mounted = mount(" public function run() {}", 0, true);
    try {
      const event = new MouseEvent("click", {
        bubbles: true,
        composed: true,
        cancelable: true,
        ctrlKey: true,
      });
      mounted.token.dispatchEvent(event);
      expect(mounted.opened).not.toHaveBeenCalled();
      expect(event.defaultPrevented).toBe(false);
    } finally {
      mounted.dispose();
    }
  });
});
