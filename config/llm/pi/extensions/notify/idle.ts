/**
 * Whether the user is away from this terminal.
 *
 * `HIDIdleTime` (nanoseconds since the last keyboard or pointer event) comes from
 * IOHIDSystem: the one presence signal macOS gives without an accessibility
 * prompt. Display sleep would be sharper, but `pmset -g powerstate` does not
 * report on every machine.
 *
 * Unknown idle time counts as away: a stray notification costs one glance, a
 * queued dialog nobody answers costs the run.
 */

import { execFile } from "node:child_process";

const IDLE_TIMEOUT_MS = 500;

export interface PushPolicy {
  /** Idle seconds after which the user counts as away. */
  idleSeconds: number;
  /** Shortest run worth a push. */
  minRunMs: number;
}

export const DEFAULT_POLICY: PushPolicy = { idleSeconds: 60, minRunMs: 300_000 };

/** Parse `"HIDIdleTime" = <nanoseconds>` out of `ioreg` output. */
export function parseHidIdleSeconds(output: string): number | null {
  const match = /"HIDIdleTime"\s*=\s*(\d+)/.exec(output);
  if (!match) return null;
  const nanos = Number(match[1]);
  return Number.isFinite(nanos) ? nanos / 1e9 : null;
}

function seconds(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

/** Policy from the environment; a malformed value keeps the default. */
export function readPolicy(env: Record<string, string | undefined>): PushPolicy {
  return {
    idleSeconds: seconds(env.PI_NOTIFY_IDLE_SECONDS, DEFAULT_POLICY.idleSeconds),
    minRunMs: seconds(env.PI_NOTIFY_MIN_RUN_SECONDS, DEFAULT_POLICY.minRunMs / 1000) * 1000,
  };
}

export function away(idleSeconds: number | null, policy: PushPolicy): boolean {
  return idleSeconds === null || idleSeconds >= policy.idleSeconds;
}

/** A blocked dialog is worth a push whenever the user is not at the keyboard. */
export function pushBlocked(idleSeconds: number | null, policy: PushPolicy): boolean {
  return away(idleSeconds, policy);
}

/** A finished run is worth a push only when it was long enough to walk away from. */
export function pushSettled(runMs: number, idleSeconds: number | null, policy: PushPolicy): boolean {
  return runMs >= policy.minRunMs && away(idleSeconds, policy);
}

/** Seconds since the last keyboard or pointer event, or null when unknown. */
export function hidIdleSeconds(): Promise<number | null> {
  if (process.platform !== "darwin") return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile("ioreg", ["-c", "IOHIDSystem"], { timeout: IDLE_TIMEOUT_MS }, (error, stdout) => {
      resolve(error ? null : parseHidIdleSeconds(stdout.toString()));
    });
  });
}
