# Solver ↔ MCP Server Contract

> **Status: normative.** This document fixes the boundary between the solver core
> (`selector/js/core/`) and the Stage-2 MCP server (`mcp/`). The server is a *renderer* of the
> core's query/response contract — the same standing every other front-end has (guideline §4).
> Registry baseline: **registry v3.0.0** (`DB/switching/switching-axes.json`).

## 1. What the core guarantees to the server

1. **Purity / portability.** Every module in `selector/js/core/` is standard ESM with no DOM, no
   Node built-ins, and no IO — it runs unmodified on any V8 host (browser, Node, workerd). The
   sole exceptions are the fetch-based convenience loaders `loadRegistry(url)` (`registry.js`)
   and `loadKB(url)` / `loadKBs(urls)` (`kb.js`), which the server does **not** use (§3).
2. **The solve contract.** `solve(query, kb, registry)` (`solver.js`) is synchronous, stateless,
   and deterministic: same inputs, same `{ candidates, open_variables, eliminated }`. No hidden
   state, no clock, no randomness. The server never adds selection logic on top — trimming a
   response for transport (§5) is presentation, choosing or reordering within it is not.
3. **Query construction monopoly.** Queries are built and validated ONLY through `query.js`:
   `constraint()`, `portConstraint()`, `translatePoeDemand()`, `validateQuery()`. The server
   never assembles raw constraint objects outside these builders and never re-derives a demand
   translation. The `level_watts` expansion ("N ports at level L" → budget/level/count
   constraints) happens inside the boundary — the calling agent states demands, it never does
   datasheet math.
4. **Registry as the single vocabulary.** The server's tool input schemas are *generated* from
   the registry via `registry.js` accessors (`getVariables`, `legalValues`,
   `acceptedConditions`, `defaultRule`, `mustResolve`, `dependsOn`, `portModel`). Nothing is
   constrainable through MCP that the registry does not declare; an undeclared variable
   appearing in a tool call is a `validateQuery()` problem, never a silent filter.

## 2. What the server owes the core (obligations in return)

- Pass `validateQuery()` problems back to the caller **verbatim** as a tool error — the problem
  text names the legal values/conditions, which is what lets an agent self-correct.
- Treat `candidates[].bom` blocks as the per-candidate choice domains (they double as the
  option tables); never re-derive domains from the KB directly.
- Return `open_variables` intact (§5) — it is the client agent's "what to ask next" list and
  the reason the server has no guided/dialogue surface: the selector is stateless and never
  asks questions; dialogue is the caller's job.

## 3. The IO seam: `mergeKBs`

The server bundles all data at build time (wrangler bundles JSON imports); nothing is fetched
at runtime. The core therefore exposes a parsed-object entry point next to the fetch loaders:

- `mergeKBs(parsedKbs)` (`kb.js`) — the pure merge: attach each KB's `_index` (via
  `buildIndex`), tag every model with a non-enumerable `_kb` back-reference to its own family
  KB, return `{ models, _sources }`. `loadKBs(urls)` is exactly fetch → `mergeKBs`.
- The registry needs no seam: `loadRegistry` is fetch + parse only, and every accessor takes
  the already-parsed object.

Worker boot is then: import `switching-axes.json`, `families.json`, and the per-family
`*_knowledge_base.json` files listed there → `mergeKBs` once at module scope → every request
reuses the same immutable pool.

## 4. Tool surface (exactly two tools)

### `lookup_model`

Input: `{ model: string }`.
Implementation: `solve([constraint("model_id", "==", model)], kb, registry)`.

- Exact hit → the single candidate; its `bom` blocks are the option summary (uplink modules,
  PSU/PoE matrix, license groups & terms, cables, included-by-default).
- No hit → a tool **error** whose message lists the nearest known model ids
  (case-insensitive substring/prefix match over the pool), so a mistyped SKU comes back with
  its own correction.

### `find_configurations`

Input (all fields optional, at least one required):

| field | shape | handling |
|---|---|---|
| `requirements` | `[{variable, condition, value}]` | verbatim registry vocabulary → `constraint()` |
| `poe_demand` | `[{count, level}]` | → `translatePoeDemand()` (never agent-side) |
| `port_demand` | `[{count, speed, role?, medium?}]` | → `portConstraint({role?, medium?, speed}, ">=", count)` |
| `limit` | integer, default 5 | candidate cap (§5) |

Flow: build via `query.js` → `validateQuery` (problems → tool error, verbatim) → `solve` →
trim (§5). The input schema enumerates, per variable, its legal values and accepted conditions
— generated from the registry at server start, never hand-maintained. A watts-shaped PoE ask
constrains `poe_budget_watts` directly in `requirements`; a ports-shaped ask uses `poe_demand`.
Severity is not exposed in v1: all tool constraints are hard; soft ranking stays a future,
deliberate addition.

## 5. Response trimming (transport shaping, not logic)

- `candidates`: at most `limit` (default 5), in solver order, each with its **full** resolved
  BOM; plus `total_candidates` so the agent knows what the cap hid. The server never reorders.
- `eliminated`: compressed to `{reason → count}`; the full per-model list is not shipped.
- `open_variables`: **whole and untrimmed**, including each variable's remaining domain,
  default, `must_resolve` flag, and the registry's `ask_priority` / `depends_on` presentation
  hints (so a sequential agent asks in the intended order).
- `query_echo`: the fully-built constraint list actually solved (post-translation), so the
  agent can see what its demands expanded into.

## 6. Versioning & deployment invariants

- The server reports the `registry_version` it was built against (from the bundled registry)
  in its server metadata; a registry variable-set change (expensive by the change policy)
  implies reviewing the generated tool schemas.
- CI ordering: `validate-kb.mjs` must pass before any deploy — a KB snapshot that fails
  validation never ships.
- A deploy is a snapshot: KB edits reach the server only through redeploy (automated in CI on
  the default branch).
