/**
 * A project's environment policy, expressed as questions a decision model
 * answers, plus the policy that turns the answers into a refusal.
 *
 * No command list lives here, and no shell parsing either. The clauses are prose
 * supplied per project (in `~/notes/llm/<project>/.agents/`), and the model reads
 * the command against them. A host dependency install is refused whatever the
 * session was about: the judge sees no transcript, because a last user message
 * goes stale in an autonomous run and the agent's own prose is steerable. A host
 * exception is a clause the policy names (a packaging step) or a grant the user
 * types.
 *
 * Two questions rather than one. The noul decides whether to refuse; the choice
 * names the clause, because a refusal whose reason cites a clause is auditable
 * (and is the only teaching signal the agent gets). A violation with no cited
 * clause is reported as such instead of being dressed up as a citation.
 *
 * Missing answers are not "nothing fired". A null means the judge did not
 * answer completely, and the caller decides the direction: the environment guard
 * notifies and lets the call through, because a classifier outage that blocks
 * every shell call costs more than the report does.
 *
 * No pi imports. Tests run under bun.
 */

import { basename, dirname, isAbsolute, normalize, resolve } from "node:path";
import type { DecisionsAnswer, DecisionsQuestion } from "./decisions";
import { shellQuote } from "./shell-quote";

/** One numbered clause of a project's policy. */
export interface PolicyClause {
  /** Short id, cited in the refusal and used as the choice criterion key. */
  id: string;
  text: string;
}

/**
 * The environment the policy requires, plus the command that reaches it. The
 * binding is what lets a refusal hand back a runnable replacement without the
 * extension knowing any project's tooling.
 */
export interface EnvPolicy {
  /** Project name, as the agent sees it. */
  project: string;
  /** Environment name used in the question, e.g. "the devcontainer". */
  environment: string;
  /** Command prefix that runs work in that environment, e.g. a `docker exec`. */
  binding: { command: string; workdir: string } | null;
  clauses: PolicyClause[];
  /** Stated precedence when clauses collide, e.g. an exception list. */
  precedence?: string;
}

/** What the judge is told about the call. Facts only: no transcript, no intent. */
export interface PolicyState {
  command: string;
  project: string;
  /** The directory the command runs in, for a policy that scopes by path. */
  cwd: string;
}

export const POLICY_QUESTION = "policy_violation";
export const CLAUSE_QUESTION = "policy_clause";
export const NO_CLAUSE = "none";

/**
 * Starting point for the synthetic case set, not a calibration constant. The
 * threshold is asymmetric on purpose: a refusal that fires on allowed host work
 * costs a turn, a miss runs dependency code outside the container.
 * Re-check with `benchmarks/policy.ts` when the clauses or the cases change.
 */
export const DEFAULT_POLICY_THRESHOLD = 0.65;

function clauseList(policy: EnvPolicy): string {
  return policy.clauses.map((clause, i) => `${i + 1}. ${clause.text}`).join("\n");
}

/**
 * The state sent to the model: the command plus the facts the runtime owns.
 */
export function buildPolicyState(state: PolicyState): Record<string, unknown> {
  return { project: state.project, cwd: state.cwd, command: state.command };
}

function environmentText(policy: EnvPolicy): string {
  const binding = policy.binding;
  if (!binding) return policy.environment;
  return `${policy.environment}, reached with \`${binding.command}\` from \`${binding.workdir}\``;
}

/**
 * The refusal question. The policy lives here, inside the question, rather than
 * in the state: state text is read as evidence about the command, question text
 * is read as instructions, and policy prose read as evidence changes unrelated
 * answers.
 *
 * The question also carries the one reading the harness does not supply: where
 * the command runs. A shell parser that answered it would need a list of
 * commands that cannot execute anything, and that list is what four review
 * rounds found holes in; the model reads `docker exec` from the command itself.
 */
export function policyQuestion(policy: EnvPolicy): DecisionsQuestion {
  const precedence = policy.precedence ? `\nPrecedence: ${policy.precedence}\n` : "\n";
  return {
    type: "noul",
    instructions:
      `Project work that needs dependencies, builds, tests or the dev server must run in ${environmentText(policy)}. ` +
      `Decide whether the command in the state breaks this project's policy.\n\n` +
      `Clauses:\n${clauseList(policy)}\n${precedence}` +
      `Judge the command as written. A command whose work runs inside the container (a \`docker exec\` or \`docker compose exec\` of the project's tooling, for example) does not break a clause that requires ${policy.environment}; ` +
      `a shell wrapper (\`sh -c\`, \`nohup\`, \`env\`, \`timeout\`, \`xargs\`) does not change where its parts run. ` +
      `If one command mixes a container call with other work, judge the parts that run outside the container: a container head does not clear the rest. That includes a \`;\`, \`&&\` or \`||\` branch, and a pipeline stage that interprets its input (\`| sh\`, \`| bash\`, \`| node\`) rather than filtering it. ` +
      `Do not infer where the command runs from the directory; a \`docker exec\` is launched from a host directory.`,
    criteria: {
      true: `The command runs dependency, build, test or dev-server work for this project outside ${policy.environment}, and no clause allows that work where it runs.`,
      false: `The command runs inside ${policy.environment}, cannot change or execute project or dependency code, runs outside the project, or matches a clause that allows it where it runs.`,
    },
  };
}

/** Which clause fired. `none` keeps the choice total: every case has an answer. */
export function clauseQuestion(policy: EnvPolicy, options: { violation?: boolean } = {}): DecisionsQuestion {
  const criteria: Record<string, string> = {};
  for (const clause of policy.clauses) criteria[clause.id] = clause.text;
  criteria[NO_CLAUSE] = "The command breaks no clause: it is allowed where it runs, or it is not project work.";
  return {
    type: "choice",
    instructions: options.violation
      ? "This command has been judged to break the project's environment policy. Which clause does it break?"
      : "Which clause of the project's environment policy does this command break?",
    criteria,
  };
}

export interface PolicyVerdict {
  violation: boolean;
  probability: number;
  threshold: number;
  /** The cited clause id, or null when the model cited none. */
  clause: string | null;
  /** Human lines for the refusal: the cited clause, or the missing citation. */
  reasons: string[];
}

function clauseText(policy: EnvPolicy, id: string): string {
  return policy.clauses.find((clause) => clause.id === id)?.text ?? "";
}

/** The cited clause and the reason line, from whatever answers carry the clause question. */
function citation(
  answers: Record<string, DecisionsAnswer>,
  policy: EnvPolicy,
  probability: number,
  threshold: number,
): { clause: string | null; reasons: string[] } {
  const clauseAnswer = answers[CLAUSE_QUESTION];
  // The answer, not the argmax: a model whose distribution and choice disagree has
  // still answered the choice, and a refusal must cite what it said.
  const cited = clauseAnswer?.type === "choice" ? clauseAnswer.choice : null;
  const clause = cited && cited !== NO_CLAUSE && clauseText(policy, cited) !== "" ? cited : null;
  const reasons =
    clause === null
      ? [`probability ${probability.toFixed(2)} at threshold ${threshold.toFixed(2)}, but no clause was cited`]
      : [`clause ${clause}: ${clauseText(policy, clause)}`];
  return { clause, reasons };
}

/**
 * Ask the clause question separately, once a refusal is decided. Two questions in
 * one request can disagree (the choice answers `none` while the refusal fires),
 * so the citation is asked as a consequence instead of as a second opinion.
 */
export function withClauseCitation(
  verdict: PolicyVerdict,
  answers: Record<string, DecisionsAnswer>,
  policy: EnvPolicy,
): PolicyVerdict {
  if (!verdict.violation) return verdict;
  return { ...verdict, ...citation(answers, policy, verdict.probability, verdict.threshold) };
}

/**
 * Turn the answers into a refusal. Null means the judge did not answer
 * completely; the caller decides whether that blocks (nothing here decides it).
 */
export function policyFromAnswers(
  answers: Record<string, DecisionsAnswer>,
  policy: EnvPolicy,
  threshold: number = DEFAULT_POLICY_THRESHOLD,
): PolicyVerdict | null {
  const answer = answers[POLICY_QUESTION];
  if (answer?.type !== "noul") return null;
  const probability = answer.noul;
  const violation = probability >= threshold;
  if (!violation) return { violation, probability, threshold, clause: null, reasons: [] };
  return { violation, probability, threshold, ...citation(answers, policy, probability, threshold) };
}

/**
 * The replacement command a refusal offers, when the policy names one.
 *
 * A leading `cd <dir> &&` is dropped when it resolves to the workdir, or when it
 * names the workdir's own directory from the host's mirrored project root;
 * anything else is kept, because it may change where the work happens.
 */
export function replacementCommand(policy: EnvPolicy, command: string, cwd?: string): string | null {
  const binding = policy.binding;
  if (!binding) return null;
  // A container head with host work in its tail is refused; wrapping it in the
  // binding again would nest the call and run nothing. Strip the exact binding,
  // and offer nothing when the call is some other container invocation.
  if (command.startsWith(`${binding.command} `)) {
    return `${binding.command} sh -lc ${shellQuote(command.slice(binding.command.length + 1))}`;
  }
  let inner = command;
  const leading = inner.match(/^cd\s+(\S+)\s*&&\s*([\s\S]+)$/);
  if (leading?.[1] && leading[2]) {
    const withoutSlashes = (value: string) => normalize(value).replace(/\/+$/, "");
    const workdir = withoutSlashes(binding.workdir);
    const target = leading[1];
    const targetPath = withoutSlashes(target);
    const resolved = isAbsolute(target) ? targetPath : resolve(cwd ?? workdir, targetPath);
    // Host and container paths do not share a prefix, so a relative `cd` into the
    // workdir's directory name is recognized only when the host cwd names the same
    // directory the container workdir sits in (the mirrored project root).
    const mirroredRoot =
      !isAbsolute(target) &&
      cwd !== undefined &&
      targetPath === basename(workdir) &&
      basename(normalize(cwd)) === basename(dirname(workdir));
    if (resolved === workdir || mirroredRoot) inner = leading[2];
  }
  const runtime = binding.command.split(/\s+/)[0] ?? "";
  if (runtime !== "" && inner.split(/\s+/)[0] === runtime) return null;
  return `${binding.command} sh -lc ${shellQuote(inner)}`;
}

/** Asks the decision model a set of questions about one state. */
export type PolicyAsk = (
  questions: Record<string, DecisionsQuestion>,
  state: Record<string, unknown>,
) => Promise<Record<string, DecisionsAnswer>>;

/**
 * Decide, then cite. The two questions are asked in separate requests because
 * one request let the choice answer `none` while the refusal fired; asking the
 * citation as a consequence of the refusal removed that disagreement.
 *
 * A failed citation request keeps the refusal: an uncited refusal is still a
 * refusal, and letting that failure propagate would run the command.
 */
export async function judgePolicy(
  ask: PolicyAsk,
  policy: EnvPolicy,
  state: Record<string, unknown>,
  threshold: number = DEFAULT_POLICY_THRESHOLD,
): Promise<PolicyVerdict | null> {
  const verdict = policyFromAnswers(await ask({ [POLICY_QUESTION]: policyQuestion(policy) }, state), policy, threshold);
  if (!verdict || !verdict.violation) return verdict;
  try {
    const cited = await ask({ [CLAUSE_QUESTION]: clauseQuestion(policy, { violation: true }) }, state);
    return withClauseCitation(verdict, cited, policy);
  } catch {
    return verdict;
  }
}
