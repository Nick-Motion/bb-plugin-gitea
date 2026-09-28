import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  definePluginApp,
  experimental_ProviderModelPicker as ProviderModelPicker,
  useBbNavigate,
  useRealtime,
  useRpc,
  UrlLink,
  type ExperimentalProviderModelPickerValue,
  type PluginNavPanelProps,
  type PluginThreadPanelProps,
} from "@get-bb/plugin-sdk/app";
import type { PluginRpcResult } from "@get-bb/plugin-sdk/app";
import type { giteaRpcContract } from "./server.js";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "sonner";
import {
  parsePatchFiles,
  type FileDiffMetadata,
  type FileDiffOptions,
} from "@pierre/diffs";
import { FileDiff as PierreFileDiff } from "@pierre/diffs/react";

type Item = PluginRpcResult<
  (typeof giteaRpcContract)["listItems"]
>["items"][number];
type ConversationView = PluginRpcResult<
  (typeof giteaRpcContract)["conversation"]
>;
type FilesView = PluginRpcResult<(typeof giteaRpcContract)["pullFiles"]>;
type FileEntry = FilesView["files"][number];
type FileDiff = FileEntry["diff"];
type Freshness = ConversationView["freshness"];
type ItemRef = { kind: "issue" | "pr"; repo: string; number: number };
type Loadable<T> =
  | { state: "loading" }
  | { state: "ready"; value: T }
  | { state: "error"; message: string };
type Keyed<T> = { key: string; view: Loadable<T> };
type MyPulls = PluginRpcResult<(typeof giteaRpcContract)["listMyPullRequests"]>;
type Preferences = MyPulls["preferences"];
type BabysitView = MyPulls["items"][number]["babysit"];
type BabysitSessions = PluginRpcResult<
  (typeof giteaRpcContract)["listBabysitSessions"]
>["sessions"];
type View = "my-prs" | "babysitters" | "issues" | "pulls";
type DetailSection = "conversation" | "files";

function useIsDarkTheme() {
  const [dark, setDark] = useState(() =>
    document.documentElement.classList.contains("dark"),
  );
  useEffect(() => {
    const observer = new MutationObserver(() =>
      setDark(document.documentElement.classList.contains("dark")),
    );
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });
    return () => observer.disconnect();
  }, []);
  return dark;
}

function formatBytes(bytes: number) {
  return bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
    : `${Math.ceil(bytes / 1024)} KiB`;
}

const unavailableText = {
  missing: "Gitea's raw diff has no section that matches this file.",
  stale:
    "The pull request changed while its files were loading. Reload to see a consistent diff.",
  "diff-too-large":
    "The pull request's raw diff exceeds the 16 MiB limit, so per-file diffs are not shown here.",
  "diff-failed": "Gitea did not return the raw diff for this pull request.",
} as const;

function DiffNotice({
  children,
  filesUrl,
}: {
  children: string;
  filesUrl: string;
}) {
  return (
    <div
      data-testid="bb-diff-notice"
      className="flex flex-wrap items-center gap-2 px-3 py-2 text-xs text-muted-foreground"
    >
      <span>{children}</span>
      {filesUrl && (
        <UrlLink href={filesUrl} className="underline hover:text-foreground">
          View on Gitea ↗
        </UrlLink>
      )}
    </div>
  );
}

function GiteaDiff({
  path,
  diff,
  filesUrl,
}: {
  path: string;
  diff: FileDiff;
  filesUrl: string;
}) {
  if (diff.kind === "text") return <PatchView path={path} patch={diff.patch} />;
  if (diff.kind === "empty")
    return (
      <DiffNotice filesUrl="">
        No content changes (rename or mode change only).
      </DiffNotice>
    );
  if (diff.kind === "binary")
    return <DiffNotice filesUrl={filesUrl}>Binary file changed.</DiffNotice>;
  if (diff.kind === "too-large")
    return (
      <DiffNotice filesUrl={filesUrl}>
        {`This file's diff is ${formatBytes(diff.bytes)}, above the ${formatBytes(diff.limit)} inline limit.`}
      </DiffNotice>
    );
  return (
    <DiffNotice filesUrl={filesUrl}>{unavailableText[diff.reason]}</DiffNotice>
  );
}

function PatchView({ path, patch }: { path: string; patch: string }) {
  const dark = useIsDarkTheme();
  const fileDiff = useMemo<FileDiffMetadata | null>(() => {
    const normalized = patch.replace(/\r\n/g, "\n").trimEnd();
    const text = normalized.startsWith("diff --git")
      ? `${normalized}\n`
      : `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n${normalized}\n`;
    try {
      return parsePatchFiles(text)[0]?.files[0] ?? null;
    } catch {
      return null;
    }
  }, [path, patch]);
  const options = useMemo<FileDiffOptions<undefined>>(
    () => ({
      diffStyle: "unified",
      overflow: "scroll",
      disableFileHeader: true,
      themeType: dark ? "dark" : "light",
    }),
    [dark],
  );
  if (!fileDiff)
    return (
      <pre className="overflow-x-auto px-3 py-2 font-mono text-xs leading-5 text-foreground/80">
        {patch}
      </pre>
    );
  return (
    <div data-testid="bb-diff" data-path={path}>
      <PierreFileDiff fileDiff={fileDiff} options={options} />
    </div>
  );
}

function filesUrl(item: { url: string }) {
  return item.url ? `${item.url.replace(/\/+$/, "")}/files` : "";
}

function DiffBanner({ files }: { files: FileEntry[] }) {
  const reasons = new Set(
    files.flatMap((file) =>
      file.diff.kind === "unavailable" ? [file.diff.reason] : [],
    ),
  );
  const notices = (["stale", "diff-too-large", "diff-failed"] as const).filter(
    (reason) => reasons.has(reason),
  );
  if (!notices.length) return null;
  return (
    <div
      role="status"
      className="rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground"
    >
      {notices.map((reason) => (
        <div key={reason}>{unavailableText[reason]}</div>
      ))}
    </div>
  );
}

function itemKey(item: Pick<Item, "repo" | "number">) {
  return `${item.repo}#${item.number}`;
}

function itemTag(item: Pick<Item, "repo" | "number">) {
  return `${item.repo.toLowerCase()}#${item.number}`;
}

function changedItem(payload: unknown): string | null | undefined {
  if (typeof payload !== "object" || payload === null || !("item" in payload))
    return undefined;
  const { item } = payload;
  return item === null || typeof item === "string" ? item : undefined;
}

function errorText(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

const loading = { state: "loading" } as const;

function useItemDisplay(target: ItemRef | null, wantFiles: boolean) {
  const rpc = useRpc<typeof giteaRpcContract>();
  const key = target ? `${target.kind}:${itemTag(target)}` : null;
  const [conversation, setConversation] =
    useState<Keyed<ConversationView> | null>(null);
  const [files, setFiles] = useState<Keyed<FilesView> | null>(null);
  const conversationRun = useRef(0);
  const filesRun = useRef(0);
  const loadConversation = useCallback(
    async (refresh: boolean) => {
      if (!target || !key) return;
      const run = ++conversationRun.current;
      let view: Loadable<ConversationView>;
      try {
        view = {
          state: "ready",
          value: await rpc.call("conversation", { ...target, refresh }),
        };
      } catch (error) {
        view = {
          state: "error",
          message: errorText(error, "Could not load item"),
        };
      }
      if (run === conversationRun.current) setConversation({ key, view });
    },
    [key, rpc, target],
  );
  useEffect(() => {
    void loadConversation(false);
    return () => {
      conversationRun.current += 1;
    };
  }, [loadConversation]);
  const shown = conversation?.key === key ? conversation.view : loading;
  const revision =
    shown.state === "ready" && shown.value.conversation.kind === "pr"
      ? shown.value.conversation.revision
      : null;
  const filesKey =
    key && revision ? `${key}@${revision.head}:${revision.base}` : null;
  const loadFiles = useCallback(
    async (refresh: boolean) => {
      if (!target || !filesKey || !revision) return;
      const run = ++filesRun.current;
      let view: Loadable<FilesView>;
      try {
        view = {
          state: "ready",
          value: await rpc.call("pullFiles", {
            repo: target.repo,
            number: target.number,
            revision,
            refresh,
          }),
        };
      } catch (error) {
        view = {
          state: "error",
          message: errorText(error, "Could not load changed files"),
        };
      }
      if (run === filesRun.current) setFiles({ key: filesKey, view });
    },
    [filesKey, rpc, target],
  );
  useEffect(() => {
    if (!wantFiles) return;
    void loadFiles(false);
    return () => {
      filesRun.current += 1;
    };
  }, [loadFiles, wantFiles]);
  const onChange = useCallback(
    (payload: unknown) => {
      const item = changedItem(payload);
      if (item === undefined || !target) return;
      if (item !== null && item !== itemTag(target)) return;
      void loadConversation(false);
      if (wantFiles) void loadFiles(false);
    },
    [loadConversation, loadFiles, target, wantFiles],
  );
  useRealtime("display-changed", onChange);
  const shownFiles = files?.key === filesKey ? files.view : loading;
  const filesMoved =
    shownFiles.state === "ready" &&
    revision !== null &&
    (shownFiles.value.revision.head !== revision.head ||
      shownFiles.value.revision.base !== revision.base);
  return {
    conversation: shown,
    files: shownFiles,
    filesMoved,
    reload: () => loadConversation(false),
    refresh: async () => {
      await loadConversation(true);
      if (wantFiles) await loadFiles(true);
    },
  };
}

function FreshnessNote({
  freshness,
  onRefresh,
}: {
  freshness: Freshness;
  onRefresh: () => void;
}) {
  const time = new Date(freshness.fetchedAt).toLocaleTimeString();
  return (
    <span
      data-testid="bb-freshness"
      data-state={freshness.state}
      className="flex shrink-0 items-center gap-1"
      title={freshness.state === "stale-error" ? freshness.error : undefined}
    >
      {freshness.state === "fresh"
        ? `Updated ${time}`
        : freshness.state === "refreshing"
          ? `Updating · shown from ${time}`
          : `Refresh failed · shown from ${time}`}
      <Button
        size="sm"
        variant="ghost"
        className="h-7 px-2"
        onClick={onRefresh}
      >
        Refresh
      </Button>
    </span>
  );
}

function FilesList({
  files,
  url,
  moved,
  compact,
}: {
  files: Loadable<FilesView>;
  url: string;
  moved: boolean;
  compact: boolean;
}) {
  if (files.state === "loading")
    return (
      <div className="space-y-2" data-testid="bb-files-loading">
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  if (files.state === "error")
    return <p className="text-xs text-muted-foreground">{files.message}</p>;
  if (moved)
    return (
      <p role="status" className="text-xs text-muted-foreground">
        This pull request changed since its conversation loaded. Loading the
        latest revision…
      </p>
    );
  const { value } = files;
  return (
    <>
      {value.filesTruncated && (
        <p className="text-xs text-muted-foreground">
          The file list reached the 100-file cap and may be incomplete.
        </p>
      )}
      {value.freshness.state === "stale-error" && (
        <p role="status" className="text-xs text-muted-foreground">
          Showing files from{" "}
          {new Date(value.freshness.fetchedAt).toLocaleTimeString()}. Gitea
          refresh failed: {value.freshness.error}
        </p>
      )}
      <DiffBanner files={value.files} />
      {value.files.map((file) =>
        compact ? (
          <details key={file.path} className="border-b py-2">
            <summary className="cursor-pointer">{file.path}</summary>
            <div className="mt-2 overflow-hidden rounded-md border border-border bg-card">
              <GiteaDiff path={file.path} diff={file.diff} filesUrl={url} />
            </div>
          </details>
        ) : (
          <article
            key={file.path}
            className="overflow-hidden rounded-lg border border-border bg-card"
          >
            <div className="flex items-center gap-2 border-b border-border bg-muted/50 px-3 py-2 text-xs">
              <span className="min-w-0 flex-1 truncate font-mono">
                {file.previousPath
                  ? `${file.previousPath} → ${file.path}`
                  : file.path}
              </span>
              <span className="text-green-600 dark:text-green-400">
                +{file.additions}
              </span>
              <span className="text-red-600 dark:text-red-400">
                −{file.deletions}
              </span>
              <Badge variant="secondary">{file.status}</Badge>
            </div>
            <GiteaDiff path={file.path} diff={file.diff} filesUrl={url} />
          </article>
        ),
      )}
    </>
  );
}

function parseSubPath(
  subPath: string,
): { kind: "issue" | "pr"; repo: string; number: number } | null {
  const parts = subPath.split("/").filter(Boolean);
  if ((parts[0] !== "issues" && parts[0] !== "pulls") || parts.length !== 4)
    return null;
  const number = Number(parts[3]);
  if (!Number.isSafeInteger(number) || number < 1) return null;
  return {
    kind: parts[0] === "issues" ? "issue" : "pr",
    repo: `${parts[1]}/${parts[2]}`,
    number,
  };
}

const babysitLabels = {
  idle: "not babysat",
  watching: "babysitting",
  needs_you: "needs you",
  failed: "failed",
  merged: "merged",
  closed: "closed",
  stopped: "stopped",
} as const;

function babysitDetail(view: BabysitView) {
  if (view.status === "failed") return view.error;
  if (view.status === "needs_you") return view.note;
  return "";
}

function BabysitControls({
  repo,
  number,
  view,
  onChanged,
}: {
  repo: string;
  number: number;
  view: BabysitView;
  onChanged: () => void;
}) {
  const rpc = useRpc<typeof giteaRpcContract>();
  const navigate = useBbNavigate();
  const [busy, setBusy] = useState(false);
  const run = async (action: BabysitView["actions"][number]) => {
    setBusy(true);
    try {
      if (action === "stop") await rpc.call("stopBabysit", { repo, number });
      else
        await rpc.call(action === "start" ? "startBabysit" : "retryBabysit", {
          repo,
          number,
        });
      toast.success(
        action === "stop"
          ? "Babysitter stopped"
          : action === "start"
            ? "Babysitter started"
            : "Babysitter resumed",
      );
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Babysitter action failed",
      );
    } finally {
      setBusy(false);
      onChanged();
    }
  };
  const detail = babysitDetail(view);
  return (
    <span
      data-testid="babysit-controls"
      className="flex shrink-0 flex-wrap items-center gap-1"
    >
      {view.status !== "idle" && (
        <Badge
          variant={view.status === "failed" ? "destructive" : "secondary"}
          title={detail || undefined}
        >
          {babysitLabels[view.status]}
        </Badge>
      )}
      {"threadId" in view && (
        <Button
          size="sm"
          variant="link"
          className="h-7 px-1"
          onClick={() => navigate.toThread(view.threadId)}
        >
          Thread
        </Button>
      )}
      {view.actions.map((action) => (
        <Button
          key={action}
          size="sm"
          variant={action === "stop" ? "outline" : "default"}
          className="h-7"
          disabled={busy}
          onClick={() => void run(action)}
        >
          {action === "start"
            ? "Babysit"
            : action === "stop"
              ? "Stop"
              : "Retry"}
        </Button>
      ))}
    </span>
  );
}

function BabysitPreferencesControl() {
  const rpc = useRpc<typeof giteaRpcContract>();
  const [loaded, setLoaded] = useState<
    | { state: "loading" }
    | { state: "ready"; preferences: Preferences }
    | { state: "error"; message: string }
  >({ state: "loading" });
  const [saving, setSaving] = useState(false);
  const load = useCallback(() => {
    void rpc
      .call("getBabysitPreferences", null)
      .then((preferences) => setLoaded({ state: "ready", preferences }))
      .catch((error: unknown) =>
        setLoaded({
          state: "error",
          message: error instanceof Error ? error.message : String(error),
        }),
      );
  }, [rpc]);
  useEffect(load, [load]);
  useRealtime("babysit-changed", load);
  if (loaded.state === "loading") return null;
  if (loaded.state === "error")
    return (
      <div
        role="alert"
        className="flex flex-wrap items-center gap-2 text-xs text-destructive"
      >
        Could not load babysitter settings: {loaded.message}
        <Button
          size="sm"
          variant="outline"
          className="h-7"
          onClick={() => {
            setLoaded({ state: "loading" });
            load();
          }}
        >
          Retry
        </Button>
      </div>
    );
  const { preferences } = loaded;
  const setPreferences = (next: Preferences) =>
    setLoaded({ state: "ready", preferences: next });
  const save = async (
    update: () => Promise<Preferences>,
    optimistic: Preferences,
  ) => {
    const previous = preferences;
    setPreferences(optimistic);
    setSaving(true);
    try {
      setPreferences(await update());
    } catch (error) {
      setPreferences(previous);
      toast.error(
        error instanceof Error ? error.message : "Could not save settings",
      );
    } finally {
      setSaving(false);
    }
  };
  const execution: ExperimentalProviderModelPickerValue = preferences.execution;
  return (
    <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          aria-label="Automatically babysit my pull requests"
          checked={preferences.autoBabysit}
          disabled={saving}
          onChange={(event) => {
            const enabled = event.target.checked;
            void save(() => rpc.call("setAutoBabysit", { enabled }), {
              ...preferences,
              autoBabysit: enabled,
            });
          }}
        />
        Auto-babysit my PRs in BB projects
      </label>
      <ProviderModelPicker
        value={execution}
        disabled={saving}
        align="end"
        onChange={(value) => {
          const next = {
            ...value,
            serviceTier: value.serviceTier ?? "default",
          };
          void save(() => rpc.call("setBabysitExecution", next), {
            ...preferences,
            execution: next,
          });
        }}
      />
    </div>
  );
}

function BabysitterSessions() {
  const rpc = useRpc<typeof giteaRpcContract>();
  const navigate = useBbNavigate();
  const [sessions, setSessions] = useState<BabysitSessions | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    void rpc
      .call("listBabysitSessions", null)
      .then((result) => {
        setSessions(result.sessions);
        setError(null);
      })
      .catch((reason: unknown) =>
        setError(
          reason instanceof Error
            ? reason.message
            : "Could not load babysitter sessions",
        ),
      );
  }, [rpc]);
  useEffect(load, [load]);
  useRealtime("babysit-changed", load);
  if (error)
    return (
      <div role="alert" className="p-8 text-center text-muted-foreground">
        {error}
      </div>
    );
  if (!sessions) return <Skeleton className="h-24 w-full" />;
  if (!sessions.length)
    return (
      <div className="rounded-lg border border-border bg-card p-8 text-center text-muted-foreground">
        No babysitter sessions yet. Start one from My PRs.
      </div>
    );
  return (
    <div className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
      {sessions.map((session) => (
        <div
          key={`${session.repo}#${session.number}`}
          data-testid="babysit-session"
          className="flex flex-col gap-2 px-3 py-3 sm:flex-row sm:items-center"
        >
          <button
            className="flex min-w-0 flex-1 cursor-pointer flex-col items-start text-left"
            onClick={() =>
              navigate.toPluginPanel("gitea", {
                subPath: `pulls/${session.repo}/${session.number}`,
              })
            }
          >
            <span className="font-medium text-foreground">
              {session.repo}#{session.number}
            </span>
            <span className="text-xs text-muted-foreground">
              {session.updatedAt}
            </span>
            {babysitDetail(session) && (
              <span className="line-clamp-2 text-xs text-muted-foreground">
                {babysitDetail(session)}
              </span>
            )}
          </button>
          <BabysitControls
            repo={session.repo}
            number={session.number}
            view={session}
            onChanged={load}
          />
        </div>
      ))}
    </div>
  );
}

function GiteaPanel({ subPath }: PluginNavPanelProps) {
  const rpc = useRpc<typeof giteaRpcContract>();
  const navigate = useBbNavigate();
  const [view, setView] = useState<View>("my-prs");
  const [state, setState] = useState<"open" | "closed" | "all">("open");
  const [repo, setRepo] = useState("all");
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<Item[]>([]);
  const [babysits, setBabysits] = useState<Map<string, BabysitView>>(
    () => new Map(),
  );
  const [listNotice, setListNotice] = useState<{
    truncated: boolean;
    errors: Array<{ repo: string; message: string }>;
  }>({ truncated: false, errors: [] });
  const [listError, setListError] = useState<string | null>(null);
  const [status, setStatus] = useState<{
    ready: boolean;
    error: string | null;
    login: string | null;
    repos: Array<{ repo: string; projectId: string | null }>;
  }>();
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState("");
  const [newIssue, setNewIssue] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [newBody, setNewBody] = useState("");
  const [reviewBody, setReviewBody] = useState("");
  const [detailSection, setDetailSection] =
    useState<DetailSection>("conversation");
  const route = useMemo(() => parseSubPath(subPath), [subPath]);
  const display = useItemDisplay(route, detailSection === "files");
  const shown = display.conversation;
  const detail = useMemo(
    () =>
      shown.state === "ready"
        ? { ...shown.value.conversation, threadId: shown.value.threadId }
        : null,
    [shown],
  );
  const detailError = shown.state === "error" ? shown.message : null;
  const [labelsDraft, setLabelsDraft] = useState("");
  const [assigneesDraft, setAssigneesDraft] = useState("");
  useEffect(() => {
    setLabelsDraft(detail?.labels.join(", ") ?? "");
    setAssigneesDraft(detail?.assignees.join(", ") ?? "");
  }, [detail]);

  const loadStatus = useCallback(async () => {
    try {
      setStatus(await rpc.call("status", null));
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Could not connect to Gitea",
      );
    }
  }, [rpc]);
  const loadItems = useCallback(async () => {
    if (view === "babysitters") return;
    setLoading(true);
    try {
      const filters = { state, query, ...(repo === "all" ? {} : { repo }) };
      const mine =
        view === "my-prs"
          ? await rpc.call("listMyPullRequests", filters)
          : null;
      const result =
        mine ??
        (await rpc.call("listItems", {
          kind: view === "issues" ? "issue" : "pr",
          ...filters,
        }));
      setItems(result.items);
      setBabysits(
        new Map(
          (mine?.items ?? []).map(
            (item) => [itemKey(item), item.babysit] as const,
          ),
        ),
      );
      setListNotice({ truncated: result.truncated, errors: result.errors });
      setListError(null);
    } catch (error) {
      setListError(
        error instanceof Error ? error.message : "Could not load Gitea items",
      );
    } finally {
      setLoading(false);
    }
  }, [rpc, view, state, query, repo]);
  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);
  useEffect(() => {
    void loadItems();
  }, [loadItems]);
  const reloadBabysits = useCallback(() => {
    if (view === "my-prs") void loadItems();
  }, [loadItems, view]);
  useRealtime("babysit-changed", reloadBabysits);
  const openItem = useCallback(
    async (item: Item) => {
      navigate.toPluginPanel("gitea", {
        subPath: `${item.kind === "pr" ? "pulls" : "issues"}/${item.repo}/${item.number}`,
      });
    },
    [navigate],
  );
  const { reload: refreshDetail } = display;
  useEffect(() => {
    if (!route) {
      setNewIssue(subPath === "new");
      if (subPath === "new") setView("issues");
      return;
    }
    setView(route.kind === "pr" ? "pulls" : "issues");
    setDetailSection("conversation");
  }, [route, subPath]);
  const refresh = useCallback(async () => {
    await loadStatus();
    await loadItems();
  }, [loadItems, loadStatus]);
  const submitComment = useCallback(async () => {
    if (!detail || !draft.trim()) return;
    try {
      await rpc.call("comment", {
        repo: detail.repo,
        number: detail.number,
        body: draft,
      });
      setDraft("");
      await refreshDetail();
      toast.success("Comment added");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Comment failed");
    }
  }, [detail, draft, refreshDetail, rpc]);
  const setItemState = useCallback(
    async (next: "open" | "closed") => {
      if (!detail) return;
      try {
        await rpc.call("setState", {
          repo: detail.repo,
          number: detail.number,
          state: next,
        });
        await refreshDetail();
        await loadItems();
        toast.success(next === "closed" ? "Closed" : "Reopened");
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Update failed");
      }
    },
    [detail, loadItems, refreshDetail, rpc],
  );
  const submitReview = useCallback(
    async (event: "APPROVED" | "REQUEST_CHANGES" | "COMMENT") => {
      if (!detail || detail.kind !== "pr") return;
      try {
        await rpc.call("review", {
          repo: detail.repo,
          number: detail.number,
          event,
          body: reviewBody,
        });
        setReviewBody("");
        await refreshDetail();
        toast.success("Review submitted");
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Review failed");
      }
    },
    [detail, refreshDetail, reviewBody, rpc],
  );
  const sendAgent = useCallback(async () => {
    if (!detail) return;
    try {
      const result = await rpc.call("sendAgent", {
        repo: detail.repo,
        number: detail.number,
        kind: detail.kind,
      });
      await refreshDetail();
      navigate.toThread(result.threadId);
      toast.success("BB agent thread created");
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Could not start an agent thread",
      );
    }
  }, [detail, navigate, openItem, refreshDetail, rpc]);
  const saveMetadata = useCallback(async () => {
    if (!detail) return;
    try {
      await rpc.call("updateMetadata", {
        repo: detail.repo,
        number: detail.number,
        labels: labelsDraft
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean),
        assignees: assigneesDraft
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean),
      });
      await refreshDetail();
      toast.success("Labels and assignees updated");
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Metadata update failed",
      );
    }
  }, [assigneesDraft, detail, labelsDraft, refreshDetail, rpc]);
  const repoOptions = useMemo(() => status?.repos ?? [], [status]);
  const create = useCallback(async () => {
    if (repo === "all") return toast.error("Choose a repository first");
    try {
      const result = await rpc.call("createIssue", {
        repo,
        title: newTitle,
        body: newBody,
      });
      setNewIssue(false);
      setNewTitle("");
      setNewBody("");
      await loadItems();
      await openItem(result);
      toast.success("Issue created");
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Issue creation failed",
      );
    }
  }, [loadItems, newBody, newTitle, openItem, repo, rpc]);

  const visibleItems = items;
  const count = visibleItems.filter((item) => item.state === "open").length;
  if (newIssue) {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto p-4 text-sm md:p-5">
        <div className="mx-auto w-full max-w-2xl space-y-4">
          <div className="flex items-center gap-1 text-xs text-muted-foreground">
            <Button
              size="sm"
              variant="ghost"
              className="h-7 px-2"
              onClick={() => navigate.toPluginPanel("gitea")}
            >
              ← Issues
            </Button>
            <span>New issue</span>
          </div>
          {!status?.ready && (
            <div className="rounded-md border border-border bg-muted/30 p-3 text-muted-foreground">
              {status?.error ?? "Checking Gitea configuration…"}
            </div>
          )}
          <div className="space-y-3 rounded-lg border border-border bg-card p-4">
            <h2 className="text-lg font-semibold">Create an issue</h2>
            <Select value={repo} onValueChange={setRepo}>
              <SelectTrigger aria-label="Repository">
                <SelectValue placeholder="Choose a repository" />
              </SelectTrigger>
              <SelectContent>
                {repoOptions.map((entry) => (
                  <SelectItem key={entry.repo} value={entry.repo}>
                    {entry.repo}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Input
              aria-label="Issue title"
              value={newTitle}
              onChange={(event) => setNewTitle(event.target.value)}
              placeholder="Issue title"
            />
            <Textarea
              aria-label="Issue description"
              value={newBody}
              onChange={(event) => setNewBody(event.target.value)}
              placeholder="Describe the issue"
            />
            <div className="flex justify-end gap-2">
              <Button
                variant="outline"
                onClick={() => navigate.toPluginPanel("gitea")}
              >
                Cancel
              </Button>
              <Button
                disabled={!newTitle.trim() || repo === "all"}
                onClick={() => void create()}
              >
                Create issue
              </Button>
            </div>
          </div>
        </div>
      </div>
    );
  }
  const detailRoute = parseSubPath(subPath);
  if (detailRoute) {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto p-4 text-sm md:p-5">
        <div className="mx-auto w-full max-w-5xl space-y-4">
          {detail ? (
            <>
              <div className="flex items-center gap-1 text-xs text-muted-foreground">
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 px-2"
                  onClick={() => navigate.toPluginPanel("gitea")}
                >
                  ← {detail.kind === "pr" ? "Pull requests" : "Issues"}
                </Button>
                <span className="min-w-0 truncate">
                  {detail.repo} · #{detail.number}
                </span>
                <span className="flex-1" />
                {shown.state === "ready" && (
                  <FreshnessNote
                    freshness={shown.value.freshness}
                    onRefresh={() => void display.refresh()}
                  />
                )}
                {detail.url && (
                  <UrlLink
                    href={detail.url}
                    className="shrink-0 underline hover:text-foreground"
                  >
                    Open on Gitea ↗
                  </UrlLink>
                )}
              </div>
              {shown.state === "ready" &&
                shown.value.freshness.state === "stale-error" && (
                  <p
                    role="status"
                    className="rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground"
                  >
                    Showing content from{" "}
                    {new Date(
                      shown.value.freshness.fetchedAt,
                    ).toLocaleTimeString()}
                    . Gitea refresh failed: {shown.value.freshness.error}
                  </p>
                )}
              <div className="flex flex-wrap items-start gap-3">
                <h2 className="min-w-0 flex-1 text-xl font-semibold text-foreground">
                  {detail.title}{" "}
                  <span className="font-normal text-muted-foreground">
                    #{detail.number}
                  </span>
                </h2>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    void setItemState(
                      detail.state === "closed" ? "open" : "closed",
                    )
                  }
                >
                  {detail.state === "closed" ? "Reopen" : "Close"}
                </Button>
                <Button size="sm" onClick={() => void sendAgent()}>
                  {detail.kind === "pr" ? "Review with agent" : "Send agent"}
                </Button>
              </div>
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <Badge variant="outline" className="gap-1.5 font-normal">
                  <span
                    className={`size-2 rounded-full ${detail.state === "open" ? "bg-green-500" : "bg-purple-500"}`}
                  />
                  {detail.state.toLowerCase()}
                </Badge>
                <span>
                  {detail.repo} · {detail.author}
                </span>
                {detail.kind === "pr" && (
                  <span className="font-mono">
                    {detail.baseRefName} ← {detail.headRefName}
                  </span>
                )}
                {detail.threadId && (
                  <Button
                    size="sm"
                    variant="link"
                    className="h-auto px-1"
                    onClick={() => navigate.toThread(detail.threadId!)}
                  >
                    Open linked BB thread
                  </Button>
                )}
              </div>
              <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_18rem]">
                <main className="min-w-0 space-y-4">
                  <article className="rounded-lg border border-border bg-card p-4">
                    <div className="mb-2 text-xs text-muted-foreground">
                      {detail.author} · {detail.updatedAt}
                    </div>
                    <div className="whitespace-pre-wrap">
                      {detail.body || "No description"}
                    </div>
                  </article>
                  {detail.kind === "pr" && (
                    <Tabs
                      value={detailSection}
                      onValueChange={(value) =>
                        setDetailSection(value as DetailSection)
                      }
                    >
                      <TabsList>
                        <TabsTrigger value="conversation">
                          Conversation
                        </TabsTrigger>
                        <TabsTrigger value="files">
                          Files{" "}
                          <Badge variant="secondary" className="ml-1.5">
                            {detail.changedFiles ??
                              (display.files.state === "ready"
                                ? display.files.value.files.length
                                : "")}
                          </Badge>
                        </TabsTrigger>
                      </TabsList>
                    </Tabs>
                  )}
                  {detail.kind === "pr" && detailSection === "files" ? (
                    <section className="space-y-3">
                      <h3 className="text-xs font-semibold text-muted-foreground">
                        Files changed
                        {display.files.state === "ready" &&
                          ` · ${display.files.value.files.length}`}
                      </h3>
                      <FilesList
                        files={display.files}
                        url={filesUrl(detail)}
                        moved={display.filesMoved}
                        compact={false}
                      />
                    </section>
                  ) : (
                    <section className="space-y-3 rounded-lg border border-border bg-card p-4">
                      <h3 className="text-xs font-semibold text-muted-foreground">
                        Conversation
                      </h3>
                      {detail.commentsTruncated && (
                        <p className="text-xs text-muted-foreground">
                          Conversation history reached the 500-comment cap and
                          may be incomplete.
                        </p>
                      )}
                      {detail.comments.map((comment, index) => (
                        <article
                          key={`${comment.author}-${index}`}
                          className="rounded-md border border-border p-3"
                        >
                          <div className="mb-1 text-xs text-muted-foreground">
                            {comment.author} · {comment.createdAt}
                          </div>
                          <div className="whitespace-pre-wrap">
                            {comment.body}
                          </div>
                        </article>
                      ))}
                      <Textarea
                        value={draft}
                        onChange={(event) => setDraft(event.target.value)}
                        placeholder="Write a comment"
                      />
                      <div className="flex justify-end">
                        <Button
                          disabled={!draft.trim()}
                          onClick={() => void submitComment()}
                        >
                          Comment
                        </Button>
                      </div>
                    </section>
                  )}
                </main>
                <aside className="space-y-3">
                  <section className="space-y-3 rounded-lg border border-border bg-card p-3">
                    <div>
                      <h3 className="mb-2 text-xs font-semibold text-muted-foreground">
                        Labels
                      </h3>
                      <div className="flex flex-wrap gap-1">
                        {detail.labels.map((label) => (
                          <Badge
                            key={label}
                            variant="secondary"
                            className="font-normal"
                          >
                            {label}
                          </Badge>
                        ))}
                      </div>
                    </div>
                    <Input
                      aria-label="Labels, comma separated"
                      value={labelsDraft}
                      onChange={(event) => setLabelsDraft(event.target.value)}
                      placeholder="Labels, comma separated"
                    />
                    <div>
                      <h3 className="mb-2 text-xs font-semibold text-muted-foreground">
                        Assignees
                      </h3>
                      <Input
                        aria-label="Assignees, comma separated"
                        value={assigneesDraft}
                        onChange={(event) =>
                          setAssigneesDraft(event.target.value)
                        }
                        placeholder="Assignees, comma separated"
                      />
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      className="w-full"
                      onClick={() => void saveMetadata()}
                    >
                      Save labels and assignees
                    </Button>
                  </section>
                  {detail.kind === "pr" && (
                    <>
                      <section className="overflow-hidden rounded-lg border border-border bg-card">
                        <h3 className="border-b border-border bg-muted/50 px-3 py-2 text-xs font-semibold text-muted-foreground">
                          Checks
                        </h3>
                        {detail.checksTruncated && (
                          <p className="px-3 pt-2 text-xs text-muted-foreground">
                            Check list may be incomplete.
                          </p>
                        )}
                        {detail.checks.length ? (
                          detail.checks.map((check, index) => (
                            <div
                              key={`${check.name}-${index}`}
                              className="flex items-center gap-2 border-b border-border px-3 py-2 text-xs"
                            >
                              <span
                                className={`size-2 rounded-full ${check.status === "success" ? "bg-green-500" : check.status === "failure" ? "bg-red-500" : "bg-muted-foreground"}`}
                              />
                              <span className="min-w-0 flex-1 truncate">
                                {check.name}
                              </span>
                              <Badge variant="secondary">{check.status}</Badge>
                            </div>
                          ))
                        ) : (
                          <p className="p-3 text-xs text-muted-foreground">
                            No checks reported.
                          </p>
                        )}
                      </section>
                      <section className="space-y-2 rounded-lg border border-border bg-card p-3">
                        <h3 className="text-xs font-semibold text-muted-foreground">
                          Reviews
                        </h3>
                        {detail.reviewsTruncated && (
                          <p className="text-xs text-muted-foreground">
                            Review history reached the 500-item cap and may be
                            incomplete.
                          </p>
                        )}
                        {detail.reviews.map((review, index) => (
                          <article
                            key={`${review.author}-${index}`}
                            className="border-b border-border py-2 text-xs"
                          >
                            <div className="font-medium">
                              {review.author} · {review.state}
                            </div>
                            <div className="whitespace-pre-wrap text-muted-foreground">
                              {review.body}
                            </div>
                          </article>
                        ))}
                        <Textarea
                          value={reviewBody}
                          onChange={(event) =>
                            setReviewBody(event.target.value)
                          }
                          placeholder="Review summary"
                        />
                        <div className="flex flex-wrap justify-end gap-1">
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => void submitReview("COMMENT")}
                          >
                            Comment
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => void submitReview("REQUEST_CHANGES")}
                          >
                            Request changes
                          </Button>
                          <Button
                            size="sm"
                            onClick={() => void submitReview("APPROVED")}
                          >
                            Approve
                          </Button>
                        </div>
                      </section>
                    </>
                  )}
                </aside>
              </div>
            </>
          ) : detailError ? (
            <div className="space-y-3 rounded-lg border border-border bg-card p-4 text-muted-foreground">
              <p>{detailError}</p>
              <Button
                size="sm"
                variant="outline"
                onClick={() => navigate.toPluginPanel("gitea")}
              >
                Back to list
              </Button>
            </div>
          ) : (
            <div className="space-y-3">
              <Skeleton className="h-6 w-2/3" />
              <Skeleton className="h-24 w-full" />
              <Skeleton className="h-48 w-full" />
            </div>
          )}
        </div>
      </div>
    );
  }
  return (
    <div className="flex h-full min-h-0 flex-col text-sm">
      <div className="border-b border-border px-4 py-3">
        <div className="mx-auto flex w-full max-w-5xl items-center gap-3">
          <Tabs
            value={view}
            onValueChange={(value) => {
              navigate.toPluginPanel("gitea");
              setNewIssue(false);
              setView(value as View);
            }}
          >
            <TabsList>
              <TabsTrigger value="my-prs" className="gap-1.5">
                My PRs{" "}
                <Badge variant="secondary">
                  {view === "my-prs" ? count : ""}
                </Badge>
              </TabsTrigger>
              <TabsTrigger value="babysitters">Babysitters</TabsTrigger>
              <TabsTrigger value="issues">Issues</TabsTrigger>
              <TabsTrigger value="pulls">Pull requests</TabsTrigger>
            </TabsList>
          </Tabs>
          <span className="flex-1" />
          <Button size="sm" variant="outline" onClick={() => void refresh()}>
            Refresh
          </Button>
          {view === "issues" && (
            <Button
              size="sm"
              onClick={() =>
                navigate.toPluginPanel("gitea", { subPath: "new" })
              }
            >
              New issue
            </Button>
          )}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-4 md:p-5">
        <div className="mx-auto w-full max-w-5xl space-y-4">
          {!status?.ready && (
            <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
              {status?.error ?? "Checking Gitea configuration…"}
            </div>
          )}
          {(listNotice.truncated || listNotice.errors.length > 0) && (
            <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
              {listNotice.truncated && (
                <div>
                  The bounded result window is full; older items may be outside
                  it.
                </div>
              )}
              {listNotice.errors.map((entry) => (
                <div key={entry.repo}>
                  {entry.repo}: {entry.message}
                </div>
              ))}
            </div>
          )}
          {(view === "my-prs" || view === "babysitters") && (
            <BabysitPreferencesControl />
          )}
          {view === "babysitters" ? (
            <BabysitterSessions />
          ) : (
            <div className="flex flex-col gap-3">
              <div className="flex flex-wrap items-center gap-2">
                <Select value={repo} onValueChange={setRepo}>
                  <SelectTrigger className="w-52">
                    <SelectValue placeholder="All repositories" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All repositories</SelectItem>
                    {repoOptions.map((entry) => (
                      <SelectItem key={entry.repo} value={entry.repo}>
                        {entry.repo}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Select
                  value={state}
                  onValueChange={(value) => setState(value as typeof state)}
                >
                  <SelectTrigger className="w-32">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="open">Open</SelectItem>
                    <SelectItem value="closed">Closed</SelectItem>
                    <SelectItem value="all">All states</SelectItem>
                  </SelectContent>
                </Select>
                <Input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Search title, body, repository"
                  className="max-w-sm"
                />
              </div>
              <div className="overflow-hidden rounded-lg border border-border bg-card">
                <div className="divide-y divide-border">
                  {loading ? (
                    Array.from({ length: 6 }, (_, index) => (
                      <div key={index} className="space-y-2 px-3 py-3">
                        <Skeleton className="h-4 w-3/4" />
                        <Skeleton className="h-3 w-1/2" />
                      </div>
                    ))
                  ) : listError ? (
                    <div
                      role="alert"
                      className="p-8 text-center text-muted-foreground"
                    >
                      {listError}
                    </div>
                  ) : visibleItems.length ? (
                    visibleItems.map((item) => (
                      <div
                        key={itemKey(item)}
                        className="flex flex-col gap-2 hover:bg-accent/50 sm:flex-row sm:items-center sm:pr-3"
                      >
                        <button
                          className="flex w-full min-w-0 flex-1 cursor-pointer flex-col gap-2 px-3 py-3 text-left sm:flex-row sm:items-center"
                          onClick={() => void openItem(item)}
                        >
                          <span className="flex min-w-0 flex-1 items-center gap-2">
                            <Badge
                              variant="outline"
                              className="gap-1.5 font-normal"
                            >
                              <span
                                className={`size-2 shrink-0 rounded-full ${item.state === "open" ? "bg-green-500" : "bg-purple-500"}`}
                              />
                              {item.state.toLowerCase()}
                            </Badge>
                            <span className="shrink-0 font-mono text-xs text-muted-foreground">
                              #{item.number}
                            </span>
                            <span className="min-w-0 truncate text-sm font-medium text-foreground">
                              {item.title}
                            </span>
                            <span className="hidden shrink-0 text-xs text-muted-foreground md:inline">
                              {item.repo}
                            </span>
                          </span>
                          <span className="flex flex-wrap items-center gap-1">
                            {item.labels.slice(0, 3).map((label) => (
                              <Badge
                                key={label}
                                variant="secondary"
                                className="font-normal text-muted-foreground"
                              >
                                {label}
                              </Badge>
                            ))}
                          </span>
                        </button>
                        {babysits.has(itemKey(item)) && (
                          <span className="px-3 pb-3 sm:p-0">
                            <BabysitControls
                              repo={item.repo}
                              number={item.number}
                              view={babysits.get(itemKey(item))!}
                              onChanged={reloadBabysits}
                            />
                          </span>
                        )}
                      </div>
                    ))
                  ) : (
                    <div className="p-8 text-center text-muted-foreground">
                      {view === "my-prs" && !status?.login
                        ? "Install tea and sign in with a matching Gitea login profile to see your pull requests."
                        : view === "my-prs"
                          ? "No pull requests authored by you in tracked repositories."
                          : repoOptions.length
                            ? "No matching items."
                            : "Add repositories in settings or attach a Gitea checkout to a BB project."}
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function GiteaThreadPanel({ threadId }: PluginThreadPanelProps) {
  const rpc = useRpc<typeof giteaRpcContract>();
  const [item, setItem] = useState<ItemRef | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    setItem(null);
    setError(null);
    void rpc
      .call("threadItem", { threadId })
      .then((linked) => {
        if (!current) return;
        if (linked) setItem(linked);
        else
          setError(
            "This BB thread is not linked to a Gitea issue or pull request.",
          );
      })
      .catch((reason: unknown) => {
        if (current)
          setError(errorText(reason, "Could not load the linked Gitea item."));
      });
    return () => {
      current = false;
    };
  }, [rpc, threadId]);
  const display = useItemDisplay(item, item?.kind === "pr");
  const shown = display.conversation;
  if (error || shown.state === "error")
    return (
      <div className="p-4 text-sm text-muted-foreground">
        {error ?? (shown.state === "error" ? shown.message : "")}
      </div>
    );
  if (shown.state === "loading")
    return (
      <div className="p-4 text-sm text-muted-foreground">
        Loading Gitea item…
      </div>
    );
  const detail = shown.value.conversation;
  return (
    <div className="flex h-full min-h-0 flex-col overflow-auto text-sm">
      <header className="border-b p-4">
        <div className="font-semibold">{detail.title}</div>
        <div className="mt-1 flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
          <span className="flex-1">
            {detail.repo}#{detail.number} · {detail.kind} · {detail.state}
          </span>
          <FreshnessNote
            freshness={shown.value.freshness}
            onRefresh={() => void display.refresh()}
          />
        </div>
      </header>
      <article className="border-b p-4">
        <div className="mb-2 text-xs text-muted-foreground">
          {detail.author}
        </div>
        <div className="whitespace-pre-wrap">
          {detail.body || "No description"}
        </div>
      </article>
      <section className="border-b p-4">
        <h3 className="mb-2 font-medium">Conversation</h3>
        {detail.commentsTruncated && (
          <div className="mb-2 text-xs text-muted-foreground">
            Conversation history reached the 500-comment cap and may be
            incomplete.
          </div>
        )}
        {detail.comments.map((comment, index) => (
          <article
            key={`${comment.author}-${index}`}
            className="mb-3 rounded border p-3"
          >
            <div className="mb-1 text-xs text-muted-foreground">
              {comment.author} · {comment.createdAt}
            </div>
            <div className="whitespace-pre-wrap">{comment.body}</div>
          </article>
        ))}
      </section>
      {detail.kind === "pr" && (
        <section className="space-y-2 p-4">
          <h3 className="mb-2 font-medium">
            Files changed
            {detail.changedFiles !== null && ` · ${detail.changedFiles}`}
          </h3>
          <FilesList
            files={display.files}
            url={filesUrl(detail)}
            moved={display.filesMoved}
            compact
          />
        </section>
      )}
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "gitea",
    title: "Gitea",
    icon: "GitPullRequest",
    path: "gitea",
    component: GiteaPanel,
  });
  app.slots.threadPanelAction({
    id: "item",
    title: "Gitea issue or PR",
    icon: "GitPullRequest",
    component: GiteaThreadPanel,
  });
});
