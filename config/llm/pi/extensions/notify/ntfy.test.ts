import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Fetcher, ntfyUrl, push, resolveNtfyUrl } from "./ntfy";

describe("ntfyUrl", () => {
  test("a bare topic becomes an ntfy.sh URL", () => {
    expect(ntfyUrl("acme-alerts")).toBe("https://ntfy.sh/acme-alerts");
  });

  test("a full URL passes through", () => {
    expect(ntfyUrl("http://ntfy.internal:8080/alerts")).toBe("http://ntfy.internal:8080/alerts");
  });

  test("surrounding whitespace is ignored", () => {
    expect(ntfyUrl("  alerts \n")).toBe("https://ntfy.sh/alerts");
  });

  test("an empty value configures nothing", () => {
    expect(ntfyUrl(undefined)).toBeUndefined();
    expect(ntfyUrl("   ")).toBeUndefined();
  });
});

describe("resolveNtfyUrl", () => {
  function fileWith(contents: string): string {
    const dir = mkdtempSync(join(tmpdir(), "notify-test-"));
    const path = join(dir, "ntfy-url");
    writeFileSync(path, contents);
    return path;
  }

  test("a configured value wins over the file", () => {
    expect(resolveNtfyUrl("configured", fileWith("from-file"))).toBe("https://ntfy.sh/configured");
  });

  test("the file is the fallback, first line only", () => {
    expect(resolveNtfyUrl(undefined, fileWith("from-file\nignored\n"))).toBe("https://ntfy.sh/from-file");
  });

  test("a missing file configures nothing", () => {
    expect(resolveNtfyUrl(undefined, join(tmpdir(), "notify-test-does-not-exist", "ntfy-url"))).toBeUndefined();
  });

  test("an unreadable path configures nothing instead of throwing", () => {
    expect(resolveNtfyUrl(undefined, mkdtempSync(join(tmpdir(), "notify-test-dir-")))).toBeUndefined();
  });
});

describe("push", () => {
  test("posts the title, body, priority and tags", async () => {
    const requests: Array<{
      title: string | null;
      body: string;
      priority: string | null;
      tags: string | null;
    }> = [];
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        requests.push({
          title: request.headers.get("Title"),
          body: await request.text(),
          priority: request.headers.get("Priority"),
          tags: request.headers.get("Tags"),
        });
        return new Response("ok");
      },
    });
    try {
      const result = await push(`http://127.0.0.1:${server.port}/alerts`, {
        title: "pi needs you",
        body: "acme, a dialog is waiting",
        priority: "high",
      });
      expect(result).toEqual({ sent: true });
      expect(requests).toEqual([
        {
          title: "pi needs you",
          body: "acme, a dialog is waiting",
          priority: "high",
          tags: "robot",
        },
      ]);
    } finally {
      server.stop(true);
    }
  });

  test("a non-2xx reply is a failure with the status in the reason", async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response("no", { status: 507 }) });
    try {
      const result = await push(`http://127.0.0.1:${server.port}/alerts`, { title: "t", body: "b" });
      expect(result.sent).toBe(false);
      expect(result.reason).toBe("ntfy replied 507");
    } finally {
      server.stop(true);
    }
  });

  test("a failure reason does not leak the topic", async () => {
    const url = "https://ntfy.sh/secret-topic";
    const failing: Fetcher = async (target) => {
      throw new Error(`connect failed for ${target}`);
    };
    const result = await push(url, { title: "t", body: "b" }, failing);
    expect(result.sent).toBe(false);
    expect(result.reason).toContain("<ntfy>");
    expect(result.reason).not.toContain("secret-topic");
  });
});
