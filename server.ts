import {
  defineRpcContract,
  type BbPluginApi,
  type PluginRpcHandlers,
} from "@get-bb/plugin-sdk";
import { z } from "zod";
import { execFile, type ExecFileException } from "node:child_process";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);

const repositorySchema = z.string().regex(/^[\w.-]+\/[\w.-]+$/);
const itemSchema = z.object({
  repo: repositorySchema,
  number: z.number().int().positive(),
  kind: z.enum(["issue", "pr"]),
  title: z.string(),
  state: z.string(),
  author: z.string(),
  labels: z.array(z.string()),
  assignees: z.array(z.string()),
  url: z.string(),
  body: z.string(),
  updatedAt: z.string(),
});
const listOutputSchema = z.object({
  items: z.array(itemSchema),
  truncated: z.boolean(),
  errors: z.array(z.object({ repo: repositorySchema, message: z.string() })),
});
const commentSchema = z.object({
  author: z.string(),
  body: z.string(),
  createdAt: z.string(),
});
const detailSchema = itemSchema.extend({
  comments: z.array(commentSchema),
  commentsTruncated: z.boolean(),
  files: z.array(
    z.object({
      path: z.string(),
      status: z.string(),
      additions: z.number(),
      deletions: z.number(),
      patch: z.string().nullable(),
    }),
  ),
  checksTruncated: z.boolean(),
  checks: z.array(
    z.object({
      name: z.string(),
      status: z.enum(["success", "failure", "pending", "neutral"]),
      url: z.string(),
    }),
  ),
  reviews: z.array(
    z.object({
      author: z.string(),
      state: z.string(),
      body: z.string(),
      createdAt: z.string(),
    }),
  ),
  filesTruncated: z.boolean(),
  reviewsTruncated: z.boolean(),
  headRefName: z.string(),
  baseRefName: z.string(),
  threadId: z.string().nullable(),
});
const okSchema = z.object({ ok: z.literal(true) });

export const giteaRpcContract = defineRpcContract({
  status: {
    input: z.null(),
    output: z.object({
      ready: z.boolean(),
      error: z.string().nullable(),
      login: z.string().nullable(),
      repos: z.array(
        z.object({ repo: repositorySchema, projectId: z.string().nullable() }),
      ),
    }),
  },
  listItems: {
    input: z.object({
      kind: z.enum(["issue", "pr"]),
      repo: repositorySchema.optional(),
      state: z.enum(["open", "closed", "all"]).default("open"),
      query: z.string().max(200).default(""),
    }),
    output: listOutputSchema,
  },
  detail: {
    input: z.object({
      repo: repositorySchema,
      number: z.number().int().positive(),
      kind: z.enum(["issue", "pr"]),
    }),
    output: detailSchema,
  },
  createIssue: {
    input: z.object({
      repo: repositorySchema,
      title: z.string().trim().min(1).max(256),
      body: z.string().max(100000),
    }),
    output: itemSchema,
  },
  comment: {
    input: z.object({
      repo: repositorySchema,
      number: z.number().int().positive(),
      body: z.string().trim().min(1).max(100000),
    }),
    output: okSchema,
  },
  setState: {
    input: z.object({
      repo: repositorySchema,
      number: z.number().int().positive(),
      state: z.enum(["open", "closed"]),
    }),
    output: okSchema,
  },
  updateMetadata: {
    input: z.object({
      repo: repositorySchema,
      number: z.number().int().positive(),
      labels: z.array(z.string().trim().min(1).max(100)).max(50),
      assignees: z.array(z.string().trim().min(1).max(100)).max(50),
    }),
    output: okSchema,
  },
  review: {
    input: z.object({
      repo: repositorySchema,
      number: z.number().int().positive(),
      event: z.enum(["APPROVED", "REQUEST_CHANGES", "COMMENT"]),
      body: z.string().max(100000),
    }),
    output: okSchema,
  },
  sendAgent: {
    input: z.object({
      repo: repositorySchema,
      number: z.number().int().positive(),
      kind: z.enum(["issue", "pr"]),
    }),
    output: z.object({ threadId: z.string().min(1) }),
  },
  threadItem: {
    input: z.object({ threadId: z.string().min(1) }),
    output: z
      .object({
        repo: repositorySchema,
        number: z.number().int().positive(),
        kind: z.enum(["issue", "pr"]),
      })
      .nullable(),
  },
  refresh: {
    input: z.null(),
    output: z.object({
      repos: z.number().int().nonnegative(),
      items: z.number().int().nonnegative(),
    }),
  },
});

type Repo = { repo: string; projectId: string | null };
type RpcContext = { experimental_signal?: AbortSignal };
type ApiRequest = {
  method?: "GET" | "POST" | "PATCH" | "PUT";
  body?: unknown;
  signal?: AbortSignal;
};
const teaHint = "Install tea 0.15.1 or newer and sign in with `tea login add`.";
const teaCandidates = ["tea", "/usr/local/bin/tea", "/opt/homebrew/bin/tea"];
const teaTimeoutMs = 15_000;
const maxConcurrentTea = 8;
const pageSize = 50;
const maxPages = 10;
const maxListRepositories = 50;

function cleanBaseUrl(raw: string): URL {
  const url = new URL(raw);
  if (
    url.protocol !== "https:" &&
    url.hostname !== "localhost" &&
    url.hostname !== "127.0.0.1"
  )
    throw new Error(
      "Gitea URL must use HTTPS (HTTP is allowed only for localhost). ",
    );
  url.search = "";
  url.hash = "";
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/`;
  return url;
}

function sameInstance(raw: string, base: URL): boolean {
  try {
    const url = new URL(raw);
    return (
      url.origin === base.origin &&
      url.pathname.replace(/\/+$/, "") === base.pathname.replace(/\/+$/, "")
    );
  } catch {
    return false;
  }
}

class TeaProcessError extends Error {
  readonly missingLogin: boolean;
  readonly interrupted: boolean;
  constructor(error: ExecFileException, stderr: string) {
    super("tea exited unsuccessfully.");
    this.missingLogin = /login name '.*' does not exist/.test(stderr);
    this.interrupted = error.killed === true || error.signal != null;
  }
}

function safeLink(base: URL, value: unknown): string {
  if (typeof value !== "string") return "";
  try {
    const url = new URL(value, base);
    return url.origin === base.origin ? url.href : "";
  } catch {
    return "";
  }
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Gitea returned an invalid response.");
  return value as Record<string, unknown>;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}
function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .map((entry) =>
          typeof entry === "string" ? entry : text(record(entry).name),
        )
        .filter(Boolean)
    : [];
}
function mapItem(
  repo: string,
  value: unknown,
  kind: "issue" | "pr",
  base: URL,
) {
  const row = record(value);
  const user = row.user && typeof row.user === "object" ? record(row.user) : {};
  return itemSchema.parse({
    repo,
    number: row.number,
    kind,
    title: text(row.title),
    state: text(row.state),
    author: text(user.login),
    labels: strings(row.labels),
    assignees: Array.isArray(row.assignees)
      ? row.assignees.map((entry) => text(record(entry).login)).filter(Boolean)
      : [],
    url: safeLink(base, row.html_url ?? row.url),
    body: text(row.body),
    updatedAt: text(row.updated_at),
  });
}

function repositoryFromRemote(raw: string, base: URL): string | null {
  let transport: "https" | "ssh";
  let host: string;
  let port: string | null = null;
  let pathname: string;
  try {
    if (/^[^/\s@]+@[^:/\s]+:.+/.test(raw)) {
      const match = raw.match(/^[^/\s@]+@([^:/\s]+):(.+)$/);
      if (!match) return null;
      transport = "ssh";
      host = match[1]!.toLowerCase();
      pathname = match[2]!;
    } else {
      const url = new URL(raw);
      if (
        url.protocol === "https:" ||
        (url.protocol === "http:" &&
          (url.hostname === "localhost" || url.hostname === "127.0.0.1"))
      )
        transport = "https";
      else if (url.protocol === "ssh:") transport = "ssh";
      else return null;
      host = url.hostname.toLowerCase();
      port = url.port || null;
      pathname = url.pathname.replace(/^\//, "");
    }
  } catch {
    return null;
  }
  if (host !== base.hostname.toLowerCase()) return null;
  if (
    transport === "https" &&
    (new URL(raw).protocol !== base.protocol ||
      (new URL(raw).port || null) !== (base.port || null))
  )
    return null;
  const prefix = base.pathname.replace(/^\//, "").replace(/\/$/, "");
  if (prefix) {
    if (!pathname.startsWith(`${prefix}/`)) return null;
    pathname = pathname.slice(prefix.length + 1);
  }
  const parts = pathname.replace(/\/$/, "").split("/");
  if (parts.length !== 2) return null;
  const repo = parts[1]!.replace(/\.git$/i, "");
  const candidate = `${parts[0]}/${repo}`;
  return repositorySchema.safeParse(candidate).success ? candidate : null;
}

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    baseUrl: {
      type: "string",
      label: "Gitea instance URL",
      default: "https://gitea.com",
    },
    teaProfile: {
      type: "string",
      label: "tea login profile (optional; auto-detected when unique)",
      default: "",
    },
    extraRepos: {
      type: "string",
      label: "Additional repositories (owner/repo, comma separated)",
      default: "",
    },
  });
  let config = await settings.get();
  let loginLookup: Promise<string> | null = null;
  settings.onChange((next) => {
    config = next;
    loginLookup = null;
  });
  let teaPath: string | null = null;
  let activeTea = 0;
  type TeaWaiter = {
    signal?: AbortSignal;
    resolve: () => void;
    reject: (reason: unknown) => void;
    settled: boolean;
    onAbort?: () => void;
  };
  const teaQueue: TeaWaiter[] = [];

  function releaseTeaSlot() {
    while (teaQueue.length > 0) {
      const waiter = teaQueue.shift()!;
      if (waiter.settled) continue;
      waiter.settled = true;
      if (waiter.onAbort)
        waiter.signal?.removeEventListener("abort", waiter.onAbort);
      waiter.resolve();
      return;
    }
    activeTea -= 1;
  }

  async function acquireTeaSlot(signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (activeTea < maxConcurrentTea) {
      activeTea += 1;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const waiter: TeaWaiter = { signal, resolve, reject, settled: false };
      waiter.onAbort = () => {
        if (waiter.settled) return;
        waiter.settled = true;
        const index = teaQueue.indexOf(waiter);
        if (index !== -1) teaQueue.splice(index, 1);
        reject(signal?.reason);
      };
      teaQueue.push(waiter);
      signal?.addEventListener("abort", waiter.onAbort, { once: true });
      if (signal?.aborted) waiter.onAbort();
    });
  }

  async function runTea(
    file: string,
    args: string[],
    options: { input?: string; timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<{ stdout: string; stderr: string }> {
    let acquired = false;
    try {
      await acquireTeaSlot(options.signal);
      acquired = true;
      options.signal?.throwIfAborted();
      return await new Promise((resolve, reject) => {
        const child = execFile(
          file,
          args,
          {
            cwd: tmpdir(),
            timeout: options.timeoutMs ?? teaTimeoutMs,
            maxBuffer: 16 * 1024 * 1024,
            ...(options.signal ? { signal: options.signal } : {}),
          },
          (error, stdout, stderr) => {
            if (!error) resolve({ stdout, stderr });
            else if (options.signal?.aborted) reject(options.signal.reason);
            else reject(new TeaProcessError(error, stderr));
          },
        );
        child.stdin?.on("error", () => {});
        child.stdin?.end(options.input ?? "");
      });
    } finally {
      if (acquired) releaseTeaSlot();
    }
  }

  async function resolveTea(signal?: AbortSignal): Promise<string> {
    if (teaPath) return teaPath;
    for (const candidate of teaCandidates) {
      try {
        await runTea(candidate, ["--version"], { timeoutMs: 5_000, signal });
        teaPath = candidate;
        return candidate;
      } catch (error) {
        if (signal?.aborted) throw error;
      }
    }
    throw new Error(`Gitea CLI tea was not found. ${teaHint}`);
  }

  async function findLogin(): Promise<string> {
    const base = cleanBaseUrl(config.baseUrl);
    const file = await resolveTea();
    let rows: unknown;
    try {
      const { stdout } = await runTea(
        file,
        ["logins", "list", "--output", "json"],
        { timeoutMs: 5_000 },
      );
      rows = JSON.parse(stdout);
    } catch {
      throw new Error(
        "Could not read tea login profiles. Run `tea logins list` to check tea's configuration.",
      );
    }
    if (!Array.isArray(rows))
      throw new Error("tea returned invalid login profile metadata.");
    const logins = rows.flatMap((row) => {
      if (typeof row !== "object" || row === null) return [];
      const { name, url, user } = row as Record<string, unknown>;
      return typeof name === "string" &&
        typeof url === "string" &&
        typeof user === "string"
        ? [{ name, url, user }]
        : [];
    });
    const matching = logins.filter((login) => sameInstance(login.url, base));
    const profile = config.teaProfile.trim();
    if (profile) {
      const selected = logins.find((login) => login.name === profile);
      if (!selected)
        throw new Error(
          `tea login profile "${profile}" was not found. ${teaHint}`,
        );
      if (!matching.includes(selected))
        throw new Error(
          `tea login profile "${profile}" belongs to a different Gitea instance than ${base.href}.`,
        );
      return selected.name;
    }
    if (!matching.length)
      throw new Error(`No tea login profile matches ${base.href}. ${teaHint}`);
    if (new Set(matching.map((login) => login.user.toLowerCase())).size > 1)
      throw new Error(
        `Several tea login profiles for ${base.href} belong to different users. Set the tea login profile in Gitea plugin settings.`,
      );
    return matching.map((login) => login.name).sort()[0]!;
  }

  function teaLogin(): Promise<string> {
    if (!loginLookup) {
      const lookup = findLogin();
      loginLookup = lookup;
      lookup.catch(() => {
        if (loginLookup === lookup) loginLookup = null;
      });
    }
    return loginLookup;
  }

  async function api(path: string, request: ApiRequest = {}): Promise<unknown> {
    const base = cleanBaseUrl(config.baseUrl);
    const { signal } = request;
    signal?.throwIfAborted();
    const login = await teaLogin();
    const file = await resolveTea(signal);
    const args = [
      "api",
      "--login",
      login,
      "--method",
      request.method ?? "GET",
      "--include",
    ];
    if (request.body !== undefined) args.push("--data", "@-");
    args.push(`/api/v1/${path.replace(/^\/+/, "")}`);
    let output: { stdout: string; stderr: string };
    try {
      output = await runTea(file, args, {
        signal,
        ...(request.body === undefined
          ? {}
          : { input: JSON.stringify(request.body) }),
      });
    } catch (error) {
      if (signal?.aborted || !(error instanceof TeaProcessError)) throw error;
      if (error.missingLogin) {
        loginLookup = null;
        throw new Error(
          `tea login profile "${login}" is no longer available. ${teaHint}`,
        );
      }
      throw new Error(
        error.interrupted
          ? "The tea request to Gitea timed out. Try again later."
          : "The tea request to Gitea failed. Check network access and server availability, then try again.",
      );
    }
    const status = Number(
      output.stderr.match(/^HTTP\/[\d.]+ (\d{3})\b/m)?.[1] ?? Number.NaN,
    );
    if (!Number.isInteger(status))
      throw new Error("tea did not report the Gitea response status.");
    if (status === 401)
      throw new Error(
        `Gitea rejected tea login profile "${login}". Sign in again with \`tea login add\`.`,
      );
    if (status < 200 || status >= 300)
      throw new Error(`Gitea API returned HTTP ${status}.`);
    if (!output.stdout.trim()) return null;
    try {
      return JSON.parse(output.stdout) as unknown;
    } catch {
      throw new Error("tea returned invalid JSON from Gitea.");
    }
  }
  async function repos(): Promise<Repo[]> {
    const found = new Map<string, Repo>();
    const base = cleanBaseUrl(config.baseUrl);
    try {
      const projects = await bb.sdk.projects.list();
      for (const project of projects)
        for (const source of project.sources ?? []) {
          if (source.type !== "local_path") continue;
          try {
            const { stdout } = await execFileAsync(
              "git",
              ["-C", source.path, "remote", "get-url", "origin"],
              { timeout: 5000, maxBuffer: 4096 },
            );
            const repo = repositoryFromRemote(stdout.trim(), base);
            if (repo && !found.has(repo.toLowerCase()))
              found.set(repo.toLowerCase(), { repo, projectId: project.id });
          } catch {}
        }
    } catch {}
    for (const repo of config.extraRepos
      .split(/[\s,]+/)
      .filter((value) => /^[\w.-]+\/[\w.-]+$/.test(value))) {
      if (!found.has(repo.toLowerCase()))
        found.set(repo.toLowerCase(), { repo, projectId: null });
    }
    return [...found.values()];
  }
  function repoPath(repo: string, suffix: string): string {
    const parsed = repositorySchema
      .parse(repo)
      .split("/")
      .map(encodeURIComponent);
    return `repos/${parsed[0]}/${parsed[1]}/${suffix}`;
  }
  async function paginated(
    path: string,
    signal: AbortSignal | undefined,
    pageLimit = maxPages,
  ): Promise<{ values: unknown[]; truncated: boolean }> {
    const values: unknown[] = [];
    for (let page = 1; page <= pageLimit; page += 1) {
      const query = new URLSearchParams({
        limit: String(pageSize),
        page: String(page),
      });
      const response = await api(
        `${path}${path.includes("?") ? "&" : "?"}${query}`,
        { signal },
      );
      if (!Array.isArray(response))
        throw new Error("Gitea returned an invalid paginated response.");
      values.push(...response);
      if (response.length < pageSize) return { values, truncated: false };
    }
    return { values, truncated: true };
  }
  async function listItems(
    kind: "issue" | "pr",
    repo: string | undefined,
    state: "open" | "closed" | "all",
    query: string,
    signal?: AbortSignal,
  ) {
    const discovered = repo ? [{ repo, projectId: null }] : await repos();
    const candidates = discovered.slice(0, maxListRepositories);
    const settled = await Promise.allSettled(
      candidates.map(async ({ repo: name }) => {
        const endpointPath = repoPath(
          name,
          `issues?${new URLSearchParams({ state, type: kind === "pr" ? "pulls" : "issues" })}`,
        );
        return { repo: name, page: await paginated(endpointPath, signal) };
      }),
    );
    const result: Array<z.infer<typeof itemSchema>> = [];
    const errors: Array<{ repo: string; message: string }> = [];
    let truncated = discovered.length > candidates.length;
    for (let index = 0; index < settled.length; index += 1) {
      const outcome = settled[index]!;
      const name = candidates[index]!.repo;
      if (outcome.status === "rejected") {
        errors.push({
          repo: name,
          message:
            outcome.reason instanceof Error
              ? outcome.reason.message
              : "Could not read repository.",
        });
        continue;
      }
      truncated ||= outcome.value.page.truncated;
      result.push(
        ...outcome.value.page.values
          .filter((value) =>
            kind === "pr"
              ? Boolean(record(value).pull_request)
              : !record(value).pull_request,
          )
          .map((value) =>
            mapItem(name, value, kind, cleanBaseUrl(config.baseUrl)),
          ),
      );
    }
    const term = query.trim().toLowerCase();
    return listOutputSchema.parse({
      items: result
        .filter(
          (item) =>
            !term ||
            `${item.title} ${item.body} ${item.repo} ${item.author}`
              .toLowerCase()
              .includes(term),
        )
        .slice(0, 200),
      truncated: truncated || result.length > 200,
      errors,
    });
  }
  const handlers = {
    status: async (
      _input,
      { experimental_signal: signal }: RpcContext = {},
    ) => {
      const discovered = await repos();
      try {
        const user = record(await api("user", { signal }));
        return {
          ready: true,
          error: null,
          login: text(user.login) || null,
          repos: discovered,
        };
      } catch (error) {
        return {
          ready: false,
          error:
            error instanceof Error
              ? error.message
              : "Could not authenticate to Gitea.",
          login: null,
          repos: discovered,
        };
      }
    },
    listItems: async (
      { kind, repo, state, query },
      { experimental_signal: signal }: RpcContext = {},
    ) => await listItems(kind, repo, state, query, signal),
    detail: async (
      { repo, number, kind },
      { experimental_signal: signal }: RpcContext = {},
    ) => {
      const base = cleanBaseUrl(config.baseUrl);
      const issueValue = await api(repoPath(repo, `issues/${number}`), {
        signal,
      });
      const item = mapItem(repo, issueValue, kind, base);
      const commentPage = await paginated(
        repoPath(repo, `issues/${number}/comments`),
        signal,
      );
      const comments = commentPage.values.map((raw) => {
        const value = record(raw);
        const user = record(value.user);
        return commentSchema.parse({
          author: text(user.login),
          body: text(value.body),
          createdAt: text(value.created_at),
        });
      });
      let files: Array<{
        path: string;
        status: string;
        additions: number;
        deletions: number;
        patch: string | null;
      }> = [];
      let filesTruncated = false,
        reviewsTruncated = false;
      let headRefName = "",
        baseRefName = "",
        checksTruncated = false,
        checks: Array<{
          name: string;
          status: "success" | "failure" | "pending" | "neutral";
          url: string;
        }> = [],
        reviews: Array<{
          author: string;
          state: string;
          body: string;
          createdAt: string;
        }> = [];
      if (kind === "pr") {
        const [pr, filePage, reviewPage] = await Promise.all([
          api(repoPath(repo, `pulls/${number}`), { signal }),
          paginated(repoPath(repo, `pulls/${number}/files`), signal, 2),
          paginated(repoPath(repo, `pulls/${number}/reviews`), signal),
        ]);
        const pull = record(pr),
          head = record(pull.head),
          baseInfo = record(pull.base);
        headRefName = text(head.ref);
        baseRefName = text(baseInfo.ref);
        filesTruncated = filePage.truncated;
        reviewsTruncated = reviewPage.truncated;
        files = filePage.values.map((entry) => {
          const f = record(entry);
          return {
            path: text(f.filename),
            status: text(f.status),
            additions: Number(f.additions) || 0,
            deletions: Number(f.deletions) || 0,
            patch: text(f.patch) || null,
          };
        });
        reviews = reviewPage.values.map((entry) => {
          const r = record(entry);
          return {
            author: text(record(r.user).login),
            state: text(r.state),
            body: text(r.body),
            createdAt: text(r.submitted_at),
          };
        });
        const statuses = await paginated(
          repoPath(repo, `statuses/${encodeURIComponent(text(head.sha))}`),
          signal,
          2,
        ).catch(() => ({ values: [], truncated: false }));
        checksTruncated = statuses.truncated;
        checks = statuses.values.slice(0, 100).map((entry) => {
          const s = record(entry);
          const state = text(s.status);
          return {
            name: text(s.context),
            status:
              state === "success"
                ? ("success" as const)
                : state === "failure" || state === "error"
                  ? ("failure" as const)
                  : state === "pending"
                    ? ("pending" as const)
                    : ("neutral" as const),
            url: safeLink(base, s.target_url),
          };
        });
      }
      const threadId = await bb.storage.kv.get<string>(
        `thread:${repo}:${number}`,
      );
      return detailSchema.parse({
        ...item,
        comments,
        commentsTruncated: commentPage.truncated,
        files,
        filesTruncated,
        checks,
        checksTruncated,
        reviews,
        reviewsTruncated,
        headRefName,
        baseRefName,
        threadId: threadId ?? null,
      });
    },
    createIssue: async (
      { repo, title, body },
      { experimental_signal: signal }: RpcContext = {},
    ) =>
      mapItem(
        repo,
        await api(repoPath(repo, "issues"), {
          method: "POST",
          body: { title, body },
          signal,
        }),
        "issue",
        cleanBaseUrl(config.baseUrl),
      ),
    comment: async (
      { repo, number, body },
      { experimental_signal: signal }: RpcContext = {},
    ) => {
      await api(repoPath(repo, `issues/${number}/comments`), {
        method: "POST",
        body: { body },
        signal,
      });
      return { ok: true as const };
    },
    setState: async (
      { repo, number, state },
      { experimental_signal: signal }: RpcContext = {},
    ) => {
      await api(repoPath(repo, `issues/${number}`), {
        method: "PATCH",
        body: { state },
        signal,
      });
      return { ok: true as const };
    },
    updateMetadata: async (
      { repo, number, labels, assignees },
      { experimental_signal: signal }: RpcContext = {},
    ) => {
      await Promise.all([
        api(repoPath(repo, `issues/${number}/labels`), {
          method: "PUT",
          body: { labels },
          signal,
        }),
        api(repoPath(repo, `issues/${number}`), {
          method: "PATCH",
          body: { assignees },
          signal,
        }),
      ]);
      return { ok: true as const };
    },
    review: async (
      { repo, number, event, body },
      { experimental_signal: signal }: RpcContext = {},
    ) => {
      await api(repoPath(repo, `pulls/${number}/reviews`), {
        method: "POST",
        body: { event, body },
        signal,
      });
      return { ok: true as const };
    },
    sendAgent: async (
      { repo, number, kind },
      { experimental_signal: signal }: RpcContext = {},
    ) => {
      const known = (await repos()).find(
        (entry) => entry.repo.toLowerCase() === repo.toLowerCase(),
      );
      if (!known?.projectId)
        throw new Error(
          `No BB project is associated with ${repo}. Attach a project checkout or use another repository.`,
        );
      const item = mapItem(
        repo,
        await api(repoPath(repo, `issues/${number}`), { signal }),
        kind,
        cleanBaseUrl(config.baseUrl),
      );
      const ref = `${repo}#${number}`;
      const instructions =
        kind === "issue"
          ? `Read the Gitea issue ${ref}, inspect its comments, and work on the requested change in the project checkout. Do not post or mutate Gitea unless asked.`
          : `Review Gitea pull request ${ref} and its changed files for correctness, missing tests, and design issues. Report findings with file and line references. Do not post or mutate Gitea unless asked.`;
      const [commentPage, filePage] = await Promise.all([
        paginated(repoPath(repo, `issues/${number}/comments`), signal),
        kind === "pr"
          ? paginated(repoPath(repo, `pulls/${number}/files`), signal, 2)
          : Promise.resolve({ values: [], truncated: false }),
      ]);
      const comments = commentPage.values.slice(-10).map((value) => {
        const comment = record(value);
        return `${text(record(comment.user).login)}: ${text(comment.body).slice(0, 2000)}`;
      });
      const files = filePage.values.slice(0, 10).map((value) => {
        const file = record(value);
        return `${text(file.filename)}\n${text(file.patch).slice(0, 3000)}`;
      });
      const context = [
        instructions,
        `Title: ${item.title}`,
        `State: ${item.state}`,
        `URL: ${item.url}`,
        "",
        item.body.slice(0, 16000),
        comments.length ? `\nRecent comments:\n${comments.join("\n\n")}` : "",
        files.length ? `\nChanged files:\n${files.join("\n\n")}` : "",
      ]
        .join("\n")
        .slice(0, 60000);
      const thread = await bb.sdk.threads.spawn({
        projectId: known.projectId,
        environment: { type: "project-default" },
        title: `${ref}: ${item.title}`.slice(0, 120),
        prompt: context,
      });
      await bb.storage.kv.set(`thread:${repo}:${number}`, thread.id);
      await bb.storage.kv.set(`thread-link:${thread.id}`, {
        repo,
        number,
        kind,
      });
      return { threadId: thread.id };
    },
    threadItem: async ({ threadId }) =>
      (await bb.storage.kv.get(`thread-link:${threadId}`)) ?? null,
    refresh: async () => ({ repos: (await repos()).length, items: 0 }),
  } satisfies PluginRpcHandlers<typeof giteaRpcContract>;
  bb.rpc.register(giteaRpcContract, handlers);
  async function mentionItems(kind: "issue" | "pr", query: string) {
    return (await listItems(kind, undefined, "open", query)).items
      .slice(0, 8)
      .map((item) => ({
        id: `${item.repo}#${item.number}`,
        title: `#${item.number} ${item.title}`,
        subtitle: item.repo,
      }));
  }
  async function mentionContext(kind: "issue" | "pr", itemId: string) {
    const match = itemId.match(/^([\w.-]+\/[\w.-]+)#([1-9]\d*)$/);
    if (!match)
      throw new Error("Expected a Gitea reference in owner/repo#number form.");
    const repo = repositorySchema.parse(match[1]);
    const number = Number(match[2]);
    const item = mapItem(
      repo,
      await api(repoPath(repo, `issues/${number}`)),
      kind,
      cleanBaseUrl(config.baseUrl),
    );
    const noun = kind === "pr" ? "pull request" : "issue";
    return {
      context: [
        `# Gitea ${noun} ${repo}#${number}: ${item.title}`,
        "",
        `State: ${item.state} · Author: ${item.author}`,
        `URL: ${item.url}`,
        "",
        item.body.slice(0, 16000) || "(no description)",
        "",
        `Use the Gitea panel or bb gitea ${kind === "pr" ? "prs" : "issues"} ${repo} for more details.`,
      ].join("\n"),
    };
  }
  bb.ui.registerMentionProvider({
    id: "issue",
    label: "Gitea issues",
    triggers: ["@", "#"],
    search({ query }) {
      return mentionItems("issue", query);
    },
    resolve(itemId) {
      return mentionContext("issue", itemId);
    },
  });
  bb.ui.registerMentionProvider({
    id: "pr",
    label: "Gitea pull requests",
    triggers: ["@", "#"],
    search({ query }) {
      return mentionItems("pr", query);
    },
    resolve(itemId) {
      return mentionContext("pr", itemId);
    },
  });
  bb.cli.register({
    name: "gitea",
    summary: "Browse and update Gitea issues and pull requests",
    commands: [
      {
        name: "status",
        summary: "Show Gitea connection and tracked repositories",
        usage: "bb gitea status [--json]",
      },
      {
        name: "repos",
        summary: "List tracked Gitea repositories",
        usage: "bb gitea repos [--json]",
      },
      {
        name: "issues",
        summary: "List repository issues",
        usage:
          "bb gitea issues [owner/repo] [--state open|closed|all] [--query text] [--json]",
      },
      {
        name: "prs",
        summary: "List pull requests",
        usage:
          "bb gitea prs [owner/repo] [--state open|closed|all] [--query text] [--json]",
      },
      {
        name: "show",
        summary: "Read issue or pull request details",
        usage: "bb gitea show <issue|pr> <owner/repo> <number> [--json]",
      },
      {
        name: "create-issue",
        summary: "Create an issue",
        usage: "bb gitea create-issue <owner/repo> <title> [--body text]",
      },
      {
        name: "comment",
        summary: "Add an issue or pull request comment",
        usage: "bb gitea comment <owner/repo> <number> <body>",
      },
      {
        name: "set-state",
        summary: "Open or close an issue or pull request",
        usage: "bb gitea set-state <owner/repo> <number> <open|closed>",
      },
      {
        name: "metadata",
        summary: "Replace labels and assignees",
        usage:
          "bb gitea metadata <owner/repo> <number> <labels-csv> <assignees-csv>",
      },
      {
        name: "review",
        summary: "Submit a pull request review",
        usage:
          "bb gitea review <owner/repo> <number> <APPROVED|REQUEST_CHANGES|COMMENT> [body]",
      },
      {
        name: "send-agent",
        summary: "Start a BB agent thread for an item",
        usage: "bb gitea send-agent <issue|pr> <owner/repo> <number>",
      },
      {
        name: "thread",
        summary: "Read the Gitea item linked to a BB thread",
        usage: "bb gitea thread <thread-id> [--json]",
      },
      {
        name: "refresh",
        summary: "Refresh repository availability",
        usage: "bb gitea refresh [--json]",
      },
    ],
    async run(argv) {
      const args = [...argv];
      const json = args.includes("--json");
      const stateIndex = args.indexOf("--state"),
        queryIndex = args.indexOf("--query"),
        bodyIndex = args.indexOf("--body");
      const state = stateIndex >= 0 ? args[stateIndex + 1] : "open";
      const query = queryIndex >= 0 ? args[queryIndex + 1] : "";
      const bodyOption = bodyIndex >= 0 ? args[bodyIndex + 1] : "";
      for (const index of [stateIndex, queryIndex, bodyIndex]
        .filter((value) => value >= 0)
        .sort((a, b) => b - a))
        args.splice(index, 2);
      const positional = args.filter((value) => value !== "--json");
      const [command, ...values] = positional;
      const succeed = (value: unknown, human: string) => ({
        exitCode: 0,
        stdout: json ? JSON.stringify(value) : human,
      });
      try {
        if (command === "status") {
          const value = await handlers.status(null);
          return succeed(
            value,
            `${value.ready ? `Connected as ${value.login ?? "user"}` : (value.error ?? "Not connected")}\n${value.repos.map((entry) => entry.repo).join("\n")}`,
          );
        }
        if (command === "repos") {
          const value = await handlers.status(null);
          return succeed(
            value.repos,
            value.repos.map((entry) => entry.repo).join("\n"),
          );
        }
        if (command === "issues" || command === "prs") {
          const input = giteaRpcContract.listItems.input.parse({
            kind: command === "prs" ? "pr" : "issue",
            ...(values[0] ? { repo: values[0] } : {}),
            state,
            query,
          });
          const value = await handlers.listItems(input);
          return succeed(
            value,
            `${value.items.map((entry) => `${entry.repo}#${entry.number} ${entry.state} ${entry.title}`).join("\n")}${value.truncated ? "\nResults are capped; narrow the repository or query." : ""}${value.errors.map((entry) => `\n${entry.repo}: ${entry.message}`).join("")}`,
          );
        }
        if (command === "show") {
          const input = giteaRpcContract.detail.input.parse({
            kind: values[0],
            repo: values[1],
            number: Number(values[2]),
          });
          const value = await handlers.detail(input);
          return succeed(
            value,
            `${value.repo}#${value.number} ${value.title}\n${value.state} · ${value.author}\n\n${value.body}`,
          );
        }
        if (command === "create-issue") {
          const input = giteaRpcContract.createIssue.input.parse({
            repo: values[0],
            title: values.slice(1).join(" "),
            body: bodyOption,
          });
          const value = await handlers.createIssue(input);
          return succeed(
            value,
            `Created ${value.repo}#${value.number} ${value.title}`,
          );
        }
        if (command === "comment") {
          const input = giteaRpcContract.comment.input.parse({
            repo: values[0],
            number: Number(values[1]),
            body: values.slice(2).join(" "),
          });
          const value = await handlers.comment(input);
          return succeed(
            value,
            `Comment added to ${input.repo}#${input.number}`,
          );
        }
        if (command === "set-state") {
          const input = giteaRpcContract.setState.input.parse({
            repo: values[0],
            number: Number(values[1]),
            state: values[2],
          });
          const value = await handlers.setState(input);
          return succeed(
            value,
            `${input.repo}#${input.number} is ${input.state}`,
          );
        }
        if (command === "metadata") {
          const input = giteaRpcContract.updateMetadata.input.parse({
            repo: values[0],
            number: Number(values[1]),
            labels: (values[2] ?? "").split(",").filter(Boolean),
            assignees: (values[3] ?? "").split(",").filter(Boolean),
          });
          const value = await handlers.updateMetadata(input);
          return succeed(
            value,
            `Updated metadata on ${input.repo}#${input.number}`,
          );
        }
        if (command === "review") {
          const input = giteaRpcContract.review.input.parse({
            repo: values[0],
            number: Number(values[1]),
            event: values[2],
            body: values.slice(3).join(" "),
          });
          const value = await handlers.review(input);
          return succeed(
            value,
            `Review submitted for ${input.repo}#${input.number}`,
          );
        }
        if (command === "send-agent") {
          const input = giteaRpcContract.sendAgent.input.parse({
            kind: values[0],
            repo: values[1],
            number: Number(values[2]),
          });
          const value = await handlers.sendAgent(input);
          return succeed(value, `Started BB thread ${value.threadId}`);
        }
        if (command === "thread") {
          const input = giteaRpcContract.threadItem.input.parse({
            threadId: values[0],
          });
          const value = await handlers.threadItem(input);
          return succeed(
            value,
            value
              ? `${value.repo}#${value.number} ${value.kind}`
              : "No Gitea item linked.",
          );
        }
        if (command === "refresh") {
          const value = await handlers.refresh();
          return succeed(value, `Tracked ${value.repos} repositories.\n`);
        }
        return {
          exitCode: 1,
          stderr: "Run `bb gitea --help` for supported commands.",
        };
      } catch (error) {
        return {
          exitCode: 1,
          stderr:
            error instanceof Error ? error.message : "Gitea request failed.",
        };
      }
    },
  });
}
