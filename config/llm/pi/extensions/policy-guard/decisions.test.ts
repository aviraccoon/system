import { describe, expect, test } from "bun:test";
import {
  COMMAND_LIMIT,
  commandLine,
  formatDecision,
  type GuardDecision,
  parseDecisions,
  sessionView,
  trimLines,
} from "./decisions";

const record = (over: Partial<GuardDecision> = {}): GuardDecision => ({
  at: "2026-01-01T00:00:00.000Z",
  session: "s-1",
  project: "acme",
  kind: "policy",
  command: "pnpm install --frozen-lockfile",
  violated: true,
  clause: "deps",
  probability: 0.91,
  threshold: 0.65,
  ...over,
});

describe("formatDecision and parseDecisions", () => {
  test("a record survives a trip through one line", () => {
    const written = formatDecision(record());
    expect(written.split("\n").filter(Boolean)).toHaveLength(1);
    expect(parseDecisions(written)).toEqual([record()]);
  });

  test("a truncated last line is dropped, since a killed process leaves one", () => {
    const written = formatDecision(record()) + formatDecision(record({ command: "second" }));
    const truncated = written.slice(0, written.length - 20);
    const parsed = parseDecisions(truncated);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.command).toBe("pnpm install --frozen-lockfile");
  });

  test("a line with the wrong shape is skipped rather than guessed at", () => {
    const parsed = parseDecisions(`${JSON.stringify({ at: "x" })}\nnot json\n${formatDecision(record())}`);
    expect(parsed).toHaveLength(1);
  });
});

describe("trimLines", () => {
  test("keeps the tail when the file is over the limit, and leaves a short one alone", () => {
    const long = Array.from({ length: 5 }, (_, index) => `line-${index}`).join("\n");
    expect(trimLines(long, 2)).toBe("line-3\nline-4\n");
    expect(trimLines(long, 10)).toBe(long);
  });
});

describe("commandLine", () => {
  test("keeps the first line and clips the rest", () => {
    const long = `${"a".repeat(COMMAND_LIMIT + 20)}\nsecond line`;
    const line = commandLine(long);
    expect(line.endsWith("…")).toBe(true);
    expect(line.length).toBe(COMMAND_LIMIT);
    expect(line).not.toContain("second line");
  });
});

describe("sessionView", () => {
  test("shows only the session it was asked about", () => {
    const view = sessionView([record({ session: "s-1" }), record({ session: "s-2", command: "other" })], "s-1");
    expect(view.join("\n")).toContain("pnpm install");
    expect(view.join("\n")).not.toContain("other");
  });

  test("never shows the probability, which the file keeps for calibration", () => {
    const view = sessionView([record({ probability: 0.9137 })], "s-1");
    expect(view.join("\n")).not.toContain("0.91");
    expect(view.join("\n")).not.toContain("threshold");
  });

  test("names what refused, and says when the judge cleared a call", () => {
    const view = sessionView(
      [
        record(),
        record({ kind: "policy-write", command: ".agents/policy.json", clause: null }),
        record({ violated: false, clause: null, command: "git status" }),
      ],
      "s-1",
    );
    expect(view[0]).toContain("refused");
    expect(view[0]).toContain("deps");
    expect(view[1]).toContain("policy file write");
    expect(view[2]).toBe("- allowed  git status");
  });

  test("shows the newest records when a session has more than the limit", () => {
    const many = Array.from({ length: 25 }, (_, index) => record({ command: `cmd-${index}` }));
    const view = sessionView(many, "s-1");
    expect(view).toHaveLength(20);
    expect(view.at(-1)).toContain("cmd-24");
    expect(view.join("\n")).not.toContain("cmd-4 ");
  });
});
