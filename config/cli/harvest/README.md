# harvest CLI

Harvest time tracking (API v2) from the terminal, for you and for any agent with shell access. Runs on bun, no runtime dependencies.

## Setup

1. Create a Personal Access Token at https://id.getharvest.com/developers (Developers section) — not an OAuth2 app (those are for integrations you ship). It shows the token and your account ID.
2. Store the token and account ID in one of these places, checked in order:
   - `HARVEST_TOKEN` + `HARVEST_ACCOUNT_ID` env vars
   - 1Password: item `Harvest API` (any vault) with fields `token` and `account-id`; `op` must be unlocked.
   - Secret files: `/run/secrets/harvest-token` + `/run/secrets/harvest-account-id` (sops-nix), or override with `HARVEST_TOKEN_FILE` / `HARVEST_ACCOUNT_FILE`
   - macOS keychain or Linux secret-tool (not available on Windows); `harvest whoami` prints the store commands.
3. Check auth: `harvest whoami`

Config lives at `~/.config/harvest/config.json`. Most setups need only the 1Password account shorthand:

```json
{ "op": { "account": "<shorthand>" } }
```

Override `vault`, `item`, or the field names if your 1Password item differs. `hourlyRate` and `requireNoteLinks` are documented below.

## Commands

| Command | What it does |
|---|---|
| `harvest` | status (default) |
| `harvest status` | running timer + today's entries and total |
| `harvest start acme dev -n "fixing login"` | start a timer (stops any running one) |
| `harvest start acme dev --offset 25m` | start, crediting time already spent |
| `harvest stop` | stop the running timer |
| `harvest log 1:30 acme dev --date 2026-09-14` | log past time; hours: `1.5`, `1:30`, `90m` |
| `harvest edit <id> [--hours H] [-n text] [--date D] [--project P] [--task T]` | edit an entry; `--project`/`--task` move it |
| `harvest delete <id> [--force]` | delete; prompts on a TTY, agents use `--force` |
| `harvest today` | today's entries and total |
| `harvest week` | ISO week, per-day and per-project totals |
| `harvest month [YYYY-MM]` | monthly overview, per-project hours and money |
| `harvest audit [YYYY-MM \| --days N \| --from D --to D]` | scan a range for entries needing attention |
| `harvest projects` | list projects + refresh cache |
| `harvest tasks acme` | list tasks assigned to a project |
| `harvest alias [list\|ls]` | list aliases |
| `harvest alias acme "Acme Website" Development` | set an alias (task optional) |
| `harvest alias -r acme` | remove an alias |
| `harvest whoami` | auth check: user, timer mode, cache state |

Project and task matches are fuzzy (name, code, or client; a number is an id), and ambiguous or missing matches print candidates with ids. Entry lists lead each line with the entry id, so `edit`/`delete` take it directly. An alias without a task leaves the task to each `start`/`log`; a project with only one task needs no task argument.

- `edit --project P [--task T]` moves an entry. The project resolves by alias, id, or name (an alias's stored task is not used); without `--task`, the entry's task carries over when the target project has it, or the target has only one task — otherwise the command fails with the target's task list.
- `audit` flags missing notes, notes without a link, zero/whole-hour durations, and duplicate entries; running entries skip the duration checks. A flagged locked entry needs its timesheet reopened first. It only reports — fix with `harvest edit <id>`.
- `--group-by project|task|note` regroups today/week/month into one list with hours and money per group; tasks show as `project / task`, and notes group by their first line so the same item merges across days.

## Notes

- `requireNoteLinks: true` in the config warns when a created or updated note has no http(s) link. It never blocks — some entries legitimately have no link — and the warning names the `harvest edit <id> -n` fix.
- Duration accounts count hours; start/end accounts record `started_time`, and `log` derives a range ending now. `harvest whoami` shows the mode.
- Projects and tasks cache in `~/.cache/harvest/cache.json`, 24 h TTL, refreshed by `harvest projects` and on a lookup miss. The list is your Harvest project assignments; Member roles cannot see account-wide projects. Neither file holds credentials.
- A timer left running from a previous day is flagged `STALE` by `status`.
- Money shows in status/today/week/month when a rate is known; `--conceal` strips it from text and JSON. `hourlyRate` in the config (e.g. `620`) overrides entry rates, and Member roles see no entry rates at all. Amounts use raw tracked hours (Harvest's 0.01 h = 36 s granularity) while H:MM rounds to the minute, so a total can differ from rate × displayed time. `billable` and report rounding are ignored; currency comes from the account.
- Windows runs the CLI, but the keychain/secret-tool auth fallback is absent — use 1Password or env vars there.

## Development

```bash
mise harvest-check    # biome + tsc + bun test
bun run harvest.ts <command>   # without the symlink
```
