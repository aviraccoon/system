/**
 * Synthetic cases for the gate's message question: did the report judge the
 * proposed commit message at all?
 *
 * Every case is written from scratch. `expected` is true when the report should
 * fail the question (it never addresses the message, or only quotes an earlier
 * round's verdict without asserting it still holds).
 */

import type { TestCase } from "./shared";

export type MessageGroup = "judged" | "unjudged" | "quoted" | "partial";

export interface MessageCase extends TestCase<boolean> {
  id: string;
  /** The message the dispatch proposed. */
  proposedMessage: string;
  /** The reviewer report. */
  input: string;
  group: MessageGroup;
  /** True when the report should fail to judge the message. */
  expected: boolean;
}

const MESSAGE = "feat(retry): bound attempts\n\nRetries stop after five attempts; the cap is a constant.";

export const MESSAGE_CASES: MessageCase[] = [
  {
    id: "code-only-clean",
    group: "unjudged",
    proposedMessage: MESSAGE,
    expected: true,
    input: [
      "## Findings",
      "",
      "No findings. I read the staged diff, both call sites, and the test that pins the retry path.",
      "The empty-list case returns the same value as before, and the new branch cannot run without a key.",
    ].join("\n"),
  },
  {
    id: "code-only-findings",
    group: "unjudged",
    proposedMessage: MESSAGE,
    expected: true,
    input: [
      "## Findings",
      "",
      "**MAJOR** — `src/retry.ts`: the loop drops the last element when `limit` is zero.",
      "",
      "checked: retry loop bounds, `src/retry.ts`.",
    ].join("\n"),
  },
  {
    id: "prose-only-no-message",
    group: "unjudged",
    proposedMessage: "docs(readme): clarify install",
    expected: true,
    input: "## Findings\n\n**MINOR** — the README's second paragraph repeats the intro.\n\nchecked: README prose.",
  },
  {
    id: "message-judged-clean",
    group: "judged",
    proposedMessage: MESSAGE,
    expected: false,
    input: [
      "## Findings",
      "",
      "None.",
      "",
      "The message's subject `feat(retry): bound attempts` matches the diff; the body's claim that the",
      "cap is a constant is supported by the new `MAX_ATTEMPTS` in `src/retry.ts`.",
      "",
      "checked: cap constant, `src/retry.ts`; subject and body claims against the staged diff.",
    ].join("\n"),
  },
  {
    id: "message-claim-unsupported",
    group: "judged",
    proposedMessage: MESSAGE,
    expected: false,
    input: [
      "## Findings",
      "",
      "**MAJOR** — the message says retries are configurable, but no hunk adds a configuration option.",
      "The only change is the constant in `src/retry.ts`.",
      "",
      "checked: message body claim against the diff.",
    ].join("\n"),
  },
  {
    id: "bare-message-fine",
    group: "judged",
    proposedMessage: MESSAGE,
    expected: false,
    input: "## Findings\n\nNone. The commit message is fine.\n\nchecked: staged diff, `src/retry.ts`.",
  },
  {
    id: "body-only-judged",
    group: "judged",
    proposedMessage: MESSAGE,
    expected: false,
    input: [
      "## Findings",
      "",
      "None.",
      "",
      "The body's sentence about the five-attempt cap matches the constant in `src/retry.ts`; I did not",
      "check the subject against the repository's conventions.",
      "",
      "checked: body claim against the diff.",
    ].join("\n"),
  },
  {
    id: "prior-round-quoted",
    group: "quoted",
    proposedMessage: MESSAGE,
    expected: true,
    input: [
      "## Findings",
      "",
      "Round 2's message review said the subject matched the diff; that is not re-checked here.",
      "No code findings.",
      "",
      "checked: staged diff.",
    ].join("\n"),
  },
  {
    id: "prior-round-asserted",
    group: "quoted",
    proposedMessage: MESSAGE,
    expected: false,
    input: [
      "## Findings",
      "",
      "None.",
      "",
      "The message is unchanged since round 2 and its subject still matches the diff; the body's",
      "constant claim still holds.",
      "",
      "checked: message unchanged against round 2, claims re-checked against `src/retry.ts`.",
    ].join("\n"),
  },
  {
    id: "message-not-reviewed",
    group: "partial",
    proposedMessage: MESSAGE,
    expected: true,
    input: [
      "## Findings",
      "",
      "No code findings. I did not review the commit message; the budget went to the retry paths.",
      "",
      "checked: retry paths, `src/retry.ts`.",
    ].join("\n"),
  },
  {
    id: "docs-message-judged",
    group: "judged",
    proposedMessage: "docs(readme): clarify install",
    expected: false,
    input:
      "## Findings\n\nNone. The message `docs(readme): clarify install` matches the only change, the install section.\n\nchecked: README hunk, subject claim.",
  },
  {
    id: "message-convention",
    group: "judged",
    proposedMessage: MESSAGE,
    expected: false,
    input: [
      "## Findings",
      "",
      "**NIT** — the message subject is 78 characters; the repository's log keeps subjects under 72.",
      "",
      "checked: `git log --oneline -10` for the subject convention; the body's claims match the diff.",
    ].join("\n"),
  },
];
