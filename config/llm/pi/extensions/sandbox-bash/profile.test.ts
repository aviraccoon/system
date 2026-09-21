import { describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { boundaryProbeScript, profileParams, SANDBOX_EXEC, sandboxArgs } from "./wrap";

const PROFILE = join(import.meta.dir, "profile.sbpl");

function runs(profilePath: string, params: string[], script: string): boolean {
  try {
    execFileSync(SANDBOX_EXEC, sandboxArgs(profilePath, params, script), { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function deniedOutput(script: string): string {
  try {
    execFileSync(SANDBOX_EXEC, sandboxArgs(PROFILE, PARAMS, script), { stdio: ["ignore", "pipe", "pipe"] });
    return "";
  } catch (err) {
    return (err as { stderr?: Buffer }).stderr?.toString() ?? "";
  }
}

/**
 * These tests spawn `sandbox-exec`, so the darwin sandbox has to be available to
 * *this* process. It is not when the suite runs inside the confined shell — a
 * nested `sandbox_apply` is refused — so the suite skips there instead of failing.
 * That keeps `mise pi-check` usable from `bash_readonly`.
 */
function nestable(): boolean {
  if (process.platform !== "darwin" || !existsSync(SANDBOX_EXEC)) return false;
  const dir = mkdtempSync(join(tmpdir(), "sandbox-probe-"));
  const allowAll = join(dir, "allow-all.sbpl");
  writeFileSync(allowAll, "(version 1)\n(allow default)\n");
  const ok = runs(allowAll, [], ":");
  rmSync(dir, { recursive: true, force: true });
  return ok;
}

const HOME = (() => {
  try {
    return realpathSync(homedir());
  } catch {
    return homedir();
  }
})();

const PARAMS = profileParams({ home: HOME });

describe.skipIf(!nestable())("profile.sbpl", () => {
  it("holds against the profile the extension loads", () => {
    expect(runs(PROFILE, PARAMS, boundaryProbeScript())).toBe(true);
  });

  it("is rejected by the probe once it stops confining", () => {
    // The probe has to discriminate. If it only proved the profile parsed, a
    // silently weakened profile would register and the gate would auto-allow a
    // shell that merely looks confined.
    const dir = mkdtempSync(join(tmpdir(), "sandbox-open-"));
    const allowAll = join(dir, "allow-all.sbpl");
    writeFileSync(allowAll, "(version 1)\n(allow default)\n");
    expect(runs(allowAll, PARAMS, boundaryProbeScript())).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it("refuses a write outside scratch, leaving nothing behind", () => {
    const script = `if touch "$HOME/.pi-sandbox-probe" 2>/dev/null; then rm -f "$HOME/.pi-sandbox-probe"; exit 0; fi; exit 1`;
    expect(runs(PROFILE, PARAMS, script)).toBe(false);
    expect(existsSync(join(HOME, ".pi-sandbox-probe"))).toBe(false);
  });

  it("allows a scratch write", () => {
    expect(runs(PROFILE, PARAMS, `f=$(mktemp) && rm -f "$f"`)).toBe(true);
  });

  it("refuses a credential read", () => {
    for (const path of [".ssh", ".aws", ".gnupg", ".config/sops", ".config/gcloud"]) {
      if (!existsSync(join(HOME, path))) continue;
      expect(runs(PROFILE, PARAMS, `ls "$HOME/${path}" >/dev/null 2>&1`)).toBe(false);
    }
  });

  it("closes a dotfile that no rule names", () => {
    if (!existsSync(join(HOME, ".zsh_history"))) return;
    expect(runs(PROFILE, PARAMS, `cat "$HOME/.zsh_history" >/dev/null 2>&1`)).toBe(false);
  });

  it("lets node's realpath walk resolve the reopened subtrees' ancestor segments", () => {
    // Metadata only: node stats each segment on the way to a script entry.
    for (const segment of [".local", ".local/share", ".local/state", ".config", ".cache"]) {
      if (!existsSync(join(HOME, segment))) continue;
      expect(runs(PROFILE, PARAMS, `[ -d "$HOME/${segment}" ]`)).toBe(true);
    }
  });

  it("denies metadata of an entry in an unreopened .local subtree", () => {
    // Created by the test: the denial fires on an existing vnode — a missing
    // leaf yields ENOENT under a correct profile too, so an absent fixture
    // would make a correct profile fail and a broken one pass. Deliberately
    // not secret-shaped: a filename deny would confound the assertion.
    const parent = join(HOME, ".local/share");
    const parentWasMissing = !existsSync(parent);
    mkdirSync(parent, { recursive: true });
    const dir = mkdtempSync(join(parent, "sandbox-bash-test-"));
    try {
      expect(deniedOutput(`stat "${dir}"`)).toContain("not permitted");
    } finally {
      rmSync(dir, { recursive: true, force: true });
      if (parentWasMissing) rmSync(parent, { recursive: true, force: true });
    }
  });
});
