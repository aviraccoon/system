/**
 * Reddit feed provider — fetches thread JSON and renders the full comment tree.
 *
 * Why: scraped HTML loses comment nesting (pandoc flattens it) and drops
 * collapsed/deep comments + scores. The `.json` endpoint carries the true
 * tree. Measured on an 85-comment thread: 85 comments w/ depth 0→4 + scores
 * vs ~25 flat comments, no threading, no scores from the HTML path.
 *
 * Transport: dual. httpFetch first (works on clean IPs — no browser needed,
 * serves a browser-less MCP host). browserFetch fallback for cookie-gated IPs
 * (the js_challenge cookie is set by an HTML page load; we try .json directly
 * first in case the session already holds the cookie, else warm up with the
 * HTML page). old.reddit/new.reddit/bare all normalize to www (its .json is
 * what clears).
 */

import type { FeedContext, FeedProvider, FeedResult } from "./types";

// ── URL handling ──

/** Thread URL on any reddit subdomain: /r/<sub>/comments/<id>[/<slug>]. */
const THREAD_RE = /^https?:\/\/([a-z]+\.)?reddit\.com\/r\/[^/]+\/comments\/[a-z0-9]+/i;

export function matches(url: string): boolean {
  return THREAD_RE.test(url);
}

/**
 * Normalize any reddit subdomain (old/new/bare/m) to a canonical www URL with
 * query/fragment stripped. old.reddit.com's .json is blocked, but www's clears
 * in the same session, so we always fetch from www.
 */
export function normalizeUrl(url: string): string {
  const noQuery = url.split(/[?#]/)[0];
  return noQuery.replace(/^https?:\/\/([a-z]+\.)?reddit\.com/i, "https://www.reddit.com");
}

function jsonUrlFor(url: string): string {
  return `${normalizeUrl(url).replace(/\/$/, "")}/.json?limit=500`;
}

// ── JSON shape (minimal typed view of Reddit's verbose schema) ──

interface RedditThing {
  kind: string;
  data: Record<string, unknown>;
}
interface RedditListing {
  data: { children: RedditThing[] };
}

function isJSON(text: string): boolean {
  const t = text.trimStart();
  return t.startsWith("[") || t.startsWith("{");
}

// ── Pure renderer ──

/** Render a parsed Reddit thread (the two-element [submission, comments] listing) to markdown. */
export function renderReddit(thread: RedditListing[]): string {
  const postData = thread[0]?.data?.children?.[0]?.data as Record<string, unknown> | undefined;
  const commentRoot = thread[1]?.data?.children ?? [];

  const lines: string[] = [];
  if (postData) {
    lines.push(`# ${String(postData.title ?? "(untitled)")}`, "");
    const meta = [
      `r/${postData.subreddit ?? "?"}`,
      `u/${postData.author ?? "[deleted]"}`,
      `${postData.score ?? 0} points`,
      `${postData.num_comments ?? 0} comments`,
    ];
    lines.push(meta.join(" · "), "");
    const flair = postData.link_flair_text;
    if (typeof flair === "string" && flair) lines.push(`*${flair}*`, "");
    const selftext = postData.selftext;
    if (typeof selftext === "string" && selftext.trim()) lines.push(selftext.trim(), "");
    lines.push("---", "", "## Comments", "");
  }
  for (const node of commentRoot) renderComment(node, 0, lines);
  return lines.join("\n").trim();
}

function renderComment(node: RedditThing, depth: number, lines: string[]): void {
  if (node.kind === "more") {
    const count = node.data.count;
    if (typeof count === "number" && count > 0) {
      lines.push(`${"  ".repeat(depth)}[…${count} more collapsed]`);
    }
    return;
  }
  if (node.kind !== "t1") return;

  const author = (node.data.author as string) || "[deleted]";
  const body = ((node.data.body as string) || "[no body]").trim();
  const score = node.data.score as number;
  const indent = "  ".repeat(depth);
  // Indent continuation lines so multi-line bodies stay within their bullet.
  const wrapped = body.replace(/\n/g, `\n${indent}  `);
  lines.push(`${indent}- **u/${author}** (${score} pts): ${wrapped}`);

  const replies = node.data.replies;
  if (replies && typeof replies === "object") {
    const children = (replies as RedditListing).data?.children ?? [];
    for (const child of children) renderComment(child, depth + 1, lines);
  }
}

// ── Provider ──

export const redditProvider: FeedProvider = {
  matches,
  hint: "Reddit threads (reddit.com/r/.../comments/...) render as full comment trees with scores.",
  async fetch(url, ctx: FeedContext): Promise<FeedResult> {
    const jsonUrl = jsonUrlFor(url);

    // 1. Plain HTTP — works on clean IPs, no browser. Primary path.
    if (ctx.httpFetch) {
      try {
        const r = await ctx.httpFetch(jsonUrl);
        if (r.status === 200 && isJSON(r.text)) {
          return result(url, r.text);
        }
      } catch {
        // fall through to browser
      }
    }

    // 2. Browser session — for cookie-gated IPs. Try .json directly first
    //    (a session that already holds the challenge cookie skips the warmup);
    //    if blocked, warm up with the HTML page then retry .json.
    if (ctx.browserFetch) {
      const direct = await safeBrowserJson(ctx, jsonUrl);
      if (direct) return result(url, direct);
      await ctx.browserFetch(normalizeUrl(url)); // warmup: HTML load sets the challenge cookie
      const warmed = await safeBrowserJson(ctx, jsonUrl);
      if (warmed) return result(url, warmed);
    }

    throw new Error("reddit: could not fetch thread JSON via http or browser");
  },
};

/** Fetch .json via browser; return the text only if it parses as JSON, else null. */
async function safeBrowserJson(ctx: FeedContext, jsonUrl: string): Promise<string | null> {
  if (!ctx.browserFetch) return null;
  try {
    const r = await ctx.browserFetch(jsonUrl);
    return isJSON(r.text) ? r.text : null;
  } catch {
    return null;
  }
}

function result(url: string, rawJson: string): FeedResult {
  const parsed = JSON.parse(rawJson) as RedditListing[];
  const title = (parsed[0]?.data?.children?.[0]?.data?.title as string) ?? url;
  return { url, title, content: renderReddit(parsed) };
}
