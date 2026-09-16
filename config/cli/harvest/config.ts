// Config (~/.config/harvest) and cache (~/.cache/harvest) files, and auth
// resolution (env vars, then macOS keychain). Paths injectable for tests.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { HarvestAuth } from "./api";

export interface Alias {
  projectId: number;
  projectName: string;
  taskId: number | null;
  taskName: string | null;
}

export interface OpConfig {
  /** 1Password account shorthand or account id (op --account). */
  account?: string;
  /** Vault name (op --vault); omitted searches all vaults of the signed-in account. */
  vault?: string;
  /** Item name, e.g. "Harvest API". */
  item?: string;
  tokenField?: string;
  accountField?: string;
}

export interface HarvestConfig {
  aliases: Record<string, Alias>;
  userAgent?: string;
  op?: OpConfig;
  /** Fallback hourly rate for money views when entries carry no rate (Member roles see none). */
  hourlyRate?: number;
  /** Warn when a created/updated entry's note has no http(s) link (account policy). */
  requireNoteLinks?: boolean;
}

export interface CachedProject {
  id: number;
  name: string;
  code: string | null;
  client: string | null;
}

export interface HarvestCache {
  me?: { id: number; first_name: string; last_name: string; email: string };
  timestampTimers?: boolean;
  currencyCode?: string | null;
  projects?: CachedProject[];
  tasksByProject?: Record<string, { id: number; name: string }[]>;
  fetchedAt?: Record<string, number>;
}

export const DEFAULT_USER_AGENT = "harvest-cli/1.0 (personal script)";

export const DEFAULT_OP_ITEM = "Harvest API";
export const SOPS_TOKEN_PATH = "/run/secrets/harvest-token";
export const SOPS_ACCOUNT_PATH = "/run/secrets/harvest-account-id";

export const CONFIG_DIR = join(homedir(), ".config", "harvest");
export const CACHE_DIR = join(homedir(), ".cache", "harvest");

function readJson<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch (e) {
    throw new Error(`could not parse ${path}: ${(e as Error).message}`);
  }
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function loadConfig(dir = CONFIG_DIR): HarvestConfig {
  const cfg = readJson<HarvestConfig>(join(dir, "config.json"));
  return { aliases: {}, ...cfg };
}

export function saveConfig(cfg: HarvestConfig, dir = CONFIG_DIR): void {
  writeJson(join(dir, "config.json"), cfg);
}

export function loadCache(dir = CACHE_DIR): HarvestCache {
  return readJson<HarvestCache>(join(dir, "cache.json")) ?? {};
}

export function saveCache(cache: HarvestCache, dir = CACHE_DIR): void {
  writeJson(join(dir, "cache.json"), cache);
}

/** A cache section is fresh if fetched within ttlMs. */
export function isFresh(cache: HarvestCache, key: string, ttlMs: number, nowMs: number): boolean {
  const at = cache.fetchedAt?.[key];
  return at !== undefined && nowMs - at < ttlMs;
}

function readTrimmed(path: string): string | null {
  try {
    const value = readFileSync(path, "utf8").trim();
    return value === "" ? null : value;
  } catch {
    return null;
  }
}

/** 1Password CLI. Reads are audited by the 1Password app (the point of using it). */
function opFields(op: OpConfig): { token: string; accountId: string } | { error: string } | null {
  const args = [
    "item",
    "get",
    op.item ?? DEFAULT_OP_ITEM,
    "--fields",
    `label=${op.tokenField ?? "token"}`,
    "--fields",
    `label=${op.accountField ?? "account-id"}`,
    "--format",
    "json",
  ];
  if (op.vault) args.push("--vault", op.vault);
  if (op.account) args.push("--account", op.account);
  try {
    const out = execFileSync("op", args, { stdio: ["ignore", "pipe", "pipe"] });
    const fields = JSON.parse(out.toString()) as Array<{ label: string; value: string }>;
    const token = fields.find((f) => f.label === (op.tokenField ?? "token"))?.value.trim();
    const accountId = fields.find((f) => f.label === (op.accountField ?? "account-id"))?.value.trim();
    if (token && accountId) return { token, accountId };
    return {
      error: `item found but fields missing (need labels "${op.tokenField ?? "token"}" and "${op.accountField ?? "account-id"}")`,
    };
  } catch (e) {
    const stderr = ((e as { stderr?: Buffer }).stderr ?? "").toString().trim();
    return { error: stderr.split("\n")[0] || "op command failed" };
  }
}

function secretValue(account: string): string | null {
  const attempts: Array<{ bin: string; args: string[] }> = [];
  if (process.platform === "darwin") {
    attempts.push({ bin: "security", args: ["find-generic-password", "-s", "harvest", "-a", account, "-w"] });
  }
  if (process.platform === "linux") {
    attempts.push({ bin: "secret-tool", args: ["lookup", "service", "harvest", "account", account] });
  }
  for (const { bin, args } of attempts) {
    try {
      const out = execFileSync(bin, args, { stdio: ["ignore", "pipe", "ignore"] });
      const value = out.toString().trim();
      if (value !== "") return value;
    } catch {
      // tool missing or entry absent; try next
    }
  }
  return null;
}

/**
 * Auth order — first source yielding both token and account id wins:
 * 1. HARVEST_TOKEN + HARVEST_ACCOUNT_ID env vars
 * 2. 1Password via `op item get` (config.op; default item "Harvest API")
 * 3. Secret files: HARVEST_TOKEN_FILE / HARVEST_ACCOUNT_ID_FILE, else
 *    /run/secrets/harvest-token + /run/secrets/harvest-account-id (sops-nix)
 * 4. Platform secret store: macOS keychain / Linux secret-tool (libsecret);
 *    Windows relies on the other sources
 */
export function resolveAuth(env: NodeJS.ProcessEnv = process.env, cfg: Partial<HarvestConfig> = {}): HarvestAuth {
  if (env.HARVEST_TOKEN && env.HARVEST_ACCOUNT_ID) {
    return { token: env.HARVEST_TOKEN, accountId: env.HARVEST_ACCOUNT_ID };
  }
  const fromOp = opFields(cfg.op ?? {});
  if (fromOp && "token" in fromOp) return fromOp;
  const opError = fromOp && "error" in fromOp ? fromOp.error : null;
  const fileToken = env.HARVEST_TOKEN_FILE ? readTrimmed(env.HARVEST_TOKEN_FILE) : readTrimmed(SOPS_TOKEN_PATH);
  const fileAccount = env.HARVEST_ACCOUNT_FILE ? readTrimmed(env.HARVEST_ACCOUNT_FILE) : readTrimmed(SOPS_ACCOUNT_PATH);
  if (fileToken && fileAccount) return { token: fileToken, accountId: fileAccount };
  const token = secretValue("token");
  const accountId = secretValue("account-id");
  if (token && accountId) return { token, accountId };
  throw new Error(authSetupMessage(opError));
}

/** Pure: the setup instructions thrown when no auth source yields credentials. */
export function authSetupMessage(opError: string | null = null): string {
  const darwinSetup =
    "  macOS keychain:\n" +
    "  security add-generic-password -s harvest -a token -w <personal-access-token>\n" +
    "  security add-generic-password -s harvest -a account-id -w <account-id>\n";
  const linuxSetup =
    "  Linux libsecret:\n" +
    "  echo -n <personal-access-token> | secret-tool store --label=harvest-token service harvest account token\n" +
    "  echo -n <account-id> | secret-tool store --label=harvest-account-id service harvest account account-id\n";
  const win32Setup = "  Windows: no system-store fallback — use 1Password or env vars (above).\n";
  const platformSetup =
    process.platform === "linux" ? linuxSetup : process.platform === "win32" ? win32Setup : darwinSetup;
  const opNote = opError === null ? "" : `\n(1Password lookup failed: ${opError})`;
  return (
    "no Harvest credentials found.\n" +
    "Set them up once (any one of these):\n" +
    `  1Password: create an item with fields token + account-id (default item: ${DEFAULT_OP_ITEM})\n` +
    opNote +
    "  sops: add harvest-token and harvest-account-id to secrets and deploy via nix\n" +
    "    files: /run/secrets/harvest-token, /run/secrets/harvest-account-id\n" +
    platformSetup +
    "  env: export HARVEST_TOKEN and HARVEST_ACCOUNT_ID\n" +
    "Create a token at https://id.getharvest.com/developers (Developers section)."
  );
}
