import { afterEach, expect, it, vi } from "vitest";
import {
  createFakePluginHost,
  type ExperimentalFakeHostRpcCall,
} from "@get-bb/plugin-sdk/testing";
import { branchRpcContract } from "./branch-contract";
import { registerBranchProvider, type BranchProviderDeps } from "./branch-provider";

const disposers: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose();
});

function start(
  options: {
    hostReply?: (call: ExperimentalFakeHostRpcCall) => unknown;
    deps?: Partial<BranchProviderDeps>;
  } = {},
) {
  const host = createFakePluginHost({
    pluginId: "gitea",
    experimental_declaredIconNames: ["teacup"],
    experimental_callHostRpc: (call) => options.hostReply?.(call) ?? null,
    sdk: {
      projects: {
        list: async () => [
          {
            id: "project-1",
            sources: [{ type: "local_path", path: "/src/widgets", hostId: "host-1", isDefault: true }],
          },
        ],
      } as never,
    },
  });
  disposers.push(() => host.harness.lifecycle.dispose());
  const handlers = registerBranchProvider(host.bb, {
    repoFromRemote: (remote) => (remote.includes("gitea.example") ? "acme/widgets" : null),
    repoFromCheckout: async () => "acme/widgets",
    login: async () => "dev",
    readRemoteBranches: async () => ({ branches: [], pulls: [], truncated: false }),
    readCiStatus: async () => "none",
    ...options.deps,
  });
  host.bb.rpc.register(branchRpcContract, handlers);
  const provider = host.harness.registrations.environmentProviders.get("gitea-branch")!;
  return { host, provider };
}

function context(inputs: unknown, claim = true) {
  const claimed: string[] = [];
  const steps: string[] = [];
  return {
    claimed,
    steps,
    value: {
      inputs,
      host: { id: "host-1" },
      projectCheckout: { path: "/src/widgets" },
      pathKey: "attempt-1",
      suggestedBranchName: "bb/thread-1",
      signal: new AbortController().signal,
      report: { step: (text: string) => steps.push(text), log: () => {} },
      experimental_claimPath: async (path: string) => {
        claimed.push(path);
        return claim;
      },
    } as never,
  };
}

it("creates a worktree on the picked remote branch itself", async () => {
  const { host, provider } = start({
    hostReply: () => ({ status: "created", path: "/data/worktrees/attempt-1/widgets", baseBranch: "main" }),
  });
  const ctx = context({ kind: "remote", name: "feature" });
  await expect(provider.create(ctx.value)).resolves.toEqual({
    status: "created",
    path: "/data/worktrees/attempt-1/widgets",
    ownsPath: true,
    mergeBaseBranch: "main",
  });
  expect(host.harness.inspection.experimental_hostRpcCalls).toMatchObject([
    {
      method: "create",
      hostId: "host-1",
      input: {
        sourcePath: "/src/widgets",
        pathKey: "attempt-1",
        branch: { kind: "checkout", name: "feature" },
      },
    },
  ]);
  expect(ctx.steps).toEqual(["Creating a worktree on feature"]);
});

it("starts a new thread branch from a local branch or the default branch", async () => {
  const { host, provider } = start({
    hostReply: () => ({ status: "created", path: "/wt", baseBranch: null }),
  });
  await provider.create(context({ kind: "new", from: { kind: "named", name: "develop" } }).value);
  await provider.create(context({ kind: "new", from: { kind: "default" } }).value);
  expect(host.harness.inspection.experimental_hostRpcCalls.map((call) => call.input)).toMatchObject([
    { branch: { kind: "new", name: "bb/thread-1", base: "develop" } },
    { branch: { kind: "new", name: "bb/thread-1", base: null } },
  ]);
});

it("switches an existing worktree to the remote branch and does not own it", async () => {
  const { host, provider } = start({
    hostReply: () => ({ status: "ready", path: "/src/widgets-wt" }),
  });
  const inputs = { kind: "existing", path: "/src/widgets-wt", remoteBranch: "feature" };
  expect(provider.experimental_existingPath?.(inputs as never)).toBeNull();
  const ctx = context(inputs);
  await expect(provider.create(ctx.value)).resolves.toEqual({
    status: "created",
    path: "/src/widgets-wt",
    ownsPath: false,
    resource: { adopted: true },
  });
  expect(ctx.claimed).toEqual(["/src/widgets-wt"]);
  expect(host.harness.inspection.experimental_hostRpcCalls[0]).toMatchObject({
    method: "useExisting",
    input: { path: "/src/widgets-wt", branch: "feature" },
  });
  expect(ctx.steps).toEqual(["Switching the worktree to feature"]);
});

it("reuses a recorded environment only when no branch switch is asked for", () => {
  const { provider } = start();
  expect(
    provider.experimental_existingPath?.({ kind: "existing", path: "/src/widgets-wt" } as never),
  ).toBe("/src/widgets-wt");
  expect(provider.experimental_existingPath?.({ kind: "remote", name: "feature" } as never)).toBeNull();
});

it("fails when another environment already uses the existing worktree", async () => {
  const { provider } = start({
    hostReply: () => ({ status: "ready", path: "/src/widgets-wt" }),
  });
  await expect(
    provider.create(context({ kind: "existing", path: "/src/widgets-wt" }, false).value),
  ).resolves.toEqual({
    status: "failed",
    message: "/src/widgets-wt is already in use by another environment.",
  });
});

it("passes host failures through", async () => {
  const { provider } = start({
    hostReply: () => ({ status: "failed", message: "/wt has uncommitted changes." }),
  });
  await expect(
    provider.create(context({ kind: "existing", path: "/wt", remoteBranch: "feature" }).value),
  ).resolves.toEqual({ status: "failed", message: "/wt has uncommitted changes." });
});

it("removes only the worktrees it created", async () => {
  const { host, provider } = start({ hostReply: () => ({ status: "removed" }) });
  const base = {
    environment: null,
    pathKey: "attempt-1",
    attempt: 1,
    report: { step: () => {}, log: () => {} },
    signal: new AbortController().signal,
  };
  await expect(
    provider.remove({ ...base, hostId: "host-1", path: "/wt", resource: { adopted: true } }),
  ).resolves.toEqual({ status: "removed" });
  expect(host.harness.inspection.experimental_hostRpcCalls).toEqual([]);
  await expect(
    provider.remove({ ...base, hostId: "host-1", path: "/data/wt", resource: null }),
  ).resolves.toEqual({ status: "removed" });
  expect(host.harness.inspection.experimental_hostRpcCalls).toMatchObject([
    { method: "remove", hostId: "host-1", input: { path: "/data/wt" } },
  ]);
});

it("restores a removed worktree on the branch it had", async () => {
  const { host, provider } = start({
    hostReply: () => ({ status: "created", path: "/wt", baseBranch: "main" }),
  });
  const ctx = context({ kind: "new", from: { kind: "default" } });
  await provider.restore!({
    ...(ctx.value as object),
    previous: { environment: { branchName: "bb/thread-1" }, resource: null },
  } as never);
  expect(host.harness.inspection.experimental_hostRpcCalls[0]?.input).toMatchObject({
    branch: { kind: "checkout", name: "bb/thread-1" },
  });
});

it("is unavailable when the project's origin is on another server", async () => {
  const { provider } = start();
  const check = async (gitRemote: string | null) =>
    provider.availability!({ gitRemote, project: {}, host: {}, projectCheckout: null } as never);
  await expect(check("https://github.com/acme/widgets.git")).resolves.toMatchObject({
    status: "unavailable",
  });
  await expect(check("https://gitea.example/acme/widgets.git")).resolves.toEqual({
    status: "available",
  });
  await expect(check(null)).resolves.toEqual({ status: "available" });
});

it("returns ordered remote branches, and reports errors without throwing", async () => {
  let fail = false;
  const { host } = start({
    deps: {
      readRemoteBranches: async () => {
        if (fail) throw new Error("Gitea API returned HTTP 403.");
        return {
          truncated: false,
          branches: [
            { name: "main", authors: ["ops"], updatedAt: "2026-09-10T00:00:00Z" },
            { name: "mine", authors: ["dev"], updatedAt: "2026-09-01T00:00:00Z" },
          ],
          pulls: [],
        };
      },
    },
  });
  const call = (refresh: boolean) =>
    host.harness.behavior.callRpc("remoteBranches", { projectId: "project-1", refresh });
  await expect(call(false)).resolves.toMatchObject({
    repo: "acme/widgets",
    error: null,
    branches: [{ name: "mine", group: "mine" }, { name: "main", group: "other" }],
  });
  fail = true;
  await expect(call(false)).resolves.toMatchObject({ branches: [{ name: "mine" }, { name: "main" }] });
  await expect(call(true)).resolves.toEqual({
    repo: "acme/widgets",
    branches: [],
    truncated: false,
    error: "Gitea API returned HTTP 403.",
  });
});

it("returns no branches for a project that is not on Gitea", async () => {
  const { host } = start({ deps: { repoFromCheckout: async () => null } });
  await expect(
    host.harness.behavior.callRpc("remoteBranches", { projectId: "project-1", refresh: false }),
  ).resolves.toEqual({ repo: null, branches: [], truncated: false, error: null });
});

it("reads CI states for my branches or other branches on request, and keeps finished results longer", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  disposers.push(() => void vi.useRealTimers());
  const reads: string[] = [];
  const results: Record<string, "passing" | "running"> = { "sha-1": "passing", "sha-2": "running" };
  const openPull = (number: number) => ({
    number,
    title: `PR ${number}`,
    url: `https://gitea.example/acme/widgets/pulls/${number}`,
    author: number === 1 ? "dev" : "ops",
    headBranch: `b${number}`,
    state: "open" as const,
    status: "checking" as const,
    sha: `sha-${number}`,
    updatedAt: "2026-09-01T00:00:00Z",
  });
  const { host } = start({
    deps: {
      readRemoteBranches: async () => ({
        truncated: false,
        branches: [1, 2].map((number) => ({
          name: `b${number}`,
          authors: [],
          updatedAt: "2026-09-01T00:00:00Z",
        })),
        pulls: [openPull(1), openPull(2)],
      }),
      readCiStatus: async (_repo, sha) => {
        reads.push(sha);
        return results[sha]!;
      },
    },
  });
  const statuses = (others: boolean) =>
    host.harness.behavior.callRpc("remotePullStatuses", { projectId: "project-1", others });
  await expect(
    host.harness.behavior.callRpc("remoteBranches", { projectId: "project-1", refresh: false }),
  ).resolves.toMatchObject({ branches: [{ pull: { status: "checking" } }, { pull: { status: "checking" } }] });
  expect(reads).toEqual([]);
  await expect(statuses(false)).resolves.toEqual({
    statuses: [{ number: 1, status: "passing" }],
  });
  expect(reads).toEqual(["sha-1"]);
  await expect(statuses(true)).resolves.toEqual({
    statuses: [{ number: 2, status: "running" }],
  });
  vi.setSystemTime(Date.now() + 25_000);
  await statuses(false);
  await statuses(true);
  expect(reads).toEqual(["sha-1", "sha-2", "sha-2"]);
});

it("uses the checkout's own origin, not the remote BB recorded for the project", async () => {
  const checkouts: Record<string, string | null> = {
    "/src/moved": "acme/widgets",
    "/src/elsewhere": null,
  };
  const { provider } = start({ deps: { repoFromCheckout: async (path) => checkouts[path] ?? null } });
  const check = async (path: string) =>
    provider.availability!({
      gitRemote: "https://github.com/acme/widgets.git",
      project: {},
      host: {},
      projectCheckout: { path },
    } as never);
  await expect(check("/src/moved")).resolves.toEqual({ status: "available" });
  await expect(check("/src/elsewhere")).resolves.toMatchObject({ status: "unavailable" });
});
