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
Large areas run in sequential batches. Limit errors identify the exceeded bound; other files
can still be checked individually if automatic area indexing cannot finish.

## Symfony configuration secrets

Symfony Wiring 1.1.0 provides an opt-in `SecurityExtension` and a standalone PHP/YAML check API.
Register the extension in the PHP worker configuration before disabling Mago's overlapping
`no-literal-password` rule. The replacement allows complete Symfony `%env(...)%` placeholders
and reports hardcoded passwords and tokens. T3 uses the source API for PHP and YAML; native Mago
lint covers PHP. See the [extension setup](https://github.com/Byte-Kitsune/mago-symfony-wiring/tree/v1.1.0)
for registration, custom sensitive keys and exclusions. Unsupported constructs are reported as
incomplete. Native Mago suppression comments do not suppress the standalone source inspection.
