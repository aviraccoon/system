# or-pin

Session-scoped pin on OpenRouter's upstream provider. OpenRouter routes a
request to one of the endpoints serving the model, and the pick decides price,
latency and throughput.

`compat.openRouterRouting` in `pi.nix` is the static, machine-wide lever. This
adds the session-scoped one, because the request payload is the only place both
can meet.

## Commands

| Command | Effect |
|---------|--------|
| `/or-pin` | Pick from the current model's endpoints; the title carries the model's OpenRouter page, and a pinned session gets `— clear pin —` |
| `/or-pin <slug>[,<slug>]` | Pin those providers directly |
| `/or-pin off` | Clear the pin |

The picker's rows are the decision, one per provider:

```
* deepinfra  zdr  fp8  $0.112/$0.336  40/55 tok/s  100%  1.0M
  alibaba  no-zdr  unknown  $0.300/$1.200  60/110 tok/s  100%  1.0M
```

`zdr` / `no-zdr` / `zdr?` is eligibility, and `DOWN` marks a provider with none
up. The price, the p50/p90 throughput and the uptime (5-minute, falling back to
30-minute) describe the provider's cheapest up endpoint — not necessarily the one
OpenRouter picks, which also weighs the model's `sort` and any throughput floor.
Eligibility and availability are true when any of the provider's variants is.
Rows are ordered eligible-and-up first, then the other up providers by price,
with providers that are down last. `↑↓` wraps and the list windows to 12 rows, so
the end of the list is one keypress either way. `— refresh from OpenRouter —`
refetches the list and the ZDR catalog in place. The picker is keyboard-only: the
`SelectList`'s mouse handling is not wired through the container that wraps it.

The active pin shows in the footer as `or-pin <slugs>`. Outside the TUI there is
no picker: RPC gets the rows as a notification, and print/json mode writes them
to stderr (its `ui.notify` is a no-op), with `/or-pin off` as the way to clear.

A pin sets `provider.only` plus `allow_fallbacks: false`: a pinned provider that
is down fails the request rather than quietly routing elsewhere. Ranking the
endpoints *within* the allowed set stays a config lever — `sort` and
`preferred_min_throughput` in the model's `compat.openRouterRouting`.

A slug OpenRouter does not serve for the model is refused before it is applied
when the endpoint list can be read — `only` with an unknown slug leaves every
request with no endpoint at all. If that list cannot be read, the pin applies
and says so.

## How it applies

The pin merges into the `provider` object pi built from
`compat.openRouterRouting`, never replacing it, so the rest of that config
(`zdr`, `data_collection`, `sort`, throughput floors) keeps applying. Only
requests routed through OpenRouter are touched: the built-in `openrouter`
provider, a self-configured one such as `openrouter-sidecar`, or any provider
whose `baseUrl` is `openrouter.ai`.

## Gotchas

- **A request that asserts ZDR cannot reach a provider with no ZDR endpoint.**
  OpenRouter filters by data policy before it applies `provider.only`, so a pin
  to such a provider leaves the request with no endpoint at all and the API
  answers `404 No endpoints found matching your data policy`. The pin refuses a
  provider the catalog marks ineligible when `compat.openRouterRouting.zdr` is
  set; when it cannot tell — no credential resolves for the current provider, or
  the ZDR fetch fails — it says so and the pin still applies. The picker's
  `— refresh from OpenRouter —` row refetches both lists, using the provider
  credential pi already holds.
- **Memory only.** One process, one session: a child pi spawned by the subagent
  extension starts unpinned, and `/reload` clears the pin. Each pin and clear is
  written to the session as a `custom` entry (`customType: "or-pin"`), so the
  session record shows what was pinned when — the upstream host itself is not
  logged by pi.
- **Which upstream served a request:** the assistant message carries a
  `responseId` (`gen-…`). `curl -H "Authorization: Bearer $OPENROUTER_API_KEY"
  "https://openrouter.ai/api/v1/generation?id=<responseId>"` returns
  `provider_name` for it. OpenRouter's error metadata names the provider too
  when the failure is provider-specific.
- **The endpoint list is cached** for 15 minutes in `~/.cache/model-scan/`,
  shared with `scripts/model-scan.ts`, and the ZDR catalog goes through the same
  credential rather than that cache's age — a stale entry only triggers a
  refetch. A row reads `zdr?` when no credential resolves or the fetch fails.
- **Prompt cache.** pi sends OpenRouter session-affinity headers, so moving the
  pin mid-session moves the cache-warm endpoint with it.
- **A router alias** (`~deepseek/deepseek-flash-latest`) may not resolve in the
  endpoints API; pin a concrete model id.
