import type { MonolithMagoDocker } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as ProcessRunner from "../processRunner.ts";

export class MagoDockerError extends Schema.TaggedError<MagoDockerError>()("MagoDockerError", {
  stage: Schema.Literals(["configuration", "service", "mount", "process", "temporary"]),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    if (this.stage === "service")
      return "Start the configured Docker Compose service; it must resolve to one running container.";
    if (this.stage === "mount")
      return "The PHP area has no matching Docker bind mount. Configure its container path explicitly.";
    if (this.stage === "configuration")
      return "No usable Compose configuration was found inside this repository.";
    return `Docker Mago execution could not complete (${this.stage}).`;
  }
}

const isMagoDockerError = Schema.is(MagoDockerError);

export interface MagoDockerTemp {
  readonly path: string;
  readonly write: (name: string, contents: string) => Effect.Effect<void, MagoDockerError>;
  readonly read: (name: string, maxBytes?: number) => Effect.Effect<string, MagoDockerError>;
}
export interface MagoDockerSession {
  readonly hostAreaRoot: string;
  readonly containerAreaRoot: string;
  readonly composeArgs: readonly string[];
  readonly toContainer: (hostPath: string) => string;
  readonly toHost: (containerPath: string) => string;
  readonly runMago: (
    args: readonly string[],
    env?: NodeJS.ProcessEnv,
  ) => Effect.Effect<ProcessRunner.ProcessRunOutput, MagoDockerError>;
  readonly runPhp: (
    args: readonly string[],
    env?: NodeJS.ProcessEnv,
    stdin?: string,
    options?: { readonly maxOutputBytes?: number },
  ) => Effect.Effect<ProcessRunner.ProcessRunOutput, MagoDockerError>;
  readonly exists: (hostPath: string) => Effect.Effect<boolean, MagoDockerError>;
  readonly allocateTemp: Effect.Effect<MagoDockerTemp, MagoDockerError, Scope.Scope>;
}
export class MagoDockerExecution extends Context.Service<
  MagoDockerExecution,
  {
    readonly prepare: (input: {
      readonly workspaceRoot: string;
      readonly areaPath: string;
      readonly runtime: MonolithMagoDocker;
      readonly binaryPath?: string;
    }) => Effect.Effect<MagoDockerSession, MagoDockerError>;
  }
>()("t3/analyzers/MagoDockerExecution") {}

interface Mapping {
  readonly host: string;
  readonly container: string;
}
const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const object = (value: unknown): Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid Docker inspection.");
  return value as Record<string, unknown>;
};
const temporaryName = (value: string) => {
  if (!/^[a-zA-Z0-9_.-]{1,100}$/.test(value) || value === "." || value === "..")
    throw new Error("Invalid temporary filename.");
  return value;
};
const checkOutput = (output: ProcessRunner.ProcessRunOutput) => {
  if (
    output.code !== 0 ||
    output.timedOut ||
    output.stdoutTruncated ||
    output.stderrTruncated ||
    output.stdoutInvalidUtf8 ||
    output.stderrInvalidUtf8
  )
    throw new Error("Incomplete Docker command output.");
  return output.stdout;
};
const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const paths = yield* Path.Path;
  const runner = yield* ProcessRunner.ProcessRunner;
  const prepare = Effect.fn("MagoDockerExecution.prepare")(function* (input: {
    workspaceRoot: string;
    areaPath: string;
    runtime: MonolithMagoDocker;
    binaryPath?: string;
  }) {
    const root = paths.resolve(input.workspaceRoot);
    const hostAreaRoot = paths.resolve(root, input.areaPath);
    const within = (target: string, base: string) => {
      const relative = paths.relative(base, target);
      return (
        relative !== ".." && !relative.startsWith(`..${paths.sep}`) && !paths.isAbsolute(relative)
      );
    };
    if (!within(hostAreaRoot, root)) return yield* new MagoDockerError({ stage: "configuration" });
    let composeDirectory =
      input.runtime.composeDirectory === undefined
        ? hostAreaRoot
        : paths.resolve(root, input.runtime.composeDirectory);
    if (!within(composeDirectory, root))
      return yield* new MagoDockerError({ stage: "configuration" });
    const composeFiles = input.runtime.composeFiles?.map((file) => paths.resolve(root, file)) ?? [];
    for (const file of composeFiles) {
      if (
        !within(file, root) ||
        (yield* fs.realPath(file)) !== file ||
        (yield* fs.stat(file)).type !== "File"
      )
        return yield* new MagoDockerError({ stage: "configuration" });
    }
    if (composeFiles.length && input.runtime.composeDirectory === undefined)
      composeDirectory = paths.dirname(composeFiles[0]!);
    while (true) {
      if ((yield* fs.realPath(composeDirectory)) !== composeDirectory)
        return yield* new MagoDockerError({ stage: "configuration" });
      if (composeFiles.length) break;
      let found = false;
      for (const name of [
        "compose.yaml",
        "compose.yml",
        "docker-compose.yaml",
        "docker-compose.yml",
      ]) {
        const file = paths.join(composeDirectory, name);
        if (yield* fs.exists(file)) {
          if ((yield* fs.realPath(file)) !== file)
            return yield* new MagoDockerError({ stage: "configuration" });
          found = true;
          break;
        }
      }
      if (found) break;
      if (composeDirectory === root || input.runtime.composeDirectory !== undefined)
        return yield* new MagoDockerError({ stage: "configuration" });
      composeDirectory = paths.dirname(composeDirectory);
    }
    const docker = Effect.fnUntraced(function* (
      args: readonly string[],
      stdin?: string,
      maxOutputBytes = 4_000_000,
    ) {
      return yield* runner
        .run({
          command: "docker",
          args,
          cwd: composeDirectory,
          env: { ...process.env, NO_COLOR: "1" },
          stdin,
          timeout: 60_000,
          maxOutputBytes,
          outputMode: "error",
          timeoutBehavior: "error",
        })
        .pipe(Effect.mapError((cause) => new MagoDockerError({ stage: "process", cause })));
    });
    const compose = [
      "compose",
      "--project-directory",
      composeDirectory,
      ...composeFiles.flatMap((file) => ["-f", file]),
    ];
    const ids = yield* docker([...compose, "ps", "--quiet", input.runtime.service]).pipe(
      Effect.flatMap((output) =>
        Effect.try(() => checkOutput(output).trim().split(/\s+/).filter(Boolean)),
      ),
      Effect.mapError((cause) => new MagoDockerError({ stage: "service", cause })),
    );
    if (ids.length !== 1 || !/^[a-f0-9]{12,64}$/i.test(ids[0]!))
      return yield* new MagoDockerError({ stage: "service" });
    const inspection = yield* docker(["inspect", ids[0]!]).pipe(
      Effect.flatMap((output) => Effect.try(() => checkOutput(output))),
      Effect.flatMap(decodeJson),
      Effect.flatMap((value) =>
        Effect.try(() => {
          if (!Array.isArray(value) || value.length !== 1) throw new Error("Ambiguous container.");
          const container = object(value[0]);
          if (object(container.State).Running !== true || !Array.isArray(container.Mounts))
            throw new Error("Container is not running.");
          return container.Mounts.map(object)
            .filter(
              (mount) =>
                mount.Type === "bind" &&
                typeof mount.Source === "string" &&
                typeof mount.Destination === "string",
            )
            .map((mount): Mapping => ({
              host: paths.resolve(mount.Source as string),
              container: (mount.Destination as string).replace(/\/$/, "") || "/",
            }));
        }),
      ),
      Effect.mapError((cause) => new MagoDockerError({ stage: "service", cause })),
    );
    const mounts = [...inspection].sort((a, b) => b.host.length - a.host.length);
    const areaMount = mounts.find((mapping) => within(hostAreaRoot, mapping.host));
    const containerAreaRoot =
      input.runtime.containerPath?.replace(/\/$/, "") ||
      (areaMount
        ? `${areaMount.container.replace(/\/$/, "")}/${paths.relative(areaMount.host, hostAreaRoot).split(paths.sep).join("/")}`.replace(
            /\/$/,
            "",
          ) || "/"
        : undefined);
    if (containerAreaRoot === undefined) return yield* new MagoDockerError({ stage: "mount" });
    const mappings = [{ host: hostAreaRoot, container: containerAreaRoot }, ...mounts].sort(
      (a, b) => b.host.length - a.host.length,
    );
    const toContainer = (hostPath: string) => {
      const absolute = paths.resolve(hostPath);
      const mapping = mappings.find((item) => within(absolute, item.host));
      if (!mapping) throw new Error("Host path has no container mapping.");
      const suffix = paths.relative(mapping.host, absolute).split(paths.sep).join("/");
      return suffix === ""
        ? mapping.container
        : `${mapping.container.replace(/\/$/, "")}/${suffix}`;
    };
    const toHost = (containerPath: string) => {
      const mapping = [...mappings]
        .sort((a, b) => b.container.length - a.container.length)
        .find(
          (item) =>
            containerPath === item.container ||
            containerPath.startsWith(`${item.container.replace(/\/$/, "")}/`),
        );
      if (!mapping) throw new Error("Container path has no checkout mapping.");
      const suffix = containerPath.slice(mapping.container.length).replace(/^\//, "");
      if (suffix.split("/").some((part) => part === ".." || part === "."))
        throw new Error("Unsafe container path.");
      return paths.resolve(mapping.host, suffix);
    };
    const exec = (
      command: string,
      args: readonly string[],
      env?: NodeJS.ProcessEnv,
      stdin?: string,
      maxBytes?: number,
    ) => {
      const environment = Object.entries(env ?? {})
        .filter(
          ([key, value]) =>
            value !== undefined &&
            ["NO_COLOR", "T3_PHP_INSIGHTS_INPUT", "APP_ENV", "APP_DEBUG"].includes(key),
        )
        .flatMap(([key, value]) => ["--env", `${key}=${value}`]);
      return docker(
        [
          ...compose,
          "exec",
          "-T",
          "--workdir",
          containerAreaRoot,
          ...environment,
          input.runtime.service,
          command,
          ...args,
        ],
        stdin,
        maxBytes,
      );
    };
    const runPhp: MagoDockerSession["runPhp"] = (args, env, stdin, options) =>
      exec("php", args, env, stdin, options?.maxOutputBytes);
    const exists: MagoDockerSession["exists"] = (hostPath) =>
      Effect.try(() => toContainer(hostPath)).pipe(
        Effect.flatMap((file) => exec("test", ["-f", file])),
        Effect.map((output) => output.code === 0),
        Effect.mapError((cause) => new MagoDockerError({ stage: "process", cause })),
      );
    let binary = input.runtime.binary;
    if (!binary && input.binaryPath && (yield* exists(input.binaryPath)))
      binary = toContainer(input.binaryPath);
    binary ??= "mago";
    if (!binary.startsWith("/") && binary.includes("/"))
      binary = `${containerAreaRoot.replace(/\/$/, "")}/${binary}`;
    const runMago: MagoDockerSession["runMago"] = (args, env) => exec(binary, args, env);
    const allocateTemp = Effect.gen(function* () {
      const directory = yield* runPhp([
        "-r",
        '$p=sys_get_temp_dir()."/t3-insights-".bin2hex(random_bytes(12)); if(!mkdir($p,0700))exit(1); echo $p;',
      ]).pipe(
        Effect.flatMap((output) => Effect.try(() => checkOutput(output))),
        Effect.mapError((cause) => new MagoDockerError({ stage: "temporary", cause })),
      );
      if (!/^\/[^\r\n\0]*\/t3-insights-[a-f0-9]{24}$/.test(directory))
        return yield* new MagoDockerError({ stage: "temporary" });
      yield* Effect.addFinalizer(() =>
        runPhp([
          "-r",
          'foreach(scandir($argv[1])?:[] as $n){if($n!=="."&&$n!=="..")unlink($argv[1]."/".$n);} rmdir($argv[1]);',
          directory,
        ]).pipe(Effect.ignoreCause),
      );
      const write: MagoDockerTemp["write"] = (name, contents) =>
        Effect.try(() => `${directory}/${temporaryName(name)}`).pipe(
          Effect.flatMap((file) =>
            runPhp(
              [
                "-r",
                'if(file_put_contents($argv[1],file_get_contents("php://stdin"))===false)exit(1);',
                file,
              ],
              undefined,
              contents,
            ),
          ),
          Effect.flatMap((output) => Effect.try(() => checkOutput(output))),
          Effect.asVoid,
          Effect.mapError((cause) => new MagoDockerError({ stage: "temporary", cause })),
        );
      const read: MagoDockerTemp["read"] = (name, maxBytes = 16 * 1024 * 1024) =>
        Effect.try(() => `${directory}/${temporaryName(name)}`).pipe(
          Effect.flatMap((file) =>
            exec(
              "php",
              [
                "-r",
                "if(!is_file($argv[1])||is_link($argv[1])||filesize($argv[1])>(int)$argv[2])exit(1);echo file_get_contents($argv[1]);",
                file,
                String(maxBytes),
              ],
              undefined,
              undefined,
              maxBytes,
            ),
          ),
          Effect.flatMap((output) => Effect.try(() => checkOutput(output))),
          Effect.mapError((cause) => new MagoDockerError({ stage: "temporary", cause })),
        );
      return { path: directory, write, read };
    });
    return {
      hostAreaRoot,
      containerAreaRoot,
      composeArgs: compose,
      toContainer,
      toHost,
      runMago,
      runPhp,
      exists,
      allocateTemp,
    } satisfies MagoDockerSession;
  });
  return MagoDockerExecution.of({
    prepare: (input) =>
      prepare(input).pipe(
        Effect.mapError((cause) =>
          isMagoDockerError(cause) ? cause : new MagoDockerError({ stage: "configuration", cause }),
        ),
      ),
  });
});
export const layer = Layer.effect(MagoDockerExecution, make);
