import { PHP_ENTRY_INSIGHTS_SOURCE } from "./PhpEntryInsightsSource.ts";
import { phpQueryInsightsSource } from "./PhpQueryInsights.ts";

/** A single isolated SDK worker writes sidecars; stdout remains the Mago protocol. */
export const PHP_INSIGHTS_WORKER_SOURCE =
  String.raw`<?php
declare(strict_types=1);
$inputPath = getenv('T3_PHP_INSIGHTS_INPUT');
if (!is_string($inputPath) || $inputPath === '') throw new RuntimeException('Missing insight worker input.');
$input = json_decode((string) file_get_contents($inputPath), true, 64, JSON_THROW_ON_ERROR);
foreach (array_unique($input['autoloadPaths']) as $autoload) require_once $autoload;
if (!class_exists(\Mago\Sdk\Worker::class)) throw new RuntimeException('The Mago PHP SDK is not installed.');
` +
  PHP_ENTRY_INSIGHTS_SOURCE.replace("declare(strict_types=1);", "") +
  phpQueryInsightsSource +
  String.raw`
final class T3QueryInsightsHook implements \Mago\Sdk\Analyzer\AfterAnalysisHook
{
    public function __construct(private readonly array $input, private readonly array $bindings, private readonly array $constructors) {}
    public function afterAnalysis(\Mago\Sdk\Analyzer\AfterAnalysisContext $context): void
    {
        try {
            $result = t3QueryInsights($context, $this->input, $this->bindings, $this->constructors);
        } catch (Throwable $error) {
            $result = ['status' => 'failed', 'message' => 'The Doctrine extension could not inspect this source snapshot.', 'methods' => []];
        }
        if (file_put_contents($this->input['queryOutput'], json_encode($result, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES)) === false) throw new RuntimeException('Cannot write query insights sidecar.');
    }
}
final class T3QueryInsightsPlugin implements \Mago\Sdk\Analyzer\Plugin
{
    public function __construct(private readonly array $input, private readonly array $bindings, private readonly array $constructors) {}
    public function getDefinition(): \Mago\Sdk\Analyzer\PluginDefinition
    { return new \Mago\Sdk\Analyzer\PluginDefinition('t3/php-query-insights', 'PHP query insights', 'Read-only query estimates for the opened file.'); }
    public function register(\Mago\Sdk\Analyzer\PluginRegistry $registry): void
    { $registry->registerAfterAnalysisHook(new T3QueryInsightsHook($this->input, $this->bindings, $this->constructors)); }
}
$bindings = [];
$constructors = [];
if (is_string($input['referencePath'] ?? null) && class_exists(\ByteKitsune\MagoSymfonyWiring\ContainerReferenceLoader::class)) {
    $root = $input['projectRoot'];
    $reference = $input['referencePath'];
    $relative = str_starts_with($reference, $root . '/') ? substr($reference, strlen($root) + 1) : $reference;
    $loader = new \ByteKitsune\MagoSymfonyWiring\ContainerReferenceLoader($root, $relative);
    $map = $loader->load();
    $bindings = $map->classBindings();
    // The Symfony API keeps conflicting service-instance positions explicitly
    // unresolved; deleting them would fall back to a misleading default alias.
    $constructors = $loader->constructorClassBindings();
}
$extensions = [new \Mago\Sdk\Extension('t3/php-insights', 'PHP file insights', '1.0.0', analyzerPlugins: [new T3QueryInsightsPlugin($input, $bindings, $constructors)])];
try {
    $graph = t3EntryInsightsExtension($input);
} catch (Throwable $_error) {
    $graph = null;
    file_put_contents($input['graphOutput'], json_encode(['status' => 'failed', 'message' => 'The architecture extension could not inspect this source snapshot.'], JSON_THROW_ON_ERROR));
}
if ($graph !== null) $extensions[] = $graph;
(new \Mago\Sdk\Worker(...$extensions))->run();
`;
