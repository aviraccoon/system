import { describe, expect, test } from "bun:test";
import {
  CLAUSE_QUESTION,
  type EnvPolicy,
  NO_CLAUSE,
  POLICY_QUESTION,
  type PolicyVerdict,
  policyFromAnswers,
} from "../shared/env-policy";
import { refusalText } from "./refusal";

const POLICY: EnvPolicy = {
  project: "acme-widgets",
  environment: "the devcontainer",
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
};

describe("refusalText", () => {
  const text = refusalText(POLICY, VERDICT, "pnpm install --frozen-lockfile");

  test("names the project and the environment it must run in", () => {
    expect(text).toContain("acme-widgets");
    expect(text).toContain("the devcontainer");
    expect(text).toContain("not on the host");
  });

  test("quotes the clause that fired, so the reason is auditable", () => {
    expect(text).toContain("clause deps: Dependency work runs in the devcontainer.");
  });

  test("hands back the command that would have been allowed", () => {
    expect(text).toContain(
      "docker exec -w /workspaces/acme-widgets/app acme-dev-1 sh -lc 'pnpm install --frozen-lockfile'",
    );
  });

  test("names the grant the user types, which is the one unlock a refusal can offer", () => {
    expect(text).toContain("/guard allow");
    expect(text).toContain("for this session");
  });

  test("an uncited refusal says so instead of inventing a clause", () => {
    // Assembled by the real derivation, so the wording is the one production emits.
    const verdict = policyFromAnswers(
      {
        [POLICY_QUESTION]: { type: "noul", noul: 0.91 },
        [CLAUSE_QUESTION]: { type: "choice", choice: NO_CLAUSE, probabilities: { [NO_CLAUSE]: 1 } },
      },
      POLICY,
    );
    if (!verdict) throw new Error("expected a verdict");
    const uncited = refusalText(POLICY, verdict, "pnpm install");
    expect(uncited).toContain("no clause was cited");
    expect(uncited).toContain("0.91");
    expect(uncited).not.toContain("clause deps");
  });

  test("passes the cwd through so a leading cd into the workdir is dropped", () => {
    const text = refusalText(POLICY, VERDICT, "cd app && pnpm install", "/Users/acme/acme-widgets");
    expect(text).toContain("sh -lc 'pnpm install'");
    expect(text).not.toContain("cd app");
  });

  test("without a binding it says so rather than inventing a command", () => {
    const noBinding = refusalText({ ...POLICY, binding: null }, VERDICT, "pnpm install");
    expect(noBinding).toContain("no command binding is configured");
    expect(noBinding).not.toContain("sh -lc");
  });

  test("a container-headed command with no single replacement says to rerun the host part", () => {
    const mixed = refusalText(POLICY, VERDICT, "docker exec -it acme-dev-1 pnpm install; pnpm build");
    expect(mixed).toContain("Run the host part inside the devcontainer yourself");
    expect(mixed).toContain("starts with `docker`");
    expect(mixed).not.toContain("sh -lc");
    expect(mixed).not.toContain("/guard status");
  });
});
