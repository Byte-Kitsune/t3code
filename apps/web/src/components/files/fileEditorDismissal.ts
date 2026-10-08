interface FileEditorDismissalOptions {
  root: HTMLElement;
  ownerDocument?: Document;
  editor: {
    setSelections: (selections: []) => void;
  };
  isBlocked: () => boolean;
  onDismiss: () => void;
}

function dismissFileEditorInteraction({
  root,
  editor,
  onDismiss,
}: Pick<FileEditorDismissalOptions, "root" | "editor" | "onDismiss">): void {
  onDismiss();
  editor.setSelections([]);

  const file = root.querySelector<HTMLElement>("diffs-container");
  const activeElement = file?.shadowRoot?.activeElement;
  if (activeElement && "blur" in activeElement && typeof activeElement.blur === "function") {
    activeElement.blur();
  }
}

function isFileEditorFocused(root: HTMLElement): boolean {
  const file = root.querySelector<HTMLElement>("diffs-container");
  return file?.shadowRoot?.activeElement?.hasAttribute("data-content") === true;
}

export function installFileEditorDismissal({
  root,
  ownerDocument = root.ownerDocument,
  editor,
  isBlocked,
  onDismiss,
}: FileEditorDismissalOptions): () => void {
  const handlePointerDown = (event: PointerEvent) => {
    if (isBlocked() || event.composedPath().includes(root)) return;
    dismissFileEditorInteraction({ root, editor, onDismiss });
  };
  const handleKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "Escape" || isBlocked() || !isFileEditorFocused(root)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    dismissFileEditorInteraction({ root, editor, onDismiss });
  };

  ownerDocument.addEventListener("pointerdown", handlePointerDown, { capture: true });
  ownerDocument.addEventListener("keydown", handleKeyDown, { capture: true });
  return () => {
    ownerDocument.removeEventListener("pointerdown", handlePointerDown, { capture: true });
    ownerDocument.removeEventListener("keydown", handleKeyDown, { capture: true });
  };
}
