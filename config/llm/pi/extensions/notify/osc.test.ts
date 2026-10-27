import { describe, expect, test } from "bun:test";
import {
  forcedProtocol,
  type NotifyProtocol,
  noFrameReason,
  notificationBytes,
  notifyProtocol,
  oscSequence,
  parseTmuxProgram,
  sanitizeNotificationText,
  wrapForTmux,
} from "./osc";

describe("notifyProtocol", () => {
  const cases: Array<[string, Record<string, string | undefined>, NotifyProtocol | null]> = [
    ["Ghostty", { TERM_PROGRAM: "ghostty" }, "osc777"],
    ["WezTerm", { TERM_PROGRAM: "WezTerm" }, "osc777"],
    ["iTerm2", { TERM_PROGRAM: "iTerm.app" }, "osc9"],
    ["rxvt-unicode", { TERM: "rxvt-unicode-256color" }, "osc777"],
    ["foot", { TERM: "foot" }, "osc777"],
    ["Terminal.app", { TERM_PROGRAM: "Apple_Terminal" }, null],
    ["Alacritty", { TERM_PROGRAM: "Alacritty" }, null],
    ["kitty (OSC 99 unsupported)", { TERM: "xterm-kitty", KITTY_WINDOW_ID: "1" }, null],
    ["empty", {}, null],
    ["tmux pane names no terminal", { TERM_PROGRAM: "tmux", TERM: "screen-256color" }, null],
    ["tmux pane, outer terminal unknown", { TERM_PROGRAM: "tmux", TMUX: "/tmp/tmux,1,0" }, "osc777"],
  ];

  for (const [name, env, expected] of cases) {
    test(name, () => {
      expect(notifyProtocol(env)).toBe(expected);
    });
  }
});

describe("notifyProtocol inside tmux", () => {
  const pane = { TERM_PROGRAM: "tmux", TERM: "screen-256color", TMUX: "/tmp/tmux,1,0" };

  test("the tmux server's environment names the outer terminal", () => {
    expect(notifyProtocol(pane, "ghostty")).toBe("osc777");
    expect(notifyProtocol(pane, "iTerm.app")).toBe("osc9");
  });

  test("an unknown outer terminal still gets the common frame", () => {
    expect(notifyProtocol(pane, "Apple_Terminal")).toBe("osc777");
    expect(notifyProtocol(pane, null)).toBe("osc777");
  });

  test("a known terminal outside tmux ignores the outer value", () => {
    expect(notifyProtocol({ TERM_PROGRAM: "ghostty" }, "iTerm.app")).toBe("osc777");
  });
});

describe("forcedProtocol", () => {
  const cases: Array<[string | undefined, NotifyProtocol | null | undefined]> = [
    [undefined, undefined],
    ["", undefined],
    ["777", "osc777"],
    ["OSC777", "osc777"],
    ["9", "osc9"],
    [" osc9 ", "osc9"],
    ["off", null],
    ["nonsense", undefined],
  ];

  for (const [value, expected] of cases) {
    test(`${JSON.stringify(value)}`, () => {
      expect(forcedProtocol(value)).toBe(expected);
    });
  }
});

describe("notifyProtocol with a forced protocol", () => {
  test("an ssh session with nothing to detect still gets a frame", () => {
    expect(notifyProtocol({ TERM: "xterm-256color", PI_NOTIFY_PROTOCOL: "777" })).toBe("osc777");
  });

  test("the force wins over detection", () => {
    expect(notifyProtocol({ TERM_PROGRAM: "ghostty", PI_NOTIFY_PROTOCOL: "9" })).toBe("osc9");
  });

  test("off suppresses the frame", () => {
    expect(notifyProtocol({ TERM_PROGRAM: "ghostty", PI_NOTIFY_PROTOCOL: "off" })).toBeNull();
  });

  test("a forced protocol decides the frame inside tmux, not only the wrapper", () => {
    // Detection inside tmux falls back to OSC 777, so an OSC 9 frame can only
    // come from the forced value.
    const bytes = notificationBytes({ TERM_PROGRAM: "tmux", TMUX: "/tmp/tmux,1,0", PI_NOTIFY_PROTOCOL: "9" }, "t", "b");
    expect(bytes).toBe("\u001bPtmux;\u001b\u001b]9;t: b\u0007\u001b\\");
  });
});

describe("noFrameReason", () => {
  test("a forced-off protocol is named", () => {
    expect(noFrameReason("off")).toBe("no terminal frame: PI_NOTIFY_PROTOCOL is off");
    expect(noFrameReason("none")).toBe("no terminal frame: PI_NOTIFY_PROTOCOL is off");
  });

  test("otherwise the terminal is blamed", () => {
    expect(noFrameReason(undefined)).toBe("no terminal frame: this terminal has no notification protocol");
    expect(noFrameReason("nonsense")).toBe("no terminal frame: this terminal has no notification protocol");
  });
});

describe("parseTmuxProgram", () => {
  test("reads the value", () => {
    expect(parseTmuxProgram("TERM_PROGRAM=ghostty\n")).toBe("ghostty");
  });

  test("a missing variable and an unset entry name nothing", () => {
    expect(parseTmuxProgram("SHELL=/bin/zsh\n")).toBeNull();
    expect(parseTmuxProgram("-TERM_PROGRAM\n")).toBeNull();
  });
});

describe("sanitizeNotificationText", () => {
  test("control characters become spaces so the frame cannot end early", () => {
    expect(sanitizeNotificationText("a\u001b]777;notify;x;y\u0007b")).toBe("a ]777:notify:x:y b");
  });

  test("the C1 block, including ST and CSI, becomes spaces", () => {
    expect(sanitizeNotificationText("a\u009cb\u009bc\u009dd")).toBe("a b c d");
  });

  test("newlines and tabs collapse to spaces", () => {
    expect(sanitizeNotificationText("one\ntwo\tthree")).toBe("one two three");
  });

  test("the field separator is inert", () => {
    expect(sanitizeNotificationText("bash: a;b")).toBe("bash: a:b");
  });
});

describe("oscSequence", () => {
  test("OSC 777 carries title and body as separate fields", () => {
    expect(oscSequence("osc777", "pi done", "acme, 3 tools")).toBe("\u001b]777;notify;pi done;acme, 3 tools\u0007");
  });

  test("OSC 9 folds the title into the single message field", () => {
    expect(oscSequence("osc9", "pi done", "acme")).toBe("\u001b]9;pi done: acme\u0007");
  });

  test("an empty body leaves the title alone", () => {
    expect(oscSequence("osc9", "pi done", "")).toBe("\u001b]9;pi done\u0007");
  });
});

describe("wrapForTmux", () => {
  test("wraps the frame in DCS passthrough with every inner ESC doubled", () => {
    const frame = oscSequence("osc777", "t", "b");
    expect(wrapForTmux(frame)).toBe(`\u001bPtmux;\u001b\u001b]777;notify;t;b\u0007\u001b\\`);
  });
});

describe("notificationBytes", () => {
  test("no frame for a terminal without a notification protocol", () => {
    expect(notificationBytes({ TERM_PROGRAM: "Apple_Terminal" }, "t", "b")).toBeNull();
  });

  test("tmux presence selects passthrough", () => {
    const bytes = notificationBytes({ TERM_PROGRAM: "ghostty", TMUX: "/tmp/tmux-501/default,1,0" }, "t", "b");
    expect(bytes?.startsWith("\u001bPtmux;")).toBe(true);
  });

  test("without tmux the frame is written raw", () => {
    expect(notificationBytes({ TERM_PROGRAM: "ghostty" }, "t", "b")).toBe("\u001b]777;notify;t;b\u0007");
  });
});
