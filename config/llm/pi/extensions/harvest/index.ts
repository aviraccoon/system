/**
 * Harvest status pill — gated on the journal meta.json `harvest` flag.
 *
 * Timer-state display in flagged sessions:
 *   - running: `⏱ 0:42 Project` (default color)
 *   - idle:    `⏱ idle` (warning color — forgetting to START is the real
 *     failure; the injected policy makes the agent ask once, this covers the rest)
 *   - not flagged: pill absent (personal sessions stay clean)
 *
 * Refreshed on agent_end only, never session_start: the status call shells the
 * harvest CLI whose auth chain may pop a 1Password unlock prompt, which must
 * not happen at session start — by turn end the user is demonstrably present.
 * CLI/auth failures degrade silently (no pill update).
 */
import { execFile } from "node:child_process";
import { basename, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadJournalConfig, loadProjectMeta } from "../shared/journal-context";
import { formatPill, type StatusJson } from "./pill";

const STATUS_TIMEOUT_MS = 8_000;

function statusJson(): Promise<StatusJson | null> {
  return new Promise((resolve) => {
    // --conceal: money fields are stripped before they reach extension memory.
    execFile("harvest", ["status", "--json", "--conceal"], { timeout: STATUS_TIMEOUT_MS }, (err, stdout) => {
      if (err) return resolve(null);
      try {
        resolve(JSON.parse(stdout.toString()) as StatusJson);
      } catch {
        resolve(null);
      }
    });
  });
}

function harvestFlag(value: unknown): boolean {
  return value === true || (value !== undefined && value !== null && typeof value === "object");
}

export default function (pi: ExtensionAPI) {
  let active = false;

  async function refresh(ctx: ExtensionContext) {
    if (!active) return;
    const status = await statusJson();
    if (!status) return;
    const pill = formatPill(status);
    ctx.ui.setStatus("harvest", pill.warn ? ctx.ui.theme.fg("warning", pill.text) : pill.text);
  }

  pi.on("session_start", async (_event, ctx) => {
    active = false;
    ctx.ui.setStatus("harvest", undefined);
    try {
      const config = loadJournalConfig();
      const meta = await loadProjectMeta(join(config.notesDir, basename(ctx.cwd)));
      active = harvestFlag(meta?.harvest);
    } catch {
      // journal config missing — extension stays off
    }
  });

  pi.on("agent_end", async (_event, ctx) => {
    await refresh(ctx);
  });
}
