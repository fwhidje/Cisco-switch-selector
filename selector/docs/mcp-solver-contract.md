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
   `acceptedConditions`, `defaultRule`, `mustResolve`, `agentNote`, `dependsOn`,
   `portModel`). Per-variable descriptions COMPOSE `agent_note` with the mechanical hints
   for the variable's kind — they are never hand-written per variable in `schema.js`, and
   never mutually exclusive. Nothing is
   constrainable through MCP that the registry does not declare; an undeclared variable
   appearing in a tool call is a `validateQuery()` problem, never a silent filter.

## 2. What the server owes the core (obligations in return)

- Pass `validateQuery()` problems back to the caller **verbatim** as a tool error — the problem
  text names the legal values/conditions, which is what lets an agent self-correct.
- Treat `candidates[].bom` blocks as the per-candidate choice domains (they double as the
  option tables); never re-derive domains from the KB directly.
- Pass each block's `decision` envelope (§2.1) through untouched. The server never
  computes or re-labels a status — deciding what was decided is core work.
- Return `open_variables` intact (§5) — it is the client agent's "what to ask next" list and
  the reason the server has no guided/dialogue surface: the selector is stateless and never
  asks questions; dialogue is the caller's job.

### 2.1 Decision status on every BOM block

`resolveBOM` marks each configurable block with a `decision` envelope
(`{status, chosen, options_count, variables}`), and rolls them up into `bom.decisions`
(`{counts, discuss, blocking}`). This is core work, not presentation: the solver is what
knows whether a value was pinned, defaulted, forced, or left deliberately open, and both
renderers (web UI and MCP server) consume the same marking.

| status | meaning |
|---|---|
| `pinned` | the caller constrained it — the customer has already decided |
| `defaulted` | resolved here, and real alternatives exist (the "what should I discuss with the customer?" set) |
| `forced` | only one option; nothing to decide |
| `required` | nothing chosen and nothing MAY be chosen — the kitlist is not orderable until the caller settles it |

`required` is a **product** fact, not a solver one, and the distinction is load-bearing:
an empty second PSU bay is a complete, working, orderable switch (`defaulted`), whereas a
switch ships with **no** license and needs one to run (`required`). A `required` block
must come back with `chosen: null` and its full option space — never manufacture a
default to fill it, and never let a caller read a blank as "nothing needed here".

The envelope is **additive**: no pre-existing block field is renamed or removed, so every
existing renderer keeps working unchanged.

### 2.2 Derived projections are separate exports, never inside `solve()`

`solve()` stays one pass over the pool. Projections that need extra solves are exported
alongside it, so a caller pays only for what it reads:

- `facetDomains(query, kb, registry, mainResult)` — live values per variable, re-solving
  without each pinned variable's own constraints (the UI's greyed-out options).

This matters because the web UI re-solves on interaction; folding N extra solves into
`solve()` would tax every caller for a projection only the MCP server reads.

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
  PSU/PoE matrix, license groups & terms, cables, included-by-default), each carrying its
  `decision` envelope (§2.1).
- No hit → a tool **error** whose message lists the nearest known model ids
  (case-insensitive substring/prefix match over the pool), so a mistyped SKU comes back with
  its own correction.

### `find_switch_kitlists`

Input (all fields optional, at least one required):

| field | shape | handling |
|---|---|---|
| `requirements` | `[{variable, condition, value}]` | verbatim registry vocabulary → `constraint()` |
| `poe_demand` | `[{count, level}]` | → `translatePoeDemand()` (never agent-side) |
| `port_demand` | `[{count, speed, role?, medium?}]` | → `portConstraint({role?, medium?, speed}, ">=", count)` |
| `limit` | integer, default 3 | cap on kitlists returned in FULL (§5); `all_matches` is uncapped |

Flow: build via `query.js` → `validateQuery` (problems → tool error, verbatim) → `solve` →
trim (§5). The input schema enumerates, per variable, its legal values and accepted conditions
— generated from the registry at server start, never hand-maintained. A watts-shaped PoE ask
constrains `poe_budget_watts` directly in `requirements`; a ports-shaped ask uses `poe_demand`.
Severity is not exposed in v1: all tool constraints are hard; soft ranking stays a future,
deliberate addition.

## 5. Response trimming (transport shaping, not logic)

- `candidates`: at most `limit` (default 3), in solver order, each with its **full** resolved
  BOM; plus `total_candidates` so the agent knows what the cap hid. The server never reorders
  — but note the core's order is *not* arbitrary: `rank()` runs unconditionally
  (`solver.js`) and, absent soft constraints, sorts smallest-sufficient-configuration first.
- `all_matches`: every survivor's model id, **uncapped**, taken from the untrimmed candidate
  list. This is what makes a small `limit` safe — the cap hides detail, never existence.
  Same order as `candidates`, so the first `limit` ids are the kitlists shown in full.
  Omitted for `lookup_model`: "every model matching `model_id == X`" is `[X]`.

The two tools therefore ship **different shapes**, and that is deliberate: the differences
are named options on `trimResponse` (`{limit, allMatches}`) rather than
inferred from `limit`, so each call site declares what its tool returns. Shape is stable
*per tool*, which is what a caller actually depends on.
- `eliminated`: **not shipped.** The former `eliminated_summary` (`{reason → count}`) was
  removed: it counted each model against the FIRST constraint it failed, making the numbers
  evaluation-order artifacts rather than costs.
- `open_variables`: the **open decision space** — every variable still genuinely in play,
  with its remaining domain, default, `must_resolve` flag, and the registry's
  `ask_priority` / `depends_on` presentation hints (so a sequential agent asks in the
  intended order). Values are never trimmed *within* an entry; whole entries are filtered
  out when the variable is no longer a decision: a domain of one value (or a numeric range
  whose min equals its max, or an empty/null domain) is a settled fact about the survivors
  that the candidates' BOM blocks already carry. **`must_resolve` entries always survive**,
  whatever their domain size — with one legal value the caller must still actively settle
  it, and hiding that would conceal the only thing blocking an orderable kitlist.
  On a single-model lookup this filter removes ~60% of the field, all of it restatement.
- `query_echo`: the fully-built constraint list actually solved (post-translation), so the
  agent can see what its demands expanded into.

## 6. Versioning & deployment invariants

- The server reports **`<registry_version>+<commit>`** in its server metadata (e.g.
  `3.0.0+a1b2c3d`), and the same on the plain-text banner at `/`. The registry half moves
  when the vocabulary changes — a registry variable-set change (expensive by the change
  policy) implies reviewing the generated tool schemas. The commit half exists because
  registry version **alone cannot distinguish two code deploys**: consecutive deploys
  against an unchanged registry all announced the same version, which made a client's
  cached `tools/list` indistinguishable from a failed deploy. CI stamps
  `mcp/src/build-info.js` immediately before `wrangler deploy`; the committed placeholder
  reports `local`, so `local` means "not built by CI", never "stale".
- **Tool definitions are cached client-side.** MCP clients fetch `tools/list` once at
  connect time and hold it. A redeploy does not reach an already-connected client — it
  must reconnect. Compare the client's view against `curl <worker>/` before suspecting
  the deploy.
- CI ordering: `validate-kb.mjs` must pass before any deploy — a KB snapshot that fails
  validation never ships.
- A deploy is a snapshot: KB edits reach the server only through redeploy (automated in CI on
  the default branch).
