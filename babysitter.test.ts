import { describe, expect, it } from "vitest";
import {
  activePolicy,
  autoStartTargets,
  babysitPolicySchema,
  babysitSessionSchema,
  babysitView,
  buildBabysitterPrompt,
  decideAutomation,
  decideRetry,
  decideStart,
  decideStop,
  onArchived,
  onCleanupFailed,
  onFailed,
  onIdle,
  parseLifecycle,
  parseMarker,
  parseStoredPreferences,
  parseStoredSession,
  stopped,
  type BabysitPolicy,
  type BabysitSession,
} from "./babysitter";

const now = "2026-09-28T00:00:00Z";
const watching: BabysitSession = {
  repo: "acme/widgets",
  number: 42,
  threadId: "thread-1",
  updatedAt: "2026-09-27T00:00:00Z",
  policy: { fix: true, merge: true },
  status: "watching",
};
const open = { state: "open" } as const;
const merged = { state: "merged", mergedAt: "2026-09-27T12:00:00Z" } as const;
const closed = { state: "closed", closedAt: "2026-09-27T12:00:00Z" } as const;

describe("parseLifecycle", () => {
  it("reads Gitea merged and state fields", () => {
    expect(parseLifecycle({ merged: false, state: "open" })).toEqual(open);
    expect(
      parseLifecycle({
        merged: true,
        state: "closed",
        merged_at: "2026-09-27T12:00:00Z",
      }),
    ).toEqual(merged);
    expect(
      parseLifecycle({
        merged: false,
        state: "closed",
        closed_at: "2026-09-27T12:00:00Z",
      }),
    ).toEqual(closed);
  });

  it("rejects responses that do not state a lifecycle", () => {
    expect(parseLifecycle({ state: "open" })).toBeNull();
    expect(parseLifecycle({ merged: true })).toBeNull();
    expect(parseLifecycle({ merged: false, state: "draft" })).toBeNull();
    expect(parseLifecycle(null)).toBeNull();
  });
});

describe("parseMarker", () => {
  it("accepts one distinct marker only", () => {
    expect(parseMarker("done\nBB_GITEA_BABYSIT: MERGED")).toBe("merged");
    expect(
      parseMarker("BB_GITEA_BABYSIT: MERGED\nBB_GITEA_BABYSIT: MERGED"),
    ).toBe("merged");
    expect(
      parseMarker("BB_GITEA_BABYSIT: MERGED\nBB_GITEA_BABYSIT: FAILED"),
    ).toBeNull();
    expect(parseMarker("BB_GITHUB_BABYSIT: MERGED")).toBeNull();
    expect(parseMarker(null)).toBeNull();
  });
});

describe("decisions", () => {
  it("starts only open pull requests in a BB project and reuses retained sessions", () => {
    const input = { session: null, lifecycle: open };
    expect(decideStart({ ...input, projectId: "p1" })).toEqual({
      kind: "spawn",
      projectId: "p1",
      replaces: null,
    });
    expect(decideStart({ ...input, projectId: null })).toEqual({
      kind: "reject",
      reason: "no-project",
    });
    expect(
      decideStart({ ...input, projectId: "p1", lifecycle: merged }),
    ).toEqual({ kind: "reject", reason: "merged" });
    for (const session of [
      watching,
      { ...watching, status: "stopped" as const, cleanupPending: false },
      { ...watching, status: "needs_you" as const, note: "" },
    ])
      expect(decideStart({ ...input, session, projectId: "p1" })).toEqual({
        kind: "existing",
        threadId: "thread-1",
      });
    expect(
      decideStart({
        ...input,
        projectId: "p1",
        session: { ...watching, status: "merged", mergedAt: now },
      }),
    ).toEqual({ kind: "reject", reason: "merged" });
  });

  it("replaces a closed session only when Gitea reports the pull request open again", () => {
    const closedSession: BabysitSession = {
      ...watching,
      status: "closed",
      closedAt: now,
    };
    expect(
      decideStart({ session: closedSession, projectId: "p1", lifecycle: open }),
    ).toEqual({ kind: "spawn", projectId: "p1", replaces: closedSession });
    expect(
      decideStart({
        session: closedSession,
        projectId: "p1",
        lifecycle: closed,
      }),
    ).toEqual({ kind: "reject", reason: "closed" });
    expect(decideRetry(closedSession)).toEqual({
      kind: "reject",
      reason: "inactive",
    });
    expect(
      decideRetry({ ...watching, status: "merged", mergedAt: now }),
    ).toEqual({ kind: "reject", reason: "merged" });
  });

  it("retries only failed or waiting sessions and cleans up first after a cleanup failure", () => {
    const failed = onCleanupFailed(watching, "stop: offline", now);
    expect(decideRetry(failed)).toEqual({
      kind: "resume",
      session: failed,
      cleanupFirst: true,
    });
    expect(
      decideRetry({ ...watching, status: "needs_you", note: "" }),
    ).toMatchObject({ kind: "resume", cleanupFirst: false });
    expect(decideRetry(watching)).toEqual({
      kind: "existing",
      threadId: "thread-1",
    });
    for (const inactive of [
      null,
      stopped(watching, now, false),
      stopped(watching, now, true),
    ])
      expect(decideRetry(inactive)).toEqual({
        kind: "reject",
        reason: "inactive",
      });
  });

  it("keeps a stopped session's cleanup pending until it succeeds", () => {
    const pending = stopped(watching, now, true);
    expect(onCleanupFailed(pending, "archive: offline", now)).toEqual(pending);
    expect(decideStop(pending)).toBe(pending);
    expect(decideAutomation(pending, { fix: false })).toEqual({ kind: "stop" });
    expect(decideAutomation(pending, { fix: true })).toMatchObject({
      kind: "resume",
      cleanupFirst: true,
    });
  });

  it("stops only live, retained or cleanup-pending workers", () => {
    expect(decideStop(watching)).toBe(watching);
    expect(decideStop(stopped(watching, now, false))).toBeNull();
    expect(
      decideStop({ ...watching, status: "merged", mergedAt: now }),
    ).toBeNull();
    expect(decideStop(null)).toBeNull();
  });
});

describe("transitions", () => {
  it("trusts Gitea's terminal state over the agent marker", () => {
    expect(
      onIdle(watching, "BB_GITEA_BABYSIT: NEEDS_YOU", merged, now),
    ).toEqual({
      repo: "acme/widgets",
      number: 42,
      threadId: "thread-1",
      updatedAt: now,
      policy: { fix: true, merge: true },
      status: "merged",
      mergedAt: merged.mergedAt,
    });
    expect(
      onIdle(watching, "BB_GITEA_BABYSIT: MERGED", closed, now),
    ).toMatchObject({
      status: "failed",
      error: "Gitea reported CLOSED, not MERGED.",
    });
  });

  it("fails an unconfirmed terminal marker and records human requests", () => {
    expect(
      onIdle(watching, "BB_GITEA_BABYSIT: MERGED", open, now),
    ).toMatchObject({
      status: "failed",
      error:
        "Gitea still reports the pull request open; it did not confirm MERGED.",
      cleanupPending: false,
    });
    expect(
      onIdle(watching, "Need a token.\nBB_GITEA_BABYSIT: NEEDS_YOU", open, now),
    ).toMatchObject({
      status: "needs_you",
      note: "Need a token.\nBB_GITEA_BABYSIT: NEEDS_YOU",
    });
    expect(
      onIdle(
        watching,
        "BB_GITEA_BABYSIT: CLOSED",
        { state: "unknown", error: "HTTP 500" },
        now,
      ),
    ).toMatchObject({
      status: "failed",
      error: "Could not confirm the Gitea pull request state: HTTP 500",
    });
    expect(onIdle(watching, "  ", open, now)).toMatchObject({
      status: "failed",
      error:
        "Babysitter turn ended without a terminal marker or a confirmed Gitea terminal state.",
    });
  });

  it("ignores lifecycle events for sessions that are no longer watching", () => {
    const halted = stopped(watching, now, false);
    expect(onIdle(halted, "BB_GITEA_BABYSIT: MERGED", merged, now)).toBeNull();
    expect(onFailed(halted, "boom", now)).toBeNull();
    expect(onArchived(halted, now)).toBeNull();
    expect(onArchived(watching, now)).toMatchObject({ status: "stopped" });
    expect(onFailed(watching, null, now)).toMatchObject({
      status: "failed",
      error: "Gitea babysitter thread failed.",
    });
  });

  it("keeps the original failure when cleanup also fails", () => {
    const failed = onFailed(watching, "turn crashed", now)!;
    expect(onCleanupFailed(failed, "archive: offline", now)).toMatchObject({
      status: "failed",
      error: "Cleanup failed: archive: offline (turn crashed)",
      cleanupPending: true,
    });
  });

  it("clips long messages to a valid session", () => {
    const next = onFailed(watching, "x".repeat(10_000), now)!;
    expect(babysitSessionSchema.parse(next)).toMatchObject({
      status: "failed",
    });
    expect(next.status === "failed" && next.error.length).toBe(4000);
  });
});

describe("views and automation", () => {
  it("offers only the actions each state and current Gitea fact supports", () => {
    const openFacts = { lifecycle: open, projectId: "p1" };
    const closedSession: BabysitSession = {
      ...watching,
      status: "closed",
      closedAt: now,
    };
    expect(babysitView(null, openFacts).actions).toEqual(["start"]);
    expect(
      babysitView(null, { ...openFacts, projectId: null }).actions,
    ).toEqual([]);
    expect(babysitView(null, null).actions).toEqual([]);
    expect(babysitView(watching, openFacts).actions).toEqual(["stop"]);
    expect(
      babysitView(stopped(watching, now, false), openFacts).actions,
    ).toEqual(["start"]);
    expect(
      babysitView({ ...watching, status: "merged", mergedAt: now }, openFacts)
        .actions,
    ).toEqual([]);
    expect(babysitView(closedSession, openFacts).actions).toEqual(["start"]);
    expect(
      babysitView(closedSession, { ...openFacts, lifecycle: closed }).actions,
    ).toEqual([]);
    expect(
      babysitView(closedSession, {
        ...openFacts,
        lifecycle: { state: "unknown", error: "HTTP 500" },
      }).actions,
    ).toEqual([]);
  });

  it("targets open authored pull requests in eligible repositories without a live session", () => {
    const pull = (
      repo: string,
      number: number,
      author = "dev",
      state = "open",
    ) => ({
      repo,
      number,
      author,
      state,
    });
    expect(
      autoStartTargets({
        login: "dev",
        pulls: [
          pull("acme/widgets", 1),
          pull("Acme/Widgets", 2),
          pull("acme/widgets", 3, "someone"),
          pull("acme/widgets", 4, "dev", "closed"),
          pull("ops/api", 5),
          pull("acme/widgets", 6),
          pull("Acme/Widgets", 7),
          pull("acme/widgets", 8),
          pull("acme/widgets", 9),
        ],
        projects: new Map([["acme/widgets", "p1"]]),
        sessions: new Map<string, BabysitSession>([
          ["acme/widgets#6", { ...watching, number: 6 }],
          [
            "acme/widgets#7",
            {
              ...watching,
              number: 7,
              status: "stopped",
              cleanupPending: false,
            },
          ],
          [
            "acme/widgets#8",
            { ...watching, number: 8, status: "closed", closedAt: now },
          ],
          [
            "acme/widgets#9",
            { ...watching, number: 9, status: "merged", mergedAt: now },
          ],
        ]),
      }).map((entry) => entry.number),
    ).toEqual([1, 2, 8]);
  });

  it("instructs tea with explicit flags and never enables a Gitea auto-merge", () => {
    const prompt = buildBabysitterPrompt({
      repo: "acme/widgets",
      number: 42,
      title: "Fix it",
      baseUrl: "https://gitea.example/prefix/",
      login: "work",
      policy: { fix: true, merge: true },
    });
    expect(prompt).toContain(
      "tea pulls --login work --repo acme/widgets --comments 42",
    );
    expect(prompt).toContain(
      "tea pulls merge --login work --repo acme/widgets --style <style> 42",
    );
    expect(prompt).toContain("no auto-merge setting");
    expect(prompt).toContain(
      "tea pulls edit --login work --repo acme/widgets --ready 42",
    );
    expect(prompt).not.toMatch(/\bgh\s+pr\b/);
  });

  it("grants code changes only with Auto-fix and merging only with Auto-merge", () => {
    const prompt = (policy: BabysitPolicy) =>
      buildBabysitterPrompt({
        repo: "acme/widgets",
        number: 42,
        title: "Fix it",
        baseUrl: "https://gitea.example/",
        login: "work",
        policy,
      });
    const mergeCommand = "tea pulls merge";
    const pushGrant = "You can fix, commit, push";
    const fixOnly = prompt({ fix: true, merge: false });
    expect(fixOnly).toContain(pushGrant);
    expect(fixOnly).not.toContain(mergeCommand);
    expect(fixOnly).toContain(
      "Auto-merge is off. Never merge this pull request",
    );
    const mergeOnly = prompt({ fix: false, merge: true });
    expect(mergeOnly).not.toContain(pushGrant);
    expect(mergeOnly).toContain("Auto-fix is off. Do not change code");
    expect(mergeOnly).toContain(mergeCommand);
    const both = prompt({ fix: true, merge: true });
    expect(both).toContain(pushGrant);
    expect(both).toContain(mergeCommand);
    for (const text of [fixOnly, mergeOnly, both])
      expect(text).toContain("replace any earlier instructions in this thread");
  });
});

describe("Auto-fix and Auto-merge policy", () => {
  it("cannot represent an active session that may neither fix nor merge", () => {
    expect(activePolicy({ fix: false, merge: false })).toBeNull();
    expect(activePolicy({ fix: true, merge: false })).toEqual({
      fix: true,
      merge: false,
    });
    expect(activePolicy({ fix: false, merge: true })).toEqual({
      fix: false,
      merge: true,
    });
    expect(
      babysitPolicySchema.safeParse({ fix: false, merge: false }).success,
    ).toBe(false);
    expect(
      babysitSessionSchema.safeParse({
        ...watching,
        policy: { fix: false, merge: false },
      }).success,
    ).toBe(false);
  });

  it("reads legacy sessions with their original fix-and-merge authority", () => {
    const { policy: _policy, ...legacy } = watching;
    expect(parseStoredSession(legacy)).toEqual(watching);
    expect(
      parseStoredSession({ ...watching, policy: { fix: false, merge: true } }),
    ).toEqual({ ...watching, policy: { fix: false, merge: true } });
    expect(parseStoredSession({ status: "watching" })).toBeNull();
    const { cleanupPending: _pending, ...legacyStopped } = stopped(
      watching,
      now,
      false,
    );
    expect(parseStoredSession(legacyStopped)).toEqual(
      stopped(watching, now, false),
    );
  });

  it("maps legacy automatic babysitting to both automatic options without losing execution", () => {
    const execution = {
      providerId: "claude",
      model: "claude-sonnet-5",
      reasoningLevel: "high",
      serviceTier: "fast",
    } as const;
    expect(parseStoredPreferences({ autoBabysit: false, execution })).toEqual({
      autoFix: false,
      autoMerge: false,
      execution,
    });
    expect(parseStoredPreferences({ autoBabysit: true, execution })).toEqual({
      autoFix: true,
      autoMerge: true,
      execution,
    });
    expect(
      parseStoredPreferences({ autoFix: false, autoMerge: true, execution }),
    ).toEqual({ autoFix: false, autoMerge: true, execution });
    expect(parseStoredPreferences(undefined)).toMatchObject({
      autoFix: false,
      autoMerge: false,
    });
  });

  it("shows automation as on only while a session is live or waiting on you", () => {
    const fixOnly: BabysitSession = {
      ...watching,
      policy: { fix: true, merge: false },
    };
    expect(babysitView(null, null).automation).toEqual({
      fix: false,
      merge: false,
    });
    expect(babysitView(fixOnly, null).automation).toEqual({
      fix: true,
      merge: false,
    });
    expect(
      babysitView({ ...fixOnly, status: "needs_you", note: "" }, null)
        .automation,
    ).toEqual({ fix: true, merge: false });
    for (const retained of [
      { ...fixOnly, status: "stopped" as const, cleanupPending: false },
      { ...fixOnly, status: "merged" as const, mergedAt: now },
      { ...fixOnly, status: "closed" as const, closedAt: now },
    ])
      expect(babysitView(retained, null).automation).toEqual({
        fix: false,
        merge: false,
      });
  });

  it("decides every Auto-fix and Auto-merge combination", () => {
    const combinations = [
      [{ fix: false, merge: false }, null],
      [
        { fix: true, merge: false },
        { fix: true, merge: false },
      ],
      [
        { fix: false, merge: true },
        { fix: false, merge: true },
      ],
      [
        { fix: true, merge: true },
        { fix: true, merge: true },
      ],
    ] as const;
    for (const [patch, policy] of combinations) {
      expect(decideAutomation(null, patch)).toEqual(
        policy ? { kind: "start", policy } : { kind: "unchanged" },
      );
      expect(decideAutomation(watching, patch)).toEqual(
        policy === null
          ? { kind: "stop" }
          : policy.fix && policy.merge
            ? { kind: "unchanged" }
            : { kind: "update", session: watching, policy },
      );
      const halted = stopped(watching, now, false);
      expect(decideAutomation(halted, patch)).toEqual(
        policy
          ? { kind: "resume", session: halted, policy, cleanupFirst: false }
          : { kind: "unchanged" },
      );
    }
  });

  it("patches one option and keeps the other", () => {
    const mergeOnly: BabysitSession = {
      ...watching,
      policy: { fix: false, merge: true },
    };
    expect(decideAutomation(mergeOnly, { fix: true })).toEqual({
      kind: "update",
      session: mergeOnly,
      policy: { fix: true, merge: true },
    });
    expect(decideAutomation(mergeOnly, { merge: false })).toEqual({
      kind: "stop",
    });
    expect(decideAutomation(watching, { merge: false })).toEqual({
      kind: "update",
      session: watching,
      policy: { fix: true, merge: false },
    });
    expect(decideAutomation(null, { merge: true })).toEqual({
      kind: "start",
      policy: { fix: false, merge: true },
    });
    const failed: BabysitSession = {
      ...watching,
      status: "failed",
      error: "x",
      cleanupPending: true,
    };
    expect(decideAutomation(failed, { fix: true })).toEqual({
      kind: "unchanged",
    });
    expect(decideAutomation(failed, { merge: false })).toEqual({
      kind: "resume",
      session: failed,
      policy: { fix: true, merge: false },
      cleanupFirst: true,
    });
  });

  it("never re-enables a merged pull request and replaces a closed session", () => {
    const mergedSession: BabysitSession = {
      ...watching,
      status: "merged",
      mergedAt: now,
    };
    expect(decideAutomation(mergedSession, { fix: true })).toEqual({
      kind: "reject",
      reason: "merged",
    });
    expect(decideAutomation(mergedSession, { fix: false })).toEqual({
      kind: "unchanged",
    });
    expect(
      decideAutomation(
        { ...watching, status: "closed", closedAt: now },
        { merge: true },
      ),
    ).toEqual({ kind: "start", policy: { fix: false, merge: true } });
  });
});
