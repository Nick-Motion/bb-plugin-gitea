# Gitea

Gitea brings issues and pull requests from a Gitea instance into BB through the Gitea `tea` CLI (0.15.1 or newer).

## Install

```sh
bb plugin install https://github.com/Nick-Motion/bb-plugin-gitea
```

This README describes version 1.5.0. Once the `v1.5.0` tag is published, pin it with `bb plugin install git:https://github.com/Nick-Motion/bb-plugin-gitea.git@v1.5.0`. To move an existing installation to a new release, run `bb plugin update gitea --yes`; settings and babysitter state are kept. The plugin id is `gitea`, and it registers the `bb gitea` command; do not install it alongside another plugin that registers the same command.

## Configure

Install `tea` and authenticate with `tea login add`. Set **Gitea instance URL**, optionally **tea login profile**, and **Additional repositories** in Gitea plugin settings. `baseUrl` defaults to `https://gitea.com`; the profile is auto-detected when a single account matches the instance. Select a profile when matching accounts differ. Remote instances require HTTPS. A reverse-proxy path prefix such as `/gitea/` is preserved. HTTP is allowed only for localhost and `127.0.0.1`.

Repositories come from BB project local-source `origin` remotes that match the configured Gitea hostname and path prefix, plus `extraRepos`, a comma or whitespace separated list of `owner/repo` names. HTTPS remotes must match the configured scheme and port. SSH remotes match the hostname and path prefix; their SSH port is independent of the HTTPS port. An explicit extra repository can be added even without an attached project; starting an agent requires an associated project checkout.

```sh
bb plugin config gitea set baseUrl https://gitea.example.com/gitea/
tea login add
bb plugin config gitea set extraRepos owner/repo,team/project
bb plugin reload gitea
```

The plugin runs `tea api` without a shell, always passes the resolved profile with `--login`, and sends mutation bodies through stdin. Profile metadata comes from `tea logins list --output json`; a profile is used only when its URL has the same origin and path prefix as `baseUrl`. Aliases for the same account are coalesced, and an explicit **tea login profile** for another instance is rejected. BB stores no Gitea token, and errors never include tea output.

## Use

The panel copies My GitHub's tab header, compact state-and-title rows, list/detail navigation, themed diff renderer, and card spacing. It provides **My PRs**, **Issues**, **Pull requests**, and **Auto-fixers**, repository/state/text filters, refresh, issue creation, detail conversations, comments, close/reopen, label and assignee editing, PR checks and reviews, agent dispatch, and links to BB threads. A pull request opens on its **Conversation** tab; **Files changed** is a separate tab in both the nav panel and the linked-thread panel, and its files load only when that tab is opened. My PRs lists pull requests in tracked repositories whose author is the signed-in Gitea login. In **Files changed**, click a line's gutter button to leave a line comment; existing line comments show inline and under **Line comments** in the conversation. Native auto-merge is unavailable; checks come from commit statuses.

**Files changed** shows a changed-files tree built with [`@pierre/trees`](https://www.npmjs.com/package/@pierre/trees) beside per-file diffs rendered with `@pierre/diffs` inside its virtualizer, so off-screen diffs are not rendered. The tree colors files as added, deleted, renamed, or modified, shows `+additions −deletions` for each file, supports keyboard navigation and search, and scrolls the diff list to the selected file. Each diff card shows `previous → new` for renames, the counts, and Gitea's status. In a narrow panel the tree stacks above the diffs.

PR files show each patch that Gitea includes. When Gitea omits a patch, the plugin fetches the raw `pulls/<number>.diff` through the same `tea api --include` transport and matches its sections to files by new path, and by previous path for renames. The files and diff are bound to the head and base revision read before and after them; the Files tab passes the revision from the conversation. If the revision moves, the plugin rereads once; if it moves again, every diff is marked stale. A file shows its patch, a binary or no-content notice, a too-large notice above 256 KiB, or an unavailable reason (missing section, stale revision, raw diff over 16 MiB, or failed raw diff read), with a link to the files page on Gitea.

## Display cache

The panel and `bb gitea conversation` / `bb gitea files` read through a bounded in-memory cache on the plugin server; nothing is written to disk. Each entry is keyed by the normalized instance URL and path prefix, the tea profile and its user, the item kind, the repository (case-insensitive), and the number. Keys hold no bodies or secrets, and realtime notices carry only `owner/repo#number` or `lists`.

| Read | Fresh for | Served stale for at most | Entries | Total size | Largest entry |
| --- | --- | --- | --- | --- | --- |
| Conversation (item, comments, reviews, checks, revision) | 15 s | 10 min | 64 | 16 MiB | 2 MiB |
| Pull request files and diffs, per head/base revision | 5 min | 30 min | 16 | 32 MiB | 8 MiB |
| Issue and pull request lists, per kind, repository or all, and state | 15 s | 10 min | 32 | 32 MiB | 8 MiB |
| My PRs, per repository or all, and state | 15 s | 10 min | 32 | 32 MiB | 8 MiB |

A fresh entry returns without calling Gitea. An older entry returns immediately with `freshness.state` `refreshing` while one shared background read updates it. When that read finishes, the plugin publishes `display-changed` and the panel rereads. If the refresh fails, the entry is shown as `stale-error` with the error. The read is retried after 30 seconds and is dropped when its retention ends. Concurrent identical reads share one Gitea read. When one caller cancels, a read still shared by other callers keeps running; background refreshes never belong to a caller. The least recently used entries are evicted first. Larger values are returned but not stored, and so are files that went stale while they were read.

The following clear the cache:

- **Refresh** in the panel and `--refresh` reread the item from Gitea.
- Comments, state changes, label and assignee edits, and reviews invalidate their item. State changes, label and assignee edits, and new issues also invalidate every list; comments and reviews do not.
- A settings change clears everything.
- A rejected or missing tea login clears everything; a 403 or 404 drops that entry.
- A read that was in flight when its entry was invalidated cannot repopulate the cache.
- Reloading the plugin disposes the cache and cancels its reads.

The conversation loads the issue, comments, pull request, reviews, and commit statuses in parallel, within tea's eight concurrent requests. It does not fetch files or the raw diff; the Files tab requests them for the revision the conversation shows. If the pull request moved, the files response reports the new revision and the conversation is reloaded instead of pairing old diffs with it.

Lists cache every item in the tracked repositories and apply the text query afterward, so changing the search does not read Gitea again. When every repository fails, the list read fails; a cached list then shows as `stale-error`. `bb gitea issues`, `prs`, and `my-prs` always reread Gitea and refresh the cached list.

The panel also remembers its tab, filters, readiness, preferences, and the last 16 lists in page memory. Remembered readiness and rows belong to one verified account: the instance, tea profile, and user the server reported for them. An app-wide watcher keeps that account verified while the panel is closed. It stays mounted for the life of the BB page and watches the plugin settings, the server's cache-clear notices, and the realtime connection. Returning to the panel from a thread repaints the remembered rows and filters at once only while the account is still verified and the settings match, then asks the server for the list, which is free while the server entry is fresh and otherwise refreshes in the background. A settings change or a server cache-clear notice forgets every remembered list and readiness before anything can repaint them. The server sends that notice on a settings change and when Gitea rejects the tea login or the profile disappears while its cache holds entries. A readiness check that reports Gitea as not ready also forgets everything; the panel runs one after a failed list read, and any reply to a request started before the forget is ignored. A lost realtime connection, a missing watcher, or unreadable settings keeps the remembered rows hidden until a readiness check confirms the same account, without waiting for the list. Neither the panel nor the server watches tea's own login files. If a token is revoked outside BB, the remembered rows for that account can show until the background readiness or list request is rejected, which then forgets them all. A filter the panel has not shown yet displays a loading state, never another filter's rows, and a reply to an older filter is ignored. Page memory ends when the BB page reloads; the next visit then reads from the server cache. The Auto-fixers tab is not remembered.

Babysitter lifecycle, automatic babysitting, merge and terminal decisions, mutations, and `bb gitea show` never use the display cache; they read Gitea directly.

## Auto-fix and Auto-merge

Each of your pull requests has two independent options, both off by default:

- **Auto-fix** fixes CI failures and addresses review feedback: it may change code, commit, push, rebase, reply to and resolve review comments, and mark a WIP pull request ready with `tea pulls edit --ready`. Auto-fix never merges.
- **Auto-merge** merges with `tea pulls merge --style` once permissions, branch protection, required checks, approvals, and conflicts allow it. Auto-merge never changes code. Gitea has no native auto-merge, so this is not a Gitea setting: the babysitter merges with the selected tea login when the rules allow.

All four combinations are valid. With only Auto-fix, the babysitter fixes and keeps watching until a human merges or closes the pull request. With only Auto-merge, it reports failing checks, requested changes, or conflicts as needing you instead of fixing them. Only an explicit Auto-merge choice grants merge authority. Both limits are enforced by the babysitter's instructions, which run with the tea login's permissions; they are not enforced by Gitea.

Turn the options on or off from My PRs, the Auto-fixers tab, or `bb gitea auto-fix` / `bb gitea auto-merge`. Turning either on starts a babysitter, a hidden BB thread that watches the pull request until Gitea reports it merged or closed, or until it needs you. Changing an option on a watching babysitter sends the new instructions to the same thread; if they cannot be delivered at once, any queued copy is withdrawn and the babysitter is stopped rather than left running under the old options. Turning both off stops the babysitter and archives its thread. Turning an option on for a stopped, failed, or needs-you session resumes it in the same thread with the new options.

Starting requires an open PR in a repository with a BB project checkout; `extraRepos` without a project cannot be babysat. One session exists per pull request, and repository names match case-insensitively: repeated or concurrent changes apply in order to the same thread, and stopped, failed, and needs-you sessions are retained. Retry resumes a failed or needs-you session with its last options. A stopped session keeps no options, so only turning an option on resumes it. Merged sessions are final. A closed session stays closed until Gitea reports the pull request open again; turning an option on then replaces the session with a fresh thread. Deleting a babysitter thread forgets its session.

The babysitter's final marker is accepted only when Gitea's `merged`/`state` fields agree; a disagreement or an unreadable state fails the session. Terminal and failed sessions are stopped and archived; a cleanup failure is shown on the session and retried before the thread resumes. After a plugin reload, a background pass reconciles watching sessions whose threads went idle, errored, or were archived, and finishes archiving stopped sessions whose cleanup failed. Changes to the automatic defaults apply to every later automatic start, including one already reading the pull request list.

Automation defaults choose the provider, model, reasoning level, and service tier for new babysitters (default Codex `gpt-5.6-luna`, `xhigh`, default tier), and whether **Auto-fix** and **Auto-merge** turn on automatically for your pull requests. Both are off by default. When either is on, the plugin starts babysitters with those options every five minutes for open PRs you authored in project-backed repositories that have no session, or only a closed session. Preferences are stored in plugin storage, not plugin settings.

Sessions and preferences saved by earlier versions are kept. A babysitter started before this version keeps the authority it was started with, so it shows Auto-fix and Auto-merge on. An earlier **Auto-babysit** preference becomes the same value for both defaults.

Lists include at most 50 repositories, use pages of 50, fetch at most ten pages per repository, and return at most 200 items total. PR comments and reviews use the same 500-item cap; PR files are capped at 500 and commit statuses at 100. When a cap or repository error affects a result, the panel and JSON output report it. Results within those bounds include older pages, and no list claims to be complete beyond its cap.

## CLI

Every panel action has a typed RPC and a matching `bb gitea` command. Read commands accept `--json` where shown. Mutations run only when the corresponding command is explicitly invoked.

```sh
bb gitea status [--json]
bb gitea repos [--json]
bb gitea issues [owner/repo] [--state open|closed|all] [--query text] [--json]
bb gitea prs [owner/repo] [--state open|closed|all] [--query text] [--json]
bb gitea show <issue|pr> <owner/repo> <number> [--json]
bb gitea conversation <issue|pr> <owner/repo> <number> [--refresh] [--json]
bb gitea files <owner/repo> <number> [--refresh] [--json]
bb gitea create-issue <owner/repo> <title> [--body text]
bb gitea comment <owner/repo> <number> <body>
bb gitea line-comment <owner/repo> <number> <path> <line> [--old] <body>
bb gitea set-state <owner/repo> <number> <open|closed>
bb gitea metadata <owner/repo> <number> <labels-csv> <assignees-csv>
bb gitea review <owner/repo> <number> <APPROVED|REQUEST_CHANGES|COMMENT> [body]
bb gitea send-agent <issue|pr> <owner/repo> <number>
bb gitea thread <thread-id> [--json]
bb gitea my-prs [owner/repo] [--state open|closed|all] [--query text] [--json]
bb gitea auto-fix <owner/repo> <number> on|off [--json]
bb gitea auto-merge <owner/repo> <number> on|off [--json]
bb gitea babysit-status <owner/repo> <number> [--json]
bb gitea babysit-retry <owner/repo> <number> [--json]
bb gitea babysit-thread <thread-id> [--json]
bb gitea babysit-sessions [--json]
bb gitea automation-defaults [fix|merge on|off] [--json]
bb gitea babysit-execution <provider> <model> <reasoning> [fast|default] [--json]
bb gitea refresh [--json]
```

The selected tea login needs read access for browsing. Issue creation, comments, state changes, metadata updates, and reviews need the corresponding Gitea write permissions. Agent threads receive instructions to inspect and report; they do not post changes to Gitea unless explicitly asked. Babysitters are the exception: with Auto-fix they may push, comment, resolve review comments, and mark WIP pull requests ready with `tea pulls edit --ready`, and with Auto-merge they may merge within the rules above, using the permissions of the selected tea login.

## Development

```sh
npm install
npm run typecheck
npm test
bb plugin build .
```

Tests run `tea` against the local fixture in `test-fixtures/tea` and never contact a Gitea server.

## License

MIT. See [LICENSE](LICENSE). Adapted from the My GitHub plugin in [BB](https://github.com/get-bb/bb).
