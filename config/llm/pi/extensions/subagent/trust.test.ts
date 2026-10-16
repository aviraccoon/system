import { describe, expect, test } from "bun:test";
import { AcceptedRoots, PROJECT_TRUST_ENTRY, type TrustHistoryEntry } from "./trust";

function branch(entries: TrustHistoryEntry[]): { getBranch(): readonly TrustHistoryEntry[] } {
  return { getBranch: () => entries };
}

describe("AcceptedRoots", () => {
  test("a session with no entries accepts nothing", () => {
    const roots = new AcceptedRoots();
    roots.restoreFromSession(branch([]));
    expect(roots.has("/repo")).toBe(false);
  });

  test("restores accepted roots and ignores other entries", () => {
    const roots = new AcceptedRoots();
    roots.restoreFromSession(
      branch([
        { type: "custom", customType: PROJECT_TRUST_ENTRY, data: { root: "/repo" } },
        { type: "custom", customType: "other_entry", data: { root: "/other" } },
        { type: "message", customType: PROJECT_TRUST_ENTRY, data: { root: "/wrong-type" } },
        { type: "custom", customType: PROJECT_TRUST_ENTRY, data: { root: 42 } },
      ]),
    );
    expect(roots.has("/repo")).toBe(true);
    expect(roots.has("/other")).toBe(false);
    expect(roots.has("/wrong-type")).toBe(false);
  });

  test("a restore replaces the set, so a branch without the entry re-asks", () => {
    const roots = new AcceptedRoots();
    roots.add("/repo");
    roots.restoreFromSession(branch([]));
    expect(roots.has("/repo")).toBe(false);
  });

  test("add then has", () => {
    const roots = new AcceptedRoots();
    roots.add("/repo");
    expect(roots.has("/repo")).toBe(true);
    expect(roots.has("/other")).toBe(false);
  });
});
