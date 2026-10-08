# Byte-Kitsune fork

This fork of [pingdotgg/t3code](https://github.com/pingdotgg/t3code) adds monolith
navigation and local analysis for PHP/Symfony and React projects. Its repository is
[Byte-Kitsune/t3code](https://github.com/Byte-Kitsune/t3code). This document records
the behavior to preserve when integrating upstream changes; setup instructions
live in [the monolith user guide](docs/user/monolith.md).

Update this document when fork behavior changes. It describes implemented
features, rather than a release log or a list of future tasks.

## Areas and navigation

- Discover PHP and React projects inside a repository, including nested layouts
  such as `artifact/catalog` and `artifact-test/library`. Review and maintain the
  discovered areas in **Settings → Project → Monolith areas**. Areas can also be
  ordinary folders without PHP or React tooling.
- Store shared area definitions in `.t3/monolith.json`. The legacy
  `t3.monolith.json` remains a compatibility input. Preserve the `.gitignore`
  exception for `.t3/monolith.json`; generated state inside `.t3` must remain
  ignored.
- Match files to the most specific enabled area boundary. Shared grouping helpers
  retain an **Other** bucket for unmatched files.
- **Changed Files** is a Git-backed repository-wide filter for untracked, staged,
  unstaged and committed-but-unpushed files. It remains independent of area
  boundaries. Red takes priority for all uncommitted changes; committed added
  files are green and committed modifications blue. Preserve the local status
  metadata across the Git driver, status contracts/subscription and file tree.
  Remote-only status updates must retain the local `fileChanges` field.
- The File Viewer sidebar offers a focused area tree/search and **All repository**.
  Recently used areas appear first. Selection and recency are stored locally per
  environment and project; they are not shared repository configuration.

Key boundaries: [area contracts](packages/contracts/src/monolith.ts),
[area service](apps/server/src/project/MonolithService.ts),
[shared path matching](packages/shared/src/monolithAreas.ts),
[settings](apps/web/src/components/settings/MonolithAreasPanel.tsx), and
[file browser](apps/web/src/components/files/FileBrowserPanel.tsx).

## Analyzer execution and indexing

PHP discovery supports Mago installed through the area's Composer project or a
`tools` Composer project. Supported `format`, `analyze`, and `guard` scripts supply
command/configuration metadata. Checks run without writing fixes. Symfony wiring
reference generation is available from project settings.

React areas support Biome, ESLint, and dependency-cruiser, including installed
workspace binaries. Discovery extracts supported analyzer commands from package
scripts, including a literal `biome ci` inside a longer CI chain. It never executes
the complete package script. Graph-export recipes are not treated as file checks;
dynamic or ambiguous commands report their limitations. ESLint diagnostics retain
real positions. Dependency-cruiser evaluates configured source folders and reports
violations for either endpoint under the file, without inventing source lines.

Indexing runs in the background when opening a project. An opened file can receive
a foreground check before its area finishes. Separate foreground/background
queues keep a queued area batch from blocking an interactive file check; they do
not preempt an already running external process.

Unchanged fingerprints also retain failed/unavailable results instead of retrying
native tools every 30 seconds. Explicit **Reindex** or changed source/configuration
retries; hash validation alone must preserve settled status. Explicit retries
refresh the opened file even when its source hash is unchanged. Fatal jobs without
a publishable cache suppress duplicate analysis for the same known fingerprint
during the service lifetime. Analyzer failure text exposes exit codes and fixed
hints, never raw native output that can include source or credentials.

Cache validity includes SHA-256 source hashes, analyzer/configuration dependencies,
and area membership. Branch changes and content changes invalidate affected data.
Interactive file checks are keyed by the SHA-256 content revision. Saving identical
content, including a no-op autosave, does not invalidate results or start another
check. Index lifecycle transitions alone do not invalidate a file check. During a
real dependency refresh, retain the last results for the same source revision;
hide them immediately when the displayed source changes, so stale annotations
cannot describe edited code.
The persistent cache format is currently version 3. Source/dependency roles are
part of the area signature, so moving a file into a nested area cannot reuse its
old parent-area entry merely because its bytes stayed the same.

Large areas run sequential batches of at most 2,000 files or 32 MiB of source.
Each actual index run shares one area snapshot across its batches: native Mago
analyze/guard reports and the PHP insight graph are computed once, then selected
per reporting batch. Explicit Reindex creates a fresh generation even for the
same content hash. A changed final area fingerprint prevents publication of the
old snapshot. Full PHP context must remain intact when changing this mechanism.
PHP formatter work within those batches uses chunks of at most 128 files or
32 KiB of path arguments, with two formatter processes at a time. Native diff
headers must retain exact per-file attribution, including Docker mapping.
Mago runs with one thread in the background and two for opened files. Queued or
running opened-file checks pause subsequent background native phases in the same
workspace; an already running Compose command finishes normally to avoid leaving
an orphan process inside the container. Foreground lanes are workspace-specific.
Background file reads and unchanged saves must reattach to a pending file check,
rather than discard its response and queue another full-project analysis.
The isolated T3 PHP worker uses a bounded 1 GiB memory limit. Area insight sidecars
share a 64 MiB aggregate budget; ordinary foreground reports retain their existing
bounds. Cached query maps and graph selectors avoid reparsing entire area reports
for each batch. Two prepared snapshots share a 64 MiB cache budget so interleaved
area jobs can reuse their results without unbounded memory growth; exceeding that
budget evicts older entries and may require recomputation.

React area-root build outputs are excluded from the automatic scan. Oversized
source files are omitted from per-file indexing and reported in the status, but
their contents remain hashed within dependency-context limits: native analyzers
can still consume them while resolving other files. Same-size edits must therefore
invalidate results. PHP `build` folders and React `src/build` remain source paths.

Current outer index bounds are 50,000 source files, 100,000 filesystem entries,
256 MiB of source, and 64 MiB of serialized cache. Other file/fingerprint bounds
and native analyzer limits still apply. Limit failures identify the exhausted
bound and leave other individual files checkable; this is not unlimited indexing. Cache
size is checked while accumulating results, before serializing the whole area.

Execution anchors: [discovery](apps/server/src/project/AnalyzerDiscoveryService.ts),
[analyzer service](apps/server/src/project/MonolithAnalyzerService.ts),
[index service](apps/server/src/project/MonolithIndexService.ts),
[CLI adapters](apps/server/src/analyzers/AnalyzerExecution.ts), and
[file-check hook](apps/web/src/hooks/useMonolithFileCheck.ts).

## PHP insights and reusable extensions

Doctrine query estimates appear above their methods. Proven zero-query estimates
do not produce annotation boxes; unknown or unbounded estimates remain visible.
Severity uses thresholds resolved safely from the extension's consumed `.mago/extension.php`
configuration, with area overrides and fallback thresholds where applicable.
Unresolved configuration is reported rather than executed or silently guessed.
Fallback display thresholds are warning from 10 and error from 50 queries. These
are static estimates, not measurements of executed SQL.

The Symfony/architecture graph supplies direct callers, entry files, and
Ctrl/Cmd-click navigation at classes and methods. Configurable comment markers
include `[DEV COMMENT]`, `@deprecated`, `@see`, and `@todo`. Metadata is attached
to the relevant usage sites. Interface-level comments and interface-method
comments are distinct: the latter annotate implementing method signatures.
Graph preparation is shared across a batch instead of reparsing the complete
graph separately for every selected file.

The file view keeps real analyzer errors inline and quieter availability/help
information below the file. Analyzer/caller sections remain present for PHP files
while loading and start collapsed. Query boxes are method annotations.

These integrations use independently reusable extensions:

| Extension                                                                                | Integrated release | Responsibility                                                 |
| ---------------------------------------------------------------------------------------- | ------------------ | -------------------------------------------------------------- |
| [mago-architecture-graph](https://github.com/Byte-Kitsune/mago-architecture-graph)       | `v0.1.0-beta.17`   | Graph, symbol metadata, comment usage sites                    |
| [mago-doctrine-query-budget](https://github.com/Byte-Kitsune/mago-doctrine-query-budget) | `v0.1.0-beta.15`   | Single-snapshot query inspection and safe threshold inspection |
| [mago-symfony-wiring](https://github.com/Byte-Kitsune/mago-symfony-wiring)               | `v1.1.0`           | Symfony wiring and opt-in PHP/YAML secret inspection           |

These are tested integration versions, not dependencies bundled with T3; each
area installs its own tools. Keep extension APIs usable outside this fork.
The Doctrine integration feature-detects `inspectSnapshot` to reuse one prepared
Program for an area's selectors. Older versions retain the bounded `inspectFiles`
fallback. The new API isolates individual file failures; it does not lift the
extension's separate full-Program safety bounds. Project-owned extension-host
commands still control their own PHP memory configuration.

Symfony Wiring's opt-in `SecurityExtension` replaces the overlapping
`no-literal-password` rule when configured. Complete valid Symfony `%env(...)%`
placeholders are allowed; hardcoded credentials in PHP and YAML are reported.
T3 consumes its standalone source API, while native Mago lint handles PHP.
Register the replacement before disabling the built-in rule. Unsupported source
constructs remain explicitly incomplete. Native Mago suppression comments do not
suppress standalone inspection, and diagnostics must never echo secret values.

Integration anchors: [PHP execution](apps/server/src/analyzers/PhpInsightsExecution.ts),
[graph normalization](apps/server/src/analyzers/PhpEntryInsights.ts),
[threshold inspection](apps/server/src/analyzers/PhpThresholdInsightsSource.ts),
[secret inspection](apps/server/src/analyzers/PhpSecurityInsightsSource.ts), and
[file insight UI](apps/web/src/components/files/PhpFileInsights.tsx).

## Docker

Each PHP area can select a Docker Compose service, compose directory/files,
container workspace path, and Mago executable. Multiple Compose files support
layouts such as `infrastructure/docker/`. Paths and commands are mapped between
host and container, with analyzer output mapped back to repository-relative files.
Automatic React analyzer execution currently uses host-visible tools.

The terminal drawer also offers configured Docker targets, recent-target ordering,
and an optional split pane for service logs alongside the regular terminal.
Preserve environment/project scoping and terminal permissions when merging.

Anchors: [Docker execution](apps/server/src/analyzers/MagoDockerExecution.ts),
[Docker terminal UI](apps/web/src/components/DockerTerminalDrawer.tsx), and
[target selection](apps/web/src/components/dockerTerminalTargets.ts).

## Builds and upstream integration

Work is consolidated on `main`. Automatic fork binary publication is disabled:
the fork-specific macOS preview workflow was removed, and
[release.yml](.github/workflows/release.yml) restricts the upstream release pipeline
to `pingdotgg/t3code`. Normal CI remains enabled. Keep this guard when importing
upstream workflow changes; do not restore automatic fork release publishing.

The Linux test starter [`scripts/start-linux-test.sh`](scripts/start-linux-test.sh)
installs locked dependencies and builds the current local checkout before every
launch, including uncommitted changes. It never falls back to an old artifact;
`T3CODE_BUILD_ONLY=1` builds without launching.

Desktop artifacts are built locally. After pulling changes, run `vp install` before
rebuilding: the bundler can otherwise leave a missing dependency (such as
`smol-toml`) as an unresolved external import. The desktop packaging scan rejects
package imports outside the staged runtime-external set in every server chunk,
including lazy CLI chunks; a successful `--version` probe alone does not cover
those imports. For Apple Silicon:

```sh
vp install
vp run dist:desktop:dmg:arm64 --output-dir artifacts
```

[The packaging script](scripts/build-desktop-artifact.ts) supports
`T3CODE_DESKTOP_UPDATE_REPOSITORY=Byte-Kitsune/t3code` for fork update ownership.
Preview versions are manual-download artifacts. An unsigned macOS build receives
a local ad-hoc signature; this is not Developer ID signing or notarization.

When resolving upstream conflicts, preserve these cross-layer constraints:

1. Monolith service methods must stay connected through server layers, typed RPC
   contracts, environment capabilities, permission checks, and client commands.
   A UI-only or server-only merge can silently remove the feature remotely.
2. Preserve canonical repository paths in focused trees, search results, file
   reveals, context menus, drag operations, and host/container report conversion.
3. Preserve actual diagnostic positions and UTF-8-byte to editor-position
   conversion. File-level findings must remain positionless.
4. Read extension-host declarations from the original bounded configuration.
   `mago config --no-extensions` strips that information. Discovering declarations
   must not execute arbitrary project configuration.
5. Keep graph context complete while selecting file-specific results; do not build
   graph context from the opened file alone. Preserve batch graph preparation and
   foreground check priority.
6. Preserve the distinct helper filenames `fileAnalyzerStatusHelpers.ts` and
   `phpInsightTargets.ts`. Names differing only by capitalization from their UI
   components break case-insensitive macOS packaging.

Use the focused tests beside the touched services/components and scope typechecks
to affected packages. The monolith settings and file views are implemented in the
web client used by desktop; a native mobile monolith settings/view implementation
has not been added. Dedicated AI PR review and project-wide panel-layout defaults
are not implemented by these additions.
