import { describe, expect, test } from "bun:test";
import { createClient, HarvestApiError, type HarvestClient, type TimeEntry } from "./api";
import { aliasRemove, aliasSet, cmdLog, cmdStart, cmdStatus, cmdStop, type Deps } from "./commands";
import { authSetupMessage, type HarvestCache, type HarvestConfig, isFresh, resolveAuth } from "./config";
import {
  buildCreateEntryBody,
  clockTime,
  entryElapsed,
  formatHours,
  localDateString,
  parseHours,
  spentDateClockToDate,
  weekDates,
} from "./format";
import { parseCli } from "./harvest";
import { type Candidate, formatCandidates, matchOne } from "./resolve";

// ---------- format ----------

describe("parseHours", () => {
  test("decimal, clock, and unit forms", () => {
    expect(parseHours("1.5")).toBe(1.5);
    expect(parseHours("1:30")).toBe(1.5);
    expect(parseHours("0:45")).toBe(0.75);
    expect(parseHours("45m")).toBe(0.75);
    expect(parseHours("1h")).toBe(1);
    expect(parseHours("1h30m")).toBe(1.5);
    expect(parseHours("2h15")).toBe(2.25);
    expect(parseHours(".5")).toBe(0.5);
    expect(parseHours(" 2 ")).toBe(2);
  });

  test("rejects garbage", () => {
    expect(parseHours("abc")).toBeNull();
    expect(parseHours("1:")).toBeNull();
    expect(parseHours("")).toBeNull();
  });
});

describe("formatHours", () => {
  test("decimal to H:MM", () => {
    expect(formatHours(1.5)).toBe("1:30");
    expect(formatHours(0.75)).toBe("0:45");
    expect(formatHours(0)).toBe("0:00");
    expect(formatHours(8)).toBe("8:00");
    expect(formatHours(4 / 3)).toBe("1:20");
  });
});

describe("clockTime / spentDateClockToDate", () => {
  test("formats 24h local to Harvest am/pm", () => {
    expect(clockTime(new Date(2026, 8, 15, 9, 41))).toBe("9:41am");
    expect(clockTime(new Date(2026, 8, 15, 14, 5))).toBe("2:05pm");
    expect(clockTime(new Date(2026, 8, 15, 0, 3))).toBe("12:03am");
    expect(clockTime(new Date(2026, 8, 15, 12, 0))).toBe("12:00pm");
  });

  test("round-trips clock to Date", () => {
    const d = spentDateClockToDate("2026-09-15", "2:05pm");
    expect(d.getFullYear()).toBe(2026);
    expect(d.getHours()).toBe(14);
    expect(d.getMinutes()).toBe(5);
  });
});

describe("weekDates", () => {
  test("ISO week Monday..Sunday", () => {
    const days = weekDates(new Date(2026, 8, 15)); // Tuesday
    expect(days).toHaveLength(7);
    expect(days[0]).toBe("2026-09-14"); // Monday
    expect(days[6]).toBe("2026-09-20"); // Sunday
  });

  test("Sunday maps back to its own week's Monday", () => {
    const days = weekDates(new Date(2026, 8, 20)); // Sunday
    expect(days[0]).toBe("2026-09-14");
  });
});

describe("localDateString", () => {
  test("local, not UTC", () => {
    expect(localDateString(new Date(2026, 8, 15))).toBe("2026-09-15");
  });
});

describe("entryElapsed", () => {
  const now = Date.parse("2026-09-15T12:00:00Z");

  test("duration mode: from timer_started_at", () => {
    const entry = { spent_date: "2026-09-15", timer_started_at: "2026-09-15T10:00:00Z", started_time: null };
    expect(entryElapsed(entry, now)).toBe("2:00");
  });

  test("timestamp mode: from spent_date + started_time (local)", () => {
    const entry = { spent_date: "2026-09-15", timer_started_at: null, started_time: "8:00am" };
    const elapsed = entryElapsed(entry, now);
    expect(elapsed).toMatch(/^\d+:\d{2}$/);
  });

  test("stopped entry: null", () => {
    const entry = { spent_date: "2026-09-15", timer_started_at: null, started_time: null };
    expect(entryElapsed(entry, now)).toBeNull();
  });
});

describe("buildCreateEntryBody", () => {
  const now = new Date(2026, 8, 15, 14, 0);
  const base = { projectId: 1, taskId: 2, spentDate: "2026-09-15", now };

  test("duration mode start: no hours field → running", () => {
    const body = buildCreateEntryBody({ ...base, timestampTimers: false });
    expect(body).toEqual({ project_id: 1, task_id: 2, spent_date: "2026-09-15" });
  });

  test("duration mode log: hours field", () => {
    const body = buildCreateEntryBody({ ...base, timestampTimers: false, hours: 1.5, notes: "hi" });
    expect(body.hours).toBe(1.5);
    expect(body.notes).toBe("hi");
  });

  test("timestamp mode start: started_time set", () => {
    const body = buildCreateEntryBody({ ...base, timestampTimers: true });
    expect(body.started_time).toBe("2:00pm");
    expect(body.hours).toBeUndefined();
  });

  test("timestamp mode log: derives start/end from duration", () => {
    const body = buildCreateEntryBody({ ...base, timestampTimers: true, hours: 1.5 });
    expect(body.started_time).toBe("12:30pm");
    expect(body.ended_time).toBe("2:00pm");
  });
});

// ---------- resolve ----------

const items: Candidate[] = [
  { id: 1, name: "Acme Website", code: "AW", client: "Acme Corp" },
  { id: 2, name: "Acme Redesign", code: "AR", client: "Acme Corp" },
  { id: 3, name: "Internal Admin", code: null, client: null },
];
const acme = items[0] as Candidate;
const redesign = items[1] as Candidate;

describe("matchOne", () => {
  test("exact name wins", () => {
    expect(matchOne("acme website", items)).toEqual({ kind: "match", item: acme });
  });

  test("code match", () => {
    expect(matchOne("AW", items)).toEqual({ kind: "match", item: acme });
  });

  test("client name match", () => {
    const r = matchOne("internal admin", items);
    expect(r.kind).toBe("match");
  });

  test("substring unique", () => {
    expect(matchOne("redesign", items)).toEqual({ kind: "match", item: redesign });
  });

  test("ambiguous at a tier lists candidates", () => {
    const r = matchOne("acme", items);
    if (r.kind !== "ambiguous") throw new Error(`expected ambiguous, got ${r.kind}`);
    expect(r.candidates).toHaveLength(2);
    expect(formatCandidates(r.candidates)).toContain("Acme Website (AW)");
  });

  test("separator-insensitive", () => {
    expect(matchOne("acme_website", items)).toEqual({ kind: "match", item: acme });
  });

  test("miss", () => {
    expect(matchOne("zzz", items).kind).toBe("none");
    expect(matchOne("", items).kind).toBe("none");
  });
});

// ---------- config ----------

describe("isFresh", () => {
  test("fresh within ttl, stale after", () => {
    const cache: HarvestCache = { fetchedAt: { projects: 1000 } };
    expect(isFresh(cache, "projects", 5000, 4000)).toBe(true);
    expect(isFresh(cache, "projects", 5000, 6001)).toBe(false);
    expect(isFresh(cache, "missing", 5000, 1000)).toBe(false);
  });
});

describe("resolveAuth", () => {
  test("env wins", () => {
    const auth = resolveAuth({ HARVEST_TOKEN: "t", HARVEST_ACCOUNT_ID: "a" });
    expect(auth).toEqual({ token: "t", accountId: "a" });
  });

  test("setup message lists all sources", () => {
    // Pure builder — resolveAuth itself probes platform binaries, which
    // tests must not do (would trigger real keychain/1Password access).
    const msg = authSetupMessage();
    expect(msg).toContain("no Harvest credentials");
    expect(msg).toContain("1Password");
    expect(msg).toContain("/run/secrets/harvest-token");
    expect(msg).toContain("HARVEST_TOKEN");
    expect(msg).toContain("id.getharvest.com/developers");
  });

  test("setup message includes op diagnostics when provided", () => {
    const msg = authSetupMessage("account is not signed in");
    expect(msg).toContain("(1Password lookup failed: account is not signed in)");
  });
});

// ---------- api client ----------

function fetchStub(responses: Array<{ status: number; body?: unknown; headers?: Record<string, string> }>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const r = responses.shift();
    if (!r) throw new Error("no stubbed response left");
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), {
      status: r.status,
      headers: r.headers,
    });
  }) as typeof fetch;
  return { impl, calls };
}

describe("createClient", () => {
  const auth = { token: "tok", accountId: "123" };

  test("sends auth headers and parses json", async () => {
    const { impl, calls } = fetchStub([{ status: 200, body: { id: 5, name: "A", email: "a@b.c" } }]);
    const client = createClient(auth, "ua", impl);
    const me = await client.me();
    expect(me.id).toBe(5);
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer tok");
    expect(headers["Harvest-Account-Id"]).toBe("123");
    expect(headers["User-Agent"]).toBe("ua");
  });

  test("GET params become query string", async () => {
    const { impl, calls } = fetchStub([{ status: 200, body: { time_entries: [], total_pages: 1 } }]);
    const client = createClient(auth, "ua", impl);
    await client.timeEntries({ user_id: 7, is_running: true });
    const url = new URL(calls[0]?.url ?? "");
    expect(url.pathname).toBe("/v2/time_entries");
    expect(url.searchParams.get("user_id")).toBe("7");
    expect(url.searchParams.get("is_running")).toBe("true");
  });

  test("paginates until total_pages", async () => {
    const page = (ids: number[]) => ({
      status: 200,
      body: { time_entries: ids.map((id) => ({ id })), total_pages: 2 },
    });
    const { impl } = fetchStub([page([1]), page([2])]);
    const client = createClient(auth, "ua", impl);
    const entries = await client.timeEntries({});
    expect(entries.map((e) => e.id)).toEqual([1, 2]);
  });

  test("error body becomes message; 429 includes retry hint", async () => {
    const { impl } = fetchStub([{ status: 422, body: { message: "bad request" } }]);
    const client = createClient(auth, "ua", impl);
    expect(client.me()).rejects.toThrow("bad request");

    const { impl: impl2 } = fetchStub([{ status: 429, body: {}, headers: { "Retry-After": "30" } }]);
    const client2 = createClient(auth, "ua", impl2);
    const err = await client2.me().catch((e) => e);
    expect(err).toBeInstanceOf(HarvestApiError);
    expect((err as HarvestApiError).retryAfter).toBe(30);
    expect((err as HarvestApiError).message).toContain("30s");
  });
});

// ---------- commands ----------

function assignment(
  project: { id: number; name: string; code?: string | null },
  client: string | null,
  tasks: { id: number; name: string }[],
) {
  return {
    id: project.id,
    is_active: true,
    project: { id: project.id, name: project.name, code: project.code ?? null },
    client: client === null ? null : { id: 30, name: client },
    task_assignments: tasks.map((t, i) => ({ id: i + 1, is_active: true, task: t })),
  };
}

function timeEntry(overrides: Partial<TimeEntry>): TimeEntry {
  return {
    id: 1,
    spent_date: "2026-09-15",
    hours: 0,
    hours_without_timer: 0,
    notes: null,
    is_running: false,
    timer_started_at: null,
    started_time: null,
    ended_time: null,
    is_billed: false,
    is_locked: false,
    approval_status: "unsubmitted",
    project: { id: 10, name: "Website" },
    task: { id: 20, name: "Development" },
    client: { id: 30, name: "Acme" },
    ...overrides,
  };
}

/** Scripted stub: methods return queued values in order. */
function apiStub(script: Partial<Record<keyof HarvestClient, unknown[]>>): HarvestClient {
  const used = new Map<string, number>();
  return new Proxy({} as HarvestClient, {
    get(_t, prop: string) {
      return (...args: unknown[]) => {
        const queue = (script as Record<string, unknown[]>)[prop] ?? [];
        const i = used.get(prop) ?? 0;
        used.set(prop, i + 1);
        const value = queue[i];
        if (value === undefined) throw new Error(`apiStub: no queued value for ${prop} call ${i + 1}`);
        if (value instanceof Error) throw value;
        return typeof value === "function" ? (value as (...a: unknown[]) => unknown)(...args) : Promise.resolve(value);
      };
    },
  }) as HarvestClient;
}

function makeDeps(
  api: HarvestClient,
  cfg: HarvestConfig = { aliases: {} },
): { deps: Deps; caches: HarvestCache[]; configs: HarvestConfig[] } {
  const cache: HarvestCache = {};
  const caches: HarvestCache[] = [];
  const configs: HarvestConfig[] = [];
  return {
    deps: {
      getApi: () => api,
      cfg,
      cache,
      saveCache: (next) => {
        caches.push(JSON.parse(JSON.stringify(next)));
        Object.assign(cache, next);
      },
      saveConfig: (next) => configs.push(JSON.parse(JSON.stringify(next))),
      now: new Date(2026, 8, 15, 10, 0), // Tuesday 10:00 local
    },
    caches,
    configs,
  };
}

describe("cmdStatus", () => {
  test("running timer + today's entries", async () => {
    const running = timeEntry({
      id: 100,
      is_running: true,
      hours: 1.25,
      timer_started_at: "2026-09-15T08:00:00Z",
      notes: "fixing bug",
    });
    const past = timeEntry({ id: 90, hours: 2 });
    const api = apiStub({
      me: [Promise.resolve({ id: 7, first_name: "A", last_name: "B", email: "a@b.c" })],
      timeEntries: [[running], [past]],
    });
    const { deps } = makeDeps(api);
    const r = await cmdStatus(deps);
    expect(r.text).toContain("▶ Acme / Website / Development 2:00 since");
    expect(r.text).toContain("fixing bug");
    expect(r.text).toContain("today: 2:00 (1 entry)");
    expect(r.text).toContain("2:00  Acme / Website / Development");
    const json = r.json as { running: { id: number }; today: unknown[]; total: number };
    expect(json.running.id).toBe(100);
    expect(json.total).toBeCloseTo(2);
  });

  test("stale timer from a previous day is flagged", async () => {
    const running = timeEntry({
      id: 100,
      is_running: true,
      hours: 5,
      spent_date: "2026-09-14",
      timer_started_at: "2026-09-14T08:00:00Z",
    });
    const api = apiStub({
      me: [{ id: 7, first_name: "A", last_name: "B", email: "a@b.c" }],
      timeEntries: [[running], []],
    });
    const { deps } = makeDeps(api);
    const r = await cmdStatus(deps);
    expect(r.text).toContain("STALE");
  });
});

describe("cmdStart", () => {
  test("resolves via alias, stops previous timer, creates entry", async () => {
    const prev = timeEntry({ id: 100, is_running: true, hours: 1 });
    const created = timeEntry({ id: 200, is_running: true, notes: "new work" });
    const bodies: unknown[] = [];
    const api = apiStub({
      me: [{ id: 7, first_name: "A", last_name: "B", email: "a@b.c" }],
      timeEntries: [[prev], []],
      company: [{ wants_timestamp_timers: false }],
      projectAssignments: [
        [assignment({ id: 10, name: "Website", code: "WEB" }, "Acme", [{ id: 20, name: "Development" }])],
      ],
      createTimeEntry: [
        (body: unknown) => {
          bodies.push(body);
          return Promise.resolve(created);
        },
      ],
      stopEntry: [Promise.resolve(prev)],
    });
    const cfg: HarvestConfig = {
      aliases: { web: { projectId: 10, projectName: "Website", taskId: null, taskName: null } },
    };
    const { deps, caches } = makeDeps(api, cfg);
    const r = await cmdStart(deps, "web", undefined, "new work");
    expect(r.text).toContain("■ stopped Acme / Website / Development at 1:00");
    expect(r.text).toContain("▶ Acme / Website / Development — started 10:00am — new work");
    expect(bodies[0]).toEqual({ project_id: 10, task_id: 20, spent_date: "2026-09-15", notes: "new work" });
    expect(caches.at(-1)?.tasksByProject?.["10"]).toEqual([{ id: 20, name: "Development" }]);
  });

  test("no alias and ambiguous name fails with candidates", async () => {
    const api = apiStub({
      me: [{ id: 7, first_name: "A", last_name: "B", email: "a@b.c" }],
      projectAssignments: [
        [assignment({ id: 1, name: "Alpha One" }, null, []), assignment({ id: 2, name: "Alpha Two" }, null, [])],
      ],
    });
    const { deps } = makeDeps(api);
    expect(cmdStart(deps, "alpha")).rejects.toThrow(/ambiguous project "alpha"/);
  });

  test("multiple tasks without a task arg fails listing them", async () => {
    const api = apiStub({
      me: [{ id: 7, first_name: "A", last_name: "B", email: "a@b.c" }],
      projectAssignments: [
        [
          assignment({ id: 1, name: "Website" }, null, [
            { id: 20, name: "Development" },
            { id: 21, name: "Design" },
          ]),
        ],
      ],
    });
    const { deps } = makeDeps(api);
    expect(cmdStart(deps, "website")).rejects.toThrow(/no task given for Website/);
  });
});

describe("cmdStop", () => {
  test("stops and reports captured hours", async () => {
    const running = timeEntry({ id: 100, is_running: true, hours: 0.5 });
    const api = apiStub({
      me: [{ id: 7, first_name: "A", last_name: "B", email: "a@b.c" }],
      timeEntries: [[running]],
      stopEntry: [Promise.resolve(timeEntry({ id: 100, hours: 0.5 }))],
    });
    const { deps } = makeDeps(api);
    const r = await cmdStop(deps);
    expect(r.text).toBe("■ Acme / Website / Development — stopped at 0:30");
  });

  test("nothing running errors", async () => {
    const api = apiStub({
      me: [{ id: 7, first_name: "A", last_name: "B", email: "a@b.c" }],
      timeEntries: [[]],
    });
    const { deps } = makeDeps(api);
    expect(cmdStop(deps)).rejects.toThrow("no running timer");
  });
});

describe("cmdLog", () => {
  test("bad hours fails", async () => {
    const api = apiStub({});
    const { deps } = makeDeps(api);
    expect(cmdLog(deps, "abc", "website")).rejects.toThrow(/bad hours/);
  });

  test("fuzzy project + explicit task, date override", async () => {
    const created = timeEntry({ id: 300, hours: 1.5, spent_date: "2026-09-14", notes: "catch-up" });
    const api = apiStub({
      me: [{ id: 7, first_name: "A", last_name: "B", email: "a@b.c" }],
      projectAssignments: [[assignment({ id: 10, name: "Website" }, "Acme", [{ id: 20, name: "Development" }])]],
      company: [{ wants_timestamp_timers: false }],
      createTimeEntry: [Promise.resolve(created)],
    });
    const { deps } = makeDeps(api);
    const r = await cmdLog(deps, "1:30", "site", "dev", "2026-09-14", "catch-up");
    expect(r.text).toBe("logged 1:30 → Acme / Website / Development (2026-09-14) — catch-up");
  });
});

describe("alias commands", () => {
  test("set stores ids + names; remove deletes", async () => {
    const api = apiStub({
      me: [{ id: 7, first_name: "A", last_name: "B", email: "a@b.c" }],
      projectAssignments: [[assignment({ id: 10, name: "Website" }, null, [{ id: 20, name: "Development" }])]],
    });
    const { deps, configs } = makeDeps(api);
    const set = await aliasSet(deps, "web", "site", "dev");
    expect(set.text).toBe("alias web → Website / Development");
    expect(configs.at(-1)?.aliases.web?.taskId).toBe(20);
    const removed = aliasRemove(deps, "WEB");
    expect(removed.text).toBe("removed alias web");
    expect(() => aliasRemove(deps, "web")).toThrow('no alias "web"');
  });
});

// ---------- cli parsing ----------

describe("parseCli", () => {
  test("positionals and flags", () => {
    const c = parseCli(["log", "1:30", "acme", "dev", "--date", "2026-09-14", "-n", "note text", "--json"]);
    expect(c.positionals).toEqual(["log", "1:30", "acme", "dev"]);
    expect(c.date).toBe("2026-09-14");
    expect(c.note).toBe("note text");
    expect(c.json).toBe(true);
  });

  test("no command means empty positionals", () => {
    expect(parseCli([]).positionals).toEqual([]);
  });

  test("unknown flag throws", () => {
    expect(() => parseCli(["--bogus"])).toThrow();
  });

  test("bad date format throws", () => {
    expect(() => parseCli(["log", "1", "a", "--date", "tomorrow"])).toThrow(/yyyy-mm-dd/);
  });
});
