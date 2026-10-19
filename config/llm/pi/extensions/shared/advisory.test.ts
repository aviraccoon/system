import { describe, expect, test } from "bun:test";
import {
  ADVICE_QUESTION,
  adviceByName,
  adviceFires,
  adviceInterception,
  adviceNoteText,
  adviceQuestions,
  adviceScores,
  PATCH_REMINDER_QUESTION,
  SHELL_ADVICES,
  withAdviceScores,
} from "./advisory";

const capture = adviceByName("advice");
const patch = adviceByName("patch");
if (!capture || !patch) throw new Error("the advisory registry is missing an entry");

describe("advisory questions", () => {
  test("every advisory is a noul with criteria on both sides", () => {
    for (const advice of SHELL_ADVICES) {
      expect(advice.question.type).toBe("noul");
      if (advice.question.type !== "noul" || !advice.question.criteria) throw new Error("unexpected shape");
      expect(typeof advice.question.criteria.true).toBe("string");
      expect(typeof advice.question.criteria.false).toBe("string");
    }
  });

  test("the patch question's false side carries both escapes", () => {
    if (PATCH_REMINDER_QUESTION.type !== "noul" || !PATCH_REMINDER_QUESTION.criteria) {
      throw new Error("unexpected shape");
    }
    // Where the edit tools cannot reach the file, and a new file (a create).
    const no = PATCH_REMINDER_QUESTION.criteria.false ?? "";
    for (const escapeCase of ["docker exec", "ssh", "new file"]) {
      expect(no).toContain(escapeCase);
    }
  });

  test("questions are keyed by the advisory's own name", () => {
    expect(adviceQuestions(SHELL_ADVICES)).toEqual({ advice: ADVICE_QUESTION, patch: PATCH_REMINDER_QUESTION });
  });
});

describe("advisory policy", () => {
  test("fires at or above its own threshold only", () => {
    expect(adviceFires(capture, capture.threshold)).toBe(true);
    expect(adviceFires(capture, capture.threshold - 0.01)).toBe(false);
    expect(adviceFires(patch, patch.threshold)).toBe(true);
    expect(adviceFires(patch, patch.threshold - 0.01)).toBe(false);
    expect(adviceFires(capture, undefined)).toBe(false);
  });

  test("only the blocking advisory intercepts, and only on an auto-allow", () => {
    expect(adviceInterception({ advice: 0.95, patch: 0.95 }, "allow")).toMatchObject({ block: true });
    expect(adviceInterception({ advice: 0.5, patch: 0.95 }, "allow")).toBeNull();
    expect(adviceInterception({ advice: 0.95 }, "confirm")).toBeNull();
    expect(adviceInterception({ advice: 0.95 }, "block")).toBeNull();
    expect(adviceInterception(undefined, "allow")).toBeNull();
  });

  test("the block reason says the call did not run and names the capture", () => {
    const reason = adviceInterception({ advice: 0.95 }, "allow")?.reason ?? "";
    expect(reason).toContain("output-capture");
    expect(reason).toContain("did not run");
    expect(reason).toContain("/tmp/<name>.log");
  });

  test("only the note advice contributes a note", () => {
    expect(adviceNoteText({ advices: { advice: 0.95, patch: 0.95 } })).toContain("[patch]");
    expect(adviceNoteText({ advices: { patch: 0.5 } })).toBeUndefined();
    expect(adviceNoteText(undefined)).toBeUndefined();
  });

  test("the patch note names the tool, both exceptions, and the read-back", () => {
    const note = patch?.text ?? "";
    expect(note).toContain("[patch]");
    expect(note).toContain("container");
    expect(note).toContain("SSH");
    expect(note).toContain("read the file back");
  });

  test("scores are read by name and a non-noul answer is skipped", () => {
    const scores = adviceScores(
      {
        advice: { type: "noul", noul: 0.7 },
        patch: { type: "choice", choice: "yes", probabilities: {} },
      },
      SHELL_ADVICES,
    );
    expect(scores).toEqual({ advice: 0.7 });
  });

  test("adviceNoteText joins the fired notes and is undefined when none did", () => {
    expect(adviceNoteText({ advices: { patch: 0.95, advice: 0.1 } })).toContain("[patch]");
    expect(adviceNoteText({ advices: { patch: 0.1 } })).toBeUndefined();
    expect(adviceNoteText({})).toBeUndefined();
    expect(adviceNoteText(null)).toBeUndefined();
  });

  test("withAdviceScores carries the map and appends one line per score", () => {
    const result = withAdviceScores({ verdict: "safe", short: "s", detail: "d" }, { advice: 0.42, patch: 0.9 });
    expect(result.detail).toBe("d\nadvice 0.42\npatch 0.90");
    expect(result.advices).toEqual({ advice: 0.42, patch: 0.9 });
    expect(result.verdict).toBe("safe");
    // No scores, no trailing newline.
    expect(withAdviceScores({ detail: "d" }, {}).detail).toBe("d");
  });
});
