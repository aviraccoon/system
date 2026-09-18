# sandbox-bash

Runs `bash` for a delegated agent under a macOS Seatbelt profile: read almost
anything, write only to scratch space, no network.

Opt in per agent by naming it in frontmatter:

```yaml
tools: read,grep,find,ls,bash
extensions: sandbox-bash
```

## What the profile allows

| | |
|---|---|
| reads | everything except dot-entries under `$HOME` and the credential paths `profile.sbpl` denies |
| writes | temp space (`/tmp`, `$TMPDIR`) and `/dev/{null,stdout,stderr,tty}` |
| network | none |
| exec | allowed — confinement is about what a process can touch, not what it can run |

Reads outside `$HOME` are open. Inside `$HOME` every dot-entry is denied, with a few
paths reopened for tools that treat a missing config file as fatal (git, mise, shell
startup files) plus `~/.local/bin`, which is on PATH. Credential stores inside those
paths stay denied, and secret-bearing filenames are denied anywhere on the filesystem —
the deny also blocks path resolution, so a scratch tree containing a matching name
cannot be removed either. `profile.sbpl` is the authority for these lists.

Keychain and pasteboard access is denied too, by Mach service name.

Writes go only to scratch space, so dotfiles, `.git/hooks` and `.mcp.json` are not
writable either.

## Behaviour

- **Subagent**, opted in with `extensions: sandbox-bash`: the confined shell replaces
  `bash`, and the gate stops confirming it.
- **Main session**: a second tool, `bash_readonly`, with the unrestricted `bash` left
  in place. Nothing to configure.
- **Local daemons**: no unix socket on this machine is reachable, so any client that
  talks to a daemon fails. `nix eval --expr` still works (host-side eval); `nix build`,
  `nix flake` and `nix-instantiate` do not, and `tmux ls` fails the same way. Docker
  commands need the unrestricted `bash`.
- **Off macOS, or when the profile fails its boundary probe**: nothing is registered,
  and the gate keeps confirming `bash`.
- **Which commands run is not restricted** — only what they can touch.

## Files

| File | Purpose |
|------|---------|
| `index.ts` | Activation, boundary probe, tool registration |
| `profile.test.ts` | Tests for the Seatbelt profile |
| `wrap.ts` | Pure: `-D` params, shell quoting, the wrapper command |
| `profile.sbpl` | The Seatbelt profile |
| `wrap.test.ts` | Tests for the wrapper |
