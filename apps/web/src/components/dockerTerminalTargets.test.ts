import { describe, expect, it } from "vite-plus/test";
import { dockerTerminalTargets, rememberDockerTerminal } from "./dockerTerminalTargets";
import type { MonolithArea } from "@t3tools/contracts";
const php = (id: string, service: string, composeDirectory?: string): MonolithArea => ({
  id,
  name: id,
  path: id,
  kind: "php",
  magoDocker: { service, ...(composeDirectory ? { composeDirectory } : {}) },
});
describe("Docker terminal targets", () => {
  it("deduplicates shared services, keeps distinct Compose projects and excludes local/generic areas", () => {
    const targets = dockerTerminalTargets([
      php("catalog", "php", "."),
      php("library", "php", "."),
      php("test", "php", "infra"),
      { id: "local", name: "local", path: "local", kind: "php" },
      { id: "docs", name: "docs", path: "docs", kind: "folder" },
    ]);
    expect(targets).toHaveLength(2);
    expect(targets[0]).toMatchObject({ areaId: "catalog", label: "catalog / library · php" });
    expect(targets[1]).toMatchObject({ areaId: "test", label: "test · php" });
  });
  it("keeps same aliases separate when their nearest Compose projects are unknown", () => {
    expect(dockerTerminalTargets([php("catalog", "php"), php("library", "php")])).toHaveLength(2);
    expect(
      dockerTerminalTargets([php("catalog", "php", "infra"), php("library", "php", "infra")]),
    ).toHaveLength(1);
  });
  it("puts the last used service first and bounds retained project history", () => {
    const targets = dockerTerminalTargets([php("a", "alpha"), php("z", "zulu")]);
    expect(
      dockerTerminalTargets([php("a", "alpha"), php("z", "zulu")], [targets[1]!.key])[0]!.service,
    ).toBe("zulu");
    const recent = rememberDockerTerminal(
      Array.from({ length: 90 }, (_, index) => `${index}`),
      "2",
    );
    expect(recent).toHaveLength(64);
    expect(recent[0]).toBe("2");
    expect(recent.filter((item) => item === "2")).toHaveLength(1);
  });
});
