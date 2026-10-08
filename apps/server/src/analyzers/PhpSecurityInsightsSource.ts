/** Installed public APIs inspect source text; project worker/configuration PHP is never evaluated. */
export const PHP_SECURITY_INSIGHTS_SOURCE = String.raw`
function t3SecurityInsights(array $input): array
{
    if (($input['securityDisabled'] ?? false) === true) return ['status' => 'inactive'];
    if (empty($input['securitySources']) || !class_exists(\ByteKitsune\MagoSymfonyWiring\SymfonyWiringExtension::class)) return ['status' => 'inactive'];
    $extension = \ByteKitsune\MagoSymfonyWiring\SecurityExtension::class;
    $inspector = \ByteKitsune\MagoSymfonyWiring\Security\ConfigSecretInspector::class;
    if (!method_exists($extension, 'inspectConfiguration') || !method_exists($inspector, 'inspectConfigFiles'))
        return ['status' => 'unavailable'];
    $options = null;
    foreach ($input['securitySources'] ?? [] as $candidate) {
        $path = $candidate['filePath'];
        if (!is_file($path) || filesize($path) > 1048576 || ($source = file_get_contents($path)) === false)
            return ['status' => 'unavailable'];
        try { $configuration = $extension::inspectConfiguration($source, $path); }
        catch (Throwable) { return ['status' => 'failed']; }
        if (!empty($configuration['references'])) {
            if ($configuration['references'] !== [$input['securityCanonical']] || !is_file($input['securityCanonical']) || filesize($input['securityCanonical']) > 1048576) return ['status' => 'unavailable'];
            try {
                $canonical = file_get_contents($input['securityCanonical']);
                if ($canonical === false) return ['status' => 'unavailable'];
                $configuration = $extension::inspectConfiguration($canonical, $input['securityCanonical']);
                if (!empty($configuration['references'])) return ['status' => 'unavailable'];
            } catch (Throwable) { return ['status' => 'failed']; }
        }
        if (($configuration['schema_version'] ?? null) !== 1 || ($configuration['status'] ?? '') === 'unresolved')
            return ['status' => 'unavailable'];
        if ($configuration['status'] === 'absent') continue;
        if ($configuration['status'] !== 'enabled' || !is_array($configuration['options'] ?? []))
            return ['status' => 'unavailable'];
        $current = $configuration['options'] ?? [];
        if ($options !== null && $options !== $current) return ['status' => 'unavailable'];
        $options = $current;
    }
    if ($options === null) return ['status' => 'inactive'];
    $files = array_column($input['securityPaths'], 'areaRelativePath');
    $result = ['schema_version' => 1, 'column_encoding' => 'utf8_bytes', 'issues' => [], 'incomplete' => []];
    try {
        foreach (array_chunk($files, 512) as $chunk) {
            $report = $inspector::inspectConfigFiles($input['projectRoot'], $chunk, $options);
            if (($report['schema_version'] ?? null) !== 1 || ($report['column_encoding'] ?? null) !== 'utf8_bytes') return ['status' => 'failed'];
            $result['issues'] = array_merge($result['issues'], $report['issues']);
            $result['incomplete'] = array_merge($result['incomplete'], $report['incomplete']);
            if (count($result['issues']) > 10000 || count($result['incomplete']) > 2000) return ['status' => 'failed'];
        }
        return $result;
    } catch (Throwable) { return ['status' => 'failed']; }
}
`;
