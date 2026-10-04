import { z } from "zod";

export const GITEA_BRANCH_ENVIRONMENT_PROVIDER_ID = "gitea-branch";

/**
 * What the "Gitea" environment does when a thread starts.
 *
 * - `new`: create a worktree on a new thread branch that starts from `from`.
 * - `remote`: create a worktree on the remote branch `name` itself.
 * - `existing`: reuse the worktree at `path`. When `remoteBranch` is set,
 *   switch that worktree to the branch first.
 */
export const giteaBranchInputsSchema = z
  .discriminatedUnion("kind", [
    z
      .object({
        kind: z.literal("new"),
        from: z.discriminatedUnion("kind", [
          z.object({ kind: z.literal("default") }).strict(),
          z.object({ kind: z.literal("named"), name: z.string().min(1) }).strict(),
        ]),
      })
      .strict(),
    z
      .object({ kind: z.literal("remote"), name: z.string().min(1) })
      .strict(),
    z
      .object({
        kind: z.literal("existing"),
        path: z.string().min(1),
        remoteBranch: z.string().min(1).optional(),
      })
      .strict(),
  ])
  .default({ kind: "new", from: { kind: "default" } });
export type GiteaBranchInputs = z.infer<typeof giteaBranchInputsSchema>;
