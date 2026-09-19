import { describe, expect, it } from "bun:test";
import {
  formatBlockReason,
  formatFindingSummary,
  formatVerdictSummary,
  mapTirithResult,
  type TirithFinding,
  tirithAnnotation,
  tirithForcesReview,
  tirithNote,
} from "./tirith";

// Captured from real tirith 0.3.1 `check --format json` output (schema v3).
const blockJson = {
  schema_version: 3,
  action: "block",
  findings: [
    {
      rule_id: "curl_pipe_shell",
      severity: "HIGH",
      title: "Pipe to interpreter: curl | bash",
      description:
        "Command pipes output from 'curl' directly to interpreter 'bash'.\n  Safer: tirith run https://evil.example/install.sh",
      evidence: [],
      mitre_id: "T1059.004",
    },
  ],
};

const multiJson = {
  schema_version: 3,
  action: "block",
  findings: [
    {
      rule_id: "pipe_to_interpreter",
      severity: "HIGH",
      title: "Pipe to interpreter: base64 | bash",
      description: "d1",
    },
    {
      rule_id: "base64_decode_execute",
      severity: "HIGH",
      title: "Base64 decode piped to interpreter",
      description: "d2",
    },
  ],
};

const warnJson = {
  schema_version: 3,
  action: "warn",
  findings: [
    { rule_id: "shortened_url", severity: "MEDIUM", title: "Shortened URL", description: "Resolve before trusting." },
  ],
};

// Trimmed from tirith 0.4.2 output for `pip install somepkg`: a warn whose only
// finding is a runtime package-intel lookup gap.
const warnCoverageGapJson = {
  schema_version: 3,
  action: "warn",
  findings: [
    {
      rule_id: "analysis_incomplete",
      severity: "MEDIUM",
      title: "Package threat intelligence could not be completed",
      description: "This is incomplete verification, not evidence that the package is malicious.",
    },
  ],
};

const allowJson = { schema_version: 3, action: "allow", findings: [] };

// Trimmed from tirith 0.4.2 output for `for d in …; do n=$(rg …); done`.
// `analysis_incomplete` means "could not prove it", which is not a detection;
// blocking it rejects shell whose body is right there in the source.
const coverageGapJson = {
  schema_version: 3,
  action: "block",
  tier_reached: 3,
  findings: [
    {
      rule_id: "analysis_incomplete",
      severity: "HIGH",
      title: "Nested executable body could not be resolved",
      description: "The command is blocked instead of trusting its benign-looking outer leader.",
    },
    { rule_id: "analysis_incomplete", severity: "HIGH", title: "nested command analysis was incomplete" },
  ],
};

describe("mapTirithResult", () => {
  it("downgrades a coverage-gap-only block to a warning (tirith #260)", () => {
    const v = mapTirithResult(coverageGapJson, 1);
    expect(v.action).toBe("warn");
    if (v.action !== "warn") throw new Error("unreachable");
    expect(v.findings).toHaveLength(2);
    // The downgrade has to be visible downstream: the findings keep HIGH
    // severity, so consumers must read the flag, not the text.
    expect(v.coverageGap).toBe(true);
  });

  it("keeps the block when a real detection accompanies a coverage gap", () => {
    const v = mapTirithResult(
      {
        action: "block",
        findings: [
          { rule_id: "analysis_incomplete", severity: "HIGH", title: "coverage gap" },
          { rule_id: "curl_pipe_shell", severity: "HIGH", title: "Pipe to interpreter" },
        ],
      },
      1,
    );
    expect(v.action).toBe("block");
    if (v.action !== "block") throw new Error("unreachable");
    expect(v.reason).toContain("curl_pipe_shell");
  });

  it("keeps a block that carries no findings (cannot classify, stay fail-closed)", () => {
    expect(mapTirithResult({ action: "block", findings: [] }, 1).action).toBe("block");
  });

  it("maps a block action, carrying rule + remedy into the reason", () => {
    const v = mapTirithResult(blockJson, 1);
    expect(v.action).toBe("block");
    if (v.action !== "block") throw new Error("unreachable");
    expect(v.reason).toContain("curl_pipe_shell");
    expect(v.reason).toContain("[HIGH]");
    expect(v.reason).toContain("Safer: tirith run");
    expect(v.findings[0].severity).toBe("HIGH");
    expect(v.findings[0].ruleId).toBe("curl_pipe_shell");
  });

  it("joins multiple findings in the reason", () => {
    const v = mapTirithResult(multiJson, 1);
    expect(v.action).toBe("block");
    if (v.action !== "block") throw new Error("unreachable");
    expect(v.reason).toContain("pipe_to_interpreter");
    expect(v.reason).toContain("base64_decode_execute");
    expect(v.findings).toHaveLength(2);
  });

  it("maps a warn action (the force-confirm case)", () => {
    const v = mapTirithResult(warnJson, 2);
    expect(v.action).toBe("warn");
    if (v.action !== "warn") throw new Error("unreachable");
    expect(v.findings[0].ruleId).toBe("shortened_url");
    // Not a downgrade: tirith itself said warn.
    expect(v.coverageGap).toBeUndefined();
  });

  it("marks a warn whose findings are all coverage gaps", () => {
    const v = mapTirithResult(warnCoverageGapJson, 2);
    expect(v.action).toBe("warn");
    if (v.action !== "warn") throw new Error("unreachable");
    expect(v.coverageGap).toBe(true);
  });

  it("maps allow → pass", () => {
    expect(mapTirithResult(allowJson, 0).action).toBe("pass");
  });

  it("falls back to exit codes when JSON is absent", () => {
    expect(mapTirithResult(null, 1).action).toBe("block");
    expect(mapTirithResult(null, 2).action).toBe("warn");
    expect(mapTirithResult(null, 0).action).toBe("pass");
  });

  it("falls back to pass on unknown exit code or missing action field", () => {
    expect(mapTirithResult(null, 99).action).toBe("pass");
    expect(mapTirithResult({ findings: [] }, 0).action).toBe("pass");
  });

  it("treats malformed JSON as null (fail-open via exit code)", () => {
    // safeParse is internal; mapTirithResult(null, 0) models a parse failure on a clean exit.
    expect(mapTirithResult(null, 0).action).toBe("pass");
  });
});

describe("tirithForcesReview", () => {
  it("holds for a block", () => {
    expect(tirithForcesReview(mapTirithResult(blockJson, 1))).toBe(true);
  });

  it("holds for a warn that reports a detection", () => {
    expect(tirithForcesReview(mapTirithResult(warnJson, 2))).toBe(true);
  });

  it("does not hold for a coverage-gap downgrade (not a detection)", () => {
    expect(tirithForcesReview(mapTirithResult(coverageGapJson, 1))).toBe(false);
  });

  it("does not hold for a warn-level coverage gap", () => {
    expect(tirithForcesReview(mapTirithResult(warnCoverageGapJson, 2))).toBe(false);
  });

  it("does not hold for pass", () => {
    expect(tirithForcesReview(mapTirithResult(allowJson, 0))).toBe(false);
  });
});

describe("tirithNote", () => {
  it("carries a block's finding to the model", () => {
    const note = tirithNote(mapTirithResult(blockJson, 1));
    expect(note).toContain("command-safety checker");
    expect(note).toContain("curl_pipe_shell");
  });

  it("carries a real warn's finding", () => {
    expect(tirithNote(mapTirithResult(warnJson, 2))).toContain("shortened_url");
  });

  it("says nothing about a coverage gap (not a detection)", () => {
    expect(tirithNote(mapTirithResult(coverageGapJson, 1))).toBe("");
    expect(tirithNote(mapTirithResult(warnCoverageGapJson, 2))).toBe("");
  });

  it("says nothing for a pass or a no-detail verdict", () => {
    expect(tirithNote(mapTirithResult(allowJson, 0))).toBe("");
    expect(tirithNote(mapTirithResult(null, 2))).toBe("");
  });
});

describe("formatters", () => {
  const finding = (over: Partial<TirithFinding> = {}): TirithFinding => ({
    severity: "HIGH",
    ruleId: "x",
    title: "T",
    description: "fix it",
    ...over,
  });

  it("formatBlockReason lists rules and the first remedy", () => {
    const r = formatBlockReason([finding({ description: "fix it" })]);
    expect(r).toContain("[HIGH] x: T");
    expect(r).toContain("fix it");
  });

  it("formatBlockReason is generic with no findings", () => {
    expect(formatBlockReason([])).toContain("tirith");
  });

  it("formatFindingSummary joins finding rules", () => {
    const s = formatFindingSummary([finding({ severity: "MEDIUM", ruleId: "shortened_url", title: "Shortened URL" })]);
    expect(s).toContain("shortened_url");
    expect(s).toContain("MEDIUM");
  });

  it("formatVerdictSummary names a verdict that carried no findings", () => {
    // Banner text for the exit-code-only paths, which would otherwise render empty.
    const summarize = (parsed: Parameters<typeof mapTirithResult>[0], exitCode: number): string => {
      const v = mapTirithResult(parsed, exitCode);
      if (v.action === "pass") throw new Error("unreachable: expected block or warn");
      return formatVerdictSummary(v);
    };
    expect(summarize(null, 1)).toBe("blocked (no detail)");
    expect(summarize(null, 2)).toBe("flagged (no detail)");
    expect(summarize(warnJson, 2)).toContain("shortened_url");
  });

  it("tirithAnnotation is self-explanatory for the LLM", () => {
    const a = tirithAnnotation("block", [
      finding({
        severity: "HIGH",
        ruleId: "curl_pipe_shell",
        title: "Pipe to interpreter",
        description: "Safer: tirith run",
      }),
    ]);
    expect(a).toContain("command-safety checker");
    expect(a).toContain("dangerous");
    expect(a).toContain("curl_pipe_shell");
    expect(a).toContain("Safer: tirith run");

    const w = tirithAnnotation("warn", [
      finding({ severity: "MEDIUM", ruleId: "shortened_url", title: "Shortened URL", description: "" }),
    ]);
    expect(w).toContain("potentially unsafe");
    expect(w).toContain("MEDIUM");
  });
});
