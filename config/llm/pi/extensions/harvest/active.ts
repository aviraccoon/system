/**
 * Whether the harvest pill is active for a session: the project's meta.json
 * carries a `harvest` flag. Reads the notes tree, no harvest CLI call.
 */

import { harvestEnabled, loadProjectMeta, projectFor } from "../shared/journal-context";

/** Whether the project owning `cwd` opts into the pill. The flag rule is
 * `harvestEnabled`, shared with the journal context so the pill and the injected
 * policy cannot disagree. */
export async function harvestActive(notesDir: string, cwd: string): Promise<boolean> {
  const { dir } = projectFor(notesDir, cwd);
  const meta = await loadProjectMeta(dir);
  return harvestEnabled(meta?.harvest);
}
