import { existsSync, watch, type FSWatcher } from "node:fs";
import { WATCH_DEBOUNCE_MS, WATCH_MAX_WAIT_MS } from "./config";

export interface WatchHandle { mode: "fs.watch" | "timer"; close(): void; }

/** Injectable so debounce behaviour can be tested on a controlled clock instead of real waits. */
export interface DebounceTimers {
  schedule(callback: () => void, delayMs: number): unknown;
  cancel(handle: unknown): void;
}

export interface Debouncer {
  /** Records activity; fires after the quiet window, or at the maximum wait, whichever comes first. */
  signal(): void;
  close(): void;
}

export interface DebouncerOptions {
  quietMs?: number;
  /** Ceiling on how long continuous activity may postpone the run. */
  maxWaitMs?: number;
  timers?: DebounceTimers;
}

const unrefTimers: DebounceTimers = {
  schedule: (callback, delayMs) => {
    const timer = setTimeout(callback, delayMs);
    timer.unref?.();
    return timer;
  },
  cancel: (handle) => { clearTimeout(handle as ReturnType<typeof setTimeout>); },
};

export function createDebouncer(fire: () => void, options: DebouncerOptions = {}): Debouncer {
  const quietMs = options.quietMs ?? WATCH_DEBOUNCE_MS;
  const maxWaitMs = options.maxWaitMs ?? WATCH_MAX_WAIT_MS;
  const timers = options.timers ?? unrefTimers;
  let quiet: unknown = null;
  let ceiling: unknown = null;
  let closed = false;

  const clear = (): void => {
    if (quiet !== null) timers.cancel(quiet);
    if (ceiling !== null) timers.cancel(ceiling);
    quiet = null;
    ceiling = null;
  };

  const run = (): void => {
    clear();
    if (!closed) fire();
  };

  return {
    signal: () => {
      if (closed) return;
      if (quiet !== null) timers.cancel(quiet);
      quiet = timers.schedule(run, quietMs);
      // Started once per burst: an endless stream of events cannot postpone the run forever.
      if (ceiling === null) ceiling = timers.schedule(run, maxWaitMs);
    },
    close: () => {
      closed = true;
      clear();
    },
  };
}

export interface SessionWatcherOptions {
  onFailure?: () => void;
  debounce?: DebouncerOptions;
}

/** Watches the local session roots and asks for one coalesced pass per burst of activity. */
export function startSessionWatcher(
  paths: readonly string[], request: () => void, options: SessionWatcherOptions = {},
): WatchHandle {
  const watchers: FSWatcher[] = [];
  const debouncer = createDebouncer(request, options.debounce);
  let failed = false;
  const close = (): void => {
    debouncer.close();
    for (const watcher of watchers) watcher.close();
  };
  try {
    for (const path of paths.filter(existsSync)) {
      watchers.push(watch(path, { recursive: true }, () => debouncer.signal()));
    }
    if (watchers.length === 0) throw new Error("no session directories available to watch");
    const handle: WatchHandle = { mode: "fs.watch", close };
    for (const watcher of watchers) {
      watcher.on("error", (error) => {
        if (failed) return;
        failed = true;
        handle.mode = "timer";
        console.error("orcatab fs.watch failed; using timer fallback", error);
        close();
        options.onFailure?.();
      });
    }
    return handle;
  } catch (error) {
    console.error("orcatab fs.watch failed; using timer fallback", error);
    close();
    return { mode: "timer", close: () => {} };
  }
}
