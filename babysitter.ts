import { z } from "zod";

export const babysitExecutionSchema = z
  .object({
    providerId: z.string().min(1),
    model: z.string().min(1),
    reasoningLevel: z.enum([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
      "none",
      "ultra",
      "ultracode",
    ]),
    serviceTier: z.enum(["fast", "default"]),
  })
  .strict();
export const babysitPreferencesSchema = z
  .object({ autoBabysit: z.boolean(), execution: babysitExecutionSchema })
  .strict();
export type BabysitPreferences = z.infer<typeof babysitPreferencesSchema>;
export const defaultBabysitPreferences: BabysitPreferences = {
  autoBabysit: false,
  execution: {
    providerId: "codex",
    model: "gpt-5.6-luna",
    reasoningLevel: "xhigh",
    serviceTier: "default",
  },
};

const sessionBase = z.object({
  repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
  number: z.number().int().positive(),
  threadId: z.string().min(1),
  updatedAt: z.string().min(1),
});
export const babysitSessionSchema = z.discriminatedUnion("status", [
  sessionBase.extend({ status: z.literal("watching") }),
  sessionBase.extend({ status: z.literal("needs_you"), note: z.string() }),
  sessionBase.extend({
    status: z.literal("failed"),
    error: z.string().min(1),
    cleanupPending: z.boolean(),
  }),
  sessionBase.extend({ status: z.literal("merged"), mergedAt: z.string() }),
  sessionBase.extend({ status: z.literal("closed"), closedAt: z.string() }),
  sessionBase.extend({ status: z.literal("stopped") }),
]);
export type BabysitSession = z.infer<typeof babysitSessionSchema>;
export type BabysitAction = "start" | "stop" | "retry";
const actionsSchema = z.object({
  actions: z.array(z.enum(["start", "stop", "retry"])),
});
export const babysitSessionViewSchema = z.intersection(
  babysitSessionSchema,
  actionsSchema,
);
export const babysitViewSchema = z.intersection(
  z.discriminatedUnion("status", [
    z.object({ status: z.literal("idle") }),
    ...babysitSessionSchema.options,
  ]),
  actionsSchema,
);
export type BabysitView = z.infer<typeof babysitViewSchema>;

export type PullLifecycle =
  | { state: "open" }
  | { state: "merged"; mergedAt: string }
  | { state: "closed"; closedAt: string };
export type LifecycleFact = PullLifecycle | { state: "unknown"; error: string };

type Marker = "merged" | "closed" | "needs_you" | "failed";
const maxMessageLength = 4000;
export const giteaBabysitterTitlePrefix = "Gitea babysitter:";

function clip(value: string) {
  return value.length > maxMessageLength
    ? `${value.slice(0, maxMessageLength - 1)}…`
    : value;
}

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

export function parseLifecycle(raw: unknown): PullLifecycle | null {
  if (typeof raw !== "object" || raw === null) return null;
  const pull = raw as Record<string, unknown>;
  if (pull.merged === true) {
    const mergedAt = nonEmpty(pull.merged_at) ?? nonEmpty(pull.closed_at);
    return mergedAt ? { state: "merged", mergedAt } : null;
  }
  if (pull.merged !== false) return null;
  if (pull.state === "open") return { state: "open" };
  if (pull.state === "closed") {
    const closedAt = nonEmpty(pull.closed_at) ?? nonEmpty(pull.updated_at);
    return closedAt ? { state: "closed", closedAt } : null;
  }
  return null;
}

export function parseMarker(text: string | null): Marker | null {
  const found = [
    ...(text ?? "").matchAll(
      /BB_GITEA_BABYSIT:\s*(MERGED|CLOSED|NEEDS_YOU|FAILED)\b/g,
    ),
  ].map((match) => match[1]!.toLowerCase() as Marker);
  return new Set(found).size === 1 ? found[0]! : null;
}

export function sessionActions(session: BabysitSession): BabysitAction[] {
  switch (session.status) {
    case "watching":
      return ["stop"];
    case "needs_you":
    case "failed":
      return ["stop", "retry"];
    case "stopped":
      return ["retry"];
    case "merged":
    case "closed":
      return [];
  }
}

export function pullKey(repo: string, number: number): string {
  return `${repo.toLowerCase()}#${number}`;
}

export type StartRejection = "merged" | "closed" | "no-project";

export function startError(key: string, reason: StartRejection): string {
  return reason === "no-project"
    ? `Cannot babysit ${key}: no BB project has a checkout of this repository.`
    : `Cannot babysit ${key}: the pull request is ${reason}.`;
}

type ClosedSession = Extract<BabysitSession, { status: "closed" }>;
export type StartDecision =
  | { kind: "existing"; threadId: string }
  | { kind: "spawn"; projectId: string; replaces: ClosedSession | null }
  | { kind: "reject"; reason: StartRejection };

export function decideStart(input: {
  session: BabysitSession | null;
  projectId: string | null;
  lifecycle: PullLifecycle;
}): StartDecision {
  const { session, lifecycle } = input;
  if (session?.status === "merged") return { kind: "reject", reason: "merged" };
  if (session !== null && session.status !== "closed")
    return { kind: "existing", threadId: session.threadId };
  if (lifecycle.state !== "open")
    return { kind: "reject", reason: lifecycle.state };
  if (input.projectId === null) return { kind: "reject", reason: "no-project" };
  return { kind: "spawn", projectId: input.projectId, replaces: session };
}

export function babysitView(
  session: BabysitSession | null,
  facts: { lifecycle: LifecycleFact; projectId: string | null } | null,
): BabysitView {
  const start: BabysitAction[] =
    facts !== null &&
    facts.lifecycle.state !== "unknown" &&
    decideStart({
      session,
      projectId: facts.projectId,
      lifecycle: facts.lifecycle,
    }).kind === "spawn"
      ? ["start"]
      : [];
  return session === null
    ? { status: "idle", actions: start }
    : { ...session, actions: [...sessionActions(session), ...start] };
}

export type RetryDecision =
  | { kind: "start" }
  | { kind: "existing"; threadId: string }
  | { kind: "reject"; reason: "merged" }
  | { kind: "resume"; session: ResumableSession; cleanupFirst: boolean };
type ResumableSession = Extract<
  BabysitSession,
  { status: "needs_you" | "failed" | "stopped" }
>;

export function decideRetry(session: BabysitSession | null): RetryDecision {
  if (session === null) return { kind: "start" };
  switch (session.status) {
    case "merged":
      return { kind: "reject", reason: "merged" };
    case "closed":
      return { kind: "start" };
    case "watching":
      return { kind: "existing", threadId: session.threadId };
    case "failed":
      return {
        kind: "resume",
        session,
        cleanupFirst: session.cleanupPending,
      };
    case "needs_you":
    case "stopped":
      return { kind: "resume", session, cleanupFirst: false };
  }
}

export function decideStop(
  session: BabysitSession | null,
): Extract<
  BabysitSession,
  { status: "watching" | "needs_you" | "failed" }
> | null {
  return session?.status === "watching" ||
    session?.status === "needs_you" ||
    session?.status === "failed"
    ? session
    : null;
}

function terminal(
  session: BabysitSession,
  lifecycle: Exclude<PullLifecycle, { state: "open" }>,
  now: string,
): BabysitSession {
  const base = {
    repo: session.repo,
    number: session.number,
    threadId: session.threadId,
    updatedAt: now,
  };
  return lifecycle.state === "merged"
    ? { ...base, status: "merged", mergedAt: lifecycle.mergedAt }
    : { ...base, status: "closed", closedAt: lifecycle.closedAt };
}

function failed(
  session: BabysitSession,
  error: string,
  now: string,
  cleanupPending = false,
): BabysitSession {
  return {
    repo: session.repo,
    number: session.number,
    threadId: session.threadId,
    updatedAt: now,
    status: "failed",
    error: clip(error),
    cleanupPending,
  };
}

export function confirmedTerminal(
  session: BabysitSession,
  lifecycle: LifecycleFact,
  now: string,
): BabysitSession | null {
  return lifecycle.state === "merged" || lifecycle.state === "closed"
    ? terminal(session, lifecycle, now)
    : null;
}

export function onIdle(
  session: BabysitSession,
  lastText: string | null,
  lifecycle: LifecycleFact,
  now: string,
): BabysitSession | null {
  if (session.status !== "watching") return null;
  const marker = parseMarker(lastText);
  const summary = lastText?.trim() ?? "";
  if (lifecycle.state === "merged" || lifecycle.state === "closed")
    return (marker === "merged" || marker === "closed") &&
      marker !== lifecycle.state
      ? failed(
          session,
          `Gitea reported ${lifecycle.state.toUpperCase()}, not ${marker.toUpperCase()}.`,
          now,
        )
      : terminal(session, lifecycle, now);
  if (marker === "needs_you")
    return {
      ...session,
      status: "needs_you",
      note: clip(summary),
      updatedAt: now,
    };
  if (marker === "failed")
    return failed(session, summary || "Babysitter reported FAILED.", now);
  if (lifecycle.state === "unknown")
    return failed(
      session,
      `Could not confirm the Gitea pull request state: ${lifecycle.error}`,
      now,
    );
  if (marker === null)
    return failed(
      session,
      summary ||
        "Babysitter turn ended without a terminal marker or a confirmed Gitea terminal state.",
      now,
    );
  return failed(
    session,
    `Gitea still reports the pull request open; it did not confirm ${marker.toUpperCase()}.`,
    now,
  );
}

export function onFailed(
  session: BabysitSession,
  error: string | null,
  now: string,
): BabysitSession | null {
  return session.status === "watching"
    ? failed(session, error?.trim() || "Gitea babysitter thread failed.", now)
    : null;
}

export function onArchived(
  session: BabysitSession,
  now: string,
): BabysitSession | null {
  return session.status === "watching"
    ? {
        repo: session.repo,
        number: session.number,
        threadId: session.threadId,
        updatedAt: now,
        status: "stopped",
      }
    : null;
}

export function onCleanupFailed(
  session: BabysitSession,
  detail: string,
  now: string,
): BabysitSession {
  const previous =
    session.status === "failed"
      ? ` (${session.error.replace(/^Cleanup failed: /, "")})`
      : "";
  return failed(session, `Cleanup failed: ${detail}${previous}`, now, true);
}

export function stopped(session: BabysitSession, now: string): BabysitSession {
  return {
    repo: session.repo,
    number: session.number,
    threadId: session.threadId,
    updatedAt: now,
    status: "stopped",
  };
}

export function watching(session: BabysitSession, now: string): BabysitSession {
  return {
    repo: session.repo,
    number: session.number,
    threadId: session.threadId,
    updatedAt: now,
    status: "watching",
  };
}

export function sameSession(
  left: BabysitSession,
  right: BabysitSession | null,
): right is BabysitSession {
  return (
    right !== null &&
    right.repo === left.repo &&
    right.number === left.number &&
    right.threadId === left.threadId &&
    right.status === left.status &&
    right.updatedAt === left.updatedAt
  );
}

export function autoStartTargets<
  T extends { repo: string; number: number; author: string; state: string },
>(input: {
  login: string;
  pulls: T[];
  projects: Map<string, string>;
  sessions: Map<string, BabysitSession>;
}): T[] {
  return input.pulls.filter(
    (pull) =>
      pull.state === "open" &&
      pull.author === input.login &&
      decideStart({
        session: input.sessions.get(pullKey(pull.repo, pull.number)) ?? null,
        projectId: input.projects.get(pull.repo.toLowerCase()) ?? null,
        lifecycle: { state: "open" },
      }).kind === "spawn",
  );
}

export function buildBabysitterPrompt(input: {
  repo: string;
  number: number;
  title: string;
  baseUrl: string;
  login: string;
}): string {
  const ref = `${input.repo}#${input.number}`;
  const flags = `--login ${input.login} --repo ${input.repo}`;
  const api = `tea api --login ${input.login} /api/v1/repos/${input.repo}`;
  return [
    `You are the Gitea PR babysitter for ${ref}: ${input.title}`,
    `Gitea instance: ${input.baseUrl}`,
    "",
    "Use the existing checkout. Do not clone the repository or create a BB project.",
    `Use the tea CLI with the explicit login profile \`${input.login}\` on every command. Do not use gh or GitHub-specific tooling.`,
    "Before you act, read the full PR, diff, conversation, reviews, review comments, and commit statuses:",
    `- \`tea pulls ${flags} --comments ${input.number}\``,
    `- \`${api}/pulls/${input.number}\` and \`${api}/pulls/${input.number}.diff\``,
    `- \`tea pulls review-comments ${flags} ${input.number}\``,
    `- \`${api}/commits/<head sha>/status\``,
    "",
    "Repeat these steps while the PR is open:",
    "1. Read the current PR state.",
    "2. Complete the next action that can advance the PR.",
    "3. Test each code change before you push it.",
    "4. After each state change, return to step 1.",
    "5. If no action is possible, run `sleep 300`. Then return to step 1.",
    "",
    `You can fix, commit, push, rebase, reply to review comments (\`tea pulls reply ${flags} ${input.number} <comment id> <reply>\`), resolve addressed review comments (\`tea pulls resolve ${flags} <comment id>\`), and mark a WIP pull request ready for review (\`tea pulls edit ${flags} --ready ${input.number}\`, which only strips a leading \`WIP: \` or \`[WIP]\` title prefix). Do not change the title otherwise.`,
    "Gitea has no auto-merge setting that this babysitter may enable; do not try to schedule one.",
    `Merge only with \`tea pulls merge ${flags} --style <style> ${input.number}\`, and only when your Gitea permissions allow it, branch protection is satisfied, every required status check passes, and required approvals are present.`,
    `Use the repository's default merge style (\`default_merge_style\` from \`${api}\`). Use squash only if the repository or a human requires it.`,
    "Only missing credentials, missing permissions, destructive choices, and product or scope decisions require a human.",
    "Stay in this turn until the PR is merged, closed, manually stopped, or requires a human.",
    "",
    "Your final response must contain exactly one of these markers:",
    "BB_GITEA_BABYSIT: MERGED",
    "BB_GITEA_BABYSIT: CLOSED",
    "BB_GITEA_BABYSIT: NEEDS_YOU",
    "BB_GITEA_BABYSIT: FAILED",
    "Use FAILED only for an execution failure.",
    "",
    `Start by running: tea pulls ${flags} --comments ${input.number}`,
  ].join("\n");
}
