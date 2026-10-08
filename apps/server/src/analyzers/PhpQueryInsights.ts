/** Bundled with the server so packaged desktop/CLI builds do not need loose PHP assets. */
export const phpQueryInsightsSource = String.raw`
function t3QueryUnavailable(array $input, array $report): array
{
    if (!is_array($input['indexPaths'] ?? null)) return $report;
    return ['files' => array_map(static fn (array $file): array => ['path' => $file['relativePath'], 'report' => $report], $input['indexPaths'])];
}

function t3QueryInsights(\Mago\Sdk\Analyzer\AfterAnalysisContext $context, array $input, array $bindings, array $constructorBindings): array
{
    if (!class_exists(\ByteKitsune\MagoDoctrineQueryBudget\QueryBudgetExtension::class)) {
        return t3QueryUnavailable($input, ['status' => 'unavailable', 'message' => 'Install the Doctrine query-budget extension in this area.', 'methods' => []]);
    }
    if (!method_exists(\ByteKitsune\MagoDoctrineQueryBudget\QueryBudgetExtension::class, 'inspectFile')) {
        return t3QueryUnavailable($input, ['status' => 'unsupported', 'message' => 'Update the Doctrine query-budget extension to 0.1.0-beta.12 or newer for file inspection.', 'methods' => []]);
    }
    if (is_array($input['indexPaths'] ?? null)) {
        $files = [];
        $batch = method_exists(\ByteKitsune\MagoDoctrineQueryBudget\QueryBudgetExtension::class, 'inspectFiles')
            ? \ByteKitsune\MagoDoctrineQueryBudget\QueryBudgetExtension::inspectFiles(
                $context->analysis, array_column($input['indexPaths'], 'areaRelativePath'), $bindings, $constructorBindings,
            ) : null;
        foreach ($input['indexPaths'] as $file) {
            $report = $batch[$file['areaRelativePath']] ?? \ByteKitsune\MagoDoctrineQueryBudget\QueryBudgetExtension::inspectFile(
                $context->analysis, $file['areaRelativePath'], $bindings, $constructorBindings,
            );
            if (($report['schemaVersion'] ?? null) !== '1') throw new \RuntimeException('Unsupported Doctrine inspection schema.');
            foreach ($report['methods'] as &$method) $method['path'] = $file['relativePath'];
            unset($method);
            $files[] = ['path' => $file['relativePath'], 'report' => $report];
        }
        return ['files' => $files];
    }
    $result = \ByteKitsune\MagoDoctrineQueryBudget\QueryBudgetExtension::inspectFile(
        $context->analysis, $input['areaRelativePath'], $bindings, $constructorBindings,
    );
    if (($result['schemaVersion'] ?? null) !== '1') throw new \RuntimeException('Unsupported Doctrine inspection schema.');
    foreach ($result['methods'] as &$method) $method['path'] = $input['relativePath'];
    unset($method);
    return $result;
}
`;

export type PhpQueryInsight = {
  readonly symbol: string;
  readonly path: string;
  readonly line: number;
  readonly column?: number;
  readonly lowerBound: number;
  readonly upperBound: number | null;
  readonly unknown: readonly string[];
  readonly cycles: readonly string[];
};
export type PhpQueryInsights = {
  readonly status: "complete" | "incomplete" | "unavailable" | "unsupported" | "failed";
  readonly message?: string;
  readonly methods: readonly PhpQueryInsight[];
};
const statuses = new Set<PhpQueryInsights["status"]>([
  "complete",
  "incomplete",
  "unavailable",
  "unsupported",
  "failed",
]);
const object = (value: unknown): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Invalid query insights object.");
  return value as Record<string, unknown>;
};
const text = (value: unknown, max = 2048): string => {
  if (typeof value !== "string" || value.length === 0 || value.length > max)
    throw new Error("Invalid query insights text.");
  return value;
};
const integer = (value: unknown, minimum: number): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum)
    throw new Error("Invalid query insights integer.");
  return value;
};
const strings = (value: unknown): readonly string[] => {
  if (!Array.isArray(value) || value.length > 32) throw new Error("Invalid query insight reasons.");
  return value.map((item) => text(item));
};

/** A missing or malformed sidecar is a failed run, never a zero-query estimate. */
export function decodePhpQueryInsights(raw: string, relativePath: string): PhpQueryInsights {
  return normalizePhpQueryInsights(JSON.parse(raw), relativePath);
}
export function normalizePhpQueryInsights(value: unknown, relativePath: string): PhpQueryInsights {
  const report = object(value);
  const status = text(report.status) as PhpQueryInsights["status"];
  if (!statuses.has(status) || !Array.isArray(report.methods) || report.methods.length > 512)
    throw new Error("Invalid query insights report.");
  const seen = new Set<string>();
  const methods = report.methods.map((value): PhpQueryInsight => {
    const method = object(value);
    const symbol = text(method.symbol, 1024);
    const path = text(method.path);
    if (path !== relativePath || seen.has(symbol))
      throw new Error("Unexpected query insight target.");
    seen.add(symbol);
    const lowerBound = integer(method.lowerBound, 0);
    const upperBound = method.upperBound === null ? null : integer(method.upperBound, lowerBound);
    return {
      symbol,
      path,
      line: integer(method.line, 1),
      ...(method.column === undefined ? {} : { column: integer(method.column, 1) }),
      lowerBound,
      upperBound,
      unknown: strings(method.unknown),
      cycles: strings(method.cycles),
    };
  });
  const incomplete = methods.some(
    (method) => method.upperBound === null || method.unknown.length > 0 || method.cycles.length > 0,
  );
  if (
    (status === "complete" && incomplete) ||
    (status === "incomplete" && !incomplete) ||
    (!["complete", "incomplete"].includes(status) && methods.length > 0)
  )
    throw new Error("Inconsistent query insights status.");
  return {
    status,
    methods,
    ...(report.message === undefined ? {} : { message: text(report.message) }),
  };
}
