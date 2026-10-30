/**
 * The guard's numeric settings, validated once at load.
 *
 * A misread threshold changes refusal behaviour in one direction or the other:
 * `0` refuses everything a judge looks at, `70` read as a percentage refuses
 * nothing, and an empty value is `0` again. An invalid value falls back to the
 * default and says so, so a typo cannot turn the guard off quietly.
 */

import { DEFAULT_POLICY_THRESHOLD } from "../shared/env-policy";

const DEFAULT_TIMEOUT_MS = 10_000;

export interface GuardNumbers {
  threshold: number;
  timeoutMs: number;
  /** Lines for the once-per-session notice; empty when both settings are usable. */
  warnings: string[];
}

export function guardNumbers(env: Record<string, string | undefined>): GuardNumbers {
  const warnings: string[] = [];

  const rawThreshold = env.PI_GUARD_THRESHOLD;
  const parsedThreshold = rawThreshold === undefined ? DEFAULT_POLICY_THRESHOLD : Number(rawThreshold);
  const thresholdOk = Number.isFinite(parsedThreshold) && parsedThreshold > 0 && parsedThreshold <= 1;
  if (rawThreshold !== undefined && !thresholdOk) {
    warnings.push(
      `PI_GUARD_THRESHOLD=${rawThreshold} is not a probability in (0, 1]; using ${DEFAULT_POLICY_THRESHOLD}`,
    );
  }

  const rawTimeout = env.PI_GUARD_TIMEOUT_MS;
  const parsedTimeout = rawTimeout === undefined ? DEFAULT_TIMEOUT_MS : Number(rawTimeout);
  const timeoutOk = Number.isFinite(parsedTimeout) && parsedTimeout > 0;
  if (rawTimeout !== undefined && !timeoutOk) {
    warnings.push(`PI_GUARD_TIMEOUT_MS=${rawTimeout} is not a positive number; using ${DEFAULT_TIMEOUT_MS}`);
  }

  return {
    threshold: thresholdOk ? parsedThreshold : DEFAULT_POLICY_THRESHOLD,
    timeoutMs: timeoutOk ? parsedTimeout : DEFAULT_TIMEOUT_MS,
    warnings,
  };
}
