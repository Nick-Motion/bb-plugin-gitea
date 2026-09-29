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
  type CacheBounds,
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
import { draftTitle } from "./draft-title.js";
import {
  activePolicy,
  applyAutomationPatch,
  automationOptions,
  automationPatchSchema,
  autoStartTargets,
  autoFixerExecutionSchema,
  autoFixerPreferencesSchema,
  autoFixerSessionViewSchema,
  autoFixerView,
  autoFixerViewSchema,
  buildAutoFixerPrompt,
  confirmedTerminal,
  decideAutomation,
  decideRetry,
  decideStart,
  decideStop,
  giteaAutoFixerTitlePrefix,
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
  type AutoFixerPolicy,
  type AutoFixerPreferences,
  type AutoFixerSession,
  type LifecycleFact,
  type ResumableSession,
} from "./auto-fixer.js";
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
  id: z.number().int().positive(),
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
const reviewCommentSchema = z.object({
  id: z.number().int(),
  author: z.string(),
  body: z.string(),
  createdAt: z.string(),
  path: z.string(),
  line: z.number().int().positive(),
  side: z.enum(["additions", "deletions"]),
  url: z.string(),
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
  reviewComments: z.array(reviewCommentSchema),
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
    reviewComments: z.array(reviewCommentSchema),
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
type ReviewComment = z.infer<typeof reviewCommentSchema>;
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
  editComment: {
    input: z.object({
      repo: repositorySchema,
      number: z.number().int().positive(),
      id: z.number().int().positive(),
      body: z.string().trim().min(1).max(100000),
    }),
    output: okSchema,
  },
  deleteComment: {
    input: z.object({
      repo: repositorySchema,
      number: z.number().int().positive(),
      id: z.number().int().positive(),
    }),
    output: okSchema,
  },
  repoOptions: {
    input: z.object({ repo: repositorySchema }),
    output: z.object({
      labels: z.array(z.object({ name: z.string(), color: z.string() })),
      assignees: z.array(z.string()),
    }),
  },
  reviewComment: {
    input: z.object({
      repo: repositorySchema,
      number: z.number().int().positive(),
      commitId: z.string().regex(/^[0-9a-f]{7,64}$/i),
      path: z.string().min(1).max(4096),
      line: z.number().int().positive(),
      side: z.enum(["additions", "deletions"]),
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
  getAgentExecution: {
    input: z.null(),
    output: z.object({ execution: autoFixerExecutionSchema.nullable() }),
  },
  setAgentExecution: {
    input: z.object({ execution: autoFixerExecutionSchema.nullable() }),
    output: okSchema,
  },
  setDraft: {
    input: z.object({
      repo: repositorySchema,
      number: z.number().int().positive(),
      draft: z.boolean(),
    }),
    output: okSchema,
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
      items: z.array(itemSchema.extend({ autoFixer: autoFixerViewSchema })),
      preferences: autoFixerPreferencesSchema,
    }),
  },
  setAutomation: {
    input: pullRefSchema
      .extend(automationOptions)
      .strict()
      .refine(...setsAutomationOption),
    output: autoFixerViewSchema,
  },
  retryAutoFixer: { input: pullRefSchema, output: threadIdSchema },
  getAutoFixerStatus: { input: pullRefSchema, output: autoFixerViewSchema },
  autoFixerThread: {
    input: threadIdSchema,
    output: autoFixerSessionViewSchema.nullable(),
  },
  listAutoFixerSessions: {
    input: z.null(),
    output: z.object({ sessions: z.array(autoFixerSessionViewSchema) }),
  },
  getAutoFixerPreferences: {
    input: z.null(),
    output: autoFixerPreferencesSchema,
  },
  setAutoAutomation: {
    input: automationPatchSchema,
    output: autoFixerPreferencesSchema,
  },
  setAutoFixerExecution: {
    input: autoFixerExecutionSchema,
    output: autoFixerPreferencesSchema,
  },
});

type Repo = { repo: string; projectId: string | null };
type RepoOptions = z.infer<typeof giteaRpcContract.repoOptions.output>;
type TeaLogin = { name: string; user: string };
type RpcContext = { experimental_signal?: AbortSignal };
type ApiRequest = {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  body?: unknown;
  signal?: AbortSignal;
};
const agentExecutionKey = "agent-execution";
const teaHint = "Install tea 0.15.1 or newer and sign in with `tea login add`.";
const teaCandidates = ["tea", "/usr/local/bin/tea", "/opt/homebrew/bin/tea"];
const teaTimeoutMs = 15_000;
const maxConcurrentTea = 8;
const pageSize = 50;
const maxPages = 10;
const maxReviewCommentReads = 50;
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
const cacheMiBSchema = z.number().int().min(1).max(1024);

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
    cacheEntryLimitMiB: {
      type: "number",
      label: "Largest Gitea response to read and cache (MiB)",
      description:
        "Larger responses fail to load. Diffs and lists up to this size stay cached.",
      experimental_schema: cacheMiBSchema,
      default: 16,
    },
    cacheLimitMiB: {
      type: "number",
      label: "Memory for each display cache (MiB)",
      description:
        "Conversations, diffs, and lists each have a cache of this size.",
      experimental_schema: cacheMiBSchema,
      default: 64,
    },
  });
  let config = await settings.get();
  let loginLookup: Promise<TeaLogin> | null = null;
  const classifyDisplayFailure = (error: unknown): FailureScope =>
    error instanceof GiteaAccessError ? "drop-entry" : "retain";
  const publishDisplay = (item: string | null) =>
    bb.realtime.publish("display-changed", { item });
  const publishFiles = (item: string | null) =>
    bb.realtime.publish("display-changed", { item, files: true });
  const cacheBounds = (maxEntries: number): CacheBounds => ({
    maxEntries,
    maxBytes: config.cacheLimitMiB * mebibyte,
    maxEntryBytes:
      Math.min(config.cacheEntryLimitMiB, config.cacheLimitMiB) * mebibyte,
  });
  const conversations = new DisplayCache<Conversation>({
    bounds: cacheBounds(64),
    now: Date.now,
    classify: classifyDisplayFailure,
    onBackgroundSettled: publishDisplay,
  });
  const pullFiles = new DisplayCache<PullFiles>({
    bounds: cacheBounds(16),
    now: Date.now,
    classify: classifyDisplayFailure,
    onBackgroundSettled: publishFiles,
  });
  const itemLists = new DisplayCache<ItemPage>({
    bounds: cacheBounds(32),
    now: Date.now,
    classify: classifyDisplayFailure,
    onBackgroundSettled: publishDisplay,
  });
  const myPullLists = new DisplayCache<{ login: string; page: ItemPage }>({
    bounds: cacheBounds(32),
    now: Date.now,
    classify: classifyDisplayFailure,
    onBackgroundSettled: publishDisplay,
  });
  const displays = [conversations, pullFiles, itemLists, myPullLists];
  const displayEntries = [64, 16, 32, 32];
  function forgetDisplay() {
    const removed = displays.map((cache) => cache.clear());
    if (removed.includes(true)) publishDisplay(null);
  }
  function forgetDisplayItem(repo: string, number: number) {
    const tag = displayTag(repo, number);
    conversations.invalidate(tag);
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
    repoDiscovery = null;
    repoOptionCache.clear();
    displays.forEach((cache, index) =>
      cache.resize(cacheBounds(displayEntries[index]!)),
    );
    publishDisplay(null);
  });
  const repoDiscoveryTtlMs = 30_000;
  let repoDiscovery: { at: number; value: Promise<Repo[]> } | null = null;
  const repoOptionTtlMs = 60_000;
  const repoOptionCache = new Map<string, { at: number; value: RepoOptions }>();
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
            maxBuffer: config.cacheEntryLimitMiB * mebibyte,
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
      throw new Error(
        `The Gitea response exceeded the ${config.cacheEntryLimitMiB} MiB limit.`,
      );
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
          id: value.id,
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
    const reviews = page.values.map(record);
    const commented = reviews
      .filter(
        (review) =>
          Number(review.comments_count) > 0 &&
          text(review.state) !== "PENDING" &&
          Number.isInteger(review.id),
      )
      .slice(0, maxReviewCommentReads);
    const reviewComments: ReviewComment[] = [];
    for (let index = 0; index < commented.length; index += 4) {
      const batch = await Promise.all(
        commented
          .slice(index, index + 4)
          .map((review) =>
            api(
              repoPath(repo, `pulls/${number}/reviews/${review.id}/comments`),
              { signal },
            ),
          ),
      );
      for (const response of batch)
        if (Array.isArray(response))
          reviewComments.push(...response.flatMap(mapReviewComment));
    }
    return {
      truncated: page.truncated,
      reviews: reviews.map((review) => ({
        author: actor(review),
        state: text(review.state),
        body: text(review.body),
        createdAt: text(review.submitted_at),
      })),
      reviewComments,
    };
  }

  function mapReviewComment(raw: unknown): ReviewComment[] {
    const value = record(raw);
    const added = Number(value.position);
    const removed = Number(value.original_position);
    const side =
      Number.isInteger(added) && added > 0
        ? { line: added, side: "additions" as const }
        : Number.isInteger(removed) && removed > 0
          ? { line: removed, side: "deletions" as const }
          : null;
    const path = text(value.path);
    if (!side || !path || !Number.isInteger(value.id)) return [];
    return [
      {
        id: value.id as number,
        author: actor(value),
        body: text(value.body),
        createdAt: text(value.created_at),
        path,
        ...side,
        url: safeLink(cleanBaseUrl(config.baseUrl), value.html_url),
      },
    ];
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
      reviewComments: reviewPage.reviewComments,
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

  function repos(): Promise<Repo[]> {
    const now = Date.now();
    if (repoDiscovery && now - repoDiscovery.at < repoDiscoveryTtlMs)
      return repoDiscovery.value;
    const value = discoverRepos();
    repoDiscovery = { at: now, value };
    return value;
  }
  async function discoverRepos(): Promise<Repo[]> {
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
    for (let page = 1; page <= pageLimit;) {
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
    author?: string,
  ): Promise<ItemPage> {
    const discovered = repo ? [{ repo, projectId: null }] : await repos();
    const candidates = discovered.slice(0, maxListRepositories);
    const settled = await Promise.allSettled(
      candidates.map(async ({ repo: name }) => {
        const endpointPath = repoPath(
          name,
          `issues?${new URLSearchParams({
            state,
            type: kind === "pr" ? "pulls" : "issues",
            ...(author && { created_by: author }),
          })}`,
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
  async function fetchMyPulls(
    repo: string | undefined,
    state: "open" | "closed" | "all",
    signal: AbortSignal,
  ) {
    const login = await currentLogin(signal);
    const page = await fetchItems("pr", repo, state, signal, login);
    if (page.reachable === 0 && page.errors.length > 0)
      throw new Error(page.errors[0]!.message);
    return {
      login,
      page: {
        ...page,
        items: page.items.filter((item) => item.author === login),
      },
    };
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
  const autoFixerPrefix = "auto-fixer:";
  const autoFixerIntervalMs = 5 * 60_000;
  const autoFixerKey = (repo: string, number: number) =>
    `${autoFixerPrefix}${pullKey(repo, number)}`;
  const autoFixerThreadKey = (threadId: string) =>
    `auto-fixer-thread:${threadId}`;
  const autoFixerRefSchema = z.object({
    repo: repositorySchema,
    number: z.number().int().positive(),
  });
  const autoFixerQueues = new Map<string, Promise<void>>();
  let defaultsQueue: Promise<void> = Promise.resolve();
  const now = () => new Date().toISOString();
  const message = (error: unknown) =>
    error instanceof Error ? error.message : String(error);

  async function getSession(
    repo: string,
    number: number,
  ): Promise<AutoFixerSession | null> {
    return parseStoredSession(
      await bb.storage.kv.get<unknown>(autoFixerKey(repo, number)),
    );
  }

  async function getSessionByThread(
    threadId: string,
  ): Promise<AutoFixerSession | null> {
    const ref = autoFixerRefSchema.safeParse(
      await bb.storage.kv.get<unknown>(autoFixerThreadKey(threadId)),
    );
    if (!ref.success) return null;
    const session = await getSession(ref.data.repo, ref.data.number);
    return session?.threadId === threadId ? session : null;
  }

  async function listSessions(): Promise<AutoFixerSession[]> {
    const sessions: AutoFixerSession[] = [];
    for (const key of await bb.storage.kv.list(autoFixerPrefix)) {
      const session = parseStoredSession(await bb.storage.kv.get<unknown>(key));
      if (session) sessions.push(session);
    }
    return sessions.sort((left, right) =>
      right.updatedAt.localeCompare(left.updatedAt),
    );
  }

  async function setSession(session: AutoFixerSession): Promise<void> {
    await bb.storage.kv.set(
      autoFixerKey(session.repo, session.number),
      session,
    );
    await bb.storage.kv.set(autoFixerThreadKey(session.threadId), {
      repo: session.repo,
      number: session.number,
    });
    bb.realtime.publish("auto-fixer-changed", {
      repo: session.repo,
      number: session.number,
    });
  }

  async function forgetDeletedThread(threadId: string): Promise<void> {
    const current = await getSessionByThread(threadId);
    if (current !== null) {
      await bb.storage.kv.delete(autoFixerKey(current.repo, current.number));
      bb.realtime.publish("auto-fixer-changed", {
        repo: current.repo,
        number: current.number,
      });
    }
    await bb.storage.kv.delete(autoFixerThreadKey(threadId));
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
    expected: AutoFixerSession,
    next: AutoFixerSession,
  ): Promise<boolean> {
    if (
      !sameSession(expected, await getSession(expected.repo, expected.number))
    )
      return false;
    await setSession(next);
    return true;
  }

  async function agentExecution() {
    const parsed = autoFixerExecutionSchema.safeParse(
      await bb.storage.kv.get<unknown>(agentExecutionKey),
    );
    return parsed.success ? parsed.data : null;
  }

  async function getPreferences(): Promise<AutoFixerPreferences> {
    return parseStoredPreferences(
      await bb.storage.kv.get<unknown>("auto-fixer-preferences"),
    );
  }

  let preferencesUpdate: Promise<unknown> = Promise.resolve();
  function updatePreferences(
    update: (current: AutoFixerPreferences) => AutoFixerPreferences,
  ): Promise<AutoFixerPreferences> {
    const result = preferencesUpdate.then(async () => {
      const next = update(await getPreferences());
      await bb.storage.kv.set("auto-fixer-preferences", next);
      bb.realtime.publish("auto-fixer-changed", { settings: true });
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

  async function withdrawQueued(threadId: string) {
    const queued = await bb.sdk.threads.queuedMessages.list({ threadId });
    for (const entry of queued)
      if (entry.originPluginId === bb.pluginId)
        await bb.sdk.threads.queuedMessages.delete({
          threadId,
          queuedMessageId: entry.id,
        });
  }

  async function archiveAndStop(
    threadId: string,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    const failures: string[] = [];
    try {
      await withdrawQueued(threadId);
    } catch (error) {
      failures.push(`withdraw: ${message(error)}`);
    }
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
    bb.log.error(`Could not clean up Gitean auto-fixer ${threadId}: ${error}`);
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
        method: "notifyAutoFixer",
        input: { threadId, event, detail },
        outputSchema: z.object({ accepted: z.boolean() }).strict(),
      });
    } catch (error) {
      bb.log.debug(
        `Supervisor unavailable for Gitean auto-fixer ${threadId}: ${message(error)}`,
      );
    }
  }

  async function settle(
    observed: AutoFixerSession,
    decide: (current: AutoFixerSession) => Promise<AutoFixerSession | null>,
    event: "idle" | "failed",
    detail: string | null,
  ) {
    const next = await serialized(observed.repo, observed.number, async () => {
      const current = await getSession(observed.repo, observed.number);
      if (!sameSession(observed, current)) return null;
      const next = await decide(current);
      if (!next || !(await writeIfCurrent(current, next))) return null;
      const cleanup = await archiveAndStop(next.threadId);
      if (!cleanup.ok)
        await writeIfCurrent(next, onCleanupFailed(next, cleanup.error, now()));
      return next;
    });
    if (next) await notifySupervisor(next.threadId, event, detail);
  }

  async function handleIdle(
    threadId: string,
    lastText: string | null,
    observed?: AutoFixerSession,
  ) {
    const session = observed ?? (await getSessionByThread(threadId));
    if (session?.status !== "watching") return;
    await settle(
      session,
      async (current) =>
        onIdle(
          current,
          lastText,
          await readLifecycle(current.repo, current.number),
          now(),
        ),
      "idle",
      lastText,
    );
  }

  async function handleFailed(
    threadId: string,
    error: string | null,
    observed?: AutoFixerSession,
  ) {
    const session = observed ?? (await getSessionByThread(threadId));
    if (session?.status !== "watching") return;
    await settle(
      session,
      async (current) => onFailed(current, error, now()),
      "failed",
      error,
    );
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
    const result = (autoFixerQueues.get(key) ?? Promise.resolve()).then(run);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    autoFixerQueues.set(key, tail);
    void tail.then(() => {
      if (autoFixerQueues.get(key) === tail) autoFixerQueues.delete(key);
    });
    return result;
  }

  async function autoFixerPrompt(
    repo: string,
    number: number,
    title: string,
    policy: AutoFixerPolicy,
  ): Promise<string> {
    return buildAutoFixerPrompt({
      repo,
      number,
      title: title || `pull request #${number}`,
      baseUrl: cleanBaseUrl(config.baseUrl).href,
      login: (await teaLogin()).name,
      policy,
    });
  }

  async function spawnAutoFixer(
    repo: string,
    number: number,
    policy: AutoFixerPolicy,
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
      autoFixerPrompt(repo, number, title, policy),
    ]);
    const thread = await bb.sdk.threads.spawn({
      projectId: decision.projectId,
      environment: { type: "project-default" },
      visibility: "hidden",
      title: `${giteaAutoFixerTitlePrefix} ${key}: ${title}`.slice(0, 120),
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
          `Could not discard duplicate auto-fixer ${thread.id}: ${cleanup.error}`,
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
      await bb.storage.kv.delete(
        autoFixerThreadKey(decision.replaces.threadId),
      );
    await bb.storage.kv.set(`thread-link:${thread.id}`, {
      repo,
      number,
      kind: "pr",
    });
    bb.log.info(`Started Gitean auto-fixer ${thread.id} for ${key}`);
    return { threadId: thread.id };
  }

  async function resumeAutoFixer(
    session: ResumableSession,
    policy: AutoFixerPolicy,
    cleanupFirst: boolean,
  ): Promise<{ threadId: string }> {
    const { repo, number } = session;
    const result = { threadId: session.threadId };
    const presence = await readThreadPresence(session.threadId);
    if (presence.state === "deleted") {
      await forgetDeletedThread(session.threadId);
      return await spawnAutoFixer(repo, number, policy);
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
    await withdrawQueued(session.threadId);
    if (!sameSession(session, await getSession(repo, number))) return result;
    await bb.sdk.threads.send({
      threadId: session.threadId,
      mode: "start",
      input: [
        {
          type: "text",
          text: `${await autoFixerPrompt(repo, number, text(pull.title), policy)}\n\nContinue from the preserved transcript and current Gitea state.`,
          mentions: [],
        },
      ],
    });
    if (await writeIfCurrent(session, watching(session, policy, now())))
      return result;
    const latest = await getSession(repo, number);
    if (latest?.threadId === session.threadId && latest.status === "stopped")
      await finishStop(latest);
    return result;
  }

  async function updateLiveAutoFixer(
    session: Extract<AutoFixerSession, { status: "watching" }>,
    policy: AutoFixerPolicy,
  ): Promise<void> {
    const { repo, number } = session;
    const pull = record(await api(repoPath(repo, `pulls/${number}`)));
    const prompt = await autoFixerPrompt(
      repo,
      number,
      text(pull.title),
      policy,
    );
    if (!(await writeIfCurrent(session, watching(session, policy, now()))))
      throw new Error(
        `The auto-fixer for ${repo}#${number} changed while its automation was updated; try again.`,
      );
    const steer = async () => {
      await withdrawQueued(session.threadId);
      return await bb.sdk.threads.send({
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
    };
    const delivery = await steer().catch(async (error: unknown) => {
      await stopAutoFixer(repo, number);
      throw new Error(
        `Could not deliver the automation change, so the auto-fixer was stopped: ${message(error)}`,
      );
    });
    if (delivery.delivery === "sent") return;
    await stopAutoFixer(repo, number);
    throw new Error(
      `The auto-fixer for ${repo}#${number} could not take the automation change immediately, so it was stopped; turn Auto-fix or Auto-merge on again to restart it.`,
    );
  }

  function retryAutoFixer(repo: string, number: number) {
    return serialized(repo, number, async () => {
      const decision = decideRetry(await getSession(repo, number));
      if (decision.kind === "reject")
        throw new Error(
          decision.reason === "inactive"
            ? `${repo}#${number} has no auto-fixer to retry; turn on Auto-fix or Auto-merge.`
            : startError(`${repo}#${number}`, decision.reason),
        );
      if (decision.kind === "existing") return { threadId: decision.threadId };
      return await resumeAutoFixer(
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
      if (decision.kind === "stop") await stopAutoFixer(repo, number);
      if (decision.kind === "start")
        await spawnAutoFixer(repo, number, decision.policy);
      if (decision.kind === "update")
        await updateLiveAutoFixer(decision.session, decision.policy);
      if (decision.kind === "resume")
        await resumeAutoFixer(
          decision.session,
          decision.policy,
          decision.cleanupFirst,
        );
      return await autoFixerStatus(repo, number);
    });
  }

  async function stopAutoFixer(repo: string, number: number) {
    for (;;) {
      const target = decideStop(await getSession(repo, number));
      if (!target) return { ok: true as const };
      const next = stopped(target, now(), true);
      if (!(await writeIfCurrent(target, next))) continue;
      const cleanup = await finishStop(next);
      if (cleanup.ok) return { ok: true as const };
      throw new Error(`Cleanup failed: ${cleanup.error}`);
    }
  }

  async function finishStop(
    session: Extract<AutoFixerSession, { status: "stopped" }>,
  ) {
    const cleanup = await archiveAndStop(session.threadId);
    await writeIfCurrent(
      session,
      cleanup.ok
        ? stopped(session, now(), false)
        : onCleanupFailed(session, cleanup.error, now()),
    );
    return cleanup;
  }

  async function autoFixerStatus(repo: string, number: number) {
    const session = await getSession(repo, number);
    if (session !== null && session.status !== "closed")
      return autoFixerView(session, null);
    const [lifecycle, projectId] = await Promise.all([
      readLifecycle(repo, number),
      projectFor(repo),
    ]);
    return autoFixerView(session, { lifecycle, projectId });
  }

  async function currentLogin(signal?: AbortSignal): Promise<string> {
    const login = text(record(await api("user", { signal })).login);
    if (!login) throw new Error("Gitea did not report the signed-in user.");
    return login;
  }

  async function defaultPolicy() {
    const preferences = await getPreferences();
    return activePolicy({
      fix: preferences.autoFix,
      merge: preferences.autoMerge,
    });
  }

  function withDefaults<T>(run: () => Promise<T>): Promise<T> {
    const result = defaultsQueue.then(run);
    defaultsQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async function reconcileAutoAutoFixer(signal?: AbortSignal) {
    if ((await defaultPolicy()) === null) return;
    const [mine, tracked, sessions] = await Promise.all([
      readList(
        myPullLists,
        "my-prs",
        undefined,
        "open",
        true,
        (loadSignal) => fetchMyPulls(undefined, "open", loadSignal),
        signal,
      ),
      repos(),
      listSessions(),
    ]);
    const { login, page } = mine.value;
    const targets = autoStartTargets({
      login,
      pulls: page.items,
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
        await withDefaults(() =>
          serialized(target.repo, target.number, async () => {
            const policy = await defaultPolicy();
            if (policy !== null)
              await spawnAutoFixer(target.repo, target.number, policy);
          }),
        );
      } catch (error) {
        bb.log.warn(
          `Automatic Gitea auto-fixer failed for ${target.repo}#${target.number}: ${message(error)}`,
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
        else if (session.status === "stopped" && session.cleanupPending)
          await serialized(session.repo, session.number, async () => {
            const current = await getSession(session.repo, session.number);
            if (
              current?.status === "stopped" &&
              current.cleanupPending &&
              current.threadId === session.threadId
            )
              await finishStop(current);
          });
        else if (session.status !== "watching") continue;
        else if (thread.archived) await handleArchived(session.threadId);
        else if (thread.status === "idle")
          await handleIdle(
            session.threadId,
            (await bb.sdk.threads.output({ threadId: session.threadId }))
              .output,
            session,
          );
        else if (thread.status === "error")
          await handleFailed(
            session.threadId,
            "The auto-fixer thread ended in error while the Gitea plugin was not observing it.",
            session,
          );
      } catch (error) {
        bb.log.warn(
          `Could not reconcile Gitean auto-fixer ${session.threadId}: ${message(error)}`,
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
  bb.background.service("auto-fixers", {
    async start(signal) {
      while (!signal.aborted) {
        try {
          await reconcileSessions(signal);
          await reconcileAutoAutoFixer(signal);
        } catch (error) {
          if (signal.aborted) break;
          bb.log.warn(
            `Gitean auto-fixer reconciliation failed: ${message(error)}`,
          );
        }
        await new Promise<void>((resolve) => {
          const timer = setTimeout(done, autoFixerIntervalMs);
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
          reviewComments: [],
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
        reviewComments: reviewPage.reviewComments,
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
    editComment: async (
      { repo, number, id, body },
      { experimental_signal: signal }: RpcContext = {},
    ) => {
      try {
        await api(repoPath(repo, `issues/comments/${id}`), {
          method: "PATCH",
          body: { body },
          signal,
        });
      } finally {
        forgetDisplayItem(repo, number);
      }
      return { ok: true as const };
    },
    deleteComment: async (
      { repo, number, id },
      { experimental_signal: signal }: RpcContext = {},
    ) => {
      try {
        await api(repoPath(repo, `issues/comments/${id}`), {
          method: "DELETE",
          signal,
        });
      } finally {
        forgetDisplayItem(repo, number);
      }
      return { ok: true as const };
    },
    repoOptions: async (
      { repo },
      { experimental_signal: signal }: RpcContext = {},
    ) => {
      const key = repo.toLowerCase();
      const cached = repoOptionCache.get(key);
      if (cached && Date.now() - cached.at < repoOptionTtlMs)
        return cached.value;
      const [labels, assignees] = await Promise.all([
        paginated(repoPath(repo, "labels"), signal),
        api(repoPath(repo, "assignees"), { signal }),
      ]);
      const value: RepoOptions = {
        labels: labels.values
          .map((raw) => {
            const label = record(raw);
            return { name: text(label.name), color: text(label.color) };
          })
          .filter((label) => label.name),
        assignees: (Array.isArray(assignees) ? assignees : [])
          .map((user) => text(record(user).login))
          .filter(Boolean),
      };
      repoOptionCache.set(key, { at: Date.now(), value });
      return value;
    },
    reviewComment: async (
      { repo, number, commitId, path, line, side, body },
      { experimental_signal: signal }: RpcContext = {},
    ) => {
      try {
        await api(repoPath(repo, `pulls/${number}/reviews`), {
          method: "POST",
          body: {
            event: "COMMENT",
            body: "",
            commit_id: commitId,
            comments: [
              {
                path,
                body,
                new_position: side === "additions" ? line : 0,
                old_position: side === "deletions" ? line : 0,
              },
            ],
          },
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
      const execution = await agentExecution();
      const thread = await bb.sdk.threads.spawn({
        projectId: known.projectId,
        environment: { type: "project-default" },
        title: `${ref}: ${item.title}`.slice(0, 120),
        prompt: context,
        ...(execution && {
          providerId: execution.providerId,
          model: execution.model,
          reasoningLevel: execution.reasoningLevel,
          serviceTier: execution.serviceTier,
          executionInputSources: {
            providerId: "explicit",
            model: "explicit",
            reasoningLevel: "explicit",
            serviceTier: "explicit",
          },
        }),
      });
      await bb.storage.kv.set(`thread:${repo}:${number}`, thread.id);
      await bb.storage.kv.set(`thread-link:${thread.id}`, {
        repo,
        number,
        kind,
      });
      return { threadId: thread.id };
    },
    getAgentExecution: async () => ({ execution: await agentExecution() }),
    setAgentExecution: async ({ execution }) => {
      if (execution) await bb.storage.kv.set(agentExecutionKey, execution);
      else await bb.storage.kv.delete(agentExecutionKey);
      return { ok: true as const };
    },
    setDraft: async (
      { repo, number, draft },
      { experimental_signal: signal }: RpcContext = {},
    ) => {
      try {
        const path = repoPath(repo, `pulls/${number}`);
        const title = text(record(await api(path, { signal })).title);
        const next = draftTitle(title, draft);
        if (next !== title)
          await api(path, { method: "PATCH", body: { title: next }, signal });
      } finally {
        forgetDisplayItem(repo, number);
        forgetLists();
      }
      return { ok: true as const };
    },
    threadItem: async ({ threadId }) =>
      (await bb.storage.kv.get(`thread-link:${threadId}`)) ?? null,
    refresh: async () => {
      repoDiscovery = null;
      repoOptionCache.clear();
      return { repos: (await repos()).length, items: 0 };
    },
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
          (loadSignal) => fetchMyPulls(repo, state, loadSignal),
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
          autoFixer: autoFixerView(
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
    retryAutoFixer: ({ repo, number }) => retryAutoFixer(repo, number),
    getAutoFixerStatus: ({ repo, number }) => autoFixerStatus(repo, number),
    autoFixerThread: async ({ threadId }) => {
      const session = await getSessionByThread(threadId);
      return session && sessionView(session);
    },
    listAutoFixerSessions: async () => ({
      sessions: (await listSessions()).map(sessionView),
    }),
    getAutoFixerPreferences: () => getPreferences(),
    setAutoAutomation: async (patch) => {
      const preferences = await withDefaults(() =>
        updatePreferences((current) => {
          const next = applyAutomationPatch(
            { fix: current.autoFix, merge: current.autoMerge },
            patch,
          );
          return { ...current, autoFix: next.fix, autoMerge: next.merge };
        }),
      );
      if (preferences.autoFix || preferences.autoMerge)
        await reconcileAutoAutoFixer().catch((error: unknown) =>
          bb.log.warn(`Automatic Gitea auto-fixing failed: ${message(error)}`),
        );
      return preferences;
    },
    setAutoFixerExecution: (execution) =>
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
        name: "line-comment",
        summary: "Comment on one line of a pull request diff",
        usage:
          "bb gitea line-comment <owner/repo> <number> <path> <line> [--old] <body>",
      },
      {
        name: "comment-edit",
        summary: "Replace the body of a conversation comment",
        usage:
          "bb gitea comment-edit <owner/repo> <number> <comment-id> <body>",
      },
      {
        name: "comment-delete",
        summary: "Delete a conversation comment",
        usage: "bb gitea comment-delete <owner/repo> <number> <comment-id>",
      },
      {
        name: "options",
        summary: "List a repository's labels and assignable users",
        usage: "bb gitea options <owner/repo> [--json]",
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
        name: "draft",
        summary: "Mark a pull request as a draft or ready for review",
        usage: "bb gitea draft <owner/repo> <number> on|off",
      },
      {
        name: "agent-execution",
        summary: "Show or set the model for send-agent threads",
        usage:
          "bb gitea agent-execution [<provider> <model> <reasoning> [fast|default] | default] [--json]",
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
        name: "auto-fixer-status",
        summary:
          "Show a pull request's Auto-fix, Auto-merge, and auto-fixer state",
        usage: "bb gitea auto-fixer-status <owner/repo> <number> [--json]",
      },
      {
        name: "auto-fixer-retry",
        summary: "Resume a failed or waiting auto-fixer",
        usage: "bb gitea auto-fixer-retry <owner/repo> <number> [--json]",
      },
      {
        name: "auto-fixer-thread",
        summary: "Show the auto-fixer session owned by a BB thread",
        usage: "bb gitea auto-fixer-thread <thread-id> [--json]",
      },
      {
        name: "auto-fixers",
        summary: "List retained auto-fixer sessions",
        usage: "bb gitea auto-fixers [--json]",
      },
      {
        name: "automation-defaults",
        summary:
          "Show or set whether Auto-fix and Auto-merge turn on automatically for your pull requests",
        usage: "bb gitea automation-defaults [fix|merge on|off] [--json]",
      },
      {
        name: "auto-fixer-execution",
        summary:
          "Set the provider, model, reasoning, and tier for new auto-fixers",
        usage:
          "bb gitea auto-fixer-execution <provider> <model> <reasoning> [fast|default] [--json]",
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
      const old = args.includes("--old");
      const positional = args.filter(
        (value) =>
          value !== "--json" && value !== "--refresh" && value !== "--old",
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
        if (command === "line-comment") {
          const [repo, number] = values;
          const { revision } = await readPull(
            repositorySchema.parse(repo),
            Number(number),
            undefined,
          );
          const input = giteaRpcContract.reviewComment.input.parse({
            repo,
            number: Number(number),
            commitId: revision.head,
            path: values[2],
            line: Number(values[3]),
            side: old ? "deletions" : "additions",
            body: values.slice(4).join(" "),
          });
          const value = await handlers.reviewComment(input);
          return succeed(
            value,
            `Commented on ${input.path}:${input.line} in ${input.repo}#${input.number}`,
          );
        }
        if (command === "comment-edit") {
          const input = giteaRpcContract.editComment.input.parse({
            repo: values[0],
            number: Number(values[1]),
            id: Number(values[2]),
            body: values.slice(3).join(" "),
          });
          const value = await handlers.editComment(input);
          return succeed(
            value,
            `Edited comment ${input.id} on ${input.repo}#${input.number}`,
          );
        }
        if (command === "comment-delete") {
          const input = giteaRpcContract.deleteComment.input.parse({
            repo: values[0],
            number: Number(values[1]),
            id: Number(values[2]),
          });
          const value = await handlers.deleteComment(input);
          return succeed(
            value,
            `Deleted comment ${input.id} on ${input.repo}#${input.number}`,
          );
        }
        if (command === "options") {
          const input = giteaRpcContract.repoOptions.input.parse({
            repo: values[0],
          });
          const value = await handlers.repoOptions(input);
          return succeed(
            value,
            `Labels: ${value.labels.map((label) => label.name).join(", ") || "none"}\nAssignees: ${value.assignees.join(", ") || "none"}`,
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
          view: z.infer<typeof autoFixerViewSchema>,
          ref: string,
        ) =>
          `${ref} ${view.status} · Auto-fix ${onOff(view.automation.fix)} · Auto-merge ${onOff(view.automation.merge)}${"threadId" in view ? ` thread ${view.threadId}` : ""}${view.status === "failed" ? `\n${view.error}` : ""}${view.status === "needs_you" && view.note ? `\n${view.note}` : ""}`;
        const pullRef = () =>
          pullRefSchema.parse({ repo: values[0], number: Number(values[1]) });
        const describePreferences = (value: AutoFixerPreferences) =>
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
            `${value.items.map((entry) => `${entry.repo}#${entry.number} ${entry.state} fix:${onOff(entry.autoFixer.automation.fix)} merge:${onOff(entry.autoFixer.automation.merge)} auto-fixer:${entry.autoFixer.status} ${entry.title}`).join("\n") || "No pull requests authored by you."}${value.truncated ? "\nResults are capped; narrow the repository or query." : ""}${value.errors.map((entry) => `\n${entry.repo}: ${entry.message}`).join("")}`,
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
        if (command === "auto-fixer-retry") {
          const input = pullRef();
          const value = await handlers.retryAutoFixer(input);
          return succeed(
            value,
            `Auto-fixer for ${input.repo}#${input.number} is thread ${value.threadId}`,
          );
        }
        if (command === "auto-fixer-status") {
          const input = pullRef();
          const value = await handlers.getAutoFixerStatus(input);
          return succeed(
            value,
            describe(value, `${input.repo}#${input.number}`),
          );
        }
        if (command === "auto-fixer-thread") {
          const value = await handlers.autoFixerThread(
            threadIdSchema.parse({ threadId: values[0] }),
          );
          return succeed(
            value,
            value
              ? describe(value, `${value.repo}#${value.number}`)
              : "No Gitean auto-fixer owns this thread.",
          );
        }
        if (command === "auto-fixers") {
          const value = await handlers.listAutoFixerSessions();
          return succeed(
            value,
            value.sessions
              .map((session) =>
                describe(session, `${session.repo}#${session.number}`),
              )
              .join("\n") || "No auto-fixer sessions.",
          );
        }
        if (command === "automation-defaults") {
          const value =
            values[0] === undefined
              ? await handlers.getAutoFixerPreferences()
              : await handlers.setAutoAutomation(
                  giteaRpcContract.setAutoAutomation.input.parse({
                    [z.enum(["fix", "merge"]).parse(values[0])]: switchValue(
                      values[1],
                    ),
                  }),
                );
          return succeed(value, describePreferences(value));
        }
        if (command === "draft") {
          const input = giteaRpcContract.setDraft.input.parse({
            repo: values[0],
            number: Number(values[1]),
            draft: switchValue(values[2]),
          });
          const value = await handlers.setDraft(input);
          return succeed(
            value,
            `${input.repo}#${input.number} is ${input.draft ? "a draft" : "ready for review"}`,
          );
        }
        if (command === "agent-execution") {
          if (values.length === 1 && values[0] === "default") {
            await handlers.setAgentExecution({ execution: null });
          } else if (values.length >= 3 && values.length <= 4) {
            await handlers.setAgentExecution({
              execution: autoFixerExecutionSchema.parse({
                providerId: values[0],
                model: values[1],
                reasoningLevel: values[2],
                serviceTier: values[3] ?? "default",
              }),
            });
          } else if (values.length !== 0) {
            return {
              exitCode: 1,
              stderr:
                "agent-execution takes: [provider model reasoning [fast|default] | default]",
            };
          }
          const value = await handlers.getAgentExecution();
          return succeed(
            value,
            value.execution
              ? `Agent threads use ${value.execution.providerId} ${value.execution.model} ${value.execution.reasoningLevel} ${value.execution.serviceTier}`
              : "Agent threads use the project default model",
          );
        }
        if (command === "auto-fixer-execution") {
          if (values.length < 3 || values.length > 4)
            return {
              exitCode: 1,
              stderr:
                "auto-fixer-execution requires: provider model reasoning [fast|default]",
            };
          const value = await handlers.setAutoFixerExecution(
            autoFixerExecutionSchema.parse({
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
