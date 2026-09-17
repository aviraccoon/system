/**
 * Sandboxed bash for delegated agents.
 *
 * Registers an override of the built-in `bash` tool that runs the whole command
 * under a macOS Seatbelt profile: reads almost anywhere, writes only to scratch
 * space, no network. Nothing inspects the command — a command-name allowlist
 * would check the string while leaving the program it launches free to do
 * anything, and every such filter leaks (`rg --pre`, `git -c core.pager=`,
 * `git --exec-path`, `tar --to-command`). The kernel decides instead.
 *
 * Opt in per agent by naming this extension in its frontmatter:
 *
 *   tools: read,grep,find,ls,bash
 *   extensions: sandbox-bash
 *
 * That is the per-agent opt-in for the *subagent* case, where the confined shell
 * replaces `bash` outright. Pi auto-discovers every extension in the extensions
 * directory, so this file also loads in the main session; there it registers the
 * same confined shell under a second name and leaves the unrestricted `bash`
 * alone, because that shell cannot write and the main session has to commit, test
 * and build. See `sandboxMode`. Off macOS, or if the profile fails a smoke test,
 * nothing is registered and `bash` stays as it was.
 *
 * `PI_BASH_SANDBOX` is set while active so the permission gate can stop
 * confirming a call the OS already confines.
 */

import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createBashToolDefinition, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { BASH_SANDBOX_ENV, SANDBOX_COMMAND_ENV } from "../shared/sandbox";
import { CONFINED_TOOL, READONLY_TOOL } from "../shared/shell-tools";
import {
  boundaryProbeScript,
  formatReadonlyCall,
  profileParams,
  SANDBOX_EXEC,
  sandboxArgs,
  sandboxCommand,
  sandboxMode,
} from "./wrap";

const PROFILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "profile.sbpl");

/** Seatbelt matches resolved vnode paths, so symlinked dirs must be real paths. */
function real(pathname: string): string {
  try {
    return realpathSync(pathname);
  } catch {
    return pathname;
  }
}

export default function sandboxBash(pi: ExtensionAPI) {
  const mode = sandboxMode({
    platform: process.platform,
    subagent: process.env.PI_SUBAGENT,
    hasSandboxExec: existsSync(SANDBOX_EXEC),
    hasProfile: existsSync(PROFILE),
  });

  // Clear immediately, then set only once every check has passed. The gate
  // auto-allows `bash` on the strength of this value, so a marker left behind by
  // a previous reload would silently skip confirmation for an unconfined shell —
  // and setting it before the smoke test would do the same on a profile failure.
  delete process.env[BASH_SANDBOX_ENV];
  if (mode === null) return;

  const params = profileParams({ home: real(os.homedir()) });

  // Smoke-test the boundary, not the profile's syntax. A profile that parses but
  // no longer confines would still set the marker and let the gate auto-allow a
  // shell that only looks confined, so this refuses to register unless the probe
  // can show a $HOME write refused, a credential path unreadable, and a scratch
  // write allowed.
  try {
    execFileSync(SANDBOX_EXEC, sandboxArgs(PROFILE, params, boundaryProbeScript()), { stdio: "ignore" });
  } catch {
    return;
  }

  const confinedTool = mode === "override" ? CONFINED_TOOL : READONLY_TOOL;

  // The *definition*, not `createBashTool`: that one wraps the definition into an
  // AgentTool, and `wrapToolDefinition` copies only name/label/description/
  // parameters/execute — renderCall and renderResult are dropped. A tool with no
  // renderCall shows its output in the TUI with no command above it.
  const tool = createBashToolDefinition(process.cwd(), {
    spawnHook: ({ command, cwd, env }) => ({
      command: sandboxCommand(PROFILE, params),
      cwd,
      env: {
        ...env,
        // The command travels as a value, not as shell text: the wrapper's shell
        // expands this into an argument for the sandboxed shell, so nothing in
        // the command can break out of the wrapper.
        [SANDBOX_COMMAND_ENV]: command,
        // Read-only git commands still want to refresh the index, which is a
        // write the profile denies.
        GIT_OPTIONAL_LOCKS: "0",
      },
    }),
  });

  const execute = async (
    id: string,
    args: { command: string; timeout?: number },
    signal: AbortSignal | undefined,
    onUpdate: Parameters<typeof tool.execute>[3],
    ctx: Parameters<typeof tool.execute>[4],
  ) => {
    return tool.execute(id, args, signal, onUpdate, ctx);
  };

  // The built-in shell renderer titles every call `$ <command>`, which is the same
  // prompt `bash` shows. Delegate to it — it also records the start time the
  // elapsed-time line reads — and restate only the title. The subagent override
  // keeps the original: there is no TUI there to confuse.
  const baseRenderCall = tool.renderCall;
  const renderCall = (...params: Parameters<NonNullable<typeof baseRenderCall>>) => {
    const [args, theme, context] = params;
    const component = baseRenderCall?.(args, theme, context) ?? new Text("", 0, 0);
    if (component instanceof Text) component.setText(formatReadonlyCall(args, theme));
    return component;
  };

  if (mode === "override") {
    pi.registerTool({ ...tool, execute });
    process.env[BASH_SANDBOX_ENV] = confinedTool;
    return;
  }

  // Main session: a second tool, not a replacement. The description carries the
  // choice — this one cannot write, so anything that commits, installs or fetches
  // has to go through `bash` and its confirmation.
  pi.registerTool({
    ...tool,
    name: READONLY_TOOL,
    label: "bash (read-only)",
    description:
      "Execute a shell command in a read-only sandbox: no writes outside the temp dir, no network, no Docker. Use it to inspect state — git log/diff/show/status, rg, find, cat, jq, wc. It cannot write, install, fetch or reach the Docker daemon (that socket is equivalent to root on the host); those need `bash`. Returns stdout and stderr, truncated to the last lines or 50KB.",
    promptSnippet: "bash_readonly: read-only shell — never prompts",
    promptGuidelines: [
      "ALWAYS reach for `bash_readonly` before `bash` when inspecting state: it is confined by the OS and never prompts, while `bash` prompts on every call. Docker is the exception — `docker ps` and friends need `bash`.",
    ],
    renderCall,
    execute,
  });

  // Set only after the last registration succeeded. Registering can throw, and a
  // marker set first would then auto-allow the unrestricted built-in `bash` with
  // no confirmation — the same fail-open shape as a marker left behind by a
  // reload.
  process.env[BASH_SANDBOX_ENV] = confinedTool;
}
