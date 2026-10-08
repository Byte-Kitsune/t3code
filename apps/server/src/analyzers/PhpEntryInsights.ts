/** Full source graphs come from the architecture extension, never policy findings. */
interface GraphNode {
  readonly id: string;
  readonly symbol: string;
  readonly path: string;
  readonly line: number;
  readonly column: number;
  readonly entryScope: string | null;
  readonly serviceId: string | null;
}
interface GraphEdge {
  readonly from: string;
  readonly to: string;
  readonly path: string;
  readonly line: number;
  readonly column: number;
}
export interface PhpEntryLocation {
  readonly id: string;
  readonly serviceId?: string;
  readonly symbol: string;
  readonly path: string;
  readonly line: number;
  readonly column: number;
}
export interface PhpEntryChain {
  readonly entry: PhpEntryLocation;
  readonly chain: readonly PhpEntryLocation[];
  readonly evidence: "call";
  readonly complete: boolean;
}
export interface PhpEntryTarget extends PhpEntryLocation {
  readonly directCallers: readonly PhpEntryLocation[];
  readonly entries: readonly PhpEntryChain[];
  readonly unknown: readonly string[];
  readonly cycles: readonly string[];
  readonly truncated: boolean;
}
export interface PhpEntryInsights {
  readonly status: "complete" | "incomplete" | "unavailable" | "unsupported" | "failed";
  readonly message?: string;
  readonly targets: readonly PhpEntryTarget[];
}
function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid graph object.");
  return value as Record<string, unknown>;
}
function text(value: unknown, max = 4096): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max || /\0/.test(value))
    throw new Error("Invalid graph text.");
  return value;
}
function position(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
    throw new Error("Invalid graph source position.");
  return value;
}
function relativePath(value: unknown): string {
  const path = text(value);
  if (
    path.startsWith("/") ||
    path.includes("\\") ||
    path.includes(":") ||
    path.split("/").some((part) => part === "" || part === "." || part === "..")
  )
    throw new Error("Graph source path escapes the area.");
  return path;
}
function list(value: unknown, max: number): readonly unknown[] {
  if (!Array.isArray(value) || value.length > max) throw new Error("Graph exceeds work bounds.");
  return value;
}

/** One deterministic shortest chain per configured entry and target service variant. */
export function normalizePhpEntryInsightsReport(
  value: unknown,
  openedAreaRelativePath: string,
  areaRepoPrefix = "",
): PhpEntryInsights {
  const report = object(value);
  if (report.status !== "snapshot") {
    if (!["unavailable", "unsupported", "failed"].includes(String(report.status)))
      throw new Error("Unexpected graph insight status.");
    return {
      status: report.status as "unavailable" | "unsupported" | "failed",
      message: text(report.message),
      targets: [],
    };
  }
  const snapshot = object(report.snapshot);
  if (
    snapshot.schema_version !== "1" ||
    snapshot.capability !== "full_source_call_graph" ||
    typeof snapshot.complete !== "boolean"
  )
    throw new Error("Unsupported full source graph.");
  const maxDepth = position(snapshot.max_depth);
  if (maxDepth > 64) throw new Error("Graph depth exceeds work bounds.");
  relativePath(openedAreaRelativePath);
  const prefix =
    areaRepoPrefix === "" || areaRepoPrefix === "." ? "" : `${relativePath(areaRepoPrefix)}/`;
  const nodes = new Map<string, GraphNode>();
  for (const value of list(snapshot.nodes, 50_000)) {
    const node = object(value);
    const id = text(node.id);
    if (nodes.has(id)) throw new Error("Duplicate graph node identity.");
    nodes.set(id, {
      id,
      symbol: text(node.symbol),
      path: relativePath(node.path),
      line: position(node.line),
      column: position(node.column),
      entryScope: node.entry_scope === null ? null : text(node.entry_scope),
      serviceId: node.service_id == null ? null : text(node.service_id, 512),
    });
  }
  const reverse = new Map<string, GraphEdge[]>();
  for (const value of list(snapshot.edges, 250_000)) {
    const edge = object(value);
    const from = text(edge.from);
    const to = text(edge.to);
    const path = relativePath(edge.path);
    if (!nodes.has(from) || !nodes.has(to) || nodes.get(from)!.path !== path)
      throw new Error("Graph edge has no unique source/target declaration.");
    const bucket = reverse.get(to) ?? [];
    bucket.push({ from, to, path, line: position(edge.line), column: position(edge.column) });
    reverse.set(to, bucket);
  }
  for (const edges of reverse.values())
    edges.sort((a, b) => a.from.localeCompare(b.from) || a.line - b.line || a.column - b.column);
  const unknown = list(snapshot.unknown, 250_000).map((item) => text(item));
  const location = (node: GraphNode): PhpEntryLocation => ({
    id: node.id,
    ...(node.serviceId === null ? {} : { serviceId: node.serviceId }),
    symbol: node.symbol,
    path: `${prefix}${node.path}`,
    line: node.line,
    column: node.column,
  });
  const selected = [...nodes.values()]
    .filter((node) => node.path === openedAreaRelativePath)
    .sort((a, b) => a.line - b.line || a.id.localeCompare(b.id));
  if (selected.length === 0)
    return {
      status: "unavailable",
      message: "The opened file has no uniquely modeled method in the source graph.",
      targets: [],
    };
  const targets: PhpEntryTarget[] = [];
  let traversalVisits = 0;
  // Multiple service variants keep independent reverse searches; collapsing them
  // into a class would invent paths between incompatible constructor bindings.
  for (const target of selected.slice(0, 256)) {
    const direct = new Map<string, PhpEntryLocation>();
    for (const edge of reverse.get(target.id) ?? []) {
      const caller = nodes.get(edge.from)!;
      const item = { ...location(caller), line: edge.line, column: edge.column };
      direct.set(`${item.id}:${item.path}:${item.line}:${item.column}`, item);
    }
    const queue: { id: string; chain: readonly string[] }[] = [
      { id: target.id, chain: [target.id] },
    ];
    const seen = new Set([target.id]);
    const entries: PhpEntryChain[] = [];
    const cycles = new Set<string>();
    let truncated = unknown.length > 200 || direct.size > 500 || selected.length > 256;
    for (let index = 0; index < queue.length; index++) {
      if (++traversalVisits > 250_000) {
        truncated = true;
        break;
      }
      const current = queue[index]!;
      const node = nodes.get(current.id)!;
      if (node.entryScope !== null) {
        if (entries.length >= 200) {
          truncated = true;
          break;
        }
        entries.push({
          entry: location(node),
          chain: current.chain.map((id) => location(nodes.get(id)!)),
          evidence: "call",
          complete: snapshot.complete,
        });
      }
      const incoming = reverse.get(current.id) ?? [];
      for (const edge of incoming) {
        const cycleIndex = current.chain.indexOf(edge.from);
        if (cycleIndex < 0) continue;
        const symbols = [
          edge.from,
          ...current.chain.slice(0, cycleIndex).toReversed(),
          edge.from,
        ].map((id) => nodes.get(id)!.symbol);
        if (cycles.size <= 32) cycles.add(`Call cycle: ${symbols.join(" → ")}`);
        else truncated = true;
      }
      if (cycles.size > 32) truncated = true;
      if (current.chain.length - 1 >= maxDepth) {
        if (incoming.some((edge) => !seen.has(edge.from))) truncated = true;
        continue;
      }
      for (const edge of incoming) {
        if (seen.has(edge.from)) continue;
        seen.add(edge.from);
        queue.push({ id: edge.from, chain: [edge.from, ...current.chain] });
      }
    }
    targets.push({
      ...location(target),
      directCallers: [...direct.values()].slice(0, 500),
      entries: entries.map((entry) => ({ ...entry, complete: entry.complete && !truncated })),
      unknown: unknown.slice(0, 200),
      cycles: [...cycles].slice(0, 32),
      truncated,
    });
  }
  const complete = snapshot.complete && targets.every((target) => !target.truncated);
  return {
    status: complete ? "complete" : "incomplete",
    targets,
    message:
      "One shortest call chain per configured entry and method/service variant; entry scopes are static configuration, not proof of a runtime request.",
  };
}
