/**
 * Scrollable text component for pi TUI.
 *
 * Renders a block of pre-styled text lines with vertical scrolling: arrow keys, page keys, home
 * and end, plus the mouse wheel through `handleMouse`. Shows scroll indicators when content
 * overflows.
 *
 * No single-letter keys: a host embeds this under its own chord-based keymap, and a bare `j`/`k`
 * would take a key the host has a use for.
 *
 * Usage:
 *   const scroll = new ScrollableText(styledLines, maxHeight, theme);
 *   // In handleInput: if (scroll.handleInput(data)) { tui.requestRender(); }
 *   // In handleMouse: forward the wheel, with the event's y offset past your own chrome.
 *   // In render: scroll.render(width) returns string[]
 */

import {
  matchesKey,
  type TuiMouseEvent,
  type TuiMouseEventResult,
  truncateToWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

export interface ScrollableTextTheme {
  scrollHint: (text: string) => string;
  border: (text: string) => string;
}

export class ScrollableText {
  private lines: string[];
  private maxHeight: number;
  private theme: ScrollableTextTheme;
  private scrollOffset = 0;
  private cachedWidth?: number;
  private cachedOutput?: string[];
  /** Total visual lines from last render (after wrapping). */
  private lastWrappedTotal = 0;

  constructor(lines: string[], maxHeight: number, theme: ScrollableTextTheme) {
    this.lines = lines;
    this.maxHeight = maxHeight;
    this.theme = theme;
  }

  /**
   * Replace the content. The offset resets to the top unless `keepOffset` is set, which is what a
   * live-tailing pane wants: a re-read every second must not jump the reader somewhere else.
   */
  setLines(lines: string[], options?: { keepOffset?: boolean }) {
    this.lines = lines;
    if (!options?.keepOffset) this.scrollOffset = 0;
    this.invalidate();
  }

  /**
   * Scroll by `lines`, positive downwards, clamped to the content. Returns whether the offset moved,
   * so a caller can tell a scroll from a no-op at either end.
   */
  scrollBy(lines: number): boolean {
    const total = this.lastWrappedTotal || this.lines.length;
    const maxOffset = this.maxOffset(total);
    const next = Math.max(0, Math.min(maxOffset, this.scrollOffset + lines));
    if (next === this.scrollOffset) return false;
    this.scrollOffset = next;
    this.invalidate();
    return true;
  }

  /**
   * Park at the bottom. Wrapping decides the real maximum, so this overshoots and `render` clamps it;
   * that keeps "follow the tail" working before the first render of a new content set.
   */
  scrollToEnd(): void {
    this.scrollOffset = Number.MAX_SAFE_INTEGER;
    this.invalidate();
  }

  /**
   * Wheel support. `wheelDelta` is in logical lines and negative upwards (pi-tui's convention), so it
   * maps straight onto `scrollBy`. A wheel event is consumed even at an end: letting it fall through
   * would scroll the transcript behind the pane.
   */
  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.type !== "wheel" || !event.wheelDelta) return undefined;
    // `handled` even at an end (so the wheel never falls through to the transcript behind the pane),
    // and `render` reports whether anything moved, which is how a host tells a scroll from a no-op.
    return { handled: true, render: this.scrollBy(event.wheelDelta) };
  }

  /**
   * A host that recomputes its layout every render (a dialog splitting rows between panes) calls this
   * on each pass, so an unchanged height must not drop the wrap cache.
   */
  setMaxHeight(maxHeight: number) {
    if (this.maxHeight === maxHeight) return;
    this.maxHeight = maxHeight;
    this.invalidate();
  }

  setScrollOffset(offset: number) {
    this.scrollOffset = Math.max(0, offset);
    this.invalidate();
  }

  /**
   * The rows content may use. The scroll hint costs one, so it is only taken when the content keeps at
   * least a row: a one-row pane with overflowing content still renders one row, not two.
   */
  private viewport(needsScroll: boolean): number {
    return Math.max(1, needsScroll && this.maxHeight > 1 ? this.maxHeight - 1 : this.maxHeight);
  }

  /** The furthest the content can scroll, given what the viewport has to show. */
  private maxOffset(total: number): number {
    return Math.max(0, total - this.viewport(total > this.maxHeight));
  }

  /** Handle keyboard input. Returns true if the event was consumed (scroll happened). */
  handleInput(data: string): boolean {
    const total = this.lastWrappedTotal || this.lines.length;
    const maxOffset = this.maxOffset(total);
    const pageRows = this.viewport(total > this.maxHeight);

    if (matchesKey(data, "up")) {
      if (this.scrollOffset > 0) {
        this.scrollOffset--;
        this.invalidate();
        return true;
      }
      return false;
    }
    if (matchesKey(data, "down")) {
      if (this.scrollOffset < maxOffset) {
        this.scrollOffset++;
        this.invalidate();
        return true;
      }
      return false;
    }
    if (matchesKey(data, "pageUp") || matchesKey(data, "shift+up")) {
      if (this.scrollOffset > 0) {
        this.scrollOffset = Math.max(0, this.scrollOffset - pageRows);
        this.invalidate();
        return true;
      }
      return false;
    }
    if (matchesKey(data, "pageDown") || matchesKey(data, "shift+down")) {
      if (this.scrollOffset < maxOffset) {
        this.scrollOffset = Math.min(maxOffset, this.scrollOffset + pageRows);
        this.invalidate();
        return true;
      }
      return false;
    }
    if (matchesKey(data, "home") || matchesKey(data, "shift+left")) {
      if (this.scrollOffset > 0) {
        this.scrollOffset = 0;
        this.invalidate();
        return true;
      }
      return false;
    }
    if (matchesKey(data, "end") || matchesKey(data, "shift+right")) {
      if (this.scrollOffset < maxOffset) {
        this.scrollOffset = maxOffset;
        this.invalidate();
        return true;
      }
      return false;
    }
    return false;
  }

  render(width: number): string[] {
    if (this.cachedOutput && this.cachedWidth === width) {
      return this.cachedOutput;
    }

    // Wrap each source line to produce visual lines, tracking which visual
    // lines belong to which source line so scroll offsets stay meaningful.
    const wrappedLines: string[] = [];
    for (const line of this.lines) {
      const wrapped = wrapTextWithAnsi(line, width);
      if (wrapped.length === 0) {
        wrappedLines.push("");
      } else {
        for (const wl of wrapped) wrappedLines.push(wl);
      }
    }

    const totalLines = wrappedLines.length;
    const needsScroll = totalLines > this.maxHeight;
    const showHint = needsScroll && this.maxHeight > 1;
    const viewportHeight = this.viewport(needsScroll);

    // Clamp scroll offset
    const maxOffset = Math.max(0, totalLines - viewportHeight);
    if (this.scrollOffset > maxOffset) this.scrollOffset = maxOffset;

    const visibleLines = wrappedLines.slice(this.scrollOffset, this.scrollOffset + viewportHeight);
    const output = visibleLines.map((line) => truncateToWidth(line, width));

    if (showHint) {
      const above = this.scrollOffset;
      const below = totalLines - this.scrollOffset - viewportHeight;
      const parts: string[] = [];
      if (above > 0) parts.push(`${above} above`);
      if (below > 0) parts.push(`${below} below`);
      output.push(truncateToWidth(this.theme.scrollHint(`[${parts.join(", ")}]`), width));
    }

    this.lastWrappedTotal = totalLines;
    this.cachedWidth = width;
    this.cachedOutput = output;
    return output;
  }

  invalidate() {
    this.cachedWidth = undefined;
    this.cachedOutput = undefined;
  }

  /** Whether content overflows the viewport (based on last render's wrapping). */
  get scrollable(): boolean {
    const total = this.lastWrappedTotal || this.lines.length;
    return total > this.maxHeight;
  }

  get totalLines(): number {
    return this.lines.length;
  }
}
