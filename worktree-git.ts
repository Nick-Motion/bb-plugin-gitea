import { execFile } from "node:child_process";
import { access, realpath, rm, rmdir } from "node:fs/promises";
import path from "node:path";
import type { DiscoveredWorktree } from "./branch-contract.js";

const REMOTE = "origin";
const GIT_TIMEOUT_MS = 10 * 60 * 1000;
const PATH_KEY_PATTERN = /^[A-Za-z0-9._-]+$/;

interface GitResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface GitOptions {
  cwd: string;
  signal?: AbortSignal;
  allowFailure?: boolean;
}

export class GitError extends Error {}

export function runGit(args: string[], options: GitOptions): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      {
        cwd: options.cwd,
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: 16 * 1024 * 1024,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
        ...(options.signal ? { signal: options.signal } : {}),
      },
      (error, stdout, stderr) => {
        if (options.signal?.aborted) {
          reject(options.signal.reason);
          return;
        }
        const exitCode =
          error === null
            ? 0
            : typeof error.code === "number"
              ? error.code
              : 1;
        if (exitCode !== 0 && !options.allowFailure) {
          const detail = stderr.trim() || stdout.trim() || error?.message;
          reject(new GitError(`git ${args[0]} failed: ${detail}`));
          return;
        }
        resolve({ exitCode, stdout, stderr });
      },
    );
  });
}

async function hasRef(cwd: string, ref: string, signal?: AbortSignal) {
  const result = await runGit(["show-ref", "--verify", "--quiet", ref], {
    cwd,
    signal,
    allowFailure: true,
  });
  return result.exitCode === 0;
}

/** Rejects names that git would not accept as a branch, or would read as an option. */
export async function assertBranchName(cwd: string, name: string) {
  const result = await runGit(["check-ref-format", "--branch", name], {
    cwd,
    allowFailure: true,
  });
  if (result.exitCode !== 0 || name.startsWith("-"))
    throw new GitError(`"${name}" is not a valid branch name.`);
}

async function fetchRemoteBranch(
  cwd: string,
  name: string,
  signal?: AbortSignal,
): Promise<boolean> {
  const result = await runGit(
    ["fetch", "--quiet", REMOTE, `+refs/heads/${name}:refs/remotes/${REMOTE}/${name}`],
    { cwd, signal, allowFailure: true },
  );
  return result.exitCode === 0;
}

/** Fast-forwards the checked-out branch to its remote copy when that is possible. */
async function fastForward(cwd: string, name: string, signal?: AbortSignal) {
  if (await hasRef(cwd, `refs/remotes/${REMOTE}/${name}`, signal))
    await runGit(["merge", "--ff-only", "--quiet", `${REMOTE}/${name}`], {
      cwd,
      signal,
      allowFailure: true,
    });
}

/** The remote's default branch, or the source checkout's current branch. */
export async function defaultBaseBranch(
  sourcePath: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const remoteHead = await runGit(
    ["symbolic-ref", "--quiet", "--short", `refs/remotes/${REMOTE}/HEAD`],
    { cwd: sourcePath, signal, allowFailure: true },
  );
  const remoteName = remoteHead.stdout.trim();
  if (remoteHead.exitCode === 0 && remoteName.startsWith(`${REMOTE}/`))
    return remoteName.slice(REMOTE.length + 1);
  const head = await runGit(["symbolic-ref", "--quiet", "--short", "HEAD"], {
    cwd: sourcePath,
    signal,
    allowFailure: true,
  });
  return head.exitCode === 0 && head.stdout.trim() ? head.stdout.trim() : null;
}

interface WorktreeEntry extends DiscoveredWorktree {
  isMain: boolean;
  isBare: boolean;
}

export function parseWorktreeList(stdout: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  let current: WorktreeEntry | null = null;
  for (const field of stdout.split("\0")) {
    if (field === "") {
      if (current) entries.push(current);
      current = null;
      continue;
    }
    const separator = field.indexOf(" ");
    const key = separator === -1 ? field : field.slice(0, separator);
    const value = separator === -1 ? "" : field.slice(separator + 1);
    if (key === "worktree") {
      if (current) entries.push(current);
      current = {
        path: value,
        branch: null,
        locked: false,
        prunable: false,
        isMain: entries.length === 0,
        isBare: false,
      };
    } else if (current) {
      if (key === "branch")
        current.branch = value.replace(/^refs\/heads\//, "");
      else if (key === "bare") current.isBare = true;
      else if (key === "locked") current.locked = true;
      else if (key === "prunable") current.prunable = true;
    }
  }
  if (current) entries.push(current);
  return entries;
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

async function resolvedPath(value: string): Promise<string> {
  try {
    return await realpath(value);
  } catch {
    return path.resolve(value);
  }
}

/** Worktrees of the repository, without the main checkout and the ones this plugin manages. */
export async function listWorktrees(args: {
  sourcePath: string;
  managedRoot: string;
  signal?: AbortSignal;
}): Promise<DiscoveredWorktree[]> {
  const result = await runGit(["worktree", "list", "--porcelain", "-z"], {
    cwd: args.sourcePath,
    signal: args.signal,
  });
  const managedRoot = await resolvedPath(args.managedRoot);
  return parseWorktreeList(result.stdout)
    .filter(
      (entry) =>
        !entry.isMain &&
        !entry.isBare &&
        entry.path !== "" &&
        !isInside(managedRoot, entry.path),
    )
    .map(({ path, branch, locked, prunable }) => ({
      path,
      branch,
      locked,
      prunable,
    }));
}

export function worktreeTargetPath(args: {
  managedRoot: string;
  pathKey: string;
  sourcePath: string;
}): string {
  if (
    !PATH_KEY_PATTERN.test(args.pathKey) ||
    args.pathKey === "." ||
    args.pathKey === ".."
  )
    throw new GitError(`Invalid worktree path key "${args.pathKey}".`);
  const name =
    path.basename(args.sourcePath.replace(/[\\/]+$/, "")).replace(/\.git$/, "") ||
    "repo";
  return path.join(args.managedRoot, args.pathKey, name);
}

async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

export type CreateBranch =
  | { kind: "checkout"; name: string }
  | { kind: "new"; name: string; base: string | null };

/**
 * Creates a worktree at `targetPath`.
 *
 * `checkout` puts the worktree on the branch itself: it fetches the branch
 * from origin, then reuses the local branch or creates one that tracks
 * origin. `new` creates a new branch from `base`, or from the default branch
 * when `base` is null.
 */
export async function createWorktree(args: {
  sourcePath: string;
  targetPath: string;
  branch: CreateBranch;
  signal?: AbortSignal;
}): Promise<{ path: string; baseBranch: string | null }> {
  const { sourcePath, targetPath, branch, signal } = args;
  await assertBranchName(sourcePath, branch.name);
  if (await exists(targetPath)) await removeWorktree({ path: targetPath, signal });

  if (branch.kind === "checkout") {
    await fetchRemoteBranch(sourcePath, branch.name, signal);
    if (await hasRef(sourcePath, `refs/heads/${branch.name}`, signal)) {
      await runGit(["worktree", "add", targetPath, branch.name], {
        cwd: sourcePath,
        signal,
      });
      await fastForward(targetPath, branch.name, signal);
    } else if (
      await hasRef(sourcePath, `refs/remotes/${REMOTE}/${branch.name}`, signal)
    ) {
      await runGit(
        ["worktree", "add", "--track", "-b", branch.name, targetPath, `${REMOTE}/${branch.name}`],
        { cwd: sourcePath, signal },
      );
    } else {
      throw new GitError(`Branch ${branch.name} was not found on ${REMOTE}.`);
    }
    return {
      path: targetPath,
      baseBranch: await defaultBaseBranch(sourcePath, signal),
    };
  }

  const base = branch.base ?? (await defaultBaseBranch(sourcePath, signal));
  if (base === null)
    throw new GitError("Could not find the repository's default branch.");
  const remotePrefix = `${REMOTE}/`;
  const baseName = base.startsWith(remotePrefix)
    ? base.slice(remotePrefix.length)
    : base;
  await assertBranchName(sourcePath, baseName);
  const fetched = await fetchRemoteBranch(sourcePath, baseName, signal);
  // The default branch starts from its fresh remote copy. A named local
  // branch starts from the local branch.
  const useRemote =
    base.startsWith(remotePrefix) ||
    (fetched && branch.base === null) ||
    !(await hasRef(sourcePath, `refs/heads/${base}`, signal));
  const startPoint = useRemote ? `${remotePrefix}${baseName}` : base;
  await runGit(
    ["worktree", "add", "--no-track", "-B", branch.name, targetPath, startPoint],
    { cwd: sourcePath, signal },
  );
  return { path: targetPath, baseBranch: baseName };
}

/**
 * Checks that `worktreePath` is a usable worktree of the repository. When
 * `branch` is set, switches the worktree to that branch. Refuses to switch a
 * worktree that has uncommitted changes.
 */
export async function useExistingWorktree(args: {
  sourcePath: string;
  managedRoot: string;
  worktreePath: string;
  branch: string | null;
  signal?: AbortSignal;
}): Promise<{ path: string }> {
  const { sourcePath, branch, signal } = args;
  const target = await resolvedPath(args.worktreePath);
  const worktrees = await listWorktrees(args);
  const entry = (
    await Promise.all(
      worktrees.map(async (worktree) => ({
        worktree,
        path: await resolvedPath(worktree.path),
      })),
    )
  ).find((candidate) => candidate.path === target)?.worktree;
  if (!entry)
    throw new GitError(`${args.worktreePath} is not a worktree of this repository.`);
  if (entry.prunable)
    throw new GitError(
      `${entry.path} is a prunable worktree. Run \`git worktree prune\` or repair it first.`,
    );
  if (branch === null) return { path: entry.path };

  await assertBranchName(sourcePath, branch);
  const status = await runGit(["status", "--porcelain"], {
    cwd: entry.path,
    signal,
  });
  if (status.stdout.trim())
    throw new GitError(
      `${entry.path} has uncommitted changes. Commit or stash them before switching to ${branch}.`,
    );
  await fetchRemoteBranch(sourcePath, branch, signal);
  if (entry.branch !== branch) {
    if (await hasRef(sourcePath, `refs/heads/${branch}`, signal))
      await runGit(["switch", "--quiet", branch], { cwd: entry.path, signal });
    else if (await hasRef(sourcePath, `refs/remotes/${REMOTE}/${branch}`, signal))
      await runGit(
        ["switch", "--quiet", "--track", "-c", branch, `${REMOTE}/${branch}`],
        { cwd: entry.path, signal },
      );
    else throw new GitError(`Branch ${branch} was not found on ${REMOTE}.`);
  }
  await fastForward(entry.path, branch, signal);
  return { path: entry.path };
}

/** Removes a worktree this plugin created, and its folder. */
export async function removeWorktree(args: {
  path: string;
  signal?: AbortSignal;
}): Promise<void> {
  const target = path.resolve(args.path);
  if (await exists(target)) {
    const commonDir = await runGit(["rev-parse", "--git-common-dir"], {
      cwd: target,
      signal: args.signal,
      allowFailure: true,
    });
    if (commonDir.exitCode === 0) {
      const gitDir = path.resolve(target, commonDir.stdout.trim());
      await runGit(
        ["--git-dir", gitDir, "worktree", "remove", "--force", target],
        { cwd: path.dirname(target), signal: args.signal, allowFailure: true },
      );
    }
    await rm(target, { recursive: true, force: true });
  }
  try {
    await rmdir(path.dirname(target));
  } catch {}
}
