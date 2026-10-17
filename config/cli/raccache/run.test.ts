import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { showRunProgress } from "./collect";
import { DEFAULT_EXCLUDE, DEFAULT_INCLUDE, paths, type Settings, type Target } from "./config";
import { parseRunProgress } from "./format";
import { generateFilter, logLinesSince, pairLabels, pairMessages, type RunOptions, runBackup, startLine } from "./run";

const dirs: string[] = [];
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "raccache-run-"));
  dirs.push(dir);
  return dir;
};

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const settings = (): Settings => ({
  powerGuard: true,
  bwLimit: "63M",
  rclone: "rclone",
  git: "git",
  brctl: "/usr/bin/brctl",
  include: [...DEFAULT_INCLUDE],
  exclude: [...DEFAULT_EXCLUDE],
});

describe("startLine", () => {
  const target: Target = { dest: "dev", src: "/home/example/dev", gitignore: false };
  const destination = { name: "b2", remote: "b2crypt:laptop", mode: "mirror" as const, flags: [] };

  test("round-trips through the parser, including a narrowed pass", () => {
    const planned = pairLabels([target], [destination]);
    expect(planned).toEqual(["b2/dev"]);
    const text = `2026-10-17T05:00:00.000Z ${startLine(planned, false)}\n`;
    expect(parseRunProgress(text, [], Date.parse("2026-10-17T05:05:00.000Z"))).toBe("1 of 1 (b2/dev) · 5m elapsed");
  });

  test("keeps the dry-run marker out of the pair list", () => {
    const planned = pairLabels([target], [destination]);
    const text = `2026-10-17T05:00:00.000Z ${startLine(planned, true)}\n`;
    expect(text).toContain("1 pair, dry run:");
    expect(parseRunProgress(text, [], Date.parse("2026-10-17T05:01:00.000Z"))).toBe("1 of 1 (b2/dev) · 1m elapsed");
  });
});

describe("pairLabels and pairMessages", () => {
  const targets: Target[] = [
    { dest: "dev", src: "/home/example/dev", gitignore: true },
    { dest: "Documents", src: "/home/example/Documents", gitignore: false },
  ];
  const destinations = [
    { name: "b2", remote: "b2crypt:laptop", mode: "mirror" as const, flags: [] },
    { name: "r2", remote: "r2crypt:laptop", mode: "copy" as const, flags: [] },
  ];

  test("pairs are target-major, matching the runner's loop order", () => {
    expect(pairLabels(targets, destinations)).toEqual(["b2/dev", "r2/dev", "b2/Documents", "r2/Documents"]);
  });

  test("every failure line the runner writes ends its pair", () => {
    const stamped = pairMessages(destinations, "dev", "FAILED to build filters: boom").map(
      (line) => `2026-10-17T05:00:10.000Z ${line}`,
    );
    const text = `2026-10-17T05:00:00.000Z ${startLine(pairLabels(targets, destinations), false)}\n${stamped.join("\n")}\n`;
    expect(parseRunProgress(text, [], Date.parse("2026-10-17T05:03:00.000Z"))).toBe(
      "3 of 4 (b2/Documents) · 3m elapsed",
    );
  });

  test("a per-target failure ends that pair for every destination", () => {
    expect(pairMessages(destinations, "dev", "ABORTED: on battery power")).toEqual([
      "b2/dev ABORTED: on battery power",
      "r2/dev ABORTED: on battery power",
    ]);
  });
});

describe("showRunProgress", () => {
  test("needs a live runner and a plan", () => {
    expect(showRunProgress(null, ["b2/dev"])).toBe(false);
    expect(showRunProgress("123", [])).toBe(false);
    expect(showRunProgress("123", ["b2/dev"])).toBe(true);
  });
});

describe("logLinesSince", () => {
  test("the offset is a byte count, so multibyte lines before it do not shift the slice", () => {
    const dir = tempDir();
    const file = join(dir, "log");
    writeFileSync(file, "2026/10/17 13:00:00 INFO  : přes/žluťoučký.txt: Copied (new)\n");
    const offset = statSync(file).size;
    appendFileSync(file, "2026/10/17 13:00:01 INFO  : b.txt: Copied (new)\n");
    expect(logLinesSince(file, offset)).toEqual(["2026/10/17 13:00:01 INFO  : b.txt: Copied (new)"]);
  });

  test("a missing log is empty, not an error", () => {
    expect(logLinesSince(join(tempDir(), "missing"), 0)).toEqual([]);
  });
});

describe("generateFilter", () => {
  const setup = (ignoreLines: string): { target: Target; p: ReturnType<typeof paths>; src: string } => {
    const root = tempDir();
    const src = join(root, "dev");
    const repo = join(src, "acme");
    mkdirSync(join(repo, "junk"), { recursive: true });
    writeFileSync(join(repo, ".gitignore"), "junk/\n");
    writeFileSync(join(repo, "junk/artifact.bin"), "junk\n");
    execFileSync("git", ["-c", "init.defaultBranch=main", "init", "--quiet", repo]);
    const configDir = join(root, "config");
    mkdirSync(configDir, { recursive: true });
    if (ignoreLines) writeFileSync(join(configDir, "ignore"), ignoreLines);
    const p = paths({ dir: configDir, home: root });
    return { target: { dest: "dev", src, gitignore: true }, p, src };
  };

  test("writes the exceptions, the repo's ignored paths, and the user's whole trees", () => {
    const { target, p } = setup("dev/reference/**\n");
    const { file, rules } = generateFilter(target, settings(), p);
    expect(rules.errors).toEqual([]);
    expect(rules.lines.slice(0, 3)).toEqual(["+ AGENTS.local.md", "+ CLAUDE.local.md", "+ .env"]);
    expect(rules.lines).toContain("- /acme/junk/");
    expect(rules.lines).toContain("- /reference/**");
    const written = readFileSync(file, "utf8");
    expect(written).toContain("- /acme/junk/");
    expect(written.endsWith("\n")).toBe(true);
  });

  test("surfaces an ignore line that would exclude the whole target", () => {
    const { target, p } = setup("dev/**/*\n");
    const { rules } = generateFilter(target, settings(), p);
    expect(rules.errors).toHaveLength(1);
    expect(rules.errors[0]).toContain("whole 'dev' target");
  });

  test("a target without gitignore has no repo rules", () => {
    const { target, p } = setup("");
    const { rules } = generateFilter({ ...target, gitignore: false }, settings(), p);
    expect(rules.stats.repos).toBe(0);
    expect(rules.lines.some((line) => line.includes("acme"))).toBe(false);
  });
});

describe("runBackup", () => {
  /**
   * End to end against stub rclone and brctl binaries: the first sync reports a
   * cloud-only file and fails; `deliver` decides what makes it readable afterwards
   * (the daemon, the file itself, or nothing). Holds "the pair is retried once".
   */
  const harness = (deliver: "brctl" | "never" | "self" = "brctl") => {
    const root = tempDir();
    const src = join(root, "src");
    mkdirSync(join(src, "sub"), { recursive: true });
    const note = join(src, "note.pdf");
    writeFileSync(note, "content");
    // Unreadable here stands in for a file whose content is still in iCloud.
    chmodSync(note, 0o000);

    const brctlLog = join(root, "brctl.args");
    const brctl = join(root, "brctl");
    // "brctl" = the daemon delivers, "self" = the file becomes readable on its own
    // between the failed read and the check, "never" = it stays cloud-only.
    const deliverLine = deliver === "brctl" ? 'chmod 644 "$2"\n' : "";
    const selfLine = deliver === "self" ? `chmod 644 "${note}"\n` : "";
    writeFileSync(brctl, `#!/bin/sh\necho "$@" >> "${brctlLog}"\n${deliverLine}`);
    chmodSync(brctl, 0o755);

    const syncCount = join(root, "sync.count");
    const argsFile = join(root, "rclone.args");
    const rclone = join(root, "rclone");
    writeFileSync(
      rclone,
      `#!/bin/sh
echo "$@" >> "${argsFile}"
case "$1" in
  version) echo "rclone v0.0.0"; exit 0 ;;
  listremotes) echo "stub:"; exit 0 ;;
esac
log=""
while [ $# -gt 0 ]; do
  case "$1" in
    --log-file) log="$2"; shift ;;
  esac
  shift
done
n=$(cat "${syncCount}" 2>/dev/null || echo 0); n=$((n+1)); echo "$n" > "${syncCount}"
if [ "$n" = "1" ]; then
  echo "2026/10/17 13:27:38 ERROR : note.pdf: Failed to copy: Post \\"https://example.invalid/upload\\": read ${note}: resource deadlock avoided" >> "$log"
${selfLine}  exit 1
fi
echo "2026/10/17 13:28:00 INFO  : note.pdf: Copied (new)" >> "$log"
exit 0
`,
    );
    chmodSync(rclone, 0o755);

    const configDir = join(root, "config");
    mkdirSync(configDir);
    writeFileSync(join(configDir, "config"), `RCLONE=${rclone}\nBRCTL=${brctl}\nPOWER_GUARD=0\n`);
    writeFileSync(join(configDir, "targets.toml"), `[[target]]\ndest = "dev"\nsrc = "${src}"\n`);
    writeFileSync(join(configDir, "destinations.toml"), `[[destination]]\nname = "stub"\nremote = "stub:laptop"\n`);
    return { root, configDir, log: join(root, "raccache.log"), note, brctlLog, syncCount, argsFile };
  };

  /** Run against a scratch config and a scratch log, without the machine's secrets. */
  const isolatedRun = async (configDir: string, log: string, options: RunOptions = {}): Promise<number> => {
    const saved = {
      log: process.env.RACCACHE_LOG,
      secrets: process.env.RACCACHE_SECRETS_ENV,
      dir: process.env.RACCACHE_CONFIG_DIR,
    };
    process.env.RACCACHE_LOG = log;
    process.env.RACCACHE_SECRETS_ENV = join(configDir, "no-secrets.env");
    delete process.env.RACCACHE_CONFIG_DIR;
    try {
      return await runBackup({ configDir, platform: "linux", ...options });
    } finally {
      for (const [key, value] of Object.entries({
        RACCACHE_LOG: saved.log,
        RACCACHE_SECRETS_ENV: saved.secrets,
        RACCACHE_CONFIG_DIR: saved.dir,
      })) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  };

  test("fetches what the log named as unreadable and retries the pair once", async () => {
    const { configDir, log, note, brctlLog, syncCount } = harness();
    const rc = await isolatedRun(configDir, log);

    expect(rc).toBe(0);
    const text = readFileSync(log, "utf8");
    expect(text).toContain("stub/dev dataless: 1 named, 1 readable");
    expect(text).toContain("stub/dev ok (1 new, 0 changed, 0 deleted)");
    expect(text).toContain("notify: NOT sent (no ntfy URL configured)");
    expect(readFileSync(brctlLog, "utf8")).toBe(`download ${note}\n`);
    expect(readFileSync(syncCount, "utf8").trim()).toBe("2");
  });

  test("a file the daemon never fetches fails the pair once, with a count", async () => {
    const { configDir, log, note, brctlLog, syncCount } = harness("never");
    const rc = await isolatedRun(configDir, log, { materialize: { intervalMs: 0, deadlineMs: 0 } });

    expect(rc).toBe(1);
    const text = readFileSync(log, "utf8");
    expect(text).toContain("stub/dev dataless: 1 named, 0 readable, 1 still cloud-only");
    expect(text).toContain("stub/dev FAILED rc=1 (1 file(s) still cloud-only)");
    expect(readFileSync(brctlLog, "utf8")).toBe(`download ${note}\n`);
    expect(readFileSync(syncCount, "utf8").trim()).toBe("1");
  });

  test("a named path that reads on its own is retried even when nothing was fetched", async () => {
    const { configDir, log, brctlLog, syncCount } = harness("self");
    const rc = await isolatedRun(configDir, log, { materialize: { intervalMs: 0, deadlineMs: 0 } });

    expect(rc).toBe(0);
    const text = readFileSync(log, "utf8");
    expect(text).toContain("stub/dev dataless: 1 named, 1 readable");
    expect(text).toContain("stub/dev ok (1 new, 0 changed, 0 deleted)");
    // Nothing to fetch, so the daemon was never asked.
    expect(existsSync(brctlLog)).toBe(false);
    expect(readFileSync(syncCount, "utf8").trim()).toBe("2");
  });

  test("a --path slice writes its own filter and drops --delete-excluded", async () => {
    const { configDir, log, argsFile } = harness();
    const rc = await isolatedRun(configDir, log, { path: ["note.pdf"] });

    expect(rc).toBe(0);
    const text = readFileSync(log, "utf8");
    expect(text).toContain("slice: note.pdf");
    expect(text).toContain(", 1 slice");
    // The excluded rest of the target must not be deleted at the destination.
    expect(readFileSync(argsFile, "utf8")).not.toContain("--delete-excluded");
    const filter = readFileSync(join(configDir, "filter.dev.slice"), "utf8").split("\n");
    expect(filter).toContain("+ /note.pdf");
    expect(filter[filter.length - 2]).toBe("- /**");
  });

  test("a slice that transfers nothing is logged, not reported as a clean pass", async () => {
    const { configDir, log } = harness();
    await isolatedRun(configDir, log, { path: ["nope.pdf", "sub", "note.pdf/"] });

    const text = readFileSync(log, "utf8");
    expect(text).toContain("'nope.pdf' is not found (or not readable) under");
    expect(text).toContain("'sub' is a directory - add a trailing slash");
    expect(text).toContain("'note.pdf/' names a file - drop the trailing slash");
  });
});
