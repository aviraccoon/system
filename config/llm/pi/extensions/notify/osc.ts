/**
 * Terminal notification frames.
 *
 * OSC 777 (`notify;title;body`) is the frame Ghostty, WezTerm, foot and rxvt
 * render. iTerm2 implements only OSC 9 (`message`), so the title is folded into
 * the message there. kitty's OSC 99 is deliberately unsupported: it nests
 * key=value metadata around the payload, and a malformed frame is worse than no
 * notification. Terminal.app and Alacritty have no notification protocol.
 *
 * Inside tmux the frame has to travel in tmux's DCS passthrough with each inner
 * ESC doubled, and tmux needs `set -g allow-passthrough on`; otherwise tmux
 * swallows the OSC and nothing appears.
 *
 * tmux also rewrites `TERM_PROGRAM` to `tmux` inside a pane, so the pane cannot
 * name its terminal. The outer value survives in the tmux server's environment
 * (read once at load), and when even that is unavailable the frame falls back to
 * OSC 777: the terminals that take it ignore it elsewhere, and the one terminal
 * that would need OSC 9 (iTerm2) gets nothing either way.
 */

export type NotifyProtocol = "osc777" | "osc9";

/** The environment variables the protocol and passthrough decisions read. */
export type TerminalEnvironment = Readonly<Record<string, string | undefined>>;

function protocolForProgram(program: string): NotifyProtocol | null {
  if (program === "iTerm.app") return "osc9";
  if (program === "ghostty" || program === "WezTerm") return "osc777";
  return null;
}

/**
 * A forced protocol, for a terminal the environment cannot describe: an ssh
 * session forwards neither `TERM_PROGRAM` nor `TMUX`. `undefined` means nothing
 * was forced, so detection runs; an unrecognized value is treated the same way.
 */
export function forcedProtocol(value: string | undefined): NotifyProtocol | null | undefined {
  switch (value?.trim().toLowerCase()) {
    case "777":
    case "osc777":
      return "osc777";
    case "9":
    case "osc9":
      return "osc9";
    case "off":
    case "none":
      return null;
    default:
      return undefined;
  }
}

/**
 * The protocol this terminal renders, or null when it renders none.
 *
 * `outerProgram` is the tmux server's `TERM_PROGRAM`, passed only when running
 * inside tmux.
 */
export function notifyProtocol(env: TerminalEnvironment, outerProgram?: string | null): NotifyProtocol | null {
  const forced = forcedProtocol(env.PI_NOTIFY_PROTOCOL);
  if (forced !== undefined) return forced;
  const program = env.TERM_PROGRAM ?? "";
  if (program !== "tmux") {
    const known = protocolForProgram(program);
    if (known) return known;
    const term = env.TERM ?? "";
    if (term.startsWith("rxvt") || term.startsWith("foot")) return "osc777";
  }
  if (!env.TMUX) return null;
  return protocolForProgram(outerProgram ?? "") ?? "osc777";
}

/** `tmux show-environment -g TERM_PROGRAM` output, or null when it is absent. */
export function parseTmuxProgram(output: string): string | null {
  const match = /^TERM_PROGRAM=(.+)$/m.exec(output);
  const value = match?.[1]?.trim();
  return value ? value : null;
}

/**
 * Make text safe inside a frame: control characters would end the sequence
 * early, and `;` is the OSC 777 field separator. C0, DEL and the C1 block are
 * all dropped, since a terminal that decodes C1 would see ST or CSI in the
 * middle of the string.
 */
export function sanitizeNotificationText(text: string): string {
  let out = "";
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) out += " ";
    else if (char === ";") out += ":";
    else out += char;
  }
  return out.trim();
}

export function oscSequence(protocol: NotifyProtocol, title: string, body: string): string {
  const cleanTitle = sanitizeNotificationText(title);
  const cleanBody = sanitizeNotificationText(body);
  if (protocol === "osc9") return `\x1b]9;${cleanBody ? `${cleanTitle}: ${cleanBody}` : cleanTitle}\x07`;
  return `\x1b]777;notify;${cleanTitle};${cleanBody}\x07`;
}

/** Why nothing was written, for the one caller that reports it to the user. */
export function noFrameReason(forcedValue: string | undefined): string {
  return forcedProtocol(forcedValue) === null
    ? "no terminal frame: PI_NOTIFY_PROTOCOL is off"
    : "no terminal frame: this terminal has no notification protocol";
}

export function wrapForTmux(sequence: string): string {
  return `\x1bPtmux;${sequence.replaceAll("\x1b", "\x1b\x1b")}\x1b\\`;
}

/** Bytes to write for one notification, or null when the terminal takes none. */
export function notificationBytes(
  env: TerminalEnvironment,
  title: string,
  body: string,
  outerProgram?: string | null,
): string | null {
  const protocol = notifyProtocol(env, outerProgram);
  if (!protocol) return null;
  const sequence = oscSequence(protocol, title, body);
  return env.TMUX ? wrapForTmux(sequence) : sequence;
}
