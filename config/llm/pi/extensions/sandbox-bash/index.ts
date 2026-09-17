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
 * Loading it is the whole opt-in — there is no mode to configure. On a platform
 * without seatbelt, or if the profile fails a smoke test, the override is not
 * registered and bash stays as it was.
 *
 * `PI_BASH_SANDBOX` is set while active so the permission gate can stop
 * confirming a call the OS already confines.
 */

import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createBashTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { BASH_SANDBOX_ENV, SANDBOX_COMMAND_ENV } from "../shared/sandbox";
import { profileParams, SANDBOX_EXEC, sandboxCommand } from "./wrap";

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
  if (process.platform !== "darwin" || !existsSync(SANDBOX_EXEC) || !existsSync(PROFILE)) return;

  const params = profileParams({
    home: real(os.homedir()),
    tmpdir: real(os.tmpdir()),
    tmp: real("/tmp"),
  });

  // Smoke-test the profile before trusting it. A profile that fails to load
  // would turn every bash call into a confusing sandbox error; refusing to
  // register leaves bash unsandboxed and gate-confirmed, which is the safe
  // degradation.
  const probe: string[] = [];
  for (const param of params) probe.push("-D", param);
  try {
    execFileSync(SANDBOX_EXEC, [...probe, "-f", PROFILE, "/bin/sh", "-c", ":"], { stdio: "ignore" });
  } catch {
    return;
  }

  process.env[BASH_SANDBOX_ENV] = "read-only";

  const tool = createBashTool(process.cwd(), {
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

  pi.registerTool({
    ...tool,
    execute: async (id, args, signal, onUpdate, _ctx) => {
      return tool.execute(id, args, signal, onUpdate);
    },
  });
}
