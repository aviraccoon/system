# harvest CLI

Terminal and agent access to Harvest time tracking (API v2). Any agent with shell access can use it; no MCP server.

Runs on bun. Zero runtime dependencies.

## Setup

1. Create a Personal Access Token at https://id.getharvest.com/developers (Developers section). The page shows the token and your account IDs. Use "Create new personal access token", not an OAuth2 application, unless you are shipping an integration for other users: OAuth2 tokens expire (18h, plus a refresh flow), while a PAT is a static bearer token for your own account.
2. Store the token and account ID in one of these places, checked in order:
   - `HARVEST_TOKEN` + `HARVEST_ACCOUNT_ID` env vars
   - 1Password: item `Harvest API` (any vault) with fields `token` and `account-id` — the default, since 1Password logs CLI reads.
   - Secret files: `/run/secrets/harvest-token` + `/run/secrets/harvest-account-id` (sops-nix), or override with `HARVEST_TOKEN_FILE` / `HARVEST_ACCOUNT_FILE`
   - macOS keychain (`security find-generic-password -s harvest -a token|account-id -w`) or Linux `secret-tool lookup service harvest account token|account-id` (not available on Windows)

3. Check auth: `harvest whoami`

`op` reads need the 1Password app unlocked. Reference customization goes in `~/.config/harvest/config.json`:

```json
{
  "op": { "account": "<shorthand>", "vault": "Private", "item": "Harvest API", "tokenField": "token", "accountField": "account-id" },
  "userAgent": "harvest-cli (you@example.com)"
}
```

Harvest wants a `User-Agent` with app name and contact. The default works; a real contact helps if you hit the API throttle (100 req/15s).

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
| `harvest alias` | list aliases |
| `harvest alias acme "Acme Website" Development` | set an alias (task optional) |
| `harvest alias -r acme` | remove an alias |
| `harvest whoami` | auth check: user, timer mode, cache state |

Project and task arguments are fuzzy-matched (case-insensitive, `-`/`_`/space equivalent; matches name, code, or client); a numeric argument matches by id instead. Ambiguous matches list the candidates with ids, so the next command can take an id directly. An alias without a task defers the task choice to each start/log; with one task assigned, it's picked automatically.

`--json` prints structured output. Money appears in status/today/week/month when a rate is known; `--conceal` hides amounts (screen-sharing, pasted output) in both text and JSON (strips amount/rate fields).

Entry lists (status, today, week) lead each line with the entry id, so `edit`/`delete` need no `--json` detour.

`edit --project` moves an entry to another project (the project resolves like `log`: alias, id, or fuzzy name; an alias's stored task is not used here). Without `--task`, the entry's task carries over when the target project has that task assigned (Harvest task ids are account-global, so sibling projects often share a task set), or the target's only task is used; otherwise the command fails listing the target's tasks — pass `--task` with a name or id.

`harvest audit [YYYY-MM | --days N | --from D --to D]` scans a date range (default: current month, one range mode at a time) for data-quality flags: notes missing entirely, notes with no link, zero-hour entries, whole-hour durations (a sign of guessed time), and entries that repeat another entry's date/project/task/hours/notes. Running entries are exempt from the duration checks. A locked entry (its timesheet was submitted) is tagged only when it also has a flag: a clean locked entry needs no action, a flagged one needs the timesheet reopened. It only reports; fix with `harvest edit <id>`. `--json` returns the flagged entries with their issue tags and the resolved `range`.

`--group-by project|task|note` regroups today/week/month into a flat list with hours and money per group. Tasks are labelled `project / task`; notes group by their first line (the work-item summary), so the same item tracked across days merges. Multiline notes render in full — first line after the entry, continuation lines indented.

`start --offset <duration>` credits time spent before the timer started. Duration accounts get it as base hours on the running entry; start/end accounts get a backdated `started_time`.

## Notes

- `start` stops any running timer first (Harvest allows only one).
- `requireNoteLinks: true` in `~/.config/harvest/config.json` warns when a created or updated entry's note has no http(s) link. It's a warning, not a block (legitimate entries can lack links); the fix line points at `harvest edit <id> -n`.
- Timer mode follows the account setting (`wants_timestamp_timers`): duration accounts get a running entry from a bare `start`; start/end accounts get `started_time` set. `log` on start/end accounts derives a time range ending now.
- Projects and tasks are cached in `~/.cache/harvest/cache.json` (24h TTL, refreshed by `harvest projects` and on lookup misses). The list comes from your Harvest project assignments — Member roles cannot list account-wide projects, and assignments are exactly what you can track time on. Config lives in `~/.config/harvest/config.json`. Neither file contains credentials.
- A timer left running from a previous day is flagged `STALE` by `status`.
- Money views (`month`): `hourlyRate` in `~/.config/harvest/config.json` (e.g. `"hourlyRate": 620`) is the rate; when unset, entries' Harvest rates are used, though Member roles see none. Amounts use the exact tracked hours, which Harvest stores at 0.01 h granularity (36-second buckets); the H:MM display rounds to the minute, so amounts can differ from rate × displayed time by a few units. The `billable` flag and the account's report rounding (`rounded_hours`, e.g. 15-min intervals) are ignored. Currency comes from the account (cached with company settings).
- macOS, Linux, and Windows (bun is cross-platform; the macOS keychain / Linux secret-tool fallbacks are not — on Windows use 1Password or env vars).

## Development

```bash
mise harvest-check    # biome + tsc + bun test
bun run harvest.ts <command>   # without the symlink
```

Source layout: `harvest.ts` (arg parsing, dispatch), `commands.ts` (command logic), `api.ts` (HTTP client), `resolve.ts` (fuzzy matching), `format.ts` (time math, output bodies), `config.ts` (config/cache/auth). Pure logic is separated from I/O for tests; API calls are stubbed via `HarvestClient` in tests.
