import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as ProcessRunner from "../processRunner.ts";
import * as MagoDockerExecution from "./MagoDockerExecution.ts";

const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const result = (stdout: string, code = 0): ProcessRunner.ProcessRunOutput => ({
  stdout,
  stderr: "",
  code: code as NonNullable<ProcessRunner.ProcessRunOutput["code"]>,
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
  stdoutInvalidUtf8: false,
  stderrInvalidUtf8: false,
});
const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-compose-test-" });
  yield* fs.makeDirectory(`${root}/artifact/api`, { recursive: true });
  yield* fs.writeFileString(`${root}/compose.yaml`, "services: {}");
  return root;
});
function mock(
  root: string,
  options: { stopped?: boolean; mounted?: boolean; binary?: boolean } = {},
) {
  const calls: ProcessRunner.ProcessRunInput[] = [];
  const run: ProcessRunner.ProcessRunner["Service"]["run"] = (input) => {
    calls.push(input);
    if (input.args.includes("ps"))
      return Effect.succeed(result(options.stopped ? "" : "abcdef123456\n"));
    if (input.args[0] === "inspect")
      return Effect.succeed(
        result(
          encode([
            {
              State: { Running: true },
              Mounts:
                options.mounted === false
                  ? []
                  : [{ Type: "bind", Source: root, Destination: "/workspace" }],
            },
          ]),
        ),
      );
    if (input.args.includes("test")) return Effect.succeed(result("", options.binary ? 0 : 1));
    if (input.args.some((arg) => arg.includes("random_bytes")))
      return Effect.succeed(result("/tmp/t3-insights-0123456789abcdef01234567"));
    if (input.args.some((arg) => arg.includes("echo file_get_contents")))
      return Effect.succeed(result('{"status":"complete"}'));
    return Effect.succeed(result(""));
  };
  const layer = MagoDockerExecution.layer.pipe(
    Layer.provide(
      Layer.succeed(ProcessRunner.ProcessRunner, ProcessRunner.ProcessRunner.of({ run })),
    ),
    Layer.provideMerge(NodeServices.layer),
  );
  return { calls, layer };
}
it.effect("finds the parent Compose project and maps nested source paths without a shell", () =>
  Effect.gen(function* () {
    const root = yield* fixture;
    const docker = mock(root, { binary: true });
    const session = yield* Effect.flatMap(MagoDockerExecution.MagoDockerExecution, (service) =>
      service.prepare({
        workspaceRoot: root,
        areaPath: "artifact/api",
        runtime: { service: "php-api" },
        binaryPath: `${root}/artifact/api/tools/vendor/bin/mago`,
      }),
    ).pipe(Effect.provide(docker.layer));
    expect(session.containerAreaRoot).toBe("/workspace/artifact/api");
    expect(session.toContainer(`${root}/artifact/api/src/File with spaces.php`)).toBe(
      "/workspace/artifact/api/src/File with spaces.php",
    );
    expect(session.toHost("/workspace/artifact/api/src/Test.php")).toBe(
      `${root}/artifact/api/src/Test.php`,
    );
    yield* session.runMago(
      ["format", "--dry-run", session.toContainer(`${root}/artifact/api/src/Test.php`)],
      { NO_COLOR: "1", PRIVATE_TOKEN: "do-not-forward" },
    );
    const command = docker.calls.at(-1)!;
    expect(command.command).toBe("docker");
    expect(command.cwd).toBe(root);
    expect(command.args).toContain("-T");
    expect(command.args).toContain("/workspace/artifact/api/tools/vendor/bin/mago");
    expect(command.args).not.toContain("PRIVATE_TOKEN=do-not-forward");
    expect(command.args).not.toContain("sh");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect(
  "supports an explicit container path and a PATH-installed Mago without host vendor files",
  () =>
    Effect.gen(function* () {
      const root = yield* fixture;
      const docker = mock(root, { mounted: false });
      const session = yield* Effect.flatMap(MagoDockerExecution.MagoDockerExecution, (service) =>
        service.prepare({
          workspaceRoot: root,
          areaPath: "artifact/api",
          runtime: { service: "php-api", containerPath: "/app" },
        }),
      ).pipe(Effect.provide(docker.layer));
      expect(session.toContainer(`${root}/artifact/api/mago.toml`)).toBe("/app/mago.toml");
      expect(() => session.toHost("/outside/Test.php")).toThrow();
      yield* session.runMago(["analyze"]);
      expect(docker.calls.at(-1)?.args.slice(-2)).toEqual(["mago", "analyze"]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect.each([
  { stopped: true, stage: "service" },
  { mounted: false, stage: "mount" },
] as const)("reports an unusable Compose service rather than falling back locally: %s", (options) =>
  Effect.gen(function* () {
    const root = yield* fixture;
    const docker = mock(root, options);
    const output = yield* Effect.flatMap(MagoDockerExecution.MagoDockerExecution, (service) =>
      service.prepare({
        workspaceRoot: root,
        areaPath: "artifact/api",
        runtime: { service: "php-api" },
      }),
    ).pipe(Effect.result, Effect.provide(docker.layer));
    expect(output._tag).toBe("Failure");
    if (output._tag === "Failure") expect(output.failure.stage).toBe(options.stage);
    expect(docker.calls.some((call) => call.args.includes("exec"))).toBe(false);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("stages bounded insight files inside the container and cleans them on scope exit", () =>
  Effect.gen(function* () {
    const root = yield* fixture;
    const docker = mock(root);
    yield* Effect.scoped(
      Effect.gen(function* () {
        const session = yield* Effect.flatMap(MagoDockerExecution.MagoDockerExecution, (service) =>
          service.prepare({
            workspaceRoot: root,
            areaPath: "artifact/api",
            runtime: { service: "php-api" },
          }),
        ).pipe(Effect.provide(docker.layer));
        const temp = yield* session.allocateTemp;
        yield* temp.write("input.json", '{"file":"test"}');
        expect(docker.calls.at(-1)?.stdin).toBe('{"file":"test"}');
        expect(yield* temp.read("queries.json", 1024)).toBe('{"status":"complete"}');
        expect(docker.calls.at(-1)?.maxOutputBytes).toBe(1024);
      }),
    );
    expect(docker.calls.at(-1)?.args.some((arg) => arg.includes("rmdir"))).toBe(true);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
