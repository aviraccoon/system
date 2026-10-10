import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { USER_AGENT } from "./feeds/http";
import {
  attachmentFilenameForUrl,
  buildNavHeaders,
  cleanMarkdown,
  filenameForUrl,
  NAV_HEADERS,
  parseEvalString,
  saveAttachmentToTmp,
  sessionName,
  spillToTmp,
  spoofUserAgent,
  stripAnsi,
  truncateContent,
  unwrapLayoutTables,
} from "./web-fetch";

describe("sessionName", () => {
  // sessionName reads PI_SUBAGENT; subagent shells run with it set, so the
  // block clears it before each test and restores it after.
  let prevSubagent: string | undefined;

  beforeEach(() => {
    prevSubagent = process.env.PI_SUBAGENT;
    delete process.env.PI_SUBAGENT;
  });

  afterEach(() => {
    if (prevSubagent === undefined) delete process.env.PI_SUBAGENT;
    else process.env.PI_SUBAGENT = prevSubagent;
  });

  test("derives from basename", () => {
    expect(sessionName("/Users/foo/bar-project")).toBe("pi-fetch-bar-project");
  });

  test("handles nested paths", () => {
    expect(sessionName("/Users/foo/dev/baz-app")).toBe("pi-fetch-baz-app");
  });

  test("appends a per-process discriminator for subagents", () => {
    process.env.PI_SUBAGENT = "1";
    expect(sessionName("/Users/foo/bar-project")).toBe(`pi-fetch-bar-project-p${process.pid}`);
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

describe("attachmentFilenameForUrl", () => {
  test("is deterministic per URL and keeps the URL extension", () => {
    const url = "https://forum.example.com/uploads/default/original/2X/4/clip.mp4";
    const name = attachmentFilenameForUrl(url);
    expect(name).toBe(attachmentFilenameForUrl(url));
    expect(name).toMatch(/^forum\.example\.com-uploads-default-original-2X-4-clip-/);
    expect(name.endsWith(".mp4")).toBe(true);
    expect(attachmentFilenameForUrl("https://forum.example.com/uploads/short-url/abc.pdf").endsWith(".pdf")).toBe(true);
  });

  test("falls back to .bin without an extension", () => {
    expect(attachmentFilenameForUrl("https://forum.example.com/download").endsWith(".bin")).toBe(true);
  });

  test("content type wins when it contradicts the URL extension", () => {
    const url = "https://forum.example.com/uploads/default/original/2X/4/clip.mp4";
    expect(attachmentFilenameForUrl(url, "image/png")).toMatch(/\.png$/);
    expect(attachmentFilenameForUrl(url, "video/mp4")).toMatch(/\.mp4$/);
    expect(attachmentFilenameForUrl(url, "image/jpeg; charset=binary")).toMatch(/\.jpg$/);
    expect(attachmentFilenameForUrl("https://forum.example.com/download", "application/pdf")).toMatch(/\.pdf$/);
    expect(attachmentFilenameForUrl("https://forum.example.com/uploads/default/2X/4/pic.jpeg", "image/jpeg")).toMatch(
      /\.jpeg$/,
    );
  });
});

describe("saveAttachmentToTmp", () => {
  /** Serve one canned response on an ephemeral port; returns the base URL. */
  async function withServer(
    handler: (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => void,
    fn: (base: string) => Promise<void>,
  ): Promise<void> {
    const server = createServer((req, res) => handler(req, res));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as { port: number };
    try {
      await fn(`http://127.0.0.1:${port}`);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  test("writes the body to a deterministic temp path with type and size", async () => {
    let seenHeader: string | undefined;
    await withServer(
      (req, res) => {
        seenHeader = req.headers["x-test"] as string | undefined;
        res.writeHead(200, { "content-type": "application/pdf", "content-length": "12" });
        res.end("hello attach");
      },
      async (base) => {
        const url = `${base}/files/report.pdf`;
        const saved = await saveAttachmentToTmp(url, { headers: { "X-Test": "abc" } });
        expect(seenHeader).toBe("abc");
        expect(saved.status).toBe(200);
        expect(saved.contentType).toBe("application/pdf");
        expect(saved.size).toBe(12);
        expect(saved.path).toMatch(/\.pdf$/);
        expect(await readFile(saved.path as string, "utf8")).toBe("hello attach");
        expect((await saveAttachmentToTmp(url)).path).toBe(saved.path);
      },
    );
  });

  test("a URL extension that contradicts the content type is corrected", async () => {
    await withServer(
      (_req, res) => {
        res.writeHead(200, { "content-type": "image/png", "content-length": "4" });
        res.end("png!");
      },
      async (base) => {
        const saved = await saveAttachmentToTmp(`${base}/clip.mp4`);
        expect(saved.path).toMatch(/\.png$/);
        expect(saved.contentType).toBe("image/png");
      },
    );
  });

  test("chunked success reports the bytes written", async () => {
    await withServer(
      (_req, res) => {
        res.writeHead(200, { "content-type": "application/octet-stream" });
        res.end("chunked body");
      },
      async (base) => {
        const saved = await saveAttachmentToTmp(`${base}/chunked-ok.bin`);
        expect(saved.path).not.toBeNull();
        expect(saved.size).toBe("chunked body".length);
      },
    );
  });

  /** Raw TCP server for stalls Bun's node:http can't produce (it auto-ends a
   * response when the handler returns): "chunked" sends headers plus one body
   * chunk and holds the connection open; "silent" never responds at all. */
  async function withRawServer(respond: "chunked" | "silent", fn: (base: string) => Promise<void>): Promise<void> {
    const server = createTcpServer((socket) => {
      if (respond === "silent") return;
      socket.once("data", () => {
        socket.write(
          "HTTP/1.1 200 OK\r\ncontent-type: application/octet-stream\r\ntransfer-encoding: chunked\r\n\r\n7\r\npartial\r\n",
        );
      });
    });
    server.unref();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as { port: number };
    try {
      await fn(`http://127.0.0.1:${port}`);
    } finally {
      server.close();
    }
  }

  test("a caller abort stops the download", async () => {
    await withRawServer("chunked", async (base) => {
      const ac = new AbortController();
      const pending = saveAttachmentToTmp(`${base}/abort.bin`, { signal: ac.signal });
      setTimeout(() => ac.abort(), 20);
      await expect(pending).rejects.toThrow();
    });
  });

  test("an already-aborted signal is honored", async () => {
    await withRawServer("chunked", async (base) => {
      const ac = new AbortController();
      ac.abort();
      await expect(saveAttachmentToTmp(`${base}/pre-aborted.bin`, { signal: ac.signal })).rejects.toThrow();
    });
  });

  test("a stalled download hits the deadline and leaves no part-file", async () => {
    await withRawServer("chunked", async (base) => {
      const url = `${base}/stall.bin`;
      const saved = await saveAttachmentToTmp(url, undefined, undefined, 40);
      expect(saved.path).toBeNull();
      expect(saved.reason).toBe("write-failed");
      expect(existsSync(join(tmpdir(), "pi-web-fetch", attachmentFilenameForUrl(url)))).toBe(false);
    });
  });

  test("a caller abort after the headers leave no part-file", async () => {
    await withRawServer("chunked", async (base) => {
      const url = `${base}/abort-file.bin`;
      const ac = new AbortController();
      const pending = saveAttachmentToTmp(url, { signal: ac.signal });
      setTimeout(() => ac.abort(), 20);
      await expect(pending).rejects.toThrow();
      expect(existsSync(join(tmpdir(), "pi-web-fetch", attachmentFilenameForUrl(url)))).toBe(false);
    });
  });

  test("a deadline before the response headers declines the save", async () => {
    await withRawServer("silent", async (base) => {
      const saved = await saveAttachmentToTmp(`${base}/silent.bin`, undefined, undefined, 40);
      expect(saved.status).toBe(0);
      expect(saved.path).toBeNull();
      expect(saved.reason).toBe("write-failed");
    });
  });

  test("a caller abort before the response headers propagates", async () => {
    await withRawServer("silent", async (base) => {
      const ac = new AbortController();
      const pending = saveAttachmentToTmp(`${base}/silent-abort.bin`, { signal: ac.signal });
      setTimeout(() => ac.abort(), 20);
      await expect(pending).rejects.toThrow();
    });
  });

  test("a declared size over the cap leaves no file", async () => {
    await withServer(
      (_req, res) => {
        res.writeHead(200, { "content-type": "application/octet-stream", "content-length": "100" });
        // Two chunks: the early content-length check never reads them (size stays
        // 100); a streaming-only check would trip on the first 60-byte chunk.
        res.write("x".repeat(60));
        setTimeout(() => {
          if (!res.destroyed) res.end("x".repeat(40));
        }, 5);
      },
      async (base) => {
        const saved = await saveAttachmentToTmp(`${base}/big.bin`, undefined, 10);
        expect(saved.path).toBeNull();
        expect(saved.reason).toBe("too-large");
        expect(saved.size).toBe(100);
      },
    );
  });

  test("a chunked body over the cap stops mid-stream and leaves no file", async () => {
    await withServer(
      (_req, res) => {
        res.writeHead(200, { "content-type": "application/octet-stream" });
        res.write("x".repeat(40));
        res.end("x".repeat(40));
      },
      async (base) => {
        const url = `${base}/chunked.bin`;
        const saved = await saveAttachmentToTmp(url, undefined, 10);
        expect(saved.path).toBeNull();
        expect(saved.reason).toBe("too-large");
        expect(saved.size).toBeGreaterThan(10);
        expect(existsSync(join(tmpdir(), "pi-web-fetch", attachmentFilenameForUrl(url)))).toBe(false);
      },
    );
  });

  test("a write failure reports instead of throwing", async () => {
    await withServer(
      (_req, res) => {
        res.writeHead(200, { "content-type": "application/octet-stream", "content-length": "4" });
        res.end("data");
      },
      async (base) => {
        const url = `${base}/blocked.bin`;
        // Occupy the deterministic target path with a directory so the stream can't open it.
        const target = join(tmpdir(), "pi-web-fetch", attachmentFilenameForUrl(url));
        await mkdir(target, { recursive: true });
        try {
          const saved = await saveAttachmentToTmp(url);
          expect(saved.path).toBeNull();
          expect(saved.reason).toBe("write-failed");
        } finally {
          await rm(target, { recursive: true, force: true });
        }
      },
    );
  });

  test("an error status reports without writing", async () => {
    await withServer(
      (_req, res) => {
        res.writeHead(404, { "content-type": "text/html" });
        res.end("nope");
      },
      async (base) => {
        const saved = await saveAttachmentToTmp(`${base}/missing.pdf`, undefined);
        expect(saved.status).toBe(404);
        expect(saved.path).toBeNull();
        expect(saved.reason).toBeUndefined();
      },
    );
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
