/** Executed by the isolated Mago companion worker; stdout belongs to its SDK protocol. */
export const PHP_ENTRY_INSIGHTS_SOURCE = String.raw`
declare(strict_types=1);

use ByteKitsune\MagoArchitectureGraph\ArchitectureGraphExtension;
use ByteKitsune\MagoSymfonyWiring\ContainerReferenceLoader;
use Mago\Sdk\Extension;

/** A companion worker hook. Never write to stdout (the Mago SDK protocol). */
function t3EntryInsightsExtension(array $input): ?Extension
{
    $output = $input['graphOutput'] ?? null;
    if (!is_string($output) || $output === '') return null;
    $write = static function (array $result) use ($output): void {
        if (file_put_contents($output, json_encode($result, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES)) === false) {
            throw new RuntimeException('Cannot write graph insights sidecar.');
        }
    };
    if (!class_exists(ArchitectureGraphExtension::class)) {
        $write(['status' => 'unavailable', 'message' => 'The architecture graph extension is not installed.']);
        return null;
    }
    $supportsObserver = method_exists(ArchitectureGraphExtension::class, 'inspect');
    foreach ((new ReflectionMethod(ArchitectureGraphExtension::class, 'create'))->getParameters() as $parameter) {
        if ($parameter->getName() === 'graphObserver') $supportsObserver = true;
    }
    if (!$supportsObserver) {
        $write(['status' => 'unsupported', 'message' => 'The installed architecture graph extension does not expose full source call graphs (requires beta.16 or later).']);
        return null;
    }
    $root = $input['projectRoot'] ?? $input['cwd'] ?? null;
    $policy = $input['architecturePolicyPath'] ?? null;
    if (!is_string($root)) {
        $write(['status' => 'unavailable', 'message' => 'No architecture policy with configured entry scopes is available.']);
        return null;
    }
    if (is_string($policy)) {
        $data = json_decode((string) file_get_contents($policy), true, 64, JSON_THROW_ON_ERROR);
        if (($data['scope_graph']['enabled'] ?? false) !== true) {
            $write(['status' => 'unavailable', 'message' => 'The architecture policy has no enabled entry scope graph.']);
            return null;
        }
    }
    $classBindings = [];
    $serviceBindings = [];
    $constructorBindings = [];
    $servicesComplete = false;
    $reference = $input['referencePath'] ?? null;
    if (is_string($reference) && class_exists(ContainerReferenceLoader::class)) {
        $relative = str_starts_with($reference, $root . '/') ? substr($reference, strlen($root) + 1) : $reference;
        $map = (new ContainerReferenceLoader($root, $relative))->load();
        $classBindings = $map->classBindings();
        $serviceBindings = $map->serviceClassBindings();
        $servicesComplete = $map->incomplete === [];
        // The public map retains service instance identity: two services of the
        // same class may have different constructor targets. Do not merge them.
        foreach ($serviceBindings as $id => $_class) {
            $resolved = $map->resolveId((string) $id);
            if ($resolved === null) continue;
            $positions = [];
            foreach ($map->services[$resolved]['arguments'] as $position => $target) {
                if (!is_int($position)) { $servicesComplete = false; continue; }
                $positions[$position] = is_string($target) && isset($serviceBindings[$target]) ? $target : null;
            }
            $constructorBindings[$id] = $positions;
        }
    }
    $observer = static function (array $snapshot) use ($write): void {
        $write(['status' => 'snapshot', 'snapshot' => $snapshot]);
    };
    if (!is_string($policy)) {
        if (!method_exists(ArchitectureGraphExtension::class, 'inspect')) {
            $write(['status' => 'unsupported', 'message' => 'The installed architecture extension lacks the inspection API.']);
            return null;
        }
        return ArchitectureGraphExtension::inspect(
            $root, $input['entrypointPaths'] ?? ['src/Controller', 'src/Command'], $observer,
            $classBindings, $servicesComplete, $serviceBindings, $constructorBindings,
        );
    }
    return ArchitectureGraphExtension::create(
        $root,
        $policy,
        $classBindings,
        $servicesComplete,
        $serviceBindings,
        $constructorBindings,
        graphObserver: $observer,
    );
}
`;
