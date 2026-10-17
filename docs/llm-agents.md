# LLM Agent Design

Design philosophy for LLM coding agent setup. Reference for agents working on extensions, instructions, or journal infrastructure.

## Stack

**Pi** (vanilla) with custom extensions. Not a fork or batteries-included variant -- custom behavior is built as extensions on top of upstream pi. The goal is owning the customization layer while staying on a maintained base. Extensions are TypeScript, live-reloadable, and symlinked from `config/llm/pi/extensions/`.

Multiple agents share the same global instructions and journal system: pi, Claude Code, and OpenCode all read the same `instructions.md` and journal directory. Agent-specific behavior (pi extensions, CC hooks, OpenCode plugins) wraps the shared core.

## Knowledge Tiers

Knowledge is routed to the right durability level, not dumped in one place.

| Tier | What goes here | Where |
|------|---------------|-------|
| Human+LLM docs | Patterns, conventions, architecture decisions useful to both humans and agents | Project documentation, @-mentioned from AGENTS.md |
| LLM shared instructions | Agent workflow rules, project-specific behavioral constraints | AGENTS.md (committed) |
| LLM personal instructions | Private workflow context, local paths, personal preferences | AGENTS.local.md (gitignored) |
| Temporal context | Session history, work in progress, things still being figured out | Journal entries |

Agents suggest AGENTS.md changes but don't edit directly. Repeated patterns in journals are signals to promote knowledge to a durable tier.

**No auto-memory.** Automatic memory extraction (reading past sessions to build a durable memory file) was tried and rejected. It creates a silo outside the repo, duplicates what journals + AGENTS.md do better, and the quality of automatic extraction is poor. The journal system is the memory system -- agents write during work, future agents read at session start.

## Journal System

Journals live in `~/notes/llm/{project-name}/`, one file per topic per day. Agents see the 3 most recent entries at session start (injected by the journal extension). The rest are accessible via `read` if the agent knows the filename.

### Design principles

- **Agents write unprompted.** Instructions mandate journaling after each completed step. No human intervention needed.
- **Temporal, not archival.** Entries capture what happened and what was learned, not polished documentation. Voice and opinions are encouraged.
- **Cross-tool.** All agents (pi, CC, OpenCode) read and write the same journal directory. A pi session can continue work started in CC.
- **Handoff via journal.** Long tasks span multiple sessions. The agent journals progress, the next agent reads recent notes and continues. No special handoff mechanism needed -- the journal *is* the handoff.
- **Start fresh often.** Rather than compacting a long session, start a new one. The journal carries context forward. This avoids compaction lossiness and keeps sessions focused.

### What agents see at startup

1. Global instructions from `instructions.md`
2. `TODO.md` from the project's journal directory (if it exists) -- persistent, not subject to the recency window
3. Full content of the 3 most recent journal entries (recency window)
4. Filename listing of older entries (up to 30) and recent filenames from other projects (up to 5 each)
5. Project-specific AGENTS.md files (loaded by pi natively + agents-loader extension)

## Extensions

Custom pi extensions follow a pattern: augment the agent with context and guardrails, using cheap sidecar models where real-time analysis is needed.

**Context injection** -- agents-loader discovers AGENTS.md files from touched directories; journal extension injects notes and instructions; at-mentions inlines file contents on `@path` references.

**Guardrails** -- permission-gate intercepts tool calls with a confirmation dialog showing colored diffs, sidecar-generated verdicts (SAFE/RISKY/DANGEROUS), and session-allow rules with shell escalation detection. model-policy enforces per-project model requirements based on provider tags (e.g., local/ZDR only for sensitive projects).

**Augmentation** -- LSP extension runs diagnostics after every edit/write so the agent sees type errors immediately; draft-suggestion predicts the next user message as ghost text; web-search provides web search and web_fetch (structured-feed fast path + headless browser rendering); vision routes image reads to a capable sidecar when the main model is text-only; stats provides live throughput readouts and per-message annotations.

**Sidecar pattern** -- cheap models run alongside the main conversation for tasks like classification, explanation generation, draft prediction, and vision descriptions. They don't share conversation context -- they get focused, purpose-built prompts. Roles are configured in `pi.nix` and managed at runtime via `/sidecar-models`.

See `config/llm/pi/README.md` for the full extension list and development guidelines.

### What's intentionally absent

- **Plan mode.** Prevents journaling and burns context on planning that should be captured in the journal. The journal is the plan.
- **MCP integration.** MCP servers exist in `config/llm/mcp/` for other clients (Claude Code, OpenCode). Pi uses native extensions instead — same capabilities, better integration. MCP may be added to pi later if a specific need arises, likely as a toggleable option.
- **Autonomous features.** No auto-commit, auto-compact customization, or background processing. The human steers; the agent executes and journals.

## Local LLMs

Two local inference servers run on this machine for offline fallback and sidecar model serving.

### Architecture

| Server | Port | Engine | Format | Use |
|--------|------|--------|--------|-----|
| LM Studio | `:1234` | llama.cpp (GGUF) + MLX | GGUF Q4_K_M, MLX | Main model, model discovery |
| oMLX | `:8124` | MLX | MLX 4-bit (unsloth UD) | Sidecar roles, continuous batching |

Both share `~/.lmstudio/models/` -- LM Studio can load both GGUF and MLX models, oMLX only loads MLX. No duplication of model files.

**LM Studio** is kept for model discovery (tells you if a model fits your RAM, curated suggestions, HuggingFace search). oMLX is the performance server -- tiered KV cache (RAM + SSD), continuous batching, multi-model serving with LRU eviction. oMLX's admin dashboard at `:8124/admin` also provides model search/download, chat, benchmarking, and settings -- sufficient for day-to-day without the GUI app.

### Providers and model selection

Three tiers of providers, defined in `modules/home-manager/pi.nix`. Specific models come and go -- this section describes the tiers, not the inventory. `pi.nix` is the source of truth.

1. **Local inference** -- `omlx` (:8124, MLX) and `lmstudio` (:1234, GGUF). Zero cost, offline-capable, used for sidecar roles and offline main-model work. Local models are also kept in the sidecar fallback chains as free options ahead of paid cloud.
2. **Cloud coding plans** -- flat-rate providers (currently z.ai) with no per-token cost. Good for main-model and sidecar use within plan limits.
3. **OpenRouter** -- pay-per-token router with ZDR enforced at the account level. Two keys (main + sidecar) with separate spend caps; `openrouter-sidecar` carries cheap fallback models for sidecar roles, and the main key can route to any provider for backup main models.

Sidecar roles (explain, draft, vision) try the fastest suitable local model first, then cloud, then cheaper/last-resort options. The exact chains and per-model `requestParams` live in the `roles` block of `pi.nix`. When picking local models for sidecar use, throughput matters most -- only the fastest local quants are viable at sidecar latency; slower models are kept in the chain for experimentation.

### Chat templates for local models

Local models load a chat template from `~/.lmstudio/models/<model>/chat_template.jinja` on disk (both LM Studio and oMLX read it from there). The template controls prompt formatting -- tool-call syntax, thinking on/off, system/developer role handling -- and the default template a quant ships with is often not the best one.

When using Qwen-family local models, the [froggeric/Qwen-Fixed-Chat-Templates](https://huggingface.co/froggeric/Qwen-Fixed-Chat-Templates) template is preferred over both the official Qwen template and the unsloth UD template. It adds the things that matter for agent workloads: tool-call error escalation (forces a corrected action after repeated failures), `preserve_thinking` defaulted to true (prevents amnesia in multi-turn tool chains), empty-think-block prevention (avoids KV cache drift), and per-message think on/off toggles. The template file lives at `~/.lmstudio/models/<model>/chat_template.jinja`.

### Why both GGUF and MLX

GGUF via llama.cpp has better quantization quality (K-quants allocate more bits to sensitive tensors, 4.7x lower perplexity than uniform 4-bit). MLX has faster generation (~60% faster) and continuous batching for concurrent requests. For main model coding work where quality matters, GGUF wins. For sidecar tasks (explain, draft, vision) where speed matters more, MLX via oMLX wins.

Prefill speed: llama.cpp is faster at batch prompt processing (3+ years of optimization). MLX is younger here. For agent workloads with growing context, prefill dominates total response time. But oMLX's tiered KV cache mitigates this -- cached prefixes don't recompute.

### Model routing in pi

`modules/home-manager/pi.nix` defines providers and sidecar role fallback chains. Roles (explain, draft, vision) try the fastest suitable local model first, then cloud providers, with cheaper/last-resort options last. The `omlx` provider at `:8124` serves MLX models; `lmstudio` at `:1234` serves GGUF models.

Per-model `requestParams` in roles.json controls thinking behavior and sampling per role (implemented via pi's `onPayload` hook):
- `explain`/`draft`: `chat_template_kwargs: { enable_thinking: false }` -- skip chain-of-thought for fast sidecar responses
- `vision`: `thinking_budget: 1024` -- capped thinking for better image descriptions
- All three roles also set `temperature: 0.7, top_p: 0.8, top_k: 20` for concise non-thinking output (vs global defaults of temp=0.6, top_p=0.95, top_k=20 for precise coding)

The sidecar's `/sidecar-models` command has a `Ctrl+D` keybinding that syncs all role chains to use the same model as the main conversation (read from `settings.json` `defaultModel`). Config mutations call `reloadConfig()` to invalidate the model-roles cache so permission-gate picks up changes immediately.

### oMLX model management

Models are managed through a combination of automatic and manual controls:

- **LRU eviction**: least-recently-used models are unloaded automatically when memory runs low
- **Manual load/unload**: status badges in the admin panel (`/admin`)
- **Model pinning**: pin frequently used models (e.g., sidecar models) to keep them always loaded
- **Per-model TTL**: auto-unload after a configurable idle timeout -- useful for freeing RAM for VMs when not doing LLM work
- **Process memory limit**: default is system RAM - 8 GB, prevents OOM

On unload, MLX arrays (weights + KV cache) are freed from Metal memory and returned to the OS. SSD-cached KV blocks persist on disk but don't consume RAM.

### oMLX experimental features

Enabled per-model in the admin panel under Experimental Features.

**TurboQuant KV cache**: compresses KV cache using vector quantization. At 4-bit, ~4x compression with negligible quality loss. The most impactful feature for memory-constrained setups -- a 32K context that would need ~6-8 GB KV cache at fp16 drops to ~1.5-2 GB. Enable per-model in the admin panel.

**SpecPrefill** (not enabled): attention-based sparse prefill for MoE models. Skipped because prefill speed isn't the bottleneck for this workload, and there are open bugs with quantized models.

**DFlash** (not enabled): block diffusion speculative decoding for 3-4x faster generation. Limited model-family support, falls back to normal engine for contexts >4K tokens (most agent conversations), and no paged/SSD cache integration. Faster generation would also make iTerm2 flicker worse.

### oMLX setup

- **CLI**: `brew install jundot/omlx/omlx` (tap: `brew tap jundot/omlx https://github.com/jundot/omlx`)
- **Start**: `omlx serve --model-dir ~/.lmstudio/models --port 8124`
- **Admin**: `http://127.0.0.1:8124/admin` (HF downloader, benchmark, model management)
- **GUI app**: Optional DMG from releases with in-app auto-update and menu bar control. Not in brew.nix (no cask available, auto-update conflicts with cask management). The admin dashboard via CLI is sufficient for most use.
- **Config**: `~/.omlx/settings.json` (global), `~/.omlx/model_settings.json` (per-model)
- **Benchmarks**: [omlx.ai/benchmarks](https://omlx.ai/benchmarks) (filter by chip/model/quant)

### oMLX admin API

Base URL: `http://127.0.0.1:8124/admin/api/`

| Endpoint | Purpose |
|----------|----------|
| `GET /models` | List all discovered models with status, size, settings |
| `GET /models/{id}/profiles` | Per-model named sampling profiles (currently empty) |
| `GET /profile-templates` | Available profile templates (currently empty) |
| `GET /grammar/parsers` | Available grammar parsers for structured output |
| `GET /hf/search?q=...&sort=downloads|trending&limit=N&mlx_only=true` | Search HuggingFace for models |
| `GET /hf/model-info?repo_id=...` | Full model card, files, tags, size for a HF repo |
| `GET /hf/recommended?mlx_only=true` | Trending + popular MLX models |
| `GET /stats` | Server stats (tokens served, cache efficiency, avg TPS) |
| `PATCH /models/{id}/settings` | Update per-model settings (sampling, experimental features) |

Per-model settings fields: `temperature`, `top_p`, `top_k`, `repetition_penalty`, `min_p`, `presence_penalty`, `force_sampling`, `max_context_window`, `max_tokens`, `enable_thinking`, `thinking_budget_enabled`, `thinking_budget_tokens`, `reasoning_parser`, `chat_template_kwargs`, `forced_ct_kwargs`, `ttl_seconds`, `turboquant_kv_enabled`, `turboquant_kv_bits`, `specprefill_enabled`, `dflash_enabled`, `is_pinned`, `is_default`, `model_alias`, `display_name`, `active_profile_name`.

### Key references

- [MLX vs GGUF benchmarks on Apple Silicon](https://famstack.dev/guides/mlx-vs-gguf-apple-silicon/) -- thorough comparison showing prefill vs generation tradeoffs, effective throughput vs UI-reported tok/s
- [Part 2: isolating variables](https://famstack.dev/guides/mlx-vs-gguf-part-2-isolating-variables/) -- runtime comparison (LM Studio, Ollama, oMLX), quantization quality (K-quants vs uniform), bf16 fix for M1/M2
- [oMLX](https://github.com/jundot/omlx) -- 10.9k stars, Apache 2.0, tiered KV cache, continuous batching
- [Rapid-MLX](https://github.com/raullenchai/Rapid-MLX) -- agent-focused MLX server with tool call parsers, DeltaNet state snapshots for Qwen hybrid attention. Worth watching.
- [SwiftLM](https://github.com/SharpAI/SwiftLM) -- native Swift, SSD expert streaming for 100B+ MoE. Ambitious but young.
- [Ollama MLX backend](https://ollama.com/blog/mlx) -- MLX support added March 2026, but 37% overhead from Go wrapper makes it uncompetitive for latency-sensitive use

## Nix Integration

Agent configuration is declarative. `modules/home-manager/pi.nix` symlinks extensions, `modules/home-manager/llm.nix` generates shared config (`journal.json`), and `modules/home-manager/llm-shared.nix` defines constants shared across all agents. Adding a new pi extension is just creating a directory with `index.ts` -- the Nix module auto-discovers it.

Runtime config (journal paths, model roles) is generated by Nix into `~/.config/llm/` so it's consistent across agents without manual setup.
