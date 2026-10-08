# Source control

T3 Code integrates with GitHub, GitLab, Forgejo, Gitea, Bitbucket, and Azure DevOps to clone and publish
repositories, create pull requests, and review changes.

## Connect an account

Install Git and configure authentication on the machine running your T3 Code server. For a remote
environment, do this on the remote machine. After signing in, open **Settings → Source Control**
and choose **Rescan**.

### GitHub

T3 Code talks to GitHub's API directly and only needs a token. Any of these works, in this
order of precedence:

1. A token saved in **Settings → Source Control → GitHub**. It is kept in the server's secret
   store, and works without the GitHub CLI.
2. `GH_TOKEN` (`GH_ENTERPRISE_TOKEN` with `GH_HOST` for GitHub Enterprise Server) in the
   server's environment.
3. [GitHub CLI](https://cli.github.com/) 2.81.0 or newer, signed in with `gh auth login`.

If `gh` is signed in to several accounts or hosts, expand **GitHub** in the same place to pick
the account each host uses or turn a host off. A saved token or `GH_TOKEN` takes precedence
over that choice; a host turned off stays off either way.

### Forgejo and Gitea

Install [Forgejo CLI (`fj`)](https://codeberg.org/forgejo-contrib/forgejo-cli) or
[Gitea CLI (`tea`)](https://gitea.com/gitea/tea) 0.16 or later on your T3 Code server.
Sign in with `fj --host https://your-server auth add-token` or `tea login add`.
Repeat for each server you use, including Codeberg.

T3 Code prefers a matching `fj` login and falls back to `tea` when `fj` is unavailable
or has no login for that server. Once an account is selected, failed actions stay on that
account. Settings shows the detected CLI. Forgejo and Gitea share one integration entry.
Servers hosted under a URL subpath, such as `https://example.com/forgejo`, use `tea` because
fj 0.6 does not preserve the subpath when checking its account.

When cloning or publishing, use a full repository URL to select a specific server.
You can use `owner/repo` when only one fj server is configured, or with your default `tea`
login when fj is unavailable or unconfigured. With multiple fj servers, use the full URL.
If you have multiple `tea` accounts on one server, select one with
`tea login default <login-name>`. Git push and clone also need Git credentials or an SSH key
for that server.

### GitLab

Install [GitLab CLI](https://gitlab.com/gitlab-org/cli), then sign in:

```bash
glab auth login
```

### Bitbucket

Open **Settings → Source Control**, expand **Bitbucket**, and choose how to sign in:

- **Access token**: a token created for one repository, project, or workspace. It can only reach
  what it was created for.
- **API token**: an Atlassian API token for your account, used with your account email. It can
  reach every repository you can. Give it read/write access to repositories and pull requests, plus
  user read access (`read:user:bitbucket`).

Choose **Save**; the change applies right away, and replaces any credential saved with the other
method. Credentials are saved on the environment's server, so select a remote environment to
configure it. Saved tokens can't be viewed again; enter a new one to replace it, or choose
**Remove**.

If no credentials are saved, T3 Code falls back to these variables in the server's environment.
Restart the server after changing them:

```bash
export T3CODE_BITBUCKET_ACCESS_TOKEN="your-access-token"
# or
export T3CODE_BITBUCKET_EMAIL="you@example.com"
export T3CODE_BITBUCKET_API_TOKEN="your-token"
```

### Azure DevOps

Install [Azure CLI](https://learn.microsoft.com/en-us/cli/azure/), add the DevOps extension, and sign in:

```bash
az extension add --name azure-devops
az login
```

## Start, clone, or publish a project

To start from nothing, choose **New project** in the command palette (`Cmd/Ctrl+K`), or
**New project** under **Add Project** on any client, and type a name. T3 Code makes a Git
repository in `~/.t3/projects` (the `projects` folder of your T3 data directory) with a README,
an icon, and a first commit, then opens a new thread in it. The folder is named after the project,
like `pinball-stats` for "Pinball Stats". Turn on **Create private repository on GitHub** to also
publish it. If Git has no name or email on that machine, the project is created without the
first commit.

Use **Add Project** in the command palette (`Cmd/Ctrl+K`) to clone a repository. Choose a hosting
provider or paste a Git URL, then choose where to save it. The project opens right away while the
clone runs in the background: you can write your first prompt, and sending waits until the files
are in place. A toast tracks progress and lets you cancel; if the clone fails, retry it from the
toast or from the banner above the composer.

For a local Git repository without a remote, **Publish Repository** creates a hosted repository,
adds it as `origin`, and pushes your commits. If there are no commits yet, it creates the remote;
make your first commit before pushing.

## Create a pull request

Use a thread's Git actions to commit, push, and create a pull request. T3 Code can generate commit
messages, review titles, and descriptions from your changes.

Choose the writing style and model in **Settings → Source Control**. **Repository conventions**
uses the project's instructions and recent commit subjects.

## Review and merge

Open **Pull requests** to review changes and comments, request reviewers, check out a branch,
or merge. You can edit review titles and descriptions and your own comments where the host allows it.
GitLab calls these merge requests.

Enable **Remove agent credits when merging** in Settings → Source Control to remove recognized
agent co-author and generated-by lines from GitHub merge and squash commit messages. Human
co-authors stay credited. The setting is off by default and projects can override it. It also
applies to auto-merge, but not merge queues or native stack merges. Original commits keep their
messages, so merge and rebase can still retain agent credits in those commits.

On web and desktop, hold **Shift** in the GitHub pull request list for quick actions.
To close several, press **Close**, drag across the rows in the same group, and release.
Press **Escape** before releasing to cancel. Failed closes stay in the list so you can retry them.

GitHub, GitLab, and Azure DevOps support auto-merge while checks are outstanding. GitHub also
supports approving waiting fork workflows and opening a revert pull request for a merged change.

GitHub sharing is off by default. In Settings → Connections → GitHub sharing (Environments on mobile), choose
**Read PRs** or **Read and act** for each environment you trust to share GitHub access.
Enable both the original environment and the environment answering its requests on this client.
**Read and act** can use broader GitHub permissions than the original environment's credential;
only enable it for environments you control and trust. Changing a saved endpoint or removing an
environment clears its permission.

GitHub review details, linked PR status, and permitted review actions can then use another
connected environment signed in to the same GitHub account. Each needs a project on that host.
A connected local environment is preferred for actions and can answer slow or failed reads.
Browsers and mobile clients need a paired environment to use its GitHub credentials.
Credentials stay on their machines. Previously verified credentials remain usable for routing
for ten minutes during a GitHub outage; new credentials must be verified first. An action with
an uncertain result is never automatically retried elsewhere. Listings, diffs, and checkout or
PR creation from Git actions continue to use the project's environment.

For Azure DevOps, use the host website to change comments. Bitbucket does not support reopening a
declined pull request.

### Mark files as viewed

Tick a file off in the **Code** tab once you have read it and it collapses; the toolbar keeps a
running count. A tick belongs to the pull request rather than to a commit, so scoping the tab to a
single commit keeps them. A file pushed to after you cleared it comes back marked **Changed**.

On GitHub these are GitHub's own viewed marks, so a review carries between T3 Code and github.com
in either direction. Forgejo, GitLab, Bitbucket, and Azure DevOps expose no record T3 Code can read, so the
server you are connected to keeps them instead: they follow you across the apps connected to that
server, but the host's own site will not show them, and the count reads **viewed in T3 Code**.

The **Code** tab is a web and desktop surface. The mobile app reports a pull request's status but
does not show its diff, so marks are made and read on web and desktop.

## Troubleshooting

- **Not authenticated:** run the provider's login command on the server, then rescan. For Bitbucket,
  check the credentials saved in Settings → Source Control, or confirm the running server received
  the environment variables.
- **GitHub sign-in cannot be verified:** update GitHub CLI to at least 2.81.0, or save a token in Settings → Source Control.
- **Push fails despite a connected account:** check the Git remote's credentials. SSH and HTTPS
  remotes can require separate setup from the hosting provider's API access.
- **A review cannot load:** open it on the host website while resolving connectivity, permissions,
  or rate limits.

## Linked pull requests

A thread can hold several pull requests, including reviews from another repository on the same host.
Use **Link pull request** in the command palette or **Linked pull requests** panel, or right-click a
pull request link in the conversation. Creating a pull request from Git actions links it automatically.
Agents can link their pull requests with the `link_pull_request` tool.

Use **Link this PR** in a branch-detected badge's tooltip to keep it with the thread. From a review
on the Pull Requests page, **Link to thread** lets you search for an active thread. The review header
also lists the threads that link to it, including archived threads, so you can return to their context.

Thread badges show a stack's layer count or the current review number with a count of additional
links. Clicking a badge with more than one review opens the **Linked pull requests** panel. On mobile, the Git overview lists linked reviews and their stacks; tap a review to open it.
Linking and unlinking are available in the web and desktop clients.

The **Linked pull requests** panel lists every review and groups stacks. Unlink a review from its
row menu. An unlinked stack layer stays out of later syncs. Open linked reviews refresh on the server;
closed reviews refresh periodically so reopening one on the host is detected. Merged reviews refresh
when requested. A settled thread's reviews stop refreshing until you unsettle it. With **Auto-settle merged threads** enabled, a thread can settle after every linked
review is terminal. An open or unsynced link keeps it active.

Ask the agent to watch, monitor, or babysit a pull request and it calls `watch_pull_request`. While
the thread is active, the server checks the pull request every two minutes and wakes the agent when a
check fails, the required checks pass, someone else comments or reviews, or the branch starts to
conflict. Threads in a project that watch the same pull request share one check. On GitHub, a check
first asks whether anything changed and reads the pull request only when it did, which keeps
watching inside GitHub's rate limit. Comments from your own account do not wake it. Watching ends
when the pull request merges or closes, after 10 wakes in a row that bring only comments, after 8
failed reads in a row, or when you press Stop on the thread. A rate limit only pauses watching.
Settling or archiving a thread also ends all its watches. Unsettle the thread before starting a new
watch. Subagents cannot watch pull requests; the thread that delegated to them does. To start or stop
it yourself, use the row menu in the **Linked pull requests** panel. In the thread details card, a
watched pull request shows an eye; click it to stop watching.

A watched thread counts as working between wakes, so it stays in the **Working** section and does
not auto-settle. Agents stop watching when they hand the work back to you, and the thread then
returns to your inbox.

Cross-repository links use a project on the same host. Azure DevOps reviews require a project checked
out from the matching organization and repository.

## GitHub stacks

The Pull Requests page shows each PR's position in its GitHub stack. Open the stack badge in a
review to navigate its layers. **Merge stack** submits the selected pull request and every unmerged
layer below it to GitHub together, respecting branch rules and merge queues. The confirmation shows
the scope and merge strategy. GitHub rebases the remaining stack after merging.

**Rebase stack** updates remote branches from bottom to top without changing your local checkout.
It can rewrite history and restart checks. If a layer fails, earlier updates remain; resolve that
layer before retrying. GitHub may require manual conflict resolution after a lower layer is amended,
even when its changes look independent. Stack actions require an environment that supports them.

## Monolith areas

This fork groups local and pull-request diffs by application or folder. Opening a project for the
first time discovers PHP projects from `composer.json` and React projects from `package.json`,
including applications nested under folders such as `artifact/` and `artifact-test/`.
Dependencies, build output, symbolic links, and PHP tools installations inside an application's
`tools/` tree are excluded from discovery.

Open **Settings → Project**, choose your project, and scroll to **Monolith areas** to rename, add,
remove, or exclude areas. You can also use the project's gear in the sidebar or search settings for
**Monolith areas**. A **Folder** area can group documentation, infrastructure, or any other directory without
PHP or React. **Rescan** offers new applications to add; it keeps your saved choices. When areas
overlap, the deepest folder wins. An excluded deeper folder goes to **Other**, which appears after
the configured groups. Use the diff file tree's area selector to review one group at a time.

Areas are saved in `.t3/monolith.json` inside the checkout. Existing root-level `t3.monolith.json` files are migrated on the next save. Commit this file to share the grouping
with your team. Reading through a connection without filesystem write access does not create it.
Invalid existing configuration is reported instead of replaced.

```json
{
  "version": 1,
  "initialized": true,
  "defaultBaseBranch": "origin/develop",
  "areas": [
    { "id": "api", "name": "API", "path": "artifact/api", "kind": "php" },
    { "id": "portal", "name": "Portal", "path": "artifact/portal", "kind": "react" },
    { "id": "infra", "name": "Infrastructure", "path": "infra", "kind": "folder" },
    {
      "id": "fixtures",
      "name": "Fixtures",
      "path": "artifact-test",
      "kind": "folder",
      "enabled": false
    }
  ]
}
```

The optional default base branch supplies the local Changes comparison target until you choose
another branch. A hosted pull request keeps its own target branch. Opening a saved PHP or React source file runs the locally installed analyzer and shows findings at
source lines. PHP uses Mago format checks, analysis, and guard; React uses Biome checks. No formatting
changes are applied. Errors and warnings stay visible inline; informational help opens from a compact
icon. Expand **File checks** below the source for missing tools, setup details and execution status.
The **Mago checks** and **Entry files and callers** sections above PHP source stay visible while
loading and start collapsed. Doctrine query estimates appear inline above each method; setup
messages stay in the footer. Query colors use the Doctrine extension thresholds from
`.mago/extension.php` when they can be read without executing PHP. The inline source hint shows
the effective limits and their origin. In **Monolith areas**, enable **Override extension thresholds
in T3** to set separate warning and error limits for an area, or leave it off to inherit the extension
configuration. The upper bound determines the color; an unknown upper bound shows an
incomplete-analysis warning. If extension thresholds cannot be resolved, the box explains this
and does not classify the count using guessed limits.
Install tools with your project's usual package manager before opening files. Existing analyzer
configuration is used, including Mago installed in a PHP area's `tools/` Composer project.

For PHP areas running in Docker Compose, enter the **Mago Compose service** in **Monolith areas**,
for example `php` or `php-dev`. Mago checks and PHP insights then run in that existing service.
Leave the service blank to use local execution. Start the service with your project's usual Compose
workflow before opening files. Optional **Docker paths** can override the Compose folder relative
to the repository root, the PHP area's absolute path in the container, and the Mago executable.
For split Compose setups, configure an ordered list of repository-relative **Compose files**.
A main file using `include` or `extends` works without a file list; for explicit merges, list the
files in the same order as your usual `docker compose -f ...` command.
Without overrides, T3 Code detects the nearest Compose project and bind mount, then looks for
Mago in the area's Composer installation or on the container's executable path.

The **Terminal** view offers configured Compose services beside the normal terminal. Choose a
service from the scrollable tabs or selector; recently used services appear first. Toggle **Logs**
to split the container shell and its live Compose logs. Services must already be running. Leaving
the container view closes its owned shell and log stream while retaining the normal terminal.

Docker choices are shared per area through `.t3/monolith.json`, for example:

```json
"magoDocker": {
  "service": "php",
  "composeDirectory": ".",
  "containerPath": "/app/artifact/api",
  "binary": "tools/vendor/bin/mago"
}
```

The project settings show detected tools and configuration paths. If the Symfony Wiring exporter
and application autoloader are installed, **Generate container reference** refreshes the dev-container
reference. The Symfony application must be able to boot in that environment. This action writes the
reference file and may warm Symfony's dev cache; file-open checks only read the current reference.
Saved PHP files also show static Doctrine query budgets per method and entry files with their
call chains. Install `byte-kitsune/mago-doctrine-query-budget` **0.1.0-beta.12** or newer and
`byte-kitsune/mago-architecture-graph` **0.1.0-beta.16** or newer in the application's Composer
project or its tools installation. Earlier versions are reported as unsupported. These inspections
use the extensions' public APIs over the configured Mago source set, including unchanged callers.
The Mago workspace must match the PHP area's root; a different configured workspace produces an
explicit failure instead of inspecting or linking the wrong source tree.
Query ranges describe one invocation; unresolved calls and recursion remain visible as unknown
bounds. An injected service alone does not prove a method call.

PHP comment hints require architecture graph **0.1.0-beta.17** or newer. By default, `[DEV COMMENT]`,
`@deprecated`, `@todo` and `@see` attach metadata to declarations and resolved direct uses. Interface
comments appear over implementing class names; interface-method comments appear over matching method
signatures. Configure marker names and severities per PHP area, or disable them. Multiline text ends
at an empty line, the next `@` tag or the comment end. Use a hint's source link to open its declaration.

Opening a project indexes configured PHP and React areas in the background. File checks reuse local
results only when the SHA-256 source hash and area dependencies still match. Branch switches, pulls,
configuration changes and refreshed Symfony references invalidate affected results. Editor changes
are saved after a short pause and checked after saving. The footer reports index progress and allows
rebuilding; generated `.t3/monolith-index/` cache data should remain untracked. Project indexing is bounded to
2,000 source files and 32 MiB per area; limits and unavailable tools are reported explicitly.

In the file source view, **Ctrl-click** a PHP class or method name (**Cmd-click** on macOS) to
inspect direct callers and entry call chains. Class selection groups its modeled methods. Select a
usage or chain step to open the file at that line; the PHP insights panel also offers call graph
buttons. Navigation uses saved source and is unavailable while edits or graph refreshes are pending.
Dynamic calls and class instantiation may remain unresolved; the view shows method call evidence.

In **Monolith areas**, configure PHP **Entry folders** relative to that area, for example
`app/Http, src/Command`. They are shared as `entrypointPaths` in `.t3/monolith.json`; the defaults are
`src/Controller` and `src/Command`. An existing `.mago/architecture-policy.json` with an enabled
scope graph takes precedence, including its source-root and exclusion filters. Chains include source links and one shortest path per configured
entry and target method/service variant. Missing references and incomplete graphs are shown
explicitly, including recursive call paths; no chain found does not establish that a class is unused. Generate the container
reference explicitly when Symfony service bindings change. Area-based AI review is a planned addition.
