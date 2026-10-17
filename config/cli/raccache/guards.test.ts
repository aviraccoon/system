import { describe, expect, test } from "bun:test";
import { guardVerdict, parseDarwinGateway, parseLinuxGateway, parsePmsetAc, parseSysfsPower } from "./guards";

describe("parsers", () => {
  test("pmset reports AC and battery", () => {
    expect(parsePmsetAc("Now drawing from 'AC Power'\n -InternalBattery-0 (id=1)\t100%; charged;")).toBe(true);
    expect(parsePmsetAc("Now drawing from 'Battery Power'\n -InternalBattery-0 (id=1)\t82%; discharging;")).toBe(false);
    expect(parsePmsetAc("random text")).toBeUndefined();
  });

  test("darwin route output", () => {
    const text = "   route to: default\n    gateway: 192.168.50.1\n  interface: en0\n";
    expect(parseDarwinGateway(text)).toBe("192.168.50.1");
    expect(parseDarwinGateway("no route")).toBeUndefined();
  });

  test("linux ip route output", () => {
    expect(parseLinuxGateway("default via 192.168.50.1 dev eth0 proto dhcp src 192.168.50.42 metric 100\n")).toBe(
      "192.168.50.1",
    );
    expect(parseLinuxGateway("192.168.1.0/24 dev eth0 scope link\n")).toBeUndefined();
  });

  test("sysfs power supplies", () => {
    expect(parseSysfsPower(["1"])).toBe(true);
    expect(parseSysfsPower(["0", "1"])).toBe(true);
    expect(parseSysfsPower(["0"])).toBe(false);
    expect(parseSysfsPower([])).toBeUndefined();
  });
});

describe("guardVerdict", () => {
  const settings = { powerGuard: true, homeGateway: "192.168.50.1" };

  test("mains on the home gateway passes", () => {
    expect(guardVerdict({ acPower: true, gateway: "192.168.50.1" }, settings)).toEqual({ ok: true });
  });

  test("battery stops the run", () => {
    expect(guardVerdict({ acPower: false, gateway: "192.168.50.1" }, settings).reason).toBe("on battery power");
    expect(guardVerdict({ acPower: false, gateway: "192.168.50.1" }, { powerGuard: false }).ok).toBe(true);
  });

  test("another network stops the run, unknown gateway included", () => {
    expect(guardVerdict({ acPower: true, gateway: "10.0.0.1" }, settings).reason).toContain("not on home network");
    expect(guardVerdict({ acPower: true }, settings).reason).toContain("gateway=none");
  });

  test("no configured gateway means no network check", () => {
    expect(guardVerdict({ acPower: true, gateway: "10.0.0.1" }, { powerGuard: true }).ok).toBe(true);
  });

  test("a desktop with no power supply passes", () => {
    expect(guardVerdict({ gateway: "192.168.50.1" }, settings).ok).toBe(true);
  });
});
