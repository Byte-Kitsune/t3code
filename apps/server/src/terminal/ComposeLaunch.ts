import { TerminalComposeError, type TerminalOpenInput } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Crypto from "effect/Crypto";
import * as Schema from "effect/Schema";
import { MagoDockerExecution } from "../analyzers/MagoDockerExecution.ts";
import { MonolithService } from "../project/MonolithService.ts";
import * as ProcessRunner from "../processRunner.ts";

export interface ComposeLaunchCommand {
  readonly shell: string;
  readonly args: string[];
  readonly cleanup: Effect.Effect<void>;
}

// Fixed scripts, with every changing value passed as a separate positional argument.
// The marker and cmdline check let cleanup address only our own container shell.
const SHELL =
  'umask 077; marker="$1"; printf "%s\\n" "$$" > "$marker"; child=""; stop_children() { [ "$2" -lt 32 ] || return; for owned in $(cat "/proc/$1/task/$1/children" 2>/dev/null); do stop_children "$owned" "$(($2 + 1))"; done; if [ "$2" -gt 0 ]; then kill -TERM "$1" 2>/dev/null || true; sleep 0.05; fi; }; cleanup() { if [ -n "$child" ]; then stop_children "$child" 0; sleep 0.1; kill -HUP "$child" 2>/dev/null || true; wait "$child" 2>/dev/null || true; fi; rm -f "$marker"; }; trap "cleanup; exit 0" HUP TERM; exec 3<&0; /bin/sh -i <&3 & child=$!; wait "$child"; result=$?; cleanup; exit "$result"';
const CLEANUP =
  'marker="$1"; [ -f "$marker" ] || exit 0; read -r pid < "$marker"; case "$pid" in ""|*[!0-9]*) exit 0;; esac; [ -r "/proc/$pid/cmdline" ] || { rm -f "$marker"; exit 0; }; command=$(tr "\\000" " " < "/proc/$pid/cmdline"); case "$command" in *"$marker"*) kill -TERM "$pid" 2>/dev/null || true;; esac';

export function composeTerminalArguments(input: {
  readonly composeArgs: readonly string[];
  readonly service: string;
  readonly containerAreaRoot: string;
  readonly mode: "shell" | "logs";
  readonly marker: string;
}): string[] {
  return input.mode === "logs"
    ? [...input.composeArgs, "logs", "--follow", "--tail", "200", "--", input.service]
    : [
        ...input.composeArgs,
        "exec",
        "--workdir",
        input.containerAreaRoot,
        input.service,
        "/bin/sh",
        "-c",
        SHELL,
        "t3-docker-shell",
        input.marker,
      ];
}

export class TerminalComposeLaunch extends Context.Service<
  TerminalComposeLaunch,
  {
    readonly resolve: (
      input: TerminalOpenInput,
    ) => Effect.Effect<ComposeLaunchCommand, TerminalComposeError>;
  }
>()("t3/terminal/ComposeLaunch/TerminalComposeLaunch") {}

const isComposeError = Schema.is(TerminalComposeError);

const make = Effect.gen(function* () {
  const monolith = yield* MonolithService;
  const docker = yield* MagoDockerExecution;
  const runner = yield* ProcessRunner.ProcessRunner;
  const crypto = yield* Crypto.Crypto;
  const resolve = Effect.fn("TerminalComposeLaunch.resolve")(function* (input: TerminalOpenInput) {
    if (!input.compose)
      return yield* new TerminalComposeError({ message: "A Docker terminal target is required." });
    const snapshot = yield* monolith.get({
      cwd: input.worktreePath ?? input.cwd,
      initialize: false,
    });
    const area = snapshot.config.areas.find((area) => area.id === input.compose!.areaId);
    if (!area || area.kind !== "php" || !area.magoDocker)
      return yield* new TerminalComposeError({
        message:
          "This PHP area has no configured Docker Compose service. Refresh the terminal targets.",
      });
    const session = yield* docker.prepare({
      workspaceRoot: input.worktreePath ?? input.cwd,
      areaPath: area.path,
      runtime: area.magoDocker,
    });
    const marker = `/tmp/t3-terminal-${yield* crypto.randomUUIDv4}.pid`;
    const cleanup =
      input.compose.mode === "logs"
        ? Effect.void
        : runner
            .run({
              command: "docker",
              args: [
                ...session.composeArgs,
                "exec",
                "-T",
                area.magoDocker.service,
                "/bin/sh",
                "-c",
                CLEANUP,
                "t3-docker-cleanup",
                marker,
              ],
              cwd: input.worktreePath ?? input.cwd,
              timeout: "5 seconds",
              maxOutputBytes: 16_384,
            })
            .pipe(Effect.asVoid, Effect.ignore);
    return {
      shell: "docker",
      args: composeTerminalArguments({
        composeArgs: session.composeArgs,
        service: area.magoDocker.service,
        containerAreaRoot: session.containerAreaRoot,
        mode: input.compose.mode,
        marker,
      }),
      cleanup,
    };
  });
  return TerminalComposeLaunch.of({
    resolve: (input) =>
      resolve(input).pipe(
        Effect.mapError((cause) =>
          isComposeError(cause)
            ? cause
            : new TerminalComposeError({ message: cause.message, cause }),
        ),
      ),
  });
});
export const layer = Layer.effect(TerminalComposeLaunch, make);
