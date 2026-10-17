// Best-effort push notification through ntfy. A failed notification never
// fails the run: the log holds the same counts.

import { existsSync, readFileSync } from "node:fs";

export interface NotifyOptions {
  title: string;
  message: string;
  priority?: "default" | "high";
  tags?: string;
  timeoutMs?: number;
  /** Topic URL, e.g. from the secrets env file; the file is the fallback. */
  url?: string;
}

export async function notify(ntfyFile: string, options: NotifyOptions): Promise<boolean> {
  const fromFile = existsSync(ntfyFile) ? readFileSync(ntfyFile, "utf8").split("\n")[0]?.trim() : undefined;
  const url = options.url?.trim() || fromFile;
  if (!url) return false;
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
    return response.ok;
  } catch {
    return false;
  }
}
