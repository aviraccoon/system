# raccache

Offsite backup for the machines in this repo: mirrors each machine's targets to
every configured destination, and shows what every device in `devices.toml` is
doing. One binary, driven entirely by the machine's own config.

```
raccache run [--dry-run] [--only <target>] [--destination <name>]
raccache status [--watch] [--interval <s>] [--json] [--device <name>...]
raccache pause|resume|stop [--device <name>...]
raccache filters [<target>]
```

`raccache --help` is the flag reference. `run` is what the scheduler calls;
`status` is the default command.

## Config

All of it lives in `~/.config/raccache/` and never in this repo.

| File | What it holds |
|------|---------------|
| `config` | `KEY=value` settings: `HOME_GATEWAY`, `POWER_GUARD`, `BW_LIMIT`, `RCLONE`, `GIT`, `INCLUDE`, `EXCLUDE`. `INCLUDE` and `EXCLUDE` replace the built-in defaults in `config.ts`, they do not add to them. |
| `targets.toml` | `[[target]]` rows: `dest` (directory under a destination), `src` (source tree), `gitignore` (follow the repos' `.gitignore` files). |
| `destinations.toml` | `[[destination]]` rows: `name`, `remote` (`{host}` expands to the short hostname), `mode` (`mirror` deletes, `copy` only adds), `flags` (extra rclone flags for provider quirks). |
| `devices.toml` | `[[device]]` rows: `name`, then either `local = true` or `ssh = "host"`. `units = [{ unit, log }]` marks a device whose jobs are systemd units, read through `remote.sh`. |
| `ignore` | Whole trees excluded from every target, one `$HOME`-relative pattern per line (`dev/reference/**`). |
| `env` | Optional `RCLONE_CONFIG_*` overrides. Read after `/run/secrets/raccache.env`. |
| `pause` | Present = `run` skips. |
| `ntfy-url` | Notification topic; `RACCACHE_NTFY_URL` wins over it. |

Missing `targets.toml`, `destinations.toml` or `devices.toml`: the first two are
errors, `devices.toml` falls back to this machine alone.

## Filters

Each target gets a generated rclone filter at `~/.config/raccache/filter.<dest>`.
`raccache filters` prints one without syncing. In order: the include exceptions
(`AGENTS.local.md`, `CLAUDE.local.md`, `.env`, `.env.*`, `mise.local.toml`),
the exclude patterns from `config`, then — for `gitignore = true` targets — every
path `git ls-files --ignored --others --exclude-standard --directory` reports for
each repo under the target, then the `ignore` file.

A repo whose `git ls-files` fails contributes no rules and a warning: missing
rules over-upload, they never delete. An `ignore` line that would exclude a whole
target is refused and fails the run.

`mode = "mirror"` passes `--delete-excluded`, so a rule that appears also removes
the matching files from the destination; recover them through the bucket's
hidden-file lifecycle. `mode = "copy"` never deletes.

## Secrets

`/run/secrets/raccache.env` is rendered by sops-nix from `secrets/raccache.yaml`
(see `modules/darwin/raccache.nix`): the rclone credentials as
`RCLONE_CONFIG_<REMOTE>_<KEY>` values plus `RACCACHE_NTFY_URL`. The runner passes
them to rclone, which lets the remote's *shape* stay in `~/.config/rclone` while
the secrets stay out of it. Machines without sops-nix can write the same file by
hand, or override single values in `~/.config/raccache/env`.

## Scheduling

`modules/darwin/raccache.nix` installs the launchd agent (13:00 and 19:30, missed
calendar runs fire at wake) with `RCLONE` and `GIT` passed by path, since launchd
has no shell profile.

## Checks

```sh
mise tree-check config/cli/raccache   # tsc --noEmit + bun test
```
