/**
 * One shared "run it again, but only once more" scheduler.
 *
 * Callers request a pass instead of starting one. While a pass runs, any number of requests
 * collapse into exactly one follow-up, and each caller settles as soon as a pass that began
 * after its own request finishes — never waiting for the stream of callers to stop.
 */

export type RunResult<T> =
  | { status: "completed"; value: T }
  | { status: "failed"; error: unknown }
  | { status: "cancelled" };

export interface CoalescingRunner<T> {
  /** Resolves when the next pass that can see this request has finished. */
  request(): Promise<RunResult<T>>;
  running(): boolean;
  queued(): boolean;
  /** Cancels queued requests and refuses new ones; an in-flight pass still settles normally. */
  close(): void;
  closed(): boolean;
}

export function createCoalescingRunner<T>(pass: () => Promise<T>): CoalescingRunner<T> {
  type Settle = (result: RunResult<T>) => void;
  let waiting: Settle[] = [];
  let active = false;
  let closed = false;

  const start = (): void => {
    if (active || closed || waiting.length === 0) return;
    active = true;
    const serving = waiting;
    waiting = [];
    void (async () => {
      let result: RunResult<T>;
      try {
        result = { status: "completed", value: await pass() };
      } catch (error) {
        result = { status: "failed", error };
      }
      active = false;
      for (const settle of serving) settle(result);
      // A failed pass still owes the queue its follow-up.
      start();
    })();
  };

  return {
    request: () => new Promise<RunResult<T>>((resolve) => {
      if (closed) {
        resolve({ status: "cancelled" });
        return;
      }
      waiting.push(resolve);
      start();
    }),
    running: () => active,
    queued: () => waiting.length > 0,
    closed: () => closed,
    close: () => {
      closed = true;
      const cancelled = waiting;
      waiting = [];
      for (const settle of cancelled) settle({ status: "cancelled" });
    },
  };
}
