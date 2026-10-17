import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { notify, ntfyUrl, resolveNtfyUrl } from "./notify";

test("a bare topic becomes an ntfy.sh URL", () => {
  expect(ntfyUrl("acme-0123456789")).toBe("https://ntfy.sh/acme-0123456789");
  expect(ntfyUrl("  spaced-topic ")).toBe("https://ntfy.sh/spaced-topic");
});

test("a URL is taken as given", () => {
  expect(ntfyUrl("https://ntfy.example.com/topic")).toBe("https://ntfy.example.com/topic");
  expect(ntfyUrl("http://localhost:8080/topic")).toBe("http://localhost:8080/topic");
});

test("nothing configured resolves to undefined", () => {
  expect(ntfyUrl()).toBeUndefined();
  expect(ntfyUrl("   ")).toBeUndefined();
});

test("the configured value wins over the file, which is the fallback", () => {
  const dir = mkdtempSync(join(tmpdir(), "raccache-notify-"));
  const file = join(dir, "ntfy-url");
  writeFileSync(file, "https://ntfy.sh/from-file\n");
  expect(resolveNtfyUrl(file, "from-env")).toBe("https://ntfy.sh/from-env");
  expect(resolveNtfyUrl(file)).toBe("https://ntfy.sh/from-file");
  expect(resolveNtfyUrl(join(dir, "missing"))).toBeUndefined();
});

test("a bare topic from the secrets env is posted as a URL", async () => {
  const calls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request) => {
    calls.push(String(url));
    return new Response("ok", { status: 200 });
  }) as typeof fetch;
  try {
    expect(await notify("/nonexistent", { title: "t", message: "m", url: "acme-topic" })).toEqual({ sent: true });
    expect(calls).toEqual(["https://ntfy.sh/acme-topic"]);
  } finally {
    globalThis.fetch = original;
  }
});

test("a refused request reports the status", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response("nope", { status: 403 })) as unknown as typeof fetch;
  try {
    expect(await notify("/nonexistent", { title: "t", message: "m", url: "acme-topic" })).toEqual({
      sent: false,
      reason: "ntfy replied 403",
    });
  } finally {
    globalThis.fetch = original;
  }
});

test("a failed request reports why without leaking the topic", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new TypeError("Unable to connect to https://ntfy.sh/acme-topic");
  }) as unknown as typeof fetch;
  try {
    const result = await notify("/nonexistent", { title: "t", message: "m", url: "acme-topic" });
    expect(result.sent).toBe(false);
    expect(result.reason).toContain("<ntfy>");
    expect(result.reason).not.toContain("acme-topic");
  } finally {
    globalThis.fetch = original;
  }
});

test("no URL at all is reported as such", async () => {
  expect(await notify("/nonexistent", { title: "t", message: "m" })).toEqual({
    sent: false,
    reason: "no ntfy URL configured",
  });
});
