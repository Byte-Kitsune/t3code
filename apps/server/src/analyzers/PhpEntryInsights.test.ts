import { describe, expect, it } from "vite-plus/test";
import {
  normalizePhpEntryInsightsReport,
  preparePhpEntryInsightsReport,
} from "./PhpEntryInsights.ts";
function graph(options: { complete?: boolean; depth?: number; unknown?: string[] } = {}) {
  return {
    status: "snapshot",
    snapshot: {
      schema_version: "1",
      capability: "full_source_call_graph",
      complete: options.complete ?? true,
      max_depth: options.depth ?? 8,
      unknown: options.unknown ?? [],
      nodes: [
        {
          id: "entry",
          symbol: "App\\Controller::index",
          path: "src/Controller.php",
          line: 8,
          column: 5,
          entry_scope: "http" as string | null,
        },
        {
          id: "service",
          symbol: "App\\Service::fetch",
          path: "src/Service.php",
          line: 12,
          column: 5,
          entry_scope: null as string | null,
        },
        {
          id: "repo",
          symbol: "App\\Repository::find",
          path: "src/Repository.php",
          line: 5,
          column: 5,
          entry_scope: null as string | null,
        },
        {
          id: "injected-only",
          symbol: "App\\Unused::run",
          path: "src/Unused.php",
          line: 4,
          column: 5,
          entry_scope: "http" as string | null,
        },
      ],
      edges: [
        { from: "entry", to: "service", path: "src/Controller.php", line: 11, column: 9 },
        { from: "service", to: "repo", path: "src/Service.php", line: 16, column: 9 },
      ],
    },
  };
}
describe("full PHP entry call graph", () => {
  it("keeps declaration comments, exact opened-file spans and referenced chain metadata", () => {
    const report = graph();
    const annotation = {
      marker: "@deprecated",
      severity: "warning",
      message: "Use ModernRepository",
      path: "src/Repository.php",
      line: 2,
      column: 5,
    };
    Object.assign(report.snapshot, {
      symbol_metadata: [
        {
          symbol: "App\\Repository",
          kind: "class",
          path: "src/Repository.php",
          line: 3,
          column: 7,
          annotations: [annotation],
        },
        {
          symbol: "App\\Service::fetch",
          kind: "method",
          path: "src/Service.php",
          line: 12,
          column: 5,
          annotations: [
            {
              ...annotation,
              marker: "@see",
              severity: "reference",
              message: "App\\Repository::find",
              path: "src/Service.php",
            },
          ],
        },
        {
          symbol: "App\\Unused",
          kind: "class",
          path: "src/Unused.php",
          line: 4,
          column: 5,
          annotations: [annotation],
        },
      ],
      annotation_sites: [
        {
          symbol: "App\\Repository::find",
          target_symbol: "App\\Repository",
          kind: "declaration",
          path: "src/Repository.php",
          line: 5,
          column: 5,
          end_line: 5,
          end_column: 9,
          annotations: [annotation],
        },
        {
          symbol: "App\\Service::fetch",
          target_symbol: "App\\Repository::find",
          kind: "call",
          path: "src/Service.php",
          line: 16,
          column: 9,
          end_line: 16,
          end_column: 13,
          annotations: [annotation],
        },
      ],
    });
    const result = normalizePhpEntryInsightsReport(report, "src/Repository.php", "artifact/api");
    expect(result.symbolMetadata?.map((item) => item.symbol)).toEqual([
      "App\\Repository",
      "App\\Service::fetch",
    ]);
    expect(result.annotationSites).toHaveLength(1);
    expect(result.annotationSites?.[0]).toMatchObject({
      path: "artifact/api/src/Repository.php",
      targetSymbol: "App\\Repository",
      endColumn: 9,
    });
    expect(result.symbolMetadata?.[1]?.annotations[0]).toMatchObject({
      severity: "reference",
      message: "App\\Repository::find",
      path: "artifact/api/src/Service.php",
    });
  });
  it("returns comments on an opened interface without graph methods", () => {
    const report = graph();
    Object.assign(report.snapshot, {
      symbol_metadata: [
        {
          symbol: "App\\Contract",
          kind: "interface",
          path: "src/Contract.php",
          line: 3,
          column: 11,
          annotations: [],
        },
      ],
      annotation_sites: [],
    });
    const result = normalizePhpEntryInsightsReport(report, "src/Contract.php");
    expect(result.status).toBe("complete");
    expect(result.targets).toEqual([]);
    expect(result.symbolMetadata?.[0]?.kind).toBe("interface");
  });
  it.each(["path", "severity", "span", "count"])("rejects invalid annotation %s", (caseName) => {
    const report = graph();
    const annotation = {
      marker: "@todo",
      severity: "info",
      message: "",
      path: "src/Repository.php",
      line: 2,
      column: 5,
    };
    const site = {
      symbol: "App\\Repository::find",
      target_symbol: "App\\Repository",
      kind: "declaration",
      path: "src/Repository.php",
      line: 5,
      column: 5,
      end_line: 5,
      end_column: 9,
      annotations: [annotation],
    };
    if (caseName === "path") annotation.path = "../outside.php";
    if (caseName === "severity") annotation.severity = "critical";
    if (caseName === "span") site.end_column = 4;
    if (caseName === "count") site.annotations = Array.from({ length: 129 }, () => annotation);
    Object.assign(report.snapshot, { annotation_sites: [site] });
    expect(() => normalizePhpEntryInsightsReport(report, "src/Repository.php")).toThrow();
  });

  it("returns actual direct callers and transitive entries, not injection-only consumers", () => {
    const result = normalizePhpEntryInsightsReport(
      graph(),
      "src/Repository.php",
      "artifact/backend",
    );
    expect(result.status).toBe("complete");
    expect(result.targets[0]!.path).toBe("artifact/backend/src/Repository.php");
    expect(result.targets[0]!.directCallers).toEqual([
      {
        id: "service",
        symbol: "App\\Service::fetch",
        path: "artifact/backend/src/Service.php",
        line: 16,
        column: 9,
      },
    ]);
    expect(result.targets[0]!.entries).toHaveLength(1);
    expect(result.targets[0]!.entries[0]!.chain.map((node) => node.symbol)).toEqual([
      "App\\Controller::index",
      "App\\Service::fetch",
      "App\\Repository::find",
    ]);
  });
  it("keeps incomplete dispatch and unresolved receiver evidence visible", () => {
    const result = normalizePhpEntryInsightsReport(
      graph({ complete: false, unknown: ["Dynamic dispatch"] }),
      "src/Repository.php",
    );
    expect(result.status).toBe("incomplete");
    expect(result.targets[0]!.unknown).toEqual(["Dynamic dispatch"]);
    expect(result.targets[0]!.entries[0]!.complete).toBe(false);
  });
  it("marks bounded depth without claiming no entry exists", () => {
    const result = normalizePhpEntryInsightsReport(graph({ depth: 1 }), "src/Repository.php");
    expect(result.status).toBe("incomplete");
    expect(result.targets[0]!.truncated).toBe(true);
    expect(result.targets[0]!.entries).toEqual([]);
  });
  it("terminates cycles and still reaches configured entry", () => {
    const report = graph();
    report.snapshot.edges.push({
      from: "repo",
      to: "service",
      path: "src/Repository.php",
      line: 7,
      column: 9,
    });
    const result = normalizePhpEntryInsightsReport(report, "src/Repository.php");
    expect(result.status).toBe("complete");
    expect(result.targets[0]!.entries).toHaveLength(1);
    expect(result.targets[0]!.cycles).toEqual([
      "Call cycle: App\\Repository::find → App\\Service::fetch → App\\Repository::find",
    ]);
  });
  it("does not connect incompatible instances of the same service class", () => {
    const report = graph();
    report.snapshot.nodes.push({
      id: "service-other",
      symbol: "App\\Service::fetch",
      path: "src/Service.php",
      line: 12,
      column: 5,
      entry_scope: null,
    });
    report.snapshot.edges[0]!.to = "service-other";
    const result = normalizePhpEntryInsightsReport(report, "src/Repository.php");
    expect(result.targets[0]!.directCallers).toHaveLength(1);
    expect(result.targets[0]!.entries).toEqual([]);
    Object.assign(report.snapshot.nodes[1]!, { service_id: "processor.safe" });
    Object.assign(report.snapshot.nodes.at(-1)!, { service_id: "processor.other" });
    const services = normalizePhpEntryInsightsReport(report, "src/Service.php").targets;
    expect(services.map((target) => [target.id, target.serviceId])).toEqual([
      ["service", "processor.safe"],
      ["service-other", "processor.other"],
    ]);
  });
  it("accepts internal NUL service identities while keeping navigable text strict", () => {
    const report = graph();
    const entryId = "app\\controller::index\0controller.http";
    const repositoryId = "app\\repository::find\0repository.safe";
    report.snapshot.nodes[0]!.id = entryId;
    report.snapshot.nodes[2]!.id = repositoryId;
    Object.assign(report.snapshot.nodes[0]!, { service_id: "controller.http" });
    Object.assign(report.snapshot.nodes[2]!, { service_id: "repository.safe" });
    report.snapshot.edges[0]!.from = entryId;
    report.snapshot.edges[1]!.to = repositoryId;
    const result = normalizePhpEntryInsightsReport(report, "src/Repository.php");
    expect(result.status).toBe("complete");
    expect(result.targets[0]!.id).toBe(encodeURIComponent(repositoryId));
    expect(result.targets[0]!.serviceId).toBe("repository.safe");
    expect(result.targets[0]!.entries[0]!.entry.id).toBe(encodeURIComponent(entryId));
    expect(result.targets[0]!.entries[0]!.entry.serviceId).toBe("controller.http");
    report.snapshot.nodes[2]!.path = "src/Bad\0Path.php";
    expect(() => normalizePhpEntryInsightsReport(report, "src/Repository.php")).toThrow(
      "Invalid graph text",
    );
  });
  it("returns one deterministic shortest path even with a second route", () => {
    const report = graph();
    report.snapshot.edges.push({
      from: "entry",
      to: "repo",
      path: "src/Controller.php",
      line: 12,
      column: 9,
    });
    expect(
      normalizePhpEntryInsightsReport(report, "src/Repository.php").targets[0]!.entries[0]!.chain,
    ).toHaveLength(2);
  });
  it("rejects policy proof reports, escaped paths and dangling edges", () => {
    expect(() =>
      normalizePhpEntryInsightsReport(
        { status: "snapshot", snapshot: { schema_version: "1", capability: "scope_graph" } },
        "src/Repository.php",
      ),
    ).toThrow();
    const badPath = graph();
    badPath.snapshot.nodes[0]!.path = "../external.php";
    expect(() => normalizePhpEntryInsightsReport(badPath, "src/Repository.php")).toThrow();
    const badEdge = graph();
    badEdge.snapshot.edges[0]!.to = "missing";
    expect(() => normalizePhpEntryInsightsReport(badEdge, "src/Repository.php")).toThrow();
  });
  it("bounds unusually large files and reports omitted targets", () => {
    const report = graph();
    for (let index = 0; index < 260; index++)
      report.snapshot.nodes.push({
        id: `method-${index}`,
        symbol: `App\\Repository::method${index}`,
        path: "src/Repository.php",
        line: index + 10,
        column: 5,
        entry_scope: null,
      });
    const result = normalizePhpEntryInsightsReport(report, "src/Repository.php");
    expect(result.status).toBe("incomplete");
    expect(result.targets).toHaveLength(256);
    expect(result.targets.every((target) => target.truncated)).toBe(true);
  });
  it("reports old APIs and absent files without fake locations", () => {
    expect(
      normalizePhpEntryInsightsReport(
        { status: "unsupported", message: "Upgrade extension" },
        "src/Foo.php",
      ),
    ).toEqual({ status: "unsupported", message: "Upgrade extension", targets: [] });
    expect(normalizePhpEntryInsightsReport(graph(), "src/Foo.php").status).toBe("unavailable");
  });
});

describe("prepared source graph selection", () => {
  it("validates once and selects many files without rereading the mutable source graph", () => {
    const report = graph();
    let nodeReads = 0;
    const originalNodes = report.snapshot.nodes;
    Object.defineProperty(report.snapshot, "nodes", {
      get() {
        nodeReads++;
        return originalNodes;
      },
      configurable: true,
    });
    const select = preparePhpEntryInsightsReport(report, "artifact/api");
    const expected = select("src/Repository.php");
    const readsAfterPreparation = nodeReads;
    for (let index = 0; index < 100; index++) {
      expect(select("src/Repository.php")).toEqual(expected);
      expect(select("src/Controller.php").targets[0]?.symbol).toBe("App\\Controller::index");
      expect(select("src/absent.php").status).toBe("unavailable");
    }
    expect(nodeReads).toBe(readsAfterPreparation);
    report.snapshot.complete = false;
    report.snapshot.edges.length = 0;
    originalNodes[0]!.symbol = "Mutated";
    report.snapshot.unknown.push("Mutated unknown");
    expect(select("src/Repository.php")).toEqual(expected);
  });
  it("preserves original metadata order when selecting opened and referenced declarations", () => {
    const report = graph();
    const metadata = (symbol: string, path: string, kind = "class") => ({
      symbol,
      path,
      kind,
      line: 1,
      column: 1,
      annotations: [],
    });
    Object.assign(report.snapshot, {
      symbol_metadata: [
        metadata("App\\Controller", "src/Controller.php"),
        metadata("App\\Repository::find", "src/Repository.php", "method"),
        metadata("App\\Unused", "src/Unused.php"),
        metadata("App\\Service", "src/Service.php"),
      ],
      annotation_sites: [],
      comment_column_encoding: "utf8_bytes",
    });
    const select = preparePhpEntryInsightsReport(report, "api");
    expect(select("src/Repository.php").symbolMetadata?.map((item) => item.symbol)).toEqual([
      "App\\Controller",
      "App\\Repository::find",
      "App\\Service",
    ]);
    expect(select("src/Unused.php").symbolMetadata?.map((item) => item.symbol)).toEqual([
      "App\\Unused",
    ]);
  });
  it("validates malformed unselected graph data during preparation", () => {
    const report = graph();
    report.snapshot.nodes.push({ ...report.snapshot.nodes[0]! });
    expect(() => preparePhpEntryInsightsReport(report)).toThrow("Duplicate graph node");
  });
});
