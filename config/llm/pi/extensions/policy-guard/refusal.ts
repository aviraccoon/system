/**
 * The refusal text the guard returns as a tool-call block.
 *
 * It has to be self-contained: the agent reading it has no memory of this file,
 * no knowledge of the project's policy, and no way to see why the call was
 * stopped. So the reason names the environment, quotes the clause it fired, hands
 * back the command that would have been allowed, and names the file the rules live
 * in, because a clause that keeps misfiring is worth reporting rather than working
 * around. The refusal can only point at /guard allow; /guard off is the other
 * session unlock, and neither is the agent's to set.
 */

import { type Policy, type PolicyVerdict, replacementCommand, rulesLine } from "../shared/policy";

function runtimeOf(policy: Policy): string {
  return policy.binding?.command.split(/\s+/)[0] ?? "";
}

export function refusalText(
  policy: Policy,
  verdict: PolicyVerdict,
  command: string,
  options: { cwd?: string; policyPath?: string } = {},
): string {
  // The reason line is owned by the verdict: citation() in shared/policy.ts.
  const clause = verdict.reasons[0] ?? "no clause was cited";
  const replacement = replacementCommand(policy, command, options.cwd);
  const runInstead = replacement
    ? `Run it in ${policy.environment} instead:\n  ${replacement}`
    : policy.binding
      ? `Run the host part inside ${policy.environment} yourself: this command already starts with \`${runtimeOf(policy)}\`, so wrapping the whole thing would nest the call.`
      : `Run it in ${policy.environment}; no command binding is configured for this project.`;
  const lines = [
    `[policy-guard] refused: ${policy.project} runs this work in ${policy.environment}, not on the host.`,
    clause,
    runInstead,
  ];
  if (options.policyPath) lines.push(rulesLine(options.policyPath, policy.clauses.length));
  lines.push("A host run needs the user: /guard allow grants it for this session.");
  return lines.join("\n");
}
