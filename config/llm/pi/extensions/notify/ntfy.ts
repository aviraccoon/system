/**
 * Best-effort push through ntfy. A failed push never fails a run; the caller
 * turns the first failure into a toast so a broken topic is not silent.
 *
 * The configured value may be a full URL or a bare topic, which is read as an
 * ntfy.sh topic: a topic is what a secret holds, and a URL is what a local file
 * may hold when the server is self-hosted. Anything that cannot be read or sent
 * stays a no-op.
 */

import { existsSync, readFileSync } from "node:fs";
import { expandTilde } from "../shared/paths";

export interface PushOptions {
  title: string;
  body: string;
  priority?: "default" | "high";
  tags?: string;
  timeoutMs?: number;
}

export interface PushResult {
  sent: boolean;
  reason?: string;
}

/** The one collaborator worth injecting: a fetcher that fails with the URL in
 * its message is how the leak guard below gets a pin that can fail. */
export type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

export function ntfyUrl(raw?: string): string | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://ntfy.sh/${value}`;
}

/** The configured value first, then the machine-local file that holds a topic. */
export function resolveNtfyUrl(configured: string | undefined, file: string): string | undefined {
  if (configured?.trim()) return ntfyUrl(configured);
  const path = expandTilde(file);
  if (!existsSync(path)) return undefined;
  try {
    return ntfyUrl(readFileSync(path, "utf8").split("\n")[0]);
  } catch {
    // An unreadable path configures nothing; a push must never throw.
    return undefined;
  }
}

export async function push(url: string, options: PushOptions, fetcher: Fetcher = fetch): Promise<PushResult> {
  try {
    const response = await fetcher(url, {
      method: "POST",
      headers: {
        Title: options.title,
        Priority: options.priority ?? "default",
        Tags: options.tags ?? "robot",
      },
      body: options.body,
      signal: AbortSignal.timeout(options.timeoutMs ?? 5_000),
    });
    if (!response.ok) return { sent: false, reason: `ntfy replied ${response.status}` };
    return { sent: true };
  } catch (error) {
    // Anyone holding the topic can read it, so keep it out of the message.
    const detail = (error instanceof Error ? error.message : String(error)).replaceAll(url, "<ntfy>");
    return { sent: false, reason: detail };
  }
}
