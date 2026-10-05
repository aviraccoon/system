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
    .replace(/\s*\/\s*/g, "/")
    .replace(/\s+/g, " ");
}

/**
 * Match a query against items by id (numeric query) or by name (and optional
 * code/client). Name tiers: exact name/code/client/client-name, starts-with,
 * substring. Multiple hits at the winning tier are ambiguous. Case-insensitive;
 * - _ . are equivalent to spaces, and spaces around / are ignored, so the
 * `client / name` form `projects` prints is matchable. A numeric query matches
 * by id only — no name fallback.
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
  const name = normalize(item.name);
  const code = normalize(item.code ?? "");
  const client = normalize(item.client ?? "");
  const fields = [name, code, client];
  // The "client / name" form printed by `projects` is itself a matchable name.
  // Normalize the raw joined string, not the normalized parts: a client ending
  // in a separator would keep a stray space ("acme inc /website") the query
  // pass never produces. A query without a slash can only hit this field where
  // the client or name field already hits at the same tier, so plain name
  // matching keeps its precedence.
  if (name !== "" && client !== "") fields.push(normalize(`${item.client ?? ""} / ${item.name}`));
  return fields;
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
  return items
    .map((i) => `  ${i.id}  ${i.client ? `${i.client} / ` : ""}${i.name}${i.code ? ` (${i.code})` : ""}`)
    .join("\n");
}
