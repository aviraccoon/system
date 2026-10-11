/**
 * Permission-gate audit over local pi sessions.
 *
 * Reads the `classified` entries the permission gate appends, joins each to its
 * tool call, dialog and outcome, and prints aggregate counts for threshold
 * tuning. Session files replay history on fork and resume with the same row ids,
 * so classified calls are deduplicated by tool call id.
 *
 * Usage:
 *   bun scripts/llm/gate-report.ts [--since YYYY-MM-DD] [--tool bash] [--detail]
 *
 * Aggregates by default; `--detail` prints one line per call with the command's
 * first line. Message content and dialog notes never print.
 */

import { readdirSync, readFileSync, type Stats, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

interface Record_ {
  file: string;
  ts: string | null;
  toolName: string;
  verdict: string;
  factors: Record<string, number>;
  hadDialog: boolean;
  outcome: "allowed" | "blocked-by-user" | "blocked-by-policy" | "unknown-error" | "no-result";
  command: string;
  note: boolean;
}

function* walk(dir: string, depth: number): Generator<string> {
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
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

/** Factor scores the gate logged, which are the ones at or above 0.3. */
function parseFactors(detail: string): Record<string, number> {
  const out: Record<string, number> = {};
  const factorPart = detail.split(/\n\s*\n/)[0] ?? "";
  for (const line of factorPart.split("\n")) {
    const match = line.match(/^\s*\*?\s*([a-z_]+)\s+([01]\.\d+)\s*$/);
    const name = match?.[1];
    const value = match?.[2];
    if (name && value) out[name] = Number(value);
  }
  return out;
}

/** First command token after env assignments and a leading cd/sleep/echo. */
function firstToken(command: string): string {
  let rest = command.trim();
  for (let i = 0; i < 6; i++) {
    rest = rest.replace(/^[A-Za-z_][A-Za-z0-9_]*=(?:'[^']*'|"[^"]*"|\S*)\s+/, "");
    rest = rest.replace(/^(?:cd\s+[^&;|]+\s*(?:&&|;)\s*)/, "");
    rest = rest.replace(/^(?:sleep\s+\d+\s*;\s*)/, "");
    rest = rest.replace(/^(?:echo\s+[^&;|]+\s*(?:&&|;)\s*)/, "");
  }
  return (rest.match(/^(\S+)/)?.[1] ?? "").replace(/['"]/g, "");
}

/** Structural class of a command's first token; the token itself otherwise. */
function commandClass(command: string): string {
  const token = firstToken(command);
  if (/^(python3?|node|bun|deno|perl|ruby|php|awk|fd|sed)$/.test(token)) return "interpreter/tool";
  if (token === "docker") return "container";
  if (token === "git" || token === "gh") return "vcs";
  if (token === "curl" || token === "wget") return "network";
  return token || "(pipeline)";
}

function count<T>(items: T[], key: (item: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const item of items) {
    const k = key(item);
    out[k] = (out[k] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(out).sort((a, b) => b[1] - a[1]));
}

const { values } = parseArgs({
  options: {
    since: { type: "string" },
    tool: { type: "string" },
    detail: { type: "boolean", default: false },
  },
});
const since = values.since ? Date.parse(values.since) : Date.now() - 30 * 24 * 3600 * 1000;
if (Number.isNaN(since)) throw new Error(`--since is not a date: ${values.since}`);

const roots = [join(homedir(), ".pi/agent/sessions"), join(homedir(), ".pi/agent/subagent-sessions")];
const byCallId = new Map<string, Record_>();
let files = 0;

for (const root of roots) {
  for (const file of walk(root, 2)) {
    let stat: Stats;
    try {
      stat = statSync(file);
    } catch {
      continue;
    }
    if (stat.mtimeMs < since) continue;
    files++;

    const calls = new Map<string, { tool: string; target: string; command: string }>();
    const results = new Map<string, { text: string; isError: boolean }>();
    const classified = new Map<string, { ts: string | null; verdict: string; detail: string; toolName: string }>();
    const pending = new Set<string>();
    const notes = new Set<string>();

    for (const line of readFileSync(file, "utf8").split("\n").filter(Boolean)) {
      let row: { type?: string; customType?: string; data?: Record<string, unknown>; timestamp?: string };
      try {
        row = JSON.parse(line);
      } catch {
        continue;
      }
      if (row.type === "custom" && row.customType === "permission_gate") {
        const data = row.data ?? {};
        const id = typeof data.toolCallId === "string" ? data.toolCallId : null;
        if (!id) continue;
        if (data.event === "classified") {
          classified.set(id, {
            ts: row.timestamp ?? null,
            verdict: String(data.verdict ?? "?"),
            detail: String(data.detail ?? ""),
            toolName: String(data.toolName ?? "?"),
          });
        } else if (data.event === "pending_confirmation") {
          pending.add(id);
        }
        continue;
      }
      const message = (row as { message?: Record<string, unknown> }).message;
      if (!message) continue;
      const content = message.content;
      if (message.role === "assistant" && Array.isArray(content)) {
        for (const part of content as Array<{
          type?: string;
          id?: string;
          name?: string;
          arguments?: Record<string, unknown>;
        }>) {
          if (part?.type !== "toolCall" || !part.id) continue;
          const args = part.arguments ?? {};
          const edits = Array.isArray(args.edits) ? (args.edits as Array<{ path?: unknown }>) : [];
          // The same target the gate's note attribution names: a command, a path,
          // or a patch's first edit path, whitespace-collapsed and clipped.
          const raw =
            typeof args.command === "string"
              ? args.command
              : typeof args.path === "string"
                ? args.path
                : typeof edits[0]?.path === "string"
                  ? edits[0].path
                  : "";
          calls.set(part.id, {
            tool: String(part.name ?? ""),
            target: raw.replace(/\s+/g, " ").trim().slice(0, 99),
            command: String(args.command ?? args.task ?? args.path ?? ""),
          });
        }
      } else if (message.role === "toolResult" && typeof message.toolCallId === "string") {
        const parts = Array.isArray(content) ? content : [];
        results.set(message.toolCallId, {
          text: parts.map((part) => (part as { text?: string }).text ?? "").join("\n"),
          isError: message.isError === true,
        });
      } else if (message.role === "user") {
        const text = Array.isArray(content)
          ? content.map((part) => (part as { text?: string }).text ?? "").join("")
          : String(content ?? "");
        for (const match of text.matchAll(/\[note on the (.+?) call: (.*?)\]/g)) {
          if (match[2]) notes.add(`${match[1]}\u0000${match[2]}`);
        }
      }
    }

    for (const [id, entry] of classified) {
      if (byCallId.has(id)) continue;
      if (entry.ts && Date.parse(entry.ts) < since) continue;
      const result = results.get(id);
      const call = calls.get(id);
      // A blocked call arrives as an error result carrying the gate's reason.
      // An unmatched error stays unknown rather than counting as allowed.
      const outcome: Record_["outcome"] =
        result === undefined
          ? "no-result"
          : !result.isError
            ? "allowed"
            : /BLOCKED by user/i.test(result.text)
              ? "blocked-by-user"
              : /permission-gate denied this call|blocked in non-interactive mode|NOT (executed|written|modified|performed)/i.test(
                    result.text,
                  )
                ? "blocked-by-policy"
                : "unknown-error";
      const note = [...notes].find((candidate) => {
        const [tool, target] = candidate.split("\u0000");
        return tool === entry.toolName && (call?.target ?? "").startsWith((target ?? "").replace(/\.\.\.$/, ""));
      });
      byCallId.set(id, {
        file: file.replace(homedir(), "~"),
        ts: entry.ts,
        toolName: entry.toolName,
        verdict: entry.verdict,
        factors: parseFactors(entry.detail),
        hadDialog: pending.has(id),
        outcome,
        command: call?.command ?? "",
        note: note !== undefined,
      });
    }
  }
}

const all = [...byCallId.values()].filter((r) => !values.tool || r.toolName === values.tool);
const show = (label: string, entries: Record<string, number>): void => {
  console.log(`${label}: ${JSON.stringify(entries)}`);
};

console.log(
  `${files} session files, ${all.length} distinct classified calls since ${new Date(since).toISOString().slice(0, 10)}`,
);
show(
  "verdict",
  count(all, (r) => r.verdict),
);
show(
  "verdict/tool",
  count(
    all.filter((r) => r.verdict !== "safe"),
    (r) => `${r.verdict}/${r.toolName}`,
  ),
);

for (const verdict of ["dangerous", "risky"]) {
  const entries = all.filter((r) => r.verdict === verdict);
  if (entries.length === 0) continue;
  console.log(`\n${verdict}: ${entries.length}`);
  show(
    "  outcome",
    count(entries, (r) => r.outcome),
  );
  console.log(
    `  with a dialog: ${entries.filter((r) => r.hadDialog).length}, with a dialog note: ${entries.filter((r) => r.note).length}`,
  );
  const fired: Record<string, number> = {};
  for (const entry of entries) {
    for (const [factor, probability] of Object.entries(entry.factors)) {
      if (probability >= 0.5) fired[factor] = (fired[factor] ?? 0) + 1;
    }
  }
  show("  factors >= 0.5", Object.fromEntries(Object.entries(fired).sort((a, b) => b[1] - a[1])));
}

const bash = all.filter((r) => r.toolName === "bash" && r.command);
if (bash.length > 0) {
  console.log("\nbash by command class:");
  for (const [cls, n] of Object.entries(count(bash, (r) => commandClass(r.command)))) {
    console.log(`  ${cls.padEnd(20)} ${n}`);
  }
}

if (values.detail) {
  console.log("\nper call:");
  for (const entry of all) {
    const first = (entry.command.split("\n")[0] ?? "").slice(0, 80);
    console.log(
      `  ${entry.ts?.slice(0, 16) ?? "?"} ${entry.verdict.padEnd(9)} ${entry.outcome.padEnd(16)} ${entry.hadDialog ? "dialog" : "      "} ${entry.toolName.padEnd(8)} ${entry.file} ${first}`,
    );
  }
}
