import { describe, expect, test } from "bun:test";
import { fmt, loadProviders, mapWithConcurrency, parseModelArgs, resolveRoleModels } from "./shared";

// ── mapWithConcurrency ──

describe("mapWithConcurrency", () => {
  test("preserves input order regardless of completion order", async () => {
    const out = await mapWithConcurrency([30, 5, 15, 1], 4, async (ms) => {
      await new Promise((r) => setTimeout(r, ms));
      return ms;
    });
    expect(out).toEqual([30, 5, 15, 1]);
  });

  test("never exceeds the limit", async () => {
    let active = 0;
    let peak = 0;
    await mapWithConcurrency([...Array(10).keys()], 3, async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return 0;
    });
    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(1);
  });

  test("handles empty input and limits above the item count", async () => {
    expect(await mapWithConcurrency([], 4, async () => 1)).toEqual([]);
    expect(await mapWithConcurrency([1, 2], 8, async (n) => n * 2)).toEqual([2, 4]);
  });
});

// ── fmt ──

describe("fmt", () => {
  test("formats single value", () => {
    expect(fmt("safe")).toBe("safe");
  });

  test("joins array with pipe", () => {
    expect(fmt(["risky", "dangerous"])).toBe("risky|dangerous");
  });

  test("handles single-element array", () => {
    expect(fmt(["safe"])).toBe("safe");
  });
});

// ── loadProviders ──

describe("loadProviders", () => {
  test("returns empty for missing file", () => {
    const result = loadProviders("/nonexistent/path/models.json");
    expect(result).toEqual({});
  });

  test("returns empty for invalid JSON", () => {
    const { writeFileSync, mkdirSync, rmSync } = require("node:fs") as typeof import("node:fs");
    const { tmpdir } = require("node:os") as typeof import("node:os");
    const { join } = require("node:path") as typeof import("node:path");
    const tmp = join(tmpdir(), `bench-test-${process.pid}`);
    mkdirSync(tmp, { recursive: true });
    const fp = join(tmp, "bad.json");
    writeFileSync(fp, "not json");
    expect(loadProviders(fp)).toEqual({});
    rmSync(tmp, { recursive: true, force: true });
  });

  test("parses valid models.json", () => {
    const { writeFileSync, mkdirSync, rmSync } = require("node:fs") as typeof import("node:fs");
    const { tmpdir } = require("node:os") as typeof import("node:os");
    const { join } = require("node:path") as typeof import("node:path");
    const tmp = join(tmpdir(), `bench-test-${process.pid}`);
    mkdirSync(tmp, { recursive: true });
    const fp = join(tmp, "models.json");
    writeFileSync(
      fp,
      JSON.stringify({
        providers: {
          test: {
            baseUrl: "http://localhost:1234/v1",
            apiKey: "test-key",
            models: [{ id: "model-a", name: "Model A" }],
          },
        },
      }),
    );
    const providers = loadProviders(fp);
    expect(providers.test.baseUrl).toBe("http://localhost:1234/v1");
    expect(providers.test.models).toHaveLength(1);
    rmSync(tmp, { recursive: true, force: true });
  });
});

// ── resolveRoleModels ──

const FIXTURE_DIR = (() => {
  const { tmpdir } = require("node:os") as typeof import("node:os");
  return require("node:path").join(tmpdir(), `bench-test-${process.pid}`);
})();

function writeFixtures(providers: object, roles: object) {
  const { writeFileSync, mkdirSync } = require("node:fs") as typeof import("node:fs");
  const { join } = require("node:path") as typeof import("node:path");
  mkdirSync(FIXTURE_DIR, { recursive: true });
  writeFileSync(join(FIXTURE_DIR, "models.json"), JSON.stringify({ providers }));
  writeFileSync(join(FIXTURE_DIR, "roles.json"), JSON.stringify(roles));
}

function cleanupFixtures() {
  const { rmSync } = require("node:fs") as typeof import("node:fs");
  rmSync(FIXTURE_DIR, { recursive: true, force: true });
}

describe("resolveRoleModels", () => {
  const providers = {
    local: {
      baseUrl: "http://localhost:8080/v1",
      apiKey: "plain-key",
      models: [
        { id: "qwen-small", name: "Qwen Small" },
        { id: "qwen-large", name: "Qwen Large" },
      ],
    },
    cloud: {
      baseUrl: "https://api.example.com/v1",
      apiKey: "!echo secret-key",
      models: [{ id: "gpt-5-mini" }],
    },
    nokey: {
      baseUrl: "http://localhost:9999/v1",
      models: [{ id: "local-model" }],
    },
  };

  test("resolves all models for a role when given filters", () => {
    writeFixtures(providers, {
      explain: {
        maxTokens: 256,
        models: [{ ref: "local/qwen-small" }, { ref: "cloud/gpt-5-mini" }],
      },
    });
    try {
      const models = resolveRoleModels("explain", ["qwen", "gpt"], {
        rolesPath: `${FIXTURE_DIR}/roles.json`,
        providersPath: `${FIXTURE_DIR}/models.json`,
      });
      expect(models).toHaveLength(2);
      expect(models[0].model).toBe("qwen-small");
      expect(models[1].model).toBe("gpt-5-mini");
    } finally {
      cleanupFixtures();
    }
  });

  test("defaults to first model when no filters given", () => {
    writeFixtures(providers, {
      explain: {
        maxTokens: 256,
        models: [{ ref: "local/qwen-small" }, { ref: "cloud/gpt-5-mini" }],
      },
    });
    try {
      const models = resolveRoleModels("explain", undefined, {
        rolesPath: `${FIXTURE_DIR}/roles.json`,
        providersPath: `${FIXTURE_DIR}/models.json`,
      });
      expect(models).toHaveLength(1);
      expect(models[0].model).toBe("qwen-small");
    } finally {
      cleanupFixtures();
    }
  });

  test("picks up requestParams from role config", () => {
    writeFixtures(providers, {
      draft: {
        maxTokens: 128,
        models: [{ ref: "local/qwen-small", requestParams: { chat_template_kwargs: { enable_thinking: false } } }],
      },
    });
    try {
      const [m] = resolveRoleModels("draft", undefined, {
        rolesPath: `${FIXTURE_DIR}/roles.json`,
        providersPath: `${FIXTURE_DIR}/models.json`,
      });
      expect(m.extra).toEqual({ chat_template_kwargs: { enable_thinking: false } });
      expect(m.maxTokens).toBe(128);
    } finally {
      cleanupFixtures();
    }
  });

  test("uses role maxTokens as default", () => {
    writeFixtures(providers, {
      explain: {
        maxTokens: 512,
        models: [{ ref: "local/qwen-small" }],
      },
    });
    try {
      const [m] = resolveRoleModels("explain", undefined, {
        rolesPath: `${FIXTURE_DIR}/roles.json`,
        providersPath: `${FIXTURE_DIR}/models.json`,
      });
      expect(m.maxTokens).toBe(512);
    } finally {
      cleanupFixtures();
    }
  });

  test("defaults maxTokens to 256 when role omits it", () => {
    writeFixtures(providers, {
      minimal: {
        models: [{ ref: "local/qwen-small" }],
      },
    });
    try {
      const [m] = resolveRoleModels("minimal", undefined, {
        rolesPath: `${FIXTURE_DIR}/roles.json`,
        providersPath: `${FIXTURE_DIR}/models.json`,
      });
      expect(m.maxTokens).toBe(256);
    } finally {
      cleanupFixtures();
    }
  });

  test("resolves !command apiKey", () => {
    writeFixtures(providers, {
      test: { models: [{ ref: "cloud/gpt-5-mini" }] },
    });
    try {
      const [m] = resolveRoleModels("test", undefined, {
        rolesPath: `${FIXTURE_DIR}/roles.json`,
        providersPath: `${FIXTURE_DIR}/models.json`,
      });
      expect(m.apiKey).toBe("secret-key");
    } finally {
      cleanupFixtures();
    }
  });

  test("handles missing apiKey", () => {
    writeFixtures(providers, {
      test: { models: [{ ref: "nokey/local-model" }] },
    });
    try {
      const [m] = resolveRoleModels("test", undefined, {
        rolesPath: `${FIXTURE_DIR}/roles.json`,
        providersPath: `${FIXTURE_DIR}/models.json`,
      });
      expect(m.apiKey).toBeUndefined();
    } finally {
      cleanupFixtures();
    }
  });

  test("uses model name as label", () => {
    writeFixtures(providers, {
      test: { models: [{ ref: "local/qwen-small" }] },
    });
    try {
      const [m] = resolveRoleModels("test", undefined, {
        rolesPath: `${FIXTURE_DIR}/roles.json`,
        providersPath: `${FIXTURE_DIR}/models.json`,
      });
      expect(m.label).toBe("Qwen Small");
    } finally {
      cleanupFixtures();
    }
  });

  test("falls back to ref as label when no model name", () => {
    writeFixtures(providers, {
      test: { models: [{ ref: "cloud/gpt-5-mini" }] },
    });
    try {
      const [m] = resolveRoleModels("test", undefined, {
        rolesPath: `${FIXTURE_DIR}/roles.json`,
        providersPath: `${FIXTURE_DIR}/models.json`,
      });
      expect(m.label).toBe("cloud/gpt-5-mini");
    } finally {
      cleanupFixtures();
    }
  });

  test("filters to matching models with modelFilters", () => {
    writeFixtures(providers, {
      draft: {
        models: [{ ref: "local/qwen-small" }, { ref: "cloud/gpt-5-mini" }, { ref: "local/qwen-large" }],
      },
    });
    try {
      const models = resolveRoleModels("draft", ["qwen"], {
        rolesPath: `${FIXTURE_DIR}/roles.json`,
        providersPath: `${FIXTURE_DIR}/models.json`,
      });
      expect(models).toHaveLength(2);
      expect(models.map((m) => m.ref)).toEqual(["local/qwen-small", "local/qwen-large"]);
    } finally {
      cleanupFixtures();
    }
  });

  test("throws for unknown role", () => {
    writeFixtures(providers, {});
    try {
      expect(() =>
        resolveRoleModels("nonexistent", undefined, {
          rolesPath: `${FIXTURE_DIR}/roles.json`,
          providersPath: `${FIXTURE_DIR}/models.json`,
        }),
      ).toThrow('Role "nonexistent" not found');
    } finally {
      cleanupFixtures();
    }
  });

  test("throws for invalid ref format", () => {
    writeFixtures(providers, {
      test: { models: [{ ref: "no-slash" }] },
    });
    try {
      expect(() =>
        resolveRoleModels("test", undefined, {
          rolesPath: `${FIXTURE_DIR}/roles.json`,
          providersPath: `${FIXTURE_DIR}/models.json`,
        }),
      ).toThrow('Invalid ref "no-slash"');
    } finally {
      cleanupFixtures();
    }
  });

  test("resolves custom model from models.json provider", () => {
    writeFixtures(providers, {
      test: { models: [{ ref: "local/nonexistent" }] },
    });
    try {
      // Custom provider has baseUrl but model isn't in models array — still resolves
      // because we only need baseUrl + model id for the HTTP call
      const [m] = resolveRoleModels("test", undefined, {
        rolesPath: `${FIXTURE_DIR}/roles.json`,
        providersPath: `${FIXTURE_DIR}/models.json`,
      });
      expect(m.baseUrl).toBe("http://localhost:8080/v1");
      expect(m.model).toBe("nonexistent");
    } finally {
      cleanupFixtures();
    }
  });

  test("throws when neither custom provider nor built-in model exists", () => {
    writeFixtures(providers, {
      test: { models: [{ ref: "totally-unknown/model" }] },
    });
    try {
      expect(() =>
        resolveRoleModels("test", undefined, {
          rolesPath: `${FIXTURE_DIR}/roles.json`,
          providersPath: `${FIXTURE_DIR}/models.json`,
        }),
      ).toThrow("not found in models.json or built-in providers");
    } finally {
      cleanupFixtures();
    }
  });

  test("throws when filters match nothing", () => {
    writeFixtures(providers, {
      test: { models: [{ ref: "local/qwen-small" }] },
    });
    try {
      expect(() =>
        resolveRoleModels("test", ["nonexistent"], {
          rolesPath: `${FIXTURE_DIR}/roles.json`,
          providersPath: `${FIXTURE_DIR}/models.json`,
        }),
      ).toThrow("No models in role");
    } finally {
      cleanupFixtures();
    }
  });

  test("ad-hoc --model refs bypass role config", () => {
    writeFixtures(providers, {
      test: { models: [{ ref: "local/qwen-small" }] },
    });
    try {
      // cloud/gpt-5-mini isn't in the role, but --model allows it as ad-hoc
      const models = resolveRoleModels("test", ["cloud/gpt-5-mini"], {
        rolesPath: `${FIXTURE_DIR}/roles.json`,
        providersPath: `${FIXTURE_DIR}/models.json`,
      });
      expect(models).toHaveLength(1);
      expect(models[0].ref).toBe("cloud/gpt-5-mini");
      expect(models[0].baseUrl).toBe("https://api.example.com/v1");
    } finally {
      cleanupFixtures();
    }
  });

  test("throws for ad-hoc ref with unknown provider", () => {
    writeFixtures(providers, {
      test: { models: [{ ref: "local/qwen-small" }] },
    });
    try {
      expect(() =>
        resolveRoleModels("test", ["totally-unknown/model"], {
          rolesPath: `${FIXTURE_DIR}/roles.json`,
          providersPath: `${FIXTURE_DIR}/models.json`,
        }),
      ).toThrow("not found in models.json or built-in providers");
    } finally {
      cleanupFixtures();
    }
  });
});

// ── parseModelArgs ──

describe("parseModelArgs", () => {
  test("returns undefined when no --model args", () => {
    const orig = process.argv;
    process.argv = ["node", "script.ts"];
    expect(parseModelArgs()).toBeUndefined();
    process.argv = orig;
  });

  test("parses single --model value", () => {
    const orig = process.argv;
    process.argv = ["node", "script.ts", "--model", "omlx/Qwen3.6"];
    expect(parseModelArgs()).toEqual(["omlx/Qwen3.6"]);
    process.argv = orig;
  });

  test("parses multiple --model values", () => {
    const orig = process.argv;
    process.argv = ["node", "script.ts", "--model", "omlx/Qwen3.6", "--model", "anthropic/claude-haiku"];
    expect(parseModelArgs()).toEqual(["omlx/Qwen3.6", "anthropic/claude-haiku"]);
    process.argv = orig;
  });

  test("parses --model=value format", () => {
    const orig = process.argv;
    process.argv = ["node", "script.ts", "--model=omlx/Qwen3.6"];
    expect(parseModelArgs()).toEqual(["omlx/Qwen3.6"]);
    process.argv = orig;
  });

  test("mixes --model value and --model=value", () => {
    const orig = process.argv;
    process.argv = ["node", "script.ts", "--model", "omlx/Qwen3.6", "--model=zai/glm-4.5"];
    expect(parseModelArgs()).toEqual(["omlx/Qwen3.6", "zai/glm-4.5"]);
    process.argv = orig;
  });
});
