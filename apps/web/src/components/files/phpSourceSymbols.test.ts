import { describe, expect, it } from "vite-plus/test";
import { resolvePhpSourceSymbol, type PhpEntryTarget } from "./phpSourceSymbols";

function target(symbol: string, line: number, id = symbol): PhpEntryTarget {
  return {
    id,
    symbol,
    path: "src/File.php",
    line,
    directCallers: [],
    entries: [],
    unknown: [],
    truncated: false,
  };
}
function position(contents: string, fragment: string, within = 0) {
  const offset = contents.indexOf(fragment) + within;
  if (offset < 0) throw new Error(`Missing test source ${fragment}`);
  const prefix = contents.slice(0, offset);
  return { line: prefix.split("\n").length, column: offset - prefix.lastIndexOf("\n") };
}
function select(
  contents: string,
  fragment: string,
  targets: readonly PhpEntryTarget[],
  within = 0,
) {
  return resolvePhpSourceSymbol({ contents, ...position(contents, fragment, within), targets });
}
const source = `<?php
namespace App\\Inventory;
final class Stock {
    #[QueryBudget(2)]
    public function
        load(bool $extra): void {
        $this->save();
        self::save();
        static::SAVE();
        $this?->save();
    }
    private function save(): void {}
}
`;
const load = target("App\\Inventory\\Stock::load", 5, "load:primary");
const save = target("App\\Inventory\\Stock::save", 12, "save:primary");

describe("PHP modeled source symbol selection", () => {
  it("selects class declarations with all independent service variants", () => {
    const second = { ...load, id: "load:secondary", serviceId: "secondary.stock" };
    const result = select(source, "Stock", [load, save, second]);
    expect(result?.kind).toBe("class");
    expect(result?.symbol).toBe("App\\Inventory\\Stock");
    expect(result?.targets).toEqual([load, save, second]);
  });
  it("keeps independent service variants when selecting a method", () => {
    const second = { ...load, id: "load:secondary", serviceId: "secondary.stock" };
    expect(select(source, "load(bool", [load, save, second])?.targets).toEqual([load, second]);
  });
  it("matches multiline attributed method declarations by namespace and modeled symbol", () => {
    const result = select(source, "load(bool", [load, save], 2);
    expect(result).toEqual({ kind: "method", symbol: load.symbol, targets: [load] });
  });
  it.each(["$this->save", "self::save", "static::SAVE", "$this?->save"])(
    "resolves %s only within its modeled class",
    (call) => {
      const result = select(
        source,
        call,
        [load, save],
        call.indexOf("save") >= 0 ? call.indexOf("save") : call.indexOf("SAVE"),
      );
      expect(result?.targets).toEqual([save]);
    },
  );
  it("does not use declarations from a different class with the same method name", () => {
    const contents = `<?php
namespace App;
class First { public function run() { $this->load(); } public function load() {} }
class Second { public function run() { self::load(); } public function load() {} }
`;
    const first = target("App\\First::load", 3);
    const second = target("App\\Second::load", 4);
    expect(select(contents, "$this->load", [first, second], 7)?.targets).toEqual([first]);
    expect(select(contents, "self::load", [first, second], 6)?.targets).toEqual([second]);
    expect(select(contents, "self::load", [first], 6)).toBeNull();
  });
  it("keeps class context through nested method blocks and drops it at the closing class brace", () => {
    const contents = `<?php
class Stock { function load() {} function run() { if (true) { self::load(); } } }
self::load();
`;
    const modeled = target("Stock::load", 2);
    expect(select(contents, "self::load", [modeled], 6)?.targets).toEqual([modeled]);
    expect(select(contents, "}\nself::load", [modeled], 8)).toBeNull();
  });
  it("resolves each braced namespace and the global namespace independently", () => {
    const contents = `<?php
namespace One { class Same { function load() {} } }
namespace Two { class Same { function load() {} } }
namespace { class Same { function load() {} } }
`;
    const targets = [
      target("One\\Same::load", 2),
      target("Two\\Same::load", 3),
      target("Same::load", 4),
    ];
    expect(select(contents, "One { class Same", targets, 12)?.symbol).toBe("One\\Same");
    expect(select(contents, "Two { class Same", targets, 12)?.symbol).toBe("Two\\Same");
    expect(select(contents, "namespace { class Same", targets, 18)?.symbol).toBe("Same");
  });
  it.each(["interface", "trait", "enum"])(
    "supports modeled %s declarations and abstract methods",
    (kind) => {
      const contents = `<?php namespace App; ${kind} Sample { public function load(): void; }`;
      const modeled = target("App\\Sample::load", 1);
      expect(select(contents, "Sample", [modeled])?.kind).toBe("class");
      expect(select(contents, "load()", [modeled])?.targets).toEqual([modeled]);
    },
  );
  it("does not attach anonymous-class methods and calls to the enclosing named class", () => {
    const contents = `<?php
class Stock {
  function load() {}
  function run() { $value = new class extends Base { function load() { $this->load(); } }; $this->load(); }
}
`;
    const modeled = target("Stock::load", 3);
    expect(select(contents, "Base { function load", [modeled], 16)).toBeNull();
    expect(select(contents, "$this->load", [modeled], 7)).toBeNull();
    expect(select(contents, "}; $this->load", [modeled], 10)?.targets).toEqual([modeled]);
  });
  it.each([
    "// self::load()",
    "/* self::load() */",
    "# self::load()",
    '"self::load()"',
    "'self::load()'",
    "`self::load()`",
  ])("ignores symbols inside %s", (value) => {
    const contents = `<?php class Stock { function load() {} function run() {\n${value}\n} }`;
    expect(select(contents, value, [target("Stock::load", 1)], value.indexOf("load"))).toBeNull();
  });
  it.each(["'TEXT'", '"TEXT"', "TEXT"])("ignores heredoc/nowdoc bodies using %s", (label) => {
    const contents = `<?php class Stock { function load() {} function run() {
$text = <<<${label}
self::load(); class Other { function load() {} }
TEXT;
self::load();
} }`;
    const modeled = target("Stock::load", 1);
    expect(select(contents, "self::load", [modeled], 6)).toBeNull();
    expect(select(contents, "TEXT;\nself::load", [modeled], 12)?.targets).toEqual([modeled]);
  });
  it.each([
    "$this->load;",
    "$this->$load();",
    "$this->{load}();",
    "Other::load();",
    "$other->load();",
    "load();",
    "$load = 1;",
    "Stock::class;",
  ])("rejects properties, dynamic calls and unrelated identifiers in %s", (expression) => {
    const contents = `<?php class Stock { function load() {} function run() { ${expression} } }`;
    const fragment = expression.includes("load") ? "load" : "class";
    const start = contents.indexOf(expression);
    const offset = start + expression.indexOf(fragment);
    expect(
      resolvePhpSourceSymbol({
        contents,
        line: 1,
        column: offset + 1,
        targets: [target("Stock::load", 1)],
      }),
    ).toBeNull();
  });
  it("uses UTF-16 columns and Windows source lines without leaking symbols into HTML", () => {
    const contents =
      '<p>Stock load()</p>\r\n<?php class Stock { function load() {} function run() { $emoji="😀"; self::load(); } } ?>\r\n<p>self::load()</p>';
    const modeled = target("Stock::load", 2);
    expect(select(contents, "self::load", [modeled], 6)?.targets).toEqual([modeled]);
    expect(select(contents, "<p>Stock", [modeled], 3)).toBeNull();
    expect(select(contents, "<p>self::load", [modeled], 9)).toBeNull();
  });
  it("rejects unmodeled symbols and stale locations outside the actual class body", () => {
    expect(select(source, "Stock", [target("Other::load", 5)])).toBeNull();
    expect(select(source, "load(bool", [target(load.symbol, 100)])).toBeNull();
    expect(
      resolvePhpSourceSymbol({ contents: source, line: 1, column: 0, targets: [load] }),
    ).toBeNull();
    expect(
      resolvePhpSourceSymbol({ contents: source, line: 999, column: 1, targets: [load] }),
    ).toBeNull();
  });
});
