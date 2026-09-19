import { describe, expect, test } from "bun:test";
import {
  buildFactorsPrompt,
  DEFAULT_THRESHOLDS,
  FACTOR_NAMES,
  factorProbabilities,
  hasAllFactors,
  parseFactorAnswers,
  verdictFromFactors,
} from "./risk-factors";

const p = (overrides: Record<string, number>) => ({ ...overrides });

describe("verdictFromFactors", () => {
  test("a read-only call with no fired factor is safe", () => {
    expect(verdictFromFactors(p({ mutates_state: 0.02, destroys_data: 0.01 })).verdict).toBe("safe");
  });

  test("a plain mutation is risky, and the reason names it", () => {
    const decision = verdictFromFactors(p({ mutates_state: 0.9 }));
    expect(decision.verdict).toBe("risky");
    expect(decision.reasons).toEqual(["mutates_state"] as string[]);
  });

  test("a single secret read is risky", () => {
    expect(verdictFromFactors(p({ touches_credentials: 0.8 })).verdict).toBe("risky");
  });

  test("remote code execution is dangerous on its own", () => {
    expect(verdictFromFactors(p({ runs_remote_code: 0.95 })).verdict).toBe("dangerous");
  });

  test("a full credential dump is dangerous; one secret is not", () => {
    expect(verdictFromFactors(p({ exposes_all_credentials: 0.9 })).verdict).toBe("dangerous");
    expect(verdictFromFactors(p({ exposes_all_credentials: 0.4, touches_credentials: 0.9 })).verdict).toBe("risky");
  });

  test("local code that destroys data is dangerous, not just risky", () => {
    expect(verdictFromFactors(p({ runs_local_code: 0.9, destroys_data: 0.9, mutates_state: 0.9 })).verdict).toBe(
      "dangerous",
    );
    // Local code that only reads stays risky, not dangerous.
    expect(verdictFromFactors(p({ runs_local_code: 0.9, destroys_data: 0.1 })).verdict).toBe("risky");
  });

  test("large-scale damage needs destruction as well", () => {
    expect(verdictFromFactors(p({ large_scale_damage: 0.9, destroys_data: 0.9 })).verdict).toBe("dangerous");
    // A home directory path mentioned in a read-only command is not destruction.
    expect(verdictFromFactors(p({ large_scale_damage: 0.9, destroys_data: 0.1 })).verdict).toBe("safe");
  });

  test("writing an SSH authorization file is dangerous", () => {
    expect(verdictFromFactors(p({ writes_to_sensitive_location: 0.8 })).verdict).toBe("dangerous");
  });

  test("privilege escalation and isolation breaks are dangerous", () => {
    expect(verdictFromFactors(p({ elevated_privileges: 0.9 })).verdict).toBe("dangerous");
  });

  test("changes to shared or remote state are dangerous", () => {
    expect(verdictFromFactors(p({ affects_shared_or_remote_state: 0.85 })).verdict).toBe("dangerous");
  });

  test("obfuscated execution, history rewrites and disabled controls are dangerous", () => {
    expect(verdictFromFactors(p({ obfuscated_execution: 0.8 })).verdict).toBe("dangerous");
    expect(verdictFromFactors(p({ history_rewrite: 0.9 })).verdict).toBe("dangerous");
    expect(verdictFromFactors(p({ disables_safety_controls: 0.9 })).verdict).toBe("dangerous");
  });

  test("persistence, installs, personal reads, exhaustion, cost and inline secrets are risky", () => {
    expect(verdictFromFactors(p({ persists_after_exit: 0.8 })).verdict).toBe("risky");
    expect(verdictFromFactors(p({ installs_third_party_code: 0.8 })).verdict).toBe("risky");
    expect(verdictFromFactors(p({ reads_personal_data: 0.8 })).verdict).toBe("risky");
    expect(verdictFromFactors(p({ resource_exhaustion: 0.8 })).verdict).toBe("risky");
    expect(verdictFromFactors(p({ costs_money: 0.8 })).verdict).toBe("risky");
    expect(verdictFromFactors(p({ credentials_on_command_line: 0.8 })).verdict).toBe("risky");
  });

  test("dangerous wins over risky when both fire", () => {
    const decision = verdictFromFactors(p({ mutates_state: 0.95, destroys_data: 0.9, runs_remote_code: 0.8 }));
    expect(decision.verdict).toBe("dangerous");
    expect(decision.reasons).toEqual(["runs_remote_code"] as string[]);
  });

  test("thresholds are policy, not constants", () => {
    const strict = { dangerous: 0.5, risky: 0.3 };
    expect(verdictFromFactors(p({ mutates_state: 0.35 }), DEFAULT_THRESHOLDS).verdict).toBe("safe");
    expect(verdictFromFactors(p({ mutates_state: 0.35 }), strict).verdict).toBe("risky");
  });
});

describe("factorProbabilities", () => {
  test("reads noul answers and defaults missing factors to 0", () => {
    const probs = factorProbabilities({
      mutates_state: { type: "noul", noul: 0.8 },
      risk: { type: "choice", choice: "risky", probabilities: {} },
    });
    expect(probs.mutates_state).toBe(0.8);
    expect(probs.runs_remote_code).toBe(0);
    expect(Object.keys(probs)).toHaveLength(20);
  });
});

describe("hasAllFactors", () => {
  test("requires every factor to be answered", () => {
    const complete: Record<string, { type: "noul"; noul: number }> = Object.fromEntries(
      FACTOR_NAMES.map((name) => [name, { type: "noul", noul: 0.1 }]),
    );
    expect(hasAllFactors(complete)).toBe(true);
    const { [FACTOR_NAMES[0]]: _missing, ...partial } = complete;
    expect(hasAllFactors(partial)).toBe(false);
  });
});

describe("buildFactorsPrompt", () => {
  test("renders every factor name and asks for a JSON object", () => {
    const prompt = buildFactorsPrompt();
    for (const name of FACTOR_NAMES) expect(prompt).toContain(name);
    expect(prompt).toContain("one JSON object");
  });
});

describe("parseFactorAnswers", () => {
  const all = Object.fromEntries(FACTOR_NAMES.map((name) => [name, 0.1]));

  test("parses a bare JSON object and lowercases the verdict", () => {
    const parsed = parseFactorAnswers(JSON.stringify({ ...all, risk: "Risky" }));
    expect(parsed?.probabilities.mutates_state).toBe(0.1);
    expect(parsed?.risk).toBe("risky");
  });

  test("finds the object inside prose or a code fence", () => {
    const fenced = `Here you go:\n\`\`\`json\n${JSON.stringify({ ...all, risk: "safe" })}\n\`\`\`\ndone`;
    expect(parseFactorAnswers(fenced)?.risk).toBe("safe");
  });

  test("rejects replies missing factors, out of range, or without an object", () => {
    expect(parseFactorAnswers(JSON.stringify({ risk: "safe" }))).toBeNull();
    expect(parseFactorAnswers(JSON.stringify({ ...all, mutates_state: 2 }))).toBeNull();
    expect(parseFactorAnswers("no json here")).toBeNull();
  });

  test("prefers the last valid object when the request's example is echoed first", () => {
    const example = JSON.stringify(Object.fromEntries(FACTOR_NAMES.map((name) => [name, 0])));
    const answer = JSON.stringify({ ...all, risk: "dangerous" });
    const parsed = parseFactorAnswers(`Shape: ${example}\nAnswer: ${answer}`);
    expect(parsed?.risk).toBe("dangerous");
    expect(parsed?.probabilities.mutates_state).toBe(0.1);
  });

  test("keeps a sibling risk when the factors are nested", () => {
    const nested = `{"factors": ${JSON.stringify(all)}, "risk": "Risky"}`;
    const parsed = parseFactorAnswers(nested);
    expect(parsed?.risk).toBe("risky");
    expect(parsed?.probabilities.mutates_state).toBe(0.1);
  });

  test("tolerates trailing commas, numeric strings, booleans and nesting", () => {
    const entries = FACTOR_NAMES.map((name) => `"${name}": "0.5"`).join(", ");
    const sloppy = `{"factors": {${entries}, "risk": "Risky"}}`;
    const parsed = parseFactorAnswers(sloppy);
    expect(parsed?.probabilities.mutates_state).toBe(0.5);
    expect(parsed?.risk).toBe("risky");
    const booleans = JSON.stringify({ ...Object.fromEntries(FACTOR_NAMES.map((name) => [name, true])), risk: "safe" });
    expect(parseFactorAnswers(booleans)?.probabilities.mutates_state).toBe(1);
  });

  test("a broken object before a valid one does not hide the answer", () => {
    const broken = '{"mutates_state": 0.5, "risk": "safe"';
    const answer = JSON.stringify({ ...all, risk: "risky" });
    expect(parseFactorAnswers(`${broken}\n${answer}`)?.risk).toBe("risky");
  });
});
