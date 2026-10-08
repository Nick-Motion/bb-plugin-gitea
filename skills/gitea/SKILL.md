# Gitea commands and settings

The plugin reads and writes Gitea through `tea api`, using the `tea` CLI 0.15.1 or newer signed in with `tea login add`. BB stores no Gitea token. `tea logins list` shows profile names.

Write to Gitea only when the user asks. Read commands accept `--json`. List commands default to open items and accept `--state open|closed|all` and `--query text`.

## Read

- `bb gitea status` checks sign-in and lists repositories.
- `bb gitea repos` lists repositories from matching project `origin` remotes and `extraRepos`.
- `bb gitea issues|prs|my-prs|my-issues [owner/repo]` list items. `my-issues` lists issues assigned to the signed-in account (not pull requests); all list commands accept `--state open|closed|all`, `--query text`, and `--json`. `my-prs` lists pull requests by the signed-in login, with each one's Auto-fix, Auto-merge, and auto-fixer state and the automation defaults. New issues created from My Issues are assigned to the signed-in account; ordinary creation is unchanged.
- `bb gitea show <issue|pr> <owner/repo> <number>` reads Gitea directly: the item, comments, and for a pull request its files, checks, and reviews. Use it when a decision needs current state.
- `bb gitea conversation <issue|pr> <owner/repo> <number> [--refresh]` returns what the panel shows, without files. It is cached; `freshness.state` is `fresh`, `refreshing`, or `stale-error`. `--refresh` rereads Gitea. Comment `id`s come from here.
- `bb gitea files <owner/repo> <number> [--refresh]` returns changed files and diffs for the returned `revision`, with `freshness` and a `stale` flag when the pull request moved during the read. Each file's `diff.kind` is `text` (with `patch`), `empty`, `binary`, `too-large` (over 256 KiB), or `unavailable` with `reason` `missing`, `stale`, `diff-too-large`, or `diff-failed`.
- `bb gitea options <owner/repo>` lists the repository's labels (name and color) and assignable users.
- `bb gitea thread <thread-id>` reads the item linked to a BB thread.
- `bb gitea refresh` rediscovers repositories now. Otherwise discovery is reused for 30 seconds, so a newly added project can take that long to appear.

## Write

- `bb gitea create-issue <owner/repo> <title> [--body text]`
- `bb gitea comment <owner/repo> <number> <body>`
- `bb gitea comment-edit <owner/repo> <number> <comment-id> <body>`
- `bb gitea comment-delete <owner/repo> <number> <comment-id>`
- `bb gitea line-comment <owner/repo> <number> <path> <line> [--old] <body>` comments on a line of the head diff. `--old` targets the removed side.
- `bb gitea metadata <owner/repo> <number> <labels-csv> <assignees-csv>` replaces labels and assignees. An empty string clears a field.
- `bb gitea set-state <owner/repo> <number> <open|closed>`
- `bb gitea draft <owner/repo> <number> on|off` adds or removes the `WIP: ` title prefix that marks a Gitea draft. `off` also strips `[WIP]`.
- `bb gitea review <owner/repo> <number> <APPROVED|REQUEST_CHANGES|COMMENT> [body]`
- `bb gitea send-agent <issue|pr> <owner/repo> <number>` starts a BB thread on the item. The item's repository needs a BB project checkout. The thread is told not to write to Gitea unless asked.
- `bb gitea agent-execution [<provider> <model> <reasoning> [fast|default] | default]` shows or sets the model for send-agent threads. `default` uses the project default.

## Auto-fix and Auto-merge

Auto-fix and native Auto-merge are separate actions.

- Auto-fix starts a hidden BB thread to fix CI failures and review feedback. It may commit, push, rebase, and reply to and resolve review comments. It must never merge or schedule a merge. Turning Auto-fix off stops and archives the thread.
- Auto-merge calls `tea api` on the BB server to POST `/repos/{owner}/{repo}/pulls/{number}/merge` with `merge_when_checks_succeed: true`, the current head SHA, and the repository's default merge style. Gitea owns the queue and enforces its rules. It may merge immediately if ready. No agent is created or steered.
- Turning Auto-merge off calls DELETE on that endpoint to cancel the native request. Errors are returned without an agent fallback. The API does not expose queue state; the UI offers explicit request and cancel actions rather than a status toggle.

Auto-fix threads run on the repository checkout's host. Install `tea` and sign in there; the BB server's login does not authenticate another host. Native merges use the BB server login and survive BB restarts. Legacy merge agents are stopped on startup and cannot be retried. Never turn on either action without a user request for that pull request.

- `bb gitea auto-fix|auto-merge <owner/repo> <number> on|off`
- `bb gitea auto-fixer-status <owner/repo> <number>` shows the auto-fix thread status and available actions. It does not report native Gitea merge queue state.
- `bb gitea auto-fixer-retry <owner/repo> <number>` resumes a failed or needs-you auto-fixer with Auto-fix authority only. It starts a replacement thread if the old thread was deleted or its workspace was retired, preserving the archived old thread. It rejects stopped, closed, and missing sessions; turn Auto-fix on instead.
- `bb gitea auto-fixer-thread <thread-id>` shows the session owned by a thread.
- `bb gitea auto-fixers` lists sessions.
- `bb gitea automation-defaults [fix on|off]` shows or sets Auto-fix all. Bulk auto-merge is not supported; enable Auto-merge for an individual pull request only when requested. When on, every five minutes (and immediately when switched on) the plugin turns the switch on for your open pull requests in project-backed repositories that have no session or only a closed one.
- `bb gitea pr-watch <owner/repo> <number> [--since token] [--timeout seconds]` waits for a cheap change signal: the pull request record (state, head, base, mergeability, update time, comment counts) and the combined head commit status, checked every 30 seconds for up to 240 seconds (at most 600). It prints `changed`, `unchanged`, or `inactive` (the auto-fixer session is no longer watching) and a token for the next `--since`. Auto-fixers use it instead of rereading the full diff and conversation.
- `bb gitea auto-fixer-execution <provider> <model> <reasoning> [fast|default]` sets the model for new auto-fixers.

## RPCs

Reads: `status`, `refresh`, `listItems`, `listMyPullRequests`, `detail`, `conversation`, `pullFiles` (pass the conversation `revision`; the current one is returned if the pull request moved), `repoOptions`, `threadItem`.

Writes: `createIssue`, `comment`, `editComment`, `deleteComment`, `reviewComment` (line comments), `updateMetadata`, `setState`, `setDraft`, `review`, `sendAgent`, `getAgentExecution`, `setAgentExecution` (`execution`, or null for the project default).

Native merging: `setAutoMerge` (`repo`, `number`, `enabled`).

Auto-fixers: `setAutomation` (`repo`, `number`, `fix`), `retryAutoFixer`, `getAutoFixerStatus`, `autoFixerThread`, `listAutoFixerSessions`, `getAutoFixerPreferences`, `setAutoAutomation` (`fix` only), `setAutoFixerExecution`.

## Limits

- Lists cover at most 50 repositories, ten pages of 50 items per repository, and 200 items total. Errors are reported per repository.
- Comments and reviews stop at 500, files at 500, checks at 100. A full result is marked as possibly truncated.
- Panel caches: conversations 15 s fresh and 10 min stale, file sets 5 min fresh and 30 min stale, lists 15 s fresh and 10 min stale. Writes, settings changes, and rejected logins clear them. `show`, list commands, auto-fixers, and merges never use the cache.
- Checks come from commit statuses.

## Settings

Set in the plugin settings page or with `bb plugin config gitea set <key> <value>`.

- `baseUrl`: Gitea root URL, default `https://gitea.com`. HTTPS is required except on localhost. A path prefix is kept.
- `teaProfile`: optional `tea` login name. When empty, the plugin uses the login whose URL matches `baseUrl`. Set it when matching logins belong to different users. A login for another instance is rejected.
- `extraRepos`: optional `owner/repo` names, comma or space separated. They work without a project, but agent features need a project checkout.
- `cacheEntryLimitMiB` (default 16): largest Gitea response read and cached. Larger reads fail with "exceeded the N MiB limit"; raise it for huge diffs.
- `cacheLimitMiB` (default 64): memory for each display cache.
