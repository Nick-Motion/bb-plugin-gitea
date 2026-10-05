// @vitest-environment jsdom

import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";

afterEach(() => cleanup());

const app = await loadPluginApp(() => import("./app"));
const registration = app.environmentProviderInputs.find(
  (entry) => entry.environmentProviderId === "gitea-branch",
)!;

const rpc = {
  remoteBranches: () => ({
    repo: "acme/widgets",
    truncated: false,
    error: null,
    branches: [
      {
        name: "review",
        group: "pull",
        pull: { number: 7, title: "Fix 7", url: "https://gitea.example/acme/widgets/pulls/7", status: "failing" },
        updatedAt: "2026-09-02T00:00:00Z",
      },
      { name: "mine", group: "mine", pull: null, updatedAt: "2026-09-05T00:00:00Z" },
      {
        name: "checked",
        group: "other",
        pull: { number: 5, title: "Fix 5", url: "https://gitea.example/acme/widgets/pulls/5", status: "checking" },
        updatedAt: "2026-09-01T00:00:00Z",
      },
      {
        name: "shipped",
        group: "other",
        pull: { number: 3, title: "Fix 3", url: "https://gitea.example/acme/widgets/pulls/3", status: "merged" },
        updatedAt: "2026-09-01T00:00:00Z",
      },
    ],
  }),
  remotePullStatuses: ({ others }: { others: boolean }) => ({
    statuses: others ? [{ number: 5, status: "passing" }] : [{ number: 7, status: "failing" }],
  }),
  branchDefaultBase: () => ({ branch: "main" }),
  branchWorktrees: () => ({
    worktrees: [{ path: "/src/widgets-wt", branch: "old", locked: false, prunable: false }],
  }),
};

function render(value: unknown) {
  const onChange = vi.fn();
  renderSlot(
    registration,
    {
      projectId: "project-1",
      target: { kind: "existing-host", hostId: "host-1" },
      value: value as never,
      onChange,
    },
    { rpc, branchesState: { branches: ["develop"], remoteBranches: [], isLoading: false } },
  );
  return onChange;
}

async function open(label: string) {
  await act(async () => {
    fireEvent.click(await screen.findByRole("combobox", { name: "Gitea branch" }));
  });
  await screen.findByText(label);
}

it("lists your branches first and shows other branches only when asked", async () => {
  const onChange = render({ kind: "new", from: { kind: "default" } });
  expect(await screen.findByText("main")).toBeTruthy();
  await open("review");
  const menu = within(screen.getByRole("dialog"));
  const rowText = () => menu.getAllByRole("button").map((row) => row.textContent);
  expect(menu.queryByText("Local branch:")).toBeNull();
  expect(menu.queryByText("develop")).toBeNull();
  expect(menu.queryByText("Other branches:")).toBeNull();
  expect(rowText()).toEqual([
    "New worktree",
    "Existing worktree",
    "Fix 7review#7",
    "mine",
    "Show other branches (2)",
  ]);
  expect(menu.getByText("Fix 7").className).toContain("font-medium");
  await waitFor(() => expect(menu.getByText("#7").getAttribute("data-status")).toBe("failing"));
  expect(menu.getByText("#7").className).toContain("text-red-600");

  await act(async () => fireEvent.click(menu.getByText("Show other branches (2)")));
  const headers = ["Work in:", "Your branches:", "Other branches:"].map((label) =>
    menu.getByText(label),
  );
  for (let index = 1; index < headers.length; index += 1)
    expect(
      headers[index - 1]!.compareDocumentPosition(headers[index]!) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  expect(rowText().slice(4)).toEqual(["Fix 5checked#5", "Fix 3shipped#3"]);
  await waitFor(() => expect(menu.getByText("#5").getAttribute("data-status")).toBe("passing"));
  expect(menu.getByText("#3").getAttribute("title")).toBe("Pull request #3: Merged");

  await act(async () => fireEvent.click(menu.getByText("review")));
  expect(onChange).toHaveBeenLastCalledWith({
    status: "ready",
    value: { kind: "remote", name: "review" },
  });
});

it("shows matching other branches while searching", async () => {
  render({ kind: "new", from: { kind: "default" } });
  await open("review");
  const menu = within(screen.getByRole("dialog"));
  await act(async () =>
    fireEvent.change(menu.getByRole("textbox"), { target: { value: "ship" } }),
  );
  await waitFor(() => expect(menu.getByText("Other branches:")).toBeTruthy());
  expect(menu.getAllByRole("button").map((row) => row.textContent)).toEqual([
    "New worktree",
    "Existing worktree",
    "Fix 3shipped#3",
  ]);
});

it("goes back to a new branch from the default branch when New worktree is picked", async () => {
  const onChange = render({ kind: "existing", path: "/src/widgets-wt" });
  await open("Keep current branch");
  await act(async () => fireEvent.click(screen.getByText("New worktree")));
  expect(onChange).toHaveBeenLastCalledWith({
    status: "ready",
    value: { kind: "new", from: { kind: "default" } },
  });
});

it("switches a picked existing worktree to a remote branch", async () => {
  const onChange = render({ kind: "existing", path: "/src/widgets-wt" });
  await open("Keep current branch");
  await screen.findByText("review");
  await act(async () => fireEvent.click(screen.getByText("review")));
  expect(onChange).toHaveBeenLastCalledWith({
    status: "ready",
    value: { kind: "existing", path: "/src/widgets-wt", remoteBranch: "review" },
  });
});

it("fills in the default inputs when there is no value", () => {
  const onChange = render(null);
  expect(onChange).toHaveBeenCalledWith({
    status: "ready",
    value: { kind: "new", from: { kind: "default" } },
  });
});

it("shows only the branch name on the trigger after a remote branch is picked", async () => {
  render({ kind: "remote", name: "review" });
  const trigger = await screen.findByRole("combobox", { name: "Gitea branch" });
  expect(trigger.textContent).toBe("review");
});
