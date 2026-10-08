import { describe, expect, it } from "vite-plus/test";
import { composeTerminalArguments } from "./ComposeLaunch.ts";
describe("Compose terminal process arguments", () => {
  const input = {
    composeArgs: [
      "compose",
      "--project-directory",
      "/repo with spaces",
      "-f",
      "/repo with spaces/infra/compose.yml",
    ],
    service: "catalog-php",
    containerAreaRoot: "/workspace/catalog",
    marker: "/tmp/t3-owned-test.pid",
  };
  it("starts a container shell using argv and a private cleanup marker, never interpolating paths", () => {
    const args = composeTerminalArguments({ ...input, mode: "shell" });
    expect(args.slice(0, 9)).toEqual([
      ...input.composeArgs,
      "exec",
      "--workdir",
      input.containerAreaRoot,
      input.service,
    ]);
    expect(args.slice(-4)).toEqual([
      "-c",
      expect.stringContaining('trap "cleanup; exit 0" HUP TERM'),
      "t3-docker-shell",
      input.marker,
    ]);
  });
  it("streams bounded history of exactly the selected service using Compose logs", () => {
    expect(composeTerminalArguments({ ...input, mode: "logs" })).toEqual([
      ...input.composeArgs,
      "logs",
      "--follow",
      "--tail",
      "200",
      "--",
      input.service,
    ]);
  });
});
