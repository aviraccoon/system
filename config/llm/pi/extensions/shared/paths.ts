/** Path helpers shared by extensions. */

import { homedir } from "node:os";
import { join } from "node:path";

/** Git expands a leading `~/` itself; `path.resolve` does not. */
export function expandTilde(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return join(homedir(), value.slice(2));
  return value;
}
