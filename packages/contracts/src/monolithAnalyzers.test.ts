import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import { MonolithAnalyzerDiagnostic, MonolithAnalyzerInstallation } from "./monolith.ts";

const decode = Schema.decodeUnknownSync(MonolithAnalyzerDiagnostic);
const decodeInstallation = Schema.decodeUnknownSync(MonolithAnalyzerInstallation);

describe("React analyzer contracts", () => {
  it("transports file-level dependency diagnostics and located ESLint findings", () => {
    const finding = {
      path: "app/source.ts",
      tool: "depcruise",
      operation: "check",
      severity: "error",
      message: "Forbidden dependency",
      ruleId: "no-cycle",
    };
    expect(decode(finding)).toEqual(finding);
    expect(decode({ ...finding, tool: "eslint", line: 3, column: 2 })).toMatchObject({
      tool: "eslint",
      line: 3,
      column: 2,
    });
    expect(() => decode({ ...finding, line: 0 })).toThrow();
    expect(() => decode({ ...finding, column: 1.5 })).toThrow();
  });
  it("transports dependency-cruiser source path metadata", () => {
    expect(
      decodeInstallation({
        tool: "depcruise",
        manifestPath: "package.json",
        workingDirectory: "ui",
        binaryPath: "node_modules/.bin/depcruise",
        available: true,
        symfonyWiring: false,
        scripts: [
          {
            name: "architecture",
            operation: "check",
            command: "depcruise app",
            sourcePaths: ["ui/app"],
          },
        ],
      }).scripts[0]?.sourcePaths,
    ).toEqual(["ui/app"]);
  });
});
