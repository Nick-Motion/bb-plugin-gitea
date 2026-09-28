# Gitea commands and settings

The plugin needs the Gitea `tea` CLI 0.15.1 or newer, signed in with `tea login add`. Requests run through `tea api` with an explicit login profile; BB stores no Gitea token. Check profile names with `tea logins list`.

Use `bb gitea` and typed Gitea RPCs to inspect or explicitly update Gitea issues and pull requests. Lists default to open items. List filters accept `--state open|closed|all` and `--query text`; `--json` is available on read commands.

## Commands

- `bb gitea status [--json]` checks authentication and lists repositories.
- `bb gitea repos [--json]` lists repositories discovered from matching local `origin` remotes and `extraRepos`.
- `bb gitea issues [owner/repo] [--state open|closed|all] [--query text] [--json]` lists issues.
- `bb gitea prs [owner/repo] [--state open|closed|all] [--query text] [--json]` lists pull requests.
- `bb gitea my-prs [owner/repo] [--state open|closed|all] [--query text] [--json]` lists pull requests authored by the signed-in Gitea login, with each babysitter state and the babysitter preferences.
- `bb gitea show <issue|pr> <owner/repo> <number> [--json]` reads the item, conversation, and, for a pull request, files, checks and reviews. Each file's `diff` has a `kind`: `text` (with `patch`), `empty`, `binary`, `too-large` (over 256 KiB), or `unavailable` with a `reason` of `missing`, `stale`, `diff-too-large`, or `diff-failed`. Patches that Gitea omits are filled from the raw `.diff`, bound to one head/base revision.
- `bb gitea conversation <issue|pr> <owner/repo> <number> [--refresh] [--json]` reads the display view the panel uses: the item, comments, and, for a pull request, head/base revision, changed-file count, checks and reviews, without files or diffs. It comes from a bounded server cache and reports `freshness.state` `fresh`, `refreshing` (served cached while one background read updates it), or `stale-error` (cached, with the last refresh `error`). `--refresh` rereads Gitea.
- `bb gitea files <owner/repo> <number> [--refresh] [--json]` reads the pull request's changed files and diffs, bound to the `revision` it returns, with the same `freshness` and a `stale` flag when the pull request kept moving during the read. The typed RPC `pullFiles` accepts the conversation `revision` and returns the current one when the pull request moved.
- Use `show`, not `conversation`, when a decision needs Gitea's current state; `show` and babysitter, merge and mutation paths never read the display cache.
- `bb gitea create-issue <owner/repo> <title> [--body text]` creates an issue.
- `bb gitea comment <owner/repo> <number> <body>` posts a conversation comment.
- `bb gitea set-state <owner/repo> <number> <open|closed>` changes issue or pull request state.
- `bb gitea metadata <owner/repo> <number> <labels-csv> <assignees-csv>` replaces labels and assignees. Use an empty string to clear either field.
- `bb gitea review <owner/repo> <number> <APPROVED|REQUEST_CHANGES|COMMENT> [body]` submits a pull request review.
- `bb gitea send-agent <issue|pr> <owner/repo> <number>` starts a BB thread for an item associated with a BB project. Agent instructions explicitly prohibit Gitea writes unless asked.
- `bb gitea thread <thread-id> [--json]` reads the item associated with a BB thread.
- `bb gitea refresh [--json]` refreshes repository discovery.

## Babysitters

A babysitter is a hidden BB thread that shepherds one of your open pull requests until Gitea reports it merged or closed, or it needs a human. It requires a repository with a BB project checkout. Gitea has no native auto-merge; a babysitter merges only with `tea pulls merge --style` when permissions, branch protection, required checks, and approvals allow. Its final marker counts only when Gitea's `merged`/`state` fields confirm it.

- `bb gitea babysit <owner/repo> <number> [--json]` starts a babysitter, or returns the existing session's thread. A closed session is replaced by a fresh thread only when Gitea reports the pull request open again; merged sessions are final. Repository names match case-insensitively.
- `bb gitea babysit-status <owner/repo> <number> [--json]` shows the state (`idle`, `watching`, `needs_you`, `failed`, `stopped`, `merged`, `closed`) and available actions.
- `bb gitea babysit-stop <owner/repo> <number> [--json]` stops and archives the thread and retains the session.
- `bb gitea babysit-retry <owner/repo> <number> [--json]` resumes a stopped, failed, or needs-you session in the same thread, finishing any pending cleanup first. If the thread was deleted, or the session is closed and the pull request reopened, it starts a fresh thread instead.
- `bb gitea babysit-thread <thread-id> [--json]` shows the session owned by a BB thread.
- `bb gitea babysit-sessions [--json]` lists retained sessions.
- `bb gitea auto-babysit [on|off] [--json]` shows or sets automatic babysitting. It is off by default; when on, it starts babysitters for your open PRs in project-backed repositories without a session or with only a closed session.
- `bb gitea babysit-execution <provider> <model> <reasoning> [fast|default] [--json]` sets the provider, model, reasoning level, and service tier for new babysitters.

Typed RPCs: `listMyPullRequests`, `startBabysit`, `stopBabysit`, `retryBabysit`, `getBabysitStatus`, `babysitThread`, `listBabysitSessions`, `getBabysitPreferences`, `setAutoBabysit`, `setBabysitExecution`.

List APIs inspect at most 50 repositories, fetch ten pages of 50 items per repository, and return at most 200 items total. Comments and reviews have a 500-item cap; files and checks have a 100-item cap. A full cap is reported as potentially truncated. Display caches hold at most 64 conversations (16 MiB, 15 s fresh, 10 min stale) 16 file sets (32 MiB, 5 min fresh, 30 min stale), and 32 lists of each kind (15 s fresh, 10 min stale) for the panel; mutations, settings changes, and rejected logins invalidate them. The `issues`, `prs`, and `my-prs` commands always reread Gitea. List errors are returned per repository while accessible repositories remain available. `extraRepos` remains usable without a project, but an associated checkout is needed for agent dispatch.

## Settings

- `baseUrl`: configured Gitea root URL. Defaults to `https://gitea.com`. HTTPS is required except for localhost loopback. Path prefixes are retained for API and remote matching.
- `teaProfile`: optional `tea` login profile name. When empty, the plugin picks the profile whose URL matches `baseUrl` origin and path prefix; aliases for the same user are coalesced. Set it when matching profiles belong to different users. A profile for another instance is rejected.
- `extraRepos`: optional comma or whitespace separated `owner/repo` names.

Configure settings in the plugin settings page or with `bb plugin config gitea set <baseUrl|teaProfile|extraRepos> <value>`, then use `bb plugin reload gitea` if the plugin needs a reload.

All external writes require an explicit panel action or CLI invocation; a started babysitter acts on its pull request with the selected tea login's permissions. Inline review threads and native auto-merge are not implemented; PR checks are read from commit statuses.
