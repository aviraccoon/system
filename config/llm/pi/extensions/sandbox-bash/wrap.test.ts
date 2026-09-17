import { describe, expect, it } from "bun:test";
import { BASH_SANDBOX_ENV, isConfinedBash, SANDBOX_COMMAND_ENV } from "../shared/sandbox";
import { CONFINED_TOOL, READONLY_TOOL } from "../shared/shell-tools";
import { formatReadonlyCall, profileParams, SANDBOX_EXEC, sandboxCommand, sandboxMode, shellQuote } from "./wrap";

const PATHS = { home: "/Users/foo" };

describe("profileParams", () => {
  const params = profileParams(PATHS);

  it("names the credential stores the profile denies", () => {
    for (const expected of [
      "HOME_SSH=/Users/foo/.ssh",
      "HOME_GPG=/Users/foo/.gnupg",
      "HOME_AWS=/Users/foo/.aws",
      "HOME_GH=/Users/foo/.config/gh",
      "HOME_DOCKER=/Users/foo/.docker",
      "HOME_OP=/Users/foo/.config/op",
      "HOME_SOPS=/Users/foo/.config/sops",
      "HOME_GCLOUD=/Users/foo/.config/gcloud",
      "HOME_KUBE=/Users/foo/.kube",
      "HOME_KEYCHAINS=/Users/foo/Library/Keychains",
      "HOME_NETRC=/Users/foo/.netrc",
    ]) {
      expect(params).toContain(expected);
    }
  });

  it("closes every dot-entry under home, reopening only what tools need", () => {
    // The deny list can never be complete, so the class is closed instead.
    expect(params).toContain("HOME_DOTFILES=^/Users/foo/\\.[^/]*");
    for (const reopened of [
      "HOME_CONFIG_GIT=/Users/foo/.config/git",
      "HOME_CONFIG_MISE=/Users/foo/.config/mise",
      "HOME_LOCAL_SHARE_MISE=/Users/foo/.local/share/mise",
      "HOME_LOCAL_STATE_MISE=/Users/foo/.local/state/mise",
      "HOME_CACHE_MISE=/Users/foo/.cache/mise",
      "HOME_ZSHRC=/Users/foo/.zshrc",
    ]) {
      expect(params).toContain(reopened);
    }
  });

  it("escapes regex metacharacters in the home path", () => {
    expect(profileParams({ home: "/Users/a.b+c" })).toContain("HOME_DOTFILES=^/Users/a\\.b\\+c/\\.[^/]*");
  });

  it("keeps the scratch roots fixed and in resolved form", () => {
    // Fixed rather than taken from $TMPDIR: a TMPDIR under $HOME would otherwise
    // make $HOME a write zone. seatbelt matches vnodes, so /private/... is required.
    expect(params).toContain("SCRATCH_VAR_FOLDERS=/private/var/folders");
    expect(params).toContain("SCRATCH_TMP=/private/tmp");
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

describe("sandboxMode", () => {
  const base = { platform: "darwin", subagent: "1", hasSandboxExec: true, hasProfile: true };

  it("replaces bash in a spawned subagent", () => {
    expect(sandboxMode(base)).toBe("override");
  });

  it("adds a second tool in the main session", () => {
    // Pi auto-discovers every extension in the extensions directory, so this file
    // loads in the main session too. Replacing `bash` there would take the user's
    // own shell read-only; a separate tool leaves the unrestricted one alone.
    expect(sandboxMode({ ...base, subagent: undefined })).toBe("extra");
    expect(sandboxMode({ ...base, subagent: "" })).toBe("extra");
  });

  it("registers nothing off macOS or without the sandbox pieces", () => {
    expect(sandboxMode({ ...base, platform: "linux" })).toBeNull();
    expect(sandboxMode({ ...base, hasSandboxExec: false })).toBeNull();
    expect(sandboxMode({ ...base, hasProfile: false })).toBeNull();
  });
});

describe("shellQuote", () => {
  it("closes and reopens around a single quote", () => {
    expect(shellQuote("a'b")).toBe("'a'\\''b'");
  });
});

describe("formatReadonlyCall", () => {
  const plain = { fg: (_color: string, text: string) => text, bold: (text: string) => text };

  it("names the tool so it is distinguishable from bash", () => {
    // The built-in shell renderer prints `$ <command>`, the same prompt `bash`
    // shows, which made the two tools identical in the TUI.
    expect(formatReadonlyCall({ command: "git log" }, plain)).toBe(`${READONLY_TOOL} git log`);
  });

  it("keeps the timeout suffix the built-in renderer shows", () => {
    expect(formatReadonlyCall({ command: "rg x", timeout: 30 }, plain)).toBe(`${READONLY_TOOL} rg x (timeout 30s)`);
  });

  it("falls back like the built-in does for missing and invalid args", () => {
    expect(formatReadonlyCall({}, plain)).toBe(`${READONLY_TOOL} ...`);
    expect(formatReadonlyCall({ command: "" }, plain)).toBe(`${READONLY_TOOL} ...`);
    expect(formatReadonlyCall({ command: 42 }, plain)).toBe(`${READONLY_TOOL} [invalid arg]`);
    expect(formatReadonlyCall(null, plain)).toBe(`${READONLY_TOOL} ...`);
  });
});

describe("isConfinedBash", () => {
  it("matches only the tool the marker names", () => {
    process.env[BASH_SANDBOX_ENV] = READONLY_TOOL;
    expect(isConfinedBash(READONLY_TOOL)).toBe(true);
    expect(isConfinedBash("bash")).toBe(false);

    process.env[BASH_SANDBOX_ENV] = CONFINED_TOOL;
    expect(isConfinedBash("bash")).toBe(true);
    expect(isConfinedBash(READONLY_TOOL)).toBe(false);

    delete process.env[BASH_SANDBOX_ENV];
    expect(isConfinedBash("bash")).toBe(false);
    expect(isConfinedBash("")).toBe(false);
  });
});
