import type { KeyId } from "@earendil-works/pi-tui";

/** How a chord reads in the UI: `ctrl+shift+c` becomes `Ctrl+Shift+C`. */
export function shortcutLabel(id: KeyId): string {
  return id
    .split("+")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("+");
}
