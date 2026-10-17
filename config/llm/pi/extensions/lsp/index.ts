/**
 * Pi extension adapter for the LSP engine.
 *
 * All harness-agnostic logic lives in the engine modules (state, client-mgmt,
 * file-events, diagnostics, hooks, status, actions) — this file only wires
 * that engine to pi: session events, tool/command registration, UI
 * notifications, and footer status rendering. Another harness would reuse the
 * engine modules with its own adapter; the engine returns plain text, so a
 * harness that wants HTML (or another format) renders the same data itself.
 *
 * Commands: /lsp (status), /lsp-dedup, /lsp-restart
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { runAction } from "./actions";
import { restartWithRedetect } from "./client-mgmt";
import { startSession, stopSession } from "./file-events";
import { handleToolCall, postBashResult, postEditResult } from "./hooks";
import { createState, LSP_ACTIONS, type PostToolResult } from "./state";
import { statusReport, toggleDedup } from "./status";

export default function (pi: ExtensionAPI) {
  // The current session's UI context, captured at session_start. Engine host
  // callbacks fire through it; null (no session) makes them no-ops.
  let sessionCtx: ExtensionContext | null = null;

  const state = createState({
    notify: (message, type) => sessionCtx?.ui.notify(message, type),
    // The engine pushes status FACTS (progress entries, running servers); the
    // pill shape (key, `lsp:` label, colors, cap) is pi's — keep it here so
    // another harness can render the same facts its own way.
    setStatus: (data) => {
      const ui = sessionCtx?.ui;
      if (!ui) return;
      if (data.progress.length > 0) {
        const parts = data.progress.map(
          (p) => `${p.server} ${p.title}${p.percentage !== undefined ? ` ${p.percentage}%` : ""}`,
        );
        ui.setStatus("lsp", ui.theme.fg("accent", `lsp:${parts.join(", ")}`));
        return;
      }
      if (data.running.length === 0) {
        ui.setStatus("lsp", undefined);
        return;
      }
      const MAX_FOOTER_SERVERS = 4;
      const shown = data.running.slice(0, MAX_FOOTER_SERVERS).join(",");
      const more = data.running.length > MAX_FOOTER_SERVERS ? `,+${data.running.length - MAX_FOOTER_SERVERS}` : "";
      ui.setStatus("lsp", ui.theme.fg("muted", `lsp:${shown}${more}`));
    },
  });

  // ── Session lifecycle ──

  pi.on("session_start", async (_event, ctx) => {
    sessionCtx = ctx;
    startSession(state, ctx.cwd);
  });

  pi.on("session_shutdown", async () => {
    sessionCtx = null;
    await stopSession(state);
  });

  // ── tool_call: read-time warming + pre-edit capture ──

  pi.on("tool_call", (event, ctx) => {
    handleToolCall(state, event.toolName, event.input, ctx.cwd);
  });

  // ── Auto-diagnostics on edit/write and after bash ──

  pi.on("tool_result", async (event, ctx) => {
    const result: PostToolResult | null =
      event.toolName === "bash"
        ? await postBashResult(state, ctx.cwd)
        : await postEditResult(state, event.toolName, event.input, ctx.cwd, event.isError);
    if (!result) return;

    // Notify the user in the UI about actual issues (clean results stay silent).
    if (result.notify) {
      ctx.ui.notify(result.notify, result.errored ? "error" : "warning");
    }

    const existingText = event.content[0]?.type === "text" ? event.content[0].text : "";
    return {
      content: [{ type: "text" as const, text: existingText + result.appended }],
    };
  });

  // ── LSP tool ──

  pi.registerTool({
    name: "lsp",
    label: "LSP",
    description: `Language Server Protocol operations. Actions: ${LSP_ACTIONS.join(", ")}. Requires a running language server for the target file's language.`,
    promptSnippet: `lsp: Language server operations (diagnostics, definition, type_definition, references, incoming, outgoing, hover, symbols, workspace_symbol, rename, codeAction, codeActionApply, restart, status). Use for type errors, go-to-definition, finding references, and refactorings.`,
    promptGuidelines: [
      "Before `read`ing a large source file (Rust, TS/JS, C#, Go, and other languages with a capable LSP server), use `lsp` with action `symbols` first. It returns a compact skeleton — top-level functions, structs/classes/interfaces with their fields, and line ranges — so you can `read` with `offset`/`limit` for just the symbol you need instead of the whole file. Useless for you on languages with weak servers (nixd, bash-language-server); fall back to `read` there. If a symbols call reports the server is still indexing, retry it immediately or use `read` directly.",
      "LSP diagnostics and lint results are automatically checked after file edits and reported in the tool result. Call `lsp diagnostics` explicitly for fresh diagnostics after a change made another way (e.g., a bash command).",
      "Use `lsp` with action `definition` or `references` to navigate code instead of grepping for definitions.",
      "Use `lsp` with action `rename` to rename symbols across files instead of rg+sed/sd. It's semantically aware and handles all references. Provide `symbol` and `new_name`.",
      "Use `lsp` with action `references` or `incoming` to find who uses/ calls a symbol; `outgoing` shows what it calls. `incoming`/`outgoing` use call hierarchy (nearest callable definition), useful for blast-radius before a refactor.",
      "The `hover` action shows type information for a symbol at a given position.",
      "Always provide `file` for all actions except `status`, `workspace_symbol`, and `restart`.",
      "Use `line` and optionally `symbol` to target a specific position. When `symbol` is provided without `line`, the tool searches the file for the symbol — this is often more reliable for go-to-definition since it uses semantic resolution.",
      "Use `lsp` with action `codeAction` to list refactorings available at a position. Then use `codeActionApply` with the action index to execute it.",
      "Use `lsp` with action `workspace_symbol` to search for symbols across the entire project by name. Provide `query` (substring match, case-insensitive). Works across all active LSP servers. Useful for finding function/type definitions when you know the name but not the file.",
      "Use `lsp` with action `restart` to restart language servers. Without `file`, restarts all servers. With `file`, restarts only the server for that file's project. Use when a server is stuck, dead, or giving stale results.",
    ],
    parameters: Type.Object({
      action: StringEnum([...LSP_ACTIONS]),
      file: Type.Optional(Type.String({ description: "File path (relative to cwd)" })),
      line: Type.Optional(Type.Number({ description: "Line number (1-indexed)" })),
      symbol: Type.Optional(Type.String({ description: "Symbol name at the line (for precise column resolution)" })),
      occurrence: Type.Optional(
        Type.Number({ description: "Which occurrence of symbol on the line (1-indexed, default 1)" }),
      ),
      new_name: Type.Optional(Type.String({ description: "New name for rename action" })),
      query: Type.Optional(
        Type.String({ description: "Search query for workspace_symbol action (substring match, case-insensitive)" }),
      ),
      index: Type.Optional(Type.Number({ description: "Index of the code action to apply (from codeAction listing)" })),
      name: Type.Optional(
        Type.String({
          description:
            "For codeActionApply: apply the action whose title contains this substring (case-insensitive) instead of by index",
        }),
      ),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      return text(await runAction(state, params, ctx.cwd));
    },

    renderCall(args, theme) {
      const action = theme.fg("accent", theme.bold(String(args.action ?? "")));
      const label = theme.fg("toolTitle", theme.bold("lsp "));
      const file = args.file ? ` ${theme.fg("muted", String(args.file))}` : "";
      const line = args.line ? theme.fg("muted", `:${args.line}`) : "";
      const sym = args.symbol ? ` ${theme.fg("dim", String(args.symbol))}` : "";
      const rename = args.new_name ? ` ${theme.fg("muted", "→")} ${theme.fg("accent", String(args.new_name))}` : "";
      const query = args.query ? ` "${theme.fg("accent", String(args.query))}"` : "";
      const idx = args.index !== undefined ? ` [${args.index}]` : "";
      return new Text(`${label}${action}${file}${line}${sym}${rename}${query}${idx}`, 0, 0);
    },

    renderResult(result, { expanded }, theme) {
      const content = result.content[0];
      const body = content?.type === "text" ? content.text : "";

      if (!expanded) {
        // Show first line only
        const firstLine = body.split("\n")[0] ?? "";
        return new Text(theme.fg("muted", firstLine), 0, 0);
      }

      return new Text(body, 0, 0);
    },
  });

  // ── Commands ──

  pi.registerCommand("lsp", {
    description: "Show LSP server and linter status",
    handler: async (_args, ctx) => {
      const report = statusReport(state);
      ctx.ui.notify(report ?? "No language servers or linters detected for this project", report ? "info" : "warning");
    },
  });

  pi.registerCommand("lsp-dedup", {
    description: "Toggle collapsing of unchanged diagnostics in post-edit blocks",
    handler: async (_args, ctx) => {
      ctx.ui.notify(toggleDedup(state), "info");
    },
  });

  pi.registerCommand("lsp-restart", {
    description: "Restart all LSP servers and re-detect linters",
    handler: async (_args, ctx) => {
      const names = await restartWithRedetect(state, ctx.cwd);
      if (names.length === 0) {
        ctx.ui.notify("No language servers or linters detected after restart", "warning");
      } else {
        ctx.ui.notify(`Restarted: ${names.join(", ")}`, "info");
      }
    },
  });
}

function text(t: string) {
  return { content: [{ type: "text" as const, text: t }], details: undefined };
}
