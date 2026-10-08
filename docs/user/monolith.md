# Monolith areas and file checks

Use **Settings → Project → Monolith areas** to review discovered PHP/React projects and add,
rename, disable or remove areas. Ordinary folders can also be areas. Shared configuration lives in
`.t3/monolith.json` and can be committed. Files outside those areas remain accessible in the full
repository view.

In the file-browser sidebar, choose an active area to browse and search its folder. Choose **All
repository** to return to the full tree. Recently selected areas appear first; the selection is
remembered locally for each project and environment.

Choose **Changed Files** to see pending Git changes across all areas: uncommitted
changes, staged and untracked files, and local commits that have not been pushed.
Red takes priority for anything not committed yet. Committed new files awaiting a
push are green; committed modifications awaiting a push are blue. These colors
also appear in the ordinary area and repository trees. Deleted files are counted
separately because they cannot be opened as current files. Git uses locally known
remote refs; the filter does not fetch from the network. A branch without a usable
remote or base reference treats its committed files as unpublished.

## File checks

PHP areas use Mago. React areas can use Biome, ESLint and dependency-cruiser together. Install the
tools in the project or its package workspace; T3 detects local installations and configuration
paths from supported package scripts. Automatic checks run without fixes and do not execute the
entire package-script recipe. Dynamic or ambiguous recipes need an explicit configuration or a
direct analyzer script.

ESLint findings with positions appear beside the relevant source lines. Dependency-cruiser checks
the configured source folders as a whole; relationship violations appear under the file because
its report does not provide source-line positions. Selecting either endpoint shows the violation.

Background indexing starts when the project opens. A file opened before its index is ready gets
a foreground check without waiting for the area to finish. Matching cached results are reused;
source hashes and area/tool configuration prevent results from another branch being reused.
Large areas run in sequential batches while reusing the full PHP analysis within
each index run. Opened files take priority over subsequent background phases;
an already running background command can briefly overlap. Limit errors identify the exceeded bound; other files
can still be checked individually if automatic area indexing cannot finish.
React output folders at the area root (`build`, `dist`, `coverage`, `out`, `.output`,
`.nuxt`, `.svelte-kit`) are excluded from automatic indexing. Source files above
2 MiB are skipped with a summary so the remaining files can be indexed. Such
files still contribute to dependency-context validation within its size limits.
For large PHP areas, update `byte-kitsune/mago-doctrine-query-budget` to
`v0.1.0-beta.15` or later in the area's Composer tools. It reuses one Doctrine
analysis model for the area; older versions remain supported with slower batch
inspection. T3 bounds its background Mago workers to one thread and its opened-file
checks to two threads. The isolated PHP insight worker can use up to 1 GiB; custom
extension-host commands in your Mago config retain their own PHP memory limits.
Unchanged hashes reuse prior results, including tool failures; they do not retry
on a timer. After fixing the runtime (for example starting its container), use
**Reindex** to retry explicitly. Editing source or area/tool configuration also
invalidates matching cached results.

## Symfony configuration secrets

Symfony Wiring 1.1.0 provides an opt-in `SecurityExtension` and a standalone PHP/YAML check API.
Register the extension in the PHP worker configuration before disabling Mago's overlapping
`no-literal-password` rule. The replacement allows complete Symfony `%env(...)%` placeholders
and reports hardcoded passwords and tokens. T3 uses the source API for PHP and YAML; native Mago
lint covers PHP. See the [extension setup](https://github.com/Byte-Kitsune/mago-symfony-wiring/tree/v1.1.0)
for registration, custom sensitive keys and exclusions. Unsupported constructs are reported as
incomplete. Native Mago suppression comments do not suppress the standalone source inspection.
