/**
 * Recurring failure signals across local pi sessions.
 *
 * Streams the session JSONL files under `~/.pi/agent/sessions` and
 * `~/.pi/agent/subagent-sessions`, counts each entry once (fork and resume
 * replay history, deduplicated by entry id and timestamp) and buckets entries
 * by their own month, so a resumed session's later entries land in the later
 * row; `--since` filters entries, not files. Prints per month: tool-call
 * volume, exact-match edit failures and user-blocked calls per 1k tool calls,
 * assistant self-admissions per 1k assistant messages, and advisory counts,
 * plus the most common tool-error signatures. The point is targeting harness
 * rules at patterns that are still live, rather than adding prose the model
 * already ignores. Aggregates carry no message content; `--examples` prints
 * the last 120 correction-shaped user messages and is opt-in.
 *
 * Usage:
 *   bun scripts/llm/session-report.ts [--since YYYY-MM] [--root DIR] [--examples]
 */

import { createReadStream, readdirSync, type Stats, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";
import { type CliSpec, scriptCli } from "../../config/shared/cli";

interface Month {
  sessions: number;
  users: number;
  assistants: number;
  tools: number;
  editFail: number;
  blocked: number;
  advisories: number;
  selfAdm: number;
}

const CORRECT_START = /^(no|nope|stop|don'?t|not|wrong|actually|wait|hmm|why|hold on|eh)\b/i;
const SELF_ADMISSION = /\b(i apologi[sz]e|my mistake|my bad|i was wrong|i got (that|it) wrong|i misread)\b/i;
const EDIT_FAIL = /^(patch failed|Could not find the exact text|Could not find edits\[)/;
const MONTH = /^\d{4}-\d{2}$/;
const PATH_LIKE = /(?:~|\/)?(?:[\w.-]+\/)+[\w.-]+/g;

/**
 * Collapse a tool error to the failure class: paths and counts vary per
 * occurrence, and without stripping them the top list is singleton rows.
 */
function signatureOf(text: string): string {
  return text
    .replace(PATH_LIKE, "<path>")
    .replace(/\b\d+\b/g, "N")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 90);
}

function* walk(dir: string, depth: number): Generator<string> {
  let entries: string[] = [];
  try {
    entries = readdirSync(dir).sort();
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(dir, entry);
    let stat: Stats;
    try {
      stat = statSync(path);
    } catch {
      continue;
    }
    if (stat.isDirectory() && depth > 0) yield* walk(path, depth - 1);
    else if (stat.isFile() && entry.endsWith(".jsonl")) yield path;
  }
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => (part && typeof part === "object" && (part as { text?: string }).text) || "").join("\n");
}

const SPEC: CliSpec = {
  name: "session-report",
  summary: "aggregate pi session counts and tool events by month",
  usage: "bun scripts/llm/session-report.ts [flags]",
  flags: [
    { key: "since", type: "string", usage: "--since <YYYY-MM>", help: "only months from this one on" },
    { key: "root", type: "string", usage: "--root <dir>", help: "sessions root (default: both pi session dirs)" },
    { key: "examples", type: "boolean", usage: "--examples", help: "print example snippets" },
    { key: "help", type: "boolean", short: "h", global: true, usage: "-h, --help", help: "this help" },
  ],
};
const values = scriptCli(SPEC).values;

const root = typeof values.root === "string" ? values.root : undefined;
const roots = root ? [root] : [join(homedir(), ".pi/agent/sessions"), join(homedir(), ".pi/agent/subagent-sessions")];
const since = typeof values.since === "string" ? values.since : "";
if (since && !MONTH.test(since)) throw new Error(`--since takes YYYY-MM, got: ${since}`);

const months = new Map<string, Month>();
const toolErrors = new Map<string, number>();
const examples: { ts: string; text: string }[] = [];
const seen = new Set<string>();

function bucketFor(month: string): Month {
  let bucket = months.get(month);
  if (!bucket) {
    bucket = { sessions: 0, users: 0, assistants: 0, tools: 0, editFail: 0, blocked: 0, advisories: 0, selfAdm: 0 };
    months.set(month, bucket);
  }
  return bucket;
}

for (const root of roots) {
  for (const file of walk(root, 2)) {
    const fileMonth = basename(file).slice(0, 7);
    const fallbackMonth = MONTH.test(fileMonth) ? fileMonth : "";
    let counted = false;

    try {
      const lines = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
      let line = 0;
      for await (const raw of lines) {
        line++;
        let entry: {
          type?: string;
          id?: string;
          timestamp?: string;
          message?: { role?: string; content?: unknown; isError?: boolean };
        };
        try {
          entry = JSON.parse(raw);
        } catch {
          continue;
        }
        if (entry.type !== "message" || !entry.message) continue;

        const month = (entry.timestamp ?? "").slice(0, 7) || fallbackMonth;
        if (!MONTH.test(month) || month < since) continue;
        const key = entry.id ? `${entry.id}:${entry.timestamp ?? ""}` : `${file}:${line}`;
        if (seen.has(key)) continue;
        seen.add(key);

        const bucket = bucketFor(month);
        if (!counted) {
          // The session is counted once, in the month of its first entry shown.
          bucket.sessions++;
          counted = true;
        }

        const message = entry.message;
        const text = textOf(message.content);
        if (message.role === "user") {
          bucket.users++;
          if (values.examples && CORRECT_START.test(text.trim())) {
            examples.push({ ts: entry.timestamp ?? "", text: text.replace(/\s+/g, " ").slice(0, 200) });
          }
        } else if (message.role === "assistant") {
          bucket.assistants++;
          if (SELF_ADMISSION.test(text)) bucket.selfAdm++;
        } else if (message.role === "toolResult") {
          bucket.tools++;
          if (EDIT_FAIL.test(text)) bucket.editFail++;
          if (text.startsWith("BLOCKED by user")) bucket.blocked++;
          if (text.startsWith("output-capture")) bucket.advisories++;
          if (message.isError) {
            const signature = signatureOf(text);
            if (signature) toolErrors.set(signature, (toolErrors.get(signature) ?? 0) + 1);
          }
        }
      }
    } catch {
      // A session file can vanish (the picker deletes sessions, the subagent
      // store prunes) or be unreadable; skip it rather than losing the report.
    }
  }
}

const rate = (count: number, total: number, scale: number): string =>
  total === 0 ? "  -  " : ((count / total) * scale).toFixed(1).padStart(5);

const columns: [string, number][] = [
  ["month", 7],
  ["sessions", 8],
  ["users", 6],
  ["tools", 6],
  ["editFail/1k", 11],
  ["blocked/1k", 10],
  ["selfAdm/1k", 10],
  ["advisories", 10],
];
const printRow = (cells: string[]) =>
  console.log(cells.map((cell, i) => cell.padStart(columns[i]?.[1] ?? 0)).join("  "));
printRow(columns.map(([name]) => name));
for (const month of [...months.keys()].sort()) {
  const m = months.get(month);
  if (!m) continue;
  printRow([
    month,
    String(m.sessions),
    String(m.users),
    String(m.tools),
    rate(m.editFail, m.tools, 1000),
    rate(m.blocked, m.tools, 1000),
    rate(m.selfAdm, m.assistants, 1000),
    String(m.advisories),
  ]);
}

console.log("\ntop tool errors");
for (const [signature, count] of [...toolErrors.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)) {
  console.log(`  ${String(count).padStart(5)}  ${signature}`);
}

const recent = examples.sort((a, b) => a.ts.localeCompare(b.ts)).slice(-120);
if (values.examples && recent.length > 0) {
  console.log(`\nrecent correction-shaped user messages (last ${recent.length})`);
  for (const example of recent) console.log(`  ${example.ts.slice(0, 7)} | ${example.text}`);
}
