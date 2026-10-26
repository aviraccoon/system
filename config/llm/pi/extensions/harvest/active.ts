/**
 * Whether the harvest pill is active for a session: the project's meta.json
 * carries a `harvest` flag. Reads the notes tree, no harvest CLI call.
 */

import { loadProjectMeta, projectFor } from "../shared/journal-context";
import { harvestEnabled } from "../shared/project-meta";

/** Whether the project owning `cwd` opts into the pill. The parser keeps
 * `harvest` only for a declared flag, so the pill and the injected policy read
 * one normalized value. */
export async function harvestActive(notesDir: string, cwd: string): Promise<boolean> {
  const { dir } = projectFor(notesDir, cwd);
  const { meta } = await loadProjectMeta(dir);
  return harvestEnabled(meta);
}
