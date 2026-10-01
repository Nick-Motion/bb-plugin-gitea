// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  screen,
} from "@testing-library/react";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";

beforeAll(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      disconnect(): void {}
      observe(): void {}
      unobserve(): void {}
    },
  );
});

afterAll(() => vi.unstubAllGlobals());

afterEach(() => cleanup());

const app = await loadPluginApp(() => import("./app"));
const panel = app.navPanels[0]!;
const overlay = app.appOverlays[0]!;

const preferences = {
  autoFix: false,
  autoMerge: false,
  execution: {
    providerId: "codex",
    model: "gpt-5.6-luna",
    reasoningLevel: "xhigh",
    serviceTier: "default",
  },
} as const;
const work = '["https://gitea.example/","work","dev"]';
const fetchedAt = "2026-09-28T12:00:00.000Z";

type Freshness =
  | { state: "fresh" | "refreshing"; fetchedAt: string }
  | { state: "stale-error"; fetchedAt: string; error: string };

function pull(number: number, title: string) {
  return {
    repo: "acme/widgets",
    number,
    kind: "pr" as const,
    title,
    state: "open",
    author: "dev",
    labels: [],
    assignees: [],
    url: `https://gitea.example/acme/widgets/pulls/${number}`,
    body: "",
    updatedAt: "2026-09-28T12:00:00Z",
    autoFixer: {
      status: "idle" as const,
      actions: ["start" as const],
      automation: { fix: false, merge: false },
    },
  };
}

function mine(
  titles: string[],
  account = work,
  freshness: Freshness = { state: "fresh", fetchedAt },
) {
  return {
    items: titles.map((title, index) => pull(index + 1, title)),
    truncated: false,
    errors: [],
    account,
    freshness,
    login: "dev",
    preferences,
  };
}

function status(account = work) {
  return { ready: true, error: null, login: "dev", account, repos: [] };
}

const settings = {
  baseUrl: "https://gitea.example/",
  teaProfile: "work",
  extraRepos: "",
};

async function watchScope() {
  const scope = renderSlot(overlay, {}, { settings });
  await scope.emitRealtime("display-changed", { item: null });
  return scope;
}

async function showQuery(query: string, rows: string[]) {
  fireEvent.change(screen.getByPlaceholderText("Search title, body, repository"), { target: { value: query } });
  for (const row of rows) expect(await screen.findByText(row)).toBeTruthy();
}

function conversation(title: string) {
  return {
    freshness: { state: "fresh", fetchedAt },
    threadId: null,
    conversation: {
      ...pull(10, title),
      comments: [],
      commentsTruncated: false,
      headRefName: "feature",
      baseRefName: "main",
      revision: { head: "a".repeat(40), base: "b".repeat(40) },
      changedFiles: 1,
      checks: [],
      checksTruncated: false,
      reviewComments: [],
      reviewCommentsTruncated: false,
      reviews: [],
      reviewsTruncated: false,
    },
  };
}

const Panel = panel.component;

it.each(["", "my-prs"])("returns to My PRs after opening a PR from %s, including after a remount", async (listPath) => {
  await watchScope();
  const options = {
    settings,
    rpc: {
      status: () => status(),
      getAutoFixerPreferences: () => preferences,
      listMyPullRequests: () => mine(["History PR"]),
      conversation: () => conversation("History PR detail"),
    },
  };
  const slot = renderSlot(panel, { subPath: listPath }, options);
  await showQuery("", ["History PR"]);
  fireEvent.click(screen.getByText("History PR"));
  expect(slot.navigateCalls.at(-1)).toEqual({
    method: "toPluginPanel", path: "gitea",
    options: { subPath: "pulls/acme/widgets/1" },
  });
  slot.lifecycle.rerender(<Panel subPath="pulls/acme/widgets/1" />);
  expect(await screen.findByText("History PR detail")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "← My PRs" }));
  expect(slot.navigateCalls.at(-1)).toEqual({
    method: "toPluginPanel", path: "gitea", options: { subPath: "my-prs" },
  });
  // The host supplies the historical route for Back and Forward.
  slot.lifecycle.rerender(<Panel subPath={listPath} />);
  expect(await screen.findByText("History PR")).toBeTruthy();
  expect(screen.getByRole("tab", { name: /My PRs/ }).getAttribute("aria-selected")).toBe("true");
  slot.lifecycle.rerender(<Panel subPath="pulls/acme/widgets/1" />);
  expect(await screen.findByText("History PR detail")).toBeTruthy();
  slot.lifecycle.unmount();
  renderSlot(panel, { subPath: listPath }, options);
  expect(await screen.findByText("History PR")).toBeTruthy();
  expect(screen.getByRole("tab", { name: /My PRs/ }).getAttribute("aria-selected")).toBe("true");
});

it("records distinct list routes and restores tabs when those routes are replayed", async () => {
  await watchScope();
  const slot = renderSlot(panel, { subPath: "my-prs" }, {
    settings,
    rpc: {
      status: () => status(),
      getAutoFixerPreferences: () => preferences,
      listMyPullRequests: () => mine([]),
      listMyIssues: () => mine([]),
      listItems: () => mine([]),
      listAutoFixerSessions: () => ({ sessions: [] }),
    },
  });
  for (const [path, label] of [
    ["my-issues", "My Issues"], ["issues", "Issues"],
    ["pulls", "Pull requests"], ["auto-fixers", "Auto-fixers"],
  ]) {
    fireEvent.mouseDown(screen.getByRole("tab", { name: new RegExp(`^${label}`) }), { button: 0 });
    expect(slot.navigateCalls.at(-1)).toEqual({
      method: "toPluginPanel", path: "gitea", options: { subPath: path },
    });
    slot.lifecycle.rerender(<Panel subPath={path!} />);
  }
  for (const [path, label] of [["pulls", "Pull requests"], ["my-issues", "My Issues"], ["auto-fixers", "Auto-fixers"]]) {
    slot.lifecycle.rerender(<Panel subPath={path!} />);
    expect(screen.getByRole("tab", { name: new RegExp(`^${label}`) }).getAttribute("aria-selected")).toBe("true");
  }
});
