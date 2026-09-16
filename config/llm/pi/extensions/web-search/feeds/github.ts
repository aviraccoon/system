/**
 * GitHub feed provider — composes a useful view of a GitHub URL from the API
 * rather than scraping the (chrome-heavy, JS-rendered) HTML page.
 *
 * Three page types, each its own composed render:
 *  - repo root  → metadata (stars, forks, language, license, topics, last push),
 *                 latest release, then the README body. The metadata is signal,
 *                 not chrome — it's what you'd scan first when landing on a repo.
 *  - blob/file  → raw file content in a ```lang:path fence (filename in the info
 *                 string, per the gittomd convention models parse well).
 *  - issue      → metadata header (state, author, labels, assignees, reactions)
 *                 + flat comment stream (GitHub issues are not nested).
 *
 * Transport: plain HTTP against api.github.com + raw.githubusercontent.com,
 * authed with a bearer token resolved lazily via `gh auth token` (cached for
 * the session so any one-time op approval happens once, on first GitHub fetch).
 * The provider owns its own auth — the host doesn't need to know about `gh`.
 * Discussions and PRs are deferred (GraphQL / complex multi-endpoint).
 */

import { execFileSync } from "node:child_process";
import { USER_AGENT } from "./http";
import type { FeedContext, FeedProvider, FeedResult } from "./types";

// ── URL parsing ──

export type GitHubTarget =
  | { kind: "repo"; owner: string; repo: string }
  | { kind: "blob"; owner: string; repo: string; ref: string; path: string }
  | { kind: "issue"; owner: string; repo: string; number: number };

const HOST_RE = /^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/]+)\/?([^?#]*)/i;

/** Parse a GitHub URL into a target, or null if unsupported (falls back to HTML scrape). */
export function parseGitHubUrl(url: string): GitHubTarget | null {
  const m = HOST_RE.exec(url);
  if (!m) return null;
  const [, owner, repo, rest] = m;
  if (!owner || !repo) return null;
  // Strip a trailing .git and ignore owner ".github.io" app hosts? Keep simple: any owner.
  const cleanRepo = repo.replace(/\.git$/, "");
  const segs = rest.split("/").filter(Boolean);
  if (segs.length === 0) return { kind: "repo", owner, repo: cleanRepo };
  if (segs[0] === "blob" && segs.length >= 3) {
    return { kind: "blob", owner, repo: cleanRepo, ref: segs[1], path: segs.slice(2).join("/") };
  }
  if (segs[0] === "issues" && /^\d+$/.test(segs[1] ?? "")) {
    return { kind: "issue", owner, repo: cleanRepo, number: Number(segs[1]) };
  }
  // pull/, discussions/, releases/, tree/, commits/, ... — not handled, fall through.
  return null;
}

export function matches(url: string): boolean {
  return parseGitHubUrl(url) !== null;
}

// ── Pure renderers ──

interface RepoMeta {
  full_name: string;
  description: string | null;
  homepage: string | null;
  private: boolean;
  stargazers_count: number;
  forks_count: number;
  subscribers_count: number;
  open_issues_count: number;
  language: string | null;
  license: { spdx_id: string } | null;
  topics: string[];
  default_branch: string;
  created_at: string;
  pushed_at: string;
  fork: boolean;
  /** Populated when `fork` is true — the upstream repo (full_name, html_url). */
  source?: { full_name: string; html_url: string } | null;
  is_template: boolean;
  archived: boolean;
  disabled: boolean;
}

interface Release {
  tag_name: string;
  name: string | null;
  published_at: string;
  body: string | null;
}

/** Render a repo root: metadata block, latest release, then README. */
export function renderRepo(meta: RepoMeta, release: Release | null, readme: string | null): string {
  const lines: string[] = [`# ${meta.full_name}`, ""];
  if (meta.description) lines.push(meta.description, "");

  const stats = [
    meta.private ? "Private" : "Public",
    `Stars: ${meta.stargazers_count}`,
    `Forks: ${meta.forks_count}`,
    `Watching: ${meta.subscribers_count}`,
    `Open issues: ${meta.open_issues_count}`,
  ];
  lines.push(stats.join(" · "));

  const facts: string[] = [];
  if (meta.language) facts.push(`Language: ${meta.language}`);
  if (meta.license?.spdx_id) facts.push(`License: ${meta.license.spdx_id}`);
  if (meta.topics?.length) facts.push(`Topics: ${meta.topics.join(", ")}`);
  if (facts.length) lines.push(facts.join(" · "));

  const life: string[] = [];
  if (meta.homepage) life.push(`Homepage: ${meta.homepage}`);
  life.push(`Default branch: ${meta.default_branch}`);
  lines.push(life.join(" · "));

  const dates: string[] = [];
  if (meta.created_at) dates.push(`Created ${formatDate(meta.created_at)}`);
  if (meta.pushed_at) dates.push(`Last push ${formatDate(meta.pushed_at)}`);
  if (dates.length) lines.push(dates.join(" · "));
  if (meta.fork && meta.source) lines.push(`Fork of ${meta.source.full_name}`);
  if (meta.is_template) lines.push("*Template*");
  if (meta.archived) lines.push("*Archived*");
  if (meta.disabled) lines.push("*Disabled*");
  lines.push("");

  if (release) {
    const heading = release.name ? `${release.tag_name} — ${release.name}` : release.tag_name;
    lines.push(`--- LATEST RELEASE: ${heading} (${formatDate(release.published_at)}) ---`);
    if (release.body?.trim()) lines.push(release.body.trim());
    lines.push("");
  }

  if (readme?.trim()) {
    lines.push("--- README ---", readme.trim());
  }
  return lines.join("\n").trim();
}

interface IssueMeta {
  number: number;
  title: string;
  state: string;
  state_reason?: string | null;
  user: { login: string };
  labels: { name: string }[];
  assignees: { login: string }[];
  reactions: { total_count: number };
  comments: number;
  created_at: string;
  body: string | null;
}

interface IssueComment {
  user: { login: string };
  created_at: string;
  reactions: { total_count: number };
  body: string | null;
}

/** Render an issue: metadata header + flat comment stream. */
export function renderIssue(issue: IssueMeta, comments: IssueComment[]): string {
  const lines: string[] = [
    `# ${issue.title}`,
    "",
    [
      `Issue #${issue.number}`,
      issue.state,
      issue.state_reason ? `(${issue.state_reason})` : null,
      `· u/${issue.user.login}`,
      `· ${issue.comments} comments`,
      `· ${issue.reactions.total_count} reactions`,
      `· ${formatDate(issue.created_at)}`,
    ]
      .filter(Boolean)
      .join(" "),
  ];
  const labels = issue.labels.map((l) => l.name);
  if (labels.length) lines.push(`Labels: ${labels.join(", ")}`);
  if (issue.assignees.length) lines.push(`Assignees: ${issue.assignees.map((a) => a.login).join(", ")}`);
  lines.push("");
  if (issue.body?.trim()) lines.push(issue.body.trim(), "");
  if (comments.length) {
    lines.push("--- COMMENTS ---");
    for (const c of comments) {
      const head = `- **u/${c.user.login}** (${c.reactions.total_count} reactions, ${formatDate(c.created_at)}):`;
      lines.push(head);
      if (c.body?.trim()) {
        // Indent body under the bullet so it stays grouped with its author.
        lines.push(
          ...c.body
            .trim()
            .split("\n")
            .map((l) => `  ${l}`),
        );
      }
      lines.push("");
    }
  }
  return lines.join("\n").trim();
}

/** Render a blob: raw content in a ```lang:path fence (gittomd convention). */
export function renderBlob(path: string, content: string): string {
  const lang = languageForPath(path);
  const info = lang ? `${lang}:${path}` : path;
  const fence = "```";
  return `${fence}${info}\n${content.replace(/\n*$/, "\n")}${fence}`;
}

// ── Helpers ──

/** Format an ISO timestamp as YYYY-MM-DD. Returns '?' on parse failure. */
export function formatDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : "?";
}

/** Map a file path to a code-fence language hint. */
export function languageForPath(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    rs: "rust",
    ts: "typescript",
    tsx: "tsx",
    js: "javascript",
    jsx: "jsx",
    py: "python",
    go: "go",
    rb: "ruby",
    java: "java",
    kt: "kotlin",
    swift: "swift",
    c: "c",
    h: "c",
    cpp: "cpp",
    cc: "cpp",
    hpp: "cpp",
    cs: "csharp",
    php: "php",
    sh: "bash",
    bash: "bash",
    zsh: "bash",
    yml: "yaml",
    yaml: "yaml",
    toml: "toml",
    json: "json",
    xml: "xml",
    html: "html",
    css: "css",
    scss: "scss",
    sql: "sql",
    nix: "nix",
    lua: "lua",
    r: "r",
    scala: "scala",
    clj: "clojure",
    ex: "elixir",
    exs: "elixir",
    erl: "erlang",
    hs: "haskell",
    ml: "ocaml",
    fs: "fsharp",
    dart: "dart",
    vue: "vue",
    svelte: "svelte",
    md: "markdown",
    markdown: "markdown",
    txt: "text",
    dockerfile: "dockerfile",
    makefile: "makefile",
  };
  // Filenames without a meaningful extension.
  if (/dockerfile$/i.test(path)) return "dockerfile";
  if (/makefile$/i.test(path)) return "makefile";
  return map[ext] ?? "";
}

// ── HTTP + auth (token resolved lazily via `gh auth token`, cached for the session) ──

const API = "https://api.github.com";

/** Session cache of the bearer token: the auth approval happens once, on first GitHub fetch. */
let cachedToken: string | null | undefined;

/** Resolve a GitHub bearer token via `gh auth token`, cached for the session. Null → unauthenticated. */
async function bearer(): Promise<string | null> {
  if (cachedToken !== undefined) return cachedToken;
  try {
    const stdout = execFileSync("gh", ["auth", "token"], {
      timeout: 10_000,
      encoding: "utf-8",
      env: process.env,
    });
    cachedToken = stdout.trim() || null;
  } catch {
    cachedToken = null;
  }
  return cachedToken;
}

/** GET a GitHub API endpoint as JSON (authed if a token resolved). Throws on non-200. */
async function apiGet(path: string, ctx: FeedContext, accept = "application/vnd.github+json"): Promise<unknown> {
  if (!ctx.httpFetch) throw new Error("github: no httpFetch transport");
  const headers: Record<string, string> = { Accept: accept, "User-Agent": USER_AGENT };
  const token = await bearer();
  if (token) headers.Authorization = `Bearer ${token}`;
  const r = await ctx.httpFetch(`${API}/${path.replace(/^\//, "")}`, { headers });
  if (r.status !== 200) throw new Error(`github: GET ${path} returned ${r.status}`);
  return JSON.parse(r.text);
}

/** GET a GitHub API endpoint as raw text (for README, where Accept: raw returns markdown). */
async function apiGetText(path: string, ctx: FeedContext): Promise<string | null> {
  if (!ctx.httpFetch) throw new Error("github: no httpFetch transport");
  const headers: Record<string, string> = { Accept: "application/vnd.github.raw", "User-Agent": USER_AGENT };
  const token = await bearer();
  if (token) headers.Authorization = `Bearer ${token}`;
  const r = await ctx.httpFetch(`${API}/${path.replace(/^\//, "")}`, { headers });
  return r.status === 200 ? r.text : null;
}

// ── Provider ──

export const githubProvider: FeedProvider = {
  matches,
  hint: "GitHub repos, issues, and PRs (github.com) render as structured markdown — READMEs, metadata, comment threads.",
  async fetch(url, ctx: FeedContext): Promise<FeedResult> {
    const target = parseGitHubUrl(url);
    if (!target) throw new Error("github: unsupported URL");

    if (target.kind === "blob") {
      return fetchBlob(url, target, ctx);
    }
    if (target.kind === "issue") {
      return fetchIssue(url, target, ctx);
    }
    return fetchRepo(url, target, ctx);
  },
};

async function fetchRepo(
  url: string,
  target: Extract<GitHubTarget, { kind: "repo" }>,
  ctx: FeedContext,
): Promise<FeedResult> {
  const base = `repos/${target.owner}/${target.repo}`;
  const [meta, releases, readme] = await Promise.all([
    apiGet(base, ctx) as Promise<RepoMeta>,
    apiGet(`${base}/releases?per_page=1`, ctx).then((r: unknown) => {
      const arr = r as Release[];
      return arr && arr.length > 0 ? arr[0] : null;
    }),
    apiGetText(`${base}/readme`, ctx).catch(() => null),
  ]);
  const release = releases as Release | null;
  const content = renderRepo(meta, release, readme);
  return { url, title: meta.full_name, content };
}

async function fetchIssue(
  url: string,
  target: Extract<GitHubTarget, { kind: "issue" }>,
  ctx: FeedContext,
): Promise<FeedResult> {
  const base = `repos/${target.owner}/${target.repo}/issues/${target.number}`;
  const [issue, comments] = await Promise.all([
    apiGet(base, ctx) as Promise<IssueMeta>,
    apiGet(`${base}/comments?per_page=100`, ctx).then((r: unknown) => (r as IssueComment[]) ?? []),
  ]);
  const content = renderIssue(issue, comments);
  return { url, title: `#${issue.number} ${issue.title}`, content };
}

async function fetchBlob(
  url: string,
  target: Extract<GitHubTarget, { kind: "blob" }>,
  ctx: FeedContext,
): Promise<FeedResult> {
  if (!ctx.httpFetch) throw new Error("github blob: no httpFetch transport");
  const rawUrl = `https://raw.githubusercontent.com/${target.owner}/${target.repo}/${target.ref}/${target.path}`;
  const r = await ctx.httpFetch(rawUrl);
  if (r.status !== 200) throw new Error(`github blob: raw fetch returned ${r.status}`);
  return { url, title: target.path, content: renderBlob(target.path, r.text) };
}
