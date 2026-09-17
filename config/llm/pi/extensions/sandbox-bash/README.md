# sandbox-bash

Runs `bash` for a delegated agent under a macOS Seatbelt profile: read almost
anything, write only to scratch space, no network.

Opt in per agent by naming it in frontmatter — loading it is the whole opt-in,
there is no mode to set:

```yaml
tools: read,grep,find,ls,bash
extensions: sandbox-bash
```

## What the profile allows

| | |
|---|---|
| reads | everywhere except credential paths |
| writes | `$TMPDIR`, `/tmp`, `/dev/null`, `/dev/stdout`, `/dev/stderr`, `/dev/tty` |
| network | none |
| exec | allowed — confinement is about what a process can touch, not what it can run |

Reads are unrestricted by default because delegated work legitimately spans other
repositories and note directories. Denied reads:

- `~/.ssh`, `~/.gnupg`, `~/.aws`, `~/.config/gh`, `~/.docker`, `~/.config/op`,
  `~/Library/Keychains`, `~/.netrc`
- by name: `.env`, `.env.*`, `secrets/`, `*.pem`, `*.key`, `*.p12`, `*.pfx`,
  `*.cert`, `*.keystore`, `id_rsa*`, `id_ed25519*`, `id_ecdsa*`, `id_dsa*`

That is the same set the permission gate treats as sensitive. Network is blocked
as well, because a credential can also be quoted into the report the agent
returns, and the report travels to the model provider — so blocking egress alone
is not enough.

Dotfiles, `.git/hooks` and `.mcp.json` need no special rule: writes are denied by
default and only scratch space is re-allowed, so they are covered by
construction. This is where a config that allows workspace writes needs a
mandatory deny list, and this one does not.

## Nothing inspects the command

A command-name allowlist checks the string while leaving the program it launches
free, and every such filter leaks: `rg --pre`, `git -c core.pager=`,
`git --exec-path`, `tar --to-command`, `xz -c`. The kernel decides instead, so a
filter that is wrong fails closed rather than open.

The command reaches the sandbox as an environment value, never as shell text, so
its quoting cannot break out of the wrapper.

## Behaviour

- Loading it *is* the opt-in.
- Off macOS, or if the profile fails a smoke test at load, the override is not
  registered: bash stays as it was and the permission gate keeps confirming it.
  No silent fallback to unsandboxed.
- `PI_BASH_SANDBOX` is set while active, so the permission gate stops confirming
  a call the OS already confines.
- `GIT_OPTIONAL_LOCKS=0` is set: read-only git commands would otherwise refresh
  the index, which is a write the profile denies.
- This confines `bash`, not the process. `web_fetch`/`web_search` are extension
  tools running in the agent process, so they are outside it.

## Files

| File | Purpose |
|------|---------|
| `index.ts` | Activation, smoke test, `bash` override via `createBashTool`'s spawn hook |
| `wrap.ts` | Pure: `-D` params, shell quoting, the wrapper command |
| `profile.sbpl` | The Seatbelt profile |
| `wrap.test.ts` | Tests for the wrapper |
