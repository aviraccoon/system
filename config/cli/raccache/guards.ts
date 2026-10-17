// Pre-run checks. A laptop on battery, or off the home network, should not
// push a whole tree: the run stops at the start and again before every target,
// because a multi-hour job can outlive the conditions it started under.

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";

export interface GuardObservation {
  /** true on mains, false on battery, undefined when the machine has no battery. */
  acPower?: boolean;
  gateway?: string;
}

export interface GuardSettings {
  powerGuard: boolean;
  homeGateway?: string;
}

export function parsePmsetAc(text: string): boolean | undefined {
  if (text.includes("AC Power")) return true;
  if (text.includes("Battery Power")) return false;
  return undefined;
}

export function parseDarwinGateway(text: string): string | undefined {
  return /gateway:\s*(\S+)/.exec(text)?.[1];
}

export function parseLinuxGateway(text: string): string | undefined {
  return /^default via (\S+)/m.exec(text)?.[1];
}

/** Linux sysfs: a supply is on mains when any `online` file reads 1. */
export function parseSysfsPower(texts: string[]): boolean | undefined {
  if (texts.length === 0) return undefined;
  return texts.some((text) => text.trim() === "1");
}

function darwinObservation(): GuardObservation {
  const run = (command: string, args: string[]): string | null => {
    try {
      return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 10_000 });
    } catch {
      return null;
    }
  };
  const batt = run("pmset", ["-g", "batt"]);
  const route = run("route", ["-n", "get", "default"]);
  return {
    acPower: batt === null ? undefined : parsePmsetAc(batt),
    gateway: route === null ? undefined : parseDarwinGateway(route),
  };
}

function linuxObservation(): GuardObservation {
  let online: string[] = [];
  try {
    const supplies = readdirSync("/sys/class/power_supply");
    online = supplies.flatMap((name) => {
      try {
        return [readFileSync(`/sys/class/power_supply/${name}/online`, "utf8")];
      } catch {
        return [];
      }
    });
  } catch {
    online = [];
  }
  let gateway: string | undefined;
  try {
    gateway = parseLinuxGateway(
      execFileSync("ip", ["route", "show", "default"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 10_000,
      }),
    );
  } catch {
    gateway = undefined;
  }
  return { acPower: parseSysfsPower(online), gateway };
}

export function observe(platform = process.platform): GuardObservation {
  if (platform === "darwin") return darwinObservation();
  if (platform === "linux") return linuxObservation();
  return {};
}

export function guardVerdict(observation: GuardObservation, settings: GuardSettings): { ok: boolean; reason?: string } {
  if (settings.powerGuard && observation.acPower === false) return { ok: false, reason: "on battery power" };
  if (settings.homeGateway && observation.gateway !== settings.homeGateway) {
    return { ok: false, reason: `not on home network (gateway=${observation.gateway ?? "none"})` };
  }
  return { ok: true };
}
