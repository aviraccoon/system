/**
 * A project's policy, expressed as questions a decision model answers, plus the
 * policy that turns the answers into a refusal.
 *
 * The clauses are prose supplied per project (in
 * `~/notes/llm/<project>/.agents/policy.json`), and the model reads one call
 * against them. No command list lives here, and no shell parsing either: a clause
 * is the user's to write and the model's to read.
 *
 * One question per clause, not one question for the policy. A single question
 * asks the model to do the judgment and the arithmetic at once, and a wrong answer
 * names nothing; per-clause questions put the threshold in code, so a wrong verdict
 * names the clause that caused it and a policy change is a number rather than a
 * prompt rewrite. The citation falls out of the same answers: the clause with the
 * highest probability above its threshold is the one a refusal names, so no second
 * request is needed to ask which clause fired.
 *
 * Missing answers are not "nothing fired". A null means the judge did not answer
 * completely, and the caller decides the direction: the guard notifies and lets the
 * call through, because a classifier outage that blocks every call costs more than
 * the report does.
 *
 * No pi imports. Tests run under bun.
 */

import { resolve } from "node:path";
import type { DecisionsAnswer, DecisionsQuestion } from "./decisions";
import { collectToolPaths } from "./edit-tools";

/** One clause of a project's policy. */
export interface PolicyClause {
  /** Short id, cited in the refusal and used as the question's key. */
  id: string;
  text: string;
  /** Probability at or above which this clause refuses; the default when absent. */
  threshold?: number;
  /**
   * What counts as breaking this clause. The author writes it because only they know
   * whether the clause requires work or allows it, and a generic pair reads a
   * permission as a requirement.
   */
  criteria?: { true: string; false: string };
}

/** The command prefix that runs work in the environment the policy requires. */
export interface PolicyBinding {
  command: string;
  workdir: string;
  /** The prefix the environment's runtime needs for a command string. */
  shell?: string;
}

export interface Policy {
  /** Project name, as the agent sees it. */
  project: string;
  /** Null when the policy names no environment, which leaves the clauses to say it. */
  binding: PolicyBinding | null;
  clauses: PolicyClause[];
  /** Stated precedence when clauses collide, e.g. an exception list. */
  precedence?: string;
}

/**
 * Starting point for the synthetic case set, not a calibration constant. The
 * threshold is asymmetric on purpose: a refusal that fires on allowed work costs a
 * turn, a miss runs work the policy keeps elsewhere. Re-check with
 * `benchmarks/policy.ts` when the clauses or the cases change.
 */
export const DEFAULT_POLICY_THRESHOLD = 0.65;

/**
 * The prefix that turns a command string into one argv: `sh -lc` for a container
 * exec, whatever the environment's own runtime takes (`bash -lc`, `sh -c`). A
 * policy whose runtime does not take a command string sets it explicitly; the
 * default is the shell the devcontainer bindings use.
 */
export function bindingShell(binding: { shell?: string }): string {
  return binding.shell?.trim() || "sh -lc";
}

/** The facts a call presents: what the judge reads, per tool. */
export interface CallFacts {
  tool: string;
  /** The directory the call runs in, for a clause that scopes by path. */
  cwd: string;
  command?: string;
  /** The bash tool's own budget in seconds, which a clause may bound. */
  timeout?: number;
  /** Resolved target paths, for the tools that name one. */
  paths?: string[];
  url?: string;
  query?: string;
  domains?: string[];
  /** A subagent dispatch's task text. */
  task?: string;
}

/**
 * The text a dispatch names: one task, a batch or chain of them, or a worker spec. A
 * clause about dispatch text has to see every form, not just the single-task one.
 */
function taskText(input: Record<string, unknown>): string | undefined {
  const parts: string[] = [];
  const add = (value: unknown) => {
    if (typeof value === "string" && value.trim() !== "") parts.push(value);
  };
  add(input.task);
  for (const key of ["tasks", "chain"]) {
    const list = input[key];
    if (Array.isArray(list)) for (const item of list) add((item as { task?: unknown } | null)?.task);
  }
  add((input.spec as { instructions?: unknown } | null | undefined)?.instructions);
  return parts.length > 0 ? parts.join("\n\n") : undefined;
}

/**
 * The call as the judge sees it: one shape for every tool, so a clause can be
 * about a path, a url, a command or a dispatch without the guard knowing which
 * tool produced it. Paths are resolved by the caller's resolver, which is where
 * `@` stripping, `~` expansion and cwd resolution live; a symlink is not
 * canonicalized here.
 */
export function callSummary(
  toolName: string,
  input: Record<string, unknown>,
  cwd: string,
  resolvePath: (path: string) => string = (path) => resolve(cwd, path),
): CallFacts {
  const facts: CallFacts = { tool: toolName, cwd };
  const stringAt = (key: string): string | undefined =>
    typeof input[key] === "string" && (input[key] as string).trim() !== "" ? (input[key] as string) : undefined;

  const command = stringAt("command");
  if (command !== undefined) facts.command = command;
  // The bash tool's own budget is a fact a clause can bound, and it is not in the command.
  if (typeof input.timeout === "number" && Number.isFinite(input.timeout)) facts.timeout = input.timeout;
  // `lsp` names its target as `file`, not `path`, so it is read here too.
  const named = collectToolPaths(toolName, input);
  const file = stringAt("file");
  if (file !== undefined) named.push(file);
  const paths = [...new Set(named)].map((path) => resolvePath(path));
  if (paths.length > 0) facts.paths = paths;
  const url = stringAt("url");
  if (url !== undefined) facts.url = url;
  const query = stringAt("query");
  if (query !== undefined) facts.query = query;
  const task = taskText(input);
  if (task !== undefined) facts.task = task;
  const domains = [
    ...(Array.isArray(input.includeDomains) ? input.includeDomains : []),
    ...(Array.isArray(input.excludeDomains) ? input.excludeDomains : []),
  ].filter((domain): domain is string => typeof domain === "string" && domain.trim() !== "");
  if (domains.length > 0) facts.domains = domains;
  return facts;
}

/** The question key for a clause, so the answer set and the clause list agree. */
export function clauseQuestionId(clauseId: string): string {
  return `clause:${clauseId}`;
}

/**
 * Whether a call names anything a clause could be about. A call with none of these
 * facts is not judged: a request per `lsp` or `/policy` call would be paid for by
 * every session, and no clause can act on a bare tool name.
 */
export function hasContent(facts: CallFacts): boolean {
  return Boolean(
    facts.command || facts.paths?.length || facts.url || facts.query || facts.task || facts.domains?.length,
  );
}

/**
 * The criteria a clause without its own gets. Neutral on purpose: it says nothing
 * about whether the clause requires work or allows it, because a clause that allows
 * work is broken by a pair that asks whether the call does what it requires.
 */
export const DEFAULT_CRITERIA = {
  true: "The call does what this clause forbids, or does not do what it requires.",
  false: "The call complies with this clause, including when the clause allows the work the call does.",
};

/**
 * Reading guidance that applies to every clause: what a wrapper does, how a mixed
 * command is read, and what counts as the project's own work. It says nothing about
 * where work runs, because a sentence that clears a container call also clears every
 * clause on another axis.
 */
const READING_GUIDANCE =
  "Judge the call as written. A shell wrapper (`sh -c`, `nohup`, `env`, `timeout`, `xargs`) does not change what its parts do. " +
  "If one command mixes a container call with other work, judge the parts that run outside the container: that includes a `;`, `&&` or `||` branch, and a pipeline stage that interprets its input (`| sh`, `| bash`, `| node`). " +
  "A command that touches nothing the project owns, meaning its code, dependencies, servers or build, is not project work even when it is launched from the project directory.";

/**
 * One question per clause. The precedence line rides every question because the
 * clauses are judged independently: a clause that allows work another clause
 * forbids is only visible to the model if it sees both.
 */
export function clauseQuestions(policy: Policy): Record<string, DecisionsQuestion> {
  const questions: Record<string, DecisionsQuestion> = {};
  const precedence = policy.precedence ? `\nPrecedence: ${policy.precedence}\n` : "\n";
  const binding = policy.binding
    ? `\nThe project's work environment is reached with \`${policy.binding.command}\` from \`${policy.binding.workdir}\`.\n`
    : "";
  for (const clause of policy.clauses) {
    questions[clauseQuestionId(clause.id)] = {
      type: "noul",
      instructions:
        `Does this call break this clause of the ${policy.project} policy?\n\n` +
        `Clause ${clause.id}: ${clause.text}\n${precedence}${binding}\n${READING_GUIDANCE}`,
      criteria: clause.criteria ?? DEFAULT_CRITERIA,
    };
  }
  return questions;
}

export interface PolicyVerdict {
  violation: boolean;
  probability: number;
  threshold: number;
  /** The clause that fired, or null when none did. */
  clause: string | null;
  /** Human lines for the refusal: the cited clause. */
  reasons: string[];
  /** Clause ids the judge did not answer. They were not checked, and the caller says so. */
  missing: string[];
}

/**
 * Turn the per-clause answers into a verdict.
 *
 * A clause with no answer is left unchecked and named in `missing`, rather than voiding
 * the whole call: with one question per clause, a single dropped answer would otherwise
 * discard a confident violation from another clause. The caller reports the gap.
 *
 * The firing clause with the highest probability is the one cited, so the refusal
 * names the strongest reason rather than the first in the file.
 */
export function verdictFromAnswers(
  answers: Record<string, DecisionsAnswer>,
  policy: Policy,
  defaultThreshold: number = DEFAULT_POLICY_THRESHOLD,
): PolicyVerdict {
  let strongest: { clause: PolicyClause; probability: number; threshold: number } | null = null;
  let highest = 0;
  const missing: string[] = [];
  for (const clause of policy.clauses) {
    const answer = answers[clauseQuestionId(clause.id)];
    if (answer?.type !== "noul") {
      missing.push(clause.id);
      continue;
    }
    highest = Math.max(highest, answer.noul);
    const threshold = clause.threshold ?? defaultThreshold;
    if (answer.noul < threshold) continue;
    if (!strongest || answer.noul > strongest.probability) {
      strongest = { clause, probability: answer.noul, threshold };
    }
  }
  if (!strongest) {
    return { violation: false, probability: highest, threshold: defaultThreshold, clause: null, reasons: [], missing };
  }
  return {
    violation: true,
    probability: strongest.probability,
    threshold: strongest.threshold,
    clause: strongest.clause.id,
    reasons: [`clause ${strongest.clause.id}: ${strongest.clause.text}`],
    missing,
  };
}

/**
 * The line that points at the policy file, in one literal for both renderers: the
 * session block and a refusal. A refusal is self-contained by design, so both
 * carry the sentence; one literal keeps them from drifting apart.
 */
export function rulesLine(policyPath: string, clauseCount: number): string {
  const clauses = clauseCount === 1 ? "1 clause" : `${clauseCount} clauses`;
  return `Rules: ${policyPath} (${clauses}). A clause that looks wrong is the user's to change: say so rather than working around it.`;
}

/**
 * The policy as a session-start block: what the guard is, the clauses as prose,
 * where the rules live, and the binding when the policy names an environment.
 *
 * Rendered from the clauses the judge reads, so the block cannot drift from what
 * is enforced; the file stays the owner.
 */
export function policySummary(policy: Policy, policyPath: string): string {
  const lines = [
    "Project policy, enforced by pi's policy-guard: a call that breaks one of these is refused before it runs, unless the judge is unavailable or the user grants the session.",
    "",
    ...policy.clauses.map((clause) => `- ${clause.id}: ${clause.text}`),
  ];
  if (policy.precedence) lines.push("", `Precedence: ${policy.precedence}`);
  if (policy.binding) {
    lines.push(
      "",
      "The project's work environment is reached with:",
      `  ${policy.binding.command} ${bindingShell(policy.binding)} '<command>'`,
    );
  }
  lines.push("", rulesLine(policyPath, policy.clauses.length));
  return lines.join("\n");
}

/** Asks the decision model a set of questions about one state. */
export type PolicyAsk = (
  questions: Record<string, DecisionsQuestion>,
  state: Record<string, unknown>,
) => Promise<Record<string, DecisionsAnswer>>;

/**
 * Judge one call against every clause in a single request. The state carries the
 * call's facts and the project name; the clauses live in the questions, because
 * state text is read as evidence and question text as instructions.
 */
export async function judgePolicy(
  ask: PolicyAsk,
  policy: Policy,
  facts: CallFacts,
  threshold: number = DEFAULT_POLICY_THRESHOLD,
): Promise<PolicyVerdict> {
  const answers = await ask(clauseQuestions(policy), { project: policy.project, ...facts });
  return verdictFromAnswers(answers, policy, threshold);
}
