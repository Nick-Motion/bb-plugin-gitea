// @vitest-environment jsdom

import { cleanup, fireEvent, screen } from "@testing-library/react";
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

it("shows Auto-fix and Auto-merge controls for a Pull requests row", async () => {
  renderSlot(app.navPanels[0]!, { subPath: "" }, {
    rpc: {
      status: () => ({ ready: true, error: null, login: "dev", account, repos: [] }),
      getAutoFixerPreferences: () => ({
        autoFix: false,
        autoMerge: false,
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
