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
| reads | outside `$HOME`, everything; inside `$HOME`, everything except dotfiles |
| writes | temp space (`/tmp`, `$TMPDIR`) and `/dev/{null,stdout,stderr,tty}` |
| network | none |
| exec | allowed — confinement is about what a process can touch, not what it can run |

Reads outside `$HOME` are unrestricted because delegated work legitimately spans
other repositories and note directories. Inside `$HOME` the default is closed: every
dot-entry is denied, and a few paths tools need are reopened above the credential
denies — git treats a denied config path as fatal, and mise needs its own state.
Whatever the reopenings miss stays closed.

The dotfile default is the load-bearing part. A list of credential paths can never
be complete — new tools add new stores — so the class is closed and the exceptions
are the reviewed part. A store the list has never heard of is unreadable because it
is a dotfile, not because someone remembered to add it.

Credential stores named after the reopenings are denied after them, so they win
inside them too; a short list of secret-bearing filenames is denied anywhere on the
filesystem. Because those match on the path, a scratch tree containing one cannot be
removed either — the deny blocks path resolution, not just the read. `profile.sbpl`
is the authority for both lists; they change and this page does not need to.

Network is blocked as well, because a credential can also be quoted into the report
the agent returns, and the report travels to the model provider — so blocking egress
alone is not enough. Keychain and pasteboard access is denied by Mach service name,
which a file-path deny cannot express: the keychain is reached through `securityd`,
not through a path.

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

- **Subagent**, opted in with `extensions: sandbox-bash`: the confined shell replaces
  `bash`, and the gate stops confirming it.
- **Main session**: a second tool, `bash_readonly`, with the unrestricted `bash` left
  in place. Nothing to configure.
- **Docker**: the daemon socket is equivalent to root on the host — `docker run -v
  /:/host --privileged` reads everything the profile denies. Granting it would void
  the boundary, so `docker` commands need the unrestricted `bash`.
- Off macOS, or if the profile fails at load: nothing is registered, and the gate
  keeps confirming `bash`. The load-time probe asserts the boundary (a `$HOME`
  write must fail, a credential read must fail, a scratch write must succeed) rather
  than that the profile parsed, so a profile that quietly stopped confining does not
  get registered.
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
