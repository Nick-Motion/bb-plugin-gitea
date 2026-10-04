import path from "node:path";
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { giteaBranchHostContract } from "./branch-contract.js";
import {
  createWorktree,
  defaultBaseBranch,
  listWorktrees,
  removeWorktree,
  useExistingWorktree,
  worktreeTargetPath,
} from "./worktree-git.js";

function managedRoot(dataDir: string): string {
  return path.join(dataDir, "worktrees");
}

function failed(error: unknown, signal: AbortSignal) {
  if (signal.aborted) throw error;
  return {
    status: "failed",
    message: error instanceof Error ? error.message : String(error),
  } as const;
}

export default experimental_defineHostEntry({
  contract: giteaBranchHostContract,
  handlers: {
    async defaultBaseBranch(input, context) {
      return {
        branch: await defaultBaseBranch(input.sourcePath, context.signal),
      };
    },
    async listWorktrees(input, context) {
      return {
        worktrees: await listWorktrees({
          sourcePath: input.sourcePath,
          managedRoot: managedRoot(context.experimental_paths.dataDir),
          signal: context.signal,
        }),
      };
    },
    async create(input, context) {
      try {
        const root = managedRoot(context.experimental_paths.dataDir);
        const created = await createWorktree({
          sourcePath: input.sourcePath,
          targetPath: worktreeTargetPath({
            managedRoot: root,
            pathKey: input.pathKey,
            sourcePath: input.sourcePath,
          }),
          branch: input.branch,
          signal: context.signal,
        });
        return { status: "created", ...created } as const;
      } catch (error) {
        return failed(error, context.signal);
      }
    },
    async useExisting(input, context) {
      try {
        const ready = await useExistingWorktree({
          sourcePath: input.sourcePath,
          managedRoot: managedRoot(context.experimental_paths.dataDir),
          worktreePath: input.path,
          branch: input.branch,
          signal: context.signal,
        });
        return { status: "ready", path: ready.path } as const;
      } catch (error) {
        return failed(error, context.signal);
      }
    },
    async remove(input, context) {
      try {
        await removeWorktree({ path: input.path, signal: context.signal });
        return { status: "removed" } as const;
      } catch (error) {
        return failed(error, context.signal);
      }
    },
  },
});
