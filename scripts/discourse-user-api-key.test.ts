import { describe, expect, test } from "bun:test";
import { join } from "node:path";

async function run(...args: string[]): Promise<{ code: number; stderr: string }> {
  const proc = Bun.spawn([process.execPath, join(import.meta.dir, "discourse-user-api-key.ts"), ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  return { code, stderr };
}

describe("CLI", () => {
  test("a missing forum is one line and exit 2", async () => {
    const result = await run();
    expect(result.code).toBe(2);
    expect(result.stderr.trim()).toBe("error: discourse-user-api-key: missing <forum-origin>");
  });

  test("an origin without a scheme is rejected separately", async () => {
    const result = await run("forum.example.com");
    expect(result.code).toBe(2);
    expect(result.stderr.trim()).toBe('error: discourse-user-api-key: invalid forum origin "forum.example.com"');
  });
});
