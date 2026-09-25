import { describe, expect, test } from "bun:test";
import { createClient, HarvestApiError, type HarvestClient, type TimeEntry } from "./api";
import {
  aliasList,
  aliasRemove,
  aliasSet,
  auditIssues,
  auditRange,
  cmdAudit,
  cmdDelete,
  cmdEdit,
  cmdLog,
  cmdMonth,
  cmdStart,
  cmdStatus,
  cmdStop,
  cmdTasks,
  cmdToday,
  cmdWeek,
  type Deps,
  duplicateEntryIds,
  isWholeHour,
  monthRange,
  noteHasLink,
} from "./commands";
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
import { concealMoney, isAliasListForm, parseCli } from "./harvest";
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
  { id: 4, name: "998", code: null, client: null },
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
    expect(formatCandidates(r.candidates)).toContain("  1  Acme Website (AW)");
  });

  test("numeric query matches by id only, no name fallback", () => {
    expect(matchOne("2", items)).toEqual({ kind: "match", item: redesign });
    // id 99 is absent; the name tier would start-with-match "998", so this
    // none proves numeric queries never fall back to name matching.
    expect(matchOne("99", items).kind).toBe("none");
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
    rounded_hours: 0,
    notes: null,
    is_running: false,
    timer_started_at: null,
    started_time: null,
    ended_time: null,
    is_billed: false,
    is_locked: false,
    approval_status: "unsubmitted",
    billable: false,
    billable_rate: null,
    cost_rate: null,
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
      company: [{ wants_timestamp_timers: false, currency: "czk" }],
    });
    const { deps } = makeDeps(api);
    const r = await cmdStatus(deps);
    expect(r.text).toContain("▶ Acme / Website / Development 2:00 since");
    expect(r.text).toContain("fixing bug");
    expect(r.text).toContain("today: 2:00 (1 entry)");
    expect(r.text).toContain("2:00  Acme / Website / Development");
    expect(r.text).toContain("90  2:00  Acme / Website / Development");
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
      company: [{ wants_timestamp_timers: false, currency: "czk" }],
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
    expect(r.text).toContain("■ stopped Acme / Website / Development (id 100) at 1:00");
    expect(r.text).toContain("▶ Acme / Website / Development (id 200) — started 10:00am — new work");
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

  test("--offset patches base hours onto the running entry (duration mode)", async () => {
    const created = timeEntry({ id: 200, is_running: true, hours: 0 });
    const patched = timeEntry({
      id: 200,
      is_running: true,
      hours: 25 / 60,
      hours_without_timer: 25 / 60,
      notes: "thinking",
    });
    const bodies: unknown[] = [];
    const patches: unknown[] = [];
    const api = apiStub({
      me: [{ id: 7, first_name: "A", last_name: "B", email: "a@b.c" }],
      timeEntries: [[], []],
      company: [{ wants_timestamp_timers: false }],
      projectAssignments: [[assignment({ id: 10, name: "Website" }, "Acme", [{ id: 20, name: "Development" }])]],
      createTimeEntry: [
        (body: unknown) => {
          bodies.push(body);
          return Promise.resolve(created);
        },
      ],
      request: [
        (_method: string, _path: string, body: unknown) => {
          patches.push(body);
          return Promise.resolve(patched);
        },
      ],
    });
    const { deps } = makeDeps(api);
    const r = await cmdStart(deps, "website", undefined, "thinking", { offset: "25m" });
    expect(bodies[0]).toEqual({ project_id: 10, task_id: 20, spent_date: "2026-09-15", notes: "thinking" });
    expect(patches[0]).toEqual({ hours: 25 / 60 });
    expect(r.text).toContain("(+0:25 head start)");
    const json = r.json as { entry: { hours_without_timer: number } };
    expect(json.entry.hours_without_timer).toBeCloseTo(25 / 60);
  });

  test("--offset on timestamp accounts backdates started_time instead", async () => {
    const created = timeEntry({ id: 200, is_running: true });
    const bodies: unknown[] = [];
    const api = apiStub({
      me: [{ id: 7, first_name: "A", last_name: "B", email: "a@b.c" }],
      timeEntries: [[], []],
      company: [{ wants_timestamp_timers: true }],
      projectAssignments: [[assignment({ id: 10, name: "Website" }, "Acme", [{ id: 20, name: "Development" }])]],
      createTimeEntry: [
        (body: unknown) => {
          bodies.push(body);
          return Promise.resolve(created);
        },
      ],
    });
    const { deps } = makeDeps(api);
    const r = await cmdStart(deps, "website", undefined, undefined, { offset: "30m" });
    expect(bodies[0]).toMatchObject({ started_time: "9:30am" });
    expect(r.text).not.toContain("head start");
  });

  test("bad offset fails", async () => {
    const api = apiStub({});
    const { deps } = makeDeps(api);
    expect(cmdStart(deps, "website", undefined, undefined, { offset: "xyz" })).rejects.toThrow(/bad offset/);
    expect(cmdStart(deps, "website", undefined, undefined, { offset: "0" })).rejects.toThrow(/bad offset/);
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
    expect(r.text).toBe("■ Acme / Website / Development (id 100) — stopped at 0:30");
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
    expect(r.text).toBe("logged 1:30 → Acme / Website / Development (2026-09-14, id 300) — catch-up");
  });
});

describe("cmdEdit", () => {
  const me = [{ id: 7, first_name: "A", last_name: "B", email: "a@b.c" }];
  // Two client projects sharing one task set by id, one internal project with
  // its own tasks — the two shapes the carryover rule separates.
  const shared = [
    { id: 100, name: "Development" },
    { id: 101, name: "Analysis" },
  ];
  const base = {
    me,
    projectAssignments: [
      [
        assignment({ id: 10, name: "Website Phase 1" }, "Acme", shared),
        assignment({ id: 11, name: "Website Phase 2" }, "Acme", shared),
        assignment({ id: 12, name: "Internal" }, null, [
          { id: 200, name: "Development Budget" },
          { id: 201, name: "Research" },
        ]),
      ],
    ],
  };

  test("moves between projects sharing a task id without --task", async () => {
    const moved = timeEntry({ id: 55, project: { id: 11, name: "Website Phase 2" } });
    const bodies: unknown[] = [];
    const api = apiStub({
      ...base,
      timeEntry: [Promise.resolve(timeEntry({ id: 55, hours: 1.5, task: { id: 100, name: "Development" } }))],
      request: [
        (_m: unknown, _p: unknown, body: unknown) => {
          bodies.push(body);
          return Promise.resolve(moved);
        },
      ],
    });
    const { deps } = makeDeps(api);
    const r = await cmdEdit(deps, "55", { project: "phase 2" });
    expect(bodies[0]).toEqual({ project_id: 11, task_id: 100 });
    expect(r.text).toContain("moved Acme / Website Phase 2 / Development");
    expect(r.text).toContain("id 55");
  });

  test("explicit --task by id wins on a disjoint project", async () => {
    const moved = timeEntry({ id: 55, project: { id: 12, name: "Internal" }, client: null });
    const bodies: unknown[] = [];
    const api = apiStub({
      ...base,
      timeEntry: [Promise.resolve(timeEntry({ id: 55, hours: 1.5 }))],
      request: [
        (_m: unknown, _p: unknown, body: unknown) => {
          bodies.push(body);
          return Promise.resolve(moved);
        },
      ],
    });
    const { deps } = makeDeps(api);
    await cmdEdit(deps, "55", { project: "internal", task: "201" });
    expect(bodies[0]).toEqual({ project_id: 12, task_id: 201 });
  });

  test("no carryover on a disjoint project fails with the task list", async () => {
    const api = apiStub({
      ...base,
      timeEntry: [Promise.resolve(timeEntry({ id: 55, hours: 1.5 }))],
    });
    const { deps } = makeDeps(api);
    expect(cmdEdit(deps, "55", { project: "internal" })).rejects.toThrow(
      /task "Development" is not on Internal and no --task given[\s\S]*Development Budget/,
    );
  });

  test("task-only move resolves against the entry's current project", async () => {
    const moved = timeEntry({ id: 55, task: { id: 101, name: "Analysis" } });
    const bodies: unknown[] = [];
    const api = apiStub({
      ...base,
      timeEntry: [Promise.resolve(timeEntry({ id: 55, hours: 1.5 }))],
      request: [
        (_m: unknown, _p: unknown, body: unknown) => {
          bodies.push(body);
          return Promise.resolve(moved);
        },
      ],
    });
    const { deps } = makeDeps(api);
    await cmdEdit(deps, "55", { task: "analysis" });
    expect(bodies[0]).toEqual({ task_id: 101 });
  });

  test("single-task target autopicks without --task", async () => {
    const moved = timeEntry({ id: 55, project: { id: 13, name: "Solo" } });
    const bodies: unknown[] = [];
    const api = apiStub({
      ...base,
      projectAssignments: [
        [
          assignment({ id: 10, name: "Website Phase 1" }, "Acme", shared),
          assignment({ id: 13, name: "Solo" }, null, [{ id: 300, name: "Only Task" }]),
        ],
      ],
      timeEntry: [Promise.resolve(timeEntry({ id: 55, hours: 1.5 }))],
      request: [
        (_m: unknown, _p: unknown, body: unknown) => {
          bodies.push(body);
          return Promise.resolve(moved);
        },
      ],
    });
    const { deps } = makeDeps(api);
    await cmdEdit(deps, "55", { project: "solo" });
    expect(bodies[0]).toEqual({ project_id: 13, task_id: 300 });
  });

  test("hours-only edit keeps the edited verb and skips the GET", async () => {
    const bodies: unknown[] = [];
    const api = apiStub({
      ...base,
      request: [
        (_m: unknown, _p: unknown, body: unknown) => {
          bodies.push(body);
          return Promise.resolve(timeEntry({ id: 55, hours: 2 }));
        },
      ],
    });
    const { deps } = makeDeps(api);
    const r = await cmdEdit(deps, "55", { hours: "2" });
    expect(bodies[0]).toEqual({ hours: 2 });
    expect(r.text).toContain("edited Acme / Website / Development");
  });

  test("nothing to edit lists all fields", async () => {
    const { deps } = makeDeps(apiStub(base));
    expect(cmdEdit(deps, "55", {})).rejects.toThrow(/nothing to edit.*--project.*--task/);
  });
});

describe("requireNoteLinks", () => {
  const base = {
    me: [{ id: 7, first_name: "A", last_name: "B", email: "a@b.c" }],
    projectAssignments: [[assignment({ id: 10, name: "Website" }, "Acme", [{ id: 20, name: "Development" }])]],
    company: [{ wants_timestamp_timers: false }],
  };
  const cfg: HarvestConfig = { aliases: {}, requireNoteLinks: true };

  test("log warns on an unlinked note, silent with a link", async () => {
    const unlinked = timeEntry({ id: 300, hours: 1.5, notes: "catch-up work" });
    const api = apiStub({ ...base, createTimeEntry: [Promise.resolve(unlinked)] });
    const { deps } = makeDeps(api, cfg);
    const r = await cmdLog(deps, "1:30", "website", undefined, undefined, "catch-up work");
    expect(r.text).toContain("⚠ note has no link");
    expect(r.text).toContain("harvest edit 300");

    const linked = timeEntry({ id: 301, hours: 1.5, notes: "fixing bug\nhttps://tracker.example/t/9" });
    const api2 = apiStub({ ...base, createTimeEntry: [Promise.resolve(linked)] });
    const { deps: deps2 } = makeDeps(api2, cfg);
    const r2 = await cmdLog(deps2, "1:30", "website", undefined, undefined, "fixing bug");
    expect(r2.text).not.toContain("⚠");
  });

  test("start warns for a noteless timer", async () => {
    const created = timeEntry({ id: 200, is_running: true, notes: null });
    const api = apiStub({ ...base, timeEntries: [[], []], createTimeEntry: [Promise.resolve(created)] });
    const { deps } = makeDeps(api, cfg);
    const r = await cmdStart(deps, "website");
    expect(r.text).toContain("⚠ note has no link");
  });

  test("edit warns when the resulting note has no link", async () => {
    const api = apiStub({ request: [Promise.resolve(timeEntry({ id: 55, hours: 2, notes: "still no link" }))] });
    const { deps } = makeDeps(api, cfg);
    const r = await cmdEdit(deps, "55", { notes: "still no link" });
    expect(r.text).toContain("⚠ note has no link");
  });

  test("off by default", async () => {
    const unlinked = timeEntry({ id: 300, hours: 1.5, notes: "catch-up work" });
    const api = apiStub({ ...base, createTimeEntry: [Promise.resolve(unlinked)] });
    const { deps } = makeDeps(api);
    const r = await cmdLog(deps, "1:30", "website", undefined, undefined, "catch-up work");
    expect(r.text).not.toContain("⚠");
  });
});

describe("noteHasLink", () => {
  test("detects http(s) urls", () => {
    expect(noteHasLink("work\nhttps://tracker.example/t/1")).toBe(true);
    expect(noteHasLink("http://intranet.example/x")).toBe(true);
    expect(noteHasLink("plain note")).toBe(false);
    expect(noteHasLink(null)).toBe(false);
    expect(noteHasLink(undefined)).toBe(false);
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

  test("list shows the stored ids", () => {
    const cfg: HarvestConfig = {
      aliases: { web: { projectId: 10, projectName: "Website", taskId: 20, taskName: "Development" } },
    };
    const { deps } = makeDeps(apiStub({}), cfg);
    expect(aliasList(deps).text).toBe("  web → 10  Website / 20  Development");
  });
});

describe("cmdTasks", () => {
  test("aliases resolve wherever a project is passed", async () => {
    const api = apiStub({
      me: [{ id: 7, first_name: "A", last_name: "B", email: "a@b.c" }],
      projectAssignments: [
        [assignment({ id: 10, name: "Website", code: "WEB" }, "Acme", [{ id: 20, name: "Development" }])],
      ],
    });
    const cfg: HarvestConfig = {
      aliases: { web: { projectId: 10, projectName: "Website", taskId: null, taskName: null } },
    };
    const { deps } = makeDeps(api, cfg);
    const r = await cmdTasks(deps, "web");
    expect(r.text).toContain("20  Development");
    const json = r.json as { project: { id: number; name: string; code: string | null } };
    expect(json.project.id).toBe(10);
    expect(json.project.code).toBe("WEB");
  });
  test("numeric project arg matches by id", async () => {
    const api = apiStub({
      me: [{ id: 7, first_name: "A", last_name: "B", email: "a@b.c" }],
      projectAssignments: [
        [assignment({ id: 10, name: "Website", code: "WEB" }, "Acme", [{ id: 20, name: "Development" }])],
      ],
    });
    const { deps } = makeDeps(api);
    const r = await cmdTasks(deps, "10");
    expect(r.text).toContain("20  Development");
    const json = r.json as { project: { id: number } };
    expect(json.project.id).toBe(10);
  });
});

describe("entry ids in list output", () => {
  const me = { id: 7, first_name: "A", last_name: "B", email: "a@b.c" };

  test("today leads each line with the id", async () => {
    const api = apiStub({
      me: [me],
      timeEntries: [[timeEntry({ id: 3009843632, hours: 1.5, notes: "fix login" })]],
      company: [{ wants_timestamp_timers: false, currency: "czk" }],
    });
    const { deps } = makeDeps(api);
    const r = await cmdToday(deps);
    expect(r.text).toContain("3009843632  1:30  Acme / Website / Development");
  });

  test("week leads each line with the id", async () => {
    const api = apiStub({
      me: [me],
      timeEntries: [[timeEntry({ id: 3009843640, hours: 2.25 })]],
      company: [{ wants_timestamp_timers: false, currency: "czk" }],
    });
    const { deps } = makeDeps(api);
    const r = await cmdWeek(deps);
    expect(r.text).toContain("3009843640  2:15  Acme / Website / Development");
  });
});

describe("auditIssues", () => {
  test("missing and blank notes count as no-note", () => {
    expect(auditIssues(timeEntry({ notes: null }))).toEqual(["no-note", "zero-hours"]);
    expect(auditIssues(timeEntry({ notes: "   " }))).toEqual(["no-note", "zero-hours"]);
  });

  test("a linked note is clean", () => {
    expect(auditIssues(timeEntry({ hours: 1.5, notes: "summary\nhttps://tracker.example/t/1" }))).toEqual([]);
  });

  test("whole hours only, and never while running", () => {
    expect(isWholeHour(2)).toBe(true);
    expect(isWholeHour(2.5)).toBe(false);
    expect(isWholeHour(0)).toBe(false);
    expect(auditIssues(timeEntry({ hours: 2, is_running: true, notes: "https://x.example/1" }))).toEqual([]);
    expect(auditIssues(timeEntry({ hours: 2, notes: "https://x.example/1" }))).toEqual(["whole-hour"]);
  });
});

describe("cmdAudit", () => {
  const me = { id: 7, first_name: "A", last_name: "B", email: "a@b.c" };
  const entries = [
    timeEntry({ id: 1, spent_date: "2026-09-02", hours: 4.5, notes: "shipped it\nhttps://tracker.example/t/1" }),
    timeEntry({ id: 2, spent_date: "2026-09-03", hours: 2, notes: "no link here" }),
    timeEntry({ id: 3, spent_date: "2026-09-04", hours: 1.25, notes: null }),
    timeEntry({ id: 4, spent_date: "2026-09-05", hours: 1, is_running: true, notes: "https://tracker.example/t/4" }),
  ];
  const api = () => apiStub({ me: [me], timeEntries: [entries] });

  test("flags note and duration smells, keeps clean entries out", async () => {
    const { deps } = makeDeps(api());
    const r = await cmdAudit(deps, { month: "2026-09" });
    expect(r.text).toContain("audit 2026-09: 2 of 4 entries flagged");
    expect(r.text).toContain("2026-09-03  2  2:00  Acme / Website / Development  [no link, whole hour]");
    expect(r.text).toContain("2026-09-04  3  1:15  Acme / Website / Development  [no note]");
    expect(r.text).not.toContain("2026-09-02");
    expect(r.text).not.toContain("2026-09-05");
  });

  test("json carries per-entry issues", async () => {
    const { deps } = makeDeps(api());
    const r = await cmdAudit(deps, { month: "2026-09" });
    const json = r.json as { total: number; flagged: { id: number; issues: string[] }[] };
    expect(json.total).toBe(4);
    expect(json.flagged.map((f) => f.id)).toEqual([2, 3]);
    expect(json.flagged[0]?.issues).toEqual(["no-link", "whole-hour"]);
  });

  test("a clean month reports nothing flagged", async () => {
    const clean = [timeEntry({ id: 1, hours: 4.25, notes: "work\nhttps://tracker.example/t/1" })];
    const api2 = apiStub({ me: [me], timeEntries: [clean] });
    const { deps } = makeDeps(api2);
    const r = await cmdAudit(deps, { month: "2026-09" });
    expect(r.text).toBe("audit 2026-09: nothing flagged (1 entry)");
  });
});
describe("audit issue extras", () => {
  test("zero-hour, locked, and duplicate flags", () => {
    expect(auditIssues(timeEntry({ hours: 0, notes: "x\nhttps://t.example/1" }))).toEqual(["zero-hours"]);
    expect(auditIssues(timeEntry({ hours: 1.5, notes: "no link", is_locked: true }))).toEqual(["no-link", "locked"]);
    expect(auditIssues(timeEntry({ hours: 1.5, notes: "x\nhttps://t.example/1", is_locked: true }))).toEqual([]);
    expect(auditIssues(timeEntry({ hours: 1.5, notes: "x\nhttps://t.example/1" }), true)).toEqual(["duplicate"]);
  });
});

describe("duplicateEntryIds", () => {
  test("same date, project, task, hours, and notes", () => {
    const a = timeEntry({ id: 1, hours: 2, notes: "x" });
    const b = timeEntry({ id: 2, hours: 2, notes: "x" });
    const c = timeEntry({ id: 3, hours: 2, notes: "y" });
    expect([...duplicateEntryIds([a, b, c])]).toEqual([1, 2]);
  });

  test("running entries are ignored", () => {
    const a = timeEntry({ id: 1, hours: 2, notes: "x" });
    const b = timeEntry({ id: 2, hours: 2, notes: "x", is_running: true });
    expect(duplicateEntryIds([a, b]).size).toBe(0);
  });
});

describe("auditRange", () => {
  const now = new Date(2026, 8, 17); // Thursday

  test("month by default; --days ends today and includes it", () => {
    expect(auditRange(now, {})).toEqual({ label: "2026-09", from: "2026-09-01", to: "2026-09-30" });
    expect(auditRange(now, { days: "7" })).toEqual({ label: "last 7 days", from: "2026-09-11", to: "2026-09-17" });
    expect(auditRange(now, { days: "1" }).label).toBe("last 1 day");
  });

  test("explicit from/to", () => {
    expect(auditRange(now, { from: "2026-08-01", to: "2026-08-15" })).toEqual({
      label: "2026-08-01..2026-08-15",
      from: "2026-08-01",
      to: "2026-08-15",
    });
  });

  test("rejects mixed modes, half ranges, bad days, reversed ranges", () => {
    expect(() => auditRange(now, { month: "2026-08", days: "7" })).toThrow(/pick one range/);
    expect(() => auditRange(now, { from: "2026-08-01" })).toThrow(/--from and --to go together/);
    expect(() => auditRange(now, { days: "0" })).toThrow(/bad --days/);
    expect(() => auditRange(now, { from: "2026-08-02", to: "2026-08-01" })).toThrow(/after/);
  });
});

describe("cmdAudit ranges", () => {
  const me = { id: 7, first_name: "A", last_name: "B", email: "a@b.c" };

  test("--days narrows the query window and labels the report", async () => {
    const params: unknown[] = [];
    const clean = timeEntry({ id: 1, spent_date: "2026-09-17", hours: 1.5, notes: "x\nhttps://t.example/1" });
    const api = apiStub({
      me: [me],
      timeEntries: [
        (p: unknown) => {
          params.push(p);
          return Promise.resolve([clean]);
        },
      ],
    });
    const { deps } = makeDeps(api);
    const r = await cmdAudit(deps, { days: "3" });
    expect(params[0]).toMatchObject({ from: "2026-09-13", to: "2026-09-15" });
    expect(r.text).toBe("audit last 3 days: nothing flagged (1 entry)");
    expect((r.json as { range: string }).range).toBe("last 3 days");
  });

  test("duplicates in a range are flagged together", async () => {
    const note = "x\nhttps://t.example/1";
    const a = timeEntry({ id: 1, hours: 2.25, notes: note });
    const b = timeEntry({ id: 2, hours: 2.25, notes: note });
    const api = apiStub({ me: [me], timeEntries: [[a, b]] });
    const { deps } = makeDeps(api);
    const r = await cmdAudit(deps, { month: "2026-09" });
    expect(r.text).toContain("audit 2026-09: 2 of 2 entries flagged");
    expect(r.text).toContain("1  2:15  Acme / Website / Development  [possible duplicate]");
    expect(r.text).toContain("2  2:15  Acme / Website / Development  [possible duplicate]");
  });
});
describe("cmdMonth", () => {
  const entries = [
    timeEntry({ id: 1, project: { id: 10, name: "Website" }, hours: 4.5, billable_rate: null }),
    timeEntry({ id: 2, project: { id: 10, name: "Website" }, hours: 2, billable_rate: null }),
    timeEntry({ id: 3, project: { id: 11, name: "Internal" }, hours: 1.25, billable_rate: 100 }),
  ];

  test("config rate covers all entries with exact hours", async () => {
    const api = apiStub({
      me: [{ id: 7, first_name: "A", last_name: "B", email: "a@b.c" }],
      timeEntries: [entries],
      company: [{ wants_timestamp_timers: false, currency: "czk" }],
    });
    const { deps } = makeDeps(api, { aliases: {}, hourlyRate: 620 });
    const r = await cmdMonth(deps, "2026-09");
    expect(r.text).toContain("2026-09: 7:45 total — 4 805.00 CZK (rate 620)");
    expect(r.text).toContain("6:30  Website — 4 030.00 CZK");
    expect(r.text).toContain("1:15  Internal — 775.00 CZK");
  });

  test("without config rate, unrated entries are flagged", async () => {
    const api = apiStub({
      me: [{ id: 7, first_name: "A", last_name: "B", email: "a@b.c" }],
      timeEntries: [entries],
      company: [{ wants_timestamp_timers: false, currency: "czk" }],
    });
    const { deps } = makeDeps(api);
    const r = await cmdMonth(deps, "2026-09");
    expect(r.text).toContain("6:30 without a rate");
    expect(r.text).toContain("1:15  Internal — 125.00 CZK");
  });

  test("month parsing", () => {
    expect(monthRange("2026-09", new Date(2026, 8, 16))).toEqual({
      label: "2026-09",
      from: "2026-09-01",
      to: "2026-09-30",
    });
    expect(monthRange("2026-02", new Date(2026, 8, 16)).to).toBe("2026-02-28");
    expect(monthRange(undefined, new Date(2026, 8, 16)).label).toBe("2026-09");
    expect(() => monthRange("september", new Date(2026, 8, 16))).toThrow(/YYYY-MM/);
    expect(() => monthRange("2026-13", new Date(2026, 8, 16))).toThrow(/YYYY-MM/);
  });
});

describe("cmdDelete", () => {
  const entry = timeEntry({ id: 42, notes: "summary line\nhttps://tracker.example/t/42" });

  test("confirm declined cancels", async () => {
    const api = apiStub({ timeEntry: [entry] });
    const { deps } = makeDeps(api);
    const r = await cmdDelete(deps, "42", { confirm: async () => false });
    expect(r.text).toBe("cancelled");
  });

  test("confirm accepted deletes with multiline summary", async () => {
    const api = apiStub({ timeEntry: [entry], deleteEntry: [null] });
    const { deps } = makeDeps(api);
    const r = await cmdDelete(deps, "42", { confirm: async () => true });
    expect(r.text).toContain("deleted Acme / Website / Development (2026-09-15, 0:00, id 42) — summary line");
    expect(r.text).toContain("https://tracker.example/t/42");
    const json = r.json as { deleted: boolean };
    expect(json.deleted).toBe(true);
  });

  test("force skips confirm", async () => {
    const api = apiStub({ timeEntry: [entry], deleteEntry: [null] });
    const { deps } = makeDeps(api);
    const r = await cmdDelete(deps, "42", { force: true });
    expect(r.text.startsWith("deleted Acme")).toBe(true);
  });

  test("no force and no confirm fails with hint", async () => {
    const api = apiStub({ timeEntry: [entry] });
    const { deps } = makeDeps(api);
    expect(cmdDelete(deps, "42")).rejects.toThrow(/--force/);
  });
});

describe("cmdMonth grouping", () => {
  const entries = [
    timeEntry({
      id: 1,
      project: { id: 10, name: "Website" },
      task: { id: 20, name: "Development" },
      hours: 3,
      billable_rate: null,
      notes: "Build the thing\nhttps://tracker.example/t/1",
    }),
    timeEntry({
      id: 2,
      project: { id: 10, name: "Website" },
      task: { id: 21, name: "Design" },
      hours: 1,
      billable_rate: null,
    }),
  ];
  const api = () =>
    apiStub({
      me: [{ id: 7, first_name: "A", last_name: "B", email: "a@b.c" }],
      timeEntries: [entries],
      company: [{ wants_timestamp_timers: false, currency: "czk" }],
    });

  test("--group-by task flattens with project prefix", async () => {
    const { deps } = makeDeps(api(), { aliases: {}, hourlyRate: 100 });
    const r = await cmdMonth(deps, "2026-09", { groupBy: "task" });
    expect(r.text).toContain("3:00  Website / Development — 300.00 CZK");
    expect(r.text).toContain("1:00  Website / Design — 100.00 CZK");
  });

  test("--group-by note merges by first line", async () => {
    const { deps } = makeDeps(api(), { aliases: {}, hourlyRate: 100 });
    const r = await cmdMonth(deps, "2026-09", { groupBy: "note" });
    expect(r.text).toContain("3:00  Build the thing — 300.00 CZK");
    expect(r.text).toContain("1:00  (no note) — 100.00 CZK");
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

  test("--group-by parses dim and rejects others", () => {
    expect(parseCli(["week", "--group-by", "note"]).groupBy).toBe("note");
    expect(parseCli(["week"]).groupBy).toBeUndefined();
    expect(() => parseCli(["week", "--group-by", "wat"])).toThrow(/project, task, or note/);
  });

  test("conceal flag parses", () => {
    expect(parseCli(["status"]).conceal).toBe(false);
    expect(parseCli(["status", "--conceal"]).conceal).toBe(true);
  });

  test("--offset parses", () => {
    expect(parseCli(["start", "acme", "--offset", "25m"]).offset).toBe("25m");
    expect(parseCli(["start", "acme"]).offset).toBeUndefined();
  });

  test("audit range flags parse and validate", () => {
    expect(parseCli(["audit", "--days", "7"]).days).toBe("7");
    const r = parseCli(["audit", "--from", "2026-08-01", "--to", "2026-08-15"]);
    expect([r.from, r.to]).toEqual(["2026-08-01", "2026-08-15"]);
    expect(() => parseCli(["audit", "--from", "yesterday"])).toThrow(/yyyy-mm-dd/);
    expect(() => parseCli(["audit", "--to", "2026/08/15"])).toThrow(/yyyy-mm-dd/);
  });
});

describe("isAliasListForm", () => {
  test("bare, list, and ls are the list form", () => {
    expect(isAliasListForm([])).toBe(true);
    expect(isAliasListForm(["list"])).toBe(true);
    expect(isAliasListForm(["ls"])).toBe(true);
    expect(isAliasListForm(["foo"])).toBe(false);
    expect(isAliasListForm(["list", "acme"])).toBe(false);
  });
});

describe("concealMoney", () => {
  test("strips money fields at any depth, keeps hours", () => {
    const out = concealMoney({
      totalAmount: 500,
      total: 2,
      entries: [{ id: 1, hours: 2, billable_rate: 100, cost_rate: 50, project: { id: 9, name: "X" } }],
      groups: [{ project: "X", hours: 2, amount: 200, ratedHours: 2 }],
    });
    expect(out).toEqual({
      total: 2,
      entries: [{ id: 1, hours: 2, project: { id: 9, name: "X" } }],
      groups: [{ project: "X", hours: 2, ratedHours: 2 }],
    });
  });
});
