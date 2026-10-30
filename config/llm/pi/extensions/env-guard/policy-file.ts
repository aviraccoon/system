/**
 * Parse and validate a project's environment policy file:
 * `~/notes/llm/<project>/.agents/environment.json`.
 *
 * A hand-edited file gets one parser and one report. Every entry the parser
 * drops is named, and any error makes the policy inactive rather than half
 * applied: a guard that silently runs on three of five clauses is worse than no
 * guard, because the refusal looks authoritative while the exception it was
 * supposed to honor is missing.
 */

import type { EnvPolicy, PolicyClause } from "../shared/env-policy";

export interface PolicyFileResult {
  /** Null when the file has any error; the caller then runs without a guard. */
  policy: EnvPolicy | null;
  errors: string[];
}

const TOP_KEYS = new Set(["project", "environment", "binding", "clauses", "precedence"]);
const CLAUSE_KEYS = new Set(["id", "text"]);
const BINDING_KEYS = new Set(["command", "workdir"]);

function objectAt(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function textAt(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function unknownKeys(value: Record<string, unknown>, allowed: Set<string>, where: string, errors: string[]): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) errors.push(`${where}: unknown key "${key}" (dropped; allowed: ${[...allowed].join(", ")})`);
  }
}

export function parsePolicyFile(raw: string): PolicyFileResult {
  const errors: string[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { policy: null, errors: [`not valid JSON: ${err instanceof Error ? err.message : String(err)}`] };
  }
  const top = objectAt(parsed);
  if (!top) return { policy: null, errors: ["the file must be a JSON object"] };
  unknownKeys(top, TOP_KEYS, "policy", errors);

  const project = textAt(top.project);
  if (!project) errors.push('"project" must be a non-empty string');
  const environment = textAt(top.environment);
  if (!environment) errors.push('"environment" must be a non-empty string (for example "the devcontainer")');

  const clauses: PolicyClause[] = [];
  const rawClauses = top.clauses;
  if (!Array.isArray(rawClauses) || rawClauses.length === 0) {
    errors.push('"clauses" must be a non-empty array of { "id", "text" }');
  } else {
    const seen = new Set<string>();
    rawClauses.forEach((entry, index) => {
      const clause = objectAt(entry);
      if (!clause) {
        errors.push(`clauses[${index}] must be an object`);
        return;
      }
      unknownKeys(clause, CLAUSE_KEYS, `clauses[${index}]`, errors);
      const id = textAt(clause.id);
      const text = textAt(clause.text);
      if (!id) errors.push(`clauses[${index}].id must be a non-empty string`);
      if (!text) errors.push(`clauses[${index}].text must be a non-empty string`);
      if (id && seen.has(id))
        errors.push(`clauses[${index}].id "${id}" is a duplicate; clause ids are the citation key`);
      if (id) seen.add(id);
      if (id && text) clauses.push({ id, text });
    });
  }

  let binding: EnvPolicy["binding"] = null;
  if (top.binding !== undefined && top.binding !== null) {
    const raw = objectAt(top.binding);
    if (!raw) {
      errors.push('"binding" must be an object or null');
    } else {
      unknownKeys(raw, BINDING_KEYS, "binding", errors);
      const command = textAt(raw.command);
      const workdir = textAt(raw.workdir);
      if (!command) errors.push('"binding.command" must be a non-empty string');
      if (!workdir) errors.push('"binding.workdir" must be a non-empty string');
      if (command && workdir) binding = { command, workdir };
    }
  }

  let precedence: string | undefined;
  if (top.precedence !== undefined) {
    const text = textAt(top.precedence);
    if (!text) errors.push('"precedence" must be a non-empty string when present');
    else precedence = text;
  }

  if (errors.length > 0 || !project || !environment) return { policy: null, errors };
  return { policy: { project, environment, binding, clauses, precedence }, errors };
}
