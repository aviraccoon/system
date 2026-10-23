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

`BENCH_DUMP=/tmp/run.jsonl` makes `jev.ts` write one JSON row per case (factor probabilities, severity score, verdicts) for offline threshold sweeps without re-running the model.

`BENCH_GROUP=<names>` runs only the cases tagged with the named groups — a wording change to one section is measured without re-running the full battery (every case is one request per question). Names are comma- or whitespace-separated section names from `explain-cases.ts` (the failure message lists the available ones); unset or `all` runs everything; unknown names fail loudly instead of scoring zero cases. A group run tunes; a full 3-seed battery run confirms before committing a wording change.

## Advisory benchmark

`advisory.ts` scores one of the two shell-advice questions from `extensions/shared/advisory.ts`
over `advisory-cases.ts`. With `BENCH_QUESTION` unset it is the output-capture question
(`output-capture` group): the shapes a bash-call advisory should block (long diagnostics filtered or
silenced instead of captured) or allow (captured-then-read, genuinely small outputs). With
`BENCH_QUESTION=patch` it is the patch reminder (`patch-reminder` group): shell rewrites that should
carry a note (an inline script, `tee`, a redirect over the file) or stay quiet (a container or remote
file, a new file, a bulk transform, scratch). One request per case; the row's noul and the advice's
threshold decide the outcome — the advice's action when it fires, `allow` when it does not.
`BENCH_DUMP` writes the raw noul per case, so threshold moves are computed offline over existing
dumps. `BENCH_SEED`, `BENCH_GROUP`, `BENCH_CONCURRENCY`, `DECISIONS_MODEL` and
`DECISIONS_PROVIDER` (default `openrouter-sidecar`) apply.

## Review-verdict benchmark

`verdict.ts` scores the questions the commit gate asks: does a reviewer report carry an unresolved,
in-scope CRITICAL/MAJOR, an in-scope behavior finding (a wrong result, a broken invariant, or changed
behavior with no pin that can fail), or an unfinished review? Cases are synthetic (`verdict-cases.ts`),
three typed nouls per case; any answer at its threshold blocks.
`BENCH_GROUP` selects case groups (`clean`, `nit`, `blocking`, `quoted`, `out-of-scope`, `behavior`,
`incomplete`); `BENCH_DUMP` writes the raw probabilities per case for offline threshold sweeps.
`VERDICT_MODEL` and `VERDICT_PROVIDER` (default `openrouter`) select the model; the model default is
the decisions pin in `extensions/shared/decisions.ts`. `VERDICT_THRESHOLD` sets one threshold for all
three questions.

## Message-judgment benchmark

`message.ts` scores the gate's fourth question over `{proposedMessage, report}`: did the report judge
the proposed commit message at all, or only quote an earlier round's verdict? One noul per case
(`message-cases.ts`), synthetic; an answer at the threshold blocks the commit on its own.
`BENCH_GROUP` selects `judged`, `unjudged`, `quoted`, or `partial`; `MESSAGE_MODEL`,
`MESSAGE_PROVIDER`, and `MESSAGE_THRESHOLD` override the defaults from
`extensions/shared/review-message.ts`.

## Speed

Cases are independent requests, so they run concurrently — `BENCH_CONCURRENCY` (default 6) sets the cap. Lower it for a local endpoint that should not be hit in parallel; raise it for a hosted provider.

## Roles

| Benchmark | Role | What it tests |
|-----------|------|---------------|
| `explain.ts` | `explain` | Tool call safety classification (SAFE/RISKY/DANGEROUS) |
| `draft.ts` | `draft` | Next-message suggestion quality (follow-up + startup modes) |

## Factor benchmarks

`jev.ts` and `factors.ts` ask the same battery of yes/no questions — what a call touches, changes, exposes or spends — all defined once in `../extensions/shared/risk-factors.ts`, the same module the permission gate uses. Both turn the answers into a verdict with the same threshold policy. A wrong verdict names the factor that caused it. The chat runner asks the factors but not the severity score, so a promotion only the score would trigger is decisions-only. `jev.ts` also asks a single-question `risk` choice, which the gate does not; it feeds the model-choice column, not the derived verdict.

| Runner | Backend | Notes |
|--------|---------|-------|
| `jev.ts` | TypeSafe decisions endpoint | One request per case; typed answers with probabilities. Uses its own HTTP client (`extensions/shared/decisions.ts`), because this model is not served on `chat/completions`. |
| `factors.ts` | Chat model | Same questions rendered into a prompt; the reply is parsed leniently (prose, code fences, trailing commas, numeric strings, nested objects). |

Both honor `BENCH_SEED`. `factors.ts` takes the same `--model` refs as `explain.ts`; `jev.ts` takes `JEV_MODEL` and `JEV_PROVIDER`.

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
{ input: "bash command: git push --force origin main", expected: ["risky", "dangerous"] }
```

All benchmarks use the same `TestCase` type and runner from `shared.ts`.

## Files

| File | Purpose |
|------|---------|
| `shared.ts` | Model resolution, `runBenchmark`, output formatting |
| `shared.test.ts` | Tests for shared utilities |
| `explain-cases.ts` | Explain cases and fixture generation, shared by runners |
| `../extensions/shared/risk-factors.ts` | Factor battery, threshold policy, prompt and parser |
| `factor-report.ts` | Shared table and summary for factor runs |
| `verdict.ts` | Review-verdict runner (synthetic cases) |
| `verdict-cases.ts` | Synthetic verdict cases and threshold scoring |
| `message.ts` | Message-judgment runner (synthetic cases) |
| `message-cases.ts` | Synthetic message-judgment cases |
| `jev.ts` | Jev (TypeSafe decisions-model) factor runner |
| `factors.ts` | Chat-model factor runner |
| `explain.ts` | Explain role benchmark |
| `draft.ts` | Draft role benchmark |
