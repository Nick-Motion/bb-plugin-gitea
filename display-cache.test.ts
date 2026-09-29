import { expect, it } from "vitest";
import { DisplayCache, decideRead, type FailureScope } from "./display-cache";

const policy = { freshMs: 100, retainMs: 1_000, retryMs: 50 };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function setup(
  bounds = { maxEntries: 10, maxBytes: 10_000, maxEntryBytes: 1_000 },
  classify: (error: unknown) => FailureScope = () => "retain",
) {
  const clock = { now: 0 };
  const settled: string[] = [];
  const cache = new DisplayCache<string>({
    bounds,
    now: () => clock.now,
    classify,
    onBackgroundSettled: (tag) => settled.push(tag),
  });
  return { cache, clock, settled };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

it("decides between fresh, refreshing, stale-error, and reload from age alone", () => {
  const stored = (fetchedAt: number, failureAt: number | null = null) => ({
    value: "v",
    fetchedAt,
    bytes: 1,
    failure: failureAt === null ? null : { message: "offline", at: failureAt },
  });
  const usable = () => true;
  expect(decideRead(null, false, 0, policy, usable)).toEqual({ kind: "load" });
  expect(decideRead(stored(0), false, 99, policy, usable)).toMatchObject({
    freshness: { state: "fresh" },
    refresh: false,
  });
  expect(decideRead(stored(0), false, 100, policy, usable)).toMatchObject({
    freshness: { state: "refreshing" },
    refresh: true,
  });
  expect(decideRead(stored(0), true, 100, policy, usable)).toMatchObject({
    freshness: { state: "refreshing" },
    refresh: false,
  });
  expect(decideRead(stored(0, 120), false, 150, policy, usable)).toMatchObject({
    freshness: { state: "stale-error", error: "offline" },
    refresh: false,
  });
  expect(decideRead(stored(0, 120), false, 170, policy, usable)).toMatchObject({
    freshness: { state: "refreshing" },
    refresh: true,
  });
  expect(decideRead(stored(0), false, 1_000, policy, usable)).toEqual({
    kind: "load",
  });
  expect(decideRead(stored(0), false, 10, policy, () => false)).toEqual({
    kind: "load",
  });
});

it("coalesces identical cold reads and serves the cached value without loading", async () => {
  const { cache } = setup();
  const gate = deferred<string>();
  let loads = 0;
  const load = () => {
    loads += 1;
    return gate.promise;
  };
  const first = cache.read("k", "t", load, { policy });
  const second = cache.read("k", "t", load, { policy });
  await flush();
  gate.resolve("one");
  expect(await first).toMatchObject({ value: "one" });
  expect(await second).toMatchObject({ value: "one" });
  expect(
    await cache.read("k", "t", async () => "two", { policy }),
  ).toMatchObject({ value: "one", freshness: { state: "fresh" } });
  expect(loads).toBe(1);
});

it("serves stale content immediately, refreshes once in the background, and reports failure with backoff", async () => {
  const { cache, clock, settled } = setup();
  await cache.read("k", "t", async () => "old", { policy });
  clock.now = 150;
  const refresh = deferred<string>();
  let loads = 0;
  const load = () => {
    loads += 1;
    return refresh.promise;
  };
  expect(await cache.read("k", "t", load, { policy })).toEqual({
    value: "old",
    freshness: { state: "refreshing", fetchedAt: 0 },
  });
  expect(await cache.read("k", "t", load, { policy })).toMatchObject({
    freshness: { state: "refreshing" },
  });
  refresh.reject(new Error("network down"));
  await flush();
  expect(settled).toEqual(["t"]);
  expect(loads).toBe(1);
  expect(await cache.read("k", "t", load, { policy })).toEqual({
    value: "old",
    freshness: { state: "stale-error", fetchedAt: 0, error: "network down" },
  });
  clock.now = 210;
  await cache.read("k", "t", async () => "new", { policy });
  await flush();
  expect(settled).toEqual(["t", "t"]);
  expect(await cache.read("k", "t", load, { policy })).toEqual({
    value: "new",
    freshness: { state: "fresh", fetchedAt: 210 },
  });
});

it("stops serving a stale value after the retention bound and reloads in the foreground", async () => {
  const { cache, clock } = setup();
  await cache.read("k", "t", async () => "old", { policy });
  clock.now = 1_000;
  await expect(
    cache.read(
      "k",
      "t",
      async () => {
        throw new Error("offline");
      },
      { policy },
    ),
  ).rejects.toThrow("offline");
  expect(cache.size.entries).toBe(0);
});

it("drops the entry instead of serving stale content for access failures", async () => {
  const { cache, clock, settled } = setup(undefined, () => "drop-entry");
  await cache.read("k", "t", async () => "private", { policy });
  clock.now = 150;
  await cache.read(
    "k",
    "t",
    async () => {
      throw new Error("forbidden");
    },
    { policy },
  );
  await flush();
  expect(settled).toEqual(["t"]);
  expect(cache.size).toEqual({ entries: 0, bytes: 0 });
});

it("evicts least recently used entries within entry and byte bounds and skips oversized values", async () => {
  const { cache } = setup({ maxEntries: 2, maxBytes: 30, maxEntryBytes: 20 });
  const value = (text: string) => async () => text;
  await cache.read("a", "a", value("a"), { policy });
  await cache.read("b", "b", value("b"), { policy });
  await cache.read("a", "a", value("unused"), { policy });
  await cache.read("c", "c", value("c"), { policy });
  expect(
    await cache.read("a", "a", value("reloaded"), { policy }),
  ).toMatchObject({ value: "a" });
  expect(
    await cache.read("b", "b", value("reloaded"), { policy }),
  ).toMatchObject({ value: "reloaded" });
  await cache.read("big", "big", value("x".repeat(40)), { policy });
  expect(cache.size.entries).toBe(2);
  await cache.read("d", "d", value("d".repeat(14)), { policy });
  await cache.read("e", "e", value("e".repeat(14)), { policy });
  expect(cache.size.bytes).toBeLessThanOrEqual(30);
});

it("applies new bounds on resize and drops entries cached under the old ones", async () => {
  const { cache } = setup({ maxEntries: 2, maxBytes: 30, maxEntryBytes: 20 });
  await cache.read("a", "a", async () => "a", { policy });
  cache.resize({ maxEntries: 2, maxBytes: 100, maxEntryBytes: 60 });
  expect(cache.size).toEqual({ entries: 0, bytes: 0 });
  await cache.read("big", "big", async () => "x".repeat(40), { policy });
  expect(
    await cache.read("big", "big", async () => "reloaded", { policy }),
  ).toMatchObject({ value: "x".repeat(40) });
});

it("does not let a load that was in flight during invalidation repopulate the cache", async () => {
  const { cache } = setup();
  const gate = deferred<string>();
  const first = cache.read("k", "t", () => gate.promise, { policy });
  await flush();
  cache.invalidate("t");
  const second = cache.read("k", "t", async () => "after", { policy });
  gate.resolve("before");
  expect(await first).toMatchObject({ value: "before" });
  expect(await second).toMatchObject({ value: "after" });
  expect(
    await cache.read("k", "t", async () => "unused", { policy }),
  ).toMatchObject({ value: "after" });
});

it("keeps a shared load running when one caller aborts and cancels it when the last caller leaves", async () => {
  const { cache } = setup();
  const gate = deferred<string>();
  let loadSignal: AbortSignal | null = null;
  const load = (signal: AbortSignal) => {
    loadSignal = signal;
    return gate.promise;
  };
  const leaving = new AbortController();
  const first = cache.read("k", "t", load, { policy, signal: leaving.signal });
  const second = cache.read("k", "t", load, { policy });
  await flush();
  leaving.abort(new Error("navigated away"));
  await expect(first).rejects.toThrow("navigated away");
  expect(loadSignal!.aborted).toBe(false);
  gate.resolve("shared");
  expect(await second).toMatchObject({ value: "shared" });

  const lone = new AbortController();
  const abandoned = cache.read(
    "x",
    "x",
    (signal) => {
      loadSignal = signal;
      return new Promise<string>(() => undefined);
    },
    { policy, signal: lone.signal },
  );
  await flush();
  lone.abort(new Error("gone"));
  await expect(abandoned).rejects.toThrow("gone");
  expect(loadSignal!.aborted).toBe(true);
  expect(cache.size.entries).toBe(1);
});

it("never cancels a background refresh when the caller that triggered it aborts", async () => {
  const { cache, clock } = setup();
  await cache.read("k", "t", async () => "old", { policy });
  clock.now = 150;
  const gate = deferred<string>();
  let loadSignal: AbortSignal | null = null;
  const caller = new AbortController();
  await cache.read(
    "k",
    "t",
    (signal) => {
      loadSignal = signal;
      return gate.promise;
    },
    { policy, signal: caller.signal },
  );
  caller.abort();
  await flush();
  expect(loadSignal!.aborted).toBe(false);
  gate.resolve("new");
  await flush();
  expect(
    await cache.read("k", "t", async () => "unused", { policy }),
  ).toMatchObject({ value: "new", freshness: { state: "fresh" } });
});

it("reloads unusable values and never stores values marked unstorable", async () => {
  const { cache } = setup();
  await cache.read("k", "t", async () => "r1", { policy });
  expect(
    await cache.read("k", "t", async () => "r2", {
      policy,
      usable: (value) => value === "r2",
    }),
  ).toMatchObject({ value: "r2" });
  await cache.read("s", "s", async () => "partial", {
    policy,
    storable: () => false,
  });
  expect(
    await cache.read("s", "s", async () => "complete", { policy }),
  ).toMatchObject({ value: "complete" });
});

it("aborts pending loads and rejects reads after dispose", async () => {
  const { cache } = setup();
  let loadSignal: AbortSignal | null = null;
  const pending = cache.read(
    "k",
    "t",
    (signal) => {
      loadSignal = signal;
      return new Promise<string>((_, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason)),
      );
    },
    { policy },
  );
  await flush();
  cache.dispose();
  await expect(pending).rejects.toThrow("unloading");
  expect(loadSignal!.aborted).toBe(true);
  await expect(
    cache.read("k", "t", async () => "late", { policy }),
  ).rejects.toThrow("disposed");
  expect(cache.size).toEqual({ entries: 0, bytes: 0 });
});
