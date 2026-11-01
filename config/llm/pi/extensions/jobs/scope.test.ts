import { describe, expect, test } from "bun:test";
import type { JobView } from "./format";
import { cycleScope, hiddenFinished, inScope, scopeLabel, startedHere, visibleJobs } from "./scope";

function view(overrides: Partial<JobView> = {}): JobView {
  return {
    id: "j-1",
    command: "make build",
    status: { startedAt: 1_000 },
    alive: true,
    logBytes: 0,
    cwd: "/work/project",
    session: "session-a",
    ...overrides,
  };
}

describe("cycleScope", () => {
  test("walks project, session, all, and returns", () => {
    expect(cycleScope("project")).toBe("session");
    expect(cycleScope("session")).toBe("all");
    expect(cycleScope("all")).toBe("project");
  });

  test("labels every state", () => {
    expect(scopeLabel("project")).toBe("this project");
    expect(scopeLabel("session")).toBe("this session");
    expect(scopeLabel("all")).toBe("all dirs");
  });
});

describe("inScope", () => {
  test("project compares directories", () => {
    expect(inScope(view(), "project", { cwd: "/work/project" })).toBe(true);
    expect(inScope(view(), "project", { cwd: "/work/other" })).toBe(false);
  });

  test("project with no cwd shows everything rather than nothing", () => {
    expect(inScope(view({ cwd: undefined }), "project", {})).toBe(true);
  });

  test("session compares ids", () => {
    expect(inScope(view(), "session", { sessionId: "session-a" })).toBe(true);
    expect(inScope(view(), "session", { sessionId: "session-b" })).toBe(false);
  });

  test("a record from before the field existed belongs to no session", () => {
    const legacy = view({ session: undefined });
    expect(inScope(legacy, "session", { sessionId: undefined })).toBe(false);
    expect(startedHere(legacy, undefined)).toBe(false);
  });

  test("all takes everything", () => {
    expect(inScope(view({ cwd: "/elsewhere", session: "other" }), "all", { cwd: "/work/project" })).toBe(true);
  });
});

describe("visibleJobs", () => {
  test("running only by default, because settled records live for days", () => {
    const running = view({ id: "run" });
    const done = view({ id: "done", alive: false, status: { startedAt: 1, exit: 0, finishedAt: 2 } });
    const visible = visibleJobs([running, done], { scope: "project", cwd: "/work/project", showFinished: false });
    expect(visible.map((v) => v.id)).toEqual(["run"]);
  });

  test("showFinished reveals the settled ones", () => {
    const done = view({ id: "done", alive: false, status: { startedAt: 1, exit: 0, finishedAt: 2 } });
    const visible = visibleJobs([done], { scope: "project", cwd: "/work/project", showFinished: true });
    expect(visible.map((v) => v.id)).toEqual(["done"]);
  });

  test("a job whose process died unwatched counts as settled, not running", () => {
    const lost = view({ alive: false, status: { startedAt: 1 } });
    expect(visibleJobs([lost], { scope: "project", cwd: "/work/project", showFinished: false })).toEqual([]);
  });

  test("the scope applies before the state filter", () => {
    const elsewhere = view({ id: "else", cwd: "/work/other" });
    expect(visibleJobs([elsewhere], { scope: "project", cwd: "/work/project", showFinished: false })).toEqual([]);
    expect(
      visibleJobs([elsewhere], { scope: "all", cwd: "/work/project", showFinished: false }).map((v) => v.id),
    ).toEqual(["else"]);
  });
});

describe("hiddenFinished", () => {
  test("counts the settled jobs the filter is hiding, inside the scope", () => {
    const done = view({ id: "done", alive: false, status: { startedAt: 1, exit: 0, finishedAt: 2 } });
    const otherDone = view({
      id: "other",
      cwd: "/work/other",
      alive: false,
      status: { startedAt: 1, exit: 0, finishedAt: 2 },
    });
    expect(hiddenFinished([done, otherDone, view()], { scope: "project", cwd: "/work/project" })).toBe(1);
    expect(hiddenFinished([done, otherDone, view()], { scope: "all", cwd: "/work/project" })).toBe(2);
  });
});
