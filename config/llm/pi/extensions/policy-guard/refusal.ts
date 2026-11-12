/**
 * The refusal text the guard returns as a tool-call block.
 *
 * It names the clause that fired and where the rules live, and nothing else. With
 * clauses on any axis, a sentence about the input would need one per clause, and the
 * agent already has the clause in context; restating what the call should have been is
 * a second copy of the rule, and a silent correction is worse than a refusal, because
 * the agent never learns why the call was wrong. The refusal points at /guard allow;
 * /guard off is the other session unlock, and neither is the agent's to set.
 */

import { type Policy, type PolicyVerdict, rulesLine } from "../shared/policy";

export function refusalText(
  policy: Policy,
  verdict: PolicyVerdict,
  options: { policyPath?: string; tool?: string } = {},
): string {
  // The reason line is owned by the verdict: verdictFromAnswers in shared/policy.ts.
  const reason = verdict.reasons[0] ?? (verdict.clause ? `clause ${verdict.clause}` : "a policy clause");
  const lines = [`[policy-guard] refused by ${reason}`];
  if (options.policyPath) lines.push(rulesLine(options.policyPath, policy.clauses.length));
  // The unlock has to be one that works for this call: a host grant covers bash only.
  lines.push(
    options.tool === "bash"
      ? "The user can unlock this: /guard allow grants host work for this session, and /guard off turns policy checks off."
      : "The user can unlock this: /guard off turns policy checks off for this session; /guard allow covers host work only.",
  );
  return lines.join("\n");
}
