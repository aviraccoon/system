/**
 * /sidecar-models command — pick models for sidecar roles (explain, draft, etc.)
 *
 * Two-screen TUI modeled after /scoped-models:
 * 1. Role list showing current primary model
 * 2. Model picker with toggle/reorder/search, matching scoped-models keybindings
 *
 * Keybindings (role list):
 *   Enter: select role → model picker
 *   Ctrl+R: reset all roles to defaults
 *   Ctrl+D: sync all roles to the main model
 *   Ctrl+C / Esc: cancel
 *
 * Keybindings (model picker):
 *   Enter: toggle model in/out of chain (added at end if new)
 *   Ctrl+T: cycle thinking level of the selected chain model
 *   Alt+↑↓: reorder within chain
 *   Ctrl+A: add all (or all filtered) to chain
 *   Ctrl+X: remove all (or all filtered) from chain
 *   Ctrl+P: toggle by provider
 *   Ctrl+S: save to roles.local.json
 *   Ctrl+R: reset role to defaults
 *   Ctrl+C / Esc: back to role list (or clear search)
 */

import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir, type ModelRegistry } from "@earendil-works/pi-coding-agent";
import { fuzzyFilter, getKeybindings, Input, Key, matchesKey, Text } from "@earendil-works/pi-tui";
import type { ModelEntry } from "../shared/model-roles";
import {
  entryForAdd,
  entryThinking,
  hasEnableThinkingPin,
  isThinkingLevel,
  nextThinking,
  THINKING_LEVELS,
  type ThinkingLevel,
  withoutEnableThinkingPin,
} from "./thinking";

// ── Settings helpers ──

function readSettings(): Record<string, unknown> {
  const settingsPath = join(getAgentDir(), "settings.json");
  if (!existsSync(settingsPath)) return {};
  try {
    return JSON.parse(readFileSync(settingsPath, "utf-8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function getDefaultModel(): string | null {
  const settings = readSettings();
  const model = settings.defaultModel;
  if (typeof model !== "string") return null;
  return model;
}

// ── Types ──

interface RoleConfig {
  models: ModelEntry[];
  maxTokens?: number;
}

type RolesFile = Record<string, RoleConfig>;

interface ModelInfo {
  ref: string;
  name: string;
  provider: string;
  modelId: string;
}

// ── Config helpers ──

function localPath(): string {
  return join(getAgentDir(), "roles.local.json");
}

function defaultsPath(): string {
  return join(getAgentDir(), "roles.json");
}

function readJson(path: string): RolesFile {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as RolesFile;
  } catch {
    return {};
  }
}

function writeLocal(data: RolesFile): void {
  writeFileSync(localPath(), `${JSON.stringify(data, null, 2)}\n`, "utf-8");
}

function mergedRoles(): RolesFile {
  const defaults = readJson(defaultsPath());
  const local = readJson(localPath());
  return { ...defaults, ...local };
}

function getAvailableModels(registry: ModelRegistry): ModelInfo[] {
  return registry
    .getAvailable()
    .map((m) => ({ ref: `${m.provider}/${m.id}`, name: m.name ?? m.id, provider: m.provider, modelId: m.id }))
    .sort((a, b) => a.ref.localeCompare(b.ref));
}

/**
 * Thinking levels a model actually accepts, weakest first. pi-ai clamps anything
 * else, so offering an unsupported level would make the stored value disagree with
 * what runs. Falls back to every level when the model is not in the registry (a
 * provider refresh between picking and rendering), so the setting stays reachable.
 */
function supportedLevels(registry: ModelRegistry, item: ModelInfo): readonly ThinkingLevel[] {
  const model = registry.find(item.provider, item.modelId);
  if (!model) return THINKING_LEVELS;
  const levels = getSupportedThinkingLevels(model).filter(isThinkingLevel);
  return levels.length > 0 ? levels : THINKING_LEVELS;
}

// ── Chain helpers ──

function isInChain(chain: ModelEntry[], ref: string): boolean {
  return chain.some((m) => m.ref === ref);
}

// ── Footer status ──

function shortModelId(ref: string): string {
  return ref.includes("/") ? ref.split("/").slice(1).join("/") : ref;
}

function setSidecarStatus(ctx: ExtensionContext) {
  const roles = mergedRoles();
  const primaries: Array<{ role: string; model: string }> = [];
  for (const [name, config] of Object.entries(roles)) {
    const ref = config.models?.[0]?.ref;
    if (ref) primaries.push({ role: name, model: shortModelId(ref) });
  }

  if (primaries.length === 0) {
    ctx.ui.setStatus("sidecar", undefined);
    return;
  }

  // If all roles use the same primary, show "side:glm-5.1"
  const unique = [...new Set(primaries.map((p) => p.model))];
  const label =
    unique.length === 1 ? `side:${unique[0]}` : primaries.map((p) => `${p.role.slice(0, 2)}:${p.model}`).join(",");

  ctx.ui.setStatus("sidecar", ctx.ui.theme.fg("muted", label));
}

// ── Command ──

type Screen = "roles" | "models";

export default function sidecarCommand(pi: ExtensionAPI) {
  // Update footer status at session start
  pi.on("session_start", (_event, ctx) => {
    setSidecarStatus(ctx);
  });

  pi.registerCommand("sidecar-models", {
    description: "Configure sidecar model roles (explain, draft)",

    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("/sidecar-models requires interactive mode", "error");
        return;
      }

      const roleNames = Object.keys(mergedRoles());
      if (roleNames.length === 0) {
        ctx.ui.notify("No roles configured in roles.json", "warning");
        return;
      }

      await ctx.ui.custom((tui, theme, _kb, done) => {
        let screen: Screen = "roles";
        let selectedRole = roleNames[0];

        // ── Models screen state ──
        let chain: ModelEntry[] = [];
        // The role's configured entries, snapshotted when the role is opened, so a
        // removed model keeps its thinking level / params if it is added back.
        let configured = new Map<string, ModelEntry>();
        let allModels: ModelInfo[] = [];
        let filteredItems: Array<ModelInfo & { inChain: boolean; position: number }> = [];
        let selectedIndex = 0;
        let isDirty = false;
        const maxVisible = 15;

        // ── Components ──
        const headerText = new Text("", 0, 0);
        const searchInput = new Input();
        const footerText = new Text("", 0, 0);

        // ── Roles screen state ──
        let roleSelectedIndex = 0;
        const defaultModel = getDefaultModel();
        const hasDefaultModel = defaultModel !== null;

        // ── Header ──

        function updateHeader() {
          if (screen === "roles") {
            headerText.setText(theme.fg("accent", theme.bold("Sidecar Model Roles")));
          } else {
            const chainLen = chain.length;
            const hasLocal = existsSync(localPath()) && selectedRole in readJson(localPath());
            const localTag = hasLocal ? theme.fg("dim", " (custom)") : "";
            headerText.setText(
              `${theme.fg("accent", theme.bold(`Role: ${selectedRole}`))}${localTag}\n${theme.fg("dim", `${chainLen} model${chainLen !== 1 ? "s" : ""} in fallback chain`)}`,
            );
          }
        }

        // ── Footer ──

        function updateFooter() {
          if (screen === "roles") {
            const syncText = hasDefaultModel ? "  ·  ^D sync to main" : "";
            footerText.setText(theme.fg("dim", `  Enter select  ·  ^R reset all${syncText}  ·  Esc cancel`.trim()));
            return;
          }

          const chainCount = chain.length;
          const parts = [
            "Enter toggle",
            "^T think",
            "^A add all",
            "^X clear",
            "^P provider",
            "Alt+↑↓ reorder",
            "^R reset",
            `^S save`,
            `${chainCount} in chain`,
          ];
          const text = `  ${parts.join(" · ")}`;
          footerText.setText(
            isDirty ? theme.fg("dim", text) + theme.fg("warning", " (unsaved)") : theme.fg("dim", text),
          );
        }

        // ── Roles screen rendering ──

        function renderRoles(): string[] {
          const lines: string[] = [];
          const fresh = mergedRoles();
          for (let i = 0; i < roleNames.length; i++) {
            const name = roleNames[i];
            const role = fresh[name];
            const primary = role?.models?.[0]?.ref ?? "(none)";
            const isSelected = i === roleSelectedIndex;
            const prefix = isSelected ? theme.fg("accent", "→ ") : "  ";
            const nameText = isSelected ? theme.fg("accent", name) : name;
            const desc = theme.fg("muted", `  ${primary}`);
            lines.push(`${prefix}${nameText}${desc}`);
          }
          return lines;
        }

        // ── Models screen ──

        function buildFilteredItems() {
          const query = searchInput.getValue();
          const chainSet = new Set(chain.map((m) => m.ref));

          // Order: chain first (in order), then remaining available
          const ordered: ModelInfo[] = [];
          const seen = new Set<string>();

          // Chain models first
          for (const entry of chain) {
            const found = allModels.find((m) => m.ref === entry.ref);
            if (found) {
              ordered.push(found);
              seen.add(found.ref);
            }
          }

          // Remaining available models
          for (const m of allModels) {
            if (!seen.has(m.ref)) {
              ordered.push(m);
            }
          }

          const items = ordered.map((m) => ({
            ...m,
            inChain: chainSet.has(m.ref),
            position: chainSet.has(m.ref) ? chain.findIndex((c) => c.ref === m.ref) + 1 : 0,
          }));

          if (query) {
            filteredItems = fuzzyFilter(items, query, (i) => `${i.modelId} ${i.provider} ${i.name}`);
          } else {
            filteredItems = items;
          }

          selectedIndex = Math.min(selectedIndex, Math.max(0, filteredItems.length - 1));
        }

        function renderModels(): string[] {
          const lines: string[] = [];

          if (filteredItems.length === 0) {
            lines.push(theme.fg("muted", "  No matching models"));
            return lines;
          }

          const startIndex = Math.max(
            0,
            Math.min(selectedIndex - Math.floor(maxVisible / 2), filteredItems.length - maxVisible),
          );
          const endIndex = Math.min(startIndex + maxVisible, filteredItems.length);

          for (let i = startIndex; i < endIndex; i++) {
            const item = filteredItems[i];
            const isSelected = i === selectedIndex;
            const prefix = isSelected ? theme.fg("accent", "→ ") : "  ";
            const modelText = isSelected ? theme.fg("accent", item.modelId) : item.modelId;
            const providerBadge = theme.fg("muted", ` [${item.provider}]`);
            const status = item.inChain ? theme.fg("success", ` #${item.position} ✓`) : theme.fg("dim", " ✗");
            const thinking = item.inChain ? ` ${renderThinking(chainEntry(item.ref))}` : "";
            lines.push(`${prefix}${modelText}${providerBadge}${status}${thinking}`);
          }

          // Scroll indicator
          if (startIndex > 0 || endIndex < filteredItems.length) {
            lines.push(theme.fg("muted", `  (${selectedIndex + 1}/${filteredItems.length})`));
          }

          // Detail lines for the selected item
          if (filteredItems.length > 0) {
            const selected = filteredItems[selectedIndex];
            lines.push("");
            lines.push(theme.fg("muted", `  Model Name: ${selected.name}`));
            if (selected.inChain) {
              const entry = chainEntry(selected.ref);
              const supported = supportedLevels(ctx.modelRegistry, selected);
              lines.push(
                theme.fg("muted", "  Thinking: ") +
                  renderThinking(entry) +
                  theme.fg("dim", `  (^T cycles: ${supported.join(" › ")})`),
              );
              if (hasEnableThinkingPin(entry) && entryThinking(entry) !== "off") {
                lines.push(
                  theme.fg(
                    "warning",
                    "  ⚠ requestParams pins enable_thinking=false — this level would not take effect",
                  ),
                );
              }
            } else {
              lines.push(theme.fg("dim", "  Not in the chain — Enter adds it, then ^T sets thinking"));
            }
          }

          return lines;
        }

        // ── Chain mutations ──

        function chainEntry(ref: string): ModelEntry | undefined {
          return chain.find((m) => m.ref === ref);
        }

        /** Chain rows show the level; "off" stays dim so an all-off chain reads quietly. */
        function renderThinking(entry: ModelEntry | undefined): string {
          const level = entryThinking(entry);
          return level === "off" ? theme.fg("dim", level) : theme.fg("warning", level);
        }

        function snapshotConfigured() {
          configured = new Map(chain.map((m) => [m.ref, { ...m }]));
        }

        function toggleModel(ref: string) {
          if (isInChain(chain, ref)) {
            // Remove from chain (unless it's the last one)
            if (chain.length <= 1) return;
            chain = chain.filter((m) => m.ref !== ref);
          } else {
            // Add to end of chain, keeping any saved config for this model
            chain.push(entryForAdd(configured.get(ref), ref));
          }
          isDirty = true;
          buildFilteredItems();
          updateHeader();
          updateFooter();
          tui.requestRender();
        }

        /**
         * Cycle the selected chain member's thinking level through the levels its model
         * supports. Raising it above "off" drops a pinned `enable_thinking: false`: that
         * pin is merged over the payload pi-ai builds from the level, so it would disable
         * thinking on the wire while the picker showed a level.
         */
        function cycleThinking() {
          const item = filteredItems[selectedIndex];
          if (!item?.inChain) return;
          const index = chain.findIndex((m) => m.ref === item.ref);
          if (index === -1) return;

          const current = entryThinking(chain[index]);
          const level = nextThinking(current, supportedLevels(ctx.modelRegistry, item));
          // A non-reasoning model has only "off"; leave the picker clean rather than dirty.
          if (level === current) return;

          let entry: ModelEntry = { ...chain[index], thinking: level };
          if (level !== "off" && hasEnableThinkingPin(entry)) {
            entry = withoutEnableThinkingPin(entry);
            ctx.ui.notify(`${item.ref}: dropped the enable_thinking=false override`, "warning");
          }
          chain[index] = entry;
          // Keep the snapshot current so a remove/re-add in this session preserves the edit.
          configured.set(item.ref, entry);
          isDirty = true;
          updateHeader();
          updateFooter();
          tui.requestRender();
        }

        function addAll(targetRefs?: string[]) {
          const targets = targetRefs ?? allModels.map((m) => m.ref);
          const chainSet = new Set(chain.map((m) => m.ref));
          for (const ref of targets) {
            if (!chainSet.has(ref)) {
              chain.push(entryForAdd(configured.get(ref), ref));
              chainSet.add(ref);
            }
          }
          isDirty = true;
          buildFilteredItems();
          updateHeader();
          updateFooter();
          tui.requestRender();
        }

        function clearAll(targetRefs?: string[]) {
          const targets = targetRefs ?? chain.map((m) => m.ref);
          const targetSet = new Set(targets);
          chain = chain.filter((m) => !targetSet.has(m.ref));
          isDirty = true;
          buildFilteredItems();
          updateHeader();
          updateFooter();
          tui.requestRender();
        }

        function moveInChain(ref: string, delta: number) {
          const idx = chain.findIndex((m) => m.ref === ref);
          if (idx === -1) return;
          const newIdx = idx + delta;
          if (newIdx < 0 || newIdx >= chain.length) return;
          [chain[idx], chain[newIdx]] = [chain[newIdx], chain[idx]];
          selectedIndex += delta;
          isDirty = true;
          buildFilteredItems();
          updateHeader();
          updateFooter();
          tui.requestRender();
        }

        function saveChain() {
          if (!isDirty) return;
          const local = readJson(localPath());
          const base = mergedRoles();
          local[selectedRole] = { ...base[selectedRole], models: chain };
          writeLocal(local);
          // What just landed on disk is the new baseline for re-adds.
          snapshotConfigured();
          isDirty = false;
          setSidecarStatus(ctx);
          updateFooter();
          tui.requestRender();
        }

        function resetRole() {
          const local = readJson(localPath());
          delete local[selectedRole];
          if (Object.keys(local).length === 0) {
            if (existsSync(localPath())) unlinkSync(localPath());
          } else {
            writeLocal(local);
          }
          // Reload chain from defaults
          const fresh = mergedRoles();
          chain = [...(fresh[selectedRole]?.models ?? [])];
          snapshotConfigured();
          isDirty = false;
          setSidecarStatus(ctx);
          buildFilteredItems();
          updateHeader();
          updateFooter();
          tui.requestRender();
        }

        function resetAllRoles() {
          if (existsSync(localPath())) unlinkSync(localPath());
          const fresh = mergedRoles();
          chain = [...(fresh[selectedRole]?.models ?? [])];
          snapshotConfigured();
          isDirty = false;
          setSidecarStatus(ctx);
          if (screen === "models") {
            buildFilteredItems();
          }
          updateHeader();
          updateFooter();
          tui.requestRender();
        }

        // ── Screen switching ──

        function switchToModels() {
          screen = "models";
          selectedIndex = 0;
          searchInput.setValue("");
          isDirty = false;
          allModels = getAvailableModels(ctx.modelRegistry);
          const fresh = mergedRoles();
          chain = (fresh[selectedRole]?.models ?? []).map((m) => ({ ...m }));
          snapshotConfigured();
          buildFilteredItems();
          updateHeader();
          updateFooter();
          tui.requestRender();
        }

        function switchToRoles() {
          screen = "roles";
          searchInput.setValue("");
          updateHeader();
          updateFooter();
          tui.requestRender();
        }

        // ── Initial state ──
        allModels = getAvailableModels(ctx.modelRegistry);
        updateHeader();
        updateFooter();

        return {
          render(width: number) {
            const lines: string[] = [];
            lines.push(...headerText.render(width));
            lines.push("");
            if (screen === "roles") {
              lines.push(...renderRoles());
            } else {
              lines.push(...searchInput.render(width));
              lines.push("");
              lines.push(...renderModels());
            }
            lines.push("");
            lines.push(...footerText.render(width));
            return lines;
          },
          invalidate() {},
          handleInput(data: string) {
            const kb = getKeybindings();

            // ── Roles screen ──
            if (screen === "roles") {
              if (kb.matches(data, "tui.select.up")) {
                roleSelectedIndex = roleSelectedIndex === 0 ? roleNames.length - 1 : roleSelectedIndex - 1;
                tui.requestRender();
                return;
              }
              if (kb.matches(data, "tui.select.down")) {
                roleSelectedIndex = roleSelectedIndex === roleNames.length - 1 ? 0 : roleSelectedIndex + 1;
                tui.requestRender();
                return;
              }
              if (matchesKey(data, Key.enter)) {
                selectedRole = roleNames[roleSelectedIndex];
                switchToModels();
                return;
              }
              if (matchesKey(data, Key.ctrl("r"))) {
                resetAllRoles();
                return;
              }
              // Ctrl+D: set all roles to use the default/main model
              if (hasDefaultModel && matchesKey(data, Key.ctrl("d"))) {
                // Find the default model in available models to get its provider
                const match = allModels.find((m) => m.modelId === defaultModel);
                if (!match) {
                  ctx.ui.notify(`Default model "${defaultModel}" not found in available models`, "warning");
                  tui.requestRender();
                  return;
                }
                const mainRef = match.ref;
                // Set all roles: replace first model with default, keep rest of chain.
                // Reuse the role's own entry when it already has the default model so a
                // configured thinking level survives the sync.
                const base = mergedRoles();
                const local: RolesFile = {};
                for (const roleName of roleNames) {
                  const current = base[roleName];
                  const roleChain = current?.models ?? [];
                  const head = entryForAdd(
                    roleChain.find((m) => m.ref === mainRef),
                    mainRef,
                  );
                  const tail = roleChain.slice(1).filter((m) => m.ref !== mainRef);
                  local[roleName] = { ...current, models: [head, ...tail] };
                }
                writeLocal(local);
                setSidecarStatus(ctx);
                ctx.ui.notify(`All roles synced to ${mainRef}`, "info");
                // The open role may now differ from disk; reload it so the picker matches.
                const fresh = mergedRoles();
                chain = (fresh[selectedRole]?.models ?? []).map((m) => ({ ...m }));
                snapshotConfigured();
                buildFilteredItems();
                updateHeader();
                updateFooter();
                tui.requestRender();
                return;
              }
              if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
                done(undefined);
                return;
              }
              return;
            }

            // ── Models screen ──

            // Navigation
            if (kb.matches(data, "tui.select.up")) {
              if (filteredItems.length === 0) return;
              selectedIndex = selectedIndex === 0 ? filteredItems.length - 1 : selectedIndex - 1;
              tui.requestRender();
              return;
            }
            if (kb.matches(data, "tui.select.down")) {
              if (filteredItems.length === 0) return;
              selectedIndex = selectedIndex === filteredItems.length - 1 ? 0 : selectedIndex + 1;
              tui.requestRender();
              return;
            }

            // Alt+Up/Down - Reorder within chain
            if (matchesKey(data, Key.alt("up")) || matchesKey(data, Key.alt("down"))) {
              const item = filteredItems[selectedIndex];
              if (item?.inChain) {
                const delta = matchesKey(data, Key.alt("up")) ? -1 : 1;
                moveInChain(item.ref, delta);
              }
              return;
            }

            // Enter - Toggle in/out of chain
            if (matchesKey(data, Key.enter)) {
              const item = filteredItems[selectedIndex];
              if (item) toggleModel(item.ref);
              return;
            }

            // Ctrl+A - Add all (filtered if search active, otherwise all)
            if (matchesKey(data, Key.ctrl("a"))) {
              const query = searchInput.getValue();
              const targetRefs = query ? filteredItems.map((i) => i.ref) : undefined;
              addAll(targetRefs);
              return;
            }

            // Ctrl+X - Clear (filtered if search active, otherwise all)
            if (matchesKey(data, Key.ctrl("x"))) {
              const query = searchInput.getValue();
              const targetRefs = query ? filteredItems.map((i) => i.ref) : undefined;
              clearAll(targetRefs);
              return;
            }

            // Ctrl+T - Cycle the selected chain member's thinking level
            if (matchesKey(data, Key.ctrl("t"))) {
              cycleThinking();
              return;
            }

            // Ctrl+P - Toggle by provider
            if (matchesKey(data, Key.ctrl("p"))) {
              const item = filteredItems[selectedIndex];
              if (item) {
                const provider = item.provider;
                const providerRefs = allModels.filter((m) => m.provider === provider).map((m) => m.ref);
                const allInChain = providerRefs.every((ref) => isInChain(chain, ref));
                if (allInChain) {
                  clearAll(providerRefs);
                } else {
                  addAll(providerRefs);
                }
              }
              return;
            }

            // Ctrl+S - Save
            if (matchesKey(data, Key.ctrl("s"))) {
              saveChain();
              return;
            }

            // Ctrl+R - Reset role to defaults
            if (matchesKey(data, Key.ctrl("r"))) {
              resetRole();
              return;
            }

            // Ctrl+C - Clear search or back
            if (matchesKey(data, Key.ctrl("c"))) {
              if (searchInput.getValue()) {
                searchInput.setValue("");
                buildFilteredItems();
                updateFooter();
                tui.requestRender();
              } else {
                switchToRoles();
              }
              return;
            }

            // Escape - Back to roles
            if (matchesKey(data, Key.escape)) {
              switchToRoles();
              return;
            }

            // Pass everything else to search input
            searchInput.handleInput(data);
            buildFilteredItems();
            updateFooter();
            tui.requestRender();
          },
        };
      });
    },
  });
}
