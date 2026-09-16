/**
 * Structured-feed provider interfaces for web_fetch.
 *
 * When a site publishes a structured feed, it's materially better than
 * scraped HTML — preserves comment threading, drops page chrome, carries
 * scores. Providers are pure logic with HOST-INJECTED transports, so they
 * don't reach into agent-browser or any specific browser. A future
 * forepaw/Firefox host or a browser-less MCP host reuses them unchanged.
 */

/** Same shape as web-fetch's FetchResult — kept local to avoid a circular import. */
export interface FeedResult {
  url: string;
  title: string;
  content: string;
}

export interface HttpFetchOptions {
  signal?: AbortSignal;
  /** Custom headers to merge with the transport's defaults (User-Agent, etc). */
  headers?: Record<string, string>;
}

export interface BrowserFetchResult {
  /** Final URL after redirects. */
  url: string;
  /** The page's body text, already unwrapped (no host-specific quoting). */
  text: string;
}

export interface FeedContext {
  /**
   * Browser-session fetch, for providers that need a real browser — e.g. when
   * a challenge cookie gates the feed. Transport-agnostic — the host injects
   * whatever browser it has (agent-browser now, forepaw later). Absent for
   * browser-less hosts, which is fine for providers that don't need a browser.
   */
  browserFetch?: (url: string, signal?: AbortSignal) => Promise<BrowserFetchResult>;
  /**
   * Plain HTTP fetch with a stealth User-Agent + timeout. For ungated APIs and
   * feeds that answer without a browser session. Returns raw status + body text.
   */
  httpFetch?: (url: string, opts?: HttpFetchOptions) => Promise<{ status: number; text: string }>;
}

export interface FeedProvider {
  /** Eligibility — owns its own URL rules (subdomain normalization, path matching, etc). */
  matches(url: string): boolean;
  /** Required one-line capability hint, folded into the host's web_fetch
   * description — how an agent discovers feed support without reading
   * feeds/ source. A hint-less provider would be undiscoverable. */
  hint: string;
  /** Fetch + render to markdown. May use browserFetch, httpFetch, or both. */
  fetch(url: string, ctx: FeedContext): Promise<FeedResult>;
}
