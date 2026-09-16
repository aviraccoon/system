import { describe, expect, it } from "bun:test";
import { formatPill, type StatusJson, shortProject } from "./pill";

const running = (over: Partial<NonNullable<StatusJson["running"]>> = {}): StatusJson => ({
  running: {
    id: 1,
    project: { id: 10, name: "Acme / Website" },
    task: { id: 20, name: "Development" },
    is_running: true,
    timer_started_at: "2026-09-16T10:00:00Z",
    started_time: null,
    elapsed: "0:42",
    ...over,
  },
  today: [],
  total: 0.7,
});

describe("shortProject", () => {
  it("takes the last client/project segment", () => {
    expect(shortProject("Acme / Website")).toBe("Website");
    expect(shortProject("Website")).toBe("Website");
    expect(shortProject("Acme / Web / Alpha")).toBe("Alpha");
  });

  it("falls back to the full name when there is no tail", () => {
    expect(shortProject(" / ")).toBe(" / ");
  });
});

describe("formatPill", () => {
  it("running timer: elapsed + short project", () => {
    expect(formatPill(running())).toEqual({ text: "⏱ 0:42 Website", warn: false });
  });

  it("missing elapsed renders as ?", () => {
    expect(formatPill(running({ elapsed: undefined })).text).toBe("⏱ ? Website");
  });

  it("no running timer: idle warning", () => {
    expect(formatPill({ running: null, today: [], total: 0 })).toEqual({ text: "⏱ idle", warn: true });
  });
});
