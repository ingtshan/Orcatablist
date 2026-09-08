import type { OrcaDatabase } from "./db";
import { findLatestSentInputEvidence } from "./session-send-evidence";
import {
  CONFIRMATION_POLL_MS, createSentInputConfirmationQueue, createSentInputStore,
  type SentInputConfirmationQueue, type SentInputStore,
} from "./session-send";
export type { SentInputStore } from "./session-send";

export interface SessionSendRuntime {
  store: SentInputStore;
  confirmationQueue: SentInputConfirmationQueue;
  close(): void;
}

export interface SessionSendRuntimeOptions {
  db: OrcaDatabase;
  store?: SentInputStore;
  startPolling?: boolean;
  now?(): number;
  onError?(error: Error): void;
}

export function createSessionSendRuntime(options: SessionSendRuntimeOptions): SessionSendRuntime {
  const store = options.store ?? createSentInputStore();
  const confirmationQueue = createSentInputConfirmationQueue({
    store,
    getLatestUserInputs: (entries) => findLatestSentInputEvidence(options.db, entries),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  const onError = options.onError ?? ((error: Error) => {
    console.error("orcatab sent-input confirmation failed", error);
  });
  const timer = options.startPolling === false ? null : setInterval(() => {
    if (!confirmationQueue.hasPending()) return;
    void confirmationQueue.reconcile().catch(onError);
  }, CONFIRMATION_POLL_MS);
  timer?.unref?.();
  return {
    store,
    confirmationQueue,
    close: () => { if (timer !== null) clearInterval(timer); },
  };
}
