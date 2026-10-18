/**
 * /or-pin — pin OpenRouter's upstream provider for the rest of the session.
 *
 * OpenRouter picks among the endpoints serving a model; the pick decides price,
 * latency and throughput. `compat.openRouterRouting` in models.json is the
 * static, machine-wide lever, so this covers the session-scoped one: the pin
 * rides the request payload, merged into the routing object pi built from that
 * config (see `applyPin` for why it must merge).
 *
 * `/or-pin` opens a picker; a slug typed after the command pins directly, for
 * when the name is already known.
 *
 * The pin lives in memory — one process, one session. A child pi spawned by the
 * subagent extension starts unpinned. `/reload` clears it.
 */

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { Container, SelectList, Spacer, Text } from "@earendil-works/pi-tui";
import { fetchModelEndpoints, fetchZdrCatalog, type OrCatalogLog } from "../shared/or-catalog";
import {
  applyPin,
  buildPinRows,
  formatPinRow,
  isOpenRouterModel,
  modelPageUrl,
  type Pin,
  type PinRow,
  parsePinCommand,
  pinSummary,
  zdrAsserted,
  zdrVerdict,
} from "./pin";

const STATUS_KEY = "or-pin";
const REFRESH_CHOICE = "— refresh from OpenRouter —";
const CLEAR_CHOICE = "— clear pin —";
const ZDR_SETTINGS_URL = "https://openrouter.ai/settings/privacy";

export default function orPin(pi: ExtensionAPI): void {
  let pin: Pin | undefined;
  let lastWarning: string | undefined;

  // The fetchers report through this seam instead of stderr: mid-TUI writes
  // would corrupt the display, so a warning is held for the next notify.
  const log: OrCatalogLog = {
    info: () => {},
    warn: (message) => {
      // The fetchers word their warnings for stderr ("Warning: …"); a toast carries
      // the severity itself.
      lastWarning = message.replace(/^Warning: /, "");
    },
  };

  pi.on("before_provider_request", (event, ctx) => {
    if (!pin || !isOpenRouterModel(ctx.model)) return;
    return applyPin(event.payload, pin);
  });

  pi.on("session_start", (_event, ctx) => {
    setStatus(ctx);
  });

  // A provider-side 404 arrives as an error assistant message: pi-ai throws on a
  // non-2xx before `after_provider_response` is emitted, so that event cannot see
  // it. The data-policy rejection is the one this pin can cause.
  pi.on("message_end", (event, ctx) => {
    if (!pin) return;
    const message = event.message as { role?: string; errorMessage?: string };
    if (
      message.role !== "assistant" ||
      !message.errorMessage?.includes("No endpoints found matching your data policy")
    ) {
      return;
    }
    notifyPolicyRefusal(ctx);
  });

  /** OpenRouter's own wording for the data-policy rejection, and the one rejection
   * this extension can observe: the pin can cause it, and the machine-wide `zdr`
   * assertion can cause it with no pin at all — so the notice names the pin, not
   * the cause. */
  function notifyPolicyRefusal(ctx: ExtensionContext): void {
    if (!pin) return;
    ctx.ui.notify(
      `or-pin: OpenRouter refused the request's data policy while pinned to ${pin.providers.join(", ")} — the pinned provider has no endpoint matching it; /or-pin off clears the pin`,
      "warning",
    );
  }

  function setStatus(ctx: ExtensionContext): void {
    ctx.ui.setStatus(STATUS_KEY, pin ? ctx.ui.theme.fg("warning", `or-pin ${pin.providers.join(",")}`) : undefined);
  }

  function clearPin(ctx: ExtensionContext): void {
    pin = undefined;
    pi.appendEntry("or-pin", { providers: null });
    setStatus(ctx);
    ctx.ui.notify("or-pin: cleared");
  }

  /** `note` rides the same notification: a pin that could not be checked should
   * not produce a second toast claiming it was applied. */
  function apply(ctx: ExtensionCommandContext, next: Pin, note?: string): void {
    pin = next;
    pi.appendEntry("or-pin", { providers: next.providers });
    setStatus(ctx);
    const summary = `or-pin: ${pinSummary(next)}`;
    if (note) ctx.ui.notify(`${summary} — ${note}`, "warning");
    else ctx.ui.notify(summary);
  }

  type EndpointRows = { ok: true; rows: PinRow[] } | { ok: false; reason: string };

  /** The provider's credential, when pi can resolve one. Only the ZDR catalog
   * needs it (`/models/<id>/endpoints` is public); without it a refresh still
   * refreshes the endpoint rows and leaves ZDR eligibility unknown. */
  async function providerKey(ctx: ExtensionCommandContext): Promise<string | undefined> {
    const provider = ctx.model?.provider;
    if (!provider) return undefined;
    try {
      return await ctx.modelRegistry.getApiKeyForProvider(provider);
    } catch {
      return undefined;
    }
  }

  /** Rows for the current model's endpoints. Never notifies: each caller decides
   * what a failure means for the command it serves. `lastWarning` carries the
   * fetcher's degradation note out. `fresh` bypasses both cache reads. */
  async function loadRows(ctx: ExtensionCommandContext, fresh = false): Promise<EndpointRows> {
    const model = ctx.model;
    if (!model) return { ok: false, reason: "no model selected" };
    lastWarning = undefined;
    try {
      const key = await providerKey(ctx);
      const [endpoints, zdr] = await Promise.all([
        fetchModelEndpoints(model.id, { key, log, fresh }),
        fetchZdrCatalog({ key, log, fresh }),
      ]);
      return { ok: true, rows: buildPinRows(endpoints.eps, zdr) };
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
  }

  /** Refuse a pin naming a provider OpenRouter does not serve for this model:
   * `only` with an unknown slug leaves the request with no endpoint at all, and
   * the failure would surface on the next turn instead of here. An unreadable
   * endpoint list is not evidence against the slug, so the pin still applies. */
  async function setPin(ctx: ExtensionCommandContext, next: Pin): Promise<void> {
    const loaded = await loadRows(ctx);
    if (!loaded.ok) {
      apply(ctx, next, `slugs unchecked (${loaded.reason})`);
      return;
    }
    const rows = loaded.rows;
    const known = new Set(rows.map((row) => row.slug));
    const missing = next.providers.filter((slug) => !known.has(slug));
    if (missing.length > 0) {
      const verb = missing.length > 1 ? "are not endpoints" : "is not an endpoint";
      const current = pin ? ` (${pinSummary(pin)})` : "";
      ctx.ui.notify(
        `or-pin: ${missing.join(", ")} ${verb} for ${ctx.model?.id ?? "this model"} — pin unchanged${current}; /or-pin opens the picker`,
        "warning",
      );
      return;
    }

    // A request that asserts ZDR cannot use a provider without a ZDR endpoint:
    // OpenRouter filters on the policy first, so `only` would select from nothing.
    if (zdrAsserted(ctx.model)) {
      const { ineligible, unknown } = zdrVerdict(rows, next.providers);
      if (ineligible.length > 0) {
        const verb = ineligible.length > 1 ? "have" : "has";
        ctx.ui.notify(
          `or-pin: ${ineligible.join(", ")} ${verb} no ZDR endpoint for ${ctx.model?.id ?? "this model"} and the request asserts zdr — every request would fail with 404; policy: ${ZDR_SETTINGS_URL}`,
          "warning",
        );
        return;
      }
      if (unknown.length > 0) {
        apply(ctx, next, `ZDR eligibility unknown (${lastWarning ?? "ZDR data unavailable"})`);
        return;
      }
    }
    apply(ctx, next);
  }

  async function openPicker(ctx: ExtensionCommandContext): Promise<void> {
    let loaded = await loadRows(ctx);
    if (!loaded.ok) {
      ctx.ui.notify(`or-pin: ${loaded.reason}`, "error");
      return;
    }

    // Loops so a refresh can redraw the same list in place; a pick or Esc ends it.
    for (;;) {
      const rows = loaded.rows;
      if (rows.length === 0) {
        const note = lastWarning ? ` (${lastWarning})` : "";
        ctx.ui.notify(`or-pin: no endpoints listed for ${ctx.model?.id ?? "the current model"}${note}`, "warning");
        return;
      }

      const choices = [
        ...rows.map((row) => ({
          label: formatPinRow(row, pin?.providers.includes(row.slug) ?? false),
          choose: () => void setPin(ctx, { providers: [row.slug] }),
        })),
        { label: REFRESH_CHOICE, choose: () => {} },
        ...(pin ? [{ label: CLEAR_CHOICE, choose: () => clearPin(ctx) }] : []),
      ];

      // No picker outside the TUI: RPC's `custom` resolves immediately with "Custom UI
      // not supported in RPC mode", so asking for one there would end the command mutely.
      if (ctx.mode !== "tui") {
        // The action rows are interactive affordances, so only provider rows print,
        // plus the command that clears a pin.
        const note = lastWarning ? `or-pin: ${lastWarning}\n` : "";
        const printable = choices.filter((choice) => choice.label !== REFRESH_CHOICE && choice.label !== CLEAR_CHOICE);
        const hint = pin ? "\n/or-pin off clears the pin" : "";
        const text = `${note}${printable.map((choice) => choice.label).join("\n")}${hint}`;
        // RPC has a real notification channel. Print and json modes do not — their
        // `ui.notify` is a no-op — so write to stderr, which keeps json's stdout clean.
        if (ctx.mode === "rpc") ctx.ui.notify(text);
        else process.stderr.write(`${text}\n`);
        return;
      }
      if (lastWarning) ctx.ui.notify(`or-pin: ${lastWarning}`, "warning");
      const page = modelPageUrl(ctx.model?.id);
      const title = `${pin ? `Pin OpenRouter provider (${pinSummary(pin)})` : "Pin OpenRouter provider"}${page ? ` — ${page}` : ""}`;

      // SelectList rather than ctx.ui.select: the dialog's nav clamps at the ends,
      // and with a provider per endpoint the two action rows sit past the fold.
      const labels = choices.map((choice) => choice.label);
      const chosen = await ctx.ui.custom<string | undefined>((tui, theme, _keybindings, done) => {
        const container = new Container();
        container.addChild(new DynamicBorder());
        container.addChild(new Spacer(1));
        container.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));
        container.addChild(new Spacer(1));
        const list = new SelectList(
          labels.map((label) => ({ value: label, label })),
          Math.min(labels.length, 12),
          {
            selectedPrefix: (t) => theme.fg("accent", t),
            selectedText: (t) => theme.fg("accent", t),
            description: (t) => theme.fg("muted", t),
            scrollInfo: (t) => theme.fg("dim", t),
            noMatch: (t) => theme.fg("warning", t),
          },
        );
        list.onSelect = (item) => done(item.value);
        list.onCancel = () => done(undefined);
        container.addChild(list);
        container.addChild(new Spacer(1));
        container.addChild(new Text(theme.fg("dim", "↑↓ wrap  enter select  esc cancel"), 1, 0));
        container.addChild(new Spacer(1));
        container.addChild(new DynamicBorder());
        // A bare Container renders but never receives keys: input reaches only the
        // component the factory returns, so route it to the list. `handleMouse` is
        // deliberately not forwarded — the list sits below a border and spacers, so
        // a raw forward would click the wrong row. See AGENTS.md, "UI methods".
        return {
          render: (width: number) => container.render(width),
          invalidate: () => container.invalidate(),
          handleInput: (data: string) => {
            list.handleInput(data);
            tui.requestRender();
          },
        };
      });
      if (chosen === undefined) return;
      if (chosen !== REFRESH_CHOICE) {
        choices.find((choice) => choice.label === chosen)?.choose();
        return;
      }

      loaded = await loadRows(ctx, true);
      if (!loaded.ok) {
        ctx.ui.notify(`or-pin: refresh failed — ${loaded.reason}`, "error");
        return;
      }
      // A refresh can still come back without ZDR data (no credential, or a failed
      // fetch), which is the one thing the row marks depend on. The fetcher's reason
      // rides this message, and consuming the warning here keeps it from firing again
      // at the top of the next iteration.
      const zdrKnown = loaded.rows.some((row) => row.zdr !== undefined);
      if (zdrKnown) ctx.ui.notify("or-pin: refreshed");
      else ctx.ui.notify(`or-pin: endpoints refreshed — ${lastWarning ?? "ZDR data unavailable"}`, "warning");
      lastWarning = undefined;
    }
  }

  pi.registerCommand("or-pin", {
    description: "Pin OpenRouter's upstream provider for this session",
    handler: async (args, ctx) => {
      const command = parsePinCommand(args);
      switch (command.kind) {
        case "pick":
          await openPicker(ctx);
          return;
        case "invalid":
          ctx.ui.notify(`or-pin: ${command.reason}`, "warning");
          return;
        case "clear":
          clearPin(ctx);
          return;
        case "set":
          await setPin(ctx, command.pin);
          return;
      }
    },
  });
}
