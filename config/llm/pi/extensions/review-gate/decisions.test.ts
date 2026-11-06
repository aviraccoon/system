import { describe, expect, test } from "bun:test";
import { formatDecisions, parseDecisions } from "./decisions";

const line = (at: string, decision: string, reason: string) =>
  `${at}\t${decision}\t/acme/repo\t${"a".repeat(40)}\t${reason}`;

describe("decision log", () => {
  test("keeps the last N lines, oldest first", () => {
    const text = [
      line("2026-01-01T00:00:00Z", "passed", "reviewed"),
      line("2026-01-01T00:00:01Z", "refused", "no-review"),
      line("2026-01-01T00:00:02Z", "skipped", "no-marker"),
    ].join("\n");
    expect(parseDecisions(text, 2).map((decision) => decision.decision)).toEqual(["refused", "skipped"]);
  });

  test("a malformed line is skipped rather than guessed at", () => {
    const text = ["at\tpassed\tonly-three", "", line("2026-01-01T00:00:00Z", "passed", "reviewed"), "garbage"].join(
      "\n",
    );
    const decisions = parseDecisions(text);
    expect(decisions).toHaveLength(1);
    expect(decisions[0].decision).toBe("passed");
    // Too many fields is malformed too: a tab in a repo path must not shift the columns.
    expect(parseDecisions("a\tb\tc\td\te\tf")).toEqual([]);
  });

  test("an empty log has nothing to show, and a count of zero shows nothing", () => {
    expect(parseDecisions("")).toEqual([]);
    expect(parseDecisions(line("2026-01-01T00:00:00Z", "passed", "reviewed"), 0)).toEqual([]);
    expect(formatDecisions([])).toBe("No commit decisions recorded.");
  });

  test("a decision with no tree says so instead of printing a dash", () => {
    const rendered = formatDecisions(
      parseDecisions(`${line("2026-01-01T00:00:00Z", "skipped", "no-marker")}`.replace(/\t(a+)\t/, "\t-\t")),
    );
    expect(rendered).toContain("(none)");
    expect(rendered).not.toContain("a".repeat(8));
  });

  test("a line carries the short tree and the reason, and no placeholder reason", () => {
    const rendered = formatDecisions(parseDecisions(line("2026-01-01T00:00:00Z", "skipped", "-")));
    expect(rendered).toContain("skipped");
    expect(rendered).toContain("aaaaaaaa");
    expect(rendered).not.toContain("a".repeat(9));
    expect(rendered.trim().endsWith("/acme/repo")).toBe(true);
  });
});
