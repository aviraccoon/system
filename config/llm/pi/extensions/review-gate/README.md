# review-gate

Dispatches the reviewer for the staged change through the `review` tool and records what the round
covered, so a commit can be checked against the reviewed tree and message.

The tool injects the proposed commit message into the child task, then classifies the report with a
decision model: the three verdict questions (`severity`, `behavior`, `unfinished`) plus `message`,
which asks whether the report judged the message at all. A question that does not answer records
nothing.

## Ledger

`~/.pi/agent/state/review-ledger.json`, keyed by repository and git tree. Each entry stores the tree,
the message normalized with `git stripspace -s`, and the verdict. A review covers exactly that tree,
so an edit after the round invalidates it, and the committed message must match the stored one.

The agent cannot write the ledger or the other gate state under `~/.pi/agent/state/`; tool calls that
name those paths are blocked. The match is on the path text, so a command that reaches the same file
another way is not caught.

## Commands

`/review-gate` opens a picker; the same actions take text arguments

| Action | Effect |
|--------|--------|
| `status` | Hooks state for the repository, the staged tree, the last recorded review |
| `off` / `on` | The user-only switch the git hooks read |

## Limits

A repository-local `core.hooksPath` shadows the gate's hooks; `status` reports the gate inactive for
that repository. The tool records the round either way, so a later install finds the reviewed tree
already recorded.
