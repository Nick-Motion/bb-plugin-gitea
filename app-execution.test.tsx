// @vitest-environment jsdom

import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";

afterEach(() => cleanup());
const app = await loadPluginApp(() => import("./app"));
const account = '["https://gitea.example/","work","dev"]';
const execution = {
  providerId: "pi",
  model: "example-model",
  reasoningLevel: "xhigh",
  serviceTier: "default",
} as const;
const freshness = { state: "fresh", fetchedAt: "2026-09-30T12:00:00Z" };
const emptyList = { items: [], truncated: false, errors: [], account, freshness, login: "dev" };

it("ignores repeated normalized model selections on an issue but saves real changes", async () => {
  const slot = renderSlot(app.navPanels[0]!, { subPath: "issues/acme/widgets/10" }, {
    rpc: {
      status: () => ({ ready: true, error: null, login: "dev", account, repos: [] }),
      getAutoFixerPreferences: () => ({ autoFix: false, autoMerge: false, execution }),
      getAgentExecution: () => ({ execution }),
      setAgentExecution: () => ({ ok: true }),
      listMyPullRequests: () => emptyList,
      listMyIssues: () => emptyList,
      listItems: () => emptyList,
      repoOptions: () => ({ labels: [], assignees: [] }),
      conversation: () => ({
        freshness,
        threadId: null,
        conversation: {
          repo: "acme/widgets", number: 10, kind: "issue", title: "Issue detail",
          state: "open", author: "dev", labels: [], assignees: [], body: "",
          url: "https://gitea.example/acme/widgets/issues/10",
          updatedAt: freshness.fetchedAt, comments: [], commentsTruncated: false,
        },
      }),
    },
  });
  expect(await screen.findByText("Issue detail")).toBeTruthy();
  await screen.findByRole("button", { name: "Apply execution selection" });
  // The live host picker emits normalized selections on render; unsupported
  // service tiers arrive as undefined, equivalent to our persisted default.
  fireEvent.change(screen.getByLabelText("Service tier"), { target: { value: "" } });
  for (let i = 0; i < 3; i++) {
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Apply execution selection" }));
    });
  }
  const writes = () => slot.rpcCalls.filter(call => call.method === "setAgentExecution");
  expect(writes()).toHaveLength(0);
  fireEvent.change(screen.getByLabelText("Model"), { target: { value: "another-model" } });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Apply execution selection" }));
  });
  expect(writes()).toHaveLength(1);
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Apply execution selection" }));
  });
  expect(writes()).toHaveLength(1);
});
