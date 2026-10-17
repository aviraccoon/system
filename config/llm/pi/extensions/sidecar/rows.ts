/**
 * Row model for the /sidecar-models picker.
 *
 * Pure: no pi imports. The caller passes in the models the registry reports as available.
 *
 * Every chain member gets a row, including one with no available model: availability is
 * provider-scoped and vanishes with a credential, so nothing is dropped here and the
 * positions always match the stored chain. The README carries the reasoning.
 */

import type { ModelEntry } from "../shared/model-roles";

/** A model the registry reports as available. */
export interface AvailableModel {
  ref: string;
  name: string;
  provider: string;
  modelId: string;
}

export interface ChainRow {
  ref: string;
  /** Catalog name; the ref for a chain member with no available model. */
  name: string;
  provider: string;
  modelId: string;
  inChain: boolean;
  /** 1-based fallback position; 0 when not in the chain. */
  position: number;
  /** False for a chain member with no matching available model. */
  available: boolean;
}

/**
 * Split a `provider/model-id` ref. A ref without a slash reads as all model id.
 *
 * Total where `model-roles.parseRef` is nullable, on purpose: the runtime skips an
 * unparseable entry, while a row still has to show it.
 */
export function splitRef(ref: string): { provider: string; modelId: string } {
  const slash = ref.indexOf("/");
  if (slash === -1) return { provider: "", modelId: ref };
  return { provider: ref.slice(0, slash), modelId: ref.slice(slash + 1) };
}

/**
 * Chain members first, in chain order, then every available model that is not in the
 * chain. Positions are 1-based chain indices, so the number on a row always equals the
 * row's place in the fallback order shown above it.
 */
export function buildRows(chain: readonly ModelEntry[], available: readonly AvailableModel[]): ChainRow[] {
  const availableByRef = new Map(available.map((model) => [model.ref, model]));
  const rows: ChainRow[] = [];
  const seen = new Set<string>();

  chain.forEach((entry, index) => {
    // A hand-edited roles.json can carry a non-string ref; give it a row rather than throw.
    const ref = typeof entry.ref === "string" ? entry.ref : String(entry.ref);
    const model = availableByRef.get(ref);
    const parsed = splitRef(ref);
    rows.push({
      ref,
      name: model?.name ?? ref,
      provider: model?.provider ?? parsed.provider,
      modelId: model?.modelId ?? parsed.modelId,
      inChain: true,
      position: index + 1,
      available: model !== undefined,
    });
    seen.add(ref);
  });

  for (const model of available) {
    if (seen.has(model.ref)) continue;
    rows.push({ ...model, inChain: false, position: 0, available: true });
  }

  return rows;
}

/**
 * Insert `entries` at the head or the tail. The head is what runs, so adding there makes
 * the added model primary.
 */
export function placeInChain(
  chain: readonly ModelEntry[],
  entries: readonly ModelEntry[],
  placement: "head" | "tail",
): ModelEntry[] {
  return placement === "head" ? [...entries, ...chain] : [...chain, ...entries];
}
