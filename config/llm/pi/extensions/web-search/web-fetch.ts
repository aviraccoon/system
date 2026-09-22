/**
 * Web page fetcher via agent-browser CLI.
 * Pure module — no pi imports, testable independently.
 *
 * Uses a persistent browser session (daemon model) for fast repeated fetches.
 * Session is named per-project to avoid collisions.
 */

import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { USER_AGENT } from "./feeds/http";
import { tryFeed } from "./feeds/registry";
import type { FeedContext, HttpFetchOptions } from "./feeds/types";

export interface FetchResult {
  url: string;
  title: string;
  content: string;
}

const IDLE_TIMEOUT_MS = 30 * 60 * 1000;
let idleTimer: ReturnType<typeof setTimeout> | null = null;

// Serialize fetches to prevent concurrent navigations from clobbering each other.
// All fetches share one tab; the mutex ensures only one runs at a time.
let fetchQueue: Promise<void> = Promise.resolve();

export class FetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FetchError";
  }
}

// ── Stealth headers ──
//
// agent-browser ships Chrome for Testing with `HeadlessChrome/...` in the UA,
// which tier-1 edge/WAFs (Reddit, StackOverflow) block on sight. A realistic
// `Chrome/...` User-Agent header clears those server-side checks. This does
// NOT defeat client-side fingerprinting (Cloudflare Turnstile/WAF, DataDome):
// those read CDP artifacts no header can hide.

/**
 * Swap the HeadlessChrome token for Chrome, keeping the exact version the
 * browser reports. No-op if the UA already looks like real Chrome (e.g.
 * `--headed` mode reports `Chrome/...` directly). Reading + spoofing the real
 * UA means we auto-track agent-browser's bundled Chrome bumps with zero
 * maintenance, and the version always lines up with the real JS engine.
 */
export function spoofUserAgent(rawUa: string): string {
  return rawUa.replace("HeadlessChrome", "Chrome");
}

/** Build the navigation-headers JSON string for a given User-Agent. */
export function buildNavHeaders(userAgent: string): string {
  return JSON.stringify({
    "User-Agent": userAgent,
    "Accept-Language": "en-US,en;q=0.9",
  });
}

/** Fallback headers (used if the dynamic UA probe fails). */
export const NAV_HEADERS = buildNavHeaders(USER_AGENT);

/** Parse agent-browser `eval` stdout (a JSON-quoted string) into the raw value. */
export function parseEvalString(stdout: string): string {
  const trimmed = stripAnsi(stdout).trim();
  if (trimmed.startsWith('"')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed === "string") return parsed;
    } catch {
      // fall through to quote-strip
    }
  }
  return trimmed.replace(/^["']|["']$/g, "");
}

/**
 * Resolved navigation headers, cached for the process lifetime. One bundled
 * Chrome → one UA, so a single global cache is correct across sessions/modes.
 */
let resolvedHeaders: string | null = null;

/**
 * Resolve navigation headers, preferring the browser's real (spoofed)
 * User-Agent over the fallback constant. Reads `navigator.userAgent` once via
 * an about:blank probe (~0.65s on first fetch), then caches. On any failure
 * falls back to NAV_HEADERS so fetch still works. Caller (fetchPageInner) runs
 * inside the fetch mutex, so the cache write is race-free.
 */
async function resolveNavHeaders(baseArgs: string[], signal?: AbortSignal): Promise<string> {
  if (resolvedHeaders) return resolvedHeaders;
  try {
    await run([...baseArgs, "open", "about:blank"], { timeout: 8_000, signal });
    const result = await run([...baseArgs, "eval", "navigator.userAgent"], {
      timeout: 5_000,
      signal,
    });
    const ua = parseEvalString(result.stdout);
    if (ua.includes("Chrome")) {
      resolvedHeaders = buildNavHeaders(spoofUserAgent(ua));
      return resolvedHeaders;
    }
  } catch {
    // probe failed — fall through to constant
  }
  resolvedHeaders = NAV_HEADERS;
  return resolvedHeaders;
}

// ── Session naming ──

/**
 * Derive a session name from cwd to isolate browser state per project.
 *
 * Subagents append a per-process discriminator (`-p<pid>`): every child is a
 * full pi session whose web-search extension closes the browser on exit
 * (`session_shutdown` → `closeSession`), so sharing the project session would
 * tear it down under the parent and sibling children, and one tab shared
 * across concurrent children would interleave navigations (the fetch mutex is
 * per-process). Closing its own session on exit is therefore correct.
 */
export function sessionName(cwd: string): string {
  const base = `pi-fetch-${basename(cwd)}`;
  return process.env.PI_SUBAGENT === "1" ? `${base}-p${process.pid}` : base;
}

// ── Browser commands ──

function run(
  args: string[],
  options: { timeout?: number; signal?: AbortSignal; maxBuffer?: number } = {},
): Promise<{ stdout: string; stderr: string }> {
  const timeout = options.timeout ?? 30_000;
  const maxBuffer = options.maxBuffer ?? 5 * 1024 * 1024; // 5MB default

  return new Promise((resolve, reject) => {
    const child = execFile("agent-browser", args, { timeout, maxBuffer, env: process.env }, (error, stdout, stderr) => {
      if (error) {
        if (options.signal?.aborted) {
          reject(new FetchError("Fetch aborted"));
          return;
        }
        reject(new FetchError(`agent-browser failed: ${error.message}\n${stderr}`));
        return;
      }
      resolve({ stdout, stderr });
    });

    if (options.signal) {
      options.signal.addEventListener("abort", () => child.kill(), { once: true });
    }
  });
}

/** Strip ANSI escape codes from agent-browser output. */
export function stripAnsi(text: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape codes are control chars by definition
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

// ── Public API ──

export async function fetchPage(
  url: string,
  options: { cwd: string; headed?: boolean; signal?: AbortSignal },
): Promise<FetchResult> {
  // Serialize: chain onto the queue so only one fetch navigates at a time.
  let resolve!: () => void;
  const gate = new Promise<void>((r) => (resolve = r));
  const previous = fetchQueue;
  fetchQueue = gate;
  await previous;

  try {
    return await fetchPageInner(url, options);
  } finally {
    resolve();
  }
}

async function fetchPageInner(
  url: string,
  options: { cwd: string; headed?: boolean; signal?: AbortSignal },
): Promise<FetchResult> {
  const session = sessionName(options.cwd);
  const sessionArgs = ["--session", session];
  const headedArgs = options.headed ? ["--headed"] : [];
  const baseArgs = [...sessionArgs, ...headedArgs];

  // Structured-feed fast path: some sites publish a structured feed (JSON/API)
  // that's materially better than scraped HTML — preserves comment threading,
  // carries scores, drops page chrome. Host-injected transports keep feed
  // providers reusable across hosts. Falls through to HTML scrape if no
  // provider matches or the provider fails. See ./feeds/registry.ts.
  const feedResult = await tryFeed(url, buildFeedContext(baseArgs, options.signal));
  if (feedResult) {
    resetIdleTimer(options.cwd);
    return feedResult;
  }

  // Stealth headers: realistic UA clears edge/WAF bot checks (Reddit, SO).
  // Resolves the browser's real UA on first fetch (cached), falls back to constant.
  const navHeaders = await resolveNavHeaders(baseArgs, options.signal);

  // Navigate (safe: mutex ensures no concurrent navigation).
  await run([...baseArgs, "--headers", navHeaders, "open", url], {
    timeout: 30_000,
    signal: options.signal,
  });

  // Get title and final URL (after redirects) in parallel
  const [titleResult, urlResult] = await Promise.all([
    run([...sessionArgs, "get", "title"], { timeout: 5_000, signal: options.signal }),
    run([...sessionArgs, "get", "url"], { timeout: 5_000, signal: options.signal }),
  ]);
  const title = stripAnsi(titleResult.stdout).trim();
  const finalUrl = stripAnsi(urlResult.stdout).trim();

  // Get HTML and convert to markdown via pandoc for structured output
  // (preserves headers, code blocks, links, lists).
  // Falls back to plain text extraction if pandoc fails.
  let content: string;
  try {
    const htmlResult = await run([...sessionArgs, "get", "html", "body"], {
      timeout: 15_000,
      signal: options.signal,
    });
    content = await htmlToMarkdown(htmlResult.stdout, options.signal);
  } catch {
    const textResult = await run([...sessionArgs, "get", "text", "body"], {
      timeout: 15_000,
      signal: options.signal,
    });
    content = stripAnsi(textResult.stdout).trim();
  }

  // Reset idle timer
  resetIdleTimer(options.cwd);

  return { url: finalUrl, title, content };
}

/**
 * Build a FeedContext wired to this host's transports: httpFetch (plain HTTP
 * with the stealth UA) + browserFetch (the agent-browser session, used for
 * cookie-gated feeds). Feed providers are transport-agnostic — a future
 * forepaw host or browser-less MCP server builds its own context.
 */
function buildFeedContext(baseArgs: string[], signal?: AbortSignal): FeedContext {
  return {
    httpFetch: (target, opts) => httpFetch(target, { ...opts, signal: opts?.signal ?? signal }),
    browserFetch: async (target, s) => browserFetch(baseArgs, target, s ?? signal),
  };
}

/** Plain-HTTP fetch with the stealth User-Agent. For ungated feeds and feeds reachable without a browser session. */
async function httpFetch(url: string, opts?: HttpFetchOptions): Promise<{ status: number; text: string }> {
  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, "Accept-Language": "en-US,en;q=0.9", ...opts?.headers },
    signal: opts?.signal,
  });
  const text = await res.text();
  return { status: res.status, text };
}

/**
 * Browser-session fetch: open the URL in the agent-browser session, return the
 * final URL + body text (unquoted via parseEvalString). For cookie-gated feeds
 * (e.g. feeds behind a challenge cookie). Shares the stealth headers + mutex
 * contract of the HTML path. Runs the open under the fetch mutex via the outer
 * queue.
 */
async function browserFetch(
  baseArgs: string[],
  url: string,
  signal?: AbortSignal,
): Promise<{ url: string; text: string }> {
  const navHeaders = await resolveNavHeaders(baseArgs, signal);
  await run([...baseArgs, "--headers", navHeaders, "open", url], { timeout: 30_000, signal });
  const [urlResult, textResult] = await Promise.all([
    run([...baseArgs, "get", "url"], { timeout: 5_000, signal }),
    run([...baseArgs, "eval", "document.body.innerText"], { timeout: 8_000, signal }),
  ]);
  return { url: stripAnsi(urlResult.stdout).trim(), text: parseEvalString(textResult.stdout) };
}

/** Convert HTML to markdown via pandoc. Strips data: URI images. */
function htmlToMarkdown(html: string, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    // gfm-raw_html: GFM pipe tables (commonmark can't represent tables, and
    // with raw_html disabled it emitted a literal `[TABLE]` placeholder,
    // silently dropping every table). -raw_html keeps the no-raw-HTML-dumps intent.
    const child = spawn("pandoc", ["-f", "html", "-t", "gfm-raw_html", "--wrap=none"], {
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 15_000,
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));

    child.on("error", (err) => reject(new FetchError(`pandoc failed: ${err.message}`)));
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new FetchError(`pandoc exited ${code}: ${stderr}`));
        return;
      }
      resolve(cleanMarkdown(stdout));
    });

    if (signal) {
      signal.addEventListener("abort", () => child.kill(), { once: true });
    }

    // Unwrap layout tables before pandoc: pages that use single-row/col <table>s
    // for layout (GitHub comments, forums, emails) would otherwise render as
    // single-cell GFM tables or [TABLE] placeholders. Real data tables (>=2
    // rows AND >=2 cols) pass through untouched.
    child.stdin.write(unwrapLayoutTables(html));
    child.stdin.end();
  });
}

/**
 * Unwrap layout tables to their cell text: single-row, single-column, and
 * tables with block-level content in cells (div, lists, p, …). The latter
 * would be dropped entirely by pandoc's GFM writer ("[TABLE]" placeholder —
 * pipe-table cells can only hold inline content), so text is strictly better.
 * Element list mirrors pandoc's drop condition; inline elements (center, span)
 * render fine and must NOT be added. Operates only on <table> spans; naive
 * tag matching, no DOM parser.
 */
export function unwrapLayoutTables(html: string): string {
  return html.replace(/<table\b[^>]*>[\s\S]*?<\/table>/gi, (table) => {
    const rows = table.match(/<tr\b[^>]*>[\s\S]*?<\/tr>/gi) ?? [];
    if (rows.length < 2) return cellsAsText(table);
    const maxCols = Math.max(...rows.map((r) => (r.match(/<t[dh]\b[^>]*>/gi) ?? []).length));
    if (maxCols < 2) return cellsAsText(table);
    // Strip the table's own tags before testing: the regex includes `table` for
    // NESTED tables (genuinely unrenderable in a cell), and the outer <table>
    // tag would otherwise self-match on every call.
    const inner = table.replace(/^<table\b[^>]*>/i, "").replace(/<\/table>\s*$/i, "");
    if (BLOCK_IN_CELL_RE.test(inner)) return cellsAsText(table);
    return table;
  });
}

/** Block elements in a cell make a table unrenderable as a GFM pipe table (pandoc drops it). */
const BLOCK_IN_CELL_RE = /<(?:div|ul|ol|dl|p|pre|blockquote|table|h[1-6]|hr)\b/i;

/** Extract <td>/<th> cell text from a table, joined by newlines. */
function cellsAsText(table: string): string {
  const cells = table.match(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi) ?? [];
  return cells
    .map((c) =>
      c
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim(),
    )
    .filter(Boolean)
    .join("\n");
}

/** Clean up pandoc markdown output: strip data: URI images, collapse blank lines. */
export function cleanMarkdown(md: string): string {
  return (
    md
      // Strip image links with data: URIs (e.g. GitHub anchor SVGs)
      .replace(/!?\[(?:[^\]]*)\]\(data:[^)]+\)/g, "")
      // Strip image links wrapping other images (common GitHub pattern)
      .replace(/\[!\[(?:[^\]]*)\]\([^)]+\)\]\([^)]+\)/g, "")
      // Collapse 3+ blank lines to 2
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}

function resetIdleTimer(cwd: string): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    idleTimer = null;
    closeSession(cwd).catch(() => {});
  }, IDLE_TIMEOUT_MS);
}

/** Close the browser session for a project. */
export async function closeSession(cwd: string): Promise<void> {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  const session = sessionName(cwd);
  try {
    await run(["--session", session, "close"], { timeout: 5_000 });
  } catch {
    // Session might already be closed
  }
}

/** Truncate content to a character limit, appending a note if truncated. */
export function truncateContent(content: string, maxChars: number): { text: string; truncated: boolean } {
  if (content.length <= maxChars) {
    return { text: content, truncated: false };
  }
  return {
    text: `${content.slice(0, maxChars)}\n\n[Truncated at ${maxChars} characters]`,
    truncated: true,
  };
}

// ── Oversized-content spill ──

/** Directory for spilled full-content files, under the OS temp dir. */
const SPILL_DIR = join(tmpdir(), "pi-web-fetch");

/**
 * Deterministic, filesystem-safe filename for a fetched URL: hostname + path
 * slug + short hash of the full URL. Re-fetching the same URL overwrites the
 * same file (idempotent), different URLs never collide.
 */
export function filenameForUrl(url: string): string {
  let host = "site";
  let slug = "";
  try {
    const u = new URL(url);
    host = u.hostname.replace(/[^a-zA-Z0-9.-]/g, "");
    slug = u.pathname
      .split("/")
      .filter(Boolean)
      .join("-")
      .replace(/[^a-zA-Z0-9.-]/g, "")
      .slice(0, 60);
  } catch {
    // unparseable URL — fall back to hash-only naming
  }
  const base = `${host}${slug ? `-${slug}` : ""}` || "fetch";
  const hash = createHash("sha256").update(url).digest("hex").slice(0, 8);
  return `${base}-${hash}.md`;
}

/**
 * Write the full (untruncated) content of an oversized fetch to the OS temp
 * dir so the agent can read the remainder with offset/limit — same pattern as
 * pi's read and bash tools for large outputs. Returns the path, or null on
 * failure (spill is an enhancement; never fail the fetch because of it).
 */
export async function spillToTmp(url: string, content: string): Promise<string | null> {
  try {
    await mkdir(SPILL_DIR, { recursive: true });
    const path = `${SPILL_DIR}/${filenameForUrl(url)}`;
    await writeFile(path, content, "utf8");
    return path;
  } catch {
    return null;
  }
}
