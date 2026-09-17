/**
 * Pi tool audit: patch / edit / write usage across local session logs.
 *
 * Usage:
 *   bun run scripts/patch-usage-audit.ts
 *   bun run scripts/patch-usage-audit.ts --since 2026-07-01
 *   bun run scripts/patch-usage-audit.ts --json
 *   bun run scripts/patch-usage-audit.ts --root ~/.pi/agent/sessions
 *
 * Reads pi's JSONL session store (default ~/.pi/agent/sessions), pairs each
 * assistant toolCall with its toolResult by toolCallId, and reports:
 *   - patch vs edit volume, success rate, and edit share over time
 *   - patch failure classes and, for no-match, how close the miss was
 *   - which model / extension / project still reaches for `edit`
 *   - recovery: after a failed edit, what the next call for that file was
 *   - batch sizes on failure (does atomicity discard good edits?)
 *
 * "Matcher attempt" excludes permission-gate blocks and schema-invalid args,
 * which are not matcher outcomes. Dates are the entry timestamps (UTC).
 */

import { createReadStream, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";

interface ToolCallPart {
  type?: string;
  id?: string;
  name?: string;
  text?: string;
  arguments?: Record<string, unknown>;
}

interface SessionMessage {
  role?: string;
  provider?: string;
  model?: string;
  content?: ToolCallPart[];
  toolName?: string;
  isError?: boolean;
  toolCallId?: string;
}

interface SessionEntry {
  type?: string;
  timestamp?: string;
  message?: SessionMessage;
}

type Kind = "patch" | "edit" | "write";

interface Event {
  kind: Kind;
  date: string;
  ok: boolean;
  blocked: boolean;
  schema: boolean;
  reason: string;
  path: string | null;
  model: string;
  session: string;
  index: number;
  edits: number;
  text: string;
}

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    root: { type: "string" },
    since: { type: "string" },
    json: { type: "boolean" },
    top: { type: "string" },
  },
});

const ROOT = (values.root ?? join(homedir(), ".pi", "agent", "sessions")).replace(/\/$/, "");
const TOP = values.top ? Number(values.top) : 12;

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const stat = statSync(path);
    if (stat.isDirectory()) yield* walk(path);
    else if (name.endsWith(".jsonl")) yield path;
  }
}

function textOf(message: SessionMessage): string {
  const parts = message.content ?? [];
  return parts.map((part) => part.text ?? "").join("\n");
}

function extensionOf(path: string | null): string {
  if (!path) return "(unknown)";
  const base = path.split("/").pop() ?? path;
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "(none)";
}

function patchReason(text: string): string {
  if (/Validation failed for tool/.test(text)) return "schema-invalid";
  if (/not found\./.test(text)) return "no-match";
  if (/occurrences\. Use a unique|overlaps another edit/.test(text)) return "ambiguous";
  if (/duplicates line|reproduces the anchor|insert only NEW content/.test(text)) return "duplication-guard";
  if (/no-op/.test(text)) return "no-op";
  if (/oldText is empty/.test(text)) return "empty-oldText";
  if (/Could not read file/.test(text)) return "missing-file";
  if (/Operation aborted/.test(text)) return "aborted";
  return "other";
}

function editReason(text: string): string {
  if (/Validation failed for tool/.test(text)) return "schema-invalid";
  if (/not found|Could not find the exact text|does not exist|no such file/i.test(text)) return "not-found";
  if (/duplicate|appears \d+ times|multiple/i.test(text)) return "ambiguous";
  if (/Operation aborted/.test(text)) return "aborted";
  return "other";
}

function editPath(kind: Kind, args: Record<string, unknown>): string | null {
  if (kind === "edit") {
    return typeof args.path === "string" ? args.path : typeof args.file_path === "string" ? args.file_path : null;
  }
  if (kind === "write") return typeof args.path === "string" ? args.path : null;
  const edits = Array.isArray(args.edits) ? args.edits : [];
  if (typeof args.path === "string") return args.path;
  if (edits.length === 1) {
    const only = edits[0] as { path?: unknown } | undefined;
    return typeof only?.path === "string" ? only.path : null;
  }
  return null;
}

async function collect(): Promise<{ events: Event[]; sessions: number }> {
  const events: Event[] = [];
  let sessions = 0;
  for (const file of walk(ROOT)) {
    sessions++;
    const session = file.slice(ROOT.length + 1);
    const pending = new Map<string, { kind: Kind; args: Record<string, unknown>; model: string }>();
    const lines = createInterface({ input: createReadStream(file), crlfDelay: Number.POSITIVE_INFINITY });
    let index = 0;
    for await (const line of lines) {
      if (line?.[0] !== "{") continue;
      let entry: SessionEntry;
      try {
        entry = JSON.parse(line) as SessionEntry;
      } catch {
        continue;
      }
      if (entry.type !== "message" || !entry.message) continue;
      const message = entry.message;
      if (message.role === "assistant") {
        for (const part of message.content ?? []) {
          if (part.type === "toolCall" && part.id && part.name) {
            pending.set(part.id, {
              kind: part.name as Kind,
              args: (part.arguments ?? {}) as Record<string, unknown>,
              model: `${message.provider ?? "?"}/${message.model ?? "?"}`,
            });
          }
        }
        continue;
      }
      if (message.role !== "toolResult") continue;
      const call = pending.get(message.toolCallId ?? "");
      pending.delete(message.toolCallId ?? "");
      const kind = (message.toolName ?? call?.kind ?? "") as Kind;
      if (kind !== "patch" && kind !== "edit" && kind !== "write") continue;
      const text = textOf(message);
      const ok = message.isError !== true;
      const blocked =
        !ok && (text.startsWith("BLOCKED by user") || /permission gate|blocked in non-interactive/.test(text));
      const schema = !ok && /Validation failed for tool/.test(text);
      const args = call?.args ?? {};
      events.push({
        kind,
        date: String(entry.timestamp ?? "").slice(0, 10),
        ok,
        blocked,
        schema,
        reason: ok ? "applied" : kind === "edit" ? editReason(text) : patchReason(text),
        path: editPath(kind, args),
        model: call?.model ?? "?",
        session,
        index: index++,
        edits: kind === "patch" && Array.isArray(args.edits) ? args.edits.length : 1,
        text,
      });
    }
    lines.close();
  }
  return { events, sessions };
}

// ── Aggregation ──

const { events, sessions } = await collect();
const patches = events.filter((e) => e.kind === "patch");
const edits = events.filter((e) => e.kind === "edit");
const writes = events.filter((e) => e.kind === "write");
const firstPatch = patches.map((e) => e.date).sort()[0] ?? "";
const cut = values.since ?? firstPatch;

const isReal = (e: Event): boolean => !e.blocked && !e.schema;
const pct = (n: number, d: number): string => (d === 0 ? "n/a" : `${((100 * n) / d).toFixed(1)}%`);
const since = (list: Event[]): Event[] => list.filter((e) => e.date >= cut);

interface Report {
  sessions: number;
  cutoff: string;
  patch: { total: number; attempts: number; applied: number; blocked: number; schema: number };
  edit: { total: number; attempts: number; applied: number; blocked: number; schema: number };
  write: number;
  editShare: string;
  patchFailures: [string, number][];
  noMatch: { total: number; noSimilar: number; similarity: [string, number][]; shape: [string, number][] };
  editShareByMonth: [string, number, number][];
  editShareByModel: [string, number, number][];
  editShareByExtension: [string, number, number][];
  recoveryAfterPatchFailure: { patch: number; edit: number; write: number };
  recoveryAfterEditFailure: { patch: number; edit: number; write: number };
  failedBatchSizes: [number, number][];
  schemaMissingField: [string, number][];
}

function buildReport(): Report {
  const post = (list: Event[]): Event[] => since(list);
  const postPatch = post(patches);
  const postEdit = post(edits);
  const patchAttempts = postPatch.filter(isReal);
  const editAttempts = postEdit.filter(isReal);

  const failReasons = new Map<string, number>();
  for (const e of patchAttempts.filter((x) => !x.ok)) failReasons.set(e.reason, (failReasons.get(e.reason) ?? 0) + 1);

  // no-match detail
  const noMatches = patchAttempts.filter((e) => !e.ok && e.reason === "no-match");
  const similarity = new Map<string, number>();
  const shape = new Map<string, number>();
  let noSimilar = 0;
  for (const e of noMatches) {
    if (/No similar text found/.test(e.text)) {
      noSimilar++;
      continue;
    }
    const sim = /Lines \d+-\d+ \((\d+)% similar/.exec(e.text);
    const value = sim ? Number(sim[1]) : Number.NaN;
    similarity.set(
      Number.isNaN(value)
        ? "?"
        : value >= 95
          ? "95-100"
          : value >= 90
            ? "90-94"
            : value >= 80
              ? "80-89"
              : value >= 50
                ? "50-79"
                : "<50",
      (similarity.get(
        Number.isNaN(value)
          ? "?"
          : value >= 95
            ? "95-100"
            : value >= 90
              ? "90-94"
              : value >= 80
                ? "80-89"
                : value >= 50
                  ? "50-79"
                  : "<50",
      ) ?? 0) + 1,
    );
    const oneLine = /1 line\(s\) differ in actual text/.test(e.text);
    const multiLine = /([2-9]|\d\d+) line\(s\) differ in actual text/.test(e.text);
    const whitespace = /differ only in whitespace/.test(e.text);
    shape.set(
      oneLine ? "single-line diff" : multiLine ? "multi-line diff" : whitespace ? "whitespace-only" : "other",
      (shape.get(
        oneLine ? "single-line diff" : multiLine ? "multi-line diff" : whitespace ? "whitespace-only" : "other",
      ) ?? 0) + 1,
    );
  }

  // edit share by month / model / extension
  const byMonth = new Map<string, { edit: number; patch: number }>();
  const bump = (map: Map<string, { edit: number; patch: number }>, key: string, kind: Kind): void => {
    const row = map.get(key) ?? { edit: 0, patch: 0 };
    if (kind === "edit") row.edit++;
    else row.patch++;
    map.set(key, row);
  };
  for (const e of postEdit) bump(byMonth, e.date.slice(0, 7), "edit");
  for (const e of patchAttempts) bump(byMonth, e.date.slice(0, 7), "patch");
  const byModel = new Map<string, { edit: number; patch: number }>();
  for (const e of postEdit) bump(byModel, e.model, "edit");
  for (const e of patchAttempts) bump(byModel, e.model, "patch");
  const byExt = new Map<string, { edit: number; patch: number }>();
  for (const e of postEdit) bump(byExt, extensionOf(e.path), "edit");
  for (const e of patchAttempts) bump(byExt, extensionOf(e.path), "patch");

  // recovery: next event for the same path in the same session
  const nextFor = (from: Event, kinds: Kind[]): Event | undefined => {
    for (const e of events) {
      if (e.session !== from.session || e.index <= from.index) continue;
      if (e.path !== from.path) continue;
      if (!kinds.includes(e.kind)) continue;
      return e;
    }
    return undefined;
  };
  const afterPatch = { patch: 0, edit: 0, write: 0 };
  for (const e of patchAttempts.filter((x) => !x.ok && x.path)) {
    const next = nextFor(e, ["patch", "edit", "write"]);
    if (!next || next.kind === "patch") afterPatch.patch++;
    else if (next.kind === "edit") afterPatch.edit++;
    else afterPatch.write++;
  }
  const afterEdit = { patch: 0, edit: 0, write: 0 };
  for (const e of editAttempts.filter((x) => !x.ok && x.path)) {
    const next = nextFor(e, ["patch", "edit", "write"]);
    if (!next || next.kind === "patch") afterEdit.patch++;
    else if (next.kind === "edit") afterEdit.edit++;
    else afterEdit.write++;
  }

  const batchSizes = new Map<number, number>();
  for (const e of patchAttempts.filter((x) => !x.ok)) batchSizes.set(e.edits, (batchSizes.get(e.edits) ?? 0) + 1);

  const schemaFields = new Map<string, number>();
  for (const e of patches.filter((x) => x.schema)) {
    const field = /must have required properties (\w+)/.exec(e.text)?.[1] ?? "?";
    schemaFields.set(field, (schemaFields.get(field) ?? 0) + 1);
  }

  const shareRows = (map: Map<string, { edit: number; patch: number }>): [string, number, number][] =>
    [...map.entries()]
      .sort((a, b) => b[1].edit + b[1].patch - (a[1].edit + a[1].patch))
      .slice(0, TOP)
      .map(([key, row]) => [key, row.edit, row.patch]);

  return {
    sessions,
    cutoff: cut,
    patch: {
      total: patches.length,
      attempts: patchAttempts.length,
      applied: patchAttempts.filter((e) => e.ok).length,
      blocked: postPatch.filter((e) => e.blocked).length,
      schema: postPatch.filter((e) => e.schema).length,
    },
    edit: {
      total: edits.length,
      attempts: editAttempts.length,
      applied: editAttempts.filter((e) => e.ok).length,
      blocked: postEdit.filter((e) => e.blocked).length,
      schema: postEdit.filter((e) => e.schema).length,
    },
    write: writes.length,
    editShare: pct(postEdit.length, postEdit.length + postPatch.length),
    patchFailures: [...failReasons.entries()].sort((a, b) => b[1] - a[1]),
    noMatch: {
      total: noMatches.length,
      noSimilar,
      similarity: [...similarity.entries()].sort((a, b) => a[0].localeCompare(b[0])),
      shape: [...shape.entries()].sort((a, b) => b[1] - a[1]),
    },
    editShareByMonth: [...byMonth.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([month, row]) => [month, row.edit, row.patch]),
    editShareByModel: shareRows(byModel),
    editShareByExtension: shareRows(byExt),
    recoveryAfterPatchFailure: afterPatch,
    recoveryAfterEditFailure: afterEdit,
    failedBatchSizes: [...batchSizes.entries()].sort((a, b) => a[0] - b[0]),
    schemaMissingField: [...schemaFields.entries()].sort((a, b) => b[1] - a[1]),
  };
}

const report = buildReport();
const json = values.json === true;
const out: string[] = [];
const push = (line = ""): void => {
  out.push(line);
};

if (json) {
  console.log(JSON.stringify(report, null, 2));
} else {
  push(`pi tool audit — ${ROOT}`);
  push(`sessions ${report.sessions}   patch ${report.patch.total}   edit ${report.edit.total}   write ${report.write}`);
  push(`cutoff ${report.cutoff} (first patch use; override with --since)`);
  push("");
  push("post-cutoff totals");
  push(
    `  patch  attempts ${report.patch.attempts}  applied ${report.patch.applied} (${pct(report.patch.applied, report.patch.attempts)})  blocked ${report.patch.blocked}  schema-invalid ${report.patch.schema}`,
  );
  push(
    `  edit   attempts ${report.edit.attempts}  applied ${report.edit.applied} (${pct(report.edit.applied, report.edit.attempts)})  blocked ${report.edit.blocked}  schema-invalid ${report.edit.schema}`,
  );
  push(`  edit share of attempts: ${report.editShare}`);
  push("");
  push("patch failure classes (post, excl. blocks/schema)");
  for (const [reason, count] of report.patchFailures) push(`  ${String(count).padStart(4)}  ${reason}`);
  push("");
  push(`no-match detail (${report.noMatch.total}; "no similar text" ${report.noMatch.noSimilar})`);
  push(`  similarity: ${report.noMatch.similarity.map(([k, v]) => `${k}=${v}`).join("  ")}`);
  push(`  shape:      ${report.noMatch.shape.map(([k, v]) => `${k}=${v}`).join("  ")}`);
  push("");
  push("edit share by month");
  for (const [month, editCount, patchCount] of report.editShareByMonth)
    push(
      `  ${month}  patch ${String(patchCount).padStart(5)}  edit ${String(editCount).padStart(4)}  editShare ${pct(editCount, editCount + patchCount)}`,
    );
  push("");
  push(`edit share by model (top ${TOP})`);
  for (const [model, editCount, patchCount] of report.editShareByModel)
    push(
      `  ${model.padEnd(46)} edit ${String(editCount).padStart(4)}  patch ${String(patchCount).padStart(5)}  editShare ${pct(editCount, editCount + patchCount)}`,
    );
  push("");
  push(`edit share by extension (top ${TOP})`);
  for (const [ext, editCount, patchCount] of report.editShareByExtension)
    push(
      `  ${ext.padEnd(14)} edit ${String(editCount).padStart(4)}  patch ${String(patchCount).padStart(5)}  editShare ${pct(editCount, editCount + patchCount)}`,
    );
  push("");
  push("recovery — next same-path call after a failure");
  push(
    `  after failed patch: patch ${report.recoveryAfterPatchFailure.patch}  edit ${report.recoveryAfterPatchFailure.edit}  write ${report.recoveryAfterPatchFailure.write}`,
  );
  push(
    `  after failed edit:  patch ${report.recoveryAfterEditFailure.patch}  edit ${report.recoveryAfterEditFailure.edit}  write ${report.recoveryAfterEditFailure.write}`,
  );
  push("");
  push("failed-call batch sizes (patch edits per call)");
  for (const [size, count] of report.failedBatchSizes) push(`  ${String(size).padStart(3)} edits: ${count}`);
  if (report.schemaMissingField.length > 0) {
    push("");
    push("schema-invalid: missing field");
    for (const [field, count] of report.schemaMissingField) push(`  ${String(count).padStart(4)}  ${field}`);
  }
  console.log(out.join("\n"));
}
