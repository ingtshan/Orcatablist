/** Version of execution settings extracted from an entire source transcript. */
export const EXECUTION_METADATA_VERSION = 1;

export interface SessionExecution {
  model?: string | null;
  reasoningEffort?: string | null;
}

const MAX_MODEL_LENGTH = 160;
const MAX_EFFORT_LENGTH = 32;

function label(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text && text.length <= maxLength && !/[\x00-\x1f<>]/.test(text) ? text : null;
}

/** A model-bearing event is a settings snapshot; missing effort must not inherit an old value. */
export function executionSettings(modelValue: unknown, effortValue: unknown): SessionExecution {
  if (modelValue === "<synthetic>") return {};
  const model = label(modelValue, MAX_MODEL_LENGTH);
  const reasoningEffort = label(effortValue, MAX_EFFORT_LENGTH);
  if (model !== null) return { model, reasoningEffort };
  return reasoningEffort === null ? {} : { reasoningEffort };
}

/** Hermes stores optional per-session provider settings as JSON, never consult global defaults. */
export function hermesExecutionSettings(model: unknown, config: unknown): SessionExecution {
  let settings: Record<string, unknown> = {};
  if (typeof config === "string") {
    try {
      const parsed: unknown = JSON.parse(config);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) settings = parsed as Record<string, unknown>;
    } catch { /* Older ledgers may carry no parseable provider settings. */ }
  }
  const reasoning = settings.reasoning;
  const effort = settings.reasoning_effort ?? (reasoning && typeof reasoning === "object" ? (reasoning as Record<string, unknown>).effort : undefined);
  return executionSettings(model, effort);
}
