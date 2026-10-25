import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInitialState } from "./logic";
import {
  applySettings,
  currentSettings,
  loadSettings,
  parseSettings,
  saveSettings,
  settingsPath,
  temporaryPath,
} from "./settings";

const HOME = "/Users/acme";

// ── parseSettings ──

describe("parseSettings", () => {
  test("reads both preferences", () => {
    expect(parseSettings('{"mode":"trust-project","autoClassify":"on"}')).toEqual({
      mode: "trust-project",
      autoClassify: "on",
    });
  });

  test("an absent or unknown value is absent, not a default", () => {
    expect(parseSettings('{"mode":"careful"}')).toEqual({ mode: "careful" });
    expect(parseSettings('{"mode":"yolo"}')).toEqual({});
    expect(parseSettings('{"autoClassify":"yes"}')).toEqual({});
    expect(parseSettings('{"autoClassify":true}')).toEqual({});
    expect(parseSettings("{}")).toEqual({});
  });

  test("only the two known keys survive", () => {
    expect(parseSettings('{"mode":"allow-all","autoClassify":"off","allowedBashPrefixes":["git"]}')).toEqual({
      mode: "allow-all",
      autoClassify: "off",
    });
  });

  test("malformed or non-object text means no settings", () => {
    expect(parseSettings("not json")).toEqual({});
    expect(parseSettings("[]")).toEqual({});
    expect(parseSettings("null")).toEqual({});
    expect(parseSettings('"trust-project"')).toEqual({});
    expect(parseSettings("")).toEqual({});
  });
});

// ── loadSettings / saveSettings ──

describe("settings file", () => {
  test("a missing file means the defaults", () => {
    const dir = mkdtempSync(join(tmpdir(), "gate-settings-"));
    expect(loadSettings(join(dir, "absent", "permission-gate.json"))).toEqual({});
  });

  test("an unreadable file means the defaults", () => {
    const dir = mkdtempSync(join(tmpdir(), "gate-settings-"));
    // A directory is the portable way to make the read fail.
    mkdirSync(join(dir, "permission-gate.json"));
    expect(loadSettings(join(dir, "permission-gate.json"))).toEqual({});
  });

  test("saving creates the state directory and round-trips", () => {
    const dir = mkdtempSync(join(tmpdir(), "gate-settings-"));
    const file = join(dir, "state", "permission-gate.json");
    expect(saveSettings(file, { mode: "trust-project", autoClassify: "on" })).toBe(true);
    expect(loadSettings(file)).toEqual({ mode: "trust-project", autoClassify: "on" });
  });

  test("the settings land in the file, with no staging file left", () => {
    const dir = mkdtempSync(join(tmpdir(), "gate-settings-"));
    const file = join(dir, "permission-gate.json");
    saveSettings(file, { mode: "careful" });
    expect(existsSync(temporaryPath(file))).toBe(false);
    expect(JSON.parse(readFileSync(file, "utf-8"))).toEqual({ mode: "careful" });
  });

  test("the staging path is per writer, not one name every process shares", () => {
    expect(temporaryPath("/Users/acme/.pi/agent/state/permission-gate.json")).toContain(String(process.pid));
  });

  test("a write that cannot land reports false instead of throwing", () => {
    const dir = mkdtempSync(join(tmpdir(), "gate-settings-"));
    // A regular file where the state directory would go.
    const blocker = join(dir, "state");
    writeFileSync(blocker, "", "utf-8");
    expect(saveSettings(join(blocker, "permission-gate.json"), { mode: "careful" })).toBe(false);
  });

  test("a write that cannot land leaves the previous file in place", () => {
    const dir = mkdtempSync(join(tmpdir(), "gate-settings-"));
    const file = join(dir, "permission-gate.json");
    expect(saveSettings(file, { mode: "careful" })).toBe(true);
    // The staging path is taken, so the new content cannot be staged; the file the
    // next start would read must still hold the previous pair.
    mkdirSync(temporaryPath(file));
    expect(saveSettings(file, { mode: "allow-all", autoClassify: "on" })).toBe(false);
    expect(loadSettings(file)).toEqual({ mode: "careful" });
  });

  test("the path is the state store, not the repo", () => {
    expect(settingsPath(HOME)).toBe("/Users/acme/.pi/agent/state/permission-gate.json");
  });
});

// ── applySettings / currentSettings ──

describe("applySettings", () => {
  test("a persisted pair replaces the fresh defaults", () => {
    const state = createInitialState();
    applySettings(state, { mode: "trust-project", autoClassify: "on" });
    expect(state.mode).toBe("trust-project");
    expect(state.autoClassify).toBe("on");
  });

  test("an absent key keeps the default", () => {
    const state = createInitialState();
    applySettings(state, { autoClassify: "on" });
    expect(state.mode).toBe("careful");
    expect(state.autoClassify).toBe("on");
  });

  test("a persisted pair round-trips through currentSettings", () => {
    const state = createInitialState();
    state.mode = "allow-all";
    state.autoClassify = "on";
    const restored = createInitialState();
    applySettings(restored, currentSettings(state));
    expect(currentSettings(restored)).toEqual({ mode: "allow-all", autoClassify: "on" });
  });

  test("session rules are not part of the persisted pair", () => {
    const state = createInitialState();
    state.allowedBashPrefixes = ["git"];
    state.allowedPaths = ["/tmp/scratch"];
    state.allowedPathGlobs = ["**/*.nix"];
    state.toolOverrides = { bash: "allow" };
    expect(currentSettings(state)).toEqual({ mode: "careful", autoClassify: "off" });
  });
});
