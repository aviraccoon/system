import { describe, expect, test } from "bun:test";
import { shellDenialReason } from "./denials";

const STATE = "/home/example/.pi/agent/state";

describe("shell command denials", () => {
  test("a command naming the gate's state is refused", () => {
    expect(shellDenialReason(`cat ${STATE}/review-ledger.json`, STATE)).toContain("state is written");
    expect(shellDenialReason("ls .pi/agent/state", STATE)).toContain("state is written");
  });

  test("a command naming core.hooksPath is refused, with or without git", () => {
    expect(shellDenialReason("git -c core.hooksPath=/dev/null commit", STATE)).toContain("core.hooksPath");
    // No `git` in the command: the prose says any command naming it is refused.
    expect(shellDenialReason("echo core.hooksPath", STATE)).toContain("core.hooksPath");
    // git's config names are case-insensitive.
    expect(shellDenialReason("git -c core.hookspath=/tmp/foo commit", STATE)).toContain("core.hooksPath");
  });

  test("clearing or reassigning an agent marker is refused", () => {
    for (const marker of ["PI_SESSION_ID", "PI_CODING_AGENT"]) {
      for (const command of [`env -u ${marker} git commit`, `unset ${marker}; git commit`, `${marker}= git commit`]) {
        const reason = shellDenialReason(command, STATE);
        expect(reason).toContain("do not clear or reassign");
        // The text an agent reads has to name the marker it just cleared.
        expect(reason).toContain(marker);
      }
      // Naming a marker without clearing it is ordinary work.
      expect(shellDenialReason(`git log --grep ${marker}`, STATE)).toBeNull();
    }
  });

  test("an unrelated command is allowed", () => {
    expect(shellDenialReason("git status --short", STATE)).toBeNull();
    expect(shellDenialReason("echo hello", STATE)).toBeNull();
    expect(shellDenialReason("git config --get user.name", STATE)).toBeNull();
  });
});
