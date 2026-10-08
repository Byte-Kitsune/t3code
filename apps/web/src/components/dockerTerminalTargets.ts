import type { MonolithArea } from "@t3tools/contracts";

export interface DockerTerminalTarget {
  readonly key: string;
  readonly areaId: string;
  readonly service: string;
  readonly label: string;
}

export function dockerTerminalTargets(
  areas: readonly MonolithArea[],
  recent: readonly string[] = [],
): readonly DockerTerminalTarget[] {
  const groups = new Map<string, { areaId: string; service: string; names: string[] }>();
  for (const area of areas) {
    if (area.kind !== "php" || !area.magoDocker) continue;
    const runtime = area.magoDocker;
    const key = JSON.stringify([
      runtime.service,
      runtime.composeDirectory ?? "",
      runtime.composeFiles ?? [],
      runtime.composeDirectory === undefined && !runtime.composeFiles?.length ? area.path : "",
    ]);
    const existing = groups.get(key);
    if (existing) existing.names.push(area.name);
    else groups.set(key, { areaId: area.id, service: runtime.service, names: [area.name] });
  }
  return [...groups]
    .map(([key, group]) => ({
      key,
      areaId: group.areaId,
      service: group.service,
      label: `${group.names.join(" / ")} · ${group.service}`,
    }))
    .sort((a, b) => {
      const left = recent.indexOf(a.key),
        right = recent.indexOf(b.key);
      return (
        (left < 0 ? Infinity : left) - (right < 0 ? Infinity : right) ||
        a.label.localeCompare(b.label)
      );
    });
}

export function rememberDockerTerminal(recent: readonly string[], key: string): string[] {
  return [key, ...recent.filter((item) => item !== key)].slice(0, 64);
}
