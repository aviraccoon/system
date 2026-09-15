// Harvest API v2 client. Zero deps; fetch injectable for tests.
// Docs: https://help.getharvest.com/api-v2/

export interface HarvestAuth {
  token: string;
  accountId: string;
}

export class HarvestApiError extends Error {
  status: number;
  retryAfter: number | null;

  constructor(status: number, message: string, retryAfter: number | null = null) {
    super(message);
    this.name = "HarvestApiError";
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

export interface TimeEntry {
  id: number;
  spent_date: string;
  hours: number;
  hours_without_timer: number;
  rounded_hours: number;
  notes: string | null;
  is_running: boolean;
  timer_started_at: string | null;
  started_time: string | null;
  ended_time: string | null;
  is_billed: boolean;
  is_locked: boolean;
  approval_status: string;
  billable: boolean;
  billable_rate: number | null;
  cost_rate: number | null;
  project: { id: number; name: string };
  task: { id: number; name: string };
  client: { id: number; name: string } | null;
}

export interface TaskAssignment {
  id: number;
  is_active: boolean;
  task: { id: number; name: string };
}

/** One of the user's assigned projects with its task assignments. */
export interface ProjectAssignment {
  id: number;
  is_active: boolean;
  project: { id: number; name: string; code: string | null };
  client: { id: number; name: string } | null;
  task_assignments: TaskAssignment[];
}

export interface HarvestUser {
  id: number;
  first_name: string;
  last_name: string;
  email: string;
}

export interface HarvestCompany {
  wants_timestamp_timers: boolean;
  /** ISO 4217 code (e.g. "CZK"); currency_code_display is a placement specifier, not a code. */
  currency?: string;
}

export type QueryParams = Record<string, string | number | boolean | undefined>;

export interface HarvestClient {
  request<T>(method: "GET" | "POST" | "PATCH" | "DELETE", path: string, body?: unknown): Promise<T>;
  listAll<T>(path: string, params: QueryParams, key: string): Promise<T[]>;
  me(): Promise<HarvestUser>;
  company(): Promise<HarvestCompany>;
  timeEntries(params: QueryParams): Promise<TimeEntry[]>;
  createTimeEntry(body: Record<string, unknown>): Promise<TimeEntry>;
  stopEntry(id: number): Promise<TimeEntry>;
  projectAssignments(): Promise<ProjectAssignment[]>;
}

function errorMessage(body: unknown, statusText: string): string {
  if (body && typeof body === "object") {
    const b = body as Record<string, unknown>;
    const parts = [b.message, b.error, b.error_description].filter((s): s is string => typeof s === "string");
    if (parts.length > 0) return parts.join(": ");
    if (b.errors) return JSON.stringify(b.errors);
  }
  return statusText || "request failed";
}

export function createClient(auth: HarvestAuth, userAgent: string, fetchImpl: typeof fetch = fetch): HarvestClient {
  const base = "https://api.harvestapp.com/v2";

  async function request<T>(method: "GET" | "POST" | "PATCH" | "DELETE", path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${auth.token}`,
      "Harvest-Account-Id": auth.accountId,
      "User-Agent": userAgent,
    };
    const init: RequestInit = { method, headers };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    const res = await fetchImpl(`${base}${path}`, init);
    if (!res.ok) {
      let parsed: unknown = null;
      try {
        parsed = await res.json();
      } catch {
        // body not JSON; fall through to statusText
      }
      const retryAfter = res.headers.get("Retry-After");
      const retryNum = retryAfter === null ? null : Number(retryAfter);
      const hint =
        res.status === 429 && retryNum !== null && !Number.isNaN(retryNum) ? ` (retry after ${retryNum}s)` : "";
      throw new HarvestApiError(res.status, `${errorMessage(parsed, res.statusText)}${hint}`, retryNum);
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  async function listAll<T>(path: string, params: QueryParams, key: string): Promise<T[]> {
    const out: T[] = [];
    let page = 1;
    for (;;) {
      const merged: QueryParams = { ...params, page, per_page: 100 };
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(merged)) {
        if (v !== undefined) qs.set(k, String(v));
      }
      const res = await request<Record<string, unknown>>("GET", `${path}?${qs.toString()}`);
      out.push(...((res[key] as T[]) ?? []));
      const totalPages = res.total_pages as number;
      if (typeof totalPages !== "number" || page >= totalPages) break;
      page += 1;
    }
    return out;
  }

  return {
    request,
    listAll,
    me: () => request<HarvestUser>("GET", "/users/me"),
    company: () => request<HarvestCompany>("GET", "/company"),
    timeEntries: (params) => listAll<TimeEntry>("/time_entries", params, "time_entries"),
    createTimeEntry: (body) => request<TimeEntry>("POST", "/time_entries", body),
    stopEntry: (id) => request<TimeEntry>("PATCH", `/time_entries/${id}/stop`),
    projectAssignments: () => listAll<ProjectAssignment>("/users/me/project_assignments", {}, "project_assignments"),
  };
}
