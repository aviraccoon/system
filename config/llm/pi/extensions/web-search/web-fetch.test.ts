import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { USER_AGENT } from "./feeds/http";
import {
  buildNavHeaders,
  cleanMarkdown,
  filenameForUrl,
  NAV_HEADERS,
  parseEvalString,
  sessionName,
  spillToTmp,
  spoofUserAgent,
  stripAnsi,
  truncateContent,
  unwrapLayoutTables,
} from "./web-fetch";

describe("sessionName", () => {
  test("derives from basename", () => {
    expect(sessionName("/Users/avi/system")).toBe("pi-fetch-system");
  });

  test("handles nested paths", () => {
    expect(sessionName("/Users/avi/dev/my-project")).toBe("pi-fetch-my-project");
  });
});

describe("stripAnsi", () => {
  test("strips color codes", () => {
    expect(stripAnsi("\x1b[32m✓\x1b[0m Page Title")).toBe("✓ Page Title");
  });

  test("passes plain text through", () => {
    expect(stripAnsi("hello world")).toBe("hello world");
  });

  test("strips multiple codes", () => {
    expect(stripAnsi("\x1b[1m\x1b[31merror\x1b[0m")).toBe("error");
  });
});

describe("truncateContent", () => {
  test("returns unchanged if under limit", () => {
    const result = truncateContent("short", 1000);
    expect(result.text).toBe("short");
    expect(result.truncated).toBe(false);
  });

  test("truncates with note", () => {
    const result = truncateContent("a".repeat(200), 100);
    expect(result.text).toContain("a".repeat(100));
    expect(result.text).toContain("[Truncated at 100 characters]");
    expect(result.truncated).toBe(true);
  });

  test("exact limit is not truncated", () => {
    const result = truncateContent("a".repeat(100), 100);
    expect(result.truncated).toBe(false);
  });
});

describe("stealth headers", () => {
  test("User-Agent is not the headless giveaway", () => {
    expect(USER_AGENT).not.toContain("HeadlessChrome");
    expect(USER_AGENT).toMatch(/Chrome\/\d+/);
  });

  test("NAV_HEADERS is valid JSON carrying the UA + language", () => {
    const parsed = JSON.parse(NAV_HEADERS);
    expect(parsed["User-Agent"]).toBe(USER_AGENT);
    expect(parsed["Accept-Language"]).toMatch(/en/);
  });
});

describe("spoofUserAgent", () => {
  test("swaps HeadlessChrome for Chrome, keeping version", () => {
    const headless =
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/149.0.0.0 Safari/537.36";
    expect(spoofUserAgent(headless)).toBe(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
    );
  });

  test("no-op on a real-Chrome UA (headed mode)", () => {
    const real =
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36";
    expect(spoofUserAgent(real)).toBe(real);
  });

  test("preserves a future major version bump", () => {
    expect(spoofUserAgent("...HeadlessChrome/200.0.0.0...")).toBe("...Chrome/200.0.0.0...");
  });
});

describe("buildNavHeaders", () => {
  test("produces JSON with the given UA + Accept-Language", () => {
    const parsed = JSON.parse(buildNavHeaders("MyUA/1.0"));
    expect(parsed["User-Agent"]).toBe("MyUA/1.0");
    expect(parsed["Accept-Language"]).toBe("en-US,en;q=0.9");
  });

  test("NAV_HEADERS matches buildNavHeaders(USER_AGENT)", () => {
    expect(buildNavHeaders(USER_AGENT)).toBe(NAV_HEADERS);
  });
});

describe("parseEvalString", () => {
  test("parses a JSON-quoted agent-browser eval result", () => {
    expect(parseEvalString('"Mozilla/5.0 ... Safari/537.36"')).toBe("Mozilla/5.0 ... Safari/537.36");
  });

  test("strips surrounding quotes on malformed JSON", () => {
    expect(parseEvalString('"unterminated')).toBe("unterminated");
  });

  test("passes plain unquoted text through", () => {
    expect(parseEvalString("plain value")).toBe("plain value");
  });

  test("strips ANSI codes", () => {
    expect(parseEvalString('\x1b[32m"hello"\x1b[0m')).toBe("hello");
  });
});

describe("unwrapLayoutTables", () => {
  test("unwraps a single-cell layout table to its text", () => {
    const html = "<table><tr><td>Hello world</td></tr></table>";
    expect(unwrapLayoutTables(html)).toBe("Hello world");
  });

  test("unwraps a single-column multi-row layout table", () => {
    const html = "<table><tr><td>line one</td></tr><tr><td>line two</td></tr></table>";
    expect(unwrapLayoutTables(html)).toBe("line one\nline two");
  });

  test("unwraps a single-row multi-cell layout table", () => {
    const html = "<table><tr><td>a</td><td>b</td><td>c</td></tr></table>";
    expect(unwrapLayoutTables(html)).toBe("a\nb\nc");
  });

  test("preserves a real data table (>=2 rows AND >=2 cols)", () => {
    const html = "<table><tr><th>Model</th><th>Price</th></tr><tr><td>GPT</td><td>$10</td></tr></table>";
    expect(unwrapLayoutTables(html)).toBe(html);
  });

  test("strips nested tags inside unwrapped cells", () => {
    const html = "<table><tr><td><p>Hello <strong>world</strong></p></td></tr></table>";
    expect(unwrapLayoutTables(html)).toBe("Hello world");
  });

  test("leaves surrounding content intact", () => {
    const html = "<p>before</p><table><tr><td>cell</td></tr></table><p>after</p>";
    expect(unwrapLayoutTables(html)).toBe("<p>before</p>cell<p>after</p>");
  });

  test("handles multiple tables independently", () => {
    const html =
      "<table><tr><td>layout</td></tr></table>" +
      "<table><tr><th>x</th><th>y</th></tr><tr><td>1</td><td>2</td></tr></table>";
    expect(unwrapLayoutTables(html)).toBe(
      "layout<table><tr><th>x</th><th>y</th></tr><tr><td>1</td><td>2</td></tr></table>",
    );
  });

  test("empty cells are dropped", () => {
    const html = "<table><tr><td>  </td></tr><tr><td>kept</td></tr></table>";
    expect(unwrapLayoutTables(html)).toBe("kept");
  });

  test("unwraps a multi-row multi-col table with block content in cells (pandoc would drop it)", () => {
    const html =
      '<table><tr><th>Title</th><th>Link</th></tr><tr><td><div class="titleline"><a href="u">Story</a></div></td><td>x</td></tr></table>';
    expect(unwrapLayoutTables(html)).toBe("Title\nLink\nStory\nx");
  });

  test("unwraps a table whose cell holds a list", () => {
    const html = "<table><tr><td><ul><li>a</li></ul></td><td>b</td></tr><tr><td>c</td><td>d</td></tr></table>";
    expect(unwrapLayoutTables(html)).toBe("a\nb\nc\nd");
  });

  test("preserves a data table whose cells hold only inline elements (center, span)", () => {
    const html =
      "<table><tr><th>a</th><th>b</th></tr><tr><td><center>x</center></td><td><span>y</span></td></tr></table>";
    expect(unwrapLayoutTables(html)).toBe(html);
  });
});

describe("spillToTmp / filenameForUrl", () => {
  test("filename is deterministic per URL", () => {
    expect(filenameForUrl("https://news.ycombinator.com/item?id=39865810")).toBe(
      filenameForUrl("https://news.ycombinator.com/item?id=39865810"),
    );
  });

  test("filename embeds host and slug, differs per URL", () => {
    const a = filenameForUrl("https://lobste.rs/s/abc/story-slug");
    const b = filenameForUrl("https://lobste.rs/s/def/other-slug");
    expect(a).toMatch(/^lobste\.rs-s-abc-story-slug-/);
    expect(b).not.toBe(a);
  });

  test("spill writes the file under the OS temp dir and returns its path", async () => {
    const path = await spillToTmp("https://example.com/spill-test", "hello spill");
    if (path === null) throw new Error("spill returned null");
    expect(path).toContain("pi-web-fetch");
    expect(await readFile(path, "utf8")).toBe("hello spill");
  });

  test("re-spilling the same URL overwrites the same file", async () => {
    const p1 = await spillToTmp("https://example.com/spill-test", "first");
    const p2 = await spillToTmp("https://example.com/spill-test", "second");
    expect(p1).toBe(p2);
  });
});

describe("cleanMarkdown", () => {
  test("strips data: URI images", () => {
    const input = "# Title\n\n![icon](data:image/svg+xml;base64,abc123)\n\nContent";
    expect(cleanMarkdown(input)).toBe("# Title\n\nContent");
  });

  test("strips data: URI image links (non-image reference)", () => {
    const input = "# Heading\n\n[](data:image/svg+xml;base64,abc123)\n\nText";
    expect(cleanMarkdown(input)).toBe("# Heading\n\nText");
  });

  test("strips nested image links (GitHub pattern)", () => {
    const input = "[![alt](https://example.com/img.png)](https://example.com/link)";
    expect(cleanMarkdown(input)).toBe("");
  });

  test("collapses excessive blank lines", () => {
    const input = "Line 1\n\n\n\n\nLine 2";
    expect(cleanMarkdown(input)).toBe("Line 1\n\nLine 2");
  });

  test("preserves normal markdown", () => {
    const input = "# Title\n\n- item 1\n- item 2\n\n[link](https://example.com)";
    expect(cleanMarkdown(input)).toBe(input);
  });

  test("preserves code blocks", () => {
    const input = "```c\nint main() {}\n```";
    expect(cleanMarkdown(input)).toBe(input);
  });
});
