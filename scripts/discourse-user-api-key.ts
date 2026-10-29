#!/usr/bin/env bun
/**
 * Discourse User API key — self-serve "authorize dance".
 *
 * Discourse has no "generate my key" button; /user-api-key/new is for apps
 * requesting access to your account. This script impersonates the app:
 * generates an RSA keypair, builds the authorize URL, you click Authorize in
 * your logged-in browser, paste the returned encrypted payload back, and it
 * decrypts to the API key.
 *
 * Usage: run with --help.
 *
 * --app-name (shown on the forum's authorization page and key list) and
 * --client-id (key rotation identity — re-authorizing with the same id
 * replaces the old key) default to "forum-reader".
 *
 * Notes:
 * - Keypair persisted per forum under ~/.config/llm/discourse-user-api-key/ —
 *   Discourse pins the client's public key on first use, so the same client_id
 *   always encrypts to the STORED key. Keep the keypair; re-authorizing with
 *   the same client_id rotates (destroys) the old key.
 * - Requires staff or TL1+ (staff always passes). Scope is read-only.
 * - Uses padding=oaep (Discourse AUTH_API_VERSION 4 supports it): OpenSSL 3
 *   in modern Node/Bun refuses RSA_PKCS1_PADDING decryption, and Ruby's OAEP
 *   default hash (SHA-1) matches Node's.
 */

import { constants, generateKeyPairSync, privateDecrypt, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { type CliSpec, scriptCli } from "../config/shared/cli";

const SPEC: CliSpec = {
  name: "discourse-user-api-key",
  summary: "request a Discourse user API key with RSA-OAEP",
  usage: "bun scripts/discourse-user-api-key.ts <forum-origin> [username] [flags]",
  args: "<forum-origin> [username]",
  flags: [
    { key: "app-name", type: "string", usage: "--app-name <name>", help: "application name shown in Discourse" },
    { key: "client-id", type: "string", usage: "--client-id <id>", help: "client id sent with the request" },
    { key: "help", type: "boolean", short: "h", global: true, usage: "-h, --help", help: "this help" },
  ],
};
const cli = scriptCli(SPEC);
const [forum, username] = cli.args;
const appName = typeof cli.values["app-name"] === "string" ? cli.values["app-name"] : undefined;
const clientId = typeof cli.values["client-id"] === "string" ? cli.values["client-id"] : undefined;

if (!forum || !/^https?:\/\//.test(forum)) {
  const problem = forum ? `invalid forum origin "${forum}"` : "missing <forum-origin>";
  console.error(`error: discourse-user-api-key: ${problem}`);
  process.exit(2);
}

const host = forum.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
const APP_NAME = appName ?? "forum-reader";
const CLIENT_ID = clientId ?? "forum-reader";
const stateDir = join(homedir(), ".config", "llm", "discourse-user-api-key", host);
const privPath = join(stateDir, "private.pem");
const pubPath = join(stateDir, "public.pem");

mkdirSync(stateDir, { recursive: true });
chmodSync(stateDir, 0o700);

let privateKeyPem: string;
let publicKeyPem: string;
if (existsSync(privPath)) {
  privateKeyPem = readFileSync(privPath, "utf8");
  publicKeyPem = existsSync(pubPath)
    ? readFileSync(pubPath, "utf8")
    : generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey.export({ type: "spki", format: "pem" }).toString();
  if (!existsSync(pubPath)) writeFileSync(pubPath, publicKeyPem);
} else {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  writeFileSync(privPath, privateKeyPem, { mode: 0o600 });
  writeFileSync(pubPath, publicKeyPem);
  console.error(`Generated new keypair in ${stateDir}`);
}

const nonce = randomBytes(16).toString("hex");
const url =
  `${forum}/user-api-key/new?application_name=${encodeURIComponent(APP_NAME)}` +
  `&client_id=${encodeURIComponent(CLIENT_ID)}&scopes=read&nonce=${nonce}` +
  `&padding=oaep&public_key=${encodeURIComponent(publicKeyPem)}`;

console.log(`
1) Open this URL in the browser where you are logged into the forum:

${url}

2) Click "Authorize".

3) The page shows an encrypted payload. Copy it, paste it below,
   and end with Ctrl-D (EOF).
`);

const rl = createInterface({ input: process.stdin, terminal: false });
const chunks: string[] = [];
for await (const line of rl) chunks.push(line);
const payload = chunks.join("").replace(/\s+/g, "");

let plaintext: string;
try {
  plaintext = privateDecrypt(
    { key: privateKeyPem, padding: constants.RSA_PKCS1_OAEP_PADDING },
    Buffer.from(payload, "base64"),
  ).toString("utf8");
} catch {
  console.error(
    `Decryption failed. The client's stored public key probably doesn't match ${privPath}.\n` +
      `Delete ${stateDir} and re-run to start fresh.`,
  );
  process.exit(1);
}

const parsed = JSON.parse(plaintext) as { key?: string; nonce?: string };
if (parsed.nonce !== nonce) {
  console.error(`Nonce mismatch (got '${parsed.nonce}', expected '${nonce}') — wrong or replayed payload.`);
  process.exit(1);
}
if (!parsed.key) {
  console.error(`No key in payload: ${plaintext}`);
  process.exit(1);
}

console.log(`
API key (read-only, for ${host}):

${parsed.key}

Store in 1Password:
  op item create --category='Password' --title="discourse-${host}" "api-key=${parsed.key}" "username=${username}"

Then add to ~/.config/llm/discourse-keys.json:
  {
    "${host}": {
      "apiKey": "!op read 'op://<vault>/discourse-${host}/api-key'",
      "apiUsername": "${username}"
    }
  }

Revoke later at: ${forum}/my/preferences/account  (User API Keys section)
`);
