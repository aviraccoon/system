# sandbox-bash

Runs `bash` for a delegated agent under a macOS Seatbelt profile: read almost
anything, write only to scratch space, no network.

Opt in per agent by naming it in frontmatter (no mode to set):

```yaml
tools: read,grep,find,ls,bash
extensions: sandbox-bash
```

## What the profile allows

| | |
|---|---|
| reads | outside `$HOME`, everything; inside `$HOME`, everything except dotfiles |
| writes | temp space (`/tmp`, `$TMPDIR`) and `/dev/{null,stdout,stderr,tty}` |
| network | none |
| exec | allowed — confinement is about what a process can touch, not what it can run |

Reads outside `$HOME` are open because delegated work spans other repositories and
note directories. Inside `$HOME` everything is closed by default: every dot-entry is
denied (a credential-path list can never be complete — new tools add new stores),
and a few paths tools need are reopened above the credential denies (git treats a
denied config path as fatal; mise needs its own state). Credential stores inside
those reopened paths, plus secret-bearing filenames anywhere on the filesystem, are
denied after the reopenings, so a credential deny beats the reopen. Denies match on
path, so a scratch tree containing a matching name cannot be removed either.
`profile.sbpl` is the authority for both lists.

Network is blocked because a credential can be quoted into the report the agent
returns, and the report goes to the model provider. Keychain and pasteboard access
is denied by Mach service name; a path deny cannot express that.

Writes are denied by default and only scratch space is re-allowed, so dotfiles,
`.git/hooks` and `.mcp.json` need no separate rule.

## Behaviour

- **Subagent**, opted in with `extensions: sandbox-bash`: the confined shell replaces
  `bash`, and the gate stops confirming it.
- **Main session**: a second tool, `bash_readonly`, with the unrestricted `bash` left
  in place. Nothing to configure.
- **Docker**: the daemon socket is equivalent to root on the host (`docker run -v
  /:/host --privileged` reads everything the profile denies), so `docker` commands
  need the unrestricted `bash`.
- **Off macOS, or when the profile fails to load**: nothing is registered, and the
  gate keeps confirming `bash`. The load-time probe asserts the boundary (a `$HOME`
  write and a credential read must fail, a scratch write must succeed), so a profile
  that stopped confining is not registered.
- **No command inspection**: a name allowlist leaves the launched program free
  (`rg --pre`, `git -c core.pager=`, `git --exec-path`, `tar --to-command`), so the
  kernel decides instead. The command reaches the sandbox as an environment value,
  so its quoting cannot break out of the wrapper.
- `GIT_OPTIONAL_LOCKS=0` is set, so read-only git commands do not try to refresh the
  index.
- This confines the shell, not the process: `web_fetch`/`web_search` run in the agent
  process and are outside it.

## Files

| File | Purpose |
|------|---------|
| `index.ts` | Activation, boundary probe, `bash` override via `createBashToolDefinition`'s spawn hook |
| `wrap.ts` | Pure: `-D` params, shell quoting, the wrapper command |
| `profile.sbpl` | The Seatbelt profile |
| `wrap.test.ts` | Tests for the wrapper |
