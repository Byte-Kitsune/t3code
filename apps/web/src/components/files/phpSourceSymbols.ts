import type { MonolithCheckFileResult } from "@t3tools/contracts";

export type PhpEntryTarget = NonNullable<MonolithCheckFileResult["entryChains"]>["targets"][number];
export type PhpSourceSymbolSelection = {
  readonly kind: "class" | "method";
  readonly symbol: string;
  readonly targets: readonly PhpEntryTarget[];
};
type Token = { value: string; start: number; end: number; word: boolean; owner: number | null };
type ClassScope = {
  symbol: string | null;
  nameToken: number | null;
  bodyDepth: number;
  startLine: number;
  endLine: number | null;
};
type Prepared = {
  tokens: Token[];
  lines: number[];
  classes: ClassScope[];
  classNames: Map<number, number>;
  methods: Map<number, { owner: number; name: string }>;
};
const cache = new Map<string, Prepared | null>();
const wordStart = (char: string) => /^[A-Za-z_\u0080-\uffff]$/.test(char);
const wordPart = (char: string) => /^[A-Za-z0-9_\u0080-\uffff]$/.test(char);
const canonical = (name: string) => name.replace(/^\\/, "").toLowerCase();

function sourceLine(lines: readonly number[], offset: number): number {
  let left = 0;
  let right = lines.length;
  while (left + 1 < right) {
    const middle = (left + right) >>> 1;
    if (lines[middle]! <= offset) left = middle;
    else right = middle;
  }
  return left + 1;
}

/** Strings (including interpolated strings) never supply navigable source symbols. */
function tokenize(contents: string): Token[] | null {
  const tokens: Token[] = [];
  let index = 0;
  let php = !contents.includes("<?");
  while (index < contents.length) {
    if (!php) {
      const opening = contents.indexOf("<?", index);
      if (opening < 0) break;
      index =
        opening +
        (contents.slice(opening, opening + 5).toLowerCase() === "<?php"
          ? 5
          : contents[opening + 2] === "="
            ? 3
            : 2);
      php = true;
      continue;
    }
    const char = contents[index]!;
    if (/\s/.test(char)) {
      index++;
      continue;
    }
    if (contents.startsWith("?>", index)) {
      php = false;
      index += 2;
      continue;
    }
    if (contents.startsWith("//", index) || (char === "#" && contents[index + 1] !== "[")) {
      const end = contents.indexOf("\n", index);
      index = end < 0 ? contents.length : end + 1;
      continue;
    }
    if (contents.startsWith("/*", index)) {
      const end = contents.indexOf("*/", index + 2);
      index = end < 0 ? contents.length : end + 2;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      const quote = char;
      index++;
      while (index < contents.length) {
        if (contents[index] === "\\") index += 2;
        else if (contents[index++] === quote) break;
      }
      continue;
    }
    if (contents.startsWith("<<<", index)) {
      const opening =
        /^<<<[ \t]*(?:'([A-Za-z_][A-Za-z0-9_]*)'|"([A-Za-z_][A-Za-z0-9_]*)"|([A-Za-z_][A-Za-z0-9_]*))[ \t]*\r?\n/.exec(
          contents.slice(index),
        );
      if (opening) {
        const label = opening[1] ?? opening[2] ?? opening[3]!;
        const body = index + opening[0].length;
        const closing = new RegExp(`^[ \\t]*${label}(?=[;,\\)\\]\\s]|$)`, "m").exec(
          contents.slice(body),
        );
        index = closing ? body + closing.index + closing[0].length : contents.length;
        continue;
      }
    }
    const start = index;
    const variable = char === "$" && wordStart(contents[index + 1] ?? "");
    const word = wordStart(char);
    if (word || variable) {
      index += variable ? 2 : 1;
      while (index < contents.length && wordPart(contents[index]!)) index++;
    } else {
      const operator = ["?->", "->", "::", "=>"].find((value) => contents.startsWith(value, index));
      index += operator?.length ?? 1;
    }
    tokens.push({ value: contents.slice(start, index), start, end: index, word, owner: null });
    if (tokens.length > 100_000) return null;
  }
  return tokens;
}

function classBody(tokens: readonly Token[], from: number): number | null {
  let parentheses = 0;
  let brackets = 0;
  for (let index = from; index < Math.min(tokens.length, from + 512); index++) {
    const value = tokens[index]!.value;
    if (value === "{") {
      if (parentheses === 0 && brackets === 0) return index;
    } else if (value === ";" && parentheses === 0 && brackets === 0) return null;
    else if (value === "(") parentheses++;
    else if (value === ")") parentheses--;
    else if (value === "[") brackets++;
    else if (value === "]") brackets--;
  }
  return null;
}

function prepare(contents: string): Prepared | null {
  if (contents.length > 2 * 1024 * 1024) return null;
  const tokens = tokenize(contents);
  if (!tokens) return null;
  const lines = [0];
  for (let index = 0; index < contents.length; index++)
    if (contents[index] === "\n") lines.push(index + 1);
  const classes: ClassScope[] = [];
  const classNames = new Map<number, number>();
  const methods: Prepared["methods"] = new Map();
  const openings = new Map<number, number>();
  const namespaceOpenings = new Map<number, string>();
  const namespaces: { depth: number; previous: string }[] = [];
  const stack: number[] = [];
  let depth = 0;
  let namespace = "";
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    token.owner = stack.at(-1) ?? null;
    const lower = token.value.toLowerCase();
    if (lower === "namespace" && depth === 0) {
      let ending = index + 1;
      let name = "";
      while (ending < tokens.length && (tokens[ending]!.word || tokens[ending]!.value === "\\"))
        name += tokens[ending++]!.value;
      if (tokens[ending]?.value === ";" && name && !name.startsWith("\\")) namespace = name;
      else if (tokens[ending]?.value === "{" && !name.startsWith("\\"))
        namespaceOpenings.set(ending, name);
    }
    if (
      ["class", "interface", "trait", "enum"].includes(lower) &&
      tokens[index - 1]?.value !== "::"
    ) {
      const name = tokens[index + 1];
      const anonymous =
        lower === "class" &&
        (tokens[index - 1]?.value.toLowerCase() === "new" ||
          !name?.word ||
          ["extends", "implements"].includes(name.value.toLowerCase()));
      const opening = classBody(tokens, index + 1);
      if (opening !== null && (anonymous || name?.word)) {
        const owner = classes.length;
        classes.push({
          symbol: anonymous ? null : `${namespace ? `${namespace}\\` : ""}${name!.value}`,
          nameToken: anonymous ? null : index + 1,
          bodyDepth: 0,
          startLine: sourceLine(lines, token.start),
          endLine: null,
        });
        openings.set(opening, owner);
        if (!anonymous) classNames.set(index + 1, owner);
      }
    }
    if (lower === "function" && token.owner !== null && depth === classes[token.owner]!.bodyDepth) {
      const nameIndex = tokens[index + 1]?.value === "&" ? index + 2 : index + 1;
      const name = tokens[nameIndex];
      if (
        name?.word &&
        tokens[nameIndex + 1]?.value === "(" &&
        classes[token.owner]!.symbol !== null
      )
        methods.set(nameIndex, { owner: token.owner, name: name.value });
    }
    if (token.value === "{") {
      depth++;
      const nextNamespace = namespaceOpenings.get(index);
      if (nextNamespace !== undefined) {
        namespaces.push({ depth, previous: namespace });
        namespace = nextNamespace;
      }
      const owner = openings.get(index);
      if (owner !== undefined) {
        classes[owner]!.bodyDepth = depth;
        stack.push(owner);
      }
    } else if (token.value === "}") {
      const owner = stack.at(-1);
      if (owner !== undefined && classes[owner]!.bodyDepth === depth) {
        classes[owner]!.endLine = sourceLine(lines, token.end);
        stack.pop();
      }
      if (namespaces.at(-1)?.depth === depth) namespace = namespaces.pop()!.previous;
      depth = Math.max(0, depth - 1);
    }
  }
  return { tokens, lines, classes, classNames, methods };
}

function prepared(contents: string): Prepared | null {
  if (cache.has(contents)) return cache.get(contents)!;
  const value = prepare(contents);
  cache.set(contents, value);
  if (cache.size > 2) cache.delete(cache.keys().next().value!);
  return value;
}

/** Restrict token navigation to declarations and statically named calls in the modeled current class. */
export function resolvePhpSourceSymbol(input: {
  contents: string;
  line: number;
  column: number;
  targets: readonly PhpEntryTarget[];
}): PhpSourceSymbolSelection | null {
  if (
    !input.targets.length ||
    !Number.isInteger(input.line) ||
    !Number.isInteger(input.column) ||
    input.line < 1 ||
    input.column < 1
  )
    return null;
  const source = prepared(input.contents);
  const lineStart = source?.lines[input.line - 1];
  if (!source || lineStart === undefined) return null;
  const offset = lineStart + input.column - 1;
  if (offset >= (source.lines[input.line] ?? input.contents.length + 1)) return null;
  let left = 0;
  let right = source.tokens.length;
  while (left < right) {
    const middle = (left + right) >>> 1;
    if (source.tokens[middle]!.start <= offset) left = middle + 1;
    else right = middle;
  }
  const index = left - 1;
  const token = source.tokens[index];
  if (!token?.word || offset >= token.end) return null;
  const classDeclaration = source.classNames.get(index);
  const declaration = source.methods.get(index);
  const operator = source.tokens[index - 1]?.value;
  const receiver = source.tokens[index - 2]?.value.toLowerCase();
  const call =
    source.tokens[index + 1]?.value === "(" &&
    ((["->", "?->"].includes(operator ?? "") && receiver === "$this") ||
      (operator === "::" && (receiver === "self" || receiver === "static")));
  const owner = classDeclaration ?? declaration?.owner ?? (call ? token.owner : null);
  const scope = owner === null || owner === undefined ? null : source.classes[owner];
  if (!scope?.symbol || scope.endLine === null) return null;
  const methodName = classDeclaration === undefined ? (declaration?.name ?? token.value) : null;
  const targets = input.targets.filter((target) => {
    const separator = target.symbol.lastIndexOf("::");
    if (separator < 1 || canonical(target.symbol.slice(0, separator)) !== canonical(scope.symbol!))
      return false;
    if (
      target.line !== undefined &&
      (target.line < scope.startLine || target.line > scope.endLine!)
    )
      return false;
    return (
      methodName === null ||
      target.symbol.slice(separator + 2).toLowerCase() === methodName.toLowerCase()
    );
  });
  if (!targets.length) return null;
  return {
    kind: methodName === null ? "class" : "method",
    symbol: methodName === null ? scope.symbol : targets[0]!.symbol,
    targets,
  };
}
