/**
 * Model roles - shared module for sidecar LLM calls.
 *
 * Reads ~/.pi/agent/roles.json for role definitions.
 * Each role maps to an ordered list of models (fallback chain).
 * Extensions use this to make cheap LLM calls for auxiliary tasks
 * (explain tool calls, auto-decide permissions, draft messages, etc.)
 * without touching the main agent model.
 *
 * Config format (~/.pi/agent/roles.json):
 * {
 *   "explain": {
 *     "models": [
 *       { "ref": "anthropic/claude-haiku-4-5", "thinking": "off" },
 *       { "ref": "openrouter/some-fallback", "thinking": "off" }
 *     ]
 *   },
 *   "decide": {
 *     "models": [
 *       { "ref": "anthropic/claude-haiku-4-5", "thinking": "minimal" }
 *     ]
 *   }
 * }
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type Api,
  type AssistantMessage,
  type Context,
  completeSimple,
  type Message,
  type Model,
  type ThinkingLevel as PiThinkingLevel,
  type ProviderHeaders,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai/compat";
import { getAgentDir, type ModelRegistry } from "@earendil-works/pi-coding-agent";

// ── Types ──

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high";

export interface ModelEntry {
  /** "provider/modelId" reference */
  ref: string;
  /** Thinking level for this specific model. Default: "off" */
  thinking?: ThinkingLevel;
  /** Max attempts per call (for retry with filtering). Default: 1 */
  maxAttempts?: number;
  /**
   * Extra params merged into the API request body via onPayload.
   * Used for provider-specific options like thinking_budget, chat_template_kwargs, etc.
   * Example: { "chat_template_kwargs": { "enable_thinking": false } }
   */
  requestParams?: Record<string, unknown>;
}

export interface RoleConfig {
  models: ModelEntry[];
  /** Max output tokens for this role. Applied to all models in the chain. */
  maxTokens?: number;
}

export interface RolesFile {
  [roleName: string]: RoleConfig;
}

export interface ResolvedModel {
  model: Model<Api>;
  apiKey: string | undefined;
  /** Pass-through from ModelRegistry.getApiKeyAndHeaders — forwarded verbatim to
   * pi-ai streams. Values may be null (header-deletion markers); do not strip. */
  headers: ProviderHeaders | undefined;
  thinking: ThinkingLevel;
}

export interface SidecarResult {
  message: AssistantMessage;
  /** Which model from the fallback chain was used */
  modelUsed: string;
  /** Cost in dollars for this call */
  cost: number;
}

// ── Cost tracker ──

let cumulativeCost = 0;
let cumulativeCalls = 0;

export function getSidecarStats() {
  return { cost: cumulativeCost, calls: cumulativeCalls };
}

export function resetSidecarStats() {
  cumulativeCost = 0;
  cumulativeCalls = 0;
}

// ── Config loading ──

const DEFAULTS_PATH = join(getAgentDir(), "roles.json");
const LOCAL_PATH = join(getAgentDir(), "roles.local.json");

function readJsonFile(filePath: string): RolesFile {
  if (!existsSync(filePath)) return {};
  try {
    return JSON.parse(readFileSync(filePath, "utf-8")) as RolesFile;
  } catch (err) {
    console.error(`Failed to load ${filePath}: ${err}`);
    return {};
  }
}

/** Read roles config from disk. Always reads fresh — no caching. */
export function loadConfig(): RolesFile {
  const defaults = readJsonFile(DEFAULTS_PATH);
  const local = readJsonFile(LOCAL_PATH);
  return { ...defaults, ...local };
}

// ── Model resolution ──

export function parseRef(ref: string): { provider: string; modelId: string } | null {
  const slash = ref.indexOf("/");
  if (slash === -1) return null;
  return { provider: ref.slice(0, slash), modelId: ref.slice(slash + 1) };
}

export type ResolvedRoleModel = ResolvedModel & { entry: ModelEntry };

/**
 * Resolve up to `limit` models from a role's fallback chain, in order, skipping
 * entries that do not resolve or have no auth. `resolveRole` is this with
 * limit 1; callers that retry on provider failure ask for more.
 */
export async function resolveRoleChain(
  roleName: string,
  modelRegistry: ModelRegistry,
  limit = Number.POSITIVE_INFINITY,
): Promise<ResolvedRoleModel[]> {
  const config = loadConfig();
  const role = config[roleName];
  if (!role?.models?.length) return [];

  const resolved: ResolvedRoleModel[] = [];
  for (const entry of role.models) {
    if (resolved.length >= limit) break;
    const parsed = parseRef(entry.ref);
    if (!parsed) continue;

    const model = modelRegistry.find(parsed.provider, parsed.modelId);
    if (!model) continue;

    const auth = await modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok) continue;

    resolved.push({
      model,
      apiKey: auth.apiKey,
      headers: auth.headers,
      thinking: entry.thinking ?? "off",
      entry,
    });
  }

  return resolved;
}

/**
 * Resolve a role to a usable model with auth.
 * Tries each model in the fallback chain until one has valid auth.
 * Returns null if no model is available.
 */
export async function resolveRole(roleName: string, modelRegistry: ModelRegistry): Promise<ResolvedRoleModel | null> {
  const [first] = await resolveRoleChain(roleName, modelRegistry, 1);
  return first ?? null;
}

// ── Sidecar call ──

/**
 * Make a sidecar LLM call using a named role.
 * Tries each model in the fallback chain.
 * Returns null if no model is available or all fail.
 */
export async function sidecarComplete(
  roleName: string,
  context: Context,
  modelRegistry: ModelRegistry,
  options?: { signal?: AbortSignal; notify?: (msg: string, level: "info" | "warning") => void },
): Promise<SidecarResult | null> {
  const config = loadConfig();
  const role = config[roleName];
  if (!role?.models?.length) return null;

  const errors: Array<{ ref: string; error: unknown }> = [];
  const failedModels: string[] = [];
  const notify = options?.notify;

  for (const entry of role.models) {
    const parsed = parseRef(entry.ref);
    if (!parsed) continue;

    const model = modelRegistry.find(parsed.provider, parsed.modelId);
    if (!model) continue;

    const auth = await modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok) continue;

    try {
      const thinking = entry.thinking ?? "off";
      // completeSimple uses "reasoning" for thinking level, but "off" isn't a valid
      // SimpleStreamOptions reasoning value -- it means no reasoning at all.
      // Only pass reasoning if it's not "off".
      const reasoning = thinking === "off" ? undefined : thinking;

      const streamOptions: SimpleStreamOptions = {
        apiKey: auth.apiKey,
        headers: auth.headers,
        reasoning: reasoning as PiThinkingLevel | undefined,
        signal: options?.signal,
        maxTokens: role.maxTokens,
      };

      // Inject per-model request params (e.g. thinking_budget, chat_template_kwargs)
      // via onPayload so they reach the provider without pi needing native support.
      if (entry.requestParams && Object.keys(entry.requestParams).length > 0) {
        const extraParams = entry.requestParams;
        streamOptions.onPayload = (payload: unknown) => {
          if (typeof payload === "object" && payload !== null) {
            return { ...(payload as Record<string, unknown>), ...extraParams };
          }
          return undefined;
        };
      }

      const message = await completeSimple(model, context, streamOptions);

      const cost = message.usage.cost.total;
      cumulativeCost += cost;
      cumulativeCalls += 1;

      if (failedModels.length > 0 && notify) {
        notify(`${roleName}: ${failedModels.join(", ")} failed, fell back to ${entry.ref}`, "warning");
      }

      return {
        message,
        modelUsed: entry.ref,
        cost,
      };
    } catch (err) {
      failedModels.push(entry.ref);
      errors.push({ ref: entry.ref, error: err });
    }
  }

  // All models failed
  if (errors.length > 0) {
    console.error(`All models failed for role "${roleName}":`, errors.map((e) => `${e.ref}: ${e.error}`).join(", "));
  }
  return null;
}

/**
 * Check if a role is configured (has at least one model entry).
 */
export function hasRole(roleName: string): boolean {
  const config = loadConfig();
  const role = config[roleName];
  return !!role?.models?.length;
}

/**
 * Get the display name for a role's active model (first available).
 */
export async function getRoleModelName(roleName: string, modelRegistry: ModelRegistry): Promise<string | null> {
  const resolved = await resolveRole(roleName, modelRegistry);
  if (!resolved) return null;
  return `${resolved.model.provider}/${resolved.model.id}`;
}

/**
 * Extract text content from an AssistantMessage.
 */
export function extractText(message: AssistantMessage): string {
  return message.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("");
}

// ── Message builders ──
// Pi 0.63.2 requires timestamp on UserMessage and api/provider/model/usage
// on AssistantMessage. For sidecar context messages these are just metadata
// the provider ignores -- only role and content matter.

/** Build a typed UserMessage for sidecar context. */
export function userMsg(text: string): Message {
  return {
    role: "user" as const,
    content: [{ type: "text" as const, text }],
    timestamp: Date.now(),
  };
}

/** Build a typed AssistantMessage for sidecar context. */
export function assistantMsg(text: string): Message {
  return {
    role: "assistant" as const,
    content: [{ type: "text" as const, text }],
    api: "messages" as Api,
    provider: "sidecar",
    model: "sidecar",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop" as const,
    timestamp: Date.now(),
  };
}
