/**
 * Test-only: run git fixtures against an empty global and system config.
 *
 * Without this, a fixture inherits the developer's `commit.gpgsign` (which needs
 * a signing agent the test host may not have) and their `core.hooksPath` (which
 * would run the installed gate's hooks inside the fixture). Each call returns
 * its own restore, so two test files cannot clobber each other's saved state.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const KEYS = ["GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM", "GIT_CONFIG_NOSYSTEM"] as const;

export function isolateGitConfig(): () => void {
  const dir = mkdtempSync(join(tmpdir(), "review-gate-config-"));
  const empty = join(dir, "gitconfig");
  writeFileSync(empty, "");
  const saved = new Map<string, string | undefined>();
  for (const key of KEYS) saved.set(key, process.env[key]);
  process.env.GIT_CONFIG_GLOBAL = empty;
  process.env.GIT_CONFIG_SYSTEM = empty;
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  return () => {
    for (const key of KEYS) {
      const value = saved.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  };
}
