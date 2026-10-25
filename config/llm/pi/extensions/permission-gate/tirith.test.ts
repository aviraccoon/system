import { describe, expect, it } from "bun:test";
import { formatFindingSummary, parseTirith, tirithFact, tirithFloor } from "./tirith";

// Trimmed from real tirith `check --format json` output (schema v3).
const blockJson = {
  action: "block",
  findings: [
    {
      rule_id: "curl_pipe_shell",
      severity: "HIGH",
      title: "Pipe to interpreter: curl | bash",
      description: "Command pipes output from 'curl' directly to interpreter 'bash'.",
    },
  ],
};

const criticalJson = {
  action: "block",
  findings: [
    {
      rule_id: "unicode_tags",
      severity: "Critical",
      title: "Unicode Tag characters",
      description: "Tag characters encode hidden ASCII.",
    },
  ],
};

const warnJson = {
  action: "warn",
  findings: [{ rule_id: "lookalike_tld", severity: "MEDIUM", title: "Lookalike TLD", description: "d" }],
};

const allowJson = { action: "allow", findings: [] };

describe("parseTirith", () => {
  it("maps a block and carries the rule fields", () => {
    const report = parseTirith(blockJson, 1);
    expect(report.action).toBe("block");
    expect(report.findings[0]).toEqual({
      severity: "HIGH",
      ruleId: "curl_pipe_shell",
      title: "Pipe to interpreter: curl | bash",
      description: "Command pipes output from 'curl' directly to interpreter 'bash'.",
    });
  });

  it("maps a warn and an allow", () => {
    expect(parseTirith(warnJson, 2).action).toBe("warn");
    expect(parseTirith(allowJson, 0).action).toBe("pass");
  });

  it("falls back to exit codes when JSON is absent", () => {
    expect(parseTirith(null, 1).action).toBe("block");
    expect(parseTirith(null, 2).action).toBe("warn");
    expect(parseTirith(null, 0).action).toBe("pass");
    expect(parseTirith(null, 99).action).toBe("pass");
  });

  it("treats an unknown action with a block exit as a block", () => {
    // A renamed tier must not read as a pass.
    expect(parseTirith({ action: "deny", findings: [] }, 1).action).toBe("block");
  });
});

describe("tirithFloor", () => {
  it("holds on a CRITICAL finding", () => {
    expect(tirithFloor(parseTirith(criticalJson, 1))).toBe(true);
  });

  it("does not hold on a HIGH finding — that is the classifier's to weigh", () => {
    expect(tirithFloor(parseTirith(blockJson, 1))).toBe(false);
  });

  it("holds on a block carrying no finding or no severity", () => {
    expect(tirithFloor(parseTirith({ action: "block", findings: [] }, 1))).toBe(true);
    expect(tirithFloor(parseTirith(null, 1))).toBe(true);
  });

  it("holds on a block whose finding carries no severity to read", () => {
    expect(tirithFloor(parseTirith({ action: "block", findings: [{ rule_id: "x", title: "t" }] }, 1))).toBe(true);
  });

  it("holds on a warning that carries a CRITICAL finding", () => {
    // The action a report carries follows tirith's config; the severity is the invariant.
    expect(
      tirithFloor(parseTirith({ action: "warn", findings: [{ rule_id: "x", severity: "CRITICAL", title: "t" }] }, 2)),
    ).toBe(true);
  });

  it("does not hold on a warning below CRITICAL", () => {
    expect(tirithFloor(parseTirith(warnJson, 2))).toBe(false);
  });

  it("does not hold when there is nothing to report", () => {
    expect(tirithFloor(parseTirith(allowJson, 0))).toBe(false);
  });
});

describe("tirithFact", () => {
  it("says what tirith is and lists every finding", () => {
    const fact = tirithFact(parseTirith(criticalJson, 1));
    expect(fact).toContain("command-safety checker");
    expect(fact).toContain("threat lists");
    expect(fact).toContain("[Critical] unicode_tags — Unicode Tag characters");
    expect(fact).toContain("Tag characters encode hidden ASCII.");
  });

  it("is empty when there is nothing to report", () => {
    expect(tirithFact(parseTirith(allowJson, 0))).toBe("");
  });
});

describe("formatFindingSummary", () => {
  it("joins the rules for the dialog banner", () => {
    const summary = formatFindingSummary(parseTirith(blockJson, 1));
    expect(summary).toContain("[HIGH] curl_pipe_shell: Pipe to interpreter: curl | bash");
  });
});
