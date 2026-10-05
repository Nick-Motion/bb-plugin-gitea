import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export {
  GITEA_BRANCH_ENVIRONMENT_PROVIDER_ID,
  giteaBranchInputsSchema,
  type GiteaBranchInputs,
} from "./branch-inputs.js";

export const discoveredWorktreeSchema = z
  .object({
    path: z.string().min(1),
    branch: z.string().nullable(),
    locked: z.boolean(),
    prunable: z.boolean(),
  })
  .strict();
export type DiscoveredWorktree = z.infer<typeof discoveredWorktreeSchema>;

const failedSchema = z
  .object({ status: z.literal("failed"), message: z.string().min(1) })
  .strict();

/** Git work that runs on the machine that holds the project checkout. */
export const giteaBranchHostContract = defineRpcContract({
  defaultBaseBranch: {
    input: z.object({ sourcePath: z.string().min(1) }).strict(),
    output: z.object({ branch: z.string().min(1).nullable() }).strict(),
  },
  listWorktrees: {
    input: z.object({ sourcePath: z.string().min(1) }).strict(),
    output: z.object({ worktrees: z.array(discoveredWorktreeSchema) }).strict(),
  },
  create: {
    input: z
      .object({
        sourcePath: z.string().min(1),
        pathKey: z.string().min(1),
        branch: z.discriminatedUnion("kind", [
          z
            .object({ kind: z.literal("checkout"), name: z.string().min(1) })
            .strict(),
          z
            .object({
              kind: z.literal("new"),
              name: z.string().min(1),
              base: z.string().min(1).nullable(),
            })
            .strict(),
        ]),
      })
      .strict(),
    output: z.discriminatedUnion("status", [
      z
        .object({
          status: z.literal("created"),
          path: z.string().min(1),
          baseBranch: z.string().min(1).nullable(),
        })
        .strict(),
      failedSchema,
    ]),
  },
  useExisting: {
    input: z
      .object({
        sourcePath: z.string().min(1),
        path: z.string().min(1),
        branch: z.string().min(1).nullable(),
      })
      .strict(),
    output: z.discriminatedUnion("status", [
      z
        .object({ status: z.literal("ready"), path: z.string().min(1) })
        .strict(),
      failedSchema,
    ]),
  },
  remove: {
    input: z.object({ path: z.string().min(1) }).strict(),
    output: z.discriminatedUnion("status", [
      z.object({ status: z.literal("removed") }).strict(),
      failedSchema,
    ]),
  },
});

const pullStatusSchema = z.enum([
  "draft",
  "failing",
  "running",
  "passing",
  "none",
  "merged",
  "checking",
]);

export const remoteBranchSchema = z
  .object({
    name: z.string().min(1),
    group: z.enum(["pull", "mine", "other"]),
    pull: z
      .object({
        number: z.number().int(),
        title: z.string(),
        url: z.string(),
        status: pullStatusSchema,
      })
      .nullable(),
    updatedAt: z.string(),
  })
  .strict();
export type RemoteBranch = z.infer<typeof remoteBranchSchema>;

/** RPC methods the "Gitea" environment picker calls. They join the plugin's main RPC contract. */
export const branchRpcMethods = {
  remoteBranches: {
    input: z
      .object({
        projectId: z.string().min(1),
        refresh: z.boolean().default(false),
      })
      .strict(),
    output: z
      .object({
        repo: z.string().nullable(),
        branches: z.array(remoteBranchSchema),
        truncated: z.boolean(),
        error: z.string().nullable(),
      })
      .strict(),
  },
  remotePullStatuses: {
    input: z
      .object({
        projectId: z.string().min(1),
        /** Read the CI states of other people's branches instead of the signed-in user's. */
        others: z.boolean().default(false),
      })
      .strict(),
    output: z
      .object({
        statuses: z.array(
          z.object({ number: z.number().int(), status: pullStatusSchema }).strict(),
        ),
      })
      .strict(),
  },
  branchDefaultBase: {
    input: z
      .object({
        projectId: z.string().min(1),
        hostId: z.string().min(1).nullable(),
      })
      .strict(),
    output: z.object({ branch: z.string().min(1).nullable() }).strict(),
  },
  branchWorktrees: {
    input: z
      .object({ projectId: z.string().min(1), hostId: z.string().min(1) })
      .strict(),
    output: z.object({ worktrees: z.array(discoveredWorktreeSchema) }).strict(),
  },
};
export const branchRpcContract = defineRpcContract(branchRpcMethods);
