# Gitea

Gitea brings issues and pull requests from a Gitea instance into BB through the Gitea `tea` CLI (0.15.1 or newer).

## Install

```sh
bb plugin install https://github.com/Nick-Motion/bb-plugin-gitea
```

This README describes version 1.2.0. Once the `v1.2.0` tag is published, pin it with `bb plugin install git:https://github.com/Nick-Motion/bb-plugin-gitea.git@v1.2.0`. To move an existing installation to a new release, run `bb plugin update gitea --yes`; settings and babysitter state are kept. The plugin id is `gitea`, and it registers the `bb gitea` command; do not install it alongside another plugin that registers the same command.

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

The panel copies My GitHub's tab header, compact state-and-title rows, list/detail navigation, themed diff renderer, and card spacing. It provides **My PRs**, **Issues**, **Pull requests**, and **Babysitters**, repository/state/text filters, refresh, issue creation, detail conversations, comments, close/reopen, label and assignee editing, PR files/checks/reviews, agent dispatch, and links to BB threads. My PRs lists pull requests in tracked repositories whose author is the signed-in Gitea login. Gitea limitations mean inline review threads and native auto-merge are unavailable; checks come from commit statuses.

PR files show each patch that Gitea includes. When Gitea omits a patch, the plugin fetches the raw `pulls/<number>.diff` through the same `tea api --include` transport and matches its sections to files by new path, and by previous path for renames. The files and diff are bound to the head and base revision read before and after them; the Files tab passes the revision from the conversation. If the revision moves, the plugin rereads once; if it moves again, every diff is marked stale. A file shows its patch, a binary or no-content notice, a too-large notice above 256 KiB, or an unavailable reason (missing section, stale revision, raw diff over 16 MiB, or failed raw diff read), with a link to the files page on Gitea.

## Display cache

The panel and `bb gitea conversation` / `bb gitea files` read through a bounded in-memory cache on the plugin server; nothing is written to disk. Each entry is keyed by the normalized instance URL and path prefix, the tea profile and its user, the item kind, the repository (case-insensitive), and the number. Keys hold no bodies or secrets, and realtime notices carry only `owner/repo#number`.

| Read | Fresh for | Served stale for at most | Entries | Total size | Largest entry |
| --- | --- | --- | --- | --- | --- |
| Conversation (item, comments, reviews, checks, revision) | 15 s | 10 min | 64 | 16 MiB | 2 MiB |
| Pull request files and diffs, per head/base revision | 5 min | 30 min | 16 | 32 MiB | 8 MiB |

A fresh entry returns without calling Gitea. An older entry returns immediately with `freshness.state` `refreshing` while one shared background read updates it. When that read finishes, the plugin publishes `display-changed` and the panel rereads. If the refresh fails, the entry is shown as `stale-error` with the error. The read is retried after 30 seconds and is dropped when its retention ends. Concurrent identical reads share one Gitea read. When one caller cancels, a read still shared by other callers keeps running; background refreshes never belong to a caller. The least recently used entries are evicted first. Larger values are returned but not stored, and so are files that went stale while they were read.

The following clear the cache:

- **Refresh** in the panel and `--refresh` reread the item from Gitea.
- Comments, state changes, label and assignee edits, and reviews invalidate their item.
- A settings change clears everything.
- A rejected or missing tea login clears everything; a 403 or 404 drops that entry.
- A read that was in flight when its entry was invalidated cannot repopulate the cache.
- Reloading the plugin disposes the cache and cancels its reads.

The conversation loads the issue, comments, pull request, reviews, and commit statuses in parallel, within tea's eight concurrent requests. It does not fetch files or the raw diff; the Files tab requests them for the revision the conversation shows. If the pull request moved, the files response reports the new revision and the conversation is reloaded instead of pairing old diffs with it.

Babysitter lifecycle, merge and terminal decisions, mutations, and `bb gitea show` never use the display cache; they read Gitea directly.

## Babysitters

A babysitter is a hidden BB thread that watches one of your open pull requests until Gitea reports it merged or closed, or until it needs you. Start, stop, and retry babysitters from My PRs or the Babysitters tab. Starting requires an open PR in a repository with a BB project checkout; `extraRepos` without a project cannot be babysat. One session exists per pull request, and repository names match case-insensitively: repeated or concurrent starts return the same thread, and stopped, failed, and needs-you sessions are retained and resumed in the same thread by retry. Merged sessions are final. A closed session stays closed until Gitea reports the pull request open again; starting or retrying it then replaces the session with a fresh thread. Deleting a babysitter thread forgets its session, so the next start or retry spawns a fresh thread. Stop records the stopped state before it stops and archives the thread.

The worker uses `tea` with the resolved login profile, may fix, push, reply to and resolve review comments, and may merge with `tea pulls merge --style` only when permissions, branch protection, required checks, and approvals allow it. It never enables auto-merge, which Gitea does not offer. Its final marker is accepted only when Gitea's `merged`/`state` fields agree; a disagreement or an unreadable state fails the session. Terminal and failed sessions are stopped and archived; a cleanup failure is shown on the session and retried before the thread resumes. After a plugin reload, a background pass reconciles watching sessions whose threads went idle, errored, or were archived.

Babysitter preferences choose the provider, model, reasoning level, and service tier for new babysitters (default Codex `gpt-5.6-luna`, `xhigh`, default tier). **Auto-babysit my PRs in BB projects** is off by default. When on, the plugin starts babysitters every five minutes for open PRs you authored in project-backed repositories that have no session, or only a closed session. Preferences are stored in plugin storage, not plugin settings.

Lists include at most 50 repositories, use pages of 50, fetch at most ten pages per repository, and return at most 200 items total. PR comments and reviews use the same 500-item cap; PR files and commit statuses are capped at 100. When a cap or repository error affects a result, the panel and JSON output report it. Results within those bounds include older pages, and no list claims to be complete beyond its cap.

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
bb gitea set-state <owner/repo> <number> <open|closed>
bb gitea metadata <owner/repo> <number> <labels-csv> <assignees-csv>
bb gitea review <owner/repo> <number> <APPROVED|REQUEST_CHANGES|COMMENT> [body]
bb gitea send-agent <issue|pr> <owner/repo> <number>
bb gitea thread <thread-id> [--json]
bb gitea my-prs [owner/repo] [--state open|closed|all] [--query text] [--json]
bb gitea babysit <owner/repo> <number> [--json]
bb gitea babysit-status <owner/repo> <number> [--json]
bb gitea babysit-stop <owner/repo> <number> [--json]
bb gitea babysit-retry <owner/repo> <number> [--json]
bb gitea babysit-thread <thread-id> [--json]
bb gitea babysit-sessions [--json]
bb gitea auto-babysit [on|off] [--json]
bb gitea babysit-execution <provider> <model> <reasoning> [fast|default] [--json]
bb gitea refresh [--json]
```

The selected tea login needs read access for browsing. Issue creation, comments, state changes, metadata updates, and reviews need the corresponding Gitea write permissions. Agent threads receive instructions to inspect and report; they do not post changes to Gitea unless explicitly asked. Babysitters are the exception: once started, they may push, comment, resolve review comments, mark WIP pull requests ready with `tea pulls edit --ready`, and merge within the rules above, using the permissions of the selected tea login.

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
