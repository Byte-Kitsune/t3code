import { act, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId } from "@t3tools/contracts";
import { FileTree } from "@pierre/trees/react";
import FileBrowserPanel from "./FileBrowserPanel";
import { Select } from "~/components/ui/select";
import { fileBrowserGroupStorageKey, readFileBrowserGroupPreference } from "./fileBrowserGroups";
const mocks = vi.hoisted(() => ({
  load: vi.fn(async (_path: string) => {}),
  search: vi.fn(),
  changes: [] as {
    path: string;
    kind: "added" | "modified" | "deleted" | "renamed";
    uncommitted: boolean;
  }[],
  refreshGit: vi.fn(),
  areas: [
    { id: "php", name: "Catalog", path: "artifact/catalog", kind: "php" },
    { id: "docs", name: "Docs", path: "docs", kind: "folder" },
  ],
}));
vi.mock("~/state/vcs", () => ({ vcsEnvironment: { status: () => null } }));
vi.mock("~/state/query", () => ({
  useEnvironmentQuery: () => ({
    data: { isRepo: true, fileChanges: { baseRef: "origin/main", files: mocks.changes } },
    refresh: mocks.refreshGit,
    error: null,
    isPending: false,
  }),
}));
vi.mock("~/hooks/useMonolithAreas", () => ({
  useMonolithAreas: () => ({ areas: mocks.areas, config: { areas: mocks.areas }, loading: false }),
}));
vi.mock("~/hooks/useTheme", () => ({ useTheme: () => ({ resolvedTheme: "dark" }) }));
vi.mock("~/hooks/useWorkspaceMutationRefresh", () => ({ useWorkspaceMutationRefresh: () => {} }));
vi.mock("~/composerHandleContext", () => ({ useComposerHandleContext: () => null }));
vi.mock("~/fileContextMenu", () => ({ useFileContextMenu: () => ({ buildItems: () => [] }) }));
vi.mock("~/state/queries", () => ({
  useProjectPathSearch: (input: unknown) => {
    mocks.search(input);
    return { entries: [], isPending: false, error: null, truncated: false, refresh: () => {} };
  },
}));
vi.mock("./useDirectoryEntries", () => ({
  useDirectoryEntries: () => ({
    entries: [
      { path: "mago.toml", kind: "file" },
      { path: "artifact", kind: "directory" },
      { path: "artifact/catalog", kind: "directory" },
      { path: "artifact/catalog/src", kind: "directory" },
      { path: "artifact/catalog/src/Demo.php", kind: "file" },
      { path: "docs", kind: "directory" },
      { path: "docs/readme.md", kind: "file" },
    ],
    load: mocks.load,
    refresh: () => {},
    ready: true,
    error: null,
    isPending: false,
  }),
}));
vi.mock("~/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => children,
  TooltipTrigger: ({ children, render }: { children: ReactNode; render?: ReactNode }) =>
    render ?? children,
  TooltipPopup: () => null,
}));
vi.mock("~/components/ui/select", () => ({
  Select: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectItem: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  SelectPopup: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectTrigger: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectValue: () => null,
}));

// Tests use the actual Pierre model; native shadow-DOM rendering is outside this unit boundary.
describe("file browser group switching", () => {
  let renderer: ReactTestRenderer | undefined;
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  };
  const props = {
    environmentId: EnvironmentId.make("local"),
    cwd: "/repo",
    projectName: "Repo",
    selectedPath: null as string | null,
    selectedPathRevealId: 0,
    onOpenFile: vi.fn(),
    workspaceMutationId: null,
  };
  beforeEach(() => {
    values.clear();
    mocks.load.mockClear();
    mocks.search.mockClear();
    mocks.changes = [];
    mocks.refreshGit.mockClear();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("window", { localStorage: storage });
    vi.stubGlobal("document", { addEventListener: () => {}, removeEventListener: () => {} });
  });
  afterEach(async () => {
    await act(async () => renderer?.unmount());
    renderer = undefined;
    vi.unstubAllGlobals();
  });
  const model = () => renderer!.root.findByType(FileTree).props.model;
  it("focuses only the active group and switches to full repo without changing canonical paths", async () => {
    await act(async () => {
      renderer = create(<FileBrowserPanel {...props} />);
    });
    expect(model().getItem("artifact/catalog/src/Demo.php")).not.toBeNull();
    expect(model().getItem("mago.toml")).toBeNull();
    await act(async () => model().getItem("artifact/catalog/src/Demo.php").select());
    expect(props.onOpenFile).toHaveBeenLastCalledWith("artifact/catalog/src/Demo.php");
    expect(mocks.load.mock.calls.map(([path]) => path)).toContain("artifact/catalog");
    expect(mocks.search).toHaveBeenLastCalledWith(
      expect.objectContaining({ cwd: "/repo/artifact/catalog" }),
    );
    await act(async () => renderer!.root.findByType(Select).props.onValueChange("area:docs"));
    expect(model().getItem("docs/readme.md")).not.toBeNull();
    expect(model().getItem("artifact/catalog/src/Demo.php")).toBeNull();
    expect(model().getItem("artifact/")).toBeNull();
    expect(
      readFileBrowserGroupPreference(storage, fileBrowserGroupStorageKey("local", "/repo"))
        ?.recentAreaIds[0],
    ).toBe("docs");
    await act(async () => renderer!.root.findByType(Select).props.onValueChange("repository"));
    expect(model().getItem("mago.toml")).not.toBeNull();
  });
  it("reveals external file opens in their matching group while manual changes remain selected", async () => {
    await act(async () => {
      renderer = create(<FileBrowserPanel {...props} selectedPath="docs/readme.md" />);
    });
    expect(renderer!.root.findByType(Select).props.value).toBe("area:docs");
    await act(async () => renderer!.root.findByType(Select).props.onValueChange("area:php"));
    expect(renderer!.root.findByType(Select).props.value).toBe("area:php");
    await act(async () =>
      renderer!.update(
        <FileBrowserPanel {...props} selectedPath="docs/readme.md" selectedPathRevealId={1} />,
      ),
    );
    expect(renderer!.root.findByType(Select).props.value).toBe("area:docs");
  });
  it("shows changes across groups and unopened folders, searches locally, and keeps the filter while opening a file", async () => {
    mocks.changes = [
      { path: "docs/readme.md", kind: "modified", uncommitted: false },
      { path: "unloaded/new/deep.ts", kind: "added", uncommitted: true },
      { path: "artifact/catalog/src/Removed.php", kind: "deleted", uncommitted: true },
      ...Array.from({ length: 210 }, (_, index) => ({
        path: `unloaded/file${index}.ts`,
        kind: "modified" as const,
        uncommitted: false,
      })),
    ];
    await act(async () => {
      renderer = create(<FileBrowserPanel {...props} />);
    });
    await act(async () => renderer!.root.findByType(Select).props.onValueChange("changed-files"));
    expect(model().getItem("docs/readme.md")).not.toBeNull();
    expect(model().getItem("unloaded/new/deep.ts")).not.toBeNull();
    expect(model().getItem("unloaded/file209.ts")).not.toBeNull();
    expect(model().getItem("artifact/catalog/src/Removed.php")).toBeNull();
    expect(model().getItem("artifact/catalog/src/Demo.php")).toBeNull();
    await act(async () => model().getItem("unloaded/new/deep.ts").select());
    expect(props.onOpenFile).toHaveBeenLastCalledWith("unloaded/new/deep.ts");
    await act(async () =>
      renderer!.update(<FileBrowserPanel {...props} selectedPath="unloaded/new/deep.ts" />),
    );
    expect(renderer!.root.findByType(Select).props.value).toBe("changed-files");
    expect(
      readFileBrowserGroupPreference(storage, fileBrowserGroupStorageKey("local", "/repo"))
        ?.changedFiles,
    ).toBe(true);
    await act(async () => model().setSearch("file209"));
    expect(mocks.search).toHaveBeenLastCalledWith(expect.objectContaining({ query: "" }));
    expect(model().getItem("unloaded/file209.ts")).not.toBeNull();
    await act(async () => renderer!.root.findByType(Select).props.onValueChange("area:docs"));
    expect(renderer!.root.findByType(Select).props.value).toBe("area:docs");
    expect(model().getItem("unloaded/new/deep.ts")).toBeNull();
  });
  it("restores the changed filter and removes paths immediately after a push status update", async () => {
    values.set(
      fileBrowserGroupStorageKey("local", "/repo"),
      JSON.stringify({ activeAreaId: "php", recentAreaIds: ["php", "docs"], changedFiles: true }),
    );
    mocks.changes = [{ path: "docs/readme.md", kind: "modified", uncommitted: false }];
    await act(async () => {
      renderer = create(<FileBrowserPanel {...props} selectedPath="docs/readme.md" />);
    });
    expect(renderer!.root.findByType(Select).props.value).toBe("changed-files");
    expect(model().getItem("docs/readme.md")).not.toBeNull();
    mocks.changes = [];
    await act(async () =>
      renderer!.update(<FileBrowserPanel {...props} selectedPath="docs/readme.md" />),
    );
    expect(model().getItem("docs/readme.md")).toBeNull();
    expect(model().getItem("docs/")).toBeNull();
    expect(renderer!.root.findByType(Select).props.value).toBe("changed-files");
    expect(
      readFileBrowserGroupPreference(storage, fileBrowserGroupStorageKey("local", "/repo"))
        ?.recentAreaIds,
    ).toEqual(["php", "docs"]);
  });
});
