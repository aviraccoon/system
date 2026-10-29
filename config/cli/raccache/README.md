# raccache

Offsite backup for the machines in this repo: mirrors each machine's targets to
every configured destination, and shows what every device in `devices.toml` is
doing. One binary, driven entirely by the machine's own config.

```
raccache run [--dry-run] [--only <target>] [--destination <name>] [--path <p>]...
raccache status [--watch] [--interval <s>] [--json] [--device <name>...]
raccache pause|resume|stop [--device <name>...]
raccache filters [--path <p>]... [<target>]
```

`raccache --help` is the flag reference. `run` is what the scheduler calls;
`status` is the default command.

```
$ raccache status
this machine (laptop) · 3s ago
  run     3 of 6 (nas/dev) · 12m elapsed
  running  run=4711 rclone=4712
  live    1.2 GiB / 3.4 GiB, 35%, 8.1 MiB/s, ETA 4m35s
  log     2026/10/17 13:41:07 INFO  : dev/foo/asset.bin: Copied (new)

storage (systemd) · 3s ago
  photos/2024                 412 GiB
  server/volumes              88 GiB
  units  backup-offsite=inactive  backup-services=inactive
  next   backup-offsite in 5h12m  backup-services in 6h40m
  log    offsite: 2026-10-17T07:02:11Z backup done rc=0
```

`run` counts the pass as destination/target pairs, so `3 of 6 (nas/dev)` is the
third pair of six with `nas/dev` transferring now. The `live` line is rclone's own
progress for that pair; a whole-run percentage would need every destination size,
which costs a recursive listing per target.

## Config

All of it lives in `~/.config/raccache/` and never in this repo.

| File | What it holds |
|------|---------------|
| `config` | `KEY=value` settings: `HOME_GATEWAY`, `POWER_GUARD`, `BW_LIMIT`, `RCLONE`, `GIT`, `BRCTL`, `INCLUDE`, `EXCLUDE`. `INCLUDE` and `EXCLUDE` replace the built-in defaults in `config.ts`, they do not add to them. |
| `targets.toml` | `[[target]]` rows: `dest` (directory under a destination), `src` (source tree), `gitignore` (follow the repos' `.gitignore` files). |
| `destinations.toml` | `[[destination]]` rows: `name`, `remote` (`{host}` expands to the short hostname), `mode` (`mirror` deletes, `copy` only adds), `flags` (extra rclone flags for provider quirks). |
| `devices.toml` | `[[device]]` rows: `name`, then either `local = true` or `ssh = "host"`. `units = [{ unit, log }]` marks a device whose jobs are systemd units, read through `remote.sh`. |
| `ignore` | Whole trees excluded from every target, one `$HOME`-relative pattern per line (`dev/reference/**`). |
| `env` | Optional `RCLONE_CONFIG_*` overrides. Read after `/run/secrets/rendered/raccache.env`. |
| `pause` | Present = `run` skips. |
| `ntfy-url` | Notification target: a topic or a URL. `RACCACHE_NTFY_URL` wins over it. A value with no scheme is read as an ntfy.sh topic, the shape the sops secret holds. |

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

## Slices

`run --path <pattern>` (repeatable) syncs only those paths, relative to each
selected target's root, with a trailing slash meaning the whole subtree: the
slice rules join the filter after the target's own rules — so an excluded path
stays excluded inside the slice — and a `- /**` closes the list. The include
exceptions are matched first, so those files ride along wherever they are;
everything else outside the slice is excluded. An entry that is not on disk under
the target, or a directory named without its trailing slash, is logged: rclone
reports such a pass as a success.
The sync then passes no `--delete-excluded` — everything outside the slice is
excluded, and the flag would delete it at the destination — while normal mirror
deletion inside the slice still happens. The filter goes to
`filter.<dest>.slice`, so a slice never leaves the target's own filter sliced on
disk, and `filters --path <pattern> <target>` prints what a slice would use.

A slice is for debugging and for a scoped catch-up, not for steady state: it
still lists the target's destination directory, and a terminal run of an iCloud
target cannot reproduce the cloud-only case below (a terminal read materialises
the file on the spot).

Symlinks are stored as `.rclonelink` files (`--links`), not followed or dropped:
repos track them, and dropping one leaves a restore that is quietly incomplete.
Restore a tree with `rclone copy --links` so they come back as links.

## Cloud-only files

iCloud Drive evicts the contents of files it does not need locally and leaves a
placeholder behind. A launchd job cannot materialise one on read, so rclone logs
`read <path>: resource deadlock avoided` and skips that target's delete phase
too, leaving the mirror add-only until those files read again. After a failed
sync the runner takes the paths out of that log line, asks the CloudDocs daemon
for a copy (`brctl download`; `BRCTL` overrides the path), waits for them to
read, and retries the pair once. The number of files the daemon had not fetched
within five minutes appears in the failure line. Only what the sync wanted to
read is fetched, so a file that is already at the destination is never pulled back.

## Secrets

`/run/secrets/rendered/raccache.env` is rendered by sops-nix from `secrets/raccache.yaml`
(see `modules/darwin/raccache.nix`): the rclone credentials as
`RCLONE_CONFIG_<REMOTE>_<KEY>` values plus `RACCACHE_NTFY_URL`. The runner passes
them to rclone, which lets the remote's *shape* stay in `~/.config/rclone` while
the secrets stay out of it. Machines without sops-nix can write the same file by
hand, or override single values in `~/.config/raccache/env`.

## Notifications

A run that moved files, and any run that failed, posts to the ntfy topic. Every
attempt is logged, as `notify: sent '...'` or `notify: NOT sent (<reason>)`, and a
run with nothing configured says so, so an alert that could not be delivered
never looks like a run with nothing to report.

## Scheduling

`modules/darwin/raccache.nix` installs the launchd agent (13:00 and 19:30, missed
calendar runs fire at wake) with `RCLONE` and `GIT` passed by path, since launchd
has no shell profile.

## Checks

```sh
mise tree-check config/cli/raccache   # this tree's tests (tsc is repo-wide; lint via `mise check`)
```
