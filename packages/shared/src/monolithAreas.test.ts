import { describe, expect, it } from "vite-plus/test";

import {
  groupFilesByMonolithArea,
  matchMonolithArea,
  type MonolithAreaBoundary,
} from "./monolithAreas.ts";

const areas: ReadonlyArray<MonolithAreaBoundary> = [
  { id: "php", name: "Backend", path: "src", kind: "php" },
  { id: "react", name: "Frontend", path: "src/web", kind: "react" },
  { id: "docs", name: "Docs", path: "docs", kind: "folder" },
];

describe("monolith area boundaries", () => {
  it("matches directories rather than common string prefixes, and picks the deepest boundary", () => {
    expect(matchMonolithArea({ path: "src/web/app.tsx" }, areas)?.id).toBe("react");
    expect(matchMonolithArea({ path: "src/worker.php" }, areas)?.id).toBe("php");
    expect(matchMonolithArea({ path: "src-old/worker.php" }, areas)).toBeNull();
    expect(matchMonolithArea({ path: "docs/readme.md" }, areas)?.kind).toBe("folder");
  });

  it("excludes disabled boundaries and permits a root group beneath nested groups", () => {
    const configured = [
      { id: "root", name: "Root", path: ".", kind: "folder" as const },
      ...areas.map((area) => ({ ...area, enabled: area.id !== "react" })),
    ];
    expect(matchMonolithArea({ path: "src/web/app.tsx" }, configured)).toBeNull();
    expect(matchMonolithArea({ path: "readme.md" }, configured)?.id).toBe("root");
    expect(matchMonolithArea({ path: "readme.md" }, [{ ...configured[0]!, path: "" }])?.id).toBe(
      "root",
    );
    expect(
      matchMonolithArea({ path: "src/web/app.tsx" }, [{ ...areas[1]!, path: "./src/web/" }])?.id,
    ).toBe("react");
  });

  it("keeps an excluded folder out of a root catchall", () => {
    const configured = [
      { id: "root", name: "Application", path: ".", kind: "folder" as const },
      {
        id: "vendor",
        name: "Dependencies",
        path: "vendor",
        kind: "folder" as const,
        enabled: false,
      },
    ];
    const grouped = groupFilesByMonolithArea(
      ["index.php", "vendor/lib.php"],
      configured,
      (path) => ({ path }),
    );
    expect(grouped.map((group) => [group.name, group.files])).toEqual([
      ["Application", ["index.php"]],
      ["Other", ["vendor/lib.php"]],
    ]);
  });

  it("uses the surviving rename destination, and the old path for a deleted file", () => {
    expect(
      matchMonolithArea({ path: "src/web/new.tsx", previousPath: "src/old.php" }, areas)?.id,
    ).toBe("react");
    expect(
      matchMonolithArea({ path: "archive/old.php", previousPath: "src/old.php" }, areas),
    ).toBeNull();
    expect(matchMonolithArea({ path: null, previousPath: "src/deleted.php" }, areas)?.id).toBe(
      "php",
    );
  });

  it("keeps user group order and each group's file order, with Other last", () => {
    const paths = ["readme.md", "src/web/b.tsx", "docs/setup.md", "src/a.php", "src/web/a.tsx"];
    const result = groupFilesByMonolithArea(paths, [areas[2]!, areas[1]!, areas[0]!], (path) => ({
      path,
    }));
    expect(result.map((group) => [group.name, group.files])).toEqual([
      ["Docs", ["docs/setup.md"]],
      ["Frontend", ["src/web/b.tsx", "src/web/a.tsx"]],
      ["Backend", ["src/a.php"]],
      ["Other", ["readme.md"]],
    ]);
    expect(result.flatMap((group) => group.files).sort()).toEqual([...paths].sort());
  });
});
