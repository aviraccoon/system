/**
 * Thinking-level helpers for the /sidecar-models picker.
 *
 * Pure: no pi imports, so the cycling and request-param rules are testable.
 * Callers pass the levels a model actually supports (pi-ai's
 * `getSupportedThinkingLevels`), since that needs a resolved pi model.
 */

import { type ModelEntry, THINKING_LEVELS, type ThinkingLevel } from "../shared/model-roles";

// Re-exported so callers of this module do not reach into shared for the vocabulary it works in.
export { THINKING_LEVELS, type ThinkingLevel };

export function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value);
}

/** The level an entry is configured with. `model-roles.ts` treats a missing one as "off". */
export function entryThinking(entry: ModelEntry | undefined): ThinkingLevel {
  const level = entry?.thinking;
  return isThinkingLevel(level) ? level : "off";
}

/**
 * Next level in the cycle, wrapping at the end.
 *
 * `supported` comes from the model, so a model without `medium` never lands on it
 * (pi-ai would clamp it to a neighbour, making the stored value disagree with what
 * runs). Levels are cycled in THINKING_LEVELS order regardless of input order, and
 * a current level the model no longer supports starts the cycle at the weakest.
 */
export function nextThinking(current: ThinkingLevel, supported: readonly ThinkingLevel[]): ThinkingLevel {
  const levels = THINKING_LEVELS.filter((level) => supported.includes(level));
  if (levels.length === 0) return current;
  const index = levels.indexOf(current);
  if (index === -1) return levels[0];
  return levels[(index + 1) % levels.length];
}

/**
 * True when the entry pins `chat_template_kwargs.enable_thinking: false`.
 *
 * That pin is merged over the payload pi-ai builds from the thinking level
 * (`sidecarComplete`'s onPayload merge is shallow, replacing `chat_template_kwargs`
 * whole), so it silently disables thinking no matter what level is configured.
 * Local Qwen/oMLX entries in roles.json all carry it.
 */
export function hasEnableThinkingPin(entry: ModelEntry | undefined): boolean {
  const kwargs = entry?.requestParams?.chat_template_kwargs;
  if (typeof kwargs !== "object" || kwargs === null) return false;
  return (kwargs as Record<string, unknown>).enable_thinking === false;
}

/**
 * Drop the `enable_thinking: false` pin, keeping every other request param.
 * Returns an entry with the pin removed; the input is not mutated. `requestParams`
 * is removed entirely when nothing else is left, so the written JSON stays tidy.
 */
export function withoutEnableThinkingPin(entry: ModelEntry): ModelEntry {
  const requestParams = entry.requestParams;
  if (typeof requestParams !== "object" || requestParams === null) return entry;
  const kwargs = requestParams.chat_template_kwargs;
  if (typeof kwargs !== "object" || kwargs === null) return { ...entry };
  const { enable_thinking: _dropped, ...remainingKwargs } = kwargs as Record<string, unknown>;
  const { chat_template_kwargs: _none, ...restParams } = requestParams;
  const next: ModelEntry = { ...entry };
  if (Object.keys(remainingKwargs).length > 0) {
    next.requestParams = { ...restParams, chat_template_kwargs: remainingKwargs };
  } else if (Object.keys(restParams).length > 0) {
    next.requestParams = restParams;
  } else {
    delete next.requestParams;
  }
  return next;
}

/**
 * Entry to put in the chain when a model is added.
 *
 * Reuses the role's configured entry so a previously saved thinking level,
 * `requestParams`, and `maxAttempts` survive a remove/re-add or a sync.
 */
export function entryForAdd(configured: ModelEntry | undefined, ref: string): ModelEntry {
  if (configured && configured.ref === ref) return { ...configured };
  return { ref, thinking: "off" };
}
