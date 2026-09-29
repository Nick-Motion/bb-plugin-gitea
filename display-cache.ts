export type Freshness =
  | { state: "fresh"; fetchedAt: number }
  | { state: "refreshing"; fetchedAt: number }
  | { state: "stale-error"; fetchedAt: number; error: string };

export type Display<T> = { value: T; freshness: Freshness };

export type FreshnessPolicy = {
  freshMs: number;
  retainMs: number;
  retryMs: number;
};

export type CacheBounds = {
  maxEntries: number;
  maxBytes: number;
  maxEntryBytes: number;
};

export type FailureScope = "retain" | "drop-entry";

type Stored<T> = {
  value: T;
  fetchedAt: number;
  bytes: number;
  failure: { message: string; at: number } | null;
};

export type ReadDecision =
  { kind: "serve"; freshness: Freshness; refresh: boolean } | { kind: "load" };

export function decideRead<T>(
  stored: Stored<T> | null,
  refreshing: boolean,
  now: number,
  policy: FreshnessPolicy,
  usable: (value: T) => boolean,
): ReadDecision {
  if (
    stored === null ||
    !usable(stored.value) ||
    now - stored.fetchedAt >= policy.retainMs
  )
    return { kind: "load" };
  const { fetchedAt, failure } = stored;
  if (now - fetchedAt < policy.freshMs)
    return {
      kind: "serve",
      freshness: { state: "fresh", fetchedAt },
      refresh: false,
    };
  if (refreshing)
    return {
      kind: "serve",
      freshness: { state: "refreshing", fetchedAt },
      refresh: false,
    };
  if (failure !== null && now - failure.at < policy.retryMs)
    return {
      kind: "serve",
      freshness: { state: "stale-error", fetchedAt, error: failure.message },
      refresh: false,
    };
  return {
    kind: "serve",
    freshness: { state: "refreshing", fetchedAt },
    refresh: true,
  };
}

type Inflight<T> = {
  entry: Entry<T>;
  controller: AbortController;
  promise: Promise<T>;
  background: boolean;
  waiters: number;
};

type Entry<T> = {
  tag: string;
  stored: Stored<T> | null;
  inflight: Inflight<T> | null;
};

export type ReadOptions<T> = {
  policy: FreshnessPolicy;
  signal?: AbortSignal;
  usable?: (value: T) => boolean;
  storable?: (value: T) => boolean;
};

export class DisplayCache<T> {
  readonly #entries = new Map<string, Entry<T>>();
  #bounds: CacheBounds;
  readonly #now: () => number;
  readonly #classify: (error: unknown) => FailureScope;
  readonly #onBackgroundSettled: (tag: string) => void;
  #bytes = 0;
  #disposed = false;

  constructor(options: {
    bounds: CacheBounds;
    now: () => number;
    classify: (error: unknown) => FailureScope;
    onBackgroundSettled: (tag: string) => void;
  }) {
    this.#bounds = options.bounds;
    this.#now = options.now;
    this.#classify = options.classify;
    this.#onBackgroundSettled = options.onBackgroundSettled;
  }

  get size() {
    return { entries: this.#entries.size, bytes: this.#bytes };
  }

  async read(
    key: string,
    tag: string,
    load: (signal: AbortSignal) => Promise<T>,
    options: ReadOptions<T>,
  ): Promise<Display<T>> {
    if (this.#disposed)
      throw new Error("The Gitea display cache was disposed.");
    options.signal?.throwIfAborted();
    const entry = this.#entries.get(key);
    const decision = decideRead(
      entry?.stored ?? null,
      entry?.inflight != null,
      this.#now(),
      options.policy,
      options.usable ?? (() => true),
    );
    if (decision.kind === "serve" && entry?.stored) {
      this.#touch(key, entry);
      if (decision.refresh) this.#start(key, entry, load, options, true);
      return { value: entry.stored.value, freshness: decision.freshness };
    }
    const target = entry ?? this.#create(key, tag);
    const inflight =
      target.inflight ?? this.#start(key, target, load, options, false);
    const value = await this.#wait(key, inflight, options.signal);
    return { value, freshness: { state: "fresh", fetchedAt: this.#now() } };
  }

  invalidate(tag: string): void {
    for (const [key, entry] of this.#entries)
      if (entry.tag === tag) this.#remove(key, entry);
  }

  resize(bounds: CacheBounds): boolean {
    this.#bounds = bounds;
    return this.clear();
  }

  clear(): boolean {
    let removed = false;
    for (const [key, entry] of this.#entries) {
      removed ||= entry.stored !== null;
      this.#remove(key, entry);
    }
    return removed;
  }

  dispose(): void {
    this.#disposed = true;
    for (const [key, entry] of this.#entries) {
      entry.inflight?.controller.abort(
        new Error("The Gitea plugin is unloading."),
      );
      this.#remove(key, entry);
    }
  }

  #create(key: string, tag: string): Entry<T> {
    const entry: Entry<T> = { tag, stored: null, inflight: null };
    this.#entries.set(key, entry);
    return entry;
  }

  #touch(key: string, entry: Entry<T>) {
    this.#entries.delete(key);
    this.#entries.set(key, entry);
  }

  #current(key: string, inflight: Inflight<T>) {
    return (
      this.#entries.get(key) === inflight.entry &&
      inflight.entry.inflight === inflight
    );
  }

  #remove(key: string, entry: Entry<T>) {
    if (this.#entries.get(key) !== entry) return;
    this.#entries.delete(key);
    this.#bytes -= entry.stored?.bytes ?? 0;
    const inflight = entry.inflight;
    entry.inflight = null;
    if (inflight && inflight.waiters === 0)
      inflight.controller.abort(
        new Error("The cached Gitea read was invalidated."),
      );
  }

  #start(
    key: string,
    entry: Entry<T>,
    load: (signal: AbortSignal) => Promise<T>,
    options: ReadOptions<T>,
    background: boolean,
  ): Inflight<T> {
    const controller = new AbortController();
    let inflight: Inflight<T> | null = null;
    const promise = Promise.resolve()
      .then(() => load(controller.signal))
      .then(
        (value) => {
          if (inflight && this.#current(key, inflight))
            this.#store(key, inflight, value, options);
          return value;
        },
        (error: unknown) => {
          if (inflight && this.#current(key, inflight))
            this.#fail(key, inflight, error);
          throw error;
        },
      );
    promise.catch(() => undefined);
    inflight = { entry, controller, background, waiters: 0, promise };
    entry.inflight = inflight;
    return inflight;
  }

  #store(
    key: string,
    inflight: Inflight<T>,
    value: T,
    options: ReadOptions<T>,
  ) {
    const { entry } = inflight;
    entry.inflight = null;
    this.#bytes -= entry.stored?.bytes ?? 0;
    entry.stored = null;
    const bytes = Buffer.byteLength(JSON.stringify(value), "utf8");
    if (
      bytes > this.#bounds.maxEntryBytes ||
      !(options.storable?.(value) ?? true)
    )
      this.#entries.delete(key);
    else {
      entry.stored = { value, fetchedAt: this.#now(), bytes, failure: null };
      this.#bytes += bytes;
      this.#touch(key, entry);
      this.#evict(entry);
    }
    if (inflight.background) this.#onBackgroundSettled(entry.tag);
  }

  #fail(key: string, inflight: Inflight<T>, error: unknown) {
    const { entry } = inflight;
    entry.inflight = null;
    const scope = this.#classify(error);
    if (scope === "drop-entry" || !inflight.background || !entry.stored)
      this.#remove(key, entry);
    else
      entry.stored.failure = {
        message: error instanceof Error ? error.message : "Gitea read failed.",
        at: this.#now(),
      };
    if (inflight.background) this.#onBackgroundSettled(entry.tag);
  }

  #evict(keep: Entry<T>) {
    for (const [key, entry] of this.#entries) {
      if (
        this.#entries.size <= this.#bounds.maxEntries &&
        this.#bytes <= this.#bounds.maxBytes
      )
        return;
      if (entry !== keep && entry.inflight === null) this.#remove(key, entry);
    }
  }

  async #wait(
    key: string,
    inflight: Inflight<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    inflight.waiters += 1;
    if (!signal)
      try {
        return await inflight.promise;
      } finally {
        inflight.waiters -= 1;
      }
    let onAbort: (() => void) | undefined;
    try {
      return await Promise.race([
        inflight.promise,
        new Promise<never>((_, reject) => {
          onAbort = () => reject(signal.reason);
          signal.addEventListener("abort", onAbort, { once: true });
          if (signal.aborted) onAbort();
        }),
      ]);
    } finally {
      signal.removeEventListener("abort", onAbort!);
      inflight.waiters -= 1;
      if (signal.aborted && inflight.waiters === 0 && !inflight.background) {
        const { entry } = inflight;
        if (this.#current(key, inflight)) {
          entry.inflight = null;
          if (entry.stored === null) this.#entries.delete(key);
        }
        inflight.controller.abort(signal.reason);
      }
    }
  }
}
