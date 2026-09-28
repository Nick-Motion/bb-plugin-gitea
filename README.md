# Gitea

Gitea brings issues and pull requests from a Gitea instance into BB through the Gitea `tea` CLI (0.15.1 or newer).

## Install

```sh
bb plugin install https://github.com/Nick-Motion/bb-plugin-gitea
```

Pin a release with `bb plugin install git:https://github.com/Nick-Motion/bb-plugin-gitea.git@v1.0.0`. The plugin id is `gitea`, and it registers the `bb gitea` command; do not install it alongside another plugin that registers the same command.

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

The panel copies My GitHub's tab header, compact state-and-title rows, list/detail navigation, themed diff renderer, and card spacing. It provides **My PRs**, **Issues**, and **Pull requests**, repository/state/text filters, refresh, issue creation, detail conversations, comments, close/reopen, label and assignee editing, PR files/checks/reviews, agent dispatch, and links to BB threads. My PRs filters the fetched pages by the configured instance login. Gitea limitations mean inline review threads and native auto-merge are unavailable; checks come from commit statuses.

Lists include at most 50 repositories, use pages of 50, fetch at most ten pages per repository, and return at most 200 items total. PR comments and reviews use the same 500-item cap; PR files and commit statuses are capped at 100. When a cap or repository error affects a result, the panel and JSON output report it. Results within those bounds include older pages, and no list claims to be complete beyond its cap.

## CLI

Every panel action has a typed RPC and a matching `bb gitea` command. Read commands accept `--json` where shown. Mutations run only when the corresponding command is explicitly invoked.

```sh
bb gitea status [--json]
bb gitea repos [--json]
bb gitea issues [owner/repo] [--state open|closed|all] [--query text] [--json]
bb gitea prs [owner/repo] [--state open|closed|all] [--query text] [--json]
bb gitea show <issue|pr> <owner/repo> <number> [--json]
bb gitea create-issue <owner/repo> <title> [--body text]
bb gitea comment <owner/repo> <number> <body>
bb gitea set-state <owner/repo> <number> <open|closed>
bb gitea metadata <owner/repo> <number> <labels-csv> <assignees-csv>
bb gitea review <owner/repo> <number> <APPROVED|REQUEST_CHANGES|COMMENT> [body]
bb gitea send-agent <issue|pr> <owner/repo> <number>
bb gitea thread <thread-id> [--json]
bb gitea refresh [--json]
```

The selected tea login needs read access for browsing. Issue creation, comments, state changes, metadata updates, and reviews need the corresponding Gitea write permissions. Agent threads receive instructions to inspect and report; they do not post changes to Gitea unless explicitly asked.

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
