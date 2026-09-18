/**
 * Discourse feed provider — fetches topic JSON and renders the post tree.
 *
 * ALWAYS fetch forum URLs with web_fetch (topics, boards, search, listings).
 * Never curl/wget a forum or scrape it through a shell pipeline, and never ask
 * whether to use web_fetch for one — this provider is the supported path.
 *
 * Why: Discourse virtualizes its post list — beyond ~20 posts, older posts are
 * not in the DOM at all, so the HTML scrape silently loses them. The topic
 * `.json` endpoint carries every post (first 20 inline, rest via ?page=N).
 * Works on any host (Discourse self-hosts on arbitrary domains), detected by
 * the /t/<slug>/<id> URL shape.
 *
 * Auth: optional per-host key from ~/.config/llm/discourse-keys.json. No raw
 * secrets on disk — the apiKey value is a "!command" string (pi models.json
 * convention) whose stdout is the key, 1Password-backed like pi.nix:
 *   { "forum.example.com": {
 *       "apiKey": "!op --account <account> read 'op://<vault>/discourse-forum-example/api-key'",
 *       "apiUsername": "name" } }
 * Values without "!" are refused (treated as unset) so a raw key never silently
 * lands in the file. Without an entry, public forums still work (anonymous
 * .json). A login-gated forum without a key returns an actionable note instead
 * of a login-wall scrape.
 *
 * Transport: httpFetch only — no browser needed, works on browser-less hosts.
 *
 * Shapes: /t/<slug>/<id> topics, /c/<slugs>[/<id>][/l/<filter>] category listings
 * (slug-only URLs resolve via site.json), /search?q=... (Discourse search filters:
 * #category, @user, in:title, order:latest, status:...), /latest /new /unread /top
 * site-wide listings, /categories index. Renders carry /t/ paths + a search hint
 * so an agent can chain fetches without knowing the API.
 */

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { FeedContext, FeedProvider, FeedResult } from "./types";

// ── URL handling ──

/** Topic URL: /t/<slug>/<id> with optional trailing post number. */
const TOPIC_RE = /^https?:\/\/[^/]+\/t\/(?:[^/]+\/)?\d+(?:\/\d+)?/i;

/** Category URL: /c/ with slugs and/or a numeric id, optional /l/<filter>. The
 * id is optional so slug-only pastes (/c/parent/child) match too — resolved
 * against site.json at fetch time. Either branch ends in a mandatory segment
 * (digits or slug) so bare /c/ never matches. */
const CATEGORY_RE = /^https?:\/\/[^/]+\/c\/(?:(?:[a-z0-9-]+\/)*\d+|(?:[a-z0-9-]+\/)*[a-z0-9-]+)(?:\/l\/[a-z0-9-]+)?/i;

/** Search: /search with a ?q= query (q presence is checked at fetch time). */
const SEARCH_RE = /^https?:\/\/[^/]+\/search\/?$/i;

/** Site-wide category index: /categories. */
const CATEGORIES_RE = /^https?:\/\/[^/]+\/categories\/?$/i;

/** Site-wide topic listings: /latest, /new, /unread, /top[/period]. */
const SITELIST_RE = /^https?:\/\/[^/]+\/(?:latest|new|unread|top)(?:\/[a-z0-9-]+)?\/?$/i;

export function matches(url: string): boolean {
  const noQuery = url.split(/[?#]/)[0];
  return (
    TOPIC_RE.test(noQuery) ||
    CATEGORY_RE.test(noQuery) ||
    SEARCH_RE.test(noQuery) ||
    CATEGORIES_RE.test(noQuery) ||
    SITELIST_RE.test(noQuery)
  );
}

export type DiscourseKind = "topic" | "category" | "search" | "sitelist" | "categories";

/** Which Discourse view a URL points at. */
export function classify(url: string): DiscourseKind {
  const noQuery = url.split(/[?#]/)[0];
  if (SEARCH_RE.test(noQuery)) return "search";
  if (CATEGORIES_RE.test(noQuery)) return "categories";
  if (SITELIST_RE.test(noQuery)) return "sitelist";
  return CATEGORY_RE.test(noQuery) ? "category" : "topic";
}

/** Canonical topic path (/t/<slug>/<id> or /t/<id>), query/fragment/post-anchor stripped. */
export function topicPath(url: string): string {
  const noQuery = url.split(/[?#]/)[0];
  const m = noQuery.match(/^https?:\/\/[^/]+(\/t\/(?:[^/]+\/)?\d+)/i);
  return m ? m[1] : noQuery.replace(/\/+$/, "");
}

/** Canonical category path (/c/.../<id>[/l/<filter>]), query stripped. */
export function categoryPath(url: string): string {
  const noQuery = url.split(/[?#]/)[0];
  const m = noQuery.match(/^(?:https?:\/\/[^/]+)?(\/c\/(?:[a-z0-9-]+\/)*\d+(?:\/l\/[a-z0-9-]+)?)/i);
  return m ? m[1] : noQuery.replace(/\/+$/, "");
}

export function jsonUrlFor(url: string): string {
  const path = topicPath(url);
  return `https://${new URL(url).hostname}${path.endsWith("/") ? path.slice(0, -1) : path}.json`;
}

/** Parts of a category URL path: nested slugs, optional numeric id, optional
 * /l/<filter>. The trailing all-digit segment is the id (canonical Discourse
 * form ends with it). */
export interface CategoryPath {
  slugs: string[];
  id?: number;
  filter?: string;
}

export function parseCategoryPath(url: string): CategoryPath | null {
  const path = url
    .split(/[?#]/)[0]
    .replace(/^https?:\/\/[^/]+/i, "")
    .replace(/\/+$/, "");
  const m = path.match(/^\/c\/(.+)$/i);
  if (!m) return null;
  const segs = m[1].split("/").filter(Boolean);
  let filter: string | undefined;
  if (segs.length >= 2 && segs[segs.length - 2] === "l") {
    filter = segs.pop() as string;
    segs.pop();
  }
  let id: number | undefined;
  if (segs.length > 0 && /^\d+$/.test(segs[segs.length - 1])) {
    id = Number(segs.pop());
  }
  return { slugs: segs, id, filter };
}

/** Canonical listing JSON URL: /c/<slugs>/<id>[/<filter>].json, keeping listing
 * query params (order/ascending) from the original URL. */
export function categoryJsonUrl(origin: string, parts: CategoryPath, id: number, url: string): string {
  const segs = [...parts.slugs, String(id)];
  const path = `/c/${segs.join("/")}${parts.filter ? `/l/${parts.filter}` : ""}`;
  return `${origin}${path}.json?${categoryQuery(url).toString()}`;
}

/** Turn a relative more_topics_url ("/c/x/8/l/latest?page=1") into its .json form. */
export function paginationUrlFor(origin: string, moreTopicsUrl: string): string {
  const [path, query = ""] = moreTopicsUrl.split("?");
  const params = new URLSearchParams(query);
  params.set("extras", "excerpts");
  return `${origin}${path.replace(/\/+$/, "")}.json?${params.toString()}`;
}

/** Query params meaningful to a category listing that must survive the .json rewrite. */
const CATEGORY_QUERY_PARAMS = ["order", "ascending"];

function categoryQuery(url: string): URLSearchParams {
  const params = new URLSearchParams();
  for (const [k, v] of new URL(url).searchParams) {
    if (CATEGORY_QUERY_PARAMS.includes(k)) params.set(k, v);
  }
  params.set("extras", "excerpts");
  return params;
}

// ── Auth (optional, per-host) ──

interface DiscourseAuthEntry {
  /** "!command" whose stdout is the API key. Raw values are refused. */
  apiKey: string;
  apiUsername?: string;
}

const AUTH_FILE = join(homedir(), ".config", "llm", "discourse-keys.json");
let authCache: Record<string, DiscourseAuthEntry> | null | undefined;

/** Load per-host auth entries from a JSON file. Missing/malformed file → null. */
export function loadDiscourseAuth(path: string): Record<string, DiscourseAuthEntry> | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, DiscourseAuthEntry>;
  } catch {
    return null;
  }
}

/** Run a "!command" key spec and return its trimmed stdout. Null if not a
 * command spec, or the command fails — never returns the raw file value. */
export function resolveKeySpec(spec: string): string | null {
  if (!spec.startsWith("!")) return null;
  try {
    const out = execSync(spec.slice(1), { encoding: "utf8", timeout: 5000 }).trim();
    return out || null;
  } catch {
    return null;
  }
}

function authHeadersFor(url: string): Record<string, string> {
  if (authCache === undefined) authCache = loadDiscourseAuth(AUTH_FILE);
  const entry = authCache?.[new URL(url).hostname];
  if (!entry?.apiKey) return {};
  const key = resolveKeySpec(entry.apiKey);
  if (!key) return {};
  return { "User-Api-Key": key, "User-Api-Username": entry.apiUsername ?? "" };
}

// ── JSON shape ──

export interface DiscoursePost {
  post_number: number;
  username: string;
  cooked: string;
  score?: number;
  reply_to_post_number?: number | null;
  /** ISO timestamp of post creation (topic JSON always provides it). */
  created_at?: string;
  /** ISO timestamp of the last edit; differs from created_at only when edited. */
  updated_at?: string;
  /** True on the community-confirmed solution (Solved plugin), else false/absent. */
  accepted_answer?: boolean;
}

export interface DiscourseTopic {
  title: string;
  posts_count: number;
  tags?: (string | { name?: string; slug?: string })[];
  post_stream: { stream: number[]; posts: DiscoursePost[] };
}

// ── Category-list JSON shape ──

export interface CategoryTopic {
  id: number;
  title: string;
  slug: string;
  posts_count: number;
  category_id?: number;
  /** String tags (older Discourse) or tag objects (newer). */
  tags?: (string | { name?: string; slug?: string })[];
  last_posted_at?: string;
  excerpt?: string;
  pinned?: boolean;
  closed?: boolean;
}

export interface CategoryList {
  topic_list: {
    per_page?: number;
    more_topics_url?: string;
    topics: CategoryTopic[];
  };
}

export interface CategoryRef {
  id: number;
  name: string;
  slug?: string;
  subcategory_list?: CategoryRef[];
}

/** site.json category entry (superset of CategoryRef). */
export interface SiteCategory extends CategoryRef {
  parent_category_id?: number | null;
  topic_count?: number;
  position?: number;
  description_text?: string;
  description?: string;
}

/** site.json payload used for name lookups, slug→id resolution, and the tree. */
export interface SiteInfo {
  names: Map<number, string>;
  categories: SiteCategory[];
}

// ── Pure rendering ──

/** Convert Discourse cooked HTML to plain text (code blocks kept as fences). */
export function cookedToText(cooked: string): string {
  const text = cooked
    // Onebox link-preview cards → single "[title](url)" line (their div soup
    // otherwise renders as whitespace noise).
    .replace(/<aside[^>]*class="[^"]*\bonebox\b[^"]*"[^>]*>([\s\S]*?)<\/aside>/gi, (_m, inner: string) => {
      const link =
        inner.match(/<h3[^>]*>\s*<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/i) ??
        inner.match(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/i);
      if (!link) return "";
      const label = link[2].replace(/<[^>]+>/g, "").trim() || "link";
      return `<p>[${label}](${link[1]})</p>`;
    })
    // Lightbox meta ("image650×454 8.19 KB") is display chrome, not content.
    .replace(/<div[^>]*class="[^"]*\bmeta\b[^"]*"[^>]*>[\s\S]*?<\/div>/gi, "")
    // Lightbox anchors wrap content images; keep the image, drop the wrapper
    // (its href is the full-size version of the img src). Stray </a> is
    // removed by the generic tag strip below.
    .replace(/<a[^>]*class="[^"]*\blightbox\b[^"]*"[^>]*>/gi, "")
    // Images → markdown placeholders (src, alt, dimensions). Without this
    // they vanish entirely; screenshots/gifs in posts are real content.
    .replace(/<img[^>]*>/gi, (img) => {
      if (/class="[^"]*\bavatar/.test(img)) return "";
      if (/class="[^"]*\bemoji\b/.test(img)) return img.match(/\balt="([^"]*)"/)?.[1] ?? "";
      const src = img.match(/\bsrc="([^"]*)"/)?.[1];
      if (!src) return "";
      const alt = img.match(/\balt="([^"]*)"/)?.[1]?.replace(/&quot;/g, '"') || "image";
      const w = img.match(/\bwidth="(\d+)"/)?.[1];
      const h = img.match(/\bheight="(\d+)"/)?.[1];
      const dims = w && h ? `|${w}x${h}` : "";
      return `\n![${alt}${dims}](${src})\n`;
    })
    // Inline links → markdown, so hrefs survive the tag strip (oneboxes are
    // handled above; this covers normal links). Fragment-only hrefs are
    // heading anchors (Discourse <a name href="#...">) — keep just the text.
    .replace(/<a\s[^>]*?\bhref="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_m: string, href: string, inner: string) => {
      if (href.startsWith("#")) return inner;
      const label = inner.replace(/<[^>]+>/g, "").trim() || href;
      return `[${label}](${href})`;
    })
    .replace(/<pre[^>]*>\s*<code[^>]*>/gi, "\n```\n")
    .replace(/<\/code>\s*<\/pre>/gi, "\n```\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li[^>]*>/gi, "- ")
    .replace(/<\/(?:p|div|li|blockquote|h[1-6]|tr|pre)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&hellip;/g, "…")
    .replace(/&mdash;/g, "—")
    .replace(/&ndash;/g, "–");
  // Trim trailing whitespace per line; collapse whitespace-only line runs.
  return text
    .split("\n")
    .map((l) => l.replace(/\s+$/, ""))
    .reduce<string[]>((acc, l) => {
      if (l === "" && acc[acc.length - 1] === "") return acc;
      acc.push(l);
      return acc;
    }, [])
    .join("\n")
    .replace(/^\n+/, "")
    .trim();
}

/** Dedupe posts by post_number (page overlap safety), keep first occurrence order. */
export function mergePosts(posts: DiscoursePost[]): DiscoursePost[] {
  const seen = new Set<number>();
  return posts.filter((p) => {
    if (seen.has(p.post_number)) return false;
    seen.add(p.post_number);
    return true;
  });
}

/** Render a topic to markdown: posts in chronological order, each reply
 * carrying an explicit "↩ #N" marker instead of physical indentation (deep
 * Discourse chains make indentation unreadable and hide late replies to early
 * posts mid-document). */
export function renderDiscourse(topic: DiscourseTopic, host: string, renderedCount: number): string {
  const posts = mergePosts(topic.post_stream.posts).sort((a, b) => a.post_number - b.post_number);

  const lines: string[] = [`# ${topic.title}`, ""];
  const meta = [host, `${topic.posts_count} posts`, `${renderedCount} rendered`];
  lines.push(meta.join(" · "));
  const tags = tagNames(topic.tags);
  if (tags.length > 0) lines.push(`Tags: ${tags.map((tag) => `#${tag}`).join(" ")}`);
  lines.push("", "---", "", "## Posts", "");

  for (const p of posts) {
    const score = Math.round(p.score ?? 0);
    const reply = p.reply_to_post_number != null ? `, ↩ #${p.reply_to_post_number}` : "";
    const date = postDate(p.created_at);
    const edited = postEdited(p.created_at, p.updated_at);
    const accepted = p.accepted_answer ? ", ✓ accepted" : "";
    lines.push(
      `- **${p.username}** (#${p.post_number}${date}${edited}, ${score} pts${reply}${accepted}): ${cookedToText(p.cooked)}`,
    );
  }

  if (renderedCount < topic.posts_count) {
    lines.push("", `[... ${topic.posts_count - renderedCount} more posts not fetched]`);
  }
  lines.push("", SEARCH_HINT);
  return lines.join("\n").trim();
}

/** Tag names from either tag shape (string or {name,slug} object). */
export function tagNames(tags: (string | { name?: string; slug?: string })[] | undefined): string[] {
  return (tags ?? [])
    .map((t) => (typeof t === "string" ? t : (t.name ?? t.slug)))
    .filter((t): t is string => Boolean(t));
}

/** Post creation date as YYYY-MM-DD, or "" when the post has no timestamp. */
export function postDate(createdAt: string | undefined): string {
  const day = createdAt?.slice(0, 10);
  return day ? `, ${day}` : "";
}

/** ", edited YYYY-MM-DD" when the post was edited on a later day, else "". */
export function postEdited(createdAt: string | undefined, updatedAt: string | undefined): string {
  if (!createdAt || !updatedAt || updatedAt.slice(0, 10) <= createdAt.slice(0, 10)) return "";
  return `, edited ${updatedAt.slice(0, 10)}`;
}

/** Render a category topic list: one bullet per topic with its /t/ path (the
 * URL to fetch next), posts count, subcategory tag (parent listings include
 * subcategory topics), tags, last activity, and excerpt. */
export function renderCategoryList(
  topics: CategoryTopic[],
  host: string,
  listingName: string,
  truncated: boolean,
  opts: { listingId?: number; kindLabel?: string; nameOf?: (id: number) => string | undefined } = {},
): string {
  const lines: string[] = [`# ${listingName} (${opts.kindLabel ?? "category"})`, ""];
  const meta = [host, `${topics.length} topics listed`];
  lines.push(meta.join(" · "), "");

  const seen = new Set<number>();
  for (const t of topics) {
    if (seen.has(t.id)) continue;
    seen.add(t.id);
    const parts = [`${t.posts_count} posts`];
    if (t.category_id != null && t.category_id !== opts.listingId) {
      parts.push(`in ${opts.nameOf?.(t.category_id) ?? `category ${t.category_id}`}`);
    }
    const tags = tagNames(t.tags);
    if (tags.length > 0) parts.push(tags.map((tag) => `#${tag}`).join(" "));
    if (t.pinned) parts.push("pinned");
    if (t.closed) parts.push("closed");
    if (t.last_posted_at) parts.push(`last ${t.last_posted_at.slice(0, 10)}`);
    lines.push(`- **${t.title}** (${parts.join(", ")}) — /t/${t.slug}/${t.id}`);
    if (t.excerpt) {
      const excerpt = cookedToText(t.excerpt).replace(/\n+/g, " ").slice(0, 280);
      if (excerpt) lines.push(`  ${excerpt}${t.excerpt.length > 280 ? "…" : ""}`);
    }
  }

  if (truncated) lines.push("", "[... more topics available — list truncated]");
  lines.push("", `${SEARCH_HINT} · All boards: /categories`);
  return lines.join("\n").trim();
}

/** One-line discovery pointer appended to listings/topic renders — the agent
 * learns the search syntax in context instead of needing it in a prompt. */
const SEARCH_HINT = "Search: /search?q=<terms> (#category, @user, in:title, order:latest)";

// ── Search rendering ──

export interface SearchPost {
  topic_id: number;
  post_number?: number;
  username: string;
  blurb?: string;
  created_at?: string;
}

export interface SearchTopic {
  id: number;
  title: string;
  slug: string;
  posts_count?: number;
  category_id?: number;
  tags?: (string | { name?: string; slug?: string })[];
}

export interface SearchResponse {
  topics?: SearchTopic[];
  posts?: SearchPost[];
  categories?: { id: number; name: string }[];
}

/** Posts rendered per search page; the server's own page size is 50. */
const MAX_SEARCH_POSTS = 50;

/** Search blurbs to plain one-line text (occasional HTML/entities stripped). */
export function blurbText(blurb: string | undefined): string {
  if (!blurb) return "";
  const t = cookedToText(blurb);
  return t.replace(/\s+/g, " ").trim().slice(0, 200);
}

/** Render search results: posts grouped under their topic, each topic carrying
 * its /t/ path so the agent can fetch the full thread next. */
export function renderSearch(res: SearchResponse, host: string, query: string): string {
  const lines: string[] = [`# Search: ${query}`, ""];
  const topics = new Map((res.topics ?? []).map((t) => [t.id, t]));
  const cats = new Map((res.categories ?? []).map((c) => [c.id, c.name]));
  const posts = res.posts ?? [];
  if (posts.length === 0) {
    lines.push(`${host} · No results.`, "", SEARCH_HINT);
    return lines.join("\n").trim();
  }
  lines.push(`${host} · ${posts.length} posts in ${topics.size} topics`, "");

  const groups = new Map<number, SearchPost[]>();
  for (const p of posts) {
    const arr = groups.get(p.topic_id);
    if (arr) arr.push(p);
    else groups.set(p.topic_id, [p]);
  }
  let shown = 0;
  for (const [topicId, group] of groups) {
    if (shown >= MAX_SEARCH_POSTS) break;
    const t = topics.get(topicId);
    const head: string[] = [];
    if (t?.posts_count != null) head.push(`${t.posts_count} posts`);
    if (t?.category_id != null) {
      const n = cats.get(t.category_id);
      if (n) head.push(`in ${n}`);
    }
    const tags = tagNames(t?.tags);
    if (tags.length > 0) head.push(tags.map((tag) => `#${tag}`).join(" "));
    const headStr = head.length > 0 ? ` (${head.join(", ")})` : "";
    lines.push(`- **${t?.title ?? `topic ${topicId}`}**${headStr} — /t/${t?.slug ?? "topic"}/${topicId}`);
    for (const p of group) {
      if (shown >= MAX_SEARCH_POSTS) break;
      shown++;
      const date = p.created_at ? `, ${p.created_at.slice(0, 10)}` : "";
      const blurb = blurbText(p.blurb);
      lines.push(`  - **${p.username}** (#${p.post_number ?? "?"}${date}): ${blurb || "(no excerpt)"}`);
    }
  }
  if (posts.length > shown) {
    lines.push("", `[... ${posts.length - shown} more posts — add &page=2 to the search URL for the next page]`);
  }
  return lines.join("\n").trim();
}

// ── Category tree rendering ──

/** Render the site category index from site.json: one bullet per category,
 * children nested under parents, each with its canonical /c/ path (the URL to
 * fetch next), topic count, and one-line description. */
export function renderCategoryTree(cats: SiteCategory[], host: string): string {
  const byId = new Map(cats.map((c) => [c.id, c]));
  const byParent = new Map<number | null, SiteCategory[]>();
  for (const c of cats) {
    const k = c.parent_category_id ?? null;
    const arr = byParent.get(k) ?? [];
    arr.push(c);
    byParent.set(k, arr);
  }
  const slugPath = (c: SiteCategory): string => {
    const parts: string[] = [];
    const guard = new Set<number>();
    let cur: SiteCategory | undefined = c;
    while (cur && !guard.has(cur.id)) {
      guard.add(cur.id);
      parts.unshift(cur.slug ?? String(cur.id));
      cur = cur.parent_category_id != null ? byId.get(cur.parent_category_id) : undefined;
    }
    return parts.join("/");
  };
  const lines: string[] = [
    `# Categories (${host})`,
    "",
    `${cats.length} categories · fetch a board: https://${host}/c/<slug-path>/<id>[/l/latest|new|top]`,
    "",
  ];
  const pos = (c: SiteCategory) => c.position ?? Number.MAX_SAFE_INTEGER;
  const walk = (parent: number | null, depth: number) => {
    if (depth > 10) return;
    const kids = (byParent.get(parent) ?? []).sort((a, b) => pos(a) - pos(b));
    for (const c of kids) {
      const raw = c.description_text ?? c.description;
      const descLine = raw
        ? ` — ${raw.split("\n")[0].replace(/\s+/g, " ").trim().slice(0, 100)}${raw.length > 100 ? "…" : ""}`
        : "";
      lines.push(
        `${"  ".repeat(depth)}- **${c.name}** (/c/${slugPath(c)}/${c.id}, ${c.topic_count ?? "?"} topics)${descLine}`,
      );
      walk(c.id, depth + 1);
    }
  };
  walk(null, 0);
  return lines.join("\n").trim();
}

// ── Provider ──

const MAX_PAGES = 50;
const MAX_CATEGORY_PAGES = 3;

/** Names for site-wide listings, keyed by the first path segment. */
const SITELIST_NAMES: Record<string, string> = {
  latest: "Latest topics",
  new: "New topics",
  unread: "Unread topics",
  top: "Top topics",
};

function sitelistName(path: string): string {
  const segs = path.split("/").filter(Boolean);
  const base = SITELIST_NAMES[segs[0] ?? ""] ?? segs[0] ?? "Topics";
  return segs[1] ? `${base} (${segs[1]})` : base;
}

type HttpFetch = NonNullable<FeedContext["httpFetch"]>;

export const discourseProvider: FeedProvider = {
  matches,
  hint:
    "ALWAYS use web_fetch for forum/Discourse URLs, never curl or scrape. " +
    "Discourse forums (any host): /t/<slug>/<id> topics, /c/<slugs>[/<id>][/l/<filter>] boards, " +
    "/categories index, /latest|/new|/unread|/top listings, /search?q=... (filters: #category, @user, " +
    "in:title, order:latest, status:...) — all render as structured markdown.",
  async fetch(url, ctx: FeedContext): Promise<FeedResult> {
    const http = ctx.httpFetch;
    if (!http) throw new Error("discourse: no httpFetch transport");
    switch (classify(url)) {
      case "category":
        return fetchCategory(url, http);
      case "search":
        return fetchSearch(url, http);
      case "sitelist":
        return fetchSitelist(url, http);
      case "categories":
        return fetchCategories(url, http);
      default:
        return fetchTopic(url, http);
    }
  },
};

async function fetchTopic(url: string, http: HttpFetch): Promise<FeedResult> {
  const headers = authHeadersFor(url);
  const jsonUrl = jsonUrlFor(url);

  const first = await http(jsonUrl, { headers });
  const denied = gatedNote(url, first.status);
  if (denied) return denied;
  if (first.status !== 200) throw new Error(`discourse: topic JSON returned HTTP ${first.status}`);
  const topic = JSON.parse(first.text) as DiscourseTopic;

  // Pagination: first response carries ~20 posts; stream lists all post ids.
  // ?page=N on the topic JSON (verified; the ids[] param is ignored by some
  // instances). Failures keep what we have rather than losing the feed.
  let posts = topic.post_stream.posts;
  const total = topic.post_stream.stream?.length ?? posts.length;
  let page = 2;
  while (posts.length < total && page <= MAX_PAGES) {
    try {
      const r = await http(`${jsonUrl}${jsonUrl.includes("?") ? "&" : "?"}page=${page}`, { headers });
      if (r.status !== 200) break;
      const more = (JSON.parse(r.text) as DiscourseTopic).post_stream?.posts ?? [];
      if (more.length === 0) break;
      posts = posts.concat(more);
      page++;
    } catch {
      break;
    }
  }
  topic.post_stream.posts = posts;

  return {
    url,
    title: topic.title,
    content: renderDiscourse(topic, new URL(url).hostname, posts.length),
  };
}

async function fetchCategory(url: string, http: HttpFetch): Promise<FeedResult> {
  const headers = authHeadersFor(url);
  const origin = `https://${new URL(url).hostname}`;
  const parts = parseCategoryPath(url);
  if (!parts) throw new Error("discourse: unparseable category path");

  // site.json first: it carries the slug→id map (slug-only URLs have no id in
  // the path) AND the id→name map for listing/subcategory labels.
  const site = await fetchSite(origin, http, headers);
  let id = parts.id;
  if (id == null) {
    const resolved = resolveCategoryId(site?.categories ?? [], parts.slugs);
    if (resolved == null) {
      throw new Error(`discourse: category /c/${parts.slugs.join("/")} not found on ${origin}`);
    }
    id = resolved;
  }

  const listing = await fetchTopicList(origin, categoryJsonUrl(origin, parts, id, url), url, headers, http);
  if (listing.denied) return listing.denied;

  const name = site?.names.get(id) ?? `Category ${id}`;
  return {
    url,
    title: name,
    content: renderCategoryList(listing.topics, new URL(url).hostname, name, listing.truncated, {
      listingId: id,
      nameOf: (cid) => site?.names.get(cid),
    }),
  };
}

async function fetchSitelist(url: string, http: HttpFetch): Promise<FeedResult> {
  const headers = authHeadersFor(url);
  const origin = `https://${new URL(url).hostname}`;
  const path = url
    .split(/[?#]/)[0]
    .replace(/^https?:\/\/[^/]+/i, "")
    .replace(/\/+$/, "");
  const name = sitelistName(path);

  const listing = await fetchTopicList(
    origin,
    `${origin}${path}.json?${categoryQuery(url).toString()}`,
    url,
    headers,
    http,
  );
  if (listing.denied) return listing.denied;

  // No listingId — every topic shows which board it belongs to.
  const site = await fetchSite(origin, http, headers);
  return {
    url,
    title: name,
    content: renderCategoryList(listing.topics, new URL(url).hostname, name, listing.truncated, {
      kindLabel: "listing",
      nameOf: (cid) => site?.names.get(cid),
    }),
  };
}

async function fetchSearch(url: string, http: HttpFetch): Promise<FeedResult> {
  const headers = authHeadersFor(url);
  const u = new URL(url);
  const q = u.searchParams.get("q")?.trim();
  if (!q) throw new Error("discourse: /search needs a ?q= parameter");
  const jsonUrl = `https://${u.hostname}/search.json?${u.searchParams.toString()}`;

  const first = await http(jsonUrl, { headers });
  const denied = gatedNote(url, first.status);
  if (denied) return denied;
  if (first.status !== 200) throw new Error(`discourse: search JSON returned HTTP ${first.status}`);
  const res = JSON.parse(first.text) as SearchResponse;
  return { url, title: `Search: ${q}`, content: renderSearch(res, u.hostname, q) };
}

async function fetchCategories(url: string, http: HttpFetch): Promise<FeedResult> {
  const headers = authHeadersFor(url);
  const origin = `https://${new URL(url).hostname}`;
  const site = await fetchSite(origin, http, headers);
  if (!site) throw new Error(`discourse: site.json unavailable on ${origin}`);
  return { url, title: "Categories", content: renderCategoryTree(site.categories, new URL(url).hostname) };
}

/** Fetch a topic-listing endpoint and follow more_topics_url pagination.
 * denied is set on an auth-gated response (caller returns it verbatim). */
async function fetchTopicList(
  origin: string,
  jsonUrl: string,
  url: string,
  headers: Record<string, string>,
  http: HttpFetch,
): Promise<{ topics: CategoryTopic[]; truncated: boolean; denied: FeedResult | null }> {
  const first = await http(jsonUrl, { headers });
  const denied = gatedNote(url, first.status);
  if (denied) return { topics: [], truncated: false, denied };
  if (first.status !== 200) throw new Error(`discourse: listing JSON returned HTTP ${first.status}`);

  // Parent listings include subcategory topics — each topic carries its own
  // category_id. Follow more_topics_url (verified: relative path + ?page=N).
  let list = JSON.parse(first.text) as CategoryList;
  let topics = list.topic_list.topics;
  let pages = 1;
  while (list.topic_list.more_topics_url && pages < MAX_CATEGORY_PAGES) {
    try {
      const r = await http(paginationUrlFor(origin, list.topic_list.more_topics_url), { headers });
      if (r.status !== 200) break;
      list = JSON.parse(r.text) as CategoryList;
      topics = topics.concat(list.topic_list.topics);
      pages++;
    } catch {
      break;
    }
  }
  return { topics, truncated: Boolean(list.topic_list.more_topics_url), denied: null };
}

/** Fetch site.json: category entries + id→name map. Null on any failure. */
async function fetchSite(origin: string, http: HttpFetch, headers: Record<string, string>): Promise<SiteInfo | null> {
  try {
    const r = await http(`${origin}/site.json`, { headers });
    if (r.status !== 200) return null;
    const cats = (JSON.parse(r.text) as { categories?: SiteCategory[] }).categories ?? [];
    return { names: new Map(cats.map((c) => [c.id, c.name])), categories: cats };
  } catch {
    return null;
  }
}

/** Resolve a category slug path against site.json. Walks the parent chain for
 * nested slugs (/c/parent/child); falls back to the last slug alone (Discourse
 * slugs are unique site-wide by default). Best-effort — null when unknown. */
export function resolveCategoryId(cats: SiteCategory[], slugs: string[]): number | null {
  if (slugs.length === 0) return null;
  let parent: number | null = null;
  let cur: SiteCategory | undefined;
  for (const slug of slugs) {
    const next = cats.find((c) => c.slug === slug && (c.parent_category_id ?? null) === parent);
    if (!next) {
      cur = undefined;
      break;
    }
    cur = next;
    parent = next.id;
  }
  if (cur) return cur.id;
  const fallback = cats.find((c) => c.slug === slugs[slugs.length - 1]);
  return fallback?.id ?? null;
}

/** Actionable note for auth-denied fetches, or null when status is fine. */
function gatedNote(url: string, status: number): FeedResult | null {
  if (status !== 401 && status !== 403) return null;
  const host = new URL(url).hostname;
  // Return (not throw) so the agent gets actionable text instead of an
  // HTML login-wall scrape. tryFeed only falls back on thrown errors.
  return {
    url,
    title: "Login-gated Discourse",
    content:
      `This Discourse (${host}) requires login and no API key is configured.\n` +
      `Create a User API Key on the forum, store it in 1Password, and point a\n` +
      `"!command" entry at it in ${AUTH_FILE}:\n` +
      `  { "${host}": { "apiKey": "!op --account <account> read 'op://<vault>/<item>/api-key'", "apiUsername": "<username>" } }`,
  };
}
