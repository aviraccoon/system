/**
 * Web Search Extension
 *
 * Registers `web_search` and `web_fetch` tools.
 *
 * Search providers (kagi, tavily, claude) are sourced entirely from the MCP
 * provider registry — adding/swapping one is a one-line change in
 * providers/registry.ts, picked up here automatically. This file only holds
 * pi-specific orchestration: fallback-on-auth-failure, status pill, commands.
 *
 * Provider clients + adapters are canonical in config/llm/mcp/web-search/providers/
 * and reached via the `web-search-core` bridge symlink.
 *
 * web_fetch: Fetches and extracts page content via agent-browser CLI (headless Chrome daemon).
 *
 * Commands: /search <query>, /fetch <url>, /fetch-headed
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { formatHits } from "../web-search-core/format";
import { availableProviders, providerLabel, resolveProvider } from "../web-search-core/registry";
import type { SearchFilters, SearchProvider } from "../web-search-core/types";
import { feedHints } from "./feeds/registry";
import { closeSession, FetchError, fetchPage, sessionName, spillToTmp, truncateContent } from "./web-fetch";

function elapsed(start: number): string {
  return `${((performance.now() - start) / 1000).toFixed(1)}s`;
}

/** Pointer note for oversized fetches: full content spilled to temp, readable via offset/limit. */
async function spillNote(url: string, content: string): Promise<string> {
  const p = await spillToTmp(url, content);
  if (!p) return "";
  const kb = Math.max(1, Math.round(content.length / 1024));
  return `\n\n[Full content (${content.length} chars, ${kb} KB) saved to ${p} — use read with offset/limit]`;
}

interface SearchResult {
  text: string;
  details: Record<string, unknown>;
}

interface SearchOpts {
  limit?: number;
  signal?: AbortSignal;
  filters?: SearchFilters;
  extractCount?: number;
}

export default function (pi: ExtensionAPI) {
  // Active provider, resolved at session_start. Falls back on auth failure.
  let activeProvider: SearchProvider | null = null;

  async function runProviderSearch(provider: SearchProvider, query: string, opts: SearchOpts): Promise<SearchResult> {
    const start = performance.now();
    try {
      const res = await provider.search(query, opts);
      return {
        text: formatHits(res.hits, res.relatedQuestions),
        details: {
          provider: provider.name,
          resultCount: res.hits.length,
          hasRelated: !!res.relatedQuestions?.length,
          extracted: res.extracted,
          elapsed: elapsed(start),
        },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        text: `Search failed: ${msg}`,
        details: { provider: provider.name, error: msg, elapsed: elapsed(start) },
      };
    }
  }

  async function doSearch(query: string, opts: SearchOpts, forceName?: string): Promise<SearchResult> {
    if (forceName) {
      const forced = resolveProvider(forceName);
      if (forced) return runProviderSearch(forced, query, opts);
      return {
        text: `Provider '${forceName}' not available. Forceable: ${availableProviders()
          .map((p) => p.name)
          .join(", ")}`,
        details: { provider: forceName, error: "unavailable" },
      };
    }

    if (activeProvider) {
      const current = activeProvider;
      const result = await runProviderSearch(current, query, opts);
      // On auth failure, switch to the next available provider for the session.
      const errMsg = (result.details as { error?: string }).error;
      if (errMsg && (errMsg.includes("401") || errMsg.includes("403"))) {
        const fallback = availableProviders().find((p) => p.name !== current.name);
        if (fallback) {
          activeProvider = fallback;
          return runProviderSearch(fallback, query, opts);
        }
      }
      return result;
    }

    return { text: "No search providers available.", details: { error: "no providers" } };
  }

  const providerList = () =>
    availableProviders()
      .map((p) => p.name)
      .join("|");

  pi.registerTool({
    name: "web_search",
    label: "Web Search",
    description: "Search the web. Returns titles, URLs, and snippets for each result.",
    promptSnippet: `web_search: Search the web. Parameters: query (required), limit (default 10, max 40), provider (${providerList()}), freshness ('day'|'week'|'month'|'year'), includeDomains/excludeDomains (string[]), extractCount (0-10, inline full page content — provider-dependent).`,
    promptGuidelines: [
      "Use web_search when you need current information, documentation, or facts you're uncertain about.",
      "Prefer specific, focused queries over broad ones.",
      "freshness/includeDomains narrow results (e.g. recent docs, a specific site). excludeDomains support varies by provider.",
      "extractCount fetches full page content for the top N results inline — useful when you'd otherwise web_fetch several of them. Not all providers support this.",
      "When search results reference a page that likely has the answer, use web_fetch to read the full page.",
      "For complex browser interactions beyond simple page reading, use bash with agent-browser CLI directly (e.g., agent-browser open <url> && agent-browser snapshot -i).",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "Search query" }),
      limit: Type.Optional(Type.Number({ description: "Max results (default 10, max 40)" })),
      provider: Type.Optional(Type.String({ description: `Force a provider: ${providerList()}` })),
      freshness: Type.Optional(
        Type.Union([Type.Literal("day"), Type.Literal("week"), Type.Literal("month"), Type.Literal("year")], {
          description: "Restrict to results published/updated within this window",
        }),
      ),
      includeDomains: Type.Optional(
        Type.Array(Type.String(), { description: "Restrict to these domains (whitelist)" }),
      ),
      excludeDomains: Type.Optional(Type.Array(Type.String(), { description: "Exclude these domains" })),
      extractCount: Type.Optional(
        Type.Number({
          description:
            "Fetch full page content for the top N results inline (0-10). Incurs extraction cost. Provider-dependent.",
        }),
      ),
    }),

    async execute(_toolCallId, params, signal) {
      const forced = typeof params.provider === "string" ? params.provider : undefined;
      const filters: SearchFilters | undefined =
        params.freshness || params.includeDomains || params.excludeDomains
          ? {
              freshness: params.freshness as SearchFilters["freshness"],
              includeDomains: params.includeDomains,
              excludeDomains: params.excludeDomains,
            }
          : undefined;
      const { text, details } = await doSearch(
        params.query,
        { limit: params.limit, signal, filters, extractCount: params.extractCount },
        forced,
      );
      return { content: [{ type: "text", text }], details };
    },

    renderCall(args, theme) {
      const query = theme.fg("accent", theme.bold(`"${args.query}"`));
      const label = theme.fg("toolTitle", theme.bold("web_search "));
      const limit = args.limit ? theme.fg("muted", ` (limit: ${args.limit})`) : "";
      return new Text(`${label}${query}${limit}`, 0, 0);
    },

    renderResult(result, { expanded }, theme) {
      const details = result.details as { resultCount?: number; error?: string; provider?: string } | undefined;

      if (details?.error) {
        return new Text(theme.fg("error", `Error: ${details.error}`), 0, 0);
      }

      const count = details?.resultCount ?? 0;
      const prov = details?.provider ?? "unknown";
      const time = (details as { elapsed?: string } | undefined)?.elapsed;
      const timeSuffix = time ? ` in ${time}` : "";
      const summary = theme.fg("muted", `${count} result${count !== 1 ? "s" : ""} (${prov}${timeSuffix})`);

      if (!expanded) {
        return new Text(summary, 0, 0);
      }

      const text = result.content[0];
      const body = text?.type === "text" ? text.text : "";
      return new Text(`${summary}\n${theme.fg("dim", body)}`, 0, 0);
    },
  });

  // ── web_fetch tool ──

  let fetchHeaded = false;

  pi.registerTool({
    name: "web_fetch",
    label: "Web Fetch",
    description:
      "Fetch a web page and extract its text content. Uses a headless browser that handles JavaScript rendering and bot detection. Use after web_search to read a specific result page. For complex interactions (clicking, filling forms, screenshots), use bash with `agent-browser` CLI directly.\n\n" +
      `Structured feeds (fetched as clean markdown, no page chrome):\n${feedHints()}`,
    promptSnippet: "web_fetch: Fetch a web page and extract its text content. Parameters: url (string, required)",
    promptGuidelines: [
      "Use web_fetch to read pages found via web_search. It handles JS-rendered pages and bot detection.",
      "For interactive browser tasks (login, click, fill, screenshot), use `agent-browser` CLI via bash instead. The browser session is shared -- after web_fetch opens a page, you can run `agent-browser --session <session> snapshot -i` to inspect interactive elements, then click/fill/type as needed.",
    ],
    parameters: Type.Object({
      url: Type.String({ description: "URL to fetch" }),
    }),

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      try {
        const result = await fetchPage(params.url, {
          cwd: ctx.cwd,
          headed: fetchHeaded,
          signal: signal ?? undefined,
        });

        const { text, truncated } = truncateContent(result.content, 100_000);
        // Feed results render their own title header; prepend only for scrapes.
        const titleLine = result.title && !result.content.startsWith("# ") ? `# ${result.title}\n\n` : "";
        const redirectNote = result.url !== params.url ? `[Redirected to: ${result.url}]\n\n` : "";
        const spill = truncated ? await spillNote(result.url, result.content) : "";
        const session = sessionName(ctx.cwd);
        const sessionNote = `\n\n[Browser session: ${session} -- use \`agent-browser --session ${session}\` for further interaction]`;

        return {
          content: [{ type: "text", text: `${titleLine}${redirectNote}${text}${spill}${sessionNote}` }],
          details: {
            url: result.url,
            requestedUrl: params.url,
            title: result.title,
            truncated,
            charCount: result.content.length,
            session,
          },
        };
      } catch (err) {
        if (err instanceof FetchError) {
          return {
            content: [{ type: "text", text: `Fetch failed: ${err.message}` }],
            details: { url: params.url, error: err.message },
          };
        }
        throw err;
      }
    },

    renderCall(args, theme) {
      const url = theme.fg("accent", args.url);
      const label = theme.fg("toolTitle", theme.bold("web_fetch "));
      return new Text(`${label}${url}`, 0, 0);
    },

    renderResult(result, { expanded }, theme) {
      const details = result.details as
        | { title?: string; charCount?: number; error?: string; truncated?: boolean }
        | undefined;

      if (details?.error) {
        return new Text(theme.fg("error", `Error: ${details.error}`), 0, 0);
      }

      const title = details?.title || "(untitled)";
      const chars = details?.charCount ?? 0;
      const trunc = details?.truncated ? " (truncated)" : "";
      const summary = theme.fg("muted", `${title} \u2014 ${chars} chars${trunc}`);

      if (!expanded) {
        return new Text(summary, 0, 0);
      }

      const text = result.content[0];
      const body = text?.type === "text" ? text.text : "";
      const preview = body.length > 500 ? `${body.slice(0, 500)}...` : body;
      return new Text(`${summary}\n${theme.fg("dim", preview)}`, 0, 0);
    },
  });

  // ── Commands ──

  pi.registerCommand("fetch", {
    description: "Fetch a web page (usage: /fetch <url>)",
    handler: async (args, ctx) => {
      const url = args.trim();
      if (!url) {
        ctx.ui.notify("Usage: /fetch <url>", "warning");
        return;
      }
      ctx.ui.notify(`Fetching: ${url}`, "info");
      try {
        const start = performance.now();
        const result = await fetchPage(url, { cwd: ctx.cwd, headed: fetchHeaded });
        const time = elapsed(start);
        const { text, truncated } = truncateContent(result.content, 100_000);
        // Feed results render their own title header; prepend only for scrapes.
        const titleLine = result.title && !result.content.startsWith("# ") ? `# ${result.title}\n\n` : "";
        const spill = truncated ? await spillNote(url, result.content) : "";
        pi.sendUserMessage(`[/fetch ${url} (${time})]\n\n${titleLine}${text}${spill}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.ui.notify(`Fetch failed: ${msg}`, "error");
      }
    },
  });

  pi.registerCommand("fetch-headed", {
    description: "Toggle headed (visible) browser mode for web_fetch",
    handler: async (_args, ctx) => {
      fetchHeaded = !fetchHeaded;
      ctx.ui.notify(`Browser mode: ${fetchHeaded ? "headed (visible)" : "headless"}`, "info");
    },
  });

  pi.registerCommand("search", {
    description: `Search the web (usage: /search [${providerList()}] <query>)`,
    getArgumentCompletions: (prefix) => {
      const names = availableProviders()
        .map((p) => p.name)
        .filter((n) => n.startsWith(prefix));
      return names.length > 0 ? names.map((n) => ({ value: `${n} `, label: n })) : null;
    },
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      if (!trimmed) {
        ctx.ui.notify(`Usage: /search [${providerList()}] <query>`, "warning");
        return;
      }

      // Check if first word is a provider name
      let forceProvider: string | undefined;
      let query = trimmed;
      const firstSpace = trimmed.indexOf(" ");
      if (firstSpace > 0) {
        const firstWord = trimmed.slice(0, firstSpace);
        if (availableProviders().some((p) => p.name === firstWord)) {
          forceProvider = firstWord;
          query = trimmed.slice(firstSpace + 1).trim();
        }
      }

      if (!query) {
        ctx.ui.notify(`Usage: /search [${providerList()}] <query>`, "warning");
        return;
      }

      const provLabel = forceProvider
        ? providerLabel(resolveProvider(forceProvider) ?? availableProviders()[0])
        : activeProvider
          ? providerLabel(activeProvider)
          : "unknown";
      ctx.ui.notify(`Searching (${provLabel}): ${query}`, "info");
      try {
        const { text, details } = await doSearch(query, { limit: 10 }, forceProvider);
        const time = (details as { elapsed?: string }).elapsed;
        const timeSuffix = time ? ` (${time})` : "";
        pi.sendUserMessage(`[/search${forceProvider ? ` ${forceProvider}` : ""} ${query}${timeSuffix}]\n\n${text}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.ui.notify(`Search failed: ${msg}`, "error");
      }
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    activeProvider = availableProviders()[0] ?? null;

    if (!activeProvider) {
      ctx.ui.notify("Web search: no providers available.", "warning");
    } else {
      ctx.ui.setStatus("web-search", ctx.ui.theme.fg("muted", `search:${activeProvider.name}`));
    }
  });

  // Clean up browser session on shutdown
  pi.on("session_shutdown", async (_event, ctx) => {
    await closeSession(ctx.cwd);
  });
}
