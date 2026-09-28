import {
  defineRpcContract,
  type BbPluginApi,
  type PluginRpcHandlers,
} from "@get-bb/plugin-sdk";
import { z } from "zod";
import { execFile, type ExecFileException } from "node:child_process";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import {
  DisplayCache,
  type Display,
  type FailureScope,
  type FreshnessPolicy,
} from "./display-cache.js";
import {
  assignFileDiffs,
  fileDiffSchema,
  parseRevision,
  sameRevision,
  type FileDiff,
  type PullRevision,
  type RawPullDiff,
} from "./pull-diff.js";
import {
  activePolicy,
  applyAutomationPatch,
  automationOptions,
  automationPatchSchema,
  autoStartTargets,
  babysitExecutionSchema,
  babysitPreferencesSchema,
  babysitSessionViewSchema,
  babysitView,
  babysitViewSchema,
  buildBabysitterPrompt,
  confirmedTerminal,
  decideAutomation,
  decideRetry,
  decideStart,
  decideStop,
  giteaBabysitterTitlePrefix,
  onArchived,
  onCleanupFailed,
  onFailed,
  onIdle,
  parseLifecycle,
  parseStoredPreferences,
  parseStoredSession,
  pullKey,
  sameSession,
  sessionView,
  setsAutomationOption,
  startError,
  stopped,
  watching,
  type AutomationPatch,
  type BabysitPolicy,
  type BabysitPreferences,
  type BabysitSession,
  type LifecycleFact,
  type ResumableSession,
} from "./babysitter.js";
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
type ListItem = z.infer<typeof itemSchema>;
type ItemPage = z.infer<typeof listOutputSchema> & { reachable: number };
const commentSchema = z.object({
  author: z.string(),
  body: z.string(),
  createdAt: z.string(),
});
const fileSchema = z.object({
  path: z.string(),
  status: z.string(),
  previousPath: z.string().nullable(),
  additions: z.number(),
  deletions: z.number(),
  diff: fileDiffSchema,
});
const checkSchema = z.object({
  name: z.string(),
  status: z.enum(["success", "failure", "pending", "neutral"]),
  url: z.string(),
});
const reviewSchema = z.object({
  author: z.string(),
  state: z.string(),
  body: z.string(),
  createdAt: z.string(),
});
const revisionSchema = z.object({ head: z.string(), base: z.string() });
const detailSchema = itemSchema.extend({
  comments: z.array(commentSchema),
  commentsTruncated: z.boolean(),
  files: z.array(fileSchema),
  checksTruncated: z.boolean(),
  checks: z.array(checkSchema),
  reviews: z.array(reviewSchema),
  filesTruncated: z.boolean(),
  reviewsTruncated: z.boolean(),
  headRefName: z.string(),
  baseRefName: z.string(),
  threadId: z.string().nullable(),
});
const conversationBase = itemSchema.omit({ kind: true }).extend({
  comments: z.array(commentSchema),
  commentsTruncated: z.boolean(),
});
const conversationSchema = z.discriminatedUnion("kind", [
  conversationBase.extend({ kind: z.literal("issue") }),
  conversationBase.extend({
    kind: z.literal("pr"),
    headRefName: z.string(),
    baseRefName: z.string(),
    revision: revisionSchema,
    changedFiles: z.number().int().nonnegative().nullable(),
    checks: z.array(checkSchema),
    checksTruncated: z.boolean(),
    reviews: z.array(reviewSchema),
    reviewsTruncated: z.boolean(),
  }),
]);
const pullFilesSchema = z.object({
  revision: revisionSchema,
  files: z.array(fileSchema),
  filesTruncated: z.boolean(),
  stale: z.boolean(),
});
const freshnessSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("fresh"), fetchedAt: z.string() }),
  z.object({ state: z.literal("refreshing"), fetchedAt: z.string() }),
  z.object({
    state: z.literal("stale-error"),
    fetchedAt: z.string(),
    error: z.string(),
  }),
]);
type Conversation = z.infer<typeof conversationSchema>;
type PullFiles = z.infer<typeof pullFilesSchema>;
type FileView = z.infer<typeof fileSchema>;
type Check = z.infer<typeof checkSchema>;
const okSchema = z.object({ ok: z.literal(true) });
const pullRefSchema = z.object({
  repo: repositorySchema,
  number: z.number().int().positive(),
});
const threadIdSchema = z.object({ threadId: z.string().min(1) });

export const giteaRpcContract = defineRpcContract({
  status: {
    input: z.null(),
    output: z.object({
      ready: z.boolean(),
      error: z.string().nullable(),
      login: z.string().nullable(),
      account: z.string().nullable(),
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
      refresh: z.boolean().default(false),
    }),
    output: listOutputSchema.extend({
      account: z.string(),
      freshness: freshnessSchema,
    }),
  },
  detail: {
    input: z.object({
      repo: repositorySchema,
      number: z.number().int().positive(),
      kind: z.enum(["issue", "pr"]),
    }),
    output: detailSchema,
  },
  conversation: {
    input: z.object({
      repo: repositorySchema,
      number: z.number().int().positive(),
      kind: z.enum(["issue", "pr"]),
      refresh: z.boolean().default(false),
    }),
    output: z.object({
      freshness: freshnessSchema,
      conversation: conversationSchema,
      threadId: z.string().nullable(),
    }),
  },
  pullFiles: {
    input: z.object({
      repo: repositorySchema,
      number: z.number().int().positive(),
      revision: revisionSchema.nullable().default(null),
      refresh: z.boolean().default(false),
    }),
    output: pullFilesSchema.extend({ freshness: freshnessSchema }),
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
  listMyPullRequests: {
    input: z.object({
      repo: repositorySchema.optional(),
      state: z.enum(["open", "closed", "all"]).default("open"),
      query: z.string().max(200).default(""),
      refresh: z.boolean().default(false),
    }),
    output: listOutputSchema.extend({
      account: z.string(),
      freshness: freshnessSchema,
      login: z.string(),
      items: z.array(itemSchema.extend({ babysit: babysitViewSchema })),
      preferences: babysitPreferencesSchema,
    }),
  },
  setAutomation: {
    input: pullRefSchema
      .extend(automationOptions)
      .strict()
      .refine(...setsAutomationOption),
    output: babysitViewSchema,
  },
  retryBabysit: { input: pullRefSchema, output: threadIdSchema },
  getBabysitStatus: { input: pullRefSchema, output: babysitViewSchema },
  babysitThread: {
    input: threadIdSchema,
    output: babysitSessionViewSchema.nullable(),
  },
  listBabysitSessions: {
    input: z.null(),
    output: z.object({ sessions: z.array(babysitSessionViewSchema) }),
  },
  getBabysitPreferences: { input: z.null(), output: babysitPreferencesSchema },
  setAutoAutomation: {
    input: automationPatchSchema,
    output: babysitPreferencesSchema,
  },
  setBabysitExecution: {
    input: babysitExecutionSchema,
    output: babysitPreferencesSchema,
  },
});

type Repo = { repo: string; projectId: string | null };
type TeaLogin = { name: string; user: string };
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
const conversationPolicy: FreshnessPolicy = {
  freshMs: 15_000,
  retainMs: 10 * 60_000,
  retryMs: 30_000,
};
const listPolicy: FreshnessPolicy = {
  freshMs: 15_000,
  retainMs: 10 * 60_000,
  retryMs: 30_000,
};
const listTag = "lists";
const filesPolicy: FreshnessPolicy = {
  freshMs: 5 * 60_000,
  retainMs: 30 * 60_000,
  retryMs: 30_000,
};
const mebibyte = 1024 * 1024;

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
  readonly overflow: boolean;
  constructor(error: ExecFileException, stderr: string) {
    super("tea exited unsuccessfully.");
    this.missingLogin = /login name '.*' does not exist/.test(stderr);
    this.overflow = error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
    this.interrupted = error.killed === true || error.signal != null;
  }
}

function displayTag(repo: string, number: number) {
  return `${repo.toLowerCase()}#${number}`;
}

function freshnessView(freshness: Display<unknown>["freshness"]) {
  const fetchedAt = new Date(freshness.fetchedAt).toISOString();
  return freshness.state === "stale-error"
    ? { state: freshness.state, fetchedAt, error: freshness.error }
    : { state: freshness.state, fetchedAt };
}

function pickItems(page: ItemPage, query: string) {
  const term = query.trim().toLowerCase();
  return listOutputSchema.parse({
    items: page.items
      .filter(
        (item) =>
          !term ||
          `${item.title} ${item.body} ${item.repo} ${item.author}`
            .toLowerCase()
            .includes(term),
      )
      .slice(0, 200),
    truncated: page.truncated || page.items.length > 200,
    errors: page.errors,
  });
}

function checkStatus(state: string): Check["status"] {
  if (state === "success") return "success";
  if (state === "failure" || state === "error") return "failure";
  if (state === "pending") return "pending";
  return "neutral";
}

class GiteaAccessError extends Error {
  readonly scope: "account" | "item";
  constructor(message: string, scope: "account" | "item") {
    super(message);
    this.scope = scope;
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
function actor(value: Record<string, unknown>): string {
  for (const nested of [value.user, value.team])
    if (
      typeof nested === "object" &&
      nested !== null &&
      !Array.isArray(nested)
    ) {
      const identity = record(nested);
      const name = text(identity.login) || text(identity.name);
      if (name) return name;
    }
  return "";
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
  let loginLookup: Promise<TeaLogin> | null = null;
  const classifyDisplayFailure = (error: unknown): FailureScope =>
    error instanceof GiteaAccessError ? "drop-entry" : "retain";
  const publishDisplay = (item: string | null) =>
    bb.realtime.publish("display-changed", { item });
  const conversations = new DisplayCache<Conversation>({
    bounds: {
      maxEntries: 64,
      maxBytes: 16 * mebibyte,
      maxEntryBytes: 2 * mebibyte,
    },
    now: Date.now,
    classify: classifyDisplayFailure,
    onBackgroundSettled: publishDisplay,
  });
  const pullFiles = new DisplayCache<PullFiles>({
    bounds: {
      maxEntries: 16,
      maxBytes: 32 * mebibyte,
      maxEntryBytes: 8 * mebibyte,
    },
    now: Date.now,
    classify: classifyDisplayFailure,
    onBackgroundSettled: publishDisplay,
  });
  const listBounds = {
    maxEntries: 32,
    maxBytes: 32 * mebibyte,
    maxEntryBytes: 8 * mebibyte,
  };
  const itemLists = new DisplayCache<ItemPage>({
    bounds: listBounds,
    now: Date.now,
    classify: classifyDisplayFailure,
    onBackgroundSettled: publishDisplay,
  });
  const myPullLists = new DisplayCache<{ login: string; page: ItemPage }>({
    bounds: listBounds,
    now: Date.now,
    classify: classifyDisplayFailure,
    onBackgroundSettled: publishDisplay,
  });
  const displays = [conversations, pullFiles, itemLists, myPullLists];
  function forgetDisplay() {
    const removed = displays.map((cache) => cache.clear());
    if (removed.includes(true)) publishDisplay(null);
  }
  function forgetDisplayItem(repo: string, number: number) {
    const tag = displayTag(repo, number);
    conversations.invalidate(tag);
    pullFiles.invalidate(tag);
    publishDisplay(tag);
  }
  function forgetLists() {
    itemLists.invalidate(listTag);
    myPullLists.invalidate(listTag);
    publishDisplay(listTag);
  }
  bb.onDispose(() => {
    for (const cache of displays) cache.dispose();
  });
  settings.onChange((next) => {
    config = next;
    loginLookup = null;
    for (const cache of displays) cache.clear();
    publishDisplay(null);
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

  async function findLogin(): Promise<TeaLogin> {
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
      return { name: selected.name, user: selected.user };
    }
    if (!matching.length)
      throw new Error(`No tea login profile matches ${base.href}. ${teaHint}`);
    if (new Set(matching.map((login) => login.user.toLowerCase())).size > 1)
      throw new Error(
        `Several tea login profiles for ${base.href} belong to different users. Set the tea login profile in Gitea plugin settings.`,
      );
    const [first] = matching.sort((left, right) =>
      left.name.localeCompare(right.name),
    );
    return { name: first!.name, user: first!.user };
  }

  function teaLogin(): Promise<TeaLogin> {
    if (!loginLookup) {
      const lookup = findLogin();
      loginLookup = lookup;
      lookup.catch(() => {
        if (loginLookup === lookup) loginLookup = null;
      });
    }
    return loginLookup;
  }

  async function teaApi(
    path: string,
    request: ApiRequest,
  ): Promise<{ kind: "body"; body: string } | { kind: "too-large" }> {
    cleanBaseUrl(config.baseUrl);
    const { signal } = request;
    signal?.throwIfAborted();
    const login = (
      await teaLogin().catch((error: unknown) => {
        forgetDisplay();
        throw error;
      })
    ).name;
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
      if (error.overflow) return { kind: "too-large" };
      if (error.missingLogin) {
        loginLookup = null;
        forgetDisplay();
        throw new GiteaAccessError(
          `tea login profile "${login}" is no longer available. ${teaHint}`,
          "account",
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
    if (status === 401) {
      forgetDisplay();
      throw new GiteaAccessError(
        `Gitea rejected tea login profile "${login}". Sign in again with \`tea login add\`.`,
        "account",
      );
    }
    if (status === 403 || status === 404)
      throw new GiteaAccessError(`Gitea API returned HTTP ${status}.`, "item");
    if (status < 200 || status >= 300)
      throw new Error(`Gitea API returned HTTP ${status}.`);
    return { kind: "body", body: output.stdout };
  }

  async function api(path: string, request: ApiRequest = {}): Promise<unknown> {
    const response = await teaApi(path, request);
    if (response.kind === "too-large")
      throw new Error("The Gitea response exceeded the 16 MiB limit.");
    if (!response.body.trim()) return null;
    try {
      return JSON.parse(response.body) as unknown;
    } catch {
      throw new Error("tea returned invalid JSON from Gitea.");
    }
  }

  async function pullDiff(
    repo: string,
    number: number,
    signal: AbortSignal | undefined,
  ): Promise<RawPullDiff> {
    try {
      const response = await teaApi(repoPath(repo, `pulls/${number}.diff`), {
        signal,
      });
      return response.kind === "body"
        ? { kind: "text", text: response.body }
        : response;
    } catch (error) {
      if (signal?.aborted) throw error;
      bb.log.warn(
        `Could not read the raw diff for ${repo}#${number}: ${error instanceof Error ? error.message : "unknown error"}`,
      );
      return { kind: "failed" };
    }
  }

  async function readPull(
    repo: string,
    number: number,
    signal: AbortSignal | undefined,
  ): Promise<{ pull: Record<string, unknown>; revision: PullRevision }> {
    const pull = record(
      await api(repoPath(repo, `pulls/${number}`), { signal }),
    );
    const revision = parseRevision(pull);
    if (!revision)
      throw new Error(
        "Gitea returned a pull request without head and base revisions.",
      );
    return { pull, revision };
  }

  async function readPullFiles(
    repo: string,
    number: number,
    signal: AbortSignal | undefined,
  ) {
    const page = await paginated(
      repoPath(repo, `pulls/${number}/files`),
      signal,
      maxPages,
      4,
    );
    const files = page.values.map((entry) => {
      const f = record(entry);
      return {
        path: text(f.filename),
        previousPath: text(f.previous_filename) || null,
        status: text(f.status),
        additions: Number(f.additions) || 0,
        deletions: Number(f.deletions) || 0,
        patch: text(f.patch) || null,
      };
    });
    const raw = files.every((file) => file.patch)
      ? null
      : await pullDiff(repo, number, signal);
    return { files, raw, truncated: page.truncated };
  }

  async function displayAccount() {
    const login = await teaLogin().catch((error: unknown) => {
      forgetDisplay();
      throw error;
    });
    return JSON.stringify([
      cleanBaseUrl(config.baseUrl).href,
      login.name,
      login.user,
    ]);
  }

  async function displayKey(scope: string, repo: string, number: number) {
    return JSON.stringify([
      await displayAccount(),
      scope,
      repo.toLowerCase(),
      number,
    ]);
  }

  async function readComments(
    repo: string,
    number: number,
    signal: AbortSignal | undefined,
  ) {
    const page = await paginated(
      repoPath(repo, `issues/${number}/comments`),
      signal,
    );
    return {
      truncated: page.truncated,
      comments: page.values.map((raw) => {
        const value = record(raw);
        return commentSchema.parse({
          author: actor(value),
          body: text(value.body),
          createdAt: text(value.created_at),
        });
      }),
    };
  }

  async function readReviews(
    repo: string,
    number: number,
    signal: AbortSignal | undefined,
  ) {
    const page = await paginated(
      repoPath(repo, `pulls/${number}/reviews`),
      signal,
    );
    return {
      truncated: page.truncated,
      reviews: page.values.map((entry) => {
        const review = record(entry);
        return {
          author: actor(review),
          state: text(review.state),
          body: text(review.body),
          createdAt: text(review.submitted_at),
        };
      }),
    };
  }

  async function readChecks(
    repo: string,
    head: string,
    signal: AbortSignal | undefined,
  ): Promise<{ checks: Check[]; truncated: boolean }> {
    const base = cleanBaseUrl(config.baseUrl);
    const statuses = await paginated(
      repoPath(repo, `statuses/${encodeURIComponent(head)}`),
      signal,
      2,
    ).catch((error: unknown) => {
      if (signal?.aborted || error instanceof GiteaAccessError) throw error;
      return { values: [], truncated: false };
    });
    return {
      truncated: statuses.truncated,
      checks: statuses.values.slice(0, 100).map((entry) => {
        const status = record(entry);
        return {
          name: text(status.context),
          status: checkStatus(text(status.status)),
          url: safeLink(base, status.target_url),
        };
      }),
    };
  }

  async function readConversation(
    repo: string,
    number: number,
    kind: "issue" | "pr",
    signal: AbortSignal,
  ): Promise<Conversation> {
    const base = cleanBaseUrl(config.baseUrl);
    const [issue, thread, pull] = await Promise.all([
      api(repoPath(repo, `issues/${number}`), { signal }),
      readComments(repo, number, signal),
      kind === "pr"
        ? Promise.all([
            readPull(repo, number, signal).then(async (loaded) => ({
              ...loaded,
              checks: await readChecks(repo, loaded.revision.head, signal),
            })),
            readReviews(repo, number, signal),
          ])
        : null,
    ]);
    const { kind: _kind, ...item } = mapItem(repo, issue, kind, base);
    const common = {
      ...item,
      comments: thread.comments,
      commentsTruncated: thread.truncated,
    };
    if (pull === null) return conversationSchema.parse({ ...common, kind });
    const [loaded, reviewPage] = pull;
    return conversationSchema.parse({
      ...common,
      kind,
      headRefName: text(record(loaded.pull.head).ref),
      baseRefName: text(record(loaded.pull.base).ref),
      revision: loaded.revision,
      changedFiles:
        typeof loaded.pull.changed_files === "number"
          ? loaded.pull.changed_files
          : null,
      checks: loaded.checks.checks,
      checksTruncated: loaded.checks.truncated,
      reviews: reviewPage.reviews,
      reviewsTruncated: reviewPage.truncated,
    });
  }

  async function readBoundFiles(
    repo: string,
    number: number,
    known: PullRevision | null,
    signal: AbortSignal | undefined,
  ): Promise<{ pull: Record<string, unknown>; value: PullFiles }> {
    const before = known ?? (await readPull(repo, number, signal)).revision;
    let loaded = await readPullFiles(repo, number, signal);
    let after = await readPull(repo, number, signal);
    let stale = false;
    if (!sameRevision(before, after.revision)) {
      const retryBase = after.revision;
      loaded = await readPullFiles(repo, number, signal);
      after = await readPull(repo, number, signal);
      stale = !sameRevision(retryBase, after.revision);
    }
    const diffs: FileDiff[] = stale
      ? loaded.files.map(() => ({ kind: "unavailable", reason: "stale" }))
      : assignFileDiffs(loaded.files, loaded.raw);
    const files: FileView[] = loaded.files.map((file, index) => ({
      path: file.path,
      previousPath: file.previousPath,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      diff: diffs[index]!,
    }));
    return {
      pull: after.pull,
      value: {
        revision: after.revision,
        files,
        filesTruncated: loaded.truncated,
        stale,
      },
    };
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
    batchSize = 1,
  ): Promise<{ values: unknown[]; truncated: boolean }> {
    const readPage = async (page: number) => {
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
      return response;
    };
    const values: unknown[] = [];
    for (let page = 1; page <= pageLimit; ) {
      const count = page === 1 ? 1 : Math.min(batchSize, pageLimit - page + 1);
      const responses = await Promise.all(
        Array.from({ length: count }, (_, index) => readPage(page + index)),
      );
      for (const response of responses) {
        values.push(...response);
        if (response.length < pageSize) return { values, truncated: false };
      }
      page += count;
    }
    return { values, truncated: true };
  }
  async function fetchItems(
    kind: "issue" | "pr",
    repo: string | undefined,
    state: "open" | "closed" | "all",
    signal?: AbortSignal,
  ): Promise<ItemPage> {
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
    const result: ListItem[] = [];
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
    return {
      items: result,
      truncated,
      errors,
      reachable: candidates.length - errors.length,
    };
  }
  async function listItems(
    kind: "issue" | "pr",
    repo: string | undefined,
    state: "open" | "closed" | "all",
    query: string,
    signal?: AbortSignal,
  ) {
    return pickItems(await fetchItems(kind, repo, state, signal), query);
  }
  async function readItemPage(
    kind: "issue" | "pr",
    repo: string | undefined,
    state: "open" | "closed" | "all",
    signal: AbortSignal,
  ): Promise<ItemPage> {
    const page = await fetchItems(kind, repo, state, signal);
    if (page.reachable === 0 && page.errors.length > 0)
      throw new Error(page.errors[0]!.message);
    return page;
  }
  async function readList<T>(
    cache: DisplayCache<T>,
    scope: string,
    repo: string | undefined,
    state: "open" | "closed" | "all",
    refresh: boolean,
    load: (signal: AbortSignal) => Promise<T>,
    signal: AbortSignal | undefined,
  ) {
    if (refresh) cache.invalidate(listTag);
    const account = await displayAccount();
    const key = JSON.stringify([
      account,
      scope,
      repo?.toLowerCase() ?? null,
      state,
    ]);
    const display = await cache.read(key, listTag, load, {
      policy: listPolicy,
      signal,
    });
    return {
      value: display.value,
      account,
      freshness: freshnessView(display.freshness),
    };
  }
  const babysitPrefix = "babysit:";
  const babysitIntervalMs = 5 * 60_000;
  const babysitKey = (repo: string, number: number) =>
    `${babysitPrefix}${pullKey(repo, number)}`;
  const babysitThreadKey = (threadId: string) => `babysit-thread:${threadId}`;
  const babysitRefSchema = z.object({
    repo: repositorySchema,
    number: z.number().int().positive(),
  });
  const babysitQueues = new Map<string, Promise<void>>();
  const now = () => new Date().toISOString();
  const message = (error: unknown) =>
    error instanceof Error ? error.message : String(error);

  async function getSession(
    repo: string,
    number: number,
  ): Promise<BabysitSession | null> {
    return parseStoredSession(
      await bb.storage.kv.get<unknown>(babysitKey(repo, number)),
    );
  }

  async function getSessionByThread(
    threadId: string,
  ): Promise<BabysitSession | null> {
    const ref = babysitRefSchema.safeParse(
      await bb.storage.kv.get<unknown>(babysitThreadKey(threadId)),
    );
    if (!ref.success) return null;
    const session = await getSession(ref.data.repo, ref.data.number);
    return session?.threadId === threadId ? session : null;
  }

  async function listSessions(): Promise<BabysitSession[]> {
    const sessions: BabysitSession[] = [];
    for (const key of await bb.storage.kv.list(babysitPrefix)) {
      const session = parseStoredSession(await bb.storage.kv.get<unknown>(key));
      if (session) sessions.push(session);
    }
    return sessions.sort((left, right) =>
      right.updatedAt.localeCompare(left.updatedAt),
    );
  }

  async function setSession(session: BabysitSession): Promise<void> {
    await bb.storage.kv.set(babysitKey(session.repo, session.number), session);
    await bb.storage.kv.set(babysitThreadKey(session.threadId), {
      repo: session.repo,
      number: session.number,
    });
    bb.realtime.publish("babysit-changed", {
      repo: session.repo,
      number: session.number,
    });
  }

  async function forgetDeletedThread(threadId: string): Promise<void> {
    const current = await getSessionByThread(threadId);
    if (current !== null) {
      await bb.storage.kv.delete(babysitKey(current.repo, current.number));
      bb.realtime.publish("babysit-changed", {
        repo: current.repo,
        number: current.number,
      });
    }
    await bb.storage.kv.delete(babysitThreadKey(threadId));
  }

  async function readThreadPresence(
    threadId: string,
  ): Promise<
    | { state: "deleted" }
    | { state: "present"; archived: boolean; status: string }
  > {
    try {
      const thread = await bb.sdk.threads.get({ threadId });
      return thread.deletedAt
        ? { state: "deleted" }
        : {
            state: "present",
            archived: Boolean(thread.archivedAt),
            status: thread.status,
          };
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        (error as { code?: unknown }).code === "thread_not_found"
      )
        return { state: "deleted" };
      throw error;
    }
  }

  async function writeIfCurrent(
    expected: BabysitSession,
    next: BabysitSession,
  ): Promise<boolean> {
    if (
      !sameSession(expected, await getSession(expected.repo, expected.number))
    )
      return false;
    await setSession(next);
    return true;
  }

  async function getPreferences(): Promise<BabysitPreferences> {
    return parseStoredPreferences(
      await bb.storage.kv.get<unknown>("babysit-preferences"),
    );
  }

  let preferencesUpdate: Promise<unknown> = Promise.resolve();
  function updatePreferences(
    update: (current: BabysitPreferences) => BabysitPreferences,
  ): Promise<BabysitPreferences> {
    const result = preferencesUpdate.then(async () => {
      const next = update(await getPreferences());
      await bb.storage.kv.set("babysit-preferences", next);
      bb.realtime.publish("babysit-changed", { settings: true });
      return next;
    });
    preferencesUpdate = result.catch(() => undefined);
    return result;
  }

  async function readLifecycle(
    repo: string,
    number: number,
    signal?: AbortSignal,
  ): Promise<LifecycleFact> {
    try {
      const lifecycle = parseLifecycle(
        await api(repoPath(repo, `pulls/${number}`), { signal }),
      );
      return (
        lifecycle ?? {
          state: "unknown",
          error: "Gitea returned an unrecognized pull request state.",
        }
      );
    } catch (error) {
      if (signal?.aborted) throw error;
      return { state: "unknown", error: message(error) };
    }
  }

  function trackedProjects(
    tracked: { repo: string; projectId: string | null }[],
  ): Map<string, string> {
    return new Map(
      tracked.flatMap((entry) =>
        entry.projectId === null
          ? []
          : [[entry.repo.toLowerCase(), entry.projectId] as const],
      ),
    );
  }

  async function projectFor(repo: string): Promise<string | null> {
    return (
      (await repos()).find(
        (entry) => entry.repo.toLowerCase() === repo.toLowerCase(),
      )?.projectId ?? null
    );
  }

  async function archiveAndStop(
    threadId: string,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    const failures: string[] = [];
    try {
      await bb.sdk.threads.stop({ threadId });
    } catch (error) {
      failures.push(`stop: ${message(error)}`);
    }
    try {
      await bb.sdk.threads.archive({ threadId });
    } catch (error) {
      failures.push(`archive: ${message(error)}`);
    }
    if (!failures.length) return { ok: true };
    const error = failures.join("; ");
    bb.log.error(`Could not clean up Gitea babysitter ${threadId}: ${error}`);
    return { ok: false, error };
  }

  async function notifySupervisor(
    threadId: string,
    event: "idle" | "failed",
    detail: string | null,
  ) {
    try {
      await bb.sdk.plugins.callRpc({
        pluginId: "supervisor",
        method: "notifyBabysitter",
        input: { threadId, event, detail },
        outputSchema: z.object({ accepted: z.boolean() }).strict(),
      });
    } catch (error) {
      bb.log.debug(
        `Supervisor unavailable for Gitea babysitter ${threadId}: ${message(error)}`,
      );
    }
  }

  async function settle(
    current: BabysitSession,
    next: BabysitSession,
    event: "idle" | "failed",
    detail: string | null,
  ) {
    if (!(await writeIfCurrent(current, next))) return;
    await notifySupervisor(next.threadId, event, detail);
    if (!sameSession(next, await getSession(next.repo, next.number))) return;
    const cleanup = await archiveAndStop(next.threadId);
    if (!cleanup.ok)
      await writeIfCurrent(next, onCleanupFailed(next, cleanup.error, now()));
  }

  async function handleIdle(threadId: string, lastText: string | null) {
    const current = await getSessionByThread(threadId);
    if (current?.status !== "watching") return;
    const lifecycle = await readLifecycle(current.repo, current.number);
    const next = onIdle(current, lastText, lifecycle, now());
    if (next) await settle(current, next, "idle", lastText);
  }

  async function handleFailed(threadId: string, error: string | null) {
    const current = await getSessionByThread(threadId);
    const next = current && onFailed(current, error, now());
    if (current && next) await settle(current, next, "failed", error);
  }

  async function handleArchived(threadId: string) {
    const current = await getSessionByThread(threadId);
    const next = current && onArchived(current, now());
    if (current && next) await writeIfCurrent(current, next);
  }

  function serialized<T>(
    repo: string,
    number: number,
    run: () => Promise<T>,
  ): Promise<T> {
    const key = pullKey(repo, number);
    const result = (babysitQueues.get(key) ?? Promise.resolve()).then(run);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    babysitQueues.set(key, tail);
    void tail.then(() => {
      if (babysitQueues.get(key) === tail) babysitQueues.delete(key);
    });
    return result;
  }

  async function babysitterPrompt(
    repo: string,
    number: number,
    title: string,
    policy: BabysitPolicy,
  ): Promise<string> {
    return buildBabysitterPrompt({
      repo,
      number,
      title: title || `pull request #${number}`,
      baseUrl: cleanBaseUrl(config.baseUrl).href,
      login: (await teaLogin()).name,
      policy,
    });
  }

  async function spawnBabysitter(
    repo: string,
    number: number,
    policy: BabysitPolicy,
  ): Promise<{ threadId: string }> {
    const key = `${repo}#${number}`;
    const [pull, projectId] = await Promise.all([
      api(repoPath(repo, `pulls/${number}`)).then(record),
      projectFor(repo),
    ]);
    const lifecycle = parseLifecycle(pull);
    if (!lifecycle)
      throw new Error("Gitea returned an unrecognized pull request state.");
    const decision = decideStart({
      session: await getSession(repo, number),
      projectId,
      lifecycle,
    });
    if (decision.kind === "reject")
      throw new Error(startError(key, decision.reason));
    if (decision.kind === "existing") return { threadId: decision.threadId };
    const title = text(pull.title) || `pull request #${number}`;
    const [{ execution }, prompt] = await Promise.all([
      getPreferences(),
      babysitterPrompt(repo, number, title, policy),
    ]);
    const thread = await bb.sdk.threads.spawn({
      projectId: decision.projectId,
      environment: { type: "project-default" },
      visibility: "hidden",
      title: `${giteaBabysitterTitlePrefix} ${key}: ${title}`.slice(0, 120),
      prompt,
      providerId: execution.providerId,
      model: execution.model,
      reasoningLevel: execution.reasoningLevel,
      serviceTier: execution.serviceTier,
      permissionMode: "auto",
      executionInputSources: {
        providerId: "explicit",
        model: "explicit",
        reasoningLevel: "explicit",
        serviceTier: "explicit",
        permissionMode: "explicit",
      },
    });
    const raced = await getSession(repo, number);
    if (
      raced !== null &&
      !(decision.replaces !== null && sameSession(decision.replaces, raced))
    ) {
      const cleanup = await archiveAndStop(thread.id);
      if (!cleanup.ok)
        throw new Error(
          `Could not discard duplicate babysitter ${thread.id}: ${cleanup.error}`,
        );
      return { threadId: raced.threadId };
    }
    await setSession({
      repo,
      number,
      threadId: thread.id,
      updatedAt: now(),
      policy,
      status: "watching",
    });
    if (decision.replaces !== null)
      await bb.storage.kv.delete(babysitThreadKey(decision.replaces.threadId));
    await bb.storage.kv.set(`thread-link:${thread.id}`, {
      repo,
      number,
      kind: "pr",
    });
    bb.log.info(`Started Gitea babysitter ${thread.id} for ${key}`);
    return { threadId: thread.id };
  }

  async function resumeBabysitter(
    session: ResumableSession,
    policy: BabysitPolicy,
    cleanupFirst: boolean,
  ): Promise<{ threadId: string }> {
    const { repo, number } = session;
    const result = { threadId: session.threadId };
    const presence = await readThreadPresence(session.threadId);
    if (presence.state === "deleted") {
      await forgetDeletedThread(session.threadId);
      return await spawnBabysitter(repo, number, policy);
    }
    if (cleanupFirst) {
      const cleanup = await archiveAndStop(session.threadId);
      if (!cleanup.ok) {
        await writeIfCurrent(
          session,
          onCleanupFailed(session, cleanup.error, now()),
        );
        throw new Error(`Cleanup failed: ${cleanup.error}`);
      }
    }
    const pull = record(await api(repoPath(repo, `pulls/${number}`)));
    const lifecycle = parseLifecycle(pull);
    if (!lifecycle)
      throw new Error("Gitea returned an unrecognized pull request state.");
    const done = confirmedTerminal(session, lifecycle, now());
    if (done) {
      await writeIfCurrent(session, done);
      return result;
    }
    if (presence.archived || cleanupFirst)
      await bb.sdk.threads.unarchive({ threadId: session.threadId });
    if (!sameSession(session, await getSession(repo, number))) return result;
    await bb.sdk.threads.send({
      threadId: session.threadId,
      mode: "start",
      input: [
        {
          type: "text",
          text: `${await babysitterPrompt(repo, number, text(pull.title), policy)}\n\nContinue from the preserved transcript and current Gitea state.`,
          mentions: [],
        },
      ],
    });
    if (await writeIfCurrent(session, watching(session, policy, now())))
      return result;
    const latest = await getSession(repo, number);
    if (latest?.threadId === session.threadId && latest.status === "stopped") {
      const cleanup = await archiveAndStop(session.threadId);
      if (!cleanup.ok)
        await writeIfCurrent(
          latest,
          onCleanupFailed(latest, cleanup.error, now()),
        );
    }
    return result;
  }

  async function updateLiveBabysitter(
    session: Extract<BabysitSession, { status: "watching" }>,
    policy: BabysitPolicy,
  ): Promise<void> {
    const { repo, number } = session;
    const pull = record(await api(repoPath(repo, `pulls/${number}`)));
    const prompt = await babysitterPrompt(
      repo,
      number,
      text(pull.title),
      policy,
    );
    if (!(await writeIfCurrent(session, watching(session, policy, now()))))
      throw new Error(
        `The babysitter for ${repo}#${number} changed while its automation was updated; try again.`,
      );
    try {
      await bb.sdk.threads.send({
        threadId: session.threadId,
        mode: "steer",
        input: [
          {
            type: "text",
            text: `Automation settings changed.\n\n${prompt}\n\nContinue from the current Gitea state under these settings.`,
            mentions: [],
          },
        ],
      });
    } catch (error) {
      await stopBabysitter(repo, number);
      throw new Error(
        `Could not deliver the automation change, so the babysitter was stopped: ${message(error)}`,
      );
    }
  }

  function retryBabysitter(repo: string, number: number) {
    return serialized(repo, number, async () => {
      const decision = decideRetry(await getSession(repo, number));
      if (decision.kind === "start")
        return await spawnBabysitter(repo, number, decision.policy);
      if (decision.kind === "reject")
        throw new Error(
          decision.reason === "idle"
            ? `${repo}#${number} has no babysitter to retry; turn on Auto-fix or Auto-merge.`
            : startError(`${repo}#${number}`, decision.reason),
        );
      if (decision.kind === "existing") return { threadId: decision.threadId };
      return await resumeBabysitter(
        decision.session,
        decision.session.policy,
        decision.cleanupFirst,
      );
    });
  }

  function setAutomation(repo: string, number: number, patch: AutomationPatch) {
    return serialized(repo, number, async () => {
      const decision = decideAutomation(await getSession(repo, number), patch);
      if (decision.kind === "reject")
        throw new Error(startError(`${repo}#${number}`, decision.reason));
      if (decision.kind === "stop") await stopBabysitter(repo, number);
      if (decision.kind === "start")
        await spawnBabysitter(repo, number, decision.policy);
      if (decision.kind === "update")
        await updateLiveBabysitter(decision.session, decision.policy);
      if (decision.kind === "resume")
        await resumeBabysitter(
          decision.session,
          decision.policy,
          decision.cleanupFirst,
        );
      return await babysitStatus(repo, number);
    });
  }

  async function stopBabysitter(repo: string, number: number) {
    for (;;) {
      const target = decideStop(await getSession(repo, number));
      if (!target) return { ok: true as const };
      const next = stopped(target, now());
      if (!(await writeIfCurrent(target, next))) continue;
      const cleanup = await archiveAndStop(target.threadId);
      if (cleanup.ok) return { ok: true as const };
      await writeIfCurrent(next, onCleanupFailed(next, cleanup.error, now()));
      throw new Error(`Cleanup failed: ${cleanup.error}`);
    }
  }

  async function babysitStatus(repo: string, number: number) {
    const session = await getSession(repo, number);
    if (session !== null && session.status !== "closed")
      return babysitView(session, null);
    const [lifecycle, projectId] = await Promise.all([
      readLifecycle(repo, number),
      projectFor(repo),
    ]);
    return babysitView(session, { lifecycle, projectId });
  }

  async function currentLogin(signal?: AbortSignal): Promise<string> {
    const login = text(record(await api("user", { signal })).login);
    if (!login) throw new Error("Gitea did not report the signed-in user.");
    return login;
  }

  async function reconcileAutoBabysit(signal?: AbortSignal) {
    const preferences = await getPreferences();
    const policy = activePolicy({
      fix: preferences.autoFix,
      merge: preferences.autoMerge,
    });
    if (policy === null) return;
    const [login, tracked, pulls, sessions] = await Promise.all([
      currentLogin(signal),
      repos(),
      listItems("pr", undefined, "open", "", signal),
      listSessions(),
    ]);
    const targets = autoStartTargets({
      login,
      pulls: pulls.items,
      projects: trackedProjects(tracked),
      sessions: new Map(
        sessions.map((session) => [
          pullKey(session.repo, session.number),
          session,
        ]),
      ),
    });
    for (const target of targets) {
      signal?.throwIfAborted();
      try {
        await serialized(target.repo, target.number, () =>
          spawnBabysitter(target.repo, target.number, policy),
        );
      } catch (error) {
        bb.log.warn(
          `Automatic Gitea babysitter failed for ${target.repo}#${target.number}: ${message(error)}`,
        );
      }
    }
  }

  async function reconcileSessions(signal: AbortSignal) {
    for (const session of await listSessions()) {
      if (signal.aborted) return;
      try {
        const thread = await readThreadPresence(session.threadId);
        if (thread.state === "deleted")
          await forgetDeletedThread(session.threadId);
        else if (session.status !== "watching") continue;
        else if (thread.archived) await handleArchived(session.threadId);
        else if (thread.status === "idle")
          await handleIdle(
            session.threadId,
            (await bb.sdk.threads.output({ threadId: session.threadId }))
              .output,
          );
        else if (thread.status === "error")
          await handleFailed(
            session.threadId,
            "The babysitter thread ended in error while the Gitea plugin was not observing it.",
          );
      } catch (error) {
        bb.log.warn(
          `Could not reconcile Gitea babysitter ${session.threadId}: ${message(error)}`,
        );
      }
    }
  }

  bb.events.on("thread.idle", ({ thread, lastAssistantText }) =>
    handleIdle(thread.id, lastAssistantText),
  );
  bb.events.on("thread.failed", ({ thread, error }) =>
    handleFailed(thread.id, error),
  );
  bb.events.on("thread.archived", ({ thread }) => handleArchived(thread.id));
  bb.events.on("thread.deleted", ({ thread }) =>
    forgetDeletedThread(thread.id),
  );
  bb.background.service("babysitters", {
    async start(signal) {
      while (!signal.aborted) {
        try {
          await reconcileSessions(signal);
          await reconcileAutoBabysit(signal);
        } catch (error) {
          if (signal.aborted) break;
          bb.log.warn(
            `Gitea babysitter reconciliation failed: ${message(error)}`,
          );
        }
        await new Promise<void>((resolve) => {
          const timer = setTimeout(done, babysitIntervalMs);
          function done() {
            clearTimeout(timer);
            signal.removeEventListener("abort", done);
            resolve();
          }
          signal.addEventListener("abort", done, { once: true });
          if (signal.aborted) done();
        });
      }
    },
  });

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
          account: await displayAccount(),
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
          account: null,
          repos: discovered,
        };
      }
    },
    listItems: async (
      { kind, repo, state, query, refresh },
      { experimental_signal: signal }: RpcContext = {},
    ) => {
      const list = await readList(
        itemLists,
        kind,
        repo,
        state,
        refresh,
        (loadSignal) => readItemPage(kind, repo, state, loadSignal),
        signal,
      );
      return {
        ...pickItems(list.value, query),
        account: list.account,
        freshness: list.freshness,
      };
    },
    detail: async (
      { repo, number, kind },
      { experimental_signal: signal }: RpcContext = {},
    ) => {
      const base = cleanBaseUrl(config.baseUrl);
      const [issue, thread, pr, threadId] = await Promise.all([
        api(repoPath(repo, `issues/${number}`), { signal }),
        readComments(repo, number, signal),
        kind === "pr"
          ? Promise.all([
              readReviews(repo, number, signal),
              readBoundFiles(repo, number, null, signal).then(
                async (bound) => ({
                  ...bound,
                  checks: await readChecks(
                    repo,
                    bound.value.revision.head,
                    signal,
                  ),
                }),
              ),
            ])
          : null,
        bb.storage.kv.get<string>(`thread:${repo}:${number}`),
      ]);
      const item = mapItem(repo, issue, kind, base);
      const common = {
        ...item,
        comments: thread.comments,
        commentsTruncated: thread.truncated,
        threadId: threadId ?? null,
      };
      if (pr === null)
        return detailSchema.parse({
          ...common,
          files: [],
          filesTruncated: false,
          checks: [],
          checksTruncated: false,
          reviews: [],
          reviewsTruncated: false,
          headRefName: "",
          baseRefName: "",
        });
      const [reviewPage, bound] = pr;
      return detailSchema.parse({
        ...common,
        files: bound.value.files,
        filesTruncated: bound.value.filesTruncated,
        checks: bound.checks.checks,
        checksTruncated: bound.checks.truncated,
        reviews: reviewPage.reviews,
        reviewsTruncated: reviewPage.truncated,
        headRefName: text(record(bound.pull.head).ref),
        baseRefName: text(record(bound.pull.base).ref),
      });
    },
    conversation: async (
      { repo, number, kind, refresh },
      { experimental_signal: signal }: RpcContext = {},
    ) => {
      const tag = displayTag(repo, number);
      if (refresh) {
        conversations.invalidate(tag);
        pullFiles.invalidate(tag);
      }
      const key = await displayKey(kind, repo, number);
      const [display, threadId] = await Promise.all([
        conversations.read(
          key,
          tag,
          (loadSignal) => readConversation(repo, number, kind, loadSignal),
          { policy: conversationPolicy, signal },
        ),
        bb.storage.kv.get<string>(`thread:${repo}:${number}`),
      ]);
      return {
        freshness: freshnessView(display.freshness),
        conversation: display.value,
        threadId: threadId ?? null,
      };
    },
    pullFiles: async (
      { repo, number, revision, refresh },
      { experimental_signal: signal }: RpcContext = {},
    ) => {
      const tag = displayTag(repo, number);
      if (refresh) pullFiles.invalidate(tag);
      const key = await displayKey("files", repo, number);
      const display = await pullFiles.read(
        key,
        tag,
        async (loadSignal) =>
          (await readBoundFiles(repo, number, revision, loadSignal)).value,
        {
          policy: filesPolicy,
          signal,
          usable: (value) =>
            revision === null || sameRevision(value.revision, revision),
          storable: (value) => !value.stale,
        },
      );
      if (
        revision !== null &&
        !sameRevision(display.value.revision, revision)
      ) {
        conversations.invalidate(tag);
        publishDisplay(tag);
      }
      return { ...display.value, freshness: freshnessView(display.freshness) };
    },
    createIssue: async (
      { repo, title, body },
      { experimental_signal: signal }: RpcContext = {},
    ) => {
      const created = await api(repoPath(repo, "issues"), {
        method: "POST",
        body: { title, body },
        signal,
      });
      forgetLists();
      return mapItem(repo, created, "issue", cleanBaseUrl(config.baseUrl));
    },
    comment: async (
      { repo, number, body },
      { experimental_signal: signal }: RpcContext = {},
    ) => {
      try {
        await api(repoPath(repo, `issues/${number}/comments`), {
          method: "POST",
          body: { body },
          signal,
        });
      } finally {
        forgetDisplayItem(repo, number);
      }
      return { ok: true as const };
    },
    setState: async (
      { repo, number, state },
      { experimental_signal: signal }: RpcContext = {},
    ) => {
      try {
        await api(repoPath(repo, `issues/${number}`), {
          method: "PATCH",
          body: { state },
          signal,
        });
      } finally {
        forgetDisplayItem(repo, number);
        forgetLists();
      }
      return { ok: true as const };
    },
    updateMetadata: async (
      { repo, number, labels, assignees },
      { experimental_signal: signal }: RpcContext = {},
    ) => {
      try {
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
      } finally {
        forgetDisplayItem(repo, number);
        forgetLists();
      }
      return { ok: true as const };
    },
    review: async (
      { repo, number, event, body },
      { experimental_signal: signal }: RpcContext = {},
    ) => {
      try {
        await api(repoPath(repo, `pulls/${number}/reviews`), {
          method: "POST",
          body: { event, body },
          signal,
        });
      } finally {
        forgetDisplayItem(repo, number);
      }
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
        return `${actor(comment)}: ${text(comment.body).slice(0, 2000)}`;
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
    listMyPullRequests: async (
      { repo, state, query, refresh },
      { experimental_signal: signal }: RpcContext = {},
    ) => {
      const [mine, tracked, preferences] = await Promise.all([
        readList(
          myPullLists,
          "my-prs",
          repo,
          state,
          refresh,
          async (loadSignal) => {
            const [login, page] = await Promise.all([
              currentLogin(loadSignal),
              readItemPage("pr", repo, state, loadSignal),
            ]);
            return {
              login,
              page: {
                ...page,
                items: page.items.filter((item) => item.author === login),
              },
            };
          },
          signal,
        ),
        repos(),
        getPreferences(),
      ]);
      const { login, page } = mine.value;
      const list = pickItems(page, query);
      const projects = trackedProjects(tracked);
      const items = await Promise.all(
        list.items.map(async (item) => ({
            ...item,
            babysit: babysitView(
              await getSession(item.repo, item.number),
              item.state === "open"
                ? {
                    lifecycle: { state: "open" },
                    projectId: projects.get(item.repo.toLowerCase()) ?? null,
                  }
                : null,
            ),
          })),
      );
      return {
        ...list,
        account: mine.account,
        freshness: mine.freshness,
        login,
        items,
        preferences,
      };
    },
    setAutomation: ({ repo, number, fix, merge }) =>
      setAutomation(repo, number, { fix, merge }),
    retryBabysit: ({ repo, number }) => retryBabysitter(repo, number),
    getBabysitStatus: ({ repo, number }) => babysitStatus(repo, number),
    babysitThread: async ({ threadId }) => {
      const session = await getSessionByThread(threadId);
      return session && sessionView(session);
    },
    listBabysitSessions: async () => ({
      sessions: (await listSessions()).map(sessionView),
    }),
    getBabysitPreferences: () => getPreferences(),
    setAutoAutomation: async (patch) => {
      const preferences = await updatePreferences((current) => {
        const next = applyAutomationPatch(
          { fix: current.autoFix, merge: current.autoMerge },
          patch,
        );
        return { ...current, autoFix: next.fix, autoMerge: next.merge };
      });
      if (preferences.autoFix || preferences.autoMerge)
        await reconcileAutoBabysit().catch((error: unknown) =>
          bb.log.warn(`Automatic Gitea babysitting failed: ${message(error)}`),
        );
      return preferences;
    },
    setBabysitExecution: (execution) =>
      updatePreferences((current) => ({ ...current, execution })),
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
        name: "conversation",
        summary: "Read the cached issue or pull request conversation",
        usage:
          "bb gitea conversation <issue|pr> <owner/repo> <number> [--refresh] [--json]",
      },
      {
        name: "files",
        summary: "Read cached pull request changed files and diffs",
        usage: "bb gitea files <owner/repo> <number> [--refresh] [--json]",
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
      {
        name: "my-prs",
        summary: "List your pull requests with Auto-fix and Auto-merge status",
        usage:
          "bb gitea my-prs [owner/repo] [--state open|closed|all] [--query text] [--json]",
      },
      {
        name: "auto-fix",
        summary:
          "Turn Auto-fix on or off for your pull request; it fixes CI failures and review feedback but never merges",
        usage: "bb gitea auto-fix <owner/repo> <number> on|off [--json]",
      },
      {
        name: "auto-merge",
        summary:
          "Turn Auto-merge on or off for your pull request; it merges when Gitea's rules allow but never changes code",
        usage: "bb gitea auto-merge <owner/repo> <number> on|off [--json]",
      },
      {
        name: "babysit-status",
        summary:
          "Show a pull request's Auto-fix, Auto-merge, and babysitter state",
        usage: "bb gitea babysit-status <owner/repo> <number> [--json]",
      },
      {
        name: "babysit-retry",
        summary: "Resume a stopped, failed, or waiting babysitter",
        usage: "bb gitea babysit-retry <owner/repo> <number> [--json]",
      },
      {
        name: "babysit-thread",
        summary: "Show the babysitter session owned by a BB thread",
        usage: "bb gitea babysit-thread <thread-id> [--json]",
      },
      {
        name: "babysit-sessions",
        summary: "List retained babysitter sessions",
        usage: "bb gitea babysit-sessions [--json]",
      },
      {
        name: "automation-defaults",
        summary:
          "Show or set whether Auto-fix and Auto-merge turn on automatically for your pull requests",
        usage: "bb gitea automation-defaults [fix|merge on|off] [--json]",
      },
      {
        name: "babysit-execution",
        summary:
          "Set the provider, model, reasoning, and tier for new babysitters",
        usage:
          "bb gitea babysit-execution <provider> <model> <reasoning> [fast|default] [--json]",
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
      const refresh = args.includes("--refresh");
      const positional = args.filter(
        (value) => value !== "--json" && value !== "--refresh",
      );
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
            refresh: true,
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
        if (command === "conversation") {
          const input = giteaRpcContract.conversation.input.parse({
            kind: values[0],
            repo: values[1],
            number: Number(values[2]),
            refresh,
          });
          const value = await handlers.conversation(input);
          const { conversation, freshness } = value;
          return succeed(
            value,
            `${conversation.repo}#${conversation.number} ${conversation.title}\n${conversation.state} · ${conversation.author} · ${freshness.state} ${freshness.fetchedAt}${freshness.state === "stale-error" ? `\n${freshness.error}` : ""}\n\n${conversation.body}`,
          );
        }
        if (command === "files") {
          const input = giteaRpcContract.pullFiles.input.parse({
            repo: values[0],
            number: Number(values[1]),
            refresh,
          });
          const value = await handlers.pullFiles(input);
          return succeed(
            value,
            `${value.files.map((file) => `${file.status} ${file.path} +${file.additions} -${file.deletions} ${file.diff.kind}`).join("\n")}${value.filesTruncated ? "\nThe file list is capped." : ""}${value.stale ? "\nThe pull request changed while files were read." : ""}`,
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
        const onOff = (value: boolean) => (value ? "on" : "off");
        const switchValue = (value: string | undefined) =>
          z.enum(["on", "off"]).parse(value) === "on";
        const describe = (
          view: z.infer<typeof babysitViewSchema>,
          ref: string,
        ) =>
          `${ref} ${view.status} · Auto-fix ${onOff(view.automation.fix)} · Auto-merge ${onOff(view.automation.merge)}${"threadId" in view ? ` thread ${view.threadId}` : ""}${view.status === "failed" ? `\n${view.error}` : ""}${view.status === "needs_you" && view.note ? `\n${view.note}` : ""}`;
        const pullRef = () =>
          pullRefSchema.parse({ repo: values[0], number: Number(values[1]) });
        const describePreferences = (value: BabysitPreferences) =>
          `Turn on Auto-fix for my PRs: ${onOff(value.autoFix)}\nTurn on Auto-merge for my PRs: ${onOff(value.autoMerge)}\nExecution: ${value.execution.providerId} ${value.execution.model} ${value.execution.reasoningLevel} ${value.execution.serviceTier}`;
        if (command === "my-prs") {
          const input = giteaRpcContract.listMyPullRequests.input.parse({
            ...(values[0] ? { repo: values[0] } : {}),
            state,
            query,
            refresh: true,
          });
          const value = await handlers.listMyPullRequests(input);
          return succeed(
            value,
            `${value.items.map((entry) => `${entry.repo}#${entry.number} ${entry.state} fix:${onOff(entry.babysit.automation.fix)} merge:${onOff(entry.babysit.automation.merge)} babysit:${entry.babysit.status} ${entry.title}`).join("\n") || "No pull requests authored by you."}${value.truncated ? "\nResults are capped; narrow the repository or query." : ""}${value.errors.map((entry) => `\n${entry.repo}: ${entry.message}`).join("")}`,
          );
        }
        if (command === "auto-fix" || command === "auto-merge") {
          const option = command === "auto-fix" ? "fix" : "merge";
          const input = giteaRpcContract.setAutomation.input.parse({
            ...pullRef(),
            [option]: switchValue(values[2]),
          });
          const value = await handlers.setAutomation(input);
          return succeed(
            value,
            describe(value, `${input.repo}#${input.number}`),
          );
        }
        if (command === "babysit-retry") {
          const input = pullRef();
          const value = await handlers.retryBabysit(input);
          return succeed(
            value,
            `Babysitter for ${input.repo}#${input.number} is thread ${value.threadId}`,
          );
        }
        if (command === "babysit-status") {
          const input = pullRef();
          const value = await handlers.getBabysitStatus(input);
          return succeed(
            value,
            describe(value, `${input.repo}#${input.number}`),
          );
        }
        if (command === "babysit-thread") {
          const value = await handlers.babysitThread(
            threadIdSchema.parse({ threadId: values[0] }),
          );
          return succeed(
            value,
            value
              ? describe(value, `${value.repo}#${value.number}`)
              : "No Gitea babysitter owns this thread.",
          );
        }
        if (command === "babysit-sessions") {
          const value = await handlers.listBabysitSessions();
          return succeed(
            value,
            value.sessions
              .map((session) =>
                describe(session, `${session.repo}#${session.number}`),
              )
              .join("\n") || "No babysitter sessions.",
          );
        }
        if (command === "automation-defaults") {
          const value =
            values[0] === undefined
              ? await handlers.getBabysitPreferences()
              : await handlers.setAutoAutomation(
                  giteaRpcContract.setAutoAutomation.input.parse({
                    [z.enum(["fix", "merge"]).parse(values[0])]: switchValue(
                      values[1],
                    ),
                  }),
                );
          return succeed(value, describePreferences(value));
        }
        if (command === "babysit-execution") {
          if (values.length < 3 || values.length > 4)
            return {
              exitCode: 1,
              stderr:
                "babysit-execution requires: provider model reasoning [fast|default]",
            };
          const value = await handlers.setBabysitExecution(
            babysitExecutionSchema.parse({
              providerId: values[0],
              model: values[1],
              reasoningLevel: values[2],
              serviceTier: values[3] ?? "default",
            }),
          );
          return succeed(value, describePreferences(value));
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
