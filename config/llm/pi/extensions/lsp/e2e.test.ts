/**
 * Live end-to-end tests: real language servers over the real client.
 *
 * Opt-in — these spawn actual servers and can take a minute:
 *   LSP_E2E=1 bun test extensions/lsp/e2e.test.ts
 * Skipped in the normal `mise tree-check config/llm/pi` run and for any server binary not on
 * PATH (add it via nix/homebrew or `nix shell nixpkgs#<pkg>` to include it).
 *
 * Host TS: this repo's root resolves its classic typescript install (classic
 * server, push diagnostics). TS7 native: set LSP_E2E_TS7_ROOT to a devcontainer
 * project on TS7 to exercise `tsc --lsp` (native server, pull diagnostics).
 */

import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runAction } from "./actions";
import type { DocumentSymbol, LspClient } from "./client";
import {
  createClient,
  fileToUri,
  incomingCalls,
  notifySaved,
  outgoingCalls,
  prepareCallHierarchy,
  syncFile,
} from "./client";
import { restartAllClients } from "./client-mgmt";
import { detectTsFlavor, resolveServerTarget } from "./devcontainer";
import { formatDriftLines } from "./drift";
import { startSession, stopSession } from "./file-events";
import { postBashResult, postEditResult } from "./hooks";
import { configForTsFlavor, KNOWN_SERVERS } from "./servers";
import { createState, type EngineState, type LspHost } from "./state";
import { statusReport } from "./status";
import { WatchChangeType } from "./watcher";

const E2E = process.env.LSP_E2E === "1";
const d = E2E ? describe : describe.skip;
d("e2e", () => {
  const tmpDirs: string[] = [];
  const clients: LspClient[] = [];
  const engineStates: EngineState[] = [];
  afterAll(() => {
    for (const c of clients) void c.shutdown();
    for (const s of engineStates) void stopSession(s);
    for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
  });

  function hasBinary(cmd: string): boolean {
    try {
      fs.accessSync(path.join("/usr/bin", cmd));
      return true;
    } catch {}
    const which = Bun.spawnSync(["sh", "-c", `command -v ${cmd}`]);
    return which.exitCode === 0;
  }

  function mkFixture(name: string, files: Record<string, string>): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `lsp-e2e-${name}-`));
    tmpDirs.push(dir);
    for (const [rel, content] of Object.entries(files)) {
      const p = path.join(dir, rel);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, content);
    }
    return dir;
  }

  async function startServer(serverName: string, cwd: string): Promise<LspClient> {
    const client = await createClient(serverName, KNOWN_SERVERS[serverName], cwd, null);
    clients.push(client);
    return client;
  }

  /** Host-mode classic-TS client. Default root: this repo (walk-up resolves ts-classic). Pass a root to root at a fixture. */
  async function startHostTs(root = path.resolve(import.meta.dir, "..", "..")): Promise<LspClient> {
    const flavor = await detectTsFlavor(root, null);
    expect(flavor).toBe("ts-classic");
    const client = await createClient(
      "typescript-language-server",
      configForTsFlavor(KNOWN_SERVERS["typescript-language-server"], flavor),
      root,
      null,
    );
    clients.push(client);
    return client;
  }

  /** Wait until diagnostics appear for a host file (or timeout). */
  async function waitForDiagnostics(client: LspClient, file: string, minCount = 1, ms = 20000) {
    const uri = fileToUri(file);
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const found = client.diagnostics.get(uri) ?? [];
      if (found.length >= minCount) return found;
      await new Promise((r) => setTimeout(r, 250));
    }
    return client.diagnostics.get(uri) ?? [];
  }

  test("typescript (host, classic TS ≤6): diagnostics for injected error", async () => {
    const client = await startHostTs();
    expect(client.pullDiagnostics).toBe(false);
    const file = path.join(path.resolve(import.meta.dir, "..", ".."), "extensions", "lsp", "servers.ts");
    await syncFile(client, file); // open (registers interest)
    const src = await fs.promises.readFile(file, "utf-8");
    await syncFile(client, file, `${src}\nconst __e2e_broken: number = "not a number";\n`);
    const diags = await waitForDiagnostics(client, file);
    expect(diags.some((d) => d.message.includes("not assignable"))).toBe(true);
  }, 60_000);

  test("typescript (host, classic): hover with multi-byte UTF-8 does not desync framing", async () => {
    // Regression: the transport once accumulated stdout as a string but
    // sliced frames by Content-Length BYTES — one multi-byte message silently
    // corrupted every response after it ("symbols work, hover times out").
    // A JSDoc with non-ASCII forces multibyte bytes into the hover response;
    // the FOLLOW-UP request proves the stream is still framed.
    const client = await startHostTs();
    const dir = mkFixture("utf8", {
      "unicode.ts":
        '/** Greets with → and ✓ ünïcode */\nexport function hello(nme: string): string {\n  return "héöllo " + nme + " — ✓";\n}\nhello("wörld");\n',
    });
    const file = path.join(dir, "unicode.ts");
    await syncFile(client, file);
    const uri = fileToUri(file);
    const hover = await client.request("textDocument/hover", {
      textDocument: { uri },
      position: { line: 4, character: 1 },
    });
    expect(hover).not.toBeNull();
    // follow-up request on the same connection proves framing survived
    const symbols = (await client.request("textDocument/documentSymbol", {
      textDocument: { uri },
    })) as DocumentSymbol[];
    expect(symbols.length).toBeGreaterThan(0);
  }, 90_000);

  test("typescript (host, classic): didChange updates diagnostics", async () => {
    const client = await startHostTs();
    const dir = mkFixture("didchange", {
      "editable.ts": "export const fine: number = 1;\n",
    });
    const file = path.join(dir, "editable.ts");
    await syncFile(client, file);
    // let the server settle on the clean file, then verify no type error
    await new Promise((r) => setTimeout(r, 3000));
    expect((client.diagnostics.get(fileToUri(file)) ?? []).every((d) => !d.message.includes("not assignable"))).toBe(
      true,
    );
    // introduce an error via didChange (no disk write)
    await syncFile(client, file, 'export const fine: number = "oops";\n');
    const broken = await waitForDiagnostics(client, file);
    expect(broken.some((d) => d.message.includes("not assignable"))).toBe(true);
  }, 90_000);

  test("typescript (host, classic): definition crosses files", async () => {
    // Client rooted AT the fixture (package.json root marker): repo-rooted
    // clients treat tmp files as orphan inferred projects and definition
    // returns only the import statement instead of jumping to target.ts.
    const dir = mkFixture("def", {
      "package.json": '{"name":"e2e-def","type":"module"}',
      "target.ts": "export function targetFn(n: number): number {\n  return n + 1;\n}\n",
      "caller.ts": 'import { targetFn } from "./target";\nexport const r = targetFn(1);\n',
    });
    const client = await startHostTs(dir);
    const file = path.join(dir, "caller.ts");
    await syncFile(client, file);
    await syncFile(client, path.join(dir, "target.ts"));
    // targetFn call site: line 1, char 19
    const def = (await client.request("textDocument/definition", {
      textDocument: { uri: fileToUri(file) },
      position: { line: 1, character: 19 },
    })) as Array<{ uri?: string; targetUri?: string }>;
    const flat = Array.isArray(def) ? def : [def];
    const uris = flat.map((l) => l?.uri ?? l?.targetUri ?? "");
    expect(uris.some((u) => u.endsWith("target.ts"))).toBe(true);
  }, 90_000);

  test("typescript (host, classic): call hierarchy incoming/outgoing", async () => {
    // Validates the call-hierarchy protocol layer the post-edit caller warning
    // is built on: prepareCallHierarchy on a declaration, then incoming/outgoing.
    const dir = mkFixture("ch", {
      "package.json": '{"name":"e2e-ch","type":"module"}',
      "a.ts":
        "export function top(): number {\n  return child();\n}\nexport function child(): number {\n  return 1;\n}\nexport function other(): number {\n  return top();\n}\n",
    });
    const client = await startHostTs(dir);
    const file = path.join(dir, "a.ts");
    await syncFile(client, file);
    const uri = fileToUri(file);

    // Position on `child` in `export function child() {` (line 3 0-based, char 16).
    const items = await prepareCallHierarchy(client, uri, { line: 3, character: 16 });
    expect(items.some((i) => i.name === "child")).toBe(true);
    const child = items.filter((i) => i.name === "child")[0];
    expect(child).toBeTruthy();

    // child() is called from top().
    const inc = await incomingCalls(client, child);
    expect(inc.some((c) => c.from.name === "top")).toBe(true);

    // top() calls child().
    const topItems = await prepareCallHierarchy(client, uri, { line: 0, character: 16 });
    const top = topItems.filter((i) => i.name === "top")[0];
    expect(top).toBeTruthy();
    const out = await outgoingCalls(client, top);
    expect(out.some((c) => c.to.name === "child")).toBe(true);
  }, 90_000);

  const ts7Root = process.env.LSP_E2E_TS7_ROOT ?? "";
  test.skipIf(!ts7Root || !fs.existsSync(ts7Root))(
    "typescript (devcontainer, TS7 native): flavor detect + pull diagnostics",
    async () => {
      const root = ts7Root;
      const target = await resolveServerTarget(root, "typescript-language-server", "tsc");
      if (!target) return; // no devcontainer with tsc running for the TS7 root
      const flavor = await detectTsFlavor(root, target);
      expect(flavor).toBe("ts7");
      const client = await createClient(
        "typescript-language-server",
        configForTsFlavor(KNOWN_SERVERS["typescript-language-server"], flavor),
        root,
        target,
      );
      clients.push(client);
      expect(client.pullDiagnostics).toBe(true);
      const file = path.join(root, "src", "index.ts");
      if (!fs.existsSync(file)) return;
      const src = await fs.promises.readFile(file, "utf-8");
      await syncFile(client, file, `${src}\nconst __e2e_broken: number = "not a number";\n`);
      const diags = await waitForDiagnostics(client, file);
      expect(diags.some((d) => d.message.includes("not assignable"))).toBe(true);
    },
    90_000,
  );

  /** Open `mainRel` from a fixture and assert its document symbols satisfy `check`. */
  async function expectSymbols(
    serverName: string,
    fixtureName: string,
    files: Record<string, string>,
    mainRel: string,
    check: (symbols: DocumentSymbol[]) => boolean = (s) => s.length > 0,
  ): Promise<void> {
    const root = mkFixture(fixtureName, files);
    const client = await startServer(serverName, root);
    const file = path.join(root, mainRel);
    await syncFile(client, file);
    const symbols = (await client.request("textDocument/documentSymbol", {
      textDocument: { uri: fileToUri(file) },
    })) as DocumentSymbol[];
    expect(check(symbols)).toBe(true);
  }

  test.skipIf(!hasBinary("rust-analyzer"))(
    "rust-analyzer: document symbols",
    () =>
      expectSymbols(
        "rust-analyzer",
        "rust",
        {
          "Cargo.toml": '[package]\nname = "e2e"\nversion = "0.1.0"\nedition = "2021"\n',
          "src/main.rs":
            'struct Point { x: u32, y: u32 }\nfn main() { let p = Point { x: 1, y: 2 }; println!("{}", p.x); }\n',
        },
        "src/main.rs",
      ),
    90_000,
  );

  test.skipIf(!hasBinary("gopls"))(
    "gopls: document symbols",
    () =>
      expectSymbols(
        "gopls",
        "go",
        {
          "go.mod": "module e2e\n\ngo 1.23\n",
          "main.go": "package main\n\nfunc main() {}\n\nfunc helper() int { return 42 }\n",
        },
        "main.go",
      ),
    60_000,
  );

  test.skipIf(!hasBinary("nixd"))(
    "nixd: document symbols on a let binding",
    () => expectSymbols("nixd", "nix", { "default.nix": "let\n  answer = 42;\nin\n  answer\n" }, "default.nix"),
    60_000,
  );

  test.skipIf(!hasBinary("bash-language-server"))(
    "bash-language-server: document symbols",
    () =>
      expectSymbols(
        "bashls",
        "bash",
        { "script.sh": "#!/usr/bin/env bash\nmy_func() {\n  echo hi\n}\nmy_func\n" },
        "script.sh",
        (s) => s.some((x) => x.name.includes("my_func")),
      ),
    60_000,
  );

  test.skipIf(!hasBinary("yaml-language-server"))(
    "yaml-language-server: document symbols",
    () =>
      expectSymbols("yamlls", "yaml", { "conf.yaml": "name: e2e\nspec:\n  replicas: 2\n  port: 8080\n" }, "conf.yaml"),
    60_000,
  );

  test.skipIf(!hasBinary("clangd"))(
    "clangd: document symbols (fallback mode, no compile db)",
    () =>
      expectSymbols(
        "clangd",
        "c",
        { "main.c": "struct Point { int x; int y; };\nint main(void) { struct Point p = {1, 2}; return p.x; }\n" },
        "main.c",
        (s) => s.some((x) => x.name === "main"),
      ),
    60_000,
  );

  test.skipIf(!hasBinary("pyright-langserver"))(
    "pyright: diagnostics for a type error",
    async () => {
      const root = mkFixture("py", {
        "main.py": 'def add(a: int, b: int) -> int:\n    return a + b\n\nadd("x", 1)\n',
      });
      const client = await startServer("pyright", root);
      const file = path.join(root, "main.py");
      await syncFile(client, file);
      const diags = await waitForDiagnostics(client, file);
      expect(diags.length).toBeGreaterThan(0);
    },
    60_000,
  );

  test.skipIf(!hasBinary("oxlint"))(
    "oxlint: push diagnostics on open, and re-push on change",
    async () => {
      const root = mkFixture("oxlint", {
        "package.json": "{}",
        "bad.ts": "export function greet(name: string): string {\n  return name;\n}\n", // clean
      });
      const client = await startServer("oxlint", root);
      const file = path.join(root, "bad.ts");
      await syncFile(client, file); // open clean
      // let the server settle, then confirm no no-debugger lint yet
      await new Promise((r) => setTimeout(r, 2000));
      expect((client.diagnostics.get(fileToUri(file)) ?? []).every((d) => !d.message.includes("debugger"))).toBe(true);
      // introduce a lint via change + save (the extension's post-edit path)
      const broken = "export function greet(name: string): string {\n  debugger;\n  return name;\n}\n";
      await syncFile(client, file, broken);
      notifySaved(client, file, broken);
      const diags = await waitForDiagnostics(client, file, 1, 20_000);
      expect(diags.some((d) => d.message.includes("debugger"))).toBe(true);
    },
    60_000,
  );

  test.skipIf(!hasBinary("biome"))(
    "biome: push diagnostics on open, and re-push on change",
    async () => {
      const root = mkFixture("biome", {
        "biome.json": '{"files":{"includes":["**"]},"linter":{"rules":{"recommended":true}}}',
        "bad.ts": "export function greet(name: string): string {\n  return name;\n}\n", // clean
      });
      const client = await startServer("biome", root);
      const file = path.join(root, "bad.ts");
      await syncFile(client, file); // open clean
      // let the server settle, then confirm no no-debugger lint yet
      await new Promise((r) => setTimeout(r, 2000));
      expect((client.diagnostics.get(fileToUri(file)) ?? []).every((d) => !d.message.includes("debugger"))).toBe(true);
      // introduce a lint via change + save (the extension's post-edit path)
      const broken =
        'export function greet(name: string): string {\n  const s = "a" + name;\n  debugger;\n  return name;\n}\n';
      await syncFile(client, file, broken);
      notifySaved(client, file, broken);
      const diags = await waitForDiagnostics(client, file, 2, 20_000);
      expect(diags.some((d) => d.message.includes("debugger"))).toBe(true);
      // quickfix hint: the useTemplate diagnostic offers a real fix, not just
      // suppress actions — this is what the post-edit block reports.
      const templ = diags.find((d) => String(d.code ?? "").includes("useTemplate"));
      if (!templ) throw new Error("expected useTemplate diagnostic");
      const acts = (await client.request("textDocument/codeAction", {
        textDocument: { uri: fileToUri(file) },
        range: templ.range,
        context: { diagnostics: [templ], only: ["quickfix"] },
      })) as Array<{ title: string; edit?: unknown; command?: unknown }>;
      expect(acts.some((a) => a.title.includes("template literal") && (a.edit || a.command))).toBe(true);
      // format drift: the 2-space file diverges from biome's default tab
      // formatter — the drift check must report changed lines, never apply.
      const drift = await formatDriftLines(client, file);
      expect(drift).not.toBeNull();
      expect(drift).toMatch(/^\d/);
    },
    60_000,
  );

  test.skipIf(!hasBinary("taplo"))(
    "taplo: toml document symbols",
    () =>
      expectSymbols(
        "taplo",
        "toml",
        { "config.toml": '[server]\nhost = "localhost"\nport = 8080\n\n[database]\nurl = "postgres://x"\n' },
        "config.toml",
      ),
    60_000,
  );

  test.skipIf(!hasBinary("marksman"))(
    "marksman: markdown document symbols (headings)",
    () =>
      expectSymbols("marksman", "md", { "doc.md": "# Title\n\nintro\n\n## Section\n\nbody\n" }, "doc.md", (s) =>
        s.some((x) => x.name.includes("Title")),
      ),
    60_000,
  );

  test.skipIf(!hasBinary("lemminx"))(
    "lemminx: xml document symbols",
    () =>
      expectSymbols(
        "lemminx",
        "xml",
        {
          "project.xml":
            '<project>\n  <module name="core">\n    <artifactId>core</artifactId>\n  </module>\n</project>\n',
        },
        "project.xml",
      ),
    60_000,
  );

  test.skipIf(!hasBinary("vscode-css-language-server"))(
    "vscode-css: scss document symbols",
    () =>
      expectSymbols(
        "css",
        "scss",
        { "style.scss": ".container {\n  display: flex;\n  .item {\n    color: red;\n  }\n}\n" },
        "style.scss",
      ),
    60_000,
  );

  test.skipIf(!hasBinary("vscode-html-language-server"))(
    "vscode-html: html document symbols",
    () =>
      expectSymbols(
        "html",
        "html",
        { "page.html": "<html>\n  <body>\n    <h1>Hi</h1>\n    <p>Hello</p>\n  </body>\n</html>\n" },
        "page.html",
      ),
    60_000,
  );

  test.skipIf(!hasBinary("vscode-json-language-server"))(
    "vscode-json: json document symbols",
    () =>
      expectSymbols("json", "json", { "conf.json": '{\n  "name": "e2e",\n  "nested": { "x": 1 }\n}\n' }, "conf.json"),
    60_000,
  );

  test.skipIf(!hasBinary("lua-language-server"))(
    "lua-language-server: lua document symbols",
    () =>
      expectSymbols(
        "lua-language-server",
        "lua",
        {
          "script.lua":
            "local function greet(name)\n  print('hello ' .. name)\nend\n\nlocal M = {}\nfunction M:method() end\nreturn M\n",
        },
        "script.lua",
      ),
    60_000,
  );

  test.skipIf(!hasBinary("docker-langserver"))(
    "docker-langserver: Dockerfile document symbols",
    () =>
      expectSymbols(
        "dockerfile",
        "docker",
        { Dockerfile: "FROM node:22-alpine\nWORKDIR /app\nCOPY package.json .\nRUN npm ci\n" },
        "Dockerfile",
      ),
    60_000,
  );

  test.skipIf(!hasBinary("zls"))(
    "zls: zig document symbols",
    () =>
      expectSymbols(
        "zls",
        "zig",
        {
          "build.zig":
            'const std = @import("std");\nfn add(a: i32, b: i32) i32 { return a + b; }\npub fn main() void {}\n',
        },
        "build.zig",
        (s) => s.some((x) => x.name === "add"),
      ),
    120_000,
  );

  test.skipIf(!hasBinary("powershell-editor-services"))(
    "powershell-editor-services: ps1 document symbols",
    () =>
      expectSymbols(
        "powershell",
        "ps",
        { "script.ps1": "function Get-Version {\n  return '1.0'\n}\n\nGet-Version\n" },
        "script.ps1",
      ),
    120_000,
  );

  test.skipIf(!hasBinary("Microsoft.CodeAnalysis.LanguageServer"))(
    "roslyn-ls: C# document symbols",
    async () => {
      const root = mkFixture("cs", {
        "Project.csproj":
          '<Project Sdk="Microsoft.NET.Sdk">\n  <PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup>\n</Project>\n',
        "Order.cs":
          "public class OrderService {\n    private readonly IRepo _repo;\n    public OrderService(IRepo repo) { _repo = repo; }\n    public async Task<Order> GetOrderAsync(int id) => await _repo.FindAsync(id);\n}\npublic interface IRepo { Task<Order> FindAsync(int id); }\n",
      });
      const client = await startServer("roslyn-ls", root);
      const file = path.join(root, "Order.cs");
      await syncFile(client, file);
      // Roslyn loads the workspace in the background; give it a moment.
      await new Promise((r) => setTimeout(r, 3000));
      const symbols = (await client.request("textDocument/documentSymbol", {
        textDocument: { uri: fileToUri(file) },
      })) as DocumentSymbol[];
      expect(symbols.some((x) => x.name.includes("OrderService"))).toBe(true);
    },
    120_000,
  );

  test.skipIf(!hasBinary("jdtls"))(
    "jdtls: Java document symbols",
    () =>
      expectSymbols(
        "jdtls",
        "java",
        {
          "pom.xml":
            '<project xmlns="http://maven.apache.org/POM/4.0.0">\n  <modelVersion>4.0.0</modelVersion>\n  <groupId>e2e</groupId><artifactId>e2e</artifactId><version>1</version>\n</project>\n',
          "Main.java":
            'public class Main {\n    public static void main(String[] args) { System.out.println("hi"); }\n}\n',
        },
        "Main.java",
        (s) => s.some((x) => x.name === "Main"),
      ),
    180_000,
  );

  // ── Engine-driven tests: the full pipeline through the engine modules ──
  // (session start → postEditResult drain → runAction) against a real server.

  function startEngineSession(fixture: string): {
    state: EngineState;
    statusCalls: Array<{ progress: unknown[]; running: string[] }>;
  } {
    const statusCalls: Array<{ progress: unknown[]; running: string[] }> = [];
    const host: LspHost = { notify: () => {}, setStatus: (d) => statusCalls.push(d) };
    const state = createState(host);
    engineStates.push(state);
    startSession(state, fixture);
    expect(state.detectedServers.length).toBeGreaterThan(0);
    return { state, statusCalls };
  }

  test.skipIf(!hasBinary("typescript-language-server"))(
    "engine: postEditResult drain reports a write-injected type error, then clears",
    async () => {
      const fixture = mkFixture("engine-edit", {
        "package.json": "{}",
        "src.ts": "export const n: number = 1;\n",
      });
      const { state } = startEngineSession(fixture);

      // Introduce a type error via a `write` tool_result drain.
      fs.writeFileSync(path.join(fixture, "src.ts"), "export const n: number = 'not a number';\n");
      const broken = await postEditResult(state, "write", { path: "src.ts" }, fixture, false);
      expect(broken).not.toBeNull();
      expect(broken?.appended).toContain("[LSP diagnostics (");
      expect(broken?.errored).toBe(true);
      expect(broken?.notify).toContain("not assignable");

      // Fix the file: the drain reports clean and raises no notification.
      fs.writeFileSync(path.join(fixture, "src.ts"), "export const n: number = 1;\n");
      const clean = await postEditResult(state, "write", { path: "src.ts" }, fixture, false);
      expect(clean).not.toBeNull();
      expect(clean?.appended).toContain("no errors, no warnings");
      expect(clean?.notify).toBeNull();
    },
    90_000,
  );

  test.skipIf(!hasBinary("typescript-language-server"))(
    "engine: consecutive drains collapse an unchanged error (dedup ledger)",
    async () => {
      const fixture = mkFixture("engine-ledger", {
        "package.json": "{}",
        "src.ts": "export const n: number = 1;\n",
      });
      const { state } = startEngineSession(fixture);

      // Two different broken contents, same error message: the second drain
      // must RUN (not be cold-skipped) and classify the error as unchanged.
      fs.writeFileSync(path.join(fixture, "src.ts"), "export const n: number = 'a';\n");
      const first = await postEditResult(state, "write", { path: "src.ts" }, fixture, false);
      expect(first?.notify).toContain("not assignable");

      fs.writeFileSync(path.join(fixture, "src.ts"), "export const n: number = 'b';\n");
      const second = await postEditResult(state, "write", { path: "src.ts" }, fixture, false);
      expect(second).not.toBeNull();
      expect(second?.appended).toContain("0 new, 1 unchanged");
      // Unchanged errors still notify, but in collapsed form (per README).
      expect(second?.notify).toContain("1 unchanged");
      expect(second?.notify).not.toContain("not assignable");
    },
    90_000,
  );

  test.skipIf(!hasBinary("typescript-language-server"))(
    "engine: runAction symbols/hover/diagnostics/references/workspace_symbol/restart against a live server",
    async () => {
      const fixture = mkFixture("engine-actions", {
        "package.json": "{}",
        "src.ts":
          '/** Greets the user. */\nexport function greet(name: string): string {\n  return "hello " + name;\n}\ngreet("world");\n',
      });
      const { state } = startEngineSession(fixture);

      const symbols = await runAction(state, { action: "symbols", file: "src.ts" }, fixture);
      expect(symbols).toContain("Symbols in src.ts:");
      expect(symbols).toContain("greet");

      const hover = await runAction(state, { action: "hover", file: "src.ts", line: 2, symbol: "greet" }, fixture);
      expect(hover).toContain("string");

      const diags = await runAction(state, { action: "diagnostics", file: "src.ts" }, fixture);
      expect(diags).toBe("No diagnostics"); // the fixture file is clean

      const refs = await runAction(state, { action: "references", file: "src.ts", line: 2, symbol: "greet" }, fixture);
      expect(refs).toContain("reference(s)");
      expect(refs).toContain("greet");

      const ws = await runAction(state, { action: "workspace_symbol", query: "greet" }, fixture);
      expect(ws).toContain('Workspace symbols matching "greet"');
      expect(ws).toContain("greet");

      const report = statusReport(state);
      expect(report).toContain("ts ("); // display name + file types
      expect(report).toContain("running");

      const restarted = await restartAllClients(state);
      expect(restarted).toBe("Restarted 1 server(s): typescript-language-server");
    },
    90_000,
  );

  test.skipIf(!hasBinary("typescript-language-server"))(
    "engine: codeAction lists and applies a quickfix (remove unused declaration)",
    async () => {
      const fixture = mkFixture("engine-codeaction", {
        "package.json": "{}",
        "tsconfig.json": '{ "compilerOptions": { "noUnusedLocals": true } }',
        "src.ts": "const unusedVar = 1;\nexport const used = 2;\n",
      });
      const { state } = startEngineSession(fixture);
      const file = path.join(fixture, "src.ts");

      // Warm the server + populate its diagnostics for this file.
      const drained = await postEditResult(state, "write", { path: "src.ts" }, fixture, false);
      expect(drained?.errored).toBe(true);

      const listed = await runAction(state, { action: "codeAction", file: "src.ts", line: 1 }, fixture);
      expect(listed).toContain("Remove unused declaration");

      const applied = await runAction(
        state,
        { action: "codeActionApply", file: "src.ts", line: 1, name: "Remove unused declaration" },
        fixture,
      );
      expect(applied).toContain("Applied");
      expect(applied).toContain("src.ts");
      expect(fs.readFileSync(file, "utf-8")).not.toContain("unusedVar");

      const after = await runAction(state, { action: "diagnostics", file: "src.ts" }, fixture);
      expect(after).toBe("No diagnostics");
    },
    90_000,
  );

  test.skipIf(!hasBinary("typescript-language-server"))(
    "engine: rename updates the file and its call site",
    async () => {
      const fixture = mkFixture("engine-rename", {
        "package.json": "{}",
        "src.ts": 'export function greet(name: string): string {\n  return "hello " + name;\n}\ngreet("world");\n',
      });
      const { state } = startEngineSession(fixture);

      const renamed = await runAction(
        state,
        { action: "rename", file: "src.ts", line: 1, symbol: "greet", new_name: "salute" },
        fixture,
      );
      expect(renamed).toContain('Renamed to "salute"');
      const content = fs.readFileSync(path.join(fixture, "src.ts"), "utf-8");
      expect(content).toContain("salute(");
      expect(content).not.toContain("greet");
    },
    90_000,
  );

  test.skipIf(!hasBinary("typescript-language-server"))(
    "engine: postBashResult drains watcher-buffered changes",
    async () => {
      const fixture = mkFixture("engine-bash", {
        "package.json": "{}",
        "src.ts": "export const n: number = 1;\n",
      });
      const { state } = startEngineSession(fixture);
      const abs = path.join(fixture, "src.ts");

      // Seed a watcher event for the write: postEditResult must consume it so
      // the file isn't re-reported as "changed by bash" on the next drain.
      state.recentChanges.set(abs, { type: WatchChangeType.Changed, ts: Date.now() });
      // Warm the server on this file first (via an edit drain), then simulate
      // a bash command that broke it: a watcher event lands in recentChanges.
      await postEditResult(state, "write", { path: "src.ts" }, fixture, false);
      expect(state.recentChanges.has(abs)).toBe(false);
      fs.writeFileSync(abs, "export const n: number = 'broken';\n");
      state.recentChanges.set(abs, { type: WatchChangeType.Changed, ts: Date.now() });

      const result = await postBashResult(state, fixture);
      expect(result).not.toBeNull();
      expect(result?.appended).toContain("[LSP diagnostics (");
      expect(result?.errored).toBe(true);
      expect(result?.notify).toContain("not assignable");
      // Reported entries are consumed; a failed diagnostics run would keep
      // them queued for the next drain instead.
      expect(state.recentChanges.has(abs)).toBe(false);

      // Fix the file and drain again: a clean bash batch collapses to one line.
      fs.writeFileSync(abs, "export const n: number = 1;\n");
      state.recentChanges.set(abs, { type: WatchChangeType.Changed, ts: Date.now() });
      const clean = await postBashResult(state, fixture);
      expect(clean?.appended).toContain("1 file clean");
      expect(clean?.notify).toBeNull();
    },
    90_000,
  );

  test.skipIf(!hasBinary("typescript-language-server"))(
    "engine: status facts push running servers to the host",
    async () => {
      const fixture = mkFixture("engine-status", {
        "package.json": "{}",
        "src.ts": "export const n: number = 1;\n",
      });
      const { state, statusCalls } = startEngineSession(fixture);

      await postEditResult(state, "write", { path: "src.ts" }, fixture, false);
      // The text report reflects the live client...
      expect(statusReport(state)).toContain("running");
      // ...and a status push (here via restart) carries the running server name.
      await restartAllClients(state);
      expect(statusCalls.some((s) => s.running.includes("ts"))).toBe(true);
    },
    90_000,
  );
});
