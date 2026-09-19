import { describe, expect, test } from "bun:test";
import type { Message } from "@earendil-works/pi-ai";
import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { renderCall, renderResult } from "./render";
import {
  formatTokens,
  formatToolCall,
  formatUsageStats,
  getDisplayTurns,
  getFinalOutput,
  type SingleResult,
  type SubagentDetails,
  type UsageStats,
} from "./rpc";

// ── Mock theme ──

function mockTheme(): Theme {
  return {
    fg: (_color: ThemeColor, text: string) => text,
    bold: (text: string) => `**${text}**`,
    italic: (text: string) => `[italic]${text}[/italic]`,
  } as Theme;
}

// ── formatTokens ──

describe("formatTokens", () => {
  test("shows raw number under 1000", () => {
    expect(formatTokens(42)).toBe("42");
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(999)).toBe("999");
  });

  test("shows 1-decimal k for 1k-10k", () => {
    expect(formatTokens(1500)).toBe("1.5k");
    expect(formatTokens(1000)).toBe("1.0k");
    expect(formatTokens(9999)).toBe("10.0k");
  });

  test("shows rounded k for 10k-1M", () => {
    expect(formatTokens(15000)).toBe("15k");
    expect(formatTokens(10000)).toBe("10k");
    expect(formatTokens(999999)).toBe("1000k");
  });

  test("shows 1-decimal M for 1M+", () => {
    expect(formatTokens(1500000)).toBe("1.5M");
    expect(formatTokens(1000000)).toBe("1.0M");
  });
});

// ── formatUsageStats ──

describe("formatUsageStats", () => {
  test("formats turns, tokens, and cost", () => {
    const usage: UsageStats = {
      input: 1000,
      output: 500,
      cacheRead: 200,
      cacheWrite: 100,
      cost: 0.0123,
      contextTokens: 0,
      turns: 3,
    };
    const result = formatUsageStats(usage);
    expect(result).toContain("3 turns");
    expect(result).toContain("↑1.0k");
    expect(result).toContain("↓500");
    expect(result).toContain("R200");
    expect(result).toContain("W100");
    expect(result).toContain("$0.0123");
  });

  test("omits zero fields", () => {
    const usage: UsageStats = {
      input: 0,
      output: 100,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      contextTokens: 0,
      turns: 0,
    };
    const result = formatUsageStats(usage);
    expect(result).toBe("↓100");
  });

  test("includes context tokens when > 0", () => {
    const usage: UsageStats = {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      contextTokens: 50000,
      turns: 0,
    };
    expect(formatUsageStats(usage)).toContain("ctx:50k");
  });

  test("appends model name", () => {
    const usage: UsageStats = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
    expect(formatUsageStats(usage, "anthropic/claude-sonnet-4")).toContain("anthropic/claude-sonnet-4");
  });
});

// ── getFinalOutput ──

describe("getFinalOutput", () => {
  test("returns text from last assistant message", () => {
    const messages: Message[] = [
      { role: "assistant", content: [{ type: "text", text: "first" }], timestamp: 0 } as Message,
      { role: "assistant", content: [{ type: "text", text: "last" }], timestamp: 0 } as Message,
    ];
    expect(getFinalOutput(messages)).toBe("last");
  });

  test("returns empty string for no assistant messages", () => {
    expect(getFinalOutput([])).toBe("");
    expect(
      getFinalOutput([
        { role: "toolResult", content: [], timestamp: 0, toolCallId: "", toolName: "", isError: false },
      ] as Message[]),
    ).toBe("");
  });

  test("skips non-text content parts", () => {
    const messages: Message[] = [
      { role: "assistant", content: [{ type: "toolCall", name: "read", arguments: {} }], timestamp: 0 } as Message,
    ];
    expect(getFinalOutput(messages)).toBe("");
  });
});

// ── getDisplayTurns ──

describe("getDisplayTurns", () => {
  test("groups assistant content into turns with thinking/text/toolCall", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "hmm" },
          { type: "text", text: "checking" },
          { type: "toolCall", name: "bash", arguments: { command: "ls" } },
        ],
        timestamp: 0,
      } as Message,
      {
        role: "toolResult",
        content: [{ type: "text", text: "result" }],
        timestamp: 0,
        toolCallId: "c1",
        toolName: "bash",
        isError: false,
      } as Message,
      { role: "assistant", content: [{ type: "text", text: "done" }], timestamp: 0 } as Message,
    ];
    const turns = getDisplayTurns(messages);
    expect(turns).toHaveLength(2);
    expect(turns[0].turn).toBe(1);
    expect(turns[0].items).toEqual([
      { type: "thinking", text: "hmm" },
      { type: "text", text: "checking" },
      { type: "toolCall", name: "bash", args: { command: "ls" } },
    ]);
    expect(turns[1].turn).toBe(2);
    expect(turns[1].items).toEqual([{ type: "text", text: "done" }]);
  });

  test("skips empty text and thinking parts", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "" },
          { type: "thinking", thinking: "" },
          { type: "toolCall", name: "read", arguments: { path: "foo.ts" } },
        ],
        timestamp: 0,
      } as Message,
    ];
    const turns = getDisplayTurns(messages);
    expect(turns).toHaveLength(1);
    expect(turns[0].items).toEqual([{ type: "toolCall", name: "read", args: { path: "foo.ts" } }]);
  });
});

// ── formatToolCall ──

describe("formatToolCall", () => {
  const theme = mockTheme();

  test("formats bash command", () => {
    const result = formatToolCall("bash", { command: "ls -la" }, theme.fg);
    expect(result).toContain("$");
    expect(result).toContain("ls -la");
  });

  test("keeps long bash commands in full", () => {
    const longCmd = "a".repeat(80);
    const result = formatToolCall("bash", { command: longCmd }, theme.fg);
    expect(result).toContain(longCmd);
    expect(result).not.toContain("...");
  });

  test("formats read with tilde for home paths", () => {
    const result = formatToolCall("read", { path: "/Users/test/file.ts" }, theme.fg);
    // Won't shorten unless it matches actual os.homedir(), but should contain "read"
    expect(result).toContain("read ");
  });

  test("formats unknown tools with JSON preview", () => {
    const result = formatToolCall("custom_tool", { key: "val" }, theme.fg);
    expect(result).toContain("custom_tool");
    expect(result).toContain("key");
  });

  test("unknown tools show full args, no truncation", () => {
    const longValue = "x".repeat(200);
    const result = formatToolCall("custom_tool", { query: longValue }, theme.fg);
    expect(result).toContain(longValue);
    expect(result).not.toContain("...");
  });
});

// ── renderCall ──

describe("renderCall", () => {
  const theme = mockTheme();

  test("renders single mode with agent name and task", () => {
    const result = renderCall({ agent: "researcher", task: "find all TODOs" }, theme, {});
    const text = result.render(80).join("\n");
    expect(text).toContain("researcher");
    expect(text).toContain("find all TODOs");
  });

  test("renders parallel mode with task count", () => {
    const result = renderCall(
      {
        tasks: [
          { agent: "a", task: "t1" },
          { agent: "b", task: "t2" },
        ],
      },
      theme,
      {},
    );
    const text = result.render(80).join("\n");
    expect(text).toContain("parallel");
    expect(text).toContain("2 tasks");
  });

  test("a one-item tasks batch renders as single", () => {
    const result = renderCall({ tasks: [{ agent: "reviewer", task: "review the change" }] }, theme, {});
    const text = result.render(80).join("\n");
    expect(text).toContain("reviewer");
    expect(text).not.toContain("parallel");
  });

  test("renders chain mode with step count", () => {
    const result = renderCall(
      {
        chain: [
          { agent: "a", task: "step 1" },
          { agent: "b", task: "step 2 {previous}" },
        ],
      },
      theme,
      {},
    );
    const text = result.render(80).join("\n");
    expect(text).toContain("chain");
    expect(text).toContain("2 steps");
  });

  test("shows scope in bracket", () => {
    const result = renderCall({ agent: "x", task: "t", agentScope: "both" }, theme, {});
    expect(result.render(80).join("\n")).toContain("[both]");
  });

  test("expanded shows full task, collapsed truncates", () => {
    const longTask = "a very long delegated task ".repeat(10);
    const collapsed = renderCall({ agent: "researcher", task: longTask }, theme, { expanded: false })
      .render(80)
      .join("\n");
    expect(collapsed).toContain("...");
    // Render wider than the task so it isn't wrapped; expanded must show it whole.
    const expanded = renderCall({ agent: "researcher", task: longTask }, theme, { expanded: true })
      .render(400)
      .join("\n");
    expect(expanded).toContain(longTask);
  });
});

// ── renderResult ──

describe("renderResult", () => {
  const theme = mockTheme();

  function makeSingleResult(overrides: Partial<SingleResult> = {}): SingleResult {
    return {
      agent: "researcher",
      agentSource: "user",
      task: "find TODOs",
      exitCode: 0,
      messages: [],
      stderr: "",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
      ...overrides,
    };
  }

  test("renders single success", () => {
    const details: SubagentDetails = {
      mode: "single",
      agentScope: "user",
      projectAgentsDir: null,
      results: [makeSingleResult()],
    };
    const result = renderResult(
      { content: [{ type: "text", text: "done" }], details },
      { expanded: false, isPartial: false },
      theme,
      {},
    );
    const text = result.render(80).join("\n");
    expect(text).toContain("researcher");
    expect(text).toContain("(user)");
  });

  test("renders single error with stop reason", () => {
    const details: SubagentDetails = {
      mode: "single",
      agentScope: "user",
      projectAgentsDir: null,
      results: [makeSingleResult({ exitCode: 1, stopReason: "max_turns_exceeded" })],
    };
    const result = renderResult(
      { content: [{ type: "text", text: "error" }], details },
      { expanded: false, isPartial: false },
      theme,
      {},
    );
    expect(result.render(80).join("\n")).toContain("max_turns_exceeded");
  });

  test("chain collapsed hint only when content is hidden", () => {
    const emptyDetails: SubagentDetails = {
      mode: "chain",
      agentScope: "user",
      projectAgentsDir: null,
      results: [makeSingleResult({ agent: "a", step: 1 })],
    };
    const noHint = renderResult(
      { content: [], details: emptyDetails },
      { expanded: false, isPartial: false },
      theme,
      {},
    )
      .render(80)
      .join("\n");
    expect(noHint).not.toContain("(Ctrl+O to expand)");

    const withThinking = {
      ...emptyDetails,
      results: [
        makeSingleResult({
          agent: "a",
          step: 1,
          messages: [{ role: "assistant", content: [{ type: "thinking", thinking: "hmm" }], timestamp: 0 } as Message],
        }),
      ],
    };
    const hint = renderResult({ content: [], details: withThinking }, { expanded: false, isPartial: false }, theme, {})
      .render(80)
      .join("\n");
    expect(hint).toContain("(Ctrl+O to expand)");
  });

  test("parallel expanded mid-run shows completed turns and running placeholder", () => {
    const done = makeSingleResult({
      agent: "a",
      messages: [{ role: "assistant", content: [{ type: "text", text: "done report" }], timestamp: 0 } as Message],
    });
    const running = makeSingleResult({ agent: "b", exitCode: -1, messages: [] });
    const details: SubagentDetails = {
      mode: "parallel",
      agentScope: "user",
      projectAgentsDir: null,
      results: [done, running],
    };
    const result = renderResult({ content: [], details }, { expanded: true, isPartial: false }, theme, {})
      .render(80)
      .join("\n");
    expect(result).toContain("done report"); // completed agent's full turns
    expect(result).toContain("(running...)"); // running agent placeholder
    expect(result).toContain("Task: find TODOs");

    const collapsed = renderResult({ content: [], details }, { expanded: false, isPartial: false }, theme, {})
      .render(80)
      .join("\n");
    expect(collapsed).toContain("parallel");
    expect(collapsed).toContain("1/2 done, 1 running");
  });

  test("renders chain results with step numbers", () => {
    const details: SubagentDetails = {
      mode: "chain",
      agentScope: "user",
      projectAgentsDir: null,
      results: [makeSingleResult({ agent: "step1", step: 1 }), makeSingleResult({ agent: "step2", step: 2 })],
    };
    const result = renderResult(
      { content: [{ type: "text", text: "" }], details },
      { expanded: false, isPartial: false },
      theme,
      {},
    );
    const text = result.render(80).join("\n");
    expect(text).toContain("chain");
    expect(text).toContain("2/2 steps");
    expect(text).toContain("Step 1");
    expect(text).toContain("Step 2");
  });

  test("renders partial streaming result", () => {
    const result = renderResult(
      { content: [{ type: "text", text: "thinking..." }] },
      { expanded: false, isPartial: true },
      theme,
      {},
    );
    expect(result.render(80).join("\n")).toContain("thinking...");
  });

  test("collapsed shows last few turns' commands in full, not all turns", () => {
    const longCmd = "rg -n 'pattern-that-exceeds-sixty-characters' config/llm/pi/extensions --include '*.ts'";
    const messages: Message[] = [];
    for (let i = 1; i <= 5; i++) {
      messages.push({
        role: "assistant",
        content: [
          { type: "text", text: `turn ${i} narration` },
          { type: "toolCall", name: "bash", arguments: { command: i === 5 ? longCmd : `echo turn ${i}` } },
        ],
        timestamp: 0,
      } as Message);
    }
    const details: SubagentDetails = {
      mode: "single",
      agentScope: "user",
      projectAgentsDir: null,
      results: [makeSingleResult({ messages })],
    };
    const result = renderResult(
      { content: [{ type: "text", text: "" }], details },
      { expanded: false, isPartial: false },
      theme,
      {},
    );
    const text = result.render(80).join("\n");
    expect(text).toContain("2 earlier turns"); // 5 turns, showing the last 3
    expect(text).toContain("echo turn 3");
    expect(text).toContain("echo turn 4");
    expect(text).not.toContain("echo turn 1");
    expect(text).not.toContain("echo turn 2");
    expect(text).not.toContain("turn 2 narration"); // no intermediate text details
    expect(text).toContain("turn 5 narration"); // final output preview
    // Command tail would have been cut by the old 60-char truncation — must survive here.
    expect(text).toContain("--include '*.ts'");
    expect(text).not.toContain("...");
    expect(text).toContain("(Ctrl+O to expand)");
  });

  test("expanded shows all turns with thinking styled separately", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "let me think" },
          { type: "text", text: "first turn output" },
          { type: "toolCall", name: "read", arguments: { path: "a.ts" } },
        ],
        timestamp: 0,
      } as Message,
      { role: "assistant", content: [{ type: "text", text: "final report" }], timestamp: 0 } as Message,
    ];
    const details: SubagentDetails = {
      mode: "single",
      agentScope: "user",
      projectAgentsDir: null,
      results: [makeSingleResult({ messages })],
    };
    const result = renderResult(
      { content: [{ type: "text", text: "" }], details },
      { expanded: true, isPartial: false },
      theme,
      {},
    );
    const text = result.render(80).join("\n");
    expect(text).toContain("─── Task ───");
    expect(text).toContain("Turn 1");
    expect(text).toContain("Turn 2");
    expect(text).toContain("[italic]let me think[/italic]");
    expect(text).toContain("first turn output");
    expect(text).toContain("final report");
    expect(text).toContain("read a.ts");
    expect(text).not.toContain("(Ctrl+O to expand)");
  });

  test("partial streaming styles thinking blocks", () => {
    const result = renderResult(
      {
        content: [
          { type: "thinking", text: "reasoning..." },
          { type: "text", text: "checking" },
          { type: "toolCall", name: "bash", args: { command: "git status" } },
        ],
      },
      { expanded: false, isPartial: true },
      theme,
      {},
    );
    const text = result.render(80).join("\n");
    expect(text).toContain("[italic]reasoning...[/italic]");
    expect(text).toContain("checking");
    expect(text).toContain("git status");
  });

  test("partial streaming separates type transitions with newlines", () => {
    const result = renderResult(
      {
        content: [
          { type: "thinking", text: "think about it" },
          { type: "thinking", text: " more" },
          { type: "text", text: "output" },
          { type: "text", text: " continues" },
          { type: "toolCall", name: "bash", args: { command: "ls" } },
          { type: "text", text: "after" },
        ],
      },
      { expanded: true, isPartial: true },
      theme,
      {},
    );
    const text = result.render(80).join("\n");
    // strip per-line width padding before asserting multi-line substrings
    const stripped = text
      .split("\n")
      .map((l) => l.trimEnd())
      .join("\n");
    // deltas glue within a type, transitions get newlines
    expect(stripped).toContain("[italic]think about it more[/italic]\noutput continues");
    expect(stripped).toContain("output continues\n→ $ ls\nafter");
  });

  test("partial collapsed caps thinking to one line, expanded shows full", () => {
    const content = [{ type: "thinking", text: "line one\nline two\nline three" }];
    const strip = (t: string) =>
      t
        .split("\n")
        .map((l) => l.trimEnd())
        .join("\n");
    const collapsed = strip(
      renderResult({ content }, { expanded: false, isPartial: true }, theme, {}).render(80).join("\n"),
    );
    expect(collapsed).toContain("[italic]… line three[/italic]");
    expect(collapsed).not.toContain("line one");
    const expanded = strip(
      renderResult({ content }, { expanded: true, isPartial: true }, theme, {}).render(80).join("\n"),
    );
    expect(expanded).toContain("[italic]line one\nline two\nline three[/italic]");
  });

  test("partial collapsed caps text to last few lines", () => {
    const content = [{ type: "text", text: "a\nb\nc\nd\ne\nf\ng" }];
    const strip = (t: string) =>
      t
        .split("\n")
        .map((l) => l.trimEnd())
        .join("\n");
    const collapsed = strip(
      renderResult({ content }, { expanded: false, isPartial: true }, theme, {}).render(80).join("\n"),
    );
    expect(collapsed).toContain("… 2 more lines");
    expect(collapsed).toContain("f\ng");
    expect(collapsed).not.toContain("\na");
  });

  test("expanded shows steering inputs interleaved at their turn boundary", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "first turn" },
          { type: "toolCall", name: "bash", arguments: { command: "ls" } },
        ],
        timestamp: 0,
      } as Message,
      { role: "assistant", content: [{ type: "text", text: "second turn" }], timestamp: 0 } as Message,
    ];
    const details: SubagentDetails = {
      mode: "single",
      agentScope: "user",
      projectAgentsDir: null,
      results: [makeSingleResult({ messages, userInputs: [{ text: "check the tests too", turn: 1 }] })],
    };
    const result = renderResult(
      { content: [{ type: "text", text: "" }], details },
      { expanded: true, isPartial: false },
      theme,
      {},
    );
    const text = result.render(80).join("\n");
    expect(text).toContain("**steering: **"); // mock bold marker
    expect(text).toContain("check the tests too");
    expect(text.indexOf("check the tests too")).toBeLessThan(text.indexOf("Turn 2"));
    expect(text.indexOf("check the tests too")).toBeGreaterThan(text.indexOf("Turn 1"));
  });

  test("partial streaming shows steering input", () => {
    const result = renderResult(
      {
        content: [
          { type: "text", text: "looking" },
          { type: "user", text: "focus on tests" },
        ],
      },
      { expanded: false, isPartial: true },
      theme,
      {},
    );
    const text = result.render(80).join("\n");
    expect(text).toContain("**steering: **");
    expect(text).toContain("focus on tests");
  });

  test("thinking-only collapsed run shows placeholder and expand hint", () => {
    const messages: Message[] = [
      { role: "assistant", content: [{ type: "thinking", thinking: "deep reasoning" }], timestamp: 0 } as Message,
    ];
    const details: SubagentDetails = {
      mode: "single",
      agentScope: "user",
      projectAgentsDir: null,
      results: [makeSingleResult({ messages })],
    };
    const result = renderResult(
      { content: [{ type: "text", text: "" }], details },
      { expanded: false, isPartial: false },
      theme,
      {},
    );
    const text = result.render(80).join("\n");
    expect(text).toContain("(thinking only)");
    expect(text).toContain("(Ctrl+O to expand)");
  });

  test("collapsed shows late steering input after the last shown turn", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "t1" },
          { type: "toolCall", name: "bash", arguments: { command: "echo 1" } },
        ],
        timestamp: 0,
      } as Message,
      {
        role: "assistant",
        content: [
          { type: "text", text: "t2" },
          { type: "toolCall", name: "bash", arguments: { command: "echo 2" } },
        ],
        timestamp: 0,
      } as Message,
    ];
    const details: SubagentDetails = {
      mode: "single",
      agentScope: "user",
      projectAgentsDir: null,
      results: [makeSingleResult({ messages, userInputs: [{ text: "wrap it up", turn: 2 }] })],
    };
    const result = renderResult(
      { content: [{ type: "text", text: "" }], details },
      { expanded: false, isPartial: false },
      theme,
      {},
    );
    const text = result.render(80).join("\n");
    expect(text).toContain("wrap it up"); // steer after final turn still visible
    expect(text.indexOf("wrap it up")).toBeGreaterThan(text.indexOf("echo 2"));
  });

  test("expanded mode shows full output and usage", () => {
    const details: SubagentDetails = {
      mode: "single",
      agentScope: "user",
      projectAgentsDir: null,
      results: [
        makeSingleResult({
          usage: {
            input: 5000,
            output: 2000,
            cacheRead: 0,
            cacheWrite: 0,
            cost: 0.05,
            contextTokens: 100000,
            turns: 5,
          },
        }),
      ],
    };
    const result = renderResult(
      { content: [{ type: "text", text: "done" }], details },
      { expanded: true, isPartial: false },
      theme,
      {},
    );
    const text = result.render(80).join("\n");
    expect(text).toContain("5 turns");
    expect(text).toContain("↑5.0k");
    expect(text).toContain("ctx:100k");
  });
});
