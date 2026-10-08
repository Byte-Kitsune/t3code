import { describe, expect, it, vi } from "vite-plus/test";

import { installFileEditorDismissal } from "./fileEditorDismissal";

function editorSurface(ownerDocument: EventTarget) {
  const blur = vi.fn();
  const focusedContent = {
    hasAttribute: (name: string) => name === "data-content",
    blur,
  };
  const root = {
    ownerDocument,
    querySelector: () => ({ shadowRoot: { activeElement: focusedContent } }),
  } as unknown as HTMLElement;
  const editor = { setSelections: vi.fn() };
  const onDismiss = vi.fn();
  return { root, editor, onDismiss, blur };
}

function escapeEvent() {
  return Object.assign(new Event("keydown", { cancelable: true }), { key: "Escape" });
}

describe("file editor interaction in its owning document", () => {
  it("dismisses and blurs on Escape in the owning document, including foreign realm elements", () => {
    const popupDocument = new EventTarget();
    const otherDocument = new EventTarget();
    const surface = editorSurface(popupDocument);
    const dispose = installFileEditorDismissal({ ...surface, isBlocked: () => false });

    otherDocument.dispatchEvent(escapeEvent());
    expect(surface.onDismiss).not.toHaveBeenCalled();
    const escape = escapeEvent();
    popupDocument.dispatchEvent(escape);
    expect(escape.defaultPrevented).toBe(true);
    expect(surface.onDismiss).toHaveBeenCalledOnce();
    expect(surface.editor.setSelections).toHaveBeenCalledWith([]);
    expect(surface.blur).toHaveBeenCalledOnce();

    dispose();
    popupDocument.dispatchEvent(escapeEvent());
    expect(surface.onDismiss).toHaveBeenCalledOnce();
  });

  it("rebinds dismissal after adoption without listening to the previous document", () => {
    const previousDocument = new EventTarget();
    const popupDocument = new EventTarget();
    const surface = editorSurface(previousDocument);
    const disposePrevious = installFileEditorDismissal({ ...surface, isBlocked: () => false });
    disposePrevious();
    const disposePopup = installFileEditorDismissal({
      ...surface,
      ownerDocument: popupDocument as Document,
      isBlocked: () => false,
    });

    previousDocument.dispatchEvent(escapeEvent());
    expect(surface.onDismiss).not.toHaveBeenCalled();
    popupDocument.dispatchEvent(escapeEvent());
    expect(surface.onDismiss).toHaveBeenCalledOnce();
    disposePopup();
  });

  it("keeps open comment forms and interactions inside the editor intact", () => {
    const ownerDocument = new EventTarget();
    const surface = editorSurface(ownerDocument);
    let blocked = true;
    const dispose = installFileEditorDismissal({ ...surface, isBlocked: () => blocked });
    ownerDocument.dispatchEvent(escapeEvent());
    ownerDocument.dispatchEvent(new Event("pointerdown"));
    expect(surface.onDismiss).not.toHaveBeenCalled();

    blocked = false;
    const inside = new Event("pointerdown");
    Object.defineProperty(inside, "composedPath", { value: () => [surface.root] });
    ownerDocument.dispatchEvent(inside);
    expect(surface.onDismiss).not.toHaveBeenCalled();
    ownerDocument.dispatchEvent(new Event("pointerdown"));
    expect(surface.onDismiss).toHaveBeenCalledOnce();
    dispose();
  });
});
