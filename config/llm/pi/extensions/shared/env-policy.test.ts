import { describe, expect, test } from "bun:test";
import type { ChoiceQuestion, DecisionsAnswer } from "./decisions";
import {
  buildPolicyState,
  CLAUSE_QUESTION,
  clauseQuestion,
  DEFAULT_POLICY_THRESHOLD,
  type EnvPolicy,
  judgePolicy,
  NO_CLAUSE,
  POLICY_QUESTION,
  policyFromAnswers,
  policyQuestion,
  replacementCommand,
  withClauseCitation,
} from "./env-policy";
import { shellQuote } from "./shell-quote";

const POLICY: EnvPolicy = {
  project: "acme-widgets",
  environment: "the devcontainer",
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

const answers = (noul: number, cited?: string): Record<string, DecisionsAnswer> => {
  const out: Record<string, DecisionsAnswer> = { [POLICY_QUESTION]: { type: "noul", noul } };
  if (cited !== undefined) {
    const probabilities: Record<string, number> = Object.fromEntries(
      POLICY.clauses.map((c) => [c.id, c.id === cited ? 0.9 : 0.05]),
    );
    probabilities[cited] = 0.9;
    out[CLAUSE_QUESTION] = { type: "choice", choice: cited, probabilities };
  }
  return out;
};

describe("buildPolicyState", () => {
  test("carries the facts the runtime owns: project, cwd and command", () => {
    const state = buildPolicyState({ command: "pnpm install", project: "acme-widgets", cwd: "/Users/acme/app" });
    expect(state).toEqual({ project: "acme-widgets", cwd: "/Users/acme/app", command: "pnpm install" });
  });

  test("carries no transcript-derived field, so the agent cannot steer the judge", () => {
    const state = buildPolicyState({ command: "ls", project: "acme-widgets", cwd: "/Users/acme/app" });
    expect(Object.keys(state).sort()).toEqual(["command", "cwd", "project"]);
  });
});

describe("policyQuestion", () => {
  const instructions = policyQuestion(POLICY).instructions;

  test("numbers every clause with its text", () => {
    expect(instructions).toContain("1. Dependency installs run in the container.");
    expect(instructions).toContain("2. Browser end-to-end suites run on the host.");
  });

  test("names the environment and how to reach it, so a refusal can be runnable", () => {
    expect(instructions).toContain("the devcontainer");
    expect(instructions).toContain("docker exec -w /workspaces/acme-widgets/app acme-dev-1");
  });

  test("states precedence when the policy declares it", () => {
    expect(instructions).toContain("Precedence: The e2e clause beats the deps clause.");
    expect(policyQuestion({ ...POLICY, precedence: undefined }).instructions).not.toContain("Precedence:");
  });

  test("tells the judge how to read a container command, since no fact supplies it", () => {
    expect(instructions).toContain("docker exec");
    expect(instructions).toContain("does not break a clause");
  });

  test("warns that a wrapper, a chain or a pipeline does not change where its parts run", () => {
    expect(instructions).toContain("sh -c");
    expect(instructions).toContain("&&");
    expect(instructions).toContain("pipeline");
  });

  test("asks nothing about intent, because no transcript reaches the judge", () => {
    expect(instructions.toLowerCase()).not.toContain("request");
  });
});

describe("clauseQuestion", () => {
  test("offers every clause plus an explicit none, so the answer is total", () => {
    const criteria = (clauseQuestion(POLICY) as ChoiceQuestion).criteria;
    expect(Object.keys(criteria).sort()).toEqual(["deps", "e2e", NO_CLAUSE].sort());
    expect(criteria.deps).toBe("Dependency installs run in the container.");
  });

  test("phrases the citation as a consequence once a refusal is decided", () => {
    const afterRefusal = (clauseQuestion(POLICY, { violation: true }) as ChoiceQuestion).instructions;
    expect(afterRefusal).toContain("has been judged to break");
    expect((clauseQuestion(POLICY) as ChoiceQuestion).instructions).not.toContain("has been judged");
  });
});

describe("withClauseCitation", () => {
  const verdict = {
    violation: true,
    probability: 0.9,
    threshold: DEFAULT_POLICY_THRESHOLD,
    clause: null,
    reasons: ["probability 0.90 at threshold 0.65, but no clause was cited"],
  };

  test("replaces the uncited reason with the clause the second answer names", () => {
    const cited = withClauseCitation(verdict, answers(0.9, "deps"), POLICY);
    expect(cited.clause).toBe("deps");
    expect(cited.reasons).toEqual(["clause deps: Dependency installs run in the container."]);
  });

  test("leaves an allowed command alone, since it has no clause to cite", () => {
    const allowed = { ...verdict, violation: false, reasons: [] };
    expect(withClauseCitation(allowed, answers(0.1, "deps"), POLICY)).toBe(allowed);
  });

  test("an answer that names none stays uncited instead of borrowing a clause", () => {
    const uncited = withClauseCitation(verdict, answers(0.9, NO_CLAUSE), POLICY);
    expect(uncited.clause).toBeNull();
    expect(uncited.reasons[0]).toContain("no clause was cited");
  });
});

describe("policyFromAnswers", () => {
  test("a missing noul returns null, and the guard notifies and allows", () => {
    expect(policyFromAnswers({}, POLICY)).toBeNull();
    expect(policyFromAnswers({ [POLICY_QUESTION]: { type: "noul", noul: 0.1 } }, POLICY)?.violation).toBe(false);
  });

  test("fires at the threshold, not only above it", () => {
    const verdict = policyFromAnswers(answers(DEFAULT_POLICY_THRESHOLD, "deps"), POLICY);
    expect(verdict?.violation).toBe(true);
    expect(verdict?.threshold).toBe(DEFAULT_POLICY_THRESHOLD);
  });

  test("below the threshold there is no violation and no clause", () => {
    const verdict = policyFromAnswers(answers(DEFAULT_POLICY_THRESHOLD - 0.01, "deps"), POLICY);
    expect(verdict?.violation).toBe(false);
    expect(verdict?.clause).toBeNull();
  });

  test("a violation cites the clause the answer chose and quotes its text", () => {
    const verdict = policyFromAnswers(answers(0.9, "deps"), POLICY);
    expect(verdict?.clause).toBe("deps");
    expect(verdict?.reasons).toEqual(["clause deps: Dependency installs run in the container."]);
  });

  test("a violation whose answer says none is reported as an uncited refusal, not dressed up", () => {
    const verdict = policyFromAnswers(answers(0.9, NO_CLAUSE), POLICY);
    expect(verdict?.violation).toBe(true);
    expect(verdict?.clause).toBeNull();
    expect(verdict?.reasons[0]).toContain("no clause was cited");
  });

  test("a cited id that is not in the policy is not a citation", () => {
    const verdict = policyFromAnswers(answers(0.9, "made-up"), POLICY);
    expect(verdict?.clause).toBeNull();
  });

  test("a violation with no clause answer at all is uncited, not an error", () => {
    const verdict = policyFromAnswers(answers(0.9), POLICY);
    expect(verdict?.violation).toBe(true);
    expect(verdict?.clause).toBeNull();
    expect(verdict?.reasons[0]).toContain("no clause was cited");
  });

  test("a clause answer of the wrong type is not a citation", () => {
    const wrong = { type: "noul", noul: 0.9, choice: "deps" } as unknown as DecisionsAnswer;
    const verdict = policyFromAnswers({ ...answers(0.9), [CLAUSE_QUESTION]: wrong }, POLICY);
    expect(verdict?.violation).toBe(true);
    expect(verdict?.clause).toBeNull();
  });
});

describe("judgePolicy", () => {
  const refused = { [POLICY_QUESTION]: { type: "noul" as const, noul: 0.9 } };

  test("asks once and returns an allow without a citation request", async () => {
    let calls = 0;
    const verdict = await judgePolicy(
      async () => {
        calls++;
        return answers(0.1);
      },
      POLICY,
      {},
    );
    expect(verdict?.violation).toBe(false);
    expect(calls).toBe(1);
  });

  test("cites from a second request after a refusal", async () => {
    const verdict = await judgePolicy(
      async (questions) => (POLICY_QUESTION in questions ? refused : answers(0.9, "deps")),
      POLICY,
      {},
    );
    expect(verdict?.violation).toBe(true);
    expect(verdict?.clause).toBe("deps");
  });

  test("a failed citation request keeps the refusal, uncited, instead of allowing it", async () => {
    const verdict = await judgePolicy(
      async (questions) => {
        if (POLICY_QUESTION in questions) return refused;
        throw new Error("429");
      },
      POLICY,
      {},
    );
    expect(verdict?.violation).toBe(true);
    expect(verdict?.clause).toBeNull();
    expect(verdict?.reasons[0]).toContain("no clause was cited");
  });

  test("a failed policy question propagates, so the caller can notify and decide", async () => {
    await expect(
      judgePolicy(
        async () => {
          throw new Error("timeout");
        },
        POLICY,
        {},
      ),
    ).rejects.toThrow("timeout");
  });
});

describe("replacementCommand", () => {
  test("wraps the command so the refusal hands back something runnable", () => {
    expect(replacementCommand(POLICY, "pnpm install --frozen-lockfile")).toBe(
      "docker exec -w /workspaces/acme-widgets/app acme-dev-1 sh -lc 'pnpm install --frozen-lockfile'",
    );
  });

  test("does not nest a command that already starts with the binding", () => {
    expect(replacementCommand(POLICY, "docker exec -w /workspaces/acme-widgets/app acme-dev-1 pnpm install")).toBe(
      "docker exec -w /workspaces/acme-widgets/app acme-dev-1 sh -lc 'pnpm install'",
    );
  });

  test("offers nothing for a different container invocation, instead of nesting one", () => {
    expect(replacementCommand(POLICY, "docker exec -it acme-dev-1 pnpm install; pnpm build")).toBeNull();
  });

  test("does not mistake a command that merely starts with the runtime word", () => {
    expect(replacementCommand(POLICY, "docker-compose-helper run")).toBe(
      "docker exec -w /workspaces/acme-widgets/app acme-dev-1 sh -lc 'docker-compose-helper run'",
    );
  });

  test("drops a leading cd that resolves to the binding's workdir", () => {
    // The wrapper already runs in the workdir; keeping the cd would point the
    // suggestion at a subdirectory of a subdirectory.
    expect(replacementCommand(POLICY, "cd app && pnpm install", "/workspaces/acme-widgets")).toBe(
      "docker exec -w /workspaces/acme-widgets/app acme-dev-1 sh -lc 'pnpm install'",
    );
    expect(replacementCommand(POLICY, "cd /workspaces/acme-widgets/app && pnpm install")).toBe(
      "docker exec -w /workspaces/acme-widgets/app acme-dev-1 sh -lc 'pnpm install'",
    );
  });

  test("drops a cd into the workdir's mirror directory from the host root", () => {
    for (const command of ["cd app && pnpm install", "cd app/ && pnpm install", "cd ./app/ && pnpm install"]) {
      expect(replacementCommand(POLICY, command, "/Users/acme/acme-widgets")).toBe(
        "docker exec -w /workspaces/acme-widgets/app acme-dev-1 sh -lc 'pnpm install'",
      );
    }
  });

  test("drops a trailing-slash absolute target and a trailing-slash workdir", () => {
    expect(replacementCommand(POLICY, "cd /workspaces/acme-widgets/app/ && pnpm install")).toBe(
      "docker exec -w /workspaces/acme-widgets/app acme-dev-1 sh -lc 'pnpm install'",
    );
    const slashed = {
      ...POLICY,
      binding: { command: POLICY.binding?.command ?? "", workdir: "/workspaces/acme-widgets/app/" },
    };
    expect(replacementCommand(slashed, "cd /workspaces/acme-widgets/app && pnpm install")).toBe(
      "docker exec -w /workspaces/acme-widgets/app acme-dev-1 sh -lc 'pnpm install'",
    );
  });

  test("without a host cwd a relative cd is left alone rather than throwing", () => {
    expect(replacementCommand(POLICY, "cd app && pnpm install")).toBe(
      "docker exec -w /workspaces/acme-widgets/app acme-dev-1 sh -lc 'cd app && pnpm install'",
    );
  });

  test("keeps a cd whose target is a deeper or neighbouring directory ending in the workdir's name", () => {
    for (const command of ["cd frontend/app && pnpm install", "cd ../app && pnpm install"]) {
      expect(replacementCommand(POLICY, command, "/Users/acme/acme-widgets")).toBe(
        `docker exec -w /workspaces/acme-widgets/app acme-dev-1 sh -lc '${command}'`,
      );
    }
  });

  test("keeps a cd whose target name matches but whose host root does not", () => {
    expect(replacementCommand(POLICY, "cd app && pnpm install", "/Users/acme/widgets/frontend")).toBe(
      "docker exec -w /workspaces/acme-widgets/app acme-dev-1 sh -lc 'cd app && pnpm install'",
    );
  });

  test("keeps a leading cd that goes somewhere else", () => {
    expect(replacementCommand(POLICY, "cd packages/api && pnpm install", "/workspaces/acme-widgets")).toBe(
      "docker exec -w /workspaces/acme-widgets/app acme-dev-1 sh -lc 'cd packages/api && pnpm install'",
    );
  });

  test("has nothing to offer without a binding", () => {
    expect(replacementCommand({ ...POLICY, binding: null }, "pnpm install")).toBeNull();
  });

  test("quotes single quotes so the command survives the shell", () => {
    expect(shellQuote("echo 'hi'")).toBe("'echo '\\''hi'\\'''");
    expect(shellQuote("")).toBe("''");
  });
});
