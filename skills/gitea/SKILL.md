# Gitea commands and settings

The plugin needs the Gitea `tea` CLI 0.15.1 or newer, signed in with `tea login add`. Requests run through `tea api` with an explicit login profile; BB stores no Gitea token. Check profile names with `tea logins list`.

Use `bb gitea` and typed Gitea RPCs to inspect or explicitly update Gitea issues and pull requests. Lists default to open items. List filters accept `--state open|closed|all` and `--query text`; `--json` is available on read commands.

## Commands

- `bb gitea status [--json]` checks authentication and lists repositories.
- `bb gitea repos [--json]` lists repositories discovered from matching local `origin` remotes and `extraRepos`.
- `bb gitea issues [owner/repo] [--state open|closed|all] [--query text] [--json]` lists issues.
- `bb gitea prs [owner/repo] [--state open|closed|all] [--query text] [--json]` lists pull requests. The panel's My PRs tab filters these results by the configured login, including fetched later pages.
- `bb gitea show <issue|pr> <owner/repo> <number> [--json]` reads the item, conversation, and, for a pull request, files, checks and reviews.
- `bb gitea create-issue <owner/repo> <title> [--body text]` creates an issue.
- `bb gitea comment <owner/repo> <number> <body>` posts a conversation comment.
- `bb gitea set-state <owner/repo> <number> <open|closed>` changes issue or pull request state.
- `bb gitea metadata <owner/repo> <number> <labels-csv> <assignees-csv>` replaces labels and assignees. Use an empty string to clear either field.
- `bb gitea review <owner/repo> <number> <APPROVED|REQUEST_CHANGES|COMMENT> [body]` submits a pull request review.
- `bb gitea send-agent <issue|pr> <owner/repo> <number>` starts a BB thread for an item associated with a BB project. Agent instructions explicitly prohibit Gitea writes unless asked.
- `bb gitea thread <thread-id> [--json]` reads the item associated with a BB thread.
- `bb gitea refresh [--json]` refreshes repository discovery.

List APIs inspect at most 50 repositories, fetch ten pages of 50 items per repository, and return at most 200 items total. Comments and reviews have a 500-item cap; files and checks have a 100-item cap. A full cap is reported as potentially truncated. List errors are returned per repository while accessible repositories remain available. `extraRepos` remains usable without a project, but an associated checkout is needed for agent dispatch.

## Settings

- `baseUrl`: configured Gitea root URL. Defaults to `https://gitea.com`. HTTPS is required except for localhost loopback. Path prefixes are retained for API and remote matching.
- `teaProfile`: optional `tea` login profile name. When empty, the plugin picks the profile whose URL matches `baseUrl` origin and path prefix; aliases for the same user are coalesced. Set it when matching profiles belong to different users. A profile for another instance is rejected.
- `extraRepos`: optional comma or whitespace separated `owner/repo` names.

Configure settings in the plugin settings page or with `bb plugin config gitea set <baseUrl|teaProfile|extraRepos> <value>`, then use `bb plugin reload gitea` if the plugin needs a reload.

All external writes require an explicit panel action or CLI invocation. Inline review threads and native auto-merge are not implemented; PR checks are read from commit statuses.
