import { describe, expect, test } from "bun:test";
import type { DecisionsAnswer, NoulQuestion } from "./decisions";
import {
  bindingShell,
  callSummary,
  clauseQuestionId,
  clauseQuestions,
  DEFAULT_CRITERIA,
  DEFAULT_POLICY_THRESHOLD,
  hasContent,
  judgePolicy,
  type Policy,
  policySummary,
  verdictFromAnswers,
} from "./policy";

const POLICY: Policy = {
  project: "acme-widgets",
  binding: {
    command: "docker exec -w /workspaces/acme-widgets/app acme-dev-1",
    workdir: "/workspaces/acme-widgets/app",
  },
  clauses: [
    { id: "deps", text: "Dependency installs run in the container." },
    { id: "e2e", text: "Browser end-to-end suites run on the host." },
  ],
  precedence: "The e2e clause beats the deps clause.",
};

/** One noul answer per clause, keyed the way the questions are. */
const answers = (...scores: number[]): Record<string, DecisionsAnswer> =>
  Object.fromEntries(
    POLICY.clauses.map((clause, index) => [
      clauseQuestionId(clause.id),
      { type: "noul" as const, noul: scores[index] ?? 0 },
    ]),
  );

describe("callSummary", () => {
  test("carries the command of a shell call", () => {
    const facts = callSummary("bash", { command: "pnpm install" }, "/Users/acme/app");
    expect(facts).toEqual({ tool: "bash", cwd: "/Users/acme/app", command: "pnpm install" });
  });

  test("resolves the targets of an edit-like call through the caller's resolver", () => {
    const resolve = (path: string) => `/Users/acme/app/${path}`;
    expect(callSummary("write", { path: "src/a.ts" }, "/Users/acme/app", resolve).paths).toEqual([
      "/Users/acme/app/src/a.ts",
    ]);
    expect(
      callSummary("patch", { path: "src/a.ts", edits: [{ path: "src/b.ts" }, {}] }, "/Users/acme/app", resolve).paths,
    ).toEqual(["/Users/acme/app/src/b.ts", "/Users/acme/app/src/a.ts"]);
  });

  test("carries a read's path, so a clause can scope reads", () => {
    expect(callSummary("read", { path: ".env" }, "/p", (path) => `/p/${path}`).paths).toEqual(["/p/.env"]);
  });

  test("carries a fetch's url, a search's query and domains, and a dispatch's task", () => {
    expect(callSummary("web_fetch", { url: "https://acme.test/x" }, "/p").url).toBe("https://acme.test/x");
    const search = callSummary("web_search", { query: "acme", includeDomains: ["acme.test"] }, "/p");
    expect(search.query).toBe("acme");
    expect(search.domains).toEqual(["acme.test"]);
    expect(callSummary("subagent", { task: "survey the repos", agent: "researcher" }, "/p").task).toBe(
      "survey the repos",
    );
  });

  test("carries no transcript-derived field, so the agent cannot steer the judge", () => {
    const facts = callSummary("bash", { command: "ls", description: "the user asked for this" }, "/p");
    expect(Object.keys(facts).sort()).toEqual(["command", "cwd", "tool"]);
  });

  test("carries the bash tool's own budget, which is not in the command", () => {
    const facts = callSummary("bash", { command: "pnpm test", timeout: 240 }, "/p");
    expect(facts.timeout).toBe(240);
    expect(callSummary("bash", { command: "pnpm test" }, "/p").timeout).toBeUndefined();
  });

  test("carries a dispatch's text in every form the tool accepts", () => {
    expect(callSummary("subagent", { agent: "researcher", task: "one task" }, "/p").task).toBe("one task");
    expect(
      callSummary(
        "subagent",
        {
          tasks: [
            { agent: "a", task: "first" },
            { agent: "b", task: "second" },
          ],
        },
        "/p",
      ).task,
    ).toBe("first\n\nsecond");
    expect(callSummary("subagent", { chain: [{ agent: "a", task: "then" }] }, "/p").task).toBe("then");
    expect(callSummary("subagent", { spec: { instructions: "a worker spec" } }, "/p").task).toBe("a worker spec");
  });

  test("carries an lsp target, which the tool names as `file`", () => {
    expect(callSummary("lsp", { action: "rename", file: "src/a.ts" }, "/p", (path) => `/p/${path}`).paths).toEqual([
      "/p/src/a.ts",
    ]);
  });

  test("hasContent is false for a call that names nothing a clause could be about", () => {
    expect(hasContent(callSummary("policy", {}, "/p"))).toBe(false);
    expect(hasContent(callSummary("bash", { command: "ls" }, "/p"))).toBe(true);
    expect(hasContent(callSummary("read", { path: "a.ts" }, "/p"))).toBe(true);
  });
});

describe("clauseQuestions", () => {
  const questions = clauseQuestions(POLICY);
  const deps = questions[clauseQuestionId("deps")];

  test("asks one question per clause, keyed by the clause id", () => {
    expect(Object.keys(questions).sort()).toEqual(["clause:deps", "clause:e2e"]);
  });

  test("quotes the clause it asks about, and its id", () => {
    expect(deps.type).toBe("noul");
    expect(deps.instructions).toContain("Clause deps: Dependency installs run in the container.");
  });

  test("states precedence in every question, since the clauses are judged independently", () => {
    expect(deps.instructions).toContain("Precedence: The e2e clause beats the deps clause.");
    expect(questions[clauseQuestionId("e2e")].instructions).toContain("Precedence:");
    const noPrecedence = clauseQuestions({ ...POLICY, precedence: undefined });
    expect(noPrecedence[clauseQuestionId("deps")].instructions).not.toContain("Precedence:");
  });

  test("states the binding as a fact when the policy names one, and nothing when it does not", () => {
    expect(deps.instructions).toContain("docker exec -w /workspaces/acme-widgets/app acme-dev-1");
    const noBinding = clauseQuestions({ ...POLICY, binding: null });
    expect(noBinding[clauseQuestionId("deps")].instructions).not.toContain("work environment");
  });

  test("carries reading guidance about wrappers, mixed commands and project ownership", () => {
    expect(deps.instructions).toContain("A shell wrapper");
    expect(deps.instructions).toContain("touches nothing the project owns");
    // The sentence that cleared a container call cleared every clause on another axis.
    expect(deps.instructions).not.toContain("does not break a clause");
  });

  test("a clause without criteria gets the neutral pair, which assumes nothing about its direction", () => {
    const criteria = (deps as NoulQuestion).criteria ?? {};
    expect(criteria).toEqual(DEFAULT_CRITERIA);
    expect(criteria.true).toContain("does not do what it requires");
  });

  test("a clause's own criteria replace the default, so a permission is not read as a requirement", () => {
    const withCriteria = clauseQuestions({
      ...POLICY,
      clauses: [
        {
          id: "e2e",
          text: "Browser suites run on the host.",
          criteria: { true: "The suite runs somewhere other than the host.", false: "The suite runs on the host." },
        },
      ],
    });
    expect((withCriteria[clauseQuestionId("e2e")] as NoulQuestion).criteria).toEqual({
      true: "The suite runs somewhere other than the host.",
      false: "The suite runs on the host.",
    });
  });

  test("asks nothing about intent, because no transcript reaches the judge", () => {
    expect(deps.instructions.toLowerCase()).not.toContain("request");
  });
});

describe("verdictFromAnswers", () => {
  test("a missing clause answer is reported, and the answered clauses still decide", () => {
    const none = verdictFromAnswers({}, POLICY);
    expect(none.violation).toBe(false);
    expect(none.missing).toEqual(["deps", "e2e"]);
    const partial = answers(0.9);
    delete partial[clauseQuestionId("e2e")];
    const verdict = verdictFromAnswers(partial, POLICY);
    expect(verdict.violation).toBe(true);
    expect(verdict.clause).toBe("deps");
    expect(verdict.missing).toEqual(["e2e"]);
  });

  test("fires at the threshold, not only above it", () => {
    const verdict = verdictFromAnswers(answers(DEFAULT_POLICY_THRESHOLD, 0), POLICY);
    expect(verdict.violation).toBe(true);
    expect(verdict.clause).toBe("deps");
    expect(verdict.threshold).toBe(DEFAULT_POLICY_THRESHOLD);
  });

  test("below every threshold there is no violation and no clause", () => {
    const verdict = verdictFromAnswers(answers(DEFAULT_POLICY_THRESHOLD - 0.01, 0), POLICY);
    expect(verdict?.violation).toBe(false);
    expect(verdict?.clause).toBeNull();
    expect(verdict?.reasons).toEqual([]);
  });

  test("an allowed call still reports the highest probability, for the record", () => {
    expect(verdictFromAnswers(answers(0.2, 0.5), POLICY)?.probability).toBe(0.5);
  });

  test("quotes the clause text in the reason, which is what the refusal renders", () => {
    expect(verdictFromAnswers(answers(0.9, 0), POLICY)?.reasons).toEqual([
      "clause deps: Dependency installs run in the container.",
    ]);
  });

  test("a clause's own threshold overrides the default", () => {
    const strict: Policy = {
      ...POLICY,
      clauses: [{ id: "deps", text: "Dependency installs run in the container.", threshold: 0.9 }],
    };
    const at = (noul: number) => verdictFromAnswers({ [clauseQuestionId("deps")]: { type: "noul", noul } }, strict);
    expect(at(0.9)?.violation).toBe(true);
    expect(at(0.9)?.threshold).toBe(0.9);
    expect(at(0.89)?.violation).toBe(false);
  });

  test("the strongest firing clause is the one cited, not the first in the file", () => {
    const verdict = verdictFromAnswers(answers(0.7, 0.95), POLICY);
    expect(verdict?.clause).toBe("e2e");
    expect(verdict?.probability).toBe(0.95);
  });

  test("a clause whose answer is the wrong type is reported as unchecked, not as a pass", () => {
    const wrong = { ...answers(0.9, 0), [clauseQuestionId("e2e")]: { type: "choice" } } as unknown as Record<
      string,
      DecisionsAnswer
    >;
    const verdict = verdictFromAnswers(wrong, POLICY);
    expect(verdict.clause).toBe("deps");
    expect(verdict.missing).toEqual(["e2e"]);
  });
});

describe("judgePolicy", () => {
  test("asks every clause in one request, with the call facts and the project in the state", async () => {
    const seen: { questions: string[]; state: Record<string, unknown> }[] = [];
    const verdict = await judgePolicy(
      async (questions, state) => {
        seen.push({ questions: Object.keys(questions), state });
        return answers(0.9, 0);
      },
      POLICY,
      { tool: "bash", cwd: "/Users/acme/app", command: "pnpm install" },
    );
    expect(seen[0]?.questions.sort()).toEqual(["clause:deps", "clause:e2e"]);
    expect(seen[0]?.state).toEqual({
      project: "acme-widgets",
      tool: "bash",
      cwd: "/Users/acme/app",
      command: "pnpm install",
    });
    expect(verdict?.clause).toBe("deps");
  });

  test("one request, whatever the clause count", async () => {
    let calls = 0;
    await judgePolicy(
      async () => {
        calls++;
        return answers(0.1, 0.1);
      },
      POLICY,
      { tool: "bash", cwd: "/p", command: "ls" },
    );
    expect(calls).toBe(1);
  });

  test("a failed request propagates, so the caller can notify and decide", async () => {
    await expect(
      judgePolicy(
        async () => {
          throw new Error("timeout");
        },
        POLICY,
        { tool: "bash", cwd: "/p", command: "ls" },
      ),
    ).rejects.toThrow("timeout");
  });
});

describe("policySummary", () => {
  const path = "/notes/acme/.agents/policy.json";
  const text = policySummary(POLICY, path);

  test("says what the guard is and what happens on a break, which a bare rule list cannot", () => {
    expect(text).toContain("enforced by pi's policy-guard");
    expect(text).toContain("refused before it runs");
    // A marked copy keeps the attribution: it is the same opening with a prefix.
    expect(policySummary(POLICY, path, { supersedes: true })).toContain("enforced by pi's policy-guard");
  });

  test("a later copy says it supersedes the earlier one, and the first does not", () => {
    const later = policySummary(POLICY, path, { supersedes: true });
    expect(later).toContain("supersedes any earlier policy block");
    expect(later).toContain("- deps: Dependency installs run in the container.");
    expect(text).not.toContain("supersedes");
  });

  test("renders every clause with the id the refusal cites", () => {
    expect(text).toContain("- deps: Dependency installs run in the container.");
    expect(text).toContain("- e2e: Browser end-to-end suites run on the host.");
  });

  test("names the command that reaches the environment, so the agent can run work there", () => {
    expect(text).toContain("docker exec -w /workspaces/acme-widgets/app acme-dev-1 sh -lc");
  });

  test("uses the shell the policy declares, because not every environment takes `sh -lc`", () => {
    const custom = {
      ...POLICY,
      binding: {
        command: "docker exec -w /workspaces/acme-widgets/app acme-dev-1",
        workdir: "/workspaces/acme-widgets/app",
        shell: "bash -lc",
      },
    };
    const rendered = policySummary(custom, path);
    expect(rendered).toContain("acme-dev-1 bash -lc '<command>'");
    expect(rendered).not.toContain("acme-dev-1 sh -lc");
    expect(bindingShell(custom.binding ?? {})).toBe("bash -lc");
    expect(bindingShell({})).toBe("sh -lc");
  });

  test("carries the precedence, and only when the policy declares one", () => {
    expect(text).toContain("Precedence: The e2e clause beats the deps clause.");
    expect(policySummary({ ...POLICY, precedence: undefined }, path)).not.toContain("Precedence:");
  });

  test("names the file, its clause count and who may change it", () => {
    expect(text).toContain(`Rules: ${path} (2 clauses)`);
    expect(text).toContain("the user's to change");
  });

  test("counts one clause in the singular, since a one-clause policy is valid", () => {
    const single = policySummary(
      { ...POLICY, clauses: [{ id: "deps", text: "Dependency work runs in the container." }] },
      path,
    );
    expect(single).toContain("Rules: /notes/acme/.agents/policy.json (1 clause)");
  });

  test("a policy without a binding renders the rules and no command", () => {
    const noBinding = policySummary({ ...POLICY, binding: null }, path);
    expect(noBinding).toContain("- deps:");
    expect(noBinding).not.toContain("work environment");
  });
});
