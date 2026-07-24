# Networking Equipment Selector

A pure, generic **constraint solver over configurations** plus a **facet UI**, spanning six switch
families (C9200, C9300, C9350, C9500, C9550, Meraki MS). Vanilla JavaScript (ES modules), **no build
step** — runs as static files and deploys to GitHub Pages as-is. The core is DOM-free and IO-free so
the Stage-2 MCP server can reuse it unchanged.

## Run it

```bash
# from the repository root (needs HTTP, not file://)
python3 -m http.server
# then open http://localhost:8000/selector/
```

## Validate the data

The knowledge files are a projection chain — **registry → schema → KB**. The validator is the
mechanical guard that keeps them consistent (incl. the v1.0.0 variable metadata: dimensions,
bindings, defaults, presentation):

```bash
cd selector && npm run validate          # node tools/validate-kb.mjs
```

It runs in CI (`.github/workflows/validate-kb.yml`) on every push/PR.

## The contract (registry v1.0.0)

The center of gravity is the **query/response contract** — every front-end (this UI, the future MCP
server, the Stage-3 agent) is a renderer of it. See the root guideline §4 for the design rationale.

- **Everything is a decision variable over configurations.** A solve answers with configurations
  (model + fitted uplink option + PSU set + license SKUs + cables), not bare models. One flat
  registry list (`../DB/switching/switching-axes.json`) declares every variable: its `dimension`
  (model-stored vs KB-derived via a `binding`), whether it `eliminates` models, its `default` rule
  (incl. **`must_resolve`** — no safe default; licensing regime/tier/term), and `presentation`.
- **The response carries the residual decision space.** `solve(query, kb, registry)` returns
  `{ candidates, open_variables, eliminated }`: ranked configurations with fully-resolved default
  BOMs (every default with a `reason`), plus every variable left open with its remaining domain and
  default. Facet greying, MCP parameter narrowing, and agent follow-up questions are all the same
  `open_variables` computation. The selector is stateless and never asks questions.
- **Queries are built in one place** (`js/core/query.js`): builders, the PoE demand translation
  ("N ports at level L" → derived budget/level/count constraints from the registry's `level_watts`),
  and `validateQuery()`. Constraints are `{ variable, condition, value, severity }`; port demands
  add a `where: {role?, medium?, speed}` selector and are **role-agnostic by default** — the
  solver's max-flow pool feasibility decides whether access ports or an uplink module supplies them.

## Modes

The UI opens on a mode chooser; the mode lives in the URL hash and switching never refetches data.
All three are thin renderings of the same `solve()` response:

- **`#lookup` — model lookup.** One text field (type-ahead over the known SKUs). An exact model
  renders its option tables — uplink modules with port capabilities, PSU configurations with the
  PoE-budget matrix, license groups/terms, cables/kits, included-by-default — the datasheet
  summary without the datasheet. Near-misses offer clickable suggestions.
- **`#full` — full options.** Every requirement control at once (panels from the registry's
  presentation metadata), results re-solving on each change with facet greying. Candidate cards
  are structured kitlists: default parts as line items with the policy's `reason`, remaining
  alternatives as compact rows; the raw solver response only behind a *show raw result* button.
  Rendering is capped at 20 cards with *show all*.
- **`#guided` — guided run.** Tile-based steps through the decision variables in the registry's
  `ask_priority` order: single-choice tiles advance on click; the composite PoE and Ports steps
  use level/category tiles with preset count menus (PoE has an explicit *None*). Dependent steps
  (uplink module, stack cable — gated on `stacking_capable`, PSU triple, stackpower cable) only appear
  when the registry's `presentation.depends_on` is satisfied, and the uplink-module tiles are the
  live residual domain. Every step has a *don't care* tile and a live match count. Ends with the
  kitlist rendered inline (top candidates + outstanding must-resolves) and a button to open the
  full view pre-filled with the accumulated draft.

## Layout

```
js/core/   pure, importable engine (no DOM)
  registry.js  accessors over ../DB/switching/switching-axes.json (variables, dimensions,
               bindings, defaults/must_resolve, presentation groups)
  kb.js        load + id-index the family KBs listed in ../DB/switching/families.json
  query.js     canonical query construction + demand translations + validation (UI & MCP both call it)
  resolve.js   port pools, configured variants, pool-feasibility (max-flow), and the resolved BOM
  solver.js    solve() -> { candidates, open_variables, eliminated }; facetDomains()
tools/
  validate-kb.mjs   registry/schema/KB consistency validator (shape, projections, bindings, references)
js/ui/       DOM only — three renderings of the one contract
  app.js         boot + hash router: loads data once, mounts a mode, landing chooser, header tabs
  shared.js      the DRAFT (UI requirement state) -> toQuery() via core/query.js; registry-driven
                 control builders; structured kit-card renderers; PoE demand section
  modes/full.js    facet mode (panels from registry presentation metadata, facet greying,
                   render cap, guided-handoff intake)
  modes/lookup.js  exact-model lookup (text field -> option tables)
  modes/guided.js  step engine over ask_priority -> summary -> handoff to full
```

## Engine notes

- **One narrowing engine over _configured variants_.** A variant = a model with one fitted uplink
  option. Filtering and configuring are the same narrowing; survivors carry a resolved kitlist.
  Pinning `uplink_module` narrows the variant domain (and eliminates models whose module group lacks
  it); pinning `model_id` turns a solve into an exact-model lookup whose BOM blocks are the option
  summary (uplink modules, PSUs, licenses, cables).
- **Unified ports.** Capability is data: `model.ports` (role=access) + the fitted module's `ports`
  (role=uplink) form a variant's pool. Each port group is `{count, role, medium, speeds[]}`;
  subsumption is the speed set. Simultaneous multi-speed demand is checked for **pool feasibility**
  against the shared physical ports (so "2×25 and 2×10" on an 8-port module passes, but "8×25 and
  8×10" — 16 ports — fails).
- **Defaulting policy is code, but named and visible.** The `psu-default` policy (ship
  `default_primary`; add a secondary to meet a PoE load; upsize only when no secondary covers it;
  redundancy populates a second bay, triple a third — how many fit is the group's `bays` count,
  what a set delivers is the PoE matrix, and PSUs beyond the load add redundancy not sourced watts)
  and the cable defaults
  (`none_option` when optional; when stacking/stackpower is required, the adapter kit's bundled
  cable on kit series — the kit is surfaced as the prerequisite — else the shortest cable) live in
  `resolve.js`. Every
  resolved default carries its `reason` in the response — an agent doesn't read the policy, it reads
  the outcome, the alternatives, and the rationale.
- **No per-switch logic.** A new switch is new JSON.

## Out of scope (deferred)

~~The MCP server itself~~ *(done: `../mcp/` — a stateless Cloudflare Worker over this core,
unchanged; `docs/mcp-solver-contract.md` is the normative boundary)*; pricing and price-based ranking (the
default order is a deterministic minimal-first stub); multi-switch quantity sizing (a future layer
*on top of* the contract); UI modes (guided run, richer lookup view) — three renderings of the same
response, deliberately after the contract; QSFP/SFP breakout.
