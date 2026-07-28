// respond.js — transport shaping of the solve() response (contract §5).
//
// Trimming is presentation, not logic: the server never reorders or re-chooses
// within the solver's answer. open_variables carries the OPEN DECISION SPACE —
// every decision still genuinely in play — decorated with the registry's
// presentation hints (ask_priority, depends_on) so a sequential agent asks in
// the intended order. Variables whose domain has collapsed to a single value are
// settled facts, not decisions, and are filtered out (see isOpen).

import { getVariable, dependsOn } from "../../selector/js/core/registry.js";

/**
 * Shape one solve() result for transport. The two tools genuinely produce
 * different response shapes, so the per-tool differences are NAMED options
 * rather than inferred from `limit`:
 *
 * - `constraintCost` is computed by the CORE (solver.constraintCost) and passed
 *   in — this function has no `kb` and must not acquire selection logic.
 *   lookup_model omits it: with `model_id ==` as the only constraint,
 *   leave-one-out would solve the empty query and report "relaxing this recovers
 *   236", which is noise rather than a relaxation hint.
 * - `allMatches` is off for lookup_model: "every model matching model_id == X"
 *   is [X], which tells the caller only what it just asked.
 */
export function trimResponse(res, query, registry, opts = {}) {
  const { limit = 3, constraintCost = null, allMatches = true } = opts;
  const out = {
    registry_version: registry.registry_version,
    total_candidates: res.candidates.length,
    candidates: res.candidates.slice(0, limit),
  };
  // Every survivor's id, uncapped — read from the UNTRIMMED list, so it is the
  // compensation for `limit` discarding candidates over the wire. Solver order
  // is preserved (smallest sufficient config first), so the first `limit` ids
  // are exactly the kitlists returned above in full. Never re-sort.
  if (allMatches) out.all_matches = res.candidates.map((c) => c.model.id);
  out.open_variables = res.open_variables.filter(isOpen).map((ov) => decorate(ov, registry));
  if (constraintCost) out.constraint_cost = constraintCost;
  out.query_echo = query;
  return out;
}

/**
 * Is this variable an OPEN decision — something the caller could still go either
 * way on? `open_variables` is the open decision SPACE, not an inventory of every
 * registry variable: a domain narrowed to a single value is a settled fact about
 * the survivors, which the candidates' own BOM blocks already state. Shipping it
 * here restates the model under a heading that promises otherwise, and on a
 * single-candidate lookup that noise was ~60% of the field.
 *
 * `must_resolve` survives regardless of domain size. Even with one legal value
 * the caller must actively settle it (licensing — the switch ships with none),
 * so it is an open decision by definition. Dropping it on domain size would hide
 * the one thing that blocks an orderable kitlist, which is exactly the failure
 * the `required` status exists to prevent.
 */
function isOpen(ov) {
  if (ov.must_resolve) return true;
  const d = ov.domain;
  if (Array.isArray(d)) return d.length > 1;
  if (d && typeof d === "object") return d.min !== d.max; // numeric {min, max}
  return false; // null: nothing to choose
}

function decorate(ov, registry) {
  const v = getVariable(registry, ov.name);
  const out = { ...ov };
  if (v?.presentation?.ask_priority != null) out.ask_priority = v.presentation.ask_priority;
  const dep = dependsOn(v);
  if (dep) out.depends_on = dep;
  return out;
}

/** Nearest known model ids for a failed exact lookup (contract §4): ranked
 *  prefix > substring > reverse-substring, case-insensitive, capped. */
export function nearestModels(models, wanted, cap = 8) {
  const w = wanted.trim().toUpperCase();
  const scored = [];
  for (const m of models) {
    const id = m.id.toUpperCase();
    let score = null;
    if (id.startsWith(w)) score = 0;
    else if (id.includes(w)) score = 1;
    else if (w.includes(id)) score = 2;
    if (score !== null) scored.push({ id: m.id, score });
  }
  scored.sort((a, b) => a.score - b.score || a.id.localeCompare(b.id));
  return scored.slice(0, cap).map((s) => s.id);
}
