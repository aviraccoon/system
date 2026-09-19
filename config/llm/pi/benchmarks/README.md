# Sidecar Model Benchmarks

Test whether models configured for sidecar roles (explain, draft, vision) produce correct output. Runs against the same models and prompts the extensions use at runtime.

## Usage

```bash
bun run benchmarks/<role>.ts                        # first model in role
bun run benchmarks/<role>.ts --model omlx           # filter by substring
bun run benchmarks/<role>.ts --model omlx/Qwen3.6   # specific ref
bun run benchmarks/<role>.ts --model omlx --model zai/glm-4.7-flash   # multiple
```

No `--model` flag runs the first model in the role config — fast iteration by default. Pass `--model` to test specific or multiple models. Any `provider/modelId` ref works, even if it's not in roles.json — useful for ad-hoc testing of new models.

## Model resolution

Models come from three sources (same as pi's `ModelRegistry`):

1. **Built-in providers** from `@earendil-works/pi-ai` — zai, anthropic, openrouter, etc. Available without any config.
2. **Custom providers** from `~/.pi/agent/models.json` — omlx, lmstudio, etc. Provides baseUrl + apiKey.
3. **Role config** from `~/.pi/agent/roles.json` — which models to use per role, with `requestParams`, `maxTokens`, etc.

No model definitions are duplicated in benchmark code. The benchmark reads the same config pi uses.

## Reproducible fixtures

Cases and per-run fixtures come from `explain-cases.ts`. Set `BENCH_SEED` to make the fixtures deterministic, so two runners score identical inputs:

```bash
BENCH_SEED=run-a bun run benchmarks/explain.ts
```

## Roles

| Benchmark | Role | What it tests |
|-----------|------|---------------|
| `explain.ts` | `explain` | Tool call safety classification (SAFE/RISKY/DANGEROUS) |
| `draft.ts` | `draft` | Next-message suggestion quality (follow-up + startup modes) |

## Adding a new role benchmark

Copy `explain.ts` as a template. Fill in:

- `role: "your-role"` — matches the key in roles.json
- `systemPrompt` — imported from the extension's prompts file
- `tests` — `TestCase<Verdict>[]` with input/expected pairs
- `parseOutput` — extracts structured verdict from raw model output
- `color` — optional color function for verdict display

Shared infrastructure (resolution, runner, output formatting) is in `shared.ts`.

## Adding test cases

Each test case has an `input` (sent to the model) and an `expected` verdict. The expected can be a single value or an array for borderline cases:

```ts
{ input: "bash command: mkdir -p /tmp/build", expected: ["safe", "risky"] }
```

All benchmarks use the same `TestCase` type and runner from `shared.ts`.

## Files

| File | Purpose |
|------|---------|
| `shared.ts` | Model resolution, `runBenchmark`, output formatting |
| `shared.test.ts` | Tests for shared utilities |
| `explain.ts` | Explain role benchmark |
| `draft.ts` | Draft role benchmark |
