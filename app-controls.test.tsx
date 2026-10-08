// @vitest-environment jsdom

import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";

afterEach(() => cleanup());

const app = await loadPluginApp(() => import("./app"));
const account = '["https://gitea.example/","work","dev"]';
const freshness = { state: "fresh" as const, fetchedAt: "2026-09-29T12:00:00Z" };
const item = {
  repo: "acme/widgets",
  number: 42,
  kind: "pr" as const,
  title: "All PR controls",
  state: "open",
  author: "someone",
  labels: [],
  assignees: [],
  url: "https://gitea.example/acme/widgets/pulls/42",
  body: "",
  updatedAt: "2026-09-29T12:00:00Z",
  autoFixer: {
    status: "idle" as const,
    actions: ["start" as const],
    automation: { fix: false, merge: false },
  },
};
const list = {
  items: [item],
  truncated: false,
  errors: [],
  account,
  freshness,
};

it("opens My PRs without changing automation and offers only bulk auto-fix", async () => {
  const preferences = {
    autoFix: false,
    execution: {
      providerId: "codex", model: "gpt-5.6-luna",
      reasoningLevel: "medium", serviceTier: "default",
    },
  };
  const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, {
    rpc: {
      status: () => ({ state: "connected", login: "dev", account, repos: [] }),
      getAutoFixerPreferences: () => preferences,
      listMyPullRequests: () => ({ ...list, login: "dev", preferences }),
      listMyIssues: () => ({ ...list, items: [], login: "dev" }),
      setAutoAutomation: ({ fix }: { fix: boolean }) => ({ ...preferences, autoFix: fix }),
    },
  });
  const autoFix = await screen.findByRole("checkbox", { name: "Auto-fix all" });
  expect((autoFix as HTMLInputElement).checked).toBe(false);
  expect(screen.queryByRole("checkbox", { name: "Auto-merge all" })).toBeNull();
  expect(slot.rpcCalls.filter(call => ["setAutoAutomation", "setAutomation", "setAutoMerge"].includes(call.method))).toEqual([]);
  await act(async () => fireEvent.click(autoFix));
  expect(slot.rpcCalls.filter(call => call.method === "setAutoAutomation"))
    .toMatchObject([{ input: { fix: true } }]);
});

it.each([false, true])("shows the My Issues badge and opens assigned issues (truncated: %s)", async (truncated) => {
  renderSlot(app.navPanels[0]!, { subPath: "" }, {
    rpc: {
      status: () => ({ state: "connected", login: "dev", account, repos: [] }),
      getAutoFixerPreferences: () => ({
        autoFix: false,
        execution: {
          providerId: "codex",
          model: "gpt-5.6-luna",
          reasoningLevel: "medium",
          serviceTier: "default",
        },
      }),
      listMyPullRequests: () => ({ ...list, items: [], login: "dev" }),
      listMyIssues: () => ({
        ...list,
        truncated,
        items: [{ ...item, number: 7, kind: "issue", title: "Assigned issue", assignees: ["dev"] }],
        login: "dev",
      }),
    },
  });
  expect(screen.getByRole("tab", { name: /My PRs/ }).getAttribute("aria-selected"))
    .toBe("true");
  const issuesTab = await screen.findByRole("tab", { name: `My Issues 1${truncated ? "+" : ""}` });
  fireEvent.mouseDown(issuesTab, { button: 0 });
  expect(await screen.findByText("Assigned issue")).toBeTruthy();
  fireEvent.mouseDown(screen.getByRole("tab", { name: /My PRs/ }), { button: 0 });
});

it("shows Auto-fix and Auto-merge controls for a Pull requests row", async () => {
  renderSlot(app.navPanels[0]!, { subPath: "" }, {
    rpc: {
      status: () => ({ state: "connected", login: "dev", account, repos: [] }),
      getAutoFixerPreferences: () => ({
        autoFix: false,
        execution: {
          providerId: "codex",
          model: "gpt-5.6-luna",
          reasoningLevel: "medium",
          serviceTier: "default",
        },
      }),
      listMyPullRequests: () => ({ ...list, items: [], login: "dev" }),
      listItems: () => list,
    },
  });
  fireEvent.mouseDown(screen.getByRole("tab", { name: "Pull requests" }), {
    button: 0,
  });
  expect(await screen.findByText(item.title)).toBeTruthy();
  const controls = screen.getByTestId("auto-fixer-controls");
  expect(controls.querySelectorAll("button")).toHaveLength(2);
  expect(controls.textContent).toContain("Auto-fix");
  expect(controls.textContent).toContain("Auto-merge");
});

it("schedules and cancels a PR merge without calling agent automation", async () => {
  let merge = false;
  const rows = () => ({ ...list, items: [{ ...item, autoFixer: { ...item.autoFixer, automation: { fix: false, merge } } }], login: "dev" });
  const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, {
    rpc: {
      status: () => ({ state: "connected", login: "dev", account, repos: [] }),
      getAutoFixerPreferences: () => ({ autoFix: false, execution: {
        providerId: "codex", model: "gpt-5.6-luna", reasoningLevel: "medium", serviceTier: "default",
      } }),
      listMyPullRequests: rows,
      listMyIssues: () => ({ ...list, items: [], login: "dev" }),
      listItems: rows,
      setAutoMerge: ({ enabled }: { enabled: boolean }) => { merge = enabled; return { ok: true }; },
    },
  });
  const toggle = await screen.findByRole("button", { name: "Auto-merge", pressed: false });
  expect(screen.queryByRole("button", { name: "Cancel auto-merge" })).toBeNull();
  await act(async () => fireEvent.click(toggle));
  await screen.findByRole("button", { name: "Auto-merge", pressed: true });
  await act(async () => fireEvent.click(toggle));
  await screen.findByRole("button", { name: "Auto-merge", pressed: false });
  expect(slot.rpcCalls.filter(call => call.method === "setAutoMerge")).toMatchObject([
    { input: { repo: "acme/widgets", number: 42, enabled: true } },
    { input: { repo: "acme/widgets", number: 42, enabled: false } },
  ]);
  expect(slot.rpcCalls.filter(call => call.method === "setAutomation")).toEqual([]);
});

it("disables metadata suggestions while the save is pending", async () => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  const slot = renderSlot(app.navPanels[0]!, { subPath: "pulls/acme/widgets/42" }, {
    rpc: {
      status: () => ({ state: "connected", login: "dev", account, repos: [] }),
      getAutoFixerPreferences: () => ({ autoFix: false, execution: { providerId: "codex", model: "gpt-5.6-luna", reasoningLevel: "medium", serviceTier: "default" } }),
      listMyPullRequests: () => ({ ...list, items: [] }),
      listMyIssues: () => ({ ...list, items: [] }),
      conversation: () => ({
        freshness, threadId: null,
        conversation: {
          ...item, comments: [], commentsTruncated: false, headRefName: "feature",
          baseRefName: "main", revision: { head: "a".repeat(40), base: "b".repeat(40) },
          changedFiles: 1, draft: true, checks: { state: "unavailable" }, reviews: [], reviewsTruncated: false,
          reviewComments: [],
        },
      }),
      repoOptions: () => ({ labels: [{ name: "bug", color: "" }, { name: "help wanted", color: "" }], assignees: [] }),
      updateMetadata: async () => { await held; return { ok: true }; },
    },
  });
  expect(await screen.findByRole("button", { name: "Mark ready" })).toBeTruthy();
  expect(await screen.findByText("Checks unavailable.")).toBeTruthy();
  const input = await screen.findByLabelText("Add labels");
  fireEvent.change(input, { target: { value: "bug" } });
  fireEvent.mouseDown(await screen.findByRole("option", { name: "bug" }));
  expect(screen.queryByRole("listbox", { name: "Labels" })).toBeNull();
  expect(slot.rpcCalls.filter(call => call.method === "updateMetadata")).toHaveLength(1);
  await act(async () => release());
});

it("hides archived auto-fixers until history is requested", async () => {
  renderSlot(app.navPanels[0]!, { subPath: "" }, {
    rpc: {
      status: () => ({ state: "connected", login: "dev", account, repos: [] }),
      getAutoFixerPreferences: () => ({ autoFix: false, execution: { providerId: "codex", model: "gpt-5.6-luna", reasoningLevel: "medium", serviceTier: "default" } }),
      listMyPullRequests: () => ({ ...list, items: [], login: "dev" }),
      listAutoFixerSessions: () => ({ sessions: [{ ...item.autoFixer, ...item, status: "archived", outcome: "merged", threadId: "archived-thread", archivedAt: item.updatedAt, policy: { fix: true, merge: false }, actions: [], automation: { fix: false, merge: false } }] }),
    },
  });
  fireEvent.mouseDown(screen.getByRole("tab", { name: "Auto-fixers" }), { button: 0 });
  const toggle = await screen.findByRole("checkbox", { name: "Show archived" });
  expect(screen.queryByTestId("auto-fixer-session")).toBeNull();
  fireEvent.click(toggle);
  expect(screen.getByTestId("auto-fixer-session").textContent).toContain("archived");
  expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
});
