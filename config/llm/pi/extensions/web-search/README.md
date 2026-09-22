# web-search

Web search and page fetching tools.

## Tools

### web_search

Search the web. Returns titles, URLs, and snippets.

Providers are sourced from the MCP provider registry — see the MCP web-search
README for how to add/swap one. Tried in priority order; first available wins.

Parameters: `query` (required), `limit` (optional, default 10, max 40), `provider` (any registered provider name), `freshness` (`'day'` | `'week'` | `'month'` | `'year'`), `includeDomains` / `excludeDomains` (string[]), `extractCount` (0-10, inline full page content — provider-dependent).

Results include timing info (elapsed seconds).

| Provider | Speed | Auth | Notes |
|----------|-------|------|-------|
| `kagi` | ~1-2s | `/run/secrets/kagi_api_key` (sops-nix) | $12/1k requests, pay-per-use. Supports all filters + extractCount. |
| `tavily` | ~1-2s | `/run/secrets/tavily_api_key` (sops-nix) | 1,000 free credits/mo. Supports all filters. |
| `claude` | ~13-20s | Claude Code CLI (`claude -p`) | Slow last resort. Needs CLI + auth. |

Default chain: kagi (primary), tavily (fallback on 401/403), claude (last resort).

### web_fetch

Fetch a web page and extract its text content.

**Structured-data fast path:** before spinning up a browser, tries sites that publish a structured feed/API (e.g. Reddit, GitHub). These return clean data with no page chrome. See `feeds/` for providers; adding one is a single file in `feeds/`. Falls back to browser rendering otherwise. Capability discovery: every provider declares a required one-line `hint` folded into the web_fetch tool description at registration, and feed renders advertise follow-up fetch paths so agents can chain requests.

**Browser rendering:** uses `agent-browser` (headless Chrome daemon), which handles JavaScript rendering and bot detection. Renders HTML to **markdown via pandoc** (with table support), falling back to plain text. Uses agent-browser's **real User-Agent** (cached on first fetch) to clear edge/WAF bot checks.

After `web_fetch` opens a page, the browser session persists. The LLM can use `agent-browser` directly via bash for complex interactions:

```bash
# Inspect interactive elements on the page web_fetch just opened
agent-browser --session pi-fetch-<project> snapshot -i

# Click, fill, screenshot, etc.
agent-browser --session pi-fetch-<project> click @e3
agent-browser --session pi-fetch-<project> screenshot page.png
```

Session name is `pi-fetch-<project-basename>`, isolated per project. Subagents
get an ephemeral per-process session (`pi-fetch-<project>-p<pid>`) that the
child closes on exit. Children fetch with a cold session — they do not
inherit the parent's cookies.

## Commands

| Command | Description |
|---------|-------------|
| `/search [provider] <query>` | Search the web (results injected into conversation via sendUserMessage) |
| `/fetch <url>` | Fetch a page (content injected into conversation via sendUserMessage) |
| `/fetch-headed` | Toggle visible browser mode (for debugging bot detection) |

## Architecture

Provider clients + adapters + the registry are **canonical in the MCP tree** (`config/llm/mcp/web-search/providers/`). Pi imports them via the `web-search-core` bridge symlink and sources all providers generically from the registry — no per-provider branching in this file. Only orchestration (fallback, status, commands) is pi-specific.

- `../web-search-core/` (bridge symlink) -- canonical provider clients, registry, types, formatting. Lives in the MCP tree (`config/llm/mcp/web-search/providers/`).
- `web-fetch.ts` -- agent-browser CLI wrapper. Session management, content extraction, pandoc markdown conversion, stealth UA handling.
- `feeds/` -- structured-feed providers (registry + per-site clients) for the web_fetch fast path.
- `web-fetch.test.ts` -- Tests for session naming, ANSI stripping, truncation.
- `index.ts` -- Pi extension. Generic provider resolution via the registry, tool + command registration.

## Sandbox compatibility

Both search providers and web_fetch make network requests from the extension's Node process (or child CLI processes), not via the LLM's bash tool. A future sandbox would not affect them. The Kagi secret at `/run/secrets/` would also be invisible to sandboxed bash.

Note: if the LLM uses `agent-browser` directly via bash, those calls *would* go through the sandbox. The `agent-browser` binary and `kagi.com` / other domains would need to be in the sandbox allowlist.
