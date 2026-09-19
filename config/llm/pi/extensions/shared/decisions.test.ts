import { describe, expect, test } from "bun:test";
import { buildDecisionsBody, parseDecisionsResponse } from "./decisions";

const RESPONSE = {
  model: "typesafe/jev-1.13-20260917",
  provider: "TypeSafe",
  answers: {
    risk: {
      type: "choice",
      choice: "dangerous",
      confidence: 1,
      probabilities: { safe: 0, risky: 0.02, dangerous: 0.98 },
    },
    touches_credentials: { type: "noul", noul: 0.38 },
    severity: {
      type: "score",
      score: 2.4,
      confidence: 0.5,
      probabilities: { "0": 0, "1": 0.1, "2": 0.4, "3": 0.5 },
      legend: { "0": "none", "3": "severe" },
    },
  },
  usage: { input_tokens: 499, output_tokens: 81, cost: 0.000020958 },
};

describe("buildDecisionsBody", () => {
  test("sends model, state and questions as given", () => {
    const body = buildDecisionsBody({
      model: "typesafe/jev-1.13",
      state: { tool: "bash", command: "rm -rf /" },
      questions: { risk: { type: "noul", instructions: "Is it dangerous?" } },
    });
    expect(body).toEqual({
      model: "typesafe/jev-1.13",
      state: { tool: "bash", command: "rm -rf /" },
      questions: { risk: { type: "noul", instructions: "Is it dangerous?" } },
    });
  });
});

describe("parseDecisionsResponse", () => {
  test("reads choice, noul and score answers with usage", () => {
    const result = parseDecisionsResponse(RESPONSE, 300);
    expect(result.model).toBe("typesafe/jev-1.13-20260917");
    expect(result.provider).toBe("TypeSafe");
    expect(result.ms).toBe(300);
    expect(result.usage).toEqual({ inputTokens: 499, outputTokens: 81, cost: 0.000020958 });

    const risk = result.answers.risk;
    expect(risk.type).toBe("choice");
    if (risk.type === "choice") {
      expect(risk.choice).toBe("dangerous");
      expect(risk.probabilities.dangerous).toBeCloseTo(0.98);
      expect(risk.confidence).toBe(1);
    }

    const creds = result.answers.touches_credentials;
    if (creds.type === "noul") expect(creds.noul).toBeCloseTo(0.38);

    const severity = result.answers.severity;
    if (severity.type === "score") {
      expect(severity.score).toBeCloseTo(2.4);
      expect(severity.legend?.["3"]).toBe("severe");
    }
  });

  test("tolerates a missing usage block", () => {
    const result = parseDecisionsResponse({ model: "m", answers: { a: { type: "noul", noul: 0.5 } } }, 1);
    expect(result.usage).toEqual({ inputTokens: 0, outputTokens: 0, cost: 0 });
  });

  test("rejects malformed answers instead of dropping them", () => {
    expect(() => parseDecisionsResponse("nope", 1)).toThrow(/not an object/);
    expect(() => parseDecisionsResponse({ answers: null }, 1)).toThrow(/no answers/);
    expect(() => parseDecisionsResponse({ answers: { a: {} } }, 1)).toThrow(/no type/);
    expect(() => parseDecisionsResponse({ answers: { a: { type: "noul" } } }, 1)).toThrow(/no noul value/);
    expect(() => parseDecisionsResponse({ answers: { a: { type: "choice", choice: "x" } } }, 1)).toThrow(
      /not a readable choice/,
    );
    expect(() => parseDecisionsResponse({ answers: { a: { type: "future" } } }, 1)).toThrow(/unknown type/);
  });
});
