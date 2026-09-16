# harvest

A timer status pill for sessions in projects that track time with the harvest
CLI. Personal sessions never see it.

## How it works

- A journal project opts in by setting a `harvest` flag in its meta.json:
  `"harvest": true`, or `"harvest": { "note": "..." }` for per-project policy
  (which aliases apply, entry-note rules, thread quirks).
- After each agent turn (agent_end), the extension runs `harvest status --json
  --conceal` and shows the result as a footer pill:
  - timer running: `⏱ 0:42 Website` (elapsed + project name)
  - nothing running: `⏱ idle` in warning color — forgetting to start the timer
    is the failure this setup exists to fix
- `--conceal` strips money fields before they reach extension memory. Auth or
  CLI failures update nothing; the pill just goes stale rather than lying.
- The refresh deliberately skips session_start: the status call shells the CLI,
  whose auth chain can pop a 1Password unlock prompt, and that must never
  happen at session start. By turn end the user is demonstrably present.
- The same meta.json flag makes the shared journal context inject the harvest
  cheat-sheet (text in `../shared/harvest-policy.md`, generic on purpose; the
  per-project `note` is appended verbatim below it).

## Testing

`pill.test.ts` covers the pure formatting. Run `mise pi-check`.
