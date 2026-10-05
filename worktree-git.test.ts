import { afterEach, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createWorktree,
  defaultBaseBranch,
  listWorktrees,
  parseWorktreeList,
  removeWorktree,
  useExistingWorktree,
  worktreeTargetPath,
} from "./worktree-git";

const cleanups: string[] = [];
afterEach(() => {
  for (const path of cleanups.splice(0))
    rmSync(path, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Dev",
      GIT_AUTHOR_EMAIL: "dev@example.com",
      GIT_COMMITTER_NAME: "Dev",
      GIT_COMMITTER_EMAIL: "dev@example.com",
    },
  }).trim();
}

function commit(cwd: string, file: string) {
  writeFileSync(join(cwd, file), file);
  git(cwd, "add", file);
  git(cwd, "commit", "--quiet", "-m", file);
}

/** An origin with `main` and `feature`, and a clone that only has `main` locally. */
function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "gitea-worktree-")));
  cleanups.push(root);
  const origin = join(root, "origin.git");
  const seed = join(root, "seed");
  git(root, "init", "--quiet", "--bare", "--initial-branch=main", origin);
  git(root, "clone", "--quiet", origin, seed);
  commit(seed, "readme");
  git(seed, "push", "--quiet", "origin", "main");
  git(seed, "switch", "--quiet", "-c", "feature");
  commit(seed, "feature");
  git(seed, "push", "--quiet", "origin", "feature");
  const source = join(root, "source");
  git(root, "clone", "--quiet", origin, source);
  return { root, origin, seed, source, managedRoot: join(root, "data", "worktrees") };
}

function target(env: ReturnType<typeof setup>, pathKey: string) {
  return worktreeTargetPath({
    managedRoot: env.managedRoot,
    pathKey,
    sourcePath: env.source,
  });
}

it("creates a worktree on a remote-only branch that tracks origin", async () => {
  const env = setup();
  const created = await createWorktree({
    sourcePath: env.source,
    targetPath: target(env, "attempt-1"),
    branch: { kind: "checkout", name: "feature" },
  });
  expect(created).toEqual({ path: target(env, "attempt-1"), baseBranch: "main" });
  expect(git(created.path, "branch", "--show-current")).toBe("feature");
  expect(git(created.path, "rev-parse", "--abbrev-ref", "@{upstream}")).toBe("origin/feature");
  expect(existsSync(join(created.path, "feature"))).toBe(true);
});

it("reuses and fast-forwards a local branch that already exists", async () => {
  const env = setup();
  git(env.source, "branch", "--quiet", "--track", "feature", "origin/feature");
  commit(env.seed, "more");
  git(env.seed, "push", "--quiet", "origin", "feature");
  const created = await createWorktree({
    sourcePath: env.source,
    targetPath: target(env, "attempt-1"),
    branch: { kind: "checkout", name: "feature" },
  });
  expect(git(created.path, "branch", "--show-current")).toBe("feature");
  expect(existsSync(join(created.path, "more"))).toBe(true);
});

it("fails clearly when the branch is not on origin", async () => {
  const env = setup();
  await expect(
    createWorktree({
      sourcePath: env.source,
      targetPath: target(env, "attempt-1"),
      branch: { kind: "checkout", name: "missing" },
    }),
  ).rejects.toThrow("Branch missing was not found on origin.");
});

it("creates a new untracked branch from the default branch or a named base", async () => {
  const env = setup();
  expect(await defaultBaseBranch(env.source)).toBe("main");
  const fromDefault = await createWorktree({
    sourcePath: env.source,
    targetPath: target(env, "attempt-1"),
    branch: { kind: "new", name: "bb/thread-1", base: null },
  });
  expect(fromDefault.baseBranch).toBe("main");
  expect(git(fromDefault.path, "branch", "--show-current")).toBe("bb/thread-1");
  expect(git(fromDefault.path, "rev-parse", "HEAD")).toBe(git(env.source, "rev-parse", "origin/main"));
  expect(() => git(fromDefault.path, "rev-parse", "--abbrev-ref", "@{upstream}")).toThrow();

  const fromFeature = await createWorktree({
    sourcePath: env.source,
    targetPath: target(env, "attempt-2"),
    branch: { kind: "new", name: "bb/thread-2", base: "origin/feature" },
  });
  expect(fromFeature.baseBranch).toBe("feature");
  expect(existsSync(join(fromFeature.path, "feature"))).toBe(true);
});

it("rejects branch names that git could read as options", async () => {
  const env = setup();
  await expect(
    createWorktree({
      sourcePath: env.source,
      targetPath: target(env, "attempt-1"),
      branch: { kind: "checkout", name: "--force" },
    }),
  ).rejects.toThrow('"--force" is not a valid branch name.');
  expect(() => target(env, "../escape")).toThrow("Invalid worktree path key");
});

it("lists worktrees without the main checkout or the ones it manages", async () => {
  const env = setup();
  const own = join(env.root, "own-worktree");
  git(env.source, "worktree", "add", "--quiet", own, "-b", "own");
  await createWorktree({
    sourcePath: env.source,
    targetPath: target(env, "attempt-1"),
    branch: { kind: "checkout", name: "feature" },
  });
  expect(await listWorktrees({ sourcePath: env.source, managedRoot: env.managedRoot })).toEqual([
    { path: own, branch: "own", locked: false, prunable: false },
  ]);
});

it("switches an existing clean worktree to a remote branch", async () => {
  const env = setup();
  const own = join(env.root, "own-worktree");
  git(env.source, "worktree", "add", "--quiet", own, "-b", "own");
  const result = await useExistingWorktree({
    sourcePath: env.source,
    managedRoot: env.managedRoot,
    worktreePath: own,
    branch: "feature",
  });
  expect(result).toEqual({ path: own });
  expect(git(own, "branch", "--show-current")).toBe("feature");
  expect(git(own, "rev-parse", "--abbrev-ref", "@{upstream}")).toBe("origin/feature");
});

it("refuses to switch a worktree with uncommitted changes", async () => {
  const env = setup();
  const own = join(env.root, "own-worktree");
  git(env.source, "worktree", "add", "--quiet", own, "-b", "own");
  writeFileSync(join(own, "draft"), "draft");
  await expect(
    useExistingWorktree({
      sourcePath: env.source,
      managedRoot: env.managedRoot,
      worktreePath: own,
      branch: "feature",
    }),
  ).rejects.toThrow("has uncommitted changes");
  expect(git(own, "branch", "--show-current")).toBe("own");
  await expect(
    useExistingWorktree({
      sourcePath: env.source,
      managedRoot: env.managedRoot,
      worktreePath: own,
      branch: null,
    }),
  ).resolves.toEqual({ path: own });
});

it("refuses a folder that is not a worktree of the repository", async () => {
  const env = setup();
  await expect(
    useExistingWorktree({
      sourcePath: env.source,
      managedRoot: env.managedRoot,
      worktreePath: env.seed,
      branch: null,
    }),
  ).rejects.toThrow("is not a worktree of this repository");
});

it("removes a created worktree and its empty attempt folder", async () => {
  const env = setup();
  const created = await createWorktree({
    sourcePath: env.source,
    targetPath: target(env, "attempt-1"),
    branch: { kind: "checkout", name: "feature" },
  });
  await removeWorktree({ path: created.path });
  expect(existsSync(created.path)).toBe(false);
  expect(existsSync(join(env.managedRoot, "attempt-1"))).toBe(false);
  expect(git(env.source, "worktree", "list", "--porcelain")).not.toContain(created.path);
});

it("parses porcelain worktree output", () => {
  expect(
    parseWorktreeList(
      "worktree /repo\0HEAD abc\0branch refs/heads/main\0\0worktree /wt\0HEAD def\0detached\0locked\0prunable gone\0\0",
    ),
  ).toEqual([
    { path: "/repo", branch: "main", locked: false, prunable: false, isMain: true, isBare: false },
    { path: "/wt", branch: null, locked: true, prunable: true, isMain: false, isBare: false },
  ]);
});
