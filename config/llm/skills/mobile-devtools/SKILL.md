---
name: mobile-devtools
description: Observe and act on iOS simulators, Android emulators/devices, and physical iPhones from the command line - screen outlines with @N refs, taps, and screenshots. Use when verifying or debugging app behavior on a simulator, emulator, or phone; tapping through a flow; capturing device screenshots as evidence; or reporting a UI bug found on a device.
---

# Mobile Devtools

`<skill-dir>/scripts/mobile.ts` (bun) is one CLI for all three targets:

| Target | Verbs |
|---|---|
| iOS simulator | `ui`, `tap`, `type`, `swipe`, `shot`, `logs` |
| Android emulator/device | `ui`, `tap`, `type`, `swipe`, `shot`, `logs` |
| physical iPhone | `shot` only |

A phone can be looked at but not touched: `ui` and `tap` exit immediately with the hint `physical iPhones only support mobile shot`; real-device interaction needs an XCUITest or WebDriverAgent harness. The Android outline includes WebView content, so the element list is trustworthy on web screens too; clickable web elements can still surface as plain `TextView`s (trust the coordinates, not the class), and `android layout` fails transiently right after a screen change (the CLI retries once).

## The loop

```bash
# <skill-dir> is this skill's directory (where this SKILL.md lives)
M=<skill-dir>/scripts/mobile.ts

bun $M ui                 # observe: outline with @N refs
bun $M tap @7             # act on a ref from that outline
bun $M ui                 # observe again; refs are only valid for the last capture
```

Never guess coordinates from a screenshot when the element is in the outline — use its ref. Verify with a screenshot (`bun $M shot`) when the visual result matters, and quote the file path as evidence. An empty outline prints its own "look at a screenshot" hint.

A sheet and the screen behind it both appear in the outline, so the same area can hold two elements; the field that receives typing is marked `[focused]`, and `bun $M type "Text"` with no target goes to it.

## Commands

```bash
bun $M devices [--json]                            # simulators, Android serials, phones
bun $M ui [--device D] [--json]                    # outline; --json for structured elements
bun $M tap @7 | 201,750 | --label "Tasks"          # ref, point, or unique label
bun $M type "Text" [--ref @7] [--device D]         # type; no target = the focused field
bun $M swipe 200,600 200,200 [--duration 0.3]      # swipe or drag between two points
bun $M logs [--grep TEXT] [--device D]             # recent app log lines
bun $M shot [--out FILE] [--device D]              # PNG path (works on a phone too)
bun $M sim start --project PATH [--device NAME]    # open the project + start a session
bun $M sim end                                     # close the session
```

`--device` takes a simulator name or UDID, an adb serial, or a `devicectl` device name; without it the CLI picks the first booted simulator, then Android, then a phone. `--label` matches case-insensitively as a substring and must be unique (an ambiguous match lists the candidates).

## Before the first call

Build and install with the project's own tooling (`mise` tasks, `xcodebuild` + `xcrun simctl`, `gradlew` + `adb`, or the Capacitor CLI). This CLI never builds, and every foreground call is capped at ~10 s — run long builds outside `$M`.

`bun $M sim start` is needed once per session per project; `ui`/`tap`/`shot` auto-start it when a project is on record in `state.json`. An iOS simulator session also needs the project open in Xcode's MCP service and an approved agent. If a call answers `isn't approved to use Xcode's tools yet` or `Xcode did not answer`, run `xcrun mcp-server open <path-to-App.xcodeproj>`, approve the prompt in Xcode (Settings → Intelligence → External Agent Access), and retry.

Call `bun $M sim end` when the task is done. Ending a session releases the simulator's screen; the next `ui`/`tap`/`shot` starts a new one, since the project stays on record.

## State and debugging

Everything lives in `$XDG_CACHE_HOME/mobile` (`~/.cache/mobile`) and is safe to inspect or delete:

- `state.json` — remembered project, session key, last device
- `mcp-reply.jsonl` — raw reply of the last MCP call; check it when a call answers unexpectedly

## Reporting

State what you did, what the screen showed before and after, and cite the screenshot paths. Distinguish functional bugs (element does not respond, wrong screen, crash) from visual ones (overlap, clipping, wrong colours) and from expected transients (spinners, animations, permission dialogs). If an element is missing from the outline, screenshot it before concluding it is absent from the UI.