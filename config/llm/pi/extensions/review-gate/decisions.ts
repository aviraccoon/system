/**
 * The hooks' decision log: one tab-separated line per gate decision (time,
 * decision, repo, tree, reason), written by `record_decision` in
 * modules/home-manager/git-hooks/_lib.sh.
 *
 * A gate that stands down leaves no other trace, and a shell command may not
 * name the state directory, so this reader is how the log becomes visible
 * inside the extension.
 */

const DECISION_FIELDS = 5;

export interface Decision {
  at: string;
  decision: string;
  repo: string;
  tree: string;
  reason: string;
}

/** The last `limit` well-formed lines, oldest first. A malformed line is skipped, not guessed at. */
export function parseDecisions(text: string, limit = 20): Decision[] {
  if (limit <= 0) return [];
  const decisions: Decision[] = [];
  for (const line of text.split("\n")) {
    const fields = line.split("\t");
    if (fields.length !== DECISION_FIELDS) continue;
    const [at, decision, repo, tree, reason] = fields;
    decisions.push({ at, decision, repo, tree, reason });
  }
  return decisions.slice(-limit);
}

export function formatDecisions(decisions: Decision[]): string {
  if (decisions.length === 0) return "No commit decisions recorded.";
  return decisions
    .map((decision) => {
      const tree = decision.tree === "-" ? "(none)" : decision.tree.slice(0, 8);
      const reason = decision.reason === "-" ? "" : `  ${decision.reason}`;
      return `${decision.at}  ${decision.decision.padEnd(8)} ${tree}  ${decision.repo}${reason}`;
    })
    .join("\n");
}
