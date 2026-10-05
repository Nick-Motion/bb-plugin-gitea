import type {
  BbPluginApi,
  JsonValue,
  PluginRpcHandlers,
} from "@get-bb/plugin-sdk";
import type { PluginEnvironmentProviderCreateResult } from "@get-bb/plugin-sdk/environment-provider";
import {
  GITEA_BRANCH_ENVIRONMENT_PROVIDER_ID,
  giteaBranchHostContract,
  giteaBranchInputsSchema,
  type branchRpcContract,
} from "./branch-contract.js";
import {
  orderRemoteBranches,
  type PullInput,
  type PullStatus,
  type RemoteBranchInput,
} from "./branch-order.js";

const HOST_TIMEOUT_MS = 15 * 60 * 1000;
const REMOTE_BRANCH_TTL_MS = 30_000;
/** A finished CI result for a commit rarely changes, so it is kept longer than one still running. */
const SETTLED_CI_TTL_MS = 5 * 60_000;
const OPEN_CI_TTL_MS = 20_000;
const MAX_CI_READS = 100;
const ADOPTED_RESOURCE = { adopted: true } as const;

export interface RemoteBranchData {
  branches: RemoteBranchInput[];
  pulls: PullInput[];
  truncated: boolean;
}

export interface BranchProviderDeps {
  /** The Gitea repository (owner/name) of an origin remote URL, or null when it is not on the configured instance. */
  repoFromRemote(remote: string): string | null;
  /** The Gitea repository of a local checkout's origin remote. */
  repoFromCheckout(path: string): Promise<string | null>;
  /** The signed-in Gitea user. */
  login(): Promise<string>;
  readRemoteBranches(repo: string, signal?: AbortSignal): Promise<RemoteBranchData>;
  /** The badge state of an open pull request from its head commit's CI statuses. */
  readCiStatus(repo: string, sha: string, signal?: AbortSignal): Promise<PullStatus>;
}

function isAdopted(resource: JsonValue | null): boolean {
  return (
    typeof resource === "object" &&
    resource !== null &&
    !Array.isArray(resource) &&
    resource.adopted === true
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Registers the "Gitea" environment provider and returns the RPC
 * handlers its picker uses.
 */
export function registerBranchProvider(
  bb: BbPluginApi,
  deps: BranchProviderDeps,
): PluginRpcHandlers<typeof branchRpcContract> {
  const host = bb.hosts.experimental_client({
    contract: giteaBranchHostContract,
  });

  async function checkoutSource(projectId: string, hostId: string | null) {
    const projects = await bb.sdk.projects.list();
    const sources = (
      projects.find((project) => project.id === projectId)?.sources ?? []
    ).filter((source) => source.type === "local_path");
    return hostId === null
      ? (sources.find((source) => source.isDefault) ?? sources[0])
      : sources.find((source) => source.hostId === hostId);
  }

  async function orderedBranches(repo: string, signal?: AbortSignal) {
    const [data, login] = await Promise.all([
      deps.readRemoteBranches(repo, signal),
      deps.login(),
    ]);
    const branches = orderRemoteBranches({ ...data, login });
    const shaByPull = new Map(data.pulls.map((pull) => [pull.number, pull.sha]));
    return {
      branches,
      truncated: data.truncated,
      // Open pull requests whose CI state is read on request, in display order.
      ciPulls: branches.flatMap((branch) =>
        branch.pull?.status === "checking"
          ? [
              {
                number: branch.pull.number,
                sha: shaByPull.get(branch.pull.number) ?? "",
                mine: branch.group !== "other",
              },
            ]
          : [],
      ),
    };
  }

  const ciCache = new Map<string, { expiresAt: number; value: Promise<PullStatus> }>();
  function cachedCiStatus(repo: string, sha: string, signal?: AbortSignal) {
    const key = `${repo}\n${sha}`;
    const cached = ciCache.get(key);
    if (cached && Date.now() < cached.expiresAt) return cached.value;
    const value = deps.readCiStatus(repo, sha, signal);
    const entry = { expiresAt: Date.now() + OPEN_CI_TTL_MS, value };
    ciCache.set(key, entry);
    value.then(
      (status) => {
        if (status === "passing" || status === "failing")
          entry.expiresAt = Date.now() + SETTLED_CI_TTL_MS;
      },
      () => {
        if (ciCache.get(key) === entry) ciCache.delete(key);
      },
    );
    return value;
  }

  type Ordered = Awaited<ReturnType<typeof orderedBranches>>;
  const orderedCache = new Map<string, { at: number; value: Promise<Ordered> }>();

  function cachedBranches(repo: string, refresh: boolean, signal?: AbortSignal) {
    const now = Date.now();
    const cached = orderedCache.get(repo);
    if (!refresh && cached && now - cached.at < REMOTE_BRANCH_TTL_MS)
      return cached.value;
    const value = orderedBranches(repo, signal);
    orderedCache.set(repo, { at: now, value });
    value.catch(() => {
      if (orderedCache.get(repo)?.value === value) orderedCache.delete(repo);
    });
    return value;
  }

  async function adopt(
    context: {
      host: { id: string };
      projectCheckout: { path: string };
      signal: AbortSignal;
      experimental_claimPath(path: string): Promise<boolean>;
      report: { step(text: string): void };
    },
    path: string,
    branch: string | null,
  ): Promise<PluginEnvironmentProviderCreateResult> {
    if (branch !== null) context.report.step(`Switching the worktree to ${branch}`);
    const result = await host.call(
      "useExisting",
      { sourcePath: context.projectCheckout.path, path, branch },
      { hostId: context.host.id, signal: context.signal, timeoutMs: HOST_TIMEOUT_MS },
    );
    if (result.status === "failed") return result;
    if (!(await context.experimental_claimPath(result.path)))
      return {
        status: "failed",
        message: `${result.path} is already in use by another environment.`,
      };
    return {
      status: "created",
      path: result.path,
      ownsPath: false,
      resource: ADOPTED_RESOURCE,
    };
  }

  async function createOwned(
    context: {
      host: { id: string };
      projectCheckout: { path: string };
      pathKey: string;
      signal: AbortSignal;
      report: { step(text: string): void };
    },
    branch:
      | { kind: "checkout"; name: string }
      | { kind: "new"; name: string; base: string | null },
  ): Promise<PluginEnvironmentProviderCreateResult> {
    context.report.step(
      branch.kind === "checkout"
        ? `Creating a worktree on ${branch.name}`
        : `Creating a worktree from ${branch.base ?? "the default branch"}`,
    );
    try {
      const result = await host.call(
        "create",
        { sourcePath: context.projectCheckout.path, pathKey: context.pathKey, branch },
        { hostId: context.host.id, signal: context.signal, timeoutMs: HOST_TIMEOUT_MS },
      );
      if (result.status === "failed") return result;
      return {
        status: "created",
        path: result.path,
        ownsPath: true,
        ...(result.baseBranch === null ? {} : { mergeBaseBranch: result.baseBranch }),
      };
    } catch (error) {
      if (context.signal.aborted) throw error;
      return { status: "failed", message: errorMessage(error) };
    }
  }

  bb.experimental_environments.register({
    id: GITEA_BRANCH_ENVIRONMENT_PROVIDER_ID,
    displayName: "Gitea",
    description: "Work on a Gitea branch in a worktree.",
    icon: "gitea/teacup",
    requires: { gitCheckout: true },
    inputs: giteaBranchInputsSchema,
    policy: { pathKeys: "per-attempt" },
    async availability(context) {
      // The checkout's own origin wins over the remote URL BB recorded for the
      // project, which can be out of date after a repository moves to Gitea.
      const repo =
        context.projectCheckout !== null
          ? await deps.repoFromCheckout(context.projectCheckout.path)
          : context.gitRemote === null
            ? "unknown"
            : deps.repoFromRemote(context.gitRemote);
      if (repo !== null) return { status: "available" };
      return {
        status: "unavailable",
        message: "This project's origin remote is not on the configured Gitea instance.",
      };
    },
    experimental_existingPath: (inputs) =>
      inputs.kind === "existing" && inputs.remoteBranch === undefined
        ? inputs.path
        : null,
    async create(context) {
      const inputs = context.inputs;
      switch (inputs.kind) {
        case "existing":
          return adopt(context, inputs.path, inputs.remoteBranch ?? null);
        case "remote":
          return createOwned(context, { kind: "checkout", name: inputs.name });
        case "new":
          return createOwned(context, {
            kind: "new",
            name: context.suggestedBranchName,
            base: inputs.from.kind === "named" ? inputs.from.name : null,
          });
      }
    },
    async restore(context) {
      if (context.inputs.kind === "existing")
        return adopt(context, context.inputs.path, null);
      const branchName = context.previous.environment.branchName;
      if (branchName === null)
        return {
          status: "failed",
          message:
            "The removed worktree had no branch checked out, so there is no branch to restore it on.",
        };
      return createOwned(context, { kind: "checkout", name: branchName });
    },
    async remove(context) {
      if (isAdopted(context.resource) || context.path === null)
        return { status: "removed" };
      if (context.hostId === null)
        return { status: "failed", message: "The worktree machine is unknown." };
      try {
        return await host.call(
          "remove",
          { path: context.path },
          { hostId: context.hostId, signal: context.signal, timeoutMs: HOST_TIMEOUT_MS },
        );
      } catch (error) {
        if (context.signal.aborted) throw error;
        return { status: "failed", message: errorMessage(error) };
      }
    },
  });

  return {
    async remoteBranches(
      { projectId, refresh },
      { experimental_signal: signal }: { experimental_signal?: AbortSignal } = {},
    ) {
      const source = await checkoutSource(projectId, null);
      const repo = source ? await deps.repoFromCheckout(source.path) : null;
      if (repo === null)
        return { repo: null, branches: [], truncated: false, error: null };
      try {
        const { branches, truncated } = await cachedBranches(repo, refresh, signal);
        return { repo, branches, truncated, error: null };
      } catch (error) {
        if (signal?.aborted) throw error;
        return { repo, branches: [], truncated: false, error: errorMessage(error) };
      }
    },
    async remotePullStatuses(
      { projectId, others },
      { experimental_signal: signal }: { experimental_signal?: AbortSignal } = {},
    ) {
      const source = await checkoutSource(projectId, null);
      const repo = source ? await deps.repoFromCheckout(source.path) : null;
      if (repo === null) return { statuses: [] };
      const { ciPulls } = await cachedBranches(repo, false, signal);
      const wanted = ciPulls
        .filter((pull) => (others ? !pull.mine : pull.mine))
        .slice(0, MAX_CI_READS);
      const statuses = await Promise.all(
        wanted.map(async ({ number, sha }) => ({
          number,
          status: await cachedCiStatus(repo, sha, signal).catch((error: unknown) => {
            if (signal?.aborted) throw error;
            return "none" as const;
          }),
        })),
      );
      return { statuses };
    },
    async branchDefaultBase({ projectId, hostId }) {
      const source = await checkoutSource(projectId, hostId);
      if (source === undefined) return { branch: null };
      return host.call(
        "defaultBaseBranch",
        { sourcePath: source.path },
        { hostId: source.hostId },
      );
    },
    async branchWorktrees({ projectId, hostId }) {
      const source = await checkoutSource(projectId, hostId);
      if (source === undefined) return { worktrees: [] };
      return host.call("listWorktrees", { sourcePath: source.path }, { hostId });
    },
  };
}
