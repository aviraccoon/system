# review-gate

Dispatches the reviewer for the staged change through the `review` tool and records what the round
covered, so a commit can be checked against the reviewed tree and message. The checks are git hooks
deployed by `modules/home-manager/git-hooks`, because `--no-verify` skips `pre-commit` and
`commit-msg` but not `reference-transaction`.

The tool injects the proposed commit message into the child task, then classifies the report with a
decision model: the three verdict questions (`severity`, `behavior`, `unfinished`) plus `message`,
which asks whether the report judged the message at all. A question that does not answer records
nothing.

## Ledger

`~/.pi/agent/state/review-ledger.json`, keyed by repository and git tree. Each entry stores the tree,
the message normalized with `git stripspace`, and the verdict. A review covers exactly that tree,
so an edit after the round invalidates it, and the committed message must match the stored one.

The agent cannot write the ledger or the other gate state under `~/.pi/agent/state/`; tool calls that
name those paths are blocked. The match is on the path text, so a command that reaches the same file
another way is not caught.

## Hooks and state

The gate applies to agent sessions only: pi's bash tool sets `PI_SESSION_ID`, and a commit without it
is not gated. The hooks read these files, written only by the extension (`/review-gate` or the
`review` tool), never by another tool call:

| File | Written by | Effect |
|------|-----------|--------|
| `review-ledger.json` | the `review` tool; `override` | the reviewed tree, message and verdict |
| `review-gate-off` | `off` / `on` | the kill switch |
| `review-gate-exempt.json` | `exempt` / `unexempt` | repositories that skip the gate |
| `review-hooks-trust.json` | `trust-hooks` | repository hooks trusted at one content hash |

`pre-commit` and `commit-msg` check the staged tree. `reference-transaction` repeats that check and
compares the message on every commit, because `--no-verify` skips the other two and only it reads the
commit object, after git has cleaned the message.

A global `core.hooksPath` shadows a repository's own hooks; each one runs only when the user trusted
that exact content with `trust-hooks`, and until then a commit that one decides is refused with the
hook's hash.

## Commands

`/review-gate` opens a picker; the same actions take text arguments

| Action | Effect |
|--------|--------|
| `status` | Hooks state for the repository, the staged tree, the last recorded review |
| `override` | Let the staged tree commit despite a blocking review; asks for a reason |
| `exempt` / `unexempt` | Skip or resume the gate for the repository |
| `trust-hooks` | Trust a repository hook at its current content |
| `off` / `on` | The user-only switch the git hooks read |

## Limits

A repository-local `core.hooksPath` shadows the gate's hooks; `status` reports the gate inactive for
that repository, and a shell command that names `core.hooksPath` is blocked (a text match, not a
parser). The tool records the round either way, so a later install finds the reviewed tree already
recorded. Every check is a compliance gate against a forgetful agent, not a sandbox: a command that
clears `PI_SESSION_ID` another way (a nested shell, `env -i`), points `HOME` or the global git config
elsewhere, or reaches the state files another way is outside what the text matches catch. So is a
commit made while merge, cherry-pick or rebase state is present, which the hooks treat as history
being rewritten rather than created.
