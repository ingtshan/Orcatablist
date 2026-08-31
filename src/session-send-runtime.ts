import type { OrcaDatabase } from "./db";
import { findSentInputEvidence } from "./session-send-evidence";
import {
  CONFIRMATION_POLL_MS, createSentInputConfirmationQueue, createSentInputStore,
  type SentInputConfirmationQueue, type SentInputStore,
} from "./session-send";
import type { SessionLiveReader } from "./session-live";
export type { SentInputStore } from "./session-send";

export interface SessionSendRuntime {
  store: SentInputStore;
  confirmationQueue: SentInputConfirmationQueue;
  close(): void;
}

export interface SessionSendRuntimeOptions {
  db: OrcaDatabase;
  liveReader: SessionLiveReader;
  store?: SentInputStore;
  startPolling?: boolean;
  now?(): number;
  onError?(error: Error): void;
}

export function createSessionSendRuntime(options: SessionSendRuntimeOptions): SessionSendRuntime {
  const store = options.store ?? createSentInputStore();
  const confirmationQueue = createSentInputConfirmationQueue({
    store,
    refreshLive: (force) => options.liveReader.refresh(force),
    getUserInputs: (entries) => findSentInputEvidence(options.db, entries),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  const onError = options.onError ?? ((error: Error) => {
    console.error("orcatab sent-input confirmation failed", error);
  });
  const timer = options.startPolling === false ? null : setInterval(() => {
    if (!confirmationQueue.hasPending()) return;
    void confirmationQueue.reconcile({ forceLive: true }).catch(onError);
  }, CONFIRMATION_POLL_MS);
  timer?.unref?.();
  return {
    store,
    confirmationQueue,
    close: () => { if (timer !== null) clearInterval(timer); },
  };
}
