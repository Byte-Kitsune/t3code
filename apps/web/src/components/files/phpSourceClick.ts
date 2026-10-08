import type { TokenEventBase } from "@pierre/diffs";
import {
  resolvePhpSourceSymbol,
  type PhpEntryTarget,
  type PhpSourceSymbolSelection,
} from "./phpSourceSymbols";

/** Modifier navigation must leave ordinary selection, context menus and range selection alone. */
export function isPhpGraphGesture(event: {
  readonly button: number;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
}): boolean {
  return event.button === 0 && (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey;
}

/** A merged/plain-text token has no reliable pointer offset; never guess its first symbol. */
export function openPhpSourceCallGraph(input: {
  token: TokenEventBase;
  event: MouseEvent;
  contents: string;
  targets: readonly PhpEntryTarget[];
  onOpen: (selection: PhpSourceSymbolSelection) => void;
}): boolean {
  const { token, event } = input;
  if (!isPhpGraphGesture(event) || !/^[\\\p{L}_][\\\p{L}\p{N}_]*$/u.test(token.tokenText))
    return false;
  const selection = resolvePhpSourceSymbol({
    contents: input.contents,
    line: token.lineNumber,
    column: token.lineCharStart + 1,
    targets: input.targets,
  });
  if (!selection) return false;
  event.preventDefault();
  event.stopPropagation();
  input.onOpen(selection);
  return true;
}
