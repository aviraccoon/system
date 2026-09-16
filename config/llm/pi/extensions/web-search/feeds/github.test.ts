import { describe, expect, test } from "bun:test";
import { formatDate, languageForPath, matches, parseGitHubUrl, renderBlob, renderIssue, renderRepo } from "./github";

describe("parseGitHubUrl", () => {
  test("repo root", () => {
    expect(parseGitHubUrl("https://github.com/acme/widgets")).toEqual({
      kind: "repo",
      owner: "acme",
      repo: "widgets",
    });
  });

  test("repo root with trailing slash + query stripped", () => {
    expect(parseGitHubUrl("https://github.com/TanStack/router/?tab=readme")).toEqual({
      kind: "repo",
      owner: "TanStack",
      repo: "router",
    });
  });

  test("blob path with nested file + ref", () => {
    expect(parseGitHubUrl("https://github.com/o/r/blob/main/src/sub/file.ts")).toEqual({
      kind: "blob",
      owner: "o",
      repo: "r",
      ref: "main",
      path: "src/sub/file.ts",
    });
  });

  test("issue number", () => {
    expect(parseGitHubUrl("https://github.com/o/r/issues/42")).toEqual({
      kind: "issue",
      owner: "o",
      repo: "r",
      number: 42,
    });
  });

  test("strips .git suffix", () => {
    expect(parseGitHubUrl("https://github.com/o/r.git")).toEqual({ kind: "repo", owner: "o", repo: "r" });
  });

  test("rejects deferred page types (pull, discussions, releases)", () => {
    expect(parseGitHubUrl("https://github.com/o/r/pull/5")).toBeNull();
    expect(parseGitHubUrl("https://github.com/o/r/discussions/9")).toBeNull();
    expect(parseGitHubUrl("https://github.com/o/r/releases")).toBeNull();
    expect(parseGitHubUrl("https://github.com/o/r/tree/main")).toBeNull();
  });

  test("rejects non-github hosts", () => {
    expect(parseGitHubUrl("https://gitlab.com/o/r")).toBeNull();
    expect(parseGitHubUrl("https://example.com/o/r/issues/1")).toBeNull();
  });
});

describe("matches", () => {
  test("delegates to parseGitHubUrl", () => {
    expect(matches("https://github.com/o/r")).toBe(true);
    expect(matches("https://github.com/o/r/pull/1")).toBe(false);
  });
});

describe("formatDate", () => {
  test("ISO to YYYY-MM-DD", () => {
    expect(formatDate("2026-03-31T00:12:25Z")).toBe("2026-03-31");
  });
  test("malformed returns ?", () => {
    expect(formatDate("not-a-date")).toBe("?");
  });
});

describe("languageForPath", () => {
  test("common extensions", () => {
    expect(languageForPath("src/main.rs")).toBe("rust");
    expect(languageForPath("app.tsx")).toBe("tsx");
    expect(languageForPath("config.nix")).toBe("nix");
    expect(languageForPath("Dockerfile")).toBe("dockerfile");
    expect(languageForPath("Makefile")).toBe("makefile");
  });
  test("unknown extension → empty", () => {
    expect(languageForPath("weird.xyz")).toBe("");
  });
});

describe("renderRepo", () => {
  const meta = {
    full_name: "acme/widgets",
    description: "A raccoon's paws.",
    homepage: "https://crates.io/crates/widgets",
    stargazers_count: 5,
    forks_count: 2,
    subscribers_count: 1,
    open_issues_count: 3,
    language: "Rust",
    license: { spdx_id: "Unlicense" },
    topics: ["a11y", "ocr"],
    default_branch: "main",
    created_at: "2026-03-31T00:00:00Z",
    pushed_at: "2026-06-09T00:00:00Z",
    private: false,
    fork: false,
    source: null,
    is_template: false,
    archived: false,
    disabled: false,
  };

  test("renders title, description, all stats, facts, dates", () => {
    const out = renderRepo(meta, null, null);
    expect(out).toContain("# acme/widgets");
    expect(out).toContain("A raccoon's paws.");
    expect(out).toContain("Stars: 5 · Forks: 2 · Watching: 1 · Open issues: 3");
    expect(out).toContain("Language: Rust · License: Unlicense · Topics: a11y, ocr");
    expect(out).toContain("Homepage: https://crates.io/crates/widgets · Default branch: main");
    expect(out).toContain("Created 2026-03-31 · Last push 2026-06-09");
  });

  test("marks archived + disabled", () => {
    const out = renderRepo({ ...meta, archived: true, disabled: true }, null, null);
    expect(out).toContain("*Archived*");
    expect(out).toContain("*Disabled*");
  });

  test("includes latest release section when present", () => {
    const release = {
      tag_name: "v0.4.0",
      name: "Trash Crab",
      published_at: "2026-06-05T00:00:00Z",
      body: "The cross-platform release.",
    };
    const out = renderRepo(meta, release, null);
    expect(out).toContain("--- LATEST RELEASE: v0.4.0 — Trash Crab (2026-06-05) ---");
    expect(out).toContain("The cross-platform release.");
  });

  test("includes README under divider", () => {
    const out = renderRepo(meta, null, "# widgets\n\nbody");
    expect(out).toContain("--- README ---");
    expect(out).toContain("# widgets");
  });

  test("omits empty sections cleanly", () => {
    const out = renderRepo({ ...meta, description: null, homepage: null, topics: [], license: null }, null, null);
    expect(out).not.toContain("--- README ---");
    expect(out).not.toContain("License:");
    expect(out).not.toContain("Homepage:");
  });
});

describe("renderIssue", () => {
  const issue = {
    number: 42,
    title: "Bug in router",
    state: "closed",
    state_reason: "completed",
    user: { login: "alice" },
    labels: [{ name: "bug" }, { name: "p0" }],
    assignees: [{ login: "bob" }],
    reactions: { total_count: 7 },
    comments: 2,
    created_at: "2026-01-01T00:00:00Z",
    body: "Steps to reproduce.",
  };
  const comments = [
    { user: { login: "bob" }, created_at: "2026-01-02T00:00:00Z", reactions: { total_count: 1 }, body: "Fixed." },
    { user: { login: "carol" }, created_at: "2026-01-03T00:00:00Z", reactions: { total_count: 0 }, body: "Thanks!" },
  ];

  test("renders metadata header with state, author, counts", () => {
    const out = renderIssue(issue, comments);
    expect(out).toContain("# Bug in router");
    expect(out).toContain("Issue #42 closed (completed)");
    expect(out).toContain("u/alice");
    expect(out).toContain("2 comments");
    expect(out).toContain("7 reactions");
    expect(out).toContain("Labels: bug, p0");
    expect(out).toContain("Assignees: bob");
  });

  test("renders flat comment stream with bodies indented", () => {
    const out = renderIssue(issue, comments);
    expect(out).toContain("--- COMMENTS ---");
    expect(out).toContain("- **u/bob** (1 reactions, 2026-01-02):");
    expect(out).toContain("  Fixed.");
    expect(out).toContain("- **u/carol** (0 reactions, 2026-01-03):");
  });
});

describe("renderBlob", () => {
  test("wraps content in a lang:path fence", () => {
    const out = renderBlob("src/main.rs", "fn main() {}\n");
    expect(out).toBe("```rust:src/main.rs\nfn main() {}\n```");
  });

  test("trims trailing newlines and adds exactly one", () => {
    const out = renderBlob("app.ts", "x\n\n\n");
    expect(out).toBe("```typescript:app.ts\nx\n```");
  });

  test("unknown extension → empty lang, path preserved", () => {
    const out = renderBlob("weird.xyz", "data");
    expect(out).toBe("```weird.xyz\ndata\n```");
  });
});
