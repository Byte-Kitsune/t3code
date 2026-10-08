/** Configuration is parsed by the Doctrine API, never required or evaluated. */
export const PHP_THRESHOLD_INSIGHTS_SOURCE = String.raw`
function t3DoctrineThresholds(array $input): array
{
    $resolved = null;
    foreach ($input['thresholdSources'] ?? [] as $candidate) {
        $path = $candidate['filePath'];
        if (!is_file($path)) continue;
        $source = ['kind' => 'unresolved', 'path' => $candidate['relativePath']];
        if (!method_exists(\ByteKitsune\MagoDoctrineQueryBudget\QueryBudgetExtension::class, 'inspectThresholds')) {
            return ['source' => [...$source, 'message' => 'Update the Doctrine extension to beta.14 or newer to read configured query thresholds safely.']];
        }
        if (filesize($path) > 1048576 || ($text = file_get_contents($path)) === false)
            return ['source' => [...$source, 'message' => 'The extension configuration could not be read within its inspection bounds.']];
        try {
            $report = \ByteKitsune\MagoDoctrineQueryBudget\QueryBudgetExtension::inspectThresholds($text);
        } catch (Throwable) {
            return ['source' => [...$source, 'message' => 'The extension configuration could not be inspected.']];
        }
        if (($report['schemaVersion'] ?? null) !== '1')
            return ['source' => [...$source, 'message' => 'The extension threshold inspection schema is unsupported.']];
        if ($report['status'] === 'resolved') {
            $current = [
                'thresholds' => ['warning' => $report['warning'], 'error' => $report['error']],
                'source' => ['kind' => 'extension', 'path' => $candidate['relativePath']],
            ];
            // The canonical area configuration is authoritative. Otherwise all workers must agree.
            $relativePath = str_replace('\\', '/', $candidate['relativePath']);
            if ($relativePath === '.mago/extension.php' || str_ends_with($relativePath, '/.mago/extension.php'))
                return $current;
            if ($resolved !== null && $resolved['thresholds'] !== $current['thresholds'])
                return ['source' => [...$source, 'message' => 'Configured extension workers declare different query thresholds.']];
            $resolved ??= $current;
            continue;
        }
        if ($report['status'] !== 'absent') return ['source' => [...$source,
            'message' => $report['message'] ?? 'Query thresholds contain dynamic or ambiguous expressions.',
        ]];
    }
    return $resolved ?? ['thresholds' => ['warning' => 10, 'error' => 50], 'source' => ['kind' => 'default']];
}
`;
