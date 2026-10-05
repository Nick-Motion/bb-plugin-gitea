import {
  useCallback,
  useDeferredValue,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  useRpc,
  type PluginEnvironmentProviderInputsProps,
} from "@get-bb/plugin-sdk/app";
import type { giteaRpcContract } from "./server.js";
import {
  giteaBranchInputsSchema,
  type GiteaBranchInputs,
} from "./branch-inputs.js";
import type { DiscoveredWorktree, RemoteBranch } from "./branch-contract.js";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  COARSE_POINTER_COMPACT_ICON_SIZE_CLASS,
  COARSE_POINTER_COMPACT_ICON_SIZE_SHRINK_CLASS,
  COARSE_POINTER_ICON_SIZE_SHRINK_CLASS,
} from "@/components/ui/coarse-pointer-sizing";
import { LIST_HOVER_TRANSITION } from "@/components/ui/motion";
import { cn } from "@/lib/utils";

const DEFAULT_INPUTS: GiteaBranchInputs = {
  kind: "new",
  from: { kind: "default" },
};
const ROW_CLASS_NAME =
  "flex w-full min-w-0 items-center gap-2 rounded-sm px-2 py-[0.3125rem] text-left text-xs outline-none hover:bg-state-hover hover:text-foreground focus-visible:bg-state-hover focus-visible:text-foreground";
const TRIGGER_CLASS_NAME =
  "h-8 w-fit max-w-full min-w-0 items-center justify-start gap-1 border-none bg-transparent px-1 text-xs leading-tight text-muted-foreground shadow-none hover:text-muted-foreground";

type Intent = "new" | "existing";

function parseInputs(value: unknown): GiteaBranchInputs | null {
  const parsed = giteaBranchInputsSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function worktreeLabel(path: string): string {
  return path.split("/").filter(Boolean).slice(-2).join("/") || path;
}

function matches(query: string, ...values: string[]): boolean {
  const normalized = query.trim().toLowerCase();
  return (
    normalized.length === 0 ||
    values.some((value) => value.toLowerCase().includes(normalized))
  );
}

function SectionHeader({ label }: { label: string }) {
  return (
    <div className="flex h-7 items-center px-2 text-xs font-medium text-muted-foreground">
      {label}
    </div>
  );
}

function Row({
  icon,
  selected,
  disabled,
  title,
  onSelect,
  children,
}: {
  icon: string;
  selected: boolean;
  disabled?: boolean;
  title: string;
  onSelect: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className={cn(
        ROW_CLASS_NAME,
        LIST_HOVER_TRANSITION,
        disabled &&
          "cursor-not-allowed text-muted-foreground opacity-60 hover:bg-transparent hover:text-muted-foreground",
      )}
      disabled={disabled}
      title={title}
      onClick={onSelect}
    >
      <Icon
        name={icon}
        className={cn("text-muted-foreground", COARSE_POINTER_COMPACT_ICON_SIZE_SHRINK_CLASS)}
      />
      {children}
      <Icon
        name="Check"
        className={cn(selected ? "opacity-100" : "opacity-0", COARSE_POINTER_ICON_SIZE_SHRINK_CLASS)}
      />
    </button>
  );
}

type PullStatus = NonNullable<RemoteBranch["pull"]>["status"];

const PULL_BADGE: Record<PullStatus, { className: string; label: string }> = {
  draft: { className: "bg-muted text-muted-foreground", label: "Draft" },
  none: { className: "bg-muted text-muted-foreground", label: "No CI" },
  failing: { className: "bg-red-500/15 text-red-600 dark:text-red-400", label: "CI failing" },
  running: { className: "bg-yellow-500/15 text-yellow-700 dark:text-yellow-400", label: "CI running" },
  passing: { className: "bg-green-500/15 text-green-700 dark:text-green-400", label: "CI passing" },
  merged: { className: "bg-purple-500/15 text-purple-700 dark:text-purple-400", label: "Merged" },
  checking: { className: "bg-muted text-muted-foreground", label: "Checking CI" },
};

function PullBadge({
  pull,
  ciLoading,
}: {
  pull: NonNullable<RemoteBranch["pull"]>;
  ciLoading: boolean;
}) {
  const badge = PULL_BADGE[pull.status];
  const label = pull.status === "checking" && !ciLoading ? "CI not checked" : badge.label;
  return (
    <span
      className={cn("shrink-0 rounded px-1.5 py-px text-[11px] font-medium leading-4", badge.className)}
      title={`Pull request #${pull.number}: ${label}`}
      data-status={pull.status}
    >
      #{pull.number}
    </span>
  );
}

function Note({ children }: { children: ReactNode }) {
  return (
    <p className="px-2 py-3 text-center text-xs text-muted-foreground">{children}</p>
  );
}

function useScoped<T>(key: string | null, load: (key: string) => Promise<T>) {
  const [state, setState] = useState<{
    key: string;
    value: T | null;
    loading: boolean;
    error: string | null;
  } | null>(null);
  const request = useRef(0);
  const reload = useCallback(
    async (nextKey = key) => {
      const id = ++request.current;
      if (nextKey === null) {
        setState(null);
        return;
      }
      setState((current) => ({
        key: nextKey,
        value: current?.key === nextKey ? current.value : null,
        loading: true,
        error: null,
      }));
      try {
        const value = await load(nextKey);
        if (id === request.current)
          setState({ key: nextKey, value, loading: false, error: null });
      } catch (error) {
        if (id === request.current)
          setState((current) => ({
            key: nextKey,
            value: current?.key === nextKey ? current.value : null,
            loading: false,
            error: error instanceof Error ? error.message : String(error),
          }));
      }
    },
    [key, load],
  );
  useEffect(() => () => void (request.current += 1), []);
  return [state?.key === key ? state : null, reload] as const;
}

/**
 * The "Gitea" environment control. Lists where to work and the repository's
 * Gitea branches, split into the signed-in user's branches and all others.
 * With no branch picked, a new worktree gets a new thread branch from the
 * default branch.
 */
export function GiteaBranchInputsControl({
  projectId,
  target,
  value,
  onChange,
}: PluginEnvironmentProviderInputsProps) {
  const hostId = target.kind === "existing-host" ? target.hostId : null;
  const rpc = useRpc<typeof giteaRpcContract>();
  const inputs = parseInputs(value);
  const selectedIntent: Intent = inputs?.kind === "existing" ? "existing" : "new";
  const [intent, setIntent] = useState<Intent>(selectedIntent);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const inputRef = useRef<HTMLInputElement>(null);

  const loadRemote = useCallback(
    (key: string) => rpc.call("remoteBranches", { projectId: key, refresh: false }),
    [rpc],
  );
  const [remote, reloadRemote] = useScoped(projectId, loadRemote);
  const refreshRemote = useCallback(async () => {
    if (projectId === null) return;
    await rpc
      .call("remoteBranches", { projectId, refresh: true })
      .then(() => reloadRemote())
      .catch(() => undefined);
  }, [projectId, rpc, reloadRemote]);

  // Other people's branches stay hidden until asked for or searched, so their CI states are read only then.
  const [othersRequested, setOthersRequested] = useState(false);
  const showOthers = othersRequested || deferredQuery.trim().length > 0;
  const loadMyStatuses = useCallback(
    (key: string) => rpc.call("remotePullStatuses", { projectId: key, others: false }),
    [rpc],
  );
  const loadOtherStatuses = useCallback(
    (key: string) => rpc.call("remotePullStatuses", { projectId: key, others: true }),
    [rpc],
  );
  const [myCi, reloadMyCi] = useScoped(projectId, loadMyStatuses);
  const [otherCi, reloadOtherCi] = useScoped(showOthers ? projectId : null, loadOtherStatuses);
  const remoteValue = remote?.value;
  // CI states load after the branch list, so the list shows without waiting for them.
  useEffect(() => {
    if (remoteValue) void reloadMyCi();
  }, [remoteValue, reloadMyCi]);
  useEffect(() => {
    if (remoteValue && showOthers) void reloadOtherCi();
  }, [remoteValue, showOthers, reloadOtherCi]);

  const scopeKey = projectId !== null && hostId !== null ? `${projectId}\n${hostId}` : null;
  const loadWorktrees = useCallback(
    (key: string) => {
      const [project, host] = key.split("\n") as [string, string];
      return rpc.call("branchWorktrees", { projectId: project, hostId: host });
    },
    [rpc],
  );
  const [worktreeState, reloadWorktrees] = useScoped(scopeKey, loadWorktrees);

  const loadDefault = useCallback(
    (key: string) => rpc.call("branchDefaultBase", { projectId: key, hostId }),
    [rpc, hostId],
  );
  const [defaultBase, reloadDefault] = useScoped(projectId, loadDefault);

  const needsDefault = inputs === null;
  useEffect(() => {
    if (needsDefault) onChange({ status: "ready", value: DEFAULT_INPUTS });
  }, [needsDefault, onChange]);

  useEffect(() => {
    void reloadRemote();
    void reloadDefault();
  }, [reloadRemote, reloadDefault]);

  useEffect(() => {
    if (open) setIntent(selectedIntent);
  }, [open, selectedIntent]);

  const ciStatus = new Map(
    [...(myCi?.value?.statuses ?? []), ...(otherCi?.value?.statuses ?? [])].map((entry) => [
      entry.number,
      entry.status,
    ]),
  );
  const remoteBranches: RemoteBranch[] = (remote?.value?.branches ?? [])
    .filter((branch) =>
      matches(
        deferredQuery,
        branch.name,
        branch.pull ? `#${branch.pull.number}` : "",
        branch.pull?.title ?? "",
      ),
    )
    .map((branch) => {
      const status = branch.pull ? ciStatus.get(branch.pull.number) : undefined;
      return branch.pull && branch.pull.status === "checking" && status
        ? { ...branch, pull: { ...branch.pull, status } }
        : branch;
    });
  const worktrees: DiscoveredWorktree[] = (worktreeState?.value?.worktrees ?? []).filter(
    (worktree) => matches(deferredQuery, worktree.path, worktree.branch ?? ""),
  );
  const existingPath = inputs?.kind === "existing" ? inputs.path : null;

  const updateOpen = (nextOpen: boolean) => {
    if (nextOpen) {
      void refreshRemote();
      if (selectedIntent === "existing") void reloadWorktrees();
    } else {
      setQuery("");
    }
    setOpen(nextOpen);
  };
  const submit = (next: GiteaBranchInputs, close = true) => {
    onChange({ status: "ready", value: next });
    if (close) updateOpen(false);
  };
  const pickRemote = (name: string) =>
    submit(
      intent === "existing" && existingPath !== null
        ? { kind: "existing", path: existingPath, remoteBranch: name }
        : { kind: "remote", name },
    );

  const trigger = (() => {
    const defaultLabel = defaultBase?.value?.branch ?? "default";
    switch (inputs?.kind) {
      case "remote":
        return { prefix: null, value: inputs.name, title: `Work on ${inputs.name} in a new worktree` };
      case "existing":
        return {
          prefix: "Reuse:",
          value: inputs.remoteBranch
            ? `${worktreeLabel(inputs.path)} · ${inputs.remoteBranch}`
            : worktreeLabel(inputs.path),
          title: inputs.remoteBranch
            ? `Switch ${inputs.path} to ${inputs.remoteBranch}`
            : inputs.path,
        };
      default: {
        const base = inputs?.from.kind === "named" ? inputs.from.name : defaultLabel;
        return { prefix: "New branch from:", value: base, title: `Create a worktree on a new branch from ${base}` };
      }
    }
  })();

  const enterSelection = (() => {
    if (intent === "existing" && existingPath === null) {
      const worktree = worktrees.find((candidate) => !candidate.prunable);
      return worktree ? () => submit({ kind: "existing", path: worktree.path }, false) : null;
    }
    const firstRemote = remoteBranches.find(
      (branch) => showOthers || branch.group !== "other",
    );
    return firstRemote ? () => pickRemote(firstRemote.name) : null;
  })();

  const branchRows = (branches: readonly RemoteBranch[]) =>
    branches.map((branch) => (
      <Row
        key={branch.name}
        icon={branch.pull ? "GitPullRequest" : "GitBranch"}
        selected={
          (inputs?.kind === "remote" && inputs.name === branch.name) ||
          (inputs?.kind === "existing" && inputs.remoteBranch === branch.name)
        }
        title={branch.pull ? `${branch.pull.title}\n${branch.name}` : branch.name}
        onSelect={() => pickRemote(branch.name)}
      >
        {branch.pull ? (
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="min-w-0 truncate font-medium text-foreground">
              {branch.pull.title || branch.name}
            </span>
            <span className="min-w-0 truncate text-[11px] text-muted-foreground">
              {branch.name}
            </span>
          </span>
        ) : (
          <span className="min-w-0 flex-1 truncate">{branch.name}</span>
        )}
        {branch.pull ? (
          <PullBadge
            pull={branch.pull}
            ciLoading={branch.group === "other" ? !otherCi || otherCi.loading : !myCi || myCi.loading}
          />
        ) : null}
      </Row>
    ));
  const yours = remoteBranches.filter((branch) => branch.group !== "other");
  const others = remoteBranches.filter((branch) => branch.group === "other");
  const remoteSection =
    remote?.value?.repo === null ? (
      <Note>This project's origin is not on Gitea.</Note>
    ) : remote?.value?.error || remote?.error ? (
      <Note>{remote?.value?.error ?? remote?.error}</Note>
    ) : remoteBranches.length === 0 ? (
      <Note>{remote === null || remote.loading ? "Loading branches..." : "No branches found."}</Note>
    ) : (
      <>
        {yours.length > 0 ? (
          <>
            <SectionHeader label="Your branches:" />
            {branchRows(yours)}
          </>
        ) : null}
        {yours.length === 0 && !showOthers ? <Note>You have no branches here.</Note> : null}
        {others.length > 0 && showOthers ? (
          <>
            <SectionHeader label="Other branches:" />
            {branchRows(others)}
          </>
        ) : null}
        {others.length > 0 && !showOthers ? (
          <Row
            icon="ChevronDown"
            selected={false}
            title="List branches from other people and check their pull requests"
            onSelect={() => setOthersRequested(true)}
          >
            <span className="min-w-0 flex-1 truncate text-muted-foreground">
              Show other branches ({others.length})
            </span>
          </Row>
        ) : null}
        {remote?.value?.truncated ? <Note>Showing the first branches only.</Note> : null}
      </>
    );

  return (
    <Popover open={open} onOpenChange={updateOpen}>
      <PopoverTrigger asChild disabled={projectId === null}>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={projectId === null}
          aria-label="Gitea branch"
          role="combobox"
          aria-expanded={open}
          className={cn(LIST_HOVER_TRANSITION, TRIGGER_CLASS_NAME)}
        >
          <span className="contents" title={trigger.title}>
            <Icon
              name={inputs?.kind === "remote" ? "GitBranch" : "GitMerge"}
              className={COARSE_POINTER_COMPACT_ICON_SIZE_SHRINK_CLASS}
            />
            <span className="flex min-w-0 items-baseline gap-1 truncate">
              {trigger.prefix ? (
                <span data-promptbox-hide-compact="" className="shrink-0 text-muted-foreground">
                  {trigger.prefix}
                </span>
              ) : null}
              <span className="min-w-0 truncate font-medium text-foreground">{trigger.value}</span>
            </span>
          </span>
          <Icon
            name="ChevronDown"
            className={cn("shrink-0 text-muted-foreground", COARSE_POINTER_COMPACT_ICON_SIZE_CLASS)}
          />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        collisionPadding={16}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          inputRef.current?.focus();
        }}
        className="flex w-full min-w-0 flex-col overflow-hidden p-0 md:w-80 md:max-h-[calc(100vh-6rem)]"
      >
        <div className="shrink-0 border-b border-border p-1.5">
          <div className="relative">
            <Icon
              name="Search"
              className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              ref={inputRef}
              aria-label={intent === "existing" && existingPath === null ? "Search worktrees" : "Search branches"}
              placeholder={intent === "existing" && existingPath === null ? "Search worktrees" : "Search branches"}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== "Enter") return;
                event.preventDefault();
                event.stopPropagation();
                enterSelection?.();
              }}
              className="h-8 border-0 bg-transparent pl-8 pr-2 text-xs shadow-none focus-visible:ring-0"
            />
          </div>
        </div>
        <div
          className="min-h-0 max-h-[60vh] overflow-y-auto overscroll-contain px-1 pb-1 pt-0 md:max-h-96"
          onWheel={(event) => event.stopPropagation()}
        >
          <SectionHeader label="Work in:" />
          <Row
            icon="Plus"
            selected={intent === "new"}
            title="Create a worktree on a new branch from the default branch, or pick a branch below"
            onSelect={() => {
              setIntent("new");
              setQuery("");
              if (inputs?.kind !== "new") submit(DEFAULT_INPUTS, false);
            }}
          >
            <span className="min-w-0 flex-1 truncate">New worktree</span>
          </Row>
          <Row
            icon="FolderGit"
            disabled={projectId === null || hostId === null}
            selected={intent === "existing"}
            title="Use a worktree you already have"
            onSelect={() => {
              setIntent("existing");
              setQuery("");
              void reloadWorktrees();
            }}
          >
            <span className="min-w-0 flex-1 truncate">Existing worktree</span>
          </Row>
          <div className="my-1 h-px bg-border/60" />
          {intent === "new" ? (
            remoteSection
          ) : (
            <>
              <SectionHeader label="Existing worktree:" />
              {worktrees.length === 0 ? (
                <Note>
                  {worktreeState === null || worktreeState.loading
                    ? "Loading worktrees..."
                    : worktreeState.error
                      ? "Could not load worktrees. Select Existing worktree to retry."
                      : (worktreeState.value?.worktrees.length ?? 0) === 0
                        ? "No existing worktrees found."
                        : "No matching worktrees found."}
                </Note>
              ) : null}
              {worktrees.map((worktree) => (
                <Row
                  key={worktree.path}
                  icon="FolderGit"
                  selected={worktree.path === existingPath}
                  disabled={worktree.prunable}
                  title={worktree.path}
                  onSelect={() => {
                    submit({ kind: "existing", path: worktree.path }, false);
                    setQuery("");
                  }}
                >
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="min-w-0 truncate text-left [direction:rtl]">
                      <bdi dir="ltr">{worktree.path}</bdi>
                    </span>
                    <span className="min-w-0 truncate text-xs text-muted-foreground">
                      {worktree.branch ?? "Detached HEAD"}
                      {worktree.locked ? " · locked" : ""}
                      {worktree.prunable ? " · prunable" : ""}
                    </span>
                  </span>
                </Row>
              ))}
              {existingPath !== null ? (
                <>
                  <div className="my-1 h-px bg-border/60" />
                  <Row
                    icon="GitMerge"
                    selected={inputs?.kind === "existing" && inputs.remoteBranch === undefined}
                    title="Keep the worktree on its current branch"
                    onSelect={() => submit({ kind: "existing", path: existingPath })}
                  >
                    <span className="min-w-0 flex-1 truncate">Keep current branch</span>
                  </Row>
                  {remoteSection}
                </>
              ) : null}
            </>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
