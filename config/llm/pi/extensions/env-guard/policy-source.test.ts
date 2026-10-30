import { describe, expect, test } from "bun:test";
import { createPolicySource } from "./policy-source";

const VALID = JSON.stringify({
  project: "acme-widgets",
  environment: "the devcontainer",
  binding: {
    command: "docker exec -w /workspaces/acme-widgets/app acme-dev-1",
    workdir: "/workspaces/acme-widgets/app",
  },
  clauses: [{ id: "deps", text: "Dependency work runs in the devcontainer." }],
});

function source(initial: { raw?: string; mtime?: number }) {
  const file = { raw: initial.raw, mtime: initial.mtime ?? 1000, path: "/notes/acme-widgets/.agents/environment.json" };
  const counts = { stat: 0, read: 0 };
  const created = createPolicySource({
    pathFor: () => file.path,
    stat: () => {
      counts.stat++;
      return file.raw === undefined ? null : { mtimeMs: file.mtime };
    },
    read: () => {
      counts.read++;
      if (file.raw === undefined) throw new Error("ENOENT");
      return file.raw;
    },
  });
  return { created, file, counts };
}

describe("createPolicySource", () => {
  test("first load reads the file and reports the change", () => {
    const { created, counts } = source({ raw: VALID });
    const loaded = created.load("/p");
    expect(loaded.changed).toBe(true);
    expect(loaded.policy?.project).toBe("acme-widgets");
    expect(counts.read).toBe(1);
  });

  test("an unchanged mtime does not re-read, and does not report a change", () => {
    const { created, counts } = source({ raw: VALID });
    created.load("/p");
    const again = created.load("/p");
    expect(again.changed).toBe(false);
    expect(counts.read).toBe(1);
  });

  test("a new mtime re-reads and reports the change, so cached verdicts drop", () => {
    const { created, file, counts } = source({ raw: VALID });
    created.load("/p");
    file.mtime = 2000;
    file.raw = VALID.replace("Dependency work", "Dependency and lockfile work");
    const reloaded = created.load("/p");
    expect(reloaded.changed).toBe(true);
    expect(counts.read).toBe(2);
    expect(reloaded.policy?.clauses[0]?.text).toContain("lockfile");
  });

  test("a different project path reloads even when the mtime matches", () => {
    const pathABC = "/notes/a/.agents/environment.json";
    const pathXYZ = "/notes/x/.agents/environment.json";
    let path = pathABC;
    const reads: string[] = [];
    const created = createPolicySource({
      pathFor: () => path,
      stat: () => ({ mtimeMs: 1000 }),
      read: (p) => {
        reads.push(p);
        return VALID;
      },
    });
    created.load("/p");
    path = pathXYZ;
    const loaded = created.load("/p");
    expect(loaded.changed).toBe(true);
    expect(loaded.path).toBe(pathXYZ);
    expect(reads).toEqual([pathABC, pathXYZ]);
  });

  test("a file that disappears reports the change and no policy", () => {
    const { created, file } = source({ raw: VALID });
    created.load("/p");
    file.raw = undefined;
    const gone = created.load("/p");
    expect(gone.changed).toBe(true);
    expect(gone.policy).toBeNull();
    expect(gone.errors).toEqual([]);
    expect(created.load("/p").changed).toBe(false);
  });

  test("an unreadable file reports the error instead of a policy", () => {
    const created = createPolicySource({
      pathFor: () => "/notes/acme-widgets/.agents/environment.json",
      stat: () => ({ mtimeMs: 1000 }),
      read: () => {
        throw new Error("EACCES");
      },
    });
    const loaded = created.load("/p");
    expect(loaded.policy).toBeNull();
    expect(loaded.errors.join()).toContain("unreadable: EACCES");
    expect(loaded.changed).toBe(true);
  });

  test("an invalid policy reports every error and leaves no policy", () => {
    const { created } = source({ raw: '{"project":"","clauses":[]}' });
    const loaded = created.load("/p");
    expect(loaded.policy).toBeNull();
    expect(loaded.errors.length).toBeGreaterThan(1);
    expect(loaded.changed).toBe(true);
  });
});
