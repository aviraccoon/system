/**
 * Registry of structured-feed providers for web_fetch.
 *
 * When a URL matches a feed provider, prefer the structured source over
 * scraped HTML (structured sources preserve threading, drop page chrome,
 * carry scores). Adding a provider = one file + one entry in PROVIDERS. No
 * branching in the host. Host-injected transports keep providers reusable
 * across hosts (pi/agent-browser now, forepaw/Firefox later, a browser-less
 * MCP server).
 */
import { discourseProvider } from "./discourse";
import { githubProvider } from "./github";
import { redditProvider } from "./reddit";
import type { FeedContext, FeedProvider, FeedResult } from "./types";

export const PROVIDERS: FeedProvider[] = [redditProvider, githubProvider, discourseProvider];

/** Return the first provider whose `matches()` accepts the URL, else undefined. */
export function matchFeed(url: string): FeedProvider | undefined {
  return PROVIDERS.find((p) => p.matches(url));
}

/** Capability hints from providers that declare them, joined for the host's
 * web_fetch tool description. */
export function feedHints(): string {
  return PROVIDERS.map((p) => p.hint)
    .filter((h): h is string => Boolean(h))
    .join("\n");
}

/**
 * Try the matching provider for a URL. Returns null if none matches or the
 * provider fails (caller falls back to the HTML scrape). Never throws — feed
 * fetching is a quality enhancement, not a gate.
 */
export async function tryFeed(url: string, ctx: FeedContext): Promise<FeedResult | null> {
  const provider = matchFeed(url);
  if (!provider) return null;
  try {
    return await provider.fetch(url, ctx);
  } catch {
    return null;
  }
}
