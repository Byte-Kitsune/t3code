import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import { MonolithArea, MonolithConfig } from "./monolith.ts";

const decodeArea = Schema.decodeUnknownSync(MonolithArea);
const jsonConfig = Schema.fromJsonString(MonolithConfig);
const decodeConfig = Schema.decodeUnknownSync(jsonConfig);
const encodeConfig = Schema.encodeSync(jsonConfig);
const area = { id: "api", name: "API", path: "artifact/api", kind: "php" };

describe("per-area Docker Mago configuration", () => {
  it("keeps local execution optional and supports a minimal service selection", () => {
    expect(decodeArea(area).magoDocker).toBeUndefined();
    expect(decodeArea({ ...area, magoDocker: { service: "php-runtime_1" } }).magoDocker).toEqual({
      service: "php-runtime_1",
    });
  });
  it("round trips Docker overrides in the committable repository config", () => {
    const config = {
      version: 1 as const,
      initialized: true as const,
      areas: [
        {
          ...area,
          kind: "php" as const,
          magoDocker: {
            service: "php",
            composeDirectory: ".",
            containerPath: "/app/artifact/api",
            binary: "tools/vendor/bin/mago",
          },
        },
      ],
    };
    expect(decodeConfig(encodeConfig(config))).toEqual(config);
  });
  it.each(["", "-php", "php runtime", "php;echo", "php/other", "x".repeat(101)])(
    "rejects invalid Compose service %s",
    (service) => {
      expect(() => decodeArea({ ...area, magoDocker: { service } })).toThrow();
    },
  );
  it.each(["../outside", "/host/project", "C:\\project", "artifact/../other"])(
    "rejects Compose folders outside the repository: %s",
    (composeDirectory) => {
      expect(() =>
        decodeArea({ ...area, magoDocker: { service: "php", composeDirectory } }),
      ).toThrow();
    },
  );
  it.each(["app/api", "/app/../other", "/app//api", "/app/./api", "/app\0", "C:\\app"])(
    "rejects invalid container path %s",
    (containerPath) => {
      expect(() =>
        decodeArea({ ...area, magoDocker: { service: "php", containerPath } }),
      ).toThrow();
    },
  );
  it.each([
    "mago --fix",
    "mago;echo",
    "$(command)",
    "../mago",
    "-mago",
    "vendor\\bin\\mago",
    "tools/./mago",
  ])("rejects executable arguments and malformed binary %s", (binary) => {
    expect(() => decodeArea({ ...area, magoDocker: { service: "php", binary } })).toThrow();
  });
  it.each(["mago", "vendor/bin/mago", "/usr/local/bin/mago"])(
    "accepts an executable argv path %s",
    (binary) => {
      expect(
        decodeArea({ ...area, magoDocker: { service: "php", binary } }).magoDocker?.binary,
      ).toBe(binary);
    },
  );
});
