import { describe, expect, it } from "bun:test";
import { BASH_SANDBOX_ENV, bashSandboxed, SANDBOX_COMMAND_ENV } from "../shared/sandbox";
import { profileParams, SANDBOX_EXEC, sandboxCommand, shellQuote, shouldActivate } from "./wrap";

const PATHS = { home: "/Users/foo", tmpdir: "/private/var/folders/ab/T", tmp: "/private/tmp" };

describe("profileParams", () => {
  const params = profileParams(PATHS);

  it("names the credential directories the profile denies", () => {
    expect(params).toContain("HOME_SSH=/Users/foo/.ssh");
    expect(params).toContain("HOME_GPG=/Users/foo/.gnupg");
    expect(params).toContain("HOME_AWS=/Users/foo/.aws");
    expect(params).toContain("HOME_GH=/Users/foo/.config/gh");
    expect(params).toContain("HOME_DOCKER=/Users/foo/.docker");
    expect(params).toContain("HOME_OP=/Users/foo/.config/op");
    expect(params).toContain("HOME_KEYCHAINS=/Users/foo/Library/Keychains");
    expect(params).toContain("HOME_NETRC=/Users/foo/.netrc");
  });

  it("passes temp dirs as the paths seatbelt will see", () => {
    // seatbelt matches resolved vnodes, so /var/folders would match nothing.
    expect(params).toContain("TMPDIR=/private/var/folders/ab/T");
    expect(params).toContain("TMP=/private/tmp");
  });
});

describe("sandboxCommand", () => {
  it("hands the command to the sandboxed shell indirectly", () => {
    // The wrapper must not contain the agent's command at all: the shell reads
    // it from the environment, so no quoting in it can escape the wrapper.
    const cmd = sandboxCommand("/repo/profile.sbpl", []);
    expect(cmd).toBe(`${SANDBOX_EXEC} -f '/repo/profile.sbpl' /bin/sh -c "$${SANDBOX_COMMAND_ENV}"`);
  });

  it("passes every param through -D, quoted", () => {
    const cmd = sandboxCommand("/repo/profile.sbpl", ["A=1", "B=/has space"]);
    expect(cmd).toContain("-D 'A=1'");
    expect(cmd).toContain("-D 'B=/has space'");
  });

  it("quotes a profile path containing a quote", () => {
    expect(sandboxCommand("/it's/profile.sbpl", [])).toContain("-f '/it'\\''s/profile.sbpl'");
  });
});

describe("shouldActivate", () => {
  const base = { platform: "darwin", subagent: "1", hasSandboxExec: true, hasProfile: true };

  it("activates for a spawned subagent on macOS", () => {
    expect(shouldActivate(base)).toBe(true);
  });

  it("stays inert in the main session", () => {
    // Pi auto-discovers every extension in the extensions directory, so this
    // file loads in the main session too. Activating there takes the user's own
    // shell read-only.
    expect(shouldActivate({ ...base, subagent: undefined })).toBe(false);
    expect(shouldActivate({ ...base, subagent: "" })).toBe(false);
  });

  it("stays inert off macOS", () => {
    expect(shouldActivate({ ...base, platform: "linux" })).toBe(false);
  });

  it("stays inert without sandbox-exec or the profile", () => {
    expect(shouldActivate({ ...base, hasSandboxExec: false })).toBe(false);
    expect(shouldActivate({ ...base, hasProfile: false })).toBe(false);
  });
});

describe("shellQuote", () => {
  it("closes and reopens around a single quote", () => {
    expect(shellQuote("a'b")).toBe("'a'\\''b'");
  });
});

describe("bashSandboxed", () => {
  it("follows the environment marker", () => {
    delete process.env[BASH_SANDBOX_ENV];
    expect(bashSandboxed()).toBe(false);
    process.env[BASH_SANDBOX_ENV] = "read-only";
    expect(bashSandboxed()).toBe(true);
    delete process.env[BASH_SANDBOX_ENV];
  });
});
