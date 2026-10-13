/**
 * File-based debug logging for pi extensions.
 *
 * Writes to /tmp/pi-<tag>-debug/<filename>.log with per-type throttling. The
 * filename defaults to `debug-<pid>.log`: several pi processes (main sessions,
 * subagent children) can run at once, and a shared file would let one process's
 * per-dispatch clear() wipe another's entries. Safe to call from hot paths
 * (render functions, streaming events) — throttled to avoid flooding disk or
 * slowing the event loop. Files stay until /tmp is cleaned on reboot.
 *
 * Usage:
 *   import { createDebugLogger } from "../shared/debug";
 *   const debugLog = createDebugLogger("subagent");
 *   debugLog("render", 500, { eventType, data });
 */

import * as fs from "node:fs";
import * as path from "node:path";

export interface DebugLogger {
  (type: string, throttleMs: number, ...args: unknown[]): void;
  /** Clear the log file. */
  clear(): void;
}

export function createDebugLogger(tag: string, filename = `debug-${process.pid}.log`): DebugLogger {
  const dir = `/tmp/pi-${tag}-debug`;
  const logPath = path.join(dir, filename);

  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    /* already exists or inaccessible */
  }

  const lastByType = new Map<string, number>();

  const log = (type: string, throttleMs: number, ...args: unknown[]) => {
    const now = Date.now();
    const last = lastByType.get(type) ?? 0;
    if (now - last < throttleMs) return;
    lastByType.set(type, now);
    const line = `[${new Date().toISOString()}] ${type} ${args
      .map((a) => {
        if (typeof a === "string") return a;
        if (typeof a === "object" && a !== null) {
          try {
            return JSON.stringify(a);
          } catch {
            return String(a);
          }
        }
        return String(a);
      })
      .join(" ")}`;
    try {
      fs.appendFileSync(logPath, `${line}\n`);
    } catch {
      /* write failed — ignore */
    }
  };

  log.clear = () => {
    try {
      fs.writeFileSync(logPath, "");
    } catch {
      /* ignore */
    }
  };

  return log;
}
