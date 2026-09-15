# harvest CLI

Terminal and agent access to Harvest time tracking (API v2). Any agent with shell access can use it — no MCP server needed.

Runs on bun. Zero runtime dependencies.

## Setup

1. Create a Personal Access Token at https://id.getharvest.com/developers (Developers section). The page shows the token and your account IDs. Use "Create new personal access token", not an OAuth2 application — OAuth2 apps are for integrations distributed to other users; their tokens expire (18h, plus a refresh flow), while a PAT is a static bearer token for your own account.
2. Store the token and account ID in one of these places, checked in order:
   - `HARVEST_TOKEN` + `HARVEST_ACCOUNT_ID` env vars
   - 1Password: item `Harvest API` (any vault) with fields `token` and `account-id`. 1Password shows CLI reads in its audit log, which is why this is the default.
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

Harvest asks for a `User-Agent` with app name and contact; the default works, but a real contact is better if you ever hit the API throttle (100 req/15s).

## Commands

```
harvest                       # status (default)
harvest status                # running timer + today's entries and total
harvest start acme dev -n "fixing login"
harvest stop
harvest log 1:30 acme dev --date 2026-09-14   # hours: 1.5 | 1:30 | 90m
harvest edit <entry-id> [--hours H] [-n text] [--date D]
harvest today
harvest week                  # ISO week, per-day and per-project totals
harvest month [YYYY-MM]       # monthly overview, per-project hours and money
harvest projects              # list + refresh cache
harvest tasks acme
harvest alias                 # list
harvest alias acme "Acme Website" Development   # task optional
harvest alias -r acme
harvest whoami
```

Project and task arguments are fuzzy-matched (case-insensitive, `-`/`_`/space equivalent; matches name, code, or client). Ambiguous matches list the candidates. An alias without a task defers the task choice to each start/log; with one task assigned, it's picked automatically.

`--json` prints structured output. Money appears in status/today/week/month when a rate is known; `--conceal` hides amounts (screen-sharing, pasted output).

## Notes

- `start` stops any running timer first (Harvest allows only one).
- Timer mode follows the account setting (`wants_timestamp_timers`): duration accounts get a running entry from a bare `start`; start/end accounts get `started_time` set. `log` on start/end accounts derives a time range ending now.
- Projects and tasks are cached in `~/.cache/harvest/cache.json` (24h TTL, refreshed by `harvest projects` and on lookup misses). The list comes from your Harvest project assignments — Member roles cannot list account-wide projects, and assignments are exactly what you can track time on. Config lives in `~/.config/harvest/config.json`. Neither file contains credentials.
- A timer left running from a previous day is flagged `STALE` by `status`.
- Money views (`month`): `hourlyRate` in `~/.config/harvest/config.json` (e.g. `"hourlyRate": 620`) is the rate; when unset, entries' Harvest rates are used, though Member roles see none. Amounts use the exact tracked hours, which Harvest stores at 0.01 h granularity (36-second buckets) — neither seconds nor whole minutes. The H:MM display rounds to the minute, so amounts can differ from rate × displayed time by a few units. The `billable` flag is ignored, and the per-account report rounding (`rounded_hours`, e.g. 15-min intervals where configured) is not applied — raw hours are the ground truth. Currency comes from the account (cached with company settings).
- macOS, Linux, and Windows (bun is cross-platform; the macOS keychain / Linux secret-tool fallbacks are not — on Windows use 1Password or env vars).

## Development

```bash
mise harvest-check    # biome + tsc + bun test
bun run harvest.ts <command>   # without the symlink
```

Source layout: `harvest.ts` (arg parsing, dispatch), `commands.ts` (command logic), `api.ts` (HTTP client), `resolve.ts` (fuzzy matching), `format.ts` (time math, output bodies), `config.ts` (config/cache/auth). Pure logic is separated from I/O for tests; API calls are stubbed via `HarvestClient` in tests.
