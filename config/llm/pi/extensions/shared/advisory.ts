/**
 * Advisories: typed questions the permission gate asks alongside the risk
 * battery on shell calls, each with the policy that turns its answer into an
 * action.
 *
 * What they measure is workflow waste, not danger. Output-capture is a long
 * diagnostic whose output reaches the reader only through a filter or
 * /dev/null, which forces a full re-run once the filtered view proves
 * insufficient. The patch reminder is a shell rewrite of a real file, which
 * hides the applied change and turns an unmatched edit into a silent no-op.
 */

import type { DecisionsAnswer, DecisionsQuestion } from "./decisions";

export type AdviceAction = "block" | "note";

export interface Advice {
  /** Key the question is sent under and its score is carried under. */
  name: string;
  question: DecisionsQuestion;
  /** At or above this noul the advisory acts. */
  threshold: number;
  action: AdviceAction;
  /** What the advice says when it fires: a block reason, or a result note. */
  text: string;
}

export const ADVICE_QUESTION: DecisionsQuestion = {
  type: "noul",
  instructions:
    "Does this call run a long diagnostic operation — a test suite, build, typecheck or lint gate, benchmark, codegen, or a project-defined check task — and show that operation's own output only through an inline filter (a pipe into head, tail, grep, awk or sed) or by discarding it to /dev/null, instead of capturing it into a file? Reading a captured file back is cheap; re-running the operation is expensive. Silencing known-noise segments (like a formatter) is fine; the diagnostic operation itself must land in a file — an exit-code echo does not replace its output.",
  criteria: {
    true: "It runs such a long diagnostic operation — including through a task runner whose task name is the only hint — and that operation's own output reaches the reader only through a filter pipe or /dev/null (an exit-code echo does not count as output), with no redirect of that operation's output to a file anywhere in the command.",
    false:
      "The operation's output is redirected to a file — reading slices of that file back with tail or grep is the correct shape — or the filtered or discarded output belongs to a genuinely short, small-output operation (listing files, version and status checks) where the filter is the point, or only noise segments (formatters) are silenced while the diagnostic operation is captured to a file or runs visibly.",
  },
};

/** The shell-rewrite question. Its false side carries the escapes: the edit
 *  tools cannot reach a container or remote host, and a new file (a script
 *  written with a heredoc) is a create, not a rewrite. */
export const PATCH_REMINDER_QUESTION: DecisionsQuestion = {
  type: "noul",
  instructions:
    "Does this call replace the content of an existing persistent file through the shell instead of a dedicated edit tool?",
  criteria: {
    true: "An existing file's content is replaced through the shell — an in-place editor (sed -i, perl -i), an inline interpreter script that opens and writes a file, tee onto it or a redirect over it — and the file is reachable by the edit tools.",
    false:
      "The rewrite happens where the edit tools cannot reach — inside docker exec, ssh or kubectl exec, or on a remote or container-only path; or the call creates a new file (a script written with a heredoc), writes scratch or generated output, runs a formatter or other bulk transform the edit tools cannot reproduce, or only reads.",
  },
};

/**
 * The patch reminder fires as a note, never a block. The shape that needs it —
 * an inline interpreter writing a file — cannot always be told apart from one
 * with no choice, so a miscalibrated threshold costs a stray reminder instead of
 * a dead call. edit-guard's in-place rule owns the blocking version, for the two
 * shapes it can see in the command text (`sed -i`, `perl -i`).
 */
const PATCH_REMINDER: Advice = {
  name: "patch",
  question: PATCH_REMINDER_QUESTION,
  // Threshold from the patch-reminder bench (`BENCH_QUESTION=patch`): re-measure
  // it there when the question or its escapes change. Note-only, so a
  // miscalibrated threshold costs a stray reminder.
  threshold: 0.7,
  action: "note",
  text:
    "[patch] this call rewrote a file through the shell. " +
    "The patch tool refuses an unmatched edit and shows the diff it applied; use it when the file is reachable " +
    "(inside a container or over SSH, the shell is the only option). Either way, read the file back to confirm " +
    "the change landed as intended — a rewrite that matched nothing still exits successfully.",
};

/**
 * Output-capture blocks with a capture rewrite. Threshold from the
 * output-capture bench (`BENCH_GROUP=output-capture`): re-measure it there when
 * the question or its cases change.
 */
const OUTPUT_CAPTURE: Advice = {
  name: "advice",
  question: ADVICE_QUESTION,
  threshold: 0.6,
  action: "block",
  text:
    "output-capture: this call was blocked and did not run. " +
    "It filters or discards a long diagnostic's output (tests, build, typecheck, lint) instead of capturing " +
    "it, so a filtered view that falls short forces a full re-run. " +
    "Re-issue the command with the diagnostic's output redirected to a file (… > /tmp/<name>.log 2>&1), " +
    "then read or filter that file. Reading a captured file back is cheap; re-running the operation is not.",
};

/** The advices asked on a shell call: a classified call is never the confined
 *  shell (the gate returns before classifying it), so both apply. */
export const SHELL_ADVICES: readonly Advice[] = [OUTPUT_CAPTURE, PATCH_REMINDER];

export function adviceByName(name: string): Advice | undefined {
  return SHELL_ADVICES.find((advice) => advice.name === name);
}

export function adviceQuestions(advices: readonly Advice[]): Record<string, DecisionsQuestion> {
  return Object.fromEntries(advices.map((advice) => [advice.name, advice.question]));
}

/** The battery's scores for these advices. A non-noul answer is skipped. */
export function adviceScores(
  answers: Record<string, DecisionsAnswer>,
  advices: readonly Advice[],
): Record<string, number> {
  const scores: Record<string, number> = {};
  for (const advice of advices) {
    const answer = answers[advice.name];
    if (answer?.type === "noul") scores[advice.name] = answer.noul;
  }
  return scores;
}

export function adviceFires(advice: Pick<Advice, "threshold">, score: number | undefined): boolean {
  return score !== undefined && score >= advice.threshold;
}

/** Attach the scores to a classification result and append them to its detail,
 *  so the session log (and the dialog, at the noise floor) carries them for
 *  tuning. The result type is structural: shared code cannot import
 *  permission-gate. */
export function withAdviceScores<T extends { detail: string }>(
  result: T,
  scores: Record<string, number>,
): T & { advices: Record<string, number> } {
  const lines = Object.entries(scores).map(([name, score]) => `${name} ${score.toFixed(2)}`);
  return {
    ...result,
    advices: scores,
    detail: lines.length === 0 ? result.detail : `${result.detail}\n${lines.join("\n")}`,
  };
}

/**
 * The gate's advisory interception: a block reason only when the call would
 * otherwise proceed silently (an auto-allow) and a blocking advice crosses its
 * threshold. A call that opens a dialog anyway needs no advisory block — the
 * dialog already shows the command and the score line.
 */
export function adviceInterception(
  scores: Record<string, number> | undefined,
  action: "allow" | "confirm" | "block",
): { block: true; reason: string } | null {
  if (action !== "allow" || !scores) return null;
  for (const advice of SHELL_ADVICES) {
    if (advice.action !== "block") continue;
    if (adviceFires(advice, scores[advice.name])) return { block: true, reason: advice.text };
  }
  return null;
}

/** The notes for note-action advices that fired, ready to append to a result. */
function firedNotes(scores: Record<string, number> | undefined): string[] {
  if (!scores) return [];
  return SHELL_ADVICES.filter((advice) => advice.action === "note" && adviceFires(advice, scores[advice.name])).map(
    (advice) => advice.text,
  );
}

/** The notes a classification result carries, joined, or undefined. */
export function adviceNoteText(result: { advices?: Record<string, number> } | null | undefined): string | undefined {
  const notes = firedNotes(result?.advices);
  return notes.length > 0 ? notes.join("\n\n") : undefined;
}
