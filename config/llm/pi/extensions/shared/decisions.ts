/**
 * Client for TypeSafe "System One" decision models (Jev), via OpenRouter.
 *
 * These models do not speak chat/completions: a request carries a state plus
 * typed questions, and the response carries typed answers with probabilities.
 * Chat-shaped calls to the same model are rejected by OpenRouter, so this is a
 * small direct HTTP client rather than a provider entry. No pi imports — usable
 * from extensions and benchmarks alike.
 *
 * Reference: https://docs.typesafe.ai/primitives
 */

export interface NoulQuestion {
  type: "noul";
  instructions: string;
  criteria?: { true?: string; false?: string };
}

export interface ChoiceQuestion {
  type: "choice";
  instructions: string;
  criteria: Record<string, string>;
}

export interface ScoreQuestion {
  type: "score";
  instructions: string;
  criteria: string[];
}

export type DecisionsQuestion = NoulQuestion | ChoiceQuestion | ScoreQuestion;

export interface NoulAnswer {
  type: "noul";
  /** Probability that the answer is true, 0–1. */
  noul: number;
}

export interface ChoiceAnswer {
  type: "choice";
  choice: string;
  confidence?: number;
  probabilities: Record<string, number>;
}

export interface ScoreAnswer {
  type: "score";
  score: number;
  confidence?: number;
  probabilities: Record<string, number>;
  legend?: Record<string, string>;
}

export type DecisionsAnswer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

export interface DecisionsRequest {
  model: string;
  /** The material the questions are answered against: string, object or array. */
  state: unknown;
  questions: Record<string, DecisionsQuestion>;
}

export interface DecisionsUsage {
  inputTokens: number;
  outputTokens: number;
  cost: number;
}

export interface DecisionsResult {
  model: string;
  provider?: string;
  answers: Record<string, DecisionsAnswer>;
  usage: DecisionsUsage;
  /** Wall-clock time for the request. */
  ms: number;
}

export const DEFAULT_DECISIONS_URL = "https://openrouter.ai/api/alpha/decisions";

export interface DecisionsOptions {
  apiKey: string;
  baseUrl?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export function buildDecisionsBody(request: DecisionsRequest): Record<string, unknown> {
  return { model: request.model, state: request.state, questions: request.questions };
}

function objectAt(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function numberAt(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function probabilitiesAt(value: unknown): Record<string, number> | null {
  const raw = objectAt(value);
  if (!raw) return null;
  const out: Record<string, number> = {};
  for (const [key, prob] of Object.entries(raw)) {
    const n = numberAt(prob);
    if (n === null) return null;
    out[key] = n;
  }
  return out;
}

/**
 * Parse a response body into typed answers. Unknown or malformed answers are an
 * error rather than a silent omission: a caller that reads `answers["risk"]`
 * should never have to wonder whether the key is missing because the model
 * declined or because parsing dropped it.
 */
export function parseDecisionsResponse(raw: unknown, ms: number): DecisionsResult {
  const body = objectAt(raw);
  if (!body) throw new Error("decisions: response is not an object");
  const model = typeof body.model === "string" ? body.model : "";
  const rawAnswers = objectAt(body.answers);
  if (!rawAnswers) throw new Error("decisions: response has no answers object");

  const answers: Record<string, DecisionsAnswer> = {};
  for (const [id, value] of Object.entries(rawAnswers)) {
    const answer = objectAt(value);
    const type = answer?.type;
    if (!answer || type === undefined) throw new Error(`decisions: answer "${id}" has no type`);
    if (type === "noul") {
      const noul = numberAt(answer.noul);
      if (noul === null) throw new Error(`decisions: answer "${id}" has no noul value`);
      answers[id] = { type, noul };
      continue;
    }
    if (type === "choice") {
      const choice = answer.choice;
      const probabilities = probabilitiesAt(answer.probabilities);
      if (typeof choice !== "string" || !probabilities) {
        throw new Error(`decisions: answer "${id}" is not a readable choice`);
      }
      answers[id] = { type, choice, probabilities, confidence: numberAt(answer.confidence) ?? undefined };
      continue;
    }
    if (type === "score") {
      const score = numberAt(answer.score);
      const probabilities = probabilitiesAt(answer.probabilities);
      if (score === null || !probabilities) throw new Error(`decisions: answer "${id}" is not a readable score`);
      answers[id] = {
        type,
        score,
        probabilities,
        confidence: numberAt(answer.confidence) ?? undefined,
        legend: objectAt(answer.legend) as Record<string, string> | undefined,
      };
      continue;
    }
    throw new Error(`decisions: answer "${id}" has unknown type "${String(type)}"`);
  }

  const usage = objectAt(body.usage) ?? {};
  return {
    model: model || "unknown",
    provider: typeof body.provider === "string" ? body.provider : undefined,
    answers,
    usage: {
      inputTokens: numberAt(usage.input_tokens) ?? 0,
      outputTokens: numberAt(usage.output_tokens) ?? 0,
      cost: numberAt(usage.cost) ?? 0,
    },
    ms,
  };
}

export async function decisionsComplete(
  request: DecisionsRequest,
  options: DecisionsOptions,
): Promise<DecisionsResult> {
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? 30_000;
  const timer = setTimeout(() => controller.abort(new Error(`decisions: timed out after ${timeoutMs}ms`)), timeoutMs);
  const forwardAbort = () => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) forwardAbort();
  else options.signal?.addEventListener("abort", forwardAbort, { once: true });

  const started = performance.now();
  try {
    const response = await fetch(options.baseUrl ?? DEFAULT_DECISIONS_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${options.apiKey}`,
      },
      body: JSON.stringify(buildDecisionsBody(request)),
      signal: controller.signal,
    });
    const ms = Math.round(performance.now() - started);
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`decisions: HTTP ${response.status}: ${text.slice(0, 300)}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`decisions: response is not JSON: ${text.slice(0, 200)}`);
    }
    return parseDecisionsResponse(parsed, ms);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", forwardAbort);
  }
}
