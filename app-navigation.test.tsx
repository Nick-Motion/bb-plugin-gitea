// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
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
const Panel = panel.component;
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
const ops = '["https://gitea.example/","ops","ops"]';
const fetchedAt = "2026-09-28T12:00:00.000Z";

type Freshness =
  | { state: "fresh" | "refreshing"; fetchedAt: string }
  | { state: "stale-error"; fetchedAt: string; error: string };
type ListInput = { state: string; query: string; refresh: boolean };

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
  return { state: "connected", login: "dev", account, repos: [] };
}

const settings = {
  baseUrl: "https://gitea.example/",
  teaProfile: "work",
  extraRepos: "",
};
const extraSettings = { ...settings, extraRepos: "acme/extra" };

async function watchScope() {
  const scope = renderSlot(overlay, {}, { settings });
  await scope.emitRealtime("display-changed", { item: null });
  return scope;
}

async function visit(
  rows: string[],
  readiness: () =>
    Promise<ReturnType<typeof status>> | ReturnType<typeof status> = () =>
    status(),
) {
  const slot = renderSlot(
    panel,
    { subPath: "" },
    {
      settings,
      rpc: {
        status: readiness,
        getAutoFixerPreferences: () => preferences,
        listMyPullRequests: () => mine(rows),
      },
    },
  );
  await showQuery("", rows);
  await waitFor(() => expect(freshness()).toBe("fresh"));
  slot.lifecycle.unmount();
}

function recordShown(text: string) {
  let shown = document.body.textContent?.includes(text) ?? false;
  const note = (value: unknown) => {
    if (String(value).includes(text)) shown = true;
  };
  for (const name of ["textContent", "nodeValue"]) {
    const property = Object.getOwnPropertyDescriptor(Node.prototype, name)!;
    Object.defineProperty(Node.prototype, name, {
      ...property,
      set(value: string | null) {
        note(value);
        property.set!.call(this, value);
      },
    });
    restoreRecorders.push(() =>
      Object.defineProperty(Node.prototype, name, property),
    );
  }
  const createTextNode = vi
    .spyOn(document, "createTextNode")
    .mockImplementation((data) => {
      note(data);
      return Document.prototype.createTextNode.call(document, data);
    });
  restoreRecorders.push(() => createTextNode.mockRestore());
  return () => shown || (document.body.textContent?.includes(text) ?? false);
}

const restoreRecorders: Array<() => void> = [];
afterEach(() => {
  for (const restore of restoreRecorders.splice(0)) restore();
});

function held() {
  let release!: () => void;
  const opened = new Promise<void>((resolve) => (release = resolve));
  return { opened, release: () => act(async () => release()) };
}

const search = () =>
  screen.getByPlaceholderText(
    "Search title, body, repository",
  ) as HTMLInputElement;
const skeleton = () => screen.queryByTestId("bb-list-loading");
const freshness = () =>
  screen.getByTestId("bb-freshness").getAttribute("data-state");

function listCalls(slot: ReturnType<typeof renderSlot>) {
  return slot.rpcCalls
    .filter((call) => call.method === "listMyPullRequests")
    .map((call) => call.input as ListInput);
}

async function showQuery(query: string, rows: string[]) {
  fireEvent.change(search(), { target: { value: query } });
  for (const row of rows) expect(await screen.findByText(row)).toBeTruthy();
}

it("repaints remembered My PRs rows at once after visiting a thread, then applies one refresh", async () => {
  await watchScope();
  const firstVisit = renderSlot(
    panel,
    { subPath: "" },
    {
      settings,
      rpc: {
        status: () => status(),
        getAutoFixerPreferences: () => preferences,
        listMyPullRequests: (input: unknown) =>
          mine(
            ["Faster pages", "Tidy docs"].filter((title) =>
              title.toLowerCase().includes((input as ListInput).query),
            ),
          ),
      },
    },
  );
  expect(await screen.findByText("Tidy docs")).toBeTruthy();
  await showQuery("faster", ["Faster pages"]);
  await waitFor(() => expect(screen.queryByText("Tidy docs")).toBeNull());
  await waitFor(() => expect(freshness()).toBe("fresh"));
  firstVisit.lifecycle.unmount();
  expect(screen.queryByText("Faster pages")).toBeNull();

  const readiness = held();
  const list = held();
  const returned = renderSlot(
    panel,
    { subPath: "" },
    {
      settings,
      rpc: {
        status: async () => {
          await readiness.opened;
          return status();
        },
        getAutoFixerPreferences: () => preferences,
        listMyPullRequests: async () => {
          await list.opened;
          return mine(["Faster pages, rebased"]);
        },
      },
    },
  );
  expect(screen.getByText("Faster pages")).toBeTruthy();
  expect(skeleton()).toBeNull();
  expect(screen.queryByText("Checking Gitea configuration…")).toBeNull();
  expect(screen.getByLabelText("Turn on Auto-fix")).toBeTruthy();
  expect(search().value).toBe("faster");
  expect(
    screen.getByRole("tab", { name: /My PRs/ }).getAttribute("aria-selected"),
  ).toBe("true");
  expect(freshness()).toBe("refreshing");
  await waitFor(() =>
    expect(listCalls(returned)).toEqual([
      { state: "open", query: "faster", refresh: false },
    ]),
  );

  await list.release();
  expect(await screen.findByText("Faster pages, rebased")).toBeTruthy();
  expect(screen.queryByText("Faster pages")).toBeNull();
  expect(freshness()).toBe("fresh");
  await readiness.release();
  expect(screen.getByText("Faster pages, rebased")).toBeTruthy();
  expect(listCalls(returned)).toHaveLength(1);
});

it("never shows another filter's rows and ignores a slower earlier filter reply", async () => {
  const slow = held();
  renderSlot(
    panel,
    { subPath: "" },
    {
      rpc: {
        status: () => status(),
        getAutoFixerPreferences: () => preferences,
        listMyPullRequests: async (input: unknown) => {
          const { query } = input as ListInput;
          if (query === "a") {
            await slow.opened;
            return mine(["Slow a result"]);
          }
          return mine([`Rows for "${query}"`]);
        },
      },
    },
  );
  await showQuery("", ['Rows for ""']);
  fireEvent.change(search(), { target: { value: "a" } });
  expect(skeleton()).toBeTruthy();
  expect(screen.queryByText('Rows for ""')).toBeNull();
  await showQuery("ab", ['Rows for "ab"']);
  await slow.release();
  expect(screen.queryByText("Slow a result")).toBeNull();
  expect(screen.getByText('Rows for "ab"')).toBeTruthy();
});

it("keeps rows through a failed background refresh and rereads only on a list change", async () => {
  let reply = mine(["Kept row"], work, {
    state: "stale-error",
    fetchedAt,
    error: "Gitea API returned HTTP 502.",
  });
  const slot = renderSlot(
    panel,
    { subPath: "" },
    {
      rpc: {
        status: () => status(),
        getAutoFixerPreferences: () => preferences,
        listMyPullRequests: () => reply,
      },
    },
  );
  await showQuery("kept", ["Kept row"]);
  await waitFor(() => expect(freshness()).toBe("stale-error"));
  expect(screen.getByText(/Refresh failed/)).toBeTruthy();
  expect(screen.getByTestId("bb-freshness").getAttribute("title")).toContain(
    "HTTP 502",
  );

  const before = listCalls(slot).length;
  await slot.emitRealtime("display-changed", { item: "acme/widgets#1" });
  expect(listCalls(slot)).toHaveLength(before);

  reply = mine(["Refreshed row"]);
  await slot.emitRealtime("display-changed", { item: "lists" });
  expect(await screen.findByText("Refreshed row")).toBeTruthy();
  expect(skeleton()).toBeNull();
  expect(listCalls(slot)).toHaveLength(before + 1);
});

it("drops remembered rows for another account, forgotten display data, and a lost login", async () => {
  const first = renderSlot(
    panel,
    { subPath: "" },
    {
      rpc: {
        status: () => status(),
        getAutoFixerPreferences: () => preferences,
        listMyPullRequests: () => mine(["Work account row"]),
      },
    },
  );
  await showQuery("", ["Work account row"]);
  first.lifecycle.unmount();

  let list = held();
  let rejected = false;
  const slot = renderSlot(
    panel,
    { subPath: "" },
    {
      rpc: {
        status: () => status(ops),
        getAutoFixerPreferences: () => preferences,
        listMyPullRequests: async () => {
          await list.opened;
          if (rejected)
            throw new Error('Gitea rejected tea login profile "ops".');
          return mine(["Ops account row"], ops);
        },
      },
    },
  );
  await waitFor(() => expect(skeleton()).toBeTruthy());
  expect(screen.queryByText("Work account row")).toBeNull();
  await list.release();
  expect(await screen.findByText("Ops account row")).toBeTruthy();

  list = held();
  await slot.emitRealtime("display-changed", { item: null });
  expect(skeleton()).toBeTruthy();
  expect(screen.queryByText("Ops account row")).toBeNull();
  await list.release();
  expect(await screen.findByText("Ops account row")).toBeTruthy();

  rejected = true;
  list = held();
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  expect(listCalls(slot).at(-1)).toEqual({
    state: "open",
    query: "",
    refresh: true,
  });
  expect(screen.getByText("Ops account row")).toBeTruthy();
  expect(freshness()).toBe("refreshing");
  await list.release();
  expect((await screen.findByRole("alert")).textContent).toContain(
    "Gitea rejected tea login",
  );
  expect(screen.queryByText("Ops account row")).toBeNull();
  slot.lifecycle.unmount();

  renderSlot(
    panel,
    { subPath: "" },
    {
      rpc: {
        status: () => status(ops),
        getAutoFixerPreferences: () => preferences,
        listMyPullRequests: () => new Promise<never>(() => {}),
      },
    },
  );
  expect(skeleton()).toBeTruthy();
  expect(screen.queryByText("Ops account row")).toBeNull();
});

it("never shows the previous account's rows when the server clears display data while the panel is away", async () => {
  const scope = await watchScope();
  const before = held();
  await visit(["Work account row"], async () => {
    await before.opened;
    return status();
  });
  await scope.emitRealtime("display-changed", { item: null });
  await before.release();

  const shown = recordShown("Work account row");
  const readiness = held();
  const list = held();
  renderSlot(
    panel,
    { subPath: "" },
    {
      settings,
      rpc: {
        status: async () => {
          await readiness.opened;
          return status(ops);
        },
        getAutoFixerPreferences: () => preferences,
        listMyPullRequests: async () => {
          await list.opened;
          return mine(["Ops account row"], ops);
        },
      },
    },
  );
  expect(skeleton()).toBeTruthy();
  expect(screen.getByText("Checking Gitea configuration…")).toBeTruthy();
  await readiness.release();
  expect(skeleton()).toBeTruthy();
  await list.release();
  expect(await screen.findByText("Ops account row")).toBeTruthy();
  expect(shown()).toBe(false);
});

it("never shows remembered rows after the plugin settings change while the panel is away", async () => {
  await watchScope();
  await visit(["Row before extra repos"]);

  const shown = recordShown("Row before extra repos");
  const readiness = held();
  const list = held();
  renderSlot(
    panel,
    { subPath: "" },
    {
      settings: extraSettings,
      rpc: {
        status: async () => {
          await readiness.opened;
          return status();
        },
        getAutoFixerPreferences: () => preferences,
        listMyPullRequests: async () => {
          await list.opened;
          return mine(["Row with extra repos"]);
        },
      },
    },
  );
  expect(skeleton()).toBeTruthy();
  await readiness.release();
  expect(skeleton()).toBeTruthy();
  await list.release();
  expect(await screen.findByText("Row with extra repos")).toBeTruthy();
  expect(shown()).toBe(false);
});

it.each(["server display invalidation", "settings change"])(
  "rejects first-load replies started before a %s",
  async (reason) => {
    const scope = await watchScope();
    const oldStatus = held();
    const oldList = held();
    const accountLabelShown = recordShown("Old account label");
    const rowShown = recordShown("Old account row");
    let statusCalls = 0;
    let listCallsCount = 0;
    const slot = renderSlot(
      panel,
      { subPath: "" },
      {
        settings,
        rpc: {
          status: async () => {
            statusCalls += 1;
            if (statusCalls === 1) {
              await oldStatus.opened;
              return { ...status(ops), login: "Old account label" };
            }
            return status();
          },
          getAutoFixerPreferences: () => preferences,
          listMyPullRequests: async () => {
            listCallsCount += 1;
            if (listCallsCount === 1) {
              await oldList.opened;
              return mine(["Old account row"], ops);
            }
            return mine(["Current account row"]);
          },
        },
      },
    );
    expect(skeleton()).toBeTruthy();

    if (reason === "server display invalidation") {
      await scope.emitRealtime("display-changed", { item: null });
    } else {
      await slot.behavior.setSettings(extraSettings);
      await scope.behavior.setSettings(extraSettings);
    }

    await oldStatus.release();
    await oldList.release();
    expect(await screen.findByText("Current account row")).toBeTruthy();
    expect(
      screen.queryByText(
        "Install tea and sign in with a matching Gitea login profile to see your pull requests.",
      ),
    ).toBeNull();
    expect(statusCalls).toBeGreaterThanOrEqual(2);
    expect(listCallsCount).toBeGreaterThanOrEqual(2);
    expect(accountLabelShown()).toBe(false);
    expect(rowShown()).toBe(false);
    slot.lifecycle.unmount();
  },
);

it("forgets every remembered filter on an auth rejection and ignores a reply that started before it", async () => {
  const scope = await watchScope();
  const first = renderSlot(
    panel,
    { subPath: "" },
    {
      settings,
      rpc: {
        status: () => status(),
        getAutoFixerPreferences: () => preferences,
        listMyPullRequests: (input: unknown) =>
          mine([`Filter "${(input as ListInput).query}" row`]),
      },
    },
  );
  await showQuery("", ['Filter "" row']);
  await showQuery("b", ['Filter "b" row']);
  first.lifecycle.unmount();

  const readiness = held();
  const early = held();
  let calls = 0;
  const rejected = {
    state: "unavailable" as const,
    error: 'Gitea rejected tea login profile "work".',
    repos: [],
  };
  const returned = renderSlot(
    panel,
    { subPath: "" },
    {
      settings,
      rpc: {
        status: async () => {
          await readiness.opened;
          return rejected;
        },
        getAutoFixerPreferences: () => preferences,
        listMyPullRequests: async () => {
          calls += 1;
          if (calls > 1) throw new Error(rejected.error);
          await early.opened;
          return mine(['Filter "b" late row']);
        },
      },
    },
  );
  expect(screen.getByText('Filter "b" row')).toBeTruthy();

  await readiness.release();
  expect(screen.queryByText('Filter "b" row')).toBeNull();
  expect(screen.getAllByText(rejected.error).length).toBeGreaterThan(0);
  const shownB = recordShown('Filter "b"');
  const shownBlank = recordShown('Filter "" row');
  fireEvent.change(search(), { target: { value: "" } });
  await early.release();
  expect((await screen.findByRole("alert")).textContent).toContain(
    "Gitea rejected",
  );
  returned.lifecycle.unmount();

  await scope.setRealtimeConnectionState("connected");
  renderSlot(
    panel,
    { subPath: "" },
    {
      settings,
      rpc: {
        status: () => new Promise<never>(() => {}),
        getAutoFixerPreferences: () => preferences,
        listMyPullRequests: () => new Promise<never>(() => {}),
      },
    },
  );
  expect(skeleton()).toBeTruthy();
  expect(shownB()).toBe(false);
  expect(shownBlank()).toBe(false);
});

it("confirms the account before repainting remembered rows after a realtime reconnect", async () => {
  const scope = await watchScope();
  await visit(["Remembered row"]);
  await scope.setRealtimeConnectionState("reconnecting");
  await scope.setRealtimeConnectionState("connected");

  const readiness = held();
  const list = held();
  const shown = recordShown("Remembered row");
  const returned = renderSlot(
    panel,
    { subPath: "" },
    {
      settings,
      rpc: {
        status: async () => {
          await readiness.opened;
          return status();
        },
        getAutoFixerPreferences: () => preferences,
        listMyPullRequests: async () => {
          await list.opened;
          return mine(["Refreshed row"]);
        },
      },
    },
  );
  expect(skeleton()).toBeTruthy();
  expect(shown()).toBe(false);
  await readiness.release();
  expect(await screen.findByText("Remembered row")).toBeTruthy();
  expect(listCalls(returned)).toHaveLength(1);
  await list.release();
  expect(await screen.findByText("Refreshed row")).toBeTruthy();
});

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
      draft: false,
      checks: { state: "loaded", values: [], truncated: false },
      reviews: [],
      reviewsTruncated: false,
      reviewComments: [],
    },
  };
}

it("hides a pull request from the previous display scope until it reloads", async () => {
  const scope = await watchScope();
  let title = "Work account change";
  let reread = held();
  let reads = 0;
  renderSlot(
    panel,
    { subPath: "pulls/acme/widgets/10" },
    {
      settings,
      rpc: {
        status: () => status(),
        getAutoFixerPreferences: () => preferences,
        conversation: async () => {
          reads += 1;
          const shown = title;
          if (reads > 1) await reread.opened;
          return conversation(shown);
        },
      },
    },
  );
  expect(await screen.findByText("Work account change")).toBeTruthy();
  title = "Ops account change";
  await scope.emitRealtime("display-changed", { item: null });
  await waitFor(() => expect(reads).toBe(2));
  expect(screen.queryByText("Work account change")).toBeNull();
  await reread.release();
  expect(await screen.findByText("Ops account change")).toBeTruthy();
});

it("shows a conversation error with a way back to the list", async () => {
  renderSlot(
    panel,
    { subPath: "pulls/acme/widgets/10" },
    {
      settings,
      rpc: {
        status: () => status(),
        getAutoFixerPreferences: () => preferences,
        conversation: () => Promise.reject(new Error("Gitea is unavailable")),
      },
    },
  );

  expect(await screen.findByText("Gitea is unavailable")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Back to list" })).toBeTruthy();
});

it("replaces the new issue form when navigation changes to an issue detail", async () => {
  const slot = renderSlot(panel, { subPath: "my-issues/new" }, {
    settings,
    rpc: {
      status: () => status(),
      getAutoFixerPreferences: () => preferences,
      listMyIssues: () => ({ ...mine([]), account: work }),
      conversation: () => conversation("Issue detail after navigation"),
    },
  });
  expect(await screen.findByLabelText("Issue title")).toBeTruthy();
  slot.lifecycle.rerender(<Panel subPath="issues/acme/widgets/10" />);
  expect(await screen.findByText("Issue detail after navigation")).toBeTruthy();
  expect(screen.queryByLabelText("Issue title")).toBeNull();
});

it("keeps a review draft scoped to its pull request", async () => {
  const slot = renderSlot(panel, { subPath: "pulls/acme/widgets/10" }, {
    settings,
    rpc: {
      status: () => status(),
      getAutoFixerPreferences: () => preferences,
      conversation: ({ number }: { number: number }) => conversation(`PR ${number}`),
    },
  });
  const draft = await screen.findByPlaceholderText("Review summary");
  fireEvent.change(draft, { target: { value: "Private draft for PR A" } });
  slot.lifecycle.rerender(<Panel subPath="pulls/acme/widgets/11" />);
  expect(await screen.findByPlaceholderText("Review summary")).toHaveProperty("value", "");
});

it("does not load an item list on the Auto-fixers tab", async () => {
  const slot = renderSlot(panel, { subPath: "auto-fixers" }, {
    settings,
    rpc: {
      status: () => status(),
      getAutoFixerPreferences: () => preferences,
      listAutoFixerSessions: () => ({ sessions: [] }),
      listMyPullRequests: () => mine([]),
      listMyIssues: () => mine([]),
      listItems: () => mine([]),
    },
  });
  expect(await screen.findByText(/No auto-fixers yet/)).toBeTruthy();
  expect(slot.rpcCalls.some(call => call.method === "listItems")).toBe(false);
});
