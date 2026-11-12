import { describe, expect, test } from "bun:test";
import type { Policy, PolicyVerdict } from "../shared/policy";
import { refusalText } from "./refusal";

const POLICY: Policy = {
  project: "acme-widgets",
  binding: {
    command: "docker exec -w /workspaces/acme-widgets/app acme-dev-1",
    workdir: "/workspaces/acme-widgets/app",
  },
  clauses: [
    { id: "deps", text: "Dependency work runs in the devcontainer." },
    { id: "e2e", text: "Browser suites run on the host." },
  ],
};

const VERDICT: PolicyVerdict = {
  violation: true,
  probability: 0.91,
  threshold: 0.65,
  clause: "deps",
  reasons: ["clause deps: Dependency work runs in the devcontainer."],
  missing: [],
  scores: { deps: 0.91 },
};

describe("refusalText", () => {
  const text = refusalText(POLICY, VERDICT, { policyPath: "/notes/acme/policy.json", tool: "bash" });

  test("names the rule that fired and quotes it, which is the whole reason", () => {
    expect(text).toContain("[policy-guard] refused by clause deps: Dependency work runs in the devcontainer.");
  });

  test("names the rules file, so a misfiring clause is reported rather than worked around", () => {
    expect(text).toContain("Rules: /notes/acme/policy.json (2 clauses)");
    expect(text).toContain("the user's to change");
  });

  test("points at the unlock that works for a shell call", () => {
    expect(text).toContain("grants host work for this session");
    expect(text).not.toContain("covers host work only");
  });

  test("a non-shell call names the unlock that works for it, since a host grant covers bash only", () => {
    const write = refusalText(POLICY, VERDICT, { tool: "write" });
    expect(write).toContain("/guard off");
    expect(write).toContain("/guard allow covers host work only");
  });

  test("says nothing about the call itself, since a clause can be about any axis", () => {
    // A per-clause sentence about the input would need one per clause, and the agent
    // already has the clause in context.
    expect(text).not.toContain("sh -lc");
    expect(text).not.toContain("instead");
    expect(text).not.toContain("not on the host");
  });

  test("no path supplied, no rules line: the text never invents a location", () => {
    expect(refusalText(POLICY, VERDICT)).not.toContain("Rules:");
  });

  test("a verdict with no reason still names its clause id", () => {
    expect(refusalText(POLICY, { ...VERDICT, reasons: [] })).toContain("refused by clause deps");
  });

  test("a verdict with neither reason nor clause says so rather than rendering a null", () => {
    const bare: PolicyVerdict = {
      violation: true,
      probability: 0.9,
      threshold: 0.65,
      clause: null,
      reasons: [],
      missing: [],
      scores: {},
    };
    expect(refusalText(POLICY, bare)).toContain("refused by a policy clause");
  });

  test("a policy without a binding refuses the same way, since the clause is the reason", () => {
    const noBinding = refusalText({ ...POLICY, binding: null }, VERDICT);
    expect(noBinding).toContain("refused by clause deps");
    expect(noBinding).not.toContain("sh -lc");
  });
});
