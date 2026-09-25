/**
 * Stash of blocked write content — a mkdtemp dir per stash: unpredictable
 * name (symlink-safe on shared tmpdirs) and collision-free between blocked
 * writes. The file is 0600 so the stashed content stays private.
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function stashWriteContent(rel: string, content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "edit-guard-write-"));
  const name = rel
    .replace(/[^a-zA-Z0-9._-]/g, "-")
    .slice(0, 80)
    .replace(/^\.+$/, "");
  const stashPath = join(dir, name || "blocked-write");
  writeFileSync(stashPath, content, { mode: 0o600 });
  return stashPath;
}
