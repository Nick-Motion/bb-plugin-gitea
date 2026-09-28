import { describe, expect, it } from "vitest";
import {
  autoStartTargets,
  babysitSessionSchema,
  babysitView,
  buildBabysitterPrompt,
  decideRetry,
  decideStart,
  decideStop,
  onArchived,
  onCleanupFailed,
  onFailed,
  onIdle,
  parseLifecycle,
  parseMarker,
  type BabysitSession,
} from "./babysitter";

const now = "2026-09-28T00:00:00Z";
const watching: BabysitSession = {
  repo: "acme/widgets",
  number: 42,
  threadId: "thread-1",
  updatedAt: "2026-09-27T00:00:00Z",
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
      { ...watching, status: "stopped" as const },
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
    expect(decideRetry(closedSession)).toEqual({ kind: "start" });
    expect(
      decideRetry({ ...watching, status: "merged", mergedAt: now }),
    ).toEqual({ kind: "reject", reason: "merged" });
  });

  it("retries resumable sessions and cleans up first after a cleanup failure", () => {
    const failed = onCleanupFailed(watching, "stop: offline", now);
    expect(decideRetry(failed)).toEqual({
      kind: "resume",
      session: failed,
      cleanupFirst: true,
    });
    expect(decideRetry({ ...watching, status: "stopped" })).toMatchObject({
      kind: "resume",
      cleanupFirst: false,
    });
    expect(decideRetry(watching)).toEqual({
      kind: "existing",
      threadId: "thread-1",
    });
    expect(decideRetry(null)).toEqual({ kind: "start" });
  });

  it("stops only live or retained non-terminal workers", () => {
    expect(decideStop(watching)).toBe(watching);
    expect(decideStop({ ...watching, status: "stopped" })).toBeNull();
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
    const stopped: BabysitSession = { ...watching, status: "stopped" };
    expect(onIdle(stopped, "BB_GITEA_BABYSIT: MERGED", merged, now)).toBeNull();
    expect(onFailed(stopped, "boom", now)).toBeNull();
    expect(onArchived(stopped, now)).toBeNull();
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
    expect(babysitView(null, { ...openFacts, projectId: null }).actions).toEqual(
      [],
    );
    expect(babysitView(null, null).actions).toEqual([]);
    expect(babysitView(watching, openFacts).actions).toEqual(["stop"]);
    expect(
      babysitView({ ...watching, status: "stopped" }, openFacts).actions,
    ).toEqual(["retry"]);
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
          ["acme/widgets#7", { ...watching, number: 7, status: "stopped" }],
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

  it("instructs tea with explicit flags and forbids auto-merge", () => {
    const prompt = buildBabysitterPrompt({
      repo: "acme/widgets",
      number: 42,
      title: "Fix it",
      baseUrl: "https://gitea.example/prefix/",
      login: "work",
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
    expect(prompt).not.toContain("mark the PR ready");
    expect(prompt).not.toMatch(/\bgh\s+pr\b/);
  });
});
