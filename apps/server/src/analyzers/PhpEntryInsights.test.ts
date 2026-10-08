import { describe, expect, it } from "vite-plus/test";
import { normalizePhpEntryInsightsReport } from "./PhpEntryInsights.ts";
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
