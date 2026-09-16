import { describe, expect, test } from "bun:test";
import { discourseProvider } from "./discourse";
import { githubProvider } from "./github";
import { redditProvider } from "./reddit";
import { feedHints, matchFeed, PROVIDERS, tryFeed } from "./registry";

describe("feedHints", () => {
  test("every provider declares a non-empty hint", () => {
    expect(PROVIDERS.length).toBeGreaterThanOrEqual(3);
    for (const p of PROVIDERS) {
      expect(p.hint.trim().length).toBeGreaterThan(0);
    }
    expect(feedHints().split("\n")).toHaveLength(PROVIDERS.length);
  });

  test("hints name their sites", () => {
    const hints = feedHints();
    expect(hints).toContain("Discourse");
    expect(hints).toContain("Reddit");
    expect(hints).toContain("GitHub");
  });
});

describe("matchFeed", () => {
  test("routes by URL shape, first match wins", () => {
    expect(matchFeed("https://www.reddit.com/r/x/comments/abc/post")).toBe(redditProvider);
    expect(matchFeed("https://github.com/org/repo/issues/1")).toBe(githubProvider);
    expect(matchFeed("https://forum.example.com/t/slug/42")).toBe(discourseProvider);
  });

  test("unknown URLs match no provider", () => {
    expect(matchFeed("https://example.com/blog/post")).toBeUndefined();
  });
});

describe("tryFeed", () => {
  const topicJson = JSON.stringify({
    title: "T",
    posts_count: 1,
    post_stream: { stream: [1], posts: [{ post_number: 1, username: "a", cooked: "<p>x</p>" }] },
  });
  const ctx = {
    httpFetch: async () => ({ status: 200, text: topicJson }),
  } as never as Parameters<typeof discourseProvider.fetch>[1];

  test("returns the rendered feed for a matching URL", async () => {
    const res = await tryFeed("https://forum.example.com/t/slug/42", ctx);
    expect(res?.title).toBe("T");
    expect(res?.content).toContain("# T");
  });

  test("null when no provider matches", async () => {
    expect(await tryFeed("https://example.com/blog/post", ctx)).toBeNull();
  });

  test("null when the provider throws (HTML fallback contract)", async () => {
    // No httpFetch transport → fetch throws → swallowed.
    expect(await tryFeed("https://forum.example.com/t/slug/42", {} as never)).toBeNull();
  });
});
