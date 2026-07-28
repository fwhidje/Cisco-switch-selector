// respond.js — transport shaping of the solve() response (contract §5).
//
// Trimming is presentation, not logic: the server never reorders or re-chooses
// within the solver's answer. open_variables ships whole — it is the client
// agent's "what should I ask next" list — decorated with the registry's
// presentation hints (ask_priority, depends_on) so a sequential agent asks in
// the intended order.

import { getVariable, dependsOn } from "../../selector/js/core/registry.js";

export function trimResponse(res, query, registry, limit = 3) {
  const eliminated_summary = {};
  for (const e of res.eliminated)
    eliminated_summary[e.reason] = (eliminated_summary[e.reason] ?? 0) + 1;

  return {
    registry_version: registry.registry_version,
    total_candidates: res.candidates.length,
    candidates: res.candidates.slice(0, limit),
    // Every survivor's id, uncapped — read from the UNTRIMMED list, so it is the
    // compensation for `limit` discarding candidates over the wire. Solver order
    // is preserved (smallest sufficient config first), so the first `limit` ids
    // are exactly the kitlists returned above in full. Never re-sort.
    all_matches: res.candidates.map((c) => c.model.id),
    open_variables: res.open_variables.map((ov) => decorate(ov, registry)),
    eliminated_summary,
    query_echo: query,
  };
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
