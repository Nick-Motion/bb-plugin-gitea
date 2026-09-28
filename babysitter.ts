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
export const babysitPolicySchema = z.union([
  z.object({ fix: z.literal(true), merge: z.boolean() }).strict(),
  z.object({ fix: z.literal(false), merge: z.literal(true) }).strict(),
]);
export type BabysitPolicy = z.infer<typeof babysitPolicySchema>;
export const automationSchema = z
  .object({ fix: z.boolean(), merge: z.boolean() })
  .strict();
export type Automation = z.infer<typeof automationSchema>;
export const automationOptions = {
  fix: z.boolean().optional(),
  merge: z.boolean().optional(),
};
export const setsAutomationOption = [
  (patch: { fix?: boolean; merge?: boolean }) =>
    patch.fix !== undefined || patch.merge !== undefined,
  { message: "Set fix, merge, or both." },
] as const;
export const automationPatchSchema = z
  .object(automationOptions)
  .strict()
  .refine(...setsAutomationOption);
export type AutomationPatch = z.infer<typeof automationPatchSchema>;
const legacyPolicy: BabysitPolicy = { fix: true, merge: true };
const automationOff: Automation = { fix: false, merge: false };

export function activePolicy(automation: Automation): BabysitPolicy | null {
  if (automation.fix) return { fix: true, merge: automation.merge };
  return automation.merge ? { fix: false, merge: true } : null;
}

export function applyAutomationPatch(
  current: Automation,
  patch: AutomationPatch,
): Automation {
  return {
    fix: patch.fix ?? current.fix,
    merge: patch.merge ?? current.merge,
  };
}

export const babysitPreferencesSchema = z
  .object({
    autoFix: z.boolean(),
    autoMerge: z.boolean(),
    execution: babysitExecutionSchema,
  })
  .strict();
export type BabysitPreferences = z.infer<typeof babysitPreferencesSchema>;
const storedPreferencesSchema = z.union([
  babysitPreferencesSchema,
  z
    .object({ autoBabysit: z.boolean(), execution: babysitExecutionSchema })
    .strict()
    .transform(
      ({ autoBabysit, execution }): BabysitPreferences => ({
        autoFix: autoBabysit,
        autoMerge: autoBabysit,
        execution,
      }),
    ),
]);
export const defaultBabysitPreferences: BabysitPreferences = {
  autoFix: false,
  autoMerge: false,
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
  policy: babysitPolicySchema,
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
const storedSessionSchema = z.preprocess(
  (raw) =>
    typeof raw === "object" && raw !== null && !("policy" in raw)
      ? { ...raw, policy: legacyPolicy }
      : raw,
  babysitSessionSchema,
);

export function parseStoredSession(raw: unknown): BabysitSession | null {
  const parsed = storedSessionSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export function parseStoredPreferences(raw: unknown): BabysitPreferences {
  const parsed = storedPreferencesSchema.safeParse(raw);
  return parsed.success ? parsed.data : defaultBabysitPreferences;
}

export function sessionAutomation(session: BabysitSession | null): Automation {
  switch (session?.status) {
    case "watching":
    case "needs_you":
    case "failed":
      return { fix: session.policy.fix, merge: session.policy.merge };
    default:
      return automationOff;
  }
}

export type BabysitAction = "start" | "stop" | "retry";
const actionsSchema = z.object({
  actions: z.array(z.enum(["start", "stop", "retry"])),
  automation: automationSchema,
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
  const automation = sessionAutomation(session);
  return session === null
    ? { status: "idle", actions: start, automation }
    : {
        ...session,
        actions: [...sessionActions(session), ...start],
        automation,
      };
}

export function sessionView(session: BabysitSession) {
  return {
    ...session,
    actions: sessionActions(session),
    automation: sessionAutomation(session),
  };
}

export type AutomationDecision =
  | { kind: "unchanged" }
  | { kind: "stop" }
  | { kind: "start"; policy: BabysitPolicy }
  | { kind: "update"; session: WatchingSession; policy: BabysitPolicy }
  | {
      kind: "resume";
      session: ResumableSession;
      policy: BabysitPolicy;
      cleanupFirst: boolean;
    }
  | { kind: "reject"; reason: "merged" };
type WatchingSession = Extract<BabysitSession, { status: "watching" }>;

export function decideAutomation(
  session: BabysitSession | null,
  patch: AutomationPatch,
): AutomationDecision {
  const policy = activePolicy(
    applyAutomationPatch(sessionAutomation(session), patch),
  );
  if (policy === null)
    return decideStop(session) ? { kind: "stop" } : { kind: "unchanged" };
  if (session?.status === "merged") return { kind: "reject", reason: "merged" };
  if (session === null || session.status === "closed")
    return { kind: "start", policy };
  if (session.status !== "stopped" && samePolicy(session.policy, policy))
    return { kind: "unchanged" };
  return session.status === "watching"
    ? { kind: "update", session, policy }
    : {
        kind: "resume",
        session,
        policy,
        cleanupFirst: session.status === "failed" && session.cleanupPending,
      };
}

function samePolicy(left: BabysitPolicy, right: BabysitPolicy): boolean {
  return left.fix === right.fix && left.merge === right.merge;
}

export type RetryDecision =
  | { kind: "start"; policy: BabysitPolicy }
  | { kind: "existing"; threadId: string }
  | { kind: "reject"; reason: "merged" | "idle" }
  | { kind: "resume"; session: ResumableSession; cleanupFirst: boolean };
export type ResumableSession = Extract<
  BabysitSession,
  { status: "needs_you" | "failed" | "stopped" }
>;

export function decideRetry(session: BabysitSession | null): RetryDecision {
  if (session === null) return { kind: "reject", reason: "idle" };
  switch (session.status) {
    case "merged":
      return { kind: "reject", reason: "merged" };
    case "closed":
      return { kind: "start", policy: session.policy };
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

function retained(session: BabysitSession, now: string) {
  return {
    repo: session.repo,
    number: session.number,
    threadId: session.threadId,
    updatedAt: now,
    policy: session.policy,
  };
}

function terminal(
  session: BabysitSession,
  lifecycle: Exclude<PullLifecycle, { state: "open" }>,
  now: string,
): BabysitSession {
  const base = retained(session, now);
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
    ...retained(session, now),
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
  return session.status === "watching" ? stopped(session, now) : null;
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

export function stopped(
  session: BabysitSession,
  now: string,
): Extract<BabysitSession, { status: "stopped" }> {
  return { ...retained(session, now), status: "stopped" };
}

export function watching(
  session: BabysitSession,
  policy: BabysitPolicy,
  now: string,
): BabysitSession {
  return { ...retained(session, now), policy, status: "watching" };
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
    right.updatedAt === left.updatedAt &&
    samePolicy(right.policy, left.policy)
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

function policyInstructions(
  policy: BabysitPolicy,
  flags: string,
  api: string,
  number: number,
): string[] {
  const fix = policy.fix
    ? [
        "Auto-fix is on. Fix failing CI checks and address review feedback.",
        `You can fix, commit, push, rebase, reply to review comments (\`tea pulls reply ${flags} ${number} <comment id> <reply>\`), resolve addressed review comments (\`tea pulls resolve ${flags} <comment id>\`), and mark a WIP pull request ready for review (\`tea pulls edit ${flags} --ready ${number}\`, which only strips a leading \`WIP: \` or \`[WIP]\` title prefix). Do not change the title otherwise.`,
        "Test each code change before you push it.",
      ]
    : [
        "Auto-fix is off. Do not change code, commit, push, rebase, reply to or resolve review comments, or edit the pull request.",
        "If a required check fails, changes are requested, or the branch conflicts with its base, finish with NEEDS_YOU and say what blocks the merge.",
      ];
  const merge = policy.merge
    ? [
        "Auto-merge is on. Gitea has no auto-merge setting that you may enable; do not try to schedule one.",
        `Merge only with \`tea pulls merge ${flags} --style <style> ${number}\`, and only when your Gitea permissions allow it, branch protection is satisfied, every required status check passes, and required approvals are present.`,
        `Use the repository's default merge style (\`default_merge_style\` from \`${api}\`). Use squash only if the repository or a human requires it.`,
      ]
    : [
        "Auto-merge is off. Never merge this pull request, and do not enable or schedule a merge. A human merges it; keep watching until Gitea reports it merged or closed.",
      ];
  return [...fix, ...merge];
}

export function buildBabysitterPrompt(input: {
  repo: string;
  number: number;
  title: string;
  baseUrl: string;
  login: string;
  policy: BabysitPolicy;
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
    "2. Complete the next permitted action that can advance the PR.",
    "3. After each state change, return to step 1.",
    "4. If no permitted action is possible, run `sleep 300`. Then return to step 1.",
    "",
    "These Auto-fix and Auto-merge settings replace any earlier instructions in this thread:",
    ...policyInstructions(input.policy, flags, api, input.number),
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
