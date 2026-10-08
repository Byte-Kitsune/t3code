import type { ProcessRunOutput } from "../processRunner.ts";

// Native output can contain source snippets and literal credentials. Report only
// the exit code and fixed hints matched against a bounded prefix, never the text.
export function analyzerFailureDetails(result: ProcessRunOutput): string {
  const exit = result.code === null ? "No exit code was returned." : `Exit code ${result.code}.`;
  if (result.timedOut) return `${exit} The command exceeded its time limit.`;
  const stderr = result.stderr.slice(0, 16_384);
  if (/unexpected argument|unrecognized option|unknown option|unknown subcommand/i.test(stderr))
    return `${exit} The installed analyzer rejected a command option; check its version and supported flags.`;
  if (
    /failed to (?:parse|load|read).*config|(?:invalid|error parsing|could not parse).*config|TOML parse error/i.test(
      stderr,
    )
  )
    return `${exit} The analyzer could not load its configuration; check the selected config with the same binary and runtime.`;
  if (/permission denied/i.test(stderr))
    return `${exit} The analyzer reported a permission error; check file access in its runtime.`;
  if (/exec format error|bad cpu type/i.test(stderr))
    return `${exit} The analyzer binary does not match this runtime's platform or CPU architecture.`;
  return `${exit} Run the same command in the configured runtime to inspect its native error.`;
}
