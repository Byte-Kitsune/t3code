import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { AuthFilesystemReadScope, type EnvironmentId, type ProjectId } from "@t3tools/contracts";
import { WrenchIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useMonolithAreas } from "~/hooks/useMonolithAreas";
import { useServerConfigs } from "~/state/entities";
import { monolithAnalyzerEnvironment } from "~/state/monolithAnalyzers";
import { useProjectClone } from "~/state/projectClones";
import { useEnvironmentQuery } from "~/state/query";
import { useEnvironmentScope } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "../ui/button";
import { SettingsSection } from "./settingsLayout";

export function MonolithAnalyzersPanel({
  environmentId,
  projectId,
  cwd,
  checkoutLabel,
  sectionId,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  cwd: string;
  checkoutLabel?: string;
  sectionId?: string;
}) {
  const clone = useProjectClone(scopeProjectRef(environmentId, projectId));
  const awaitingClone = clone !== null && clone.phase !== "done";
  const areas = useMonolithAreas(environmentId, awaitingClone ? null : cwd, { initialize: false });
  const configs = useServerConfigs();
  const supported = configs.get(environmentId)?.environment.capabilities.monolithAnalyzers === true;
  const canRead = useEnvironmentScope(environmentId, AuthFilesystemReadScope);
  const canGenerate = useAtomValue(
    monolithAnalyzerEnvironment.generateReferences.permissionAtom(environmentId),
  );
  const query = useEnvironmentQuery(
    supported && canRead && areas.config !== null && !awaitingClone
      ? monolithAnalyzerEnvironment.discovery({ environmentId, input: { cwd } })
      : null,
  );
  const generate = useAtomCommand(monolithAnalyzerEnvironment.generateReferences, {
    reportFailure: false,
  });
  const [operation, setOperation] = useState<{
    key: string;
    areaId: string;
    pending: boolean;
    message: string;
  } | null>(null);
  const key = JSON.stringify([environmentId, cwd]);
  const currentOperation = operation?.key === key ? operation : null;
  const configRef = useRef(areas.config);
  const destinationRef = useRef<string | null>(key);
  useEffect(() => {
    destinationRef.current = key;
    return () => {
      destinationRef.current = null;
    };
  }, [key]);
  const { refresh } = query;
  useEffect(() => {
    const previous = configRef.current;
    configRef.current = areas.config;
    if (previous !== null && areas.config !== null && previous !== areas.config) refresh();
  }, [areas.config, refresh]);

  async function generateReference(areaId: string) {
    if (!canGenerate || awaitingClone) return;
    setOperation({ key, areaId, pending: true, message: "Generating container reference…" });
    const result = await generate({ environmentId, input: { cwd, areaId } });
    if (destinationRef.current !== key) return;
    const failure = result._tag === "Failure" ? squashAtomCommandFailure(result) : null;
    setOperation({
      key,
      areaId,
      pending: false,
      message:
        result._tag === "Failure"
          ? failure instanceof Error
            ? failure.message
            : "Container reference generation failed. No error details were returned."
          : `Container reference generated: ${result.value.path}`,
    });
  }

  if (!supported) return null;
  return (
    <SettingsSection
      id={sectionId}
      title={checkoutLabel ? `File analyzers · ${checkoutLabel}` : "File analyzers"}
      icon={<WrenchIcon className="size-4" />}
    >
      <div className="space-y-4 px-3 py-3 text-xs sm:px-4">
        <p className="text-muted-foreground">
          Installed Mago and Biome tools check saved files when opened. Composer scripts identify
          configuration files; automatic checks do not execute arbitrary scripts or rewrite source
          files.
        </p>
        <Button
          size="sm"
          variant="outline"
          onClick={refresh}
          disabled={!canRead || areas.config === null || query.isPending || awaitingClone}
        >
          Refresh tool discovery
        </Button>
        {query.error ? (
          <p role="alert" className="text-destructive">
            {query.error}
          </p>
        ) : null}
        {!canRead ? (
          <p className="text-muted-foreground">This connection cannot read project tools.</p>
        ) : null}
        {query.isPending || areas.loading ? (
          <p className="text-muted-foreground">Discovering project tools…</p>
        ) : null}
        {query.data?.length === 0 ? (
          <p className="text-muted-foreground">No PHP or React areas are enabled.</p>
        ) : null}
        {query.data?.map((area) => (
          <div key={area.areaId} className="space-y-2 rounded-md border border-border p-3">
            <h3 className="text-sm font-medium">
              {areas.areas.find((entry) => entry.id === area.areaId)?.name ?? area.areaId}
            </h3>
            {area.tools.length === 0 ? (
              <p className="text-muted-foreground">No supported analyzer detected.</p>
            ) : null}
            {area.tools.map((tool) => (
              <div key={`${tool.tool}:${tool.manifestPath}`} className="space-y-2">
                <p>
                  <span className="font-medium">
                    {
                      {
                        mago: "Mago",
                        biome: "Biome",
                        eslint: "ESLint",
                        depcruise: "dependency-cruiser",
                      }[tool.tool]
                    }
                  </span>{" "}
                  ·{" "}
                  {tool.tool === "mago" &&
                  areas.areas.find((entry) => entry.id === area.areaId)?.magoDocker
                    ? "Docker Compose"
                    : tool.available
                      ? "Installed"
                      : "Declared; local binary unavailable"}
                </p>
                <p className="break-all font-mono text-muted-foreground">{tool.manifestPath}</p>
                {tool.configPath ? (
                  <p className="break-all text-muted-foreground">
                    Configuration: {tool.configPath}
                  </p>
                ) : null}
                {tool.scripts.length ? (
                  <p className="text-muted-foreground">
                    Scripts:{" "}
                    {tool.scripts
                      .map((script) => `${script.name} (${script.operation})`)
                      .join(", ")}
                  </p>
                ) : null}
                {tool.symfonyWiringReference ? (
                  <div className="space-y-2">
                    <p className="text-muted-foreground">
                      Symfony wiring reference:{" "}
                      {tool.symfonyWiringReference.referenceAvailable ? "Available" : "Missing"}
                    </p>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={
                        !canGenerate ||
                        currentOperation?.pending === true ||
                        (!areas.areas.find((entry) => entry.id === area.areaId)?.magoDocker &&
                          (!tool.symfonyWiringReference.generatorAvailable ||
                            !tool.symfonyWiringReference.autoloadAvailable))
                      }
                      onClick={() => void generateReference(area.areaId)}
                    >
                      Generate container reference
                    </Button>
                    {!canGenerate ? (
                      <p className="text-muted-foreground">
                        Generation requires permission to run tools and write files.
                      </p>
                    ) : null}
                    {!areas.areas.find((entry) => entry.id === area.areaId)?.magoDocker &&
                    (!tool.symfonyWiringReference.generatorAvailable ||
                      !tool.symfonyWiringReference.autoloadAvailable) ? (
                      <p className="text-muted-foreground">
                        Install the generator and project dependencies before generating references.
                      </p>
                    ) : null}
                  </div>
                ) : tool.symfonyWiring ? (
                  <p className="text-muted-foreground">
                    Symfony wiring detected; reference generator unavailable.
                  </p>
                ) : null}
              </div>
            ))}
            {area.warnings.map((warning) => (
              <p key={`${warning.path}:${warning.reason}`} className="break-all text-warning">
                {warning.path}: {warning.reason.replaceAll("_", " ")}
              </p>
            ))}
            {currentOperation?.areaId === area.areaId ? (
              <p role="status" className="whitespace-pre-wrap break-all text-muted-foreground">
                {currentOperation.message}
              </p>
            ) : null}
          </div>
        ))}
      </div>
    </SettingsSection>
  );
}
