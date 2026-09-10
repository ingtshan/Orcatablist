import { ValidationError } from "./focus";
import { identityKey } from "./session-identity";
import { CONFIRMATION_POLL_MS, confirmationState, SendConflictError, sendSessionInput,
  type SendExpectation, type SentInputConfirmationQueue, type SessionSendDeps } from "./session-send";
import type { SessionOutboxStore } from "./session-outbox";

export interface OutboxSendDeps extends SessionSendDeps { outbox: SessionOutboxStore; }

export async function sendOutboxInput(id: string, deps: OutboxSendDeps, expected: SendExpectation = {}, automatic = false) {
  const item = deps.outbox.get(id);
  if (!item) throw new ValidationError("outbox item not found");
  const setting = deps.outbox.setting(item);
  if (setting.pending || deps.store.get(item.agent, item.sid, item.env)) {
    throw new SendConflictError("send-pending", "previous input is awaiting confirmation");
  }
  if (automatic && (!setting.autoSend || deps.outbox.list().find((entry) => identityKey(entry) === identityKey(item))?.id !== id)) {
    throw new ValidationError("automatic sending is disabled or queue order changed");
  }
  deps.outbox.updateSetting(item, { pending: { ...item, itemId: id, phase: "sending",
    handle: expected.handle ?? "", sentAt: (deps.now ?? Date.now)() }, error: null });
  let submitted = false;
  try {
    const record = await sendSessionInput(item.agent, item.sid, item.text, { ...deps, beforeSend: () => {
      deps.beforeSend?.();
      if (automatic && !deps.outbox.setting(item).autoSend) throw new ValidationError("automatic sending was turned off");
    } }, expected, item.env);
    submitted = true;
    deps.outbox.completeDelivery(item, { ...record, itemId: id, phase: "sent" });
    return record;
  } catch (error) {
    if (submitted) {
      deps.outbox.updateSetting(item, { autoSend: false, error: "消息已发送，但保存结果失败；请核对会话后再处理队列。" });
      throw error;
    }
    const conflict = error instanceof SendConflictError;
    deps.outbox.updateSetting(item, { pending: null,
      ...(automatic && !conflict ? { autoSend: false } : {}),
      error: conflict ? null : `发送失败，已保留消息：${error instanceof Error ? error.message : String(error)}` });
    throw error;
  }
}

export interface OutboxRuntimeOptions extends OutboxSendDeps {
  confirmationQueue: SentInputConfirmationQueue;
  startPolling?: boolean;
  liveFresh?(): boolean;
  onError?(error: Error): void;
}

export function createSessionOutboxRuntime(options: OutboxRuntimeOptions) {
  let running: Promise<void> | null = null;
  let closed = false;
  for (const setting of options.outbox.settings()) {
    if (setting.pending?.phase === "sent") options.store.record(setting.pending);
    if (setting.pending?.phase === "sending") options.outbox.updateSetting(setting, {
      autoSend: false, pending: null, error: "上次发送中断，自动发送已暂停；请核对会话后手动处理这条消息。",
    });
  }
  async function run() {
    await options.confirmationQueue.reconcile();
    if (closed) return;
    for (const setting of options.outbox.settings()) {
      if (setting.pending?.phase !== "sent") continue;
      const pending = options.store.get(setting.agent, setting.sid, setting.env);
      if (!pending) options.outbox.updateSetting(setting, { pending: null });
      else if (confirmationState(pending, (options.now ?? Date.now)()) === "stalled" && setting.autoSend) {
        options.outbox.updateSetting(setting, { autoSend: false, error: "上一条消息的送达尚未确认，自动发送已暂停。" });
      }
    }
    for (const setting of options.outbox.settings()) {
      if (closed || !setting.autoSend || setting.pending) continue;
      const item = options.outbox.list().find((entry) => identityKey(entry) === identityKey(setting));
      if (!item || options.store.get(item.agent, item.sid, item.env)) continue;
      const live = await options.findLive(item.agent, item.sid, item.env);
      if (closed) return;
      if (options.liveFresh?.() === false || live?.status !== "done" || live.waitingFor || !live.handle) continue;
      try {
        await sendOutboxInput(item.id, { ...options, beforeSend: () => {
          if (closed || options.liveFresh?.() === false) throw new ValidationError("live state unavailable; automatic sending paused");
        } }, { handle: live.handle, status: live.status }, true);
      } catch (error) {
        if (!(error instanceof SendConflictError) && !(error instanceof ValidationError)) {
          options.onError?.(error instanceof Error ? error : new Error(String(error)));
        }
      }
    }
  }
  function tick(): Promise<void> {
    if (closed) return Promise.resolve();
    if (running) return running;
    running = run().finally(() => { running = null; });
    return running;
  }
  const timer = options.startPolling === false ? null : setInterval(() => {
    void tick().catch((error) => (options.onError ?? console.error)(error));
  }, CONFIRMATION_POLL_MS);
  timer?.unref?.();
  return { tick, close: () => { closed = true; if (timer) clearInterval(timer); } };
}
