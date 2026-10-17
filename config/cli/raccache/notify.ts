// Best-effort push notification through ntfy. A failed notification never fails
// the run, but it is reported to the log: silence has to keep meaning "nothing
// to report", not "the report could not be sent".

import { existsSync, readFileSync } from "node:fs";

export interface NotifyOptions {
  title: string;
  message: string;
  priority?: "default" | "high";
  tags?: string;
  timeoutMs?: number;
  /** Topic or URL, e.g. from the secrets env file; the file is the fallback. */
  url?: string;
}

export interface NotifyResult {
  sent: boolean;
  reason?: string;
}

/**
 * ntfy takes a full URL or a bare topic. The sops secret holds the topic and the
 * machine-local file holds the URL, so both shapes have to work.
 */
export function ntfyUrl(raw?: string): string | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://ntfy.sh/${value}`;
}

/** Where a notification would go: the configured value first, else the file. */
export function resolveNtfyUrl(ntfyFile: string, url?: string): string | undefined {
  if (url?.trim()) return ntfyUrl(url);
  if (!existsSync(ntfyFile)) return undefined;
  return ntfyUrl(readFileSync(ntfyFile, "utf8").split("\n")[0]);
}

export async function notify(ntfyFile: string, options: NotifyOptions): Promise<NotifyResult> {
  const url = resolveNtfyUrl(ntfyFile, options.url);
  if (!url) return { sent: false, reason: "no ntfy URL configured" };
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Title: options.title,
        Priority: options.priority ?? "default",
        Tags: options.tags ?? "floppy_disk",
      },
      body: options.message,
      signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
    });
    if (!response.ok) return { sent: false, reason: `ntfy replied ${response.status}` };
    return { sent: true };
  } catch (error) {
    // Anyone holding the topic can read it, so keep it out of the log.
    const detail = (error instanceof Error ? error.message : String(error)).replaceAll(url, "<ntfy>");
    return { sent: false, reason: detail };
  }
}
