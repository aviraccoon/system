# /sidecar-models — Configure sidecar model roles

Interactive command for picking which models handle sidecar tasks (permission-gate explain, draft-suggestion).

## Usage

```
/sidecar-models
```

Opens a two-screen UI:
1. **Role list** — shows all configured roles and their current primary model
2. **Model picker** — every available model plus the chain's unresolvable members, with a position badge
   per row (`#1 ✓`, `#1 ✗`, `✗`)

### Keybindings

**Role list:**
- `Enter` — select role → model picker
- `Ctrl+R` — reset all roles to defaults
- `Ctrl+D` — sync all roles to the main model
- `Ctrl+C` / `Esc` — cancel

**Model picker** (matches `/scoped-models` conventions):
- `Enter` — toggle model in/out of chain (adding puts it at #1)
- `Ctrl+T` — cycle the selected chain model's thinking level
- `Alt+↑↓` — reorder within chain
- `Ctrl+A` — add all (or all filtered) to the end of the chain
- `Ctrl+X` — remove all (or all filtered) from chain
- `Ctrl+P` — toggle all models from same provider (prepends the batch, the picked model first)
- `Ctrl+S` — save to `roles.local.json`
- `Ctrl+R` — reset this role to defaults
- `Ctrl+C` — clear search or back to role list
- `Esc` — back to role list

Type in the search box to fuzzy-filter models by name, ID, or provider. Every printable character is
free for the query: no command is on a bare printable key.

## Thinking levels

Thinking is set per model entry (`models[].thinking`), not per role, so a fallback chain can mix a
thinking local model with a non-thinking cloud one. Each chain row shows its level, and the detail
line shows the cycle for the selected model, e.g. `^T cycles: off › low › high › max`.

`Ctrl+T` cycles the levels the model supports, as reported by pi's model catalog. pi clamps an
unsupported level to a neighbour, so offering one would leave the stored value disagreeing with what
runs. A non-reasoning model has only `off`; `xhigh` and `max` appear only when the model maps them.
(When the model is momentarily missing from the catalog, every level is offered rather than locking
the setting.)

Adding a model reuses its saved entry, so removing and re-adding it (or `Ctrl+D`, which syncs every role to
the main model) keeps its level.

### `enable_thinking: false` pins

Local Qwen/oMLX entries in `roles.json` set `requestParams.chat_template_kwargs.enable_thinking:
false`. `sidecarComplete` merges `requestParams` over the request body, replacing `chat_template_kwargs`
whole, so that pin disables thinking whatever level is configured. Cycling above `off` drops the pin;
the detail view warns about one still present.

## Unavailable chain members

A chain entry whose model is not in the available list is still listed, dim and marked `#N ✗`, so
positions match the stored chain and the entry stays reorderable and removable. The detail line names
the case: `not in the model catalog` (a retired or mistyped id), or `provider "…" has no credentials`.

Availability is decided per provider — `getAvailable()` keeps the models of providers with resolvable
credentials — so one missing key hides every model of that provider. Nothing in the picker drops an entry
for being unavailable; removal is always an explicit key (`Enter`, `Ctrl+X`, `Ctrl+P`, `Ctrl+R`).

## How it works

- **roles.json** — default role configuration (deployed by pi.nix or hand-edited)
- **roles.local.json** — runtime overrides saved by `Ctrl+S`
- `model-roles.ts` merges both, with local taking precedence per-role

Toggling a model puts it at #1 (or removes it): the head of the chain is what runs. `Ctrl+A` appends
its batch instead, and `Ctrl+P` prepends the provider's models with the picked one first. `Alt+↑↓`
reorders within the chain and the cursor follows the moved row. Changes are session-only until `Ctrl+S`
saves them.

### Reset overrides

Delete `~/.pi/agent/roles.local.json` to revert to defaults:

```bash
rm ~/.pi/agent/roles.local.json
```
