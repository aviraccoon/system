// Pure name matching for project/task/alias resolution.

export interface Candidate {
  id: number;
  name: string;
  code?: string | null;
  client?: string | null;
}

export type MatchResult<T> = { kind: "match"; item: T } | { kind: "ambiguous"; candidates: T[] } | { kind: "none" };

function normalize(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/[-_.]+/g, " ")
    .replace(/\s+/g, " ");
}

/**
 * Match a query against items by id (numeric query) or by name (and optional
 * code/client). Name tiers: exact name/code, starts-with, substring. Multiple
 * hits at the winning tier are ambiguous. Case-insensitive; -/_/space
 * equivalent. A numeric query matches by id only — no name fallback.
 */
export function matchOne<T extends Candidate>(query: string, items: T[]): MatchResult<T> {
  const q = normalize(query);
  if (q === "") return { kind: "none" };
  if (/^\d+$/.test(q)) {
    const hits = items.filter((item) => item.id === Number(q));
    if (hits.length === 1 && hits[0]) return { kind: "match", item: hits[0] };
    if (hits.length > 1) return { kind: "ambiguous", candidates: hits };
    return { kind: "none" };
  }
  for (const tier of [exact, startsWith, substring]) {
    const hits = items.filter((item) => tier(q, item));
    if (hits.length === 1 && hits[0]) return { kind: "match", item: hits[0] };
    if (hits.length > 1) return { kind: "ambiguous", candidates: hits };
  }
  return { kind: "none" };
}

function fields(item: Candidate): string[] {
  return [item.name, item.code ?? "", item.client ?? ""].map(normalize);
}

function exact(q: string, item: Candidate): boolean {
  return fields(item).some((f) => f !== "" && f === q);
}

function startsWith(q: string, item: Candidate): boolean {
  return fields(item).some((f) => f.startsWith(q));
}

function substring(q: string, item: Candidate): boolean {
  return fields(item).some((f) => f.includes(q));
}

/** Format candidates for an "ambiguous" error listing. */
export function formatCandidates<T extends Candidate>(items: T[]): string {
  return items.map((i) => `  ${i.id}  ${i.name}${i.code ? ` (${i.code})` : ""}`).join("\n");
}
