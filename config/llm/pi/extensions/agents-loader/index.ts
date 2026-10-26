/**
 * AGENTS.md / AGENTS.local.md loader extension
 *
 * Loads agent instruction files that pi doesn't handle natively:
 *
 * 1. **Startup**: AGENTS.local.md (and CLAUDE.local.md) from cwd and
 *    parent directories. Injected via before_agent_start on first prompt.
 *
 * 2. **Tool access**: When read/write/edit/ls/find/grep tools touch files
 *    in subdirectories, discovers AGENTS.md and AGENTS.local.md in the
 *    directory chain up to cwd. Appended to tool_result.
 *
 * 3. **@ mentions**: When user types @path references in their prompt,
 *    discovers agents files in the directory chain for those paths.
 *    Injected as a hidden message via before_agent_start.
 *
 * Deduplicates by realpath so symlinks (CLAUDE.local.md -> AGENTS.local.md)
 * don't cause double-loading. Each file loaded at most once per session.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { extractAtMentions } from "../shared/at-mentions";
import { declaredInstructionsWarning, projectInstructions } from "../shared/extra-instructions";
import { journalNotesDir, loadProjectMeta, projectFor } from "../shared/journal-context";
import { type DiscoveredFile, discoverAgentsFiles, discoverStartupLocalFiles, extractPaths } from "./loader.js";

export default function agentsLoaderExtension(pi: ExtensionAPI) {
  let loadedRealpaths = new Set<string>();
  let cwd = "";
  let startupContext = "";
  let startupInjected = false;
  let pendingAtContext = "";

  /** Load startup context; returns what to tell the user. */
  async function init(newCwd: string): Promise<string[]> {
    cwd = newCwd;
    loadedRealpaths = new Set();
    startupInjected = false;
    pendingAtContext = "";

    const parts: string[] = [];
    const notices: string[] = [];

    // Subagent children are the one place the journal extension does not run, so
    // the project's subagent-scoped instructions load here instead.
    if (process.env.PI_SUBAGENT === "1") {
      const { dir: projectDir } = projectFor(journalNotesDir(), cwd);
      const meta = await loadProjectMeta(projectDir);
      const warning = declaredInstructionsWarning(meta, projectDir);
      const declared = projectInstructions(meta?.instructions, "subagent", projectDir);
      if (warning) parts.push(warning);
      if (declared) {
        parts.push(declared);
        notices.push("Loaded project instructions");
      }
    }

    const localFiles = discoverStartupLocalFiles(cwd, loadedRealpaths);
    if (localFiles.length > 0) {
      parts.push(localFiles.map((f) => `<file name="${f.relativePath}">\n${f.content}\n</file>`).join("\n\n"));
      notices.push("Loaded AGENTS.local.md");
    }

    startupContext = parts.join("\n\n");
    return notices;
  }

  pi.on("session_start", async (_event, ctx) => {
    for (const notice of await init(ctx.cwd)) ctx.ui.notify(notice, "info");
  });

  // Discover agents files from @path mentions
  pi.on("input", async (event, ctx) => {
    if (!cwd) return { action: "continue" as const };

    const mentions = extractAtMentions(event.text);
    if (mentions.length === 0) return { action: "continue" as const };

    const parts: string[] = [];
    for (const mention of mentions) {
      const discovered = discoverAgentsFiles(mention, cwd, loadedRealpaths, true);
      const discoveredFile = discoverAgentsFiles(mention, cwd, loadedRealpaths, false);
      for (const f of [...discovered, ...discoveredFile]) {
        parts.push(`<file name="${f.relativePath}">\n${f.content}\n</file>`);
      }
    }

    if (parts.length > 0) {
      pendingAtContext = parts.join("\n\n");
      const names = parts.map((p) => p.match(/name="([^"]+)"/)?.[1]).filter(Boolean);
      ctx.ui.notify(`Loaded ${names.join(", ")}`, "info");
    }

    return { action: "continue" as const };
  });

  // Inject .local.md content and @-mention agents context
  pi.on("before_agent_start", async () => {
    const parts: string[] = [];

    if (!startupInjected && startupContext) {
      parts.push(startupContext);
    }
    startupInjected = true;

    if (pendingAtContext) {
      parts.push(pendingAtContext);
      pendingAtContext = "";
    }

    if (parts.length === 0) return;

    return {
      message: {
        customType: "agents-local",
        content: parts.join("\n\n"),
        display: false,
      },
    };
  });

  // Discover agents files in subdirectories on file access
  pi.on("tool_result", async (event, ctx) => {
    const extracted = extractPaths(event.toolName, event.input as Record<string, unknown>);
    if (extracted.length === 0 || !cwd) return;

    let discovered: DiscoveredFile[] = [];
    for (const ext of extracted) {
      discovered = discovered.concat(discoverAgentsFiles(ext.path, cwd, loadedRealpaths, ext.isDirectory));
    }
    if (discovered.length === 0) return;

    const names = discovered.map((f) => f.relativePath).join(", ");
    ctx.ui.notify(`Loaded ${names}`, "info");

    const injection = discovered.map((f) => `\n\n<file name="${f.relativePath}">\n${f.content}\n</file>`).join("");

    const existingText = event.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("\n");

    return {
      content: [{ type: "text" as const, text: existingText + injection }],
    };
  });
}
