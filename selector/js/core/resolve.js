// resolve.js — port pools, configured variants, pool-feasibility, and BOM.
//
// v0.4.0 port model: a model carries role=access port groups; uplink ports come
// from the fitted network module (modular) or inline on the model (fixed). A
// configured VARIANT = model + one fitted uplink option; its port pool drives
// the parametrised port_count axis. All generic/data-driven — no per-switch logic.

import {
  getNetworkModuleGroup,
  getNetworkModule,
  getPowerSupplyGroup,
  getPowerSupply,
  getStackCableGroup,
  getStackpowerCableGroup,
  getStackKit,
  getLicenseGroup,
} from "./kb.js";

// --- port pools -------------------------------------------------------------
export const accessGroups = (model) => (model.ports ?? []).filter((p) => p.role === "access");
export const inlineUplinkGroups = (model) => (model.ports ?? []).filter((p) => p.role === "uplink");

/**
 * The ACCESS-port configurations of a model. Almost every model has exactly ONE
 * (its static role=access rows). A model with an `access_pair_block` (a bank of
 * combinable pairs, each configured 2x-low OR 1x-high — e.g. C9500-32QC's 16
 * QSFP+ pairs, each 2x40G | 1x100G) instead has pairs+1 configurations: k pairs
 * combined to high, k = 0..pairs. Each configuration is one real simultaneous
 * arrangement, so the solver checks a port demand against every configuration
 * and the model survives if ANY satisfies it (max-flow feasibility per config
 * never over-counts a combined port). This is CAPABILITY only — it never reaches
 * the BOM (access ports are inherent to the SKU, not separately ordered).
 * @returns {Array<{ports: object[]}>}
 */
export function accessConfigs(model) {
  const staticAccess = accessGroups(model);
  const pb = model.access_pair_block;
  if (!pb) return [{ ports: staticAccess }];
  return expandPairBlock(pb, "access").map(({ ports }) => ({ ports: staticAccess.concat(ports) }));
}

/**
 * Expand a combinable-pair bank {pairs, low, high} into pairs+1 discrete
 * port-group configurations (k = 0..pairs pairs assigned to `high`), each a
 * real simultaneous arrangement. `role` is the port role the generated groups
 * carry (access_pair_block -> "access").
 * @returns {Array<{k:number, ports:object[]}>}
 */
function expandPairBlock(pb, role) {
  const out = [];
  for (let k = 0; k <= pb.pairs; k++) {
    const groups = [];
    const lowCount = (pb.pairs - k) * pb.low.ports_per_pair;
    const highCount = k * pb.high.ports_per_pair;
    if (lowCount > 0)
      groups.push({ count: lowCount, role, medium: pb.low.medium, speeds: pb.low.speeds });
    if (highCount > 0)
      groups.push({ count: highCount, role, medium: pb.high.medium, speeds: pb.high.speeds });
    out.push({ k, ports: groups });
  }
  return out;
}

/**
 * The uplink options for a model. Modular models offer each group member plus a
 * "none" option; fixed-uplink models offer their single soldered configuration.
 * A dual-mode module (catalog `modes`, e.g. C9350-NM-8Y: 8x25G | 4x50G) expands
 * into one option per mode — all sharing the same `moduleId` (the real SKU), so
 * the kitlist/BOM never shows a phantom part number; the mode is only a label.
 * A fixed-uplink model with a `uplink_pair_block` (a bank of N combinable pairs,
 * each pair either low.ports_per_pair×low OR high.ports_per_pair×high, e.g. the
 * C9550 CD uplinks: "4x100/40G OR 2x400G") expands into one option per pair-
 * assignment k=0..pairs, so every valid mix is a real simultaneous pool and the
 * solver's max-flow feasibility never over-counts a combined port.
 * @returns {Array<{id:string, moduleId:string|null, mode?:string, ports:object[]}>}
 */
export function uplinkOptions(model, kb) {
  const av = model.axis_values ?? {};
  if (av.uplink_modular) {
    const g = getNetworkModuleGroup(kb, model.configurables?.network_modules?.group);
    if (!g) return [{ id: "none", moduleId: null, ports: [] }];
    const opts = [];
    for (const id of g.members ?? []) {
      const mod = getNetworkModule(kb, id);
      if (mod?.modes?.length) {
        for (const mode of mod.modes)
          opts.push({
            id: `${id}#${mode.name}`,
            moduleId: id,
            mode: mode.name,
            ports: mode.ports ?? [],
          });
      } else {
        opts.push({ id, moduleId: id, ports: mod?.ports ?? [] });
      }
    }
    opts.push({ id: g.none_option, moduleId: null, ports: [] });
    return opts;
  }
  const pb = model.uplink_pair_block;
  if (pb) {
    const base = inlineUplinkGroups(model);
    const opts = [];
    for (let k = 0; k <= pb.pairs; k++) {
      const groups = [...base];
      const lowCount = (pb.pairs - k) * pb.low.ports_per_pair;
      const highCount = k * pb.high.ports_per_pair;
      if (lowCount > 0)
        groups.push({
          count: lowCount,
          role: "uplink",
          medium: pb.low.medium,
          speeds: pb.low.speeds,
        });
      if (highCount > 0)
        groups.push({
          count: highCount,
          role: "uplink",
          medium: pb.high.medium,
          speeds: pb.high.speeds,
        });
      opts.push({ id: `pairs#${k}`, moduleId: null, mode: `${k}-high`, ports: groups });
    }
    return opts;
  }
  return [{ id: "fixed", moduleId: null, ports: inlineUplinkGroups(model) }];
}

// --- port matching + pool feasibility ---------------------------------------
const groupMatches = (g, where) =>
  (!where.role || g.role === where.role) && (!where.medium || g.medium === where.medium);
const groupHasSpeed = (g, speed) => (g.speeds ?? []).includes(speed);

/** Upper-bound count of ports able to run `where.speed` (ignores contention). */
export function portCount(pool, where) {
  return pool
    .filter((g) => groupMatches(g, where) && groupHasSpeed(g, where.speed))
    .reduce((s, g) => s + g.count, 0);
}

/**
 * Can the pool simultaneously satisfy every demand `{where, min}`? A single
 * physical port serves at most one demand, so independent per-speed checks
 * over-match (the 8Y "8x25 AND 8x10" trap). Modelled exactly as a max-flow:
 * source -> demand(min) -> matching groups -> sink(group.count). Feasible iff
 * the flow saturates total demand. Small graphs; Edmonds-Karp is plenty.
 */
export function poolFeasible(pool, demands) {
  if (demands.length === 0) return true;
  // dedup demands on the same selector -> keep the largest min
  const byKey = new Map();
  for (const d of demands) {
    const k = `${d.where.role ?? "*"}|${d.where.medium ?? "*"}|${d.where.speed}`;
    byKey.set(k, Math.max(byKey.get(k) ?? 0, d.min));
  }
  const D = [...byKey.entries()].map(([k, min]) => {
    const [role, medium, speed] = k.split("|");
    return { role: role === "*" ? null : role, medium: medium === "*" ? null : medium, speed, min };
  });

  const S = 0,
    dBase = 1,
    gBase = 1 + D.length,
    T = gBase + pool.length,
    N = T + 1;
  const cap = Array.from({ length: N }, () => ({}));
  const add = (u, v, c) => {
    cap[u][v] = (cap[u][v] ?? 0) + c;
    cap[v][u] = cap[v][u] ?? 0;
  };

  let need = 0;
  D.forEach((d, i) => {
    add(S, dBase + i, d.min);
    need += d.min;
    pool.forEach((g, j) => {
      if (groupMatches(g, { role: d.role, medium: d.medium }) && groupHasSpeed(g, d.speed))
        add(dBase + i, gBase + j, Infinity);
    });
  });
  pool.forEach((g, j) => add(gBase + j, T, g.count));

  let flow = 0;
  for (;;) {
    const prev = new Array(N).fill(-1);
    prev[S] = S;
    const q = [S];
    while (q.length) {
      const u = q.shift();
      for (let v = 0; v < N; v++)
        if (prev[v] === -1 && (cap[u][v] ?? 0) > 0) {
          prev[v] = u;
          q.push(v);
        }
    }
    if (prev[T] === -1) break;
    let b = Infinity;
    for (let v = T; v !== S; v = prev[v]) b = Math.min(b, cap[prev[v]][v]);
    for (let v = T; v !== S; v = prev[v]) {
      cap[prev[v]][v] -= b;
      cap[v][prev[v]] = (cap[v][prev[v]] ?? 0) + b;
    }
    flow += b;
  }
  return flow >= need;
}

// --- BOM (kitlist) ----------------------------------------------------------
export function resolveBOM(model, query, kb, validOptions) {
  const bom = {
    switch: { id: model.id, description: model.description },
    uplinks: resolveUplinkBOM(model, validOptions),
    power: resolvePower(model, query, kb),
    license: resolveLicense(model, query, kb),
    accessories: resolveAccessories(model, query, kb),
    included_by_default: stripComment(model.included_by_default_non_selectable),
  };
  markDecisions(bom, query);
  return bom;
}

// --- Decision status --------------------------------------------------------
// Every configurable block carries a `decision` envelope so a caller can tell —
// without knowing each block's individual shape — what is settled and what still
// needs a choice. Four statuses:
//
//   pinned    the caller constrained it; the customer has already decided
//   defaulted resolved here, and REAL ALTERNATIVES EXIST — this is the
//             "what should I discuss with the customer?" set
//   forced    only one option; there is nothing to decide
//   required  nothing chosen, and nothing MAY be chosen here — the kitlist is
//             not orderable until the caller settles it
//
// `required` is a PRODUCT fact, not a solver one, and the distinction is easy to
// get wrong: an empty second PSU bay is a complete, working, orderable switch
// (→ defaulted, chosen = the single shipped PSU), whereas a switch ships with NO
// license and needs one to run (→ required). Never manufacture a default to fill
// a `required` block — a null `chosen` is the answer there, not a gap.
//
// `variables` names the registry variables that settle the block, so a caller can
// map an open decision straight back into the query it needs to re-send.
//
// Additive by design: no existing block field is renamed or removed, so the web
// UI and every other renderer of this response keep working unchanged.
const STATUSES = ["pinned", "defaulted", "forced", "required"];

const decision = (variables, status, chosen, options_count) => ({
  status,
  chosen,
  options_count,
  variables,
});

function markDecisions(bom, query) {
  const asked = (name) => pickValue(query, name) != null;

  if (bom.uplinks) {
    const n = bom.uplinks.options.length;
    bom.uplinks.decision = decision(
      ["uplink_module"],
      asked("uplink_module") ? "pinned" : n <= 1 ? "forced" : "defaulted",
      bom.uplinks.default,
      n,
    );
  }

  if (bom.power) {
    const dc = bom.power.default_config;
    // bays === 0 is an integrated supply: one PSU, no bay, nothing to choose.
    const fixed = (bom.power.psu_bays?.count ?? 0) === 0;
    bom.power.decision = decision(
      ["psu_redundancy", "psu_triple", "poe_budget_watts"],
      fixed ? "forced" : asked("psu_redundancy") || asked("psu_triple") ? "pinned" : "defaulted",
      dc ? [dc.primary, dc.secondary, dc.tertiary].filter((x) => x != null) : null,
      (bom.power.poe_budget_matrix ?? []).length,
    );
  }

  if (bom.license) bom.license.decision = licenseDecision(bom.license, asked);

  for (const [key, variable] of [
    ["stack_cables", "stack_cable"],
    ["stackpower_cables", "stackpower_cable"],
  ]) {
    const block = bom.accessories?.[key];
    if (!block) continue;
    const n = (block.members ?? []).length;
    // members.length === 1 is still a choice: that cable, or the none_option.
    block.decision = decision(
      [variable],
      asked(variable) ? "pinned" : n === 0 ? "forced" : "defaulted",
      block.default,
      n,
    );
  }

  bom.decisions = summariseDecisions(bom);
}

// A license line is orderable only once regime, tier and term all resolve to one
// concrete SKU. Anything short of that is `required`: the switch needs a license
// and comes with none, so a blank here is an INCOMPLETE ORDER, not a default.
function licenseDecision(lic, asked) {
  const groups = lic.groups ?? [];
  const only = groups.length === 1 ? groups[0] : null;
  // A group with no term choices (e.g. Meraki subscription-L, one device-tied
  // SKU) is term-settled without the caller saying anything.
  const termSettled =
    only != null && ((only.term_choices_years ?? []).length === 0 || only.chosen_term != null);
  const variables = ["license_regime", "license_tier", "license_term"];

  if (!only || !termSettled) return decision(variables, "required", null, groups.length);

  const constrained = asked("license_regime") || asked("license_tier") || asked("license_term");
  return decision(
    variables,
    constrained ? "pinned" : "forced",
    {
      group: only.id,
      regime: only.regime,
      tier: only.tier,
      subscription_sku:
        only.chosen_term?.subscription_sku ?? (only.subscription_members ?? [])[0] ?? null,
    },
    groups.length,
  );
}

/** Roll the per-block decisions up so a caller sees the shape of the answer
 *  without scanning every block: what is worth discussing, and what blocks the
 *  order outright. */
function summariseDecisions(bom) {
  const counts = Object.fromEntries(STATUSES.map((s) => [s, 0]));
  const discuss = [];
  const blocking = [];
  const entries = [
    ["uplinks", bom.uplinks?.decision],
    ["power", bom.power?.decision],
    ["license", bom.license?.decision],
    ["accessories.stack_cables", bom.accessories?.stack_cables?.decision],
    ["accessories.stackpower_cables", bom.accessories?.stackpower_cables?.decision],
  ];
  for (const [path, d] of entries) {
    if (!d) continue;
    counts[d.status] += 1;
    if (d.status === "defaulted") discuss.push(path);
    if (d.status === "required") blocking.push(path);
  }
  return { counts, discuss, blocking };
}

function resolveUplinkBOM(model, validOptions) {
  const modular = !!model.axis_values?.uplink_modular;
  const opts = (validOptions ?? []).map((o) => ({
    id: o.id,
    moduleId: o.moduleId,
    mode: o.mode,
    ports: o.ports,
  }));
  // none_option has moduleId === null; prefer it as default (standalone switch, no uplink module fitted).
  // When a port demand excluded the none_option, fall back to the first valid real module.
  const noneOpt = opts.find((o) => o.moduleId === null);
  const dflt = noneOpt ?? opts[0] ?? null;
  return { modular, default: dflt?.id ?? null, options: opts };
}

// What the chassis can HOLD (bays, member PSUs) is a chassis fact on the PSU
// group; what a populated set DELIVERS is the datasheet poe_budget_matrix. The
// two are independent — redundancy capability is `bays >= 2`, NOT "the matrix has
// a row with a secondary". A spare bay accepts any group member (the group is the
// per-chassis compatibility list); valid_primary restricts only the PRIMARY role.
function resolvePower(model, query, kb) {
  const ps = model.configurables?.power_supplies;
  if (!ps) return null;
  const group = getPowerSupplyGroup(kb, ps.group);
  const bays = ps.bays ?? group?.bays ?? 0; // per-model override, else group, else integrated
  const need = numericMin(query, "poe_budget_watts");
  const redundancy = pickValue(query, "psu_redundancy") === true;
  const triple = pickValue(query, "psu_triple") === true;
  const matrix = ps.poe_budget_matrix ?? [];
  const rows = need == null ? matrix : matrix.filter((r) => r.poe_budget_watts >= need);
  // A matrix flagged _incomplete carries derived-not-sourced numbers: never turn
  // an unsourced blank into a confident "does not meet" — meets stays null.
  const matrixUnconfirmed = (model._incomplete ?? []).includes("poe_budget_matrix");

  // The PSU bay layout, as one self-contained section: how many bays, the default
  // shipped primary, and what each bay accepts. PoE-independent — this is the
  // "redundant PSU" answer that stands on its own next to the PoE budget matrix.
  const psu_bays = {
    count: bays, // 0 = fixed / integrated supply
    fixed: bays === 0,
    populated_by_default: 1, // the kitlist ships exactly the default_primary
    default_primary: ps.default_primary,
    primary_options: ps.valid_primary ?? [], // what may be the PRIMARY (a role restriction)
    additional_bay_options: bays >= 2 ? (group?.members ?? []) : [], // any group member fits a spare bay
    max_additional: bays === 0 ? 0 : Math.max(bays - 1, 0),
  };
  if (bays >= 2 && group?.secondary_none_option != null)
    psu_bays.decline_redundant_sku = group.secondary_none_option;

  const out = {
    group: ps.group,
    psu_bays,
    default_config: chooseDefaultPsu(ps, kb, need, redundancy, triple, bays),
    poe_budget_matrix: rows,
    meets_requested_budget: need == null || matrixUnconfirmed ? null : rows.length > 0,
  };
  // Provenance passthrough (zero logic): let a client tell a sourced blank from an
  // unsourced one, and a datasheet matrix from a derived-by-analogy one.
  if (ps.matrix_provenance != null) out.matrix_provenance = ps.matrix_provenance;
  if (matrixUnconfirmed) out.poe_budget_matrix_unconfirmed = true;
  return out;
}

// Resolve the default PSU config as (primary [, secondary [, tertiary]]) + reason.
// Two independent facts drive it, never derived from each other:
//   - the poe_budget_matrix decides which PSUs the requested PoE LOAD needs (the
//     "PoE base") and what a populated set DELIVERS — a datasheet fact;
//   - the chassis `bays` count decides how many PSUs FIT; redundancy/triple say how
//     many the caller WANTS — chassis / intent facts.
// fitted = bays === 0 ? 1 : min(max(nPoe, nAsked), bays). PSUs beyond the PoE base
// are redundancy / StackPower headroom: they never invent watts — the reported
// budget is the best SOURCED matrix row that is a subset of what is installed.
function chooseDefaultPsu(ps, kb, need, redundancy, triple, bays) {
  const dp = ps.default_primary;
  const matrix = ps.poe_budget_matrix ?? [];
  const w = (id) => (id == null ? 0 : (getPowerSupply(kb, id)?.watts ?? 0));
  const meets = (r) => need == null || r.poe_budget_watts >= need;
  const psusOf = (c) => [c.primary, c.secondary, c.tertiary].filter((x) => x != null);

  // PoE base: the set the matrix requires for `need`, ignoring redundancy intent.
  // This is the previous no-flag policy verbatim, so the unflagged path is unchanged.
  const base = poeBase();
  if (base == null) return null; // load not satisfiable by this model's PSU options

  const nPoe = psusOf(base).length;
  const nAsked = triple ? 3 : redundancy ? 2 : 1;
  const target = bays === 0 ? 1 : Math.min(Math.max(nPoe, nAsked), bays);

  // Integrated supply (no bay): exactly one PSU — a redundancy ask cannot be met.
  if (bays === 0 && nAsked > 1)
    return { ...base, reason: "integrated supply — redundancy not available (no PSU bay)" };
  if (target <= nPoe) return base; // nothing to add: the no-flag / already-sized case

  // Redundancy extension: fill the extra bays with PSUs matching the primary (a
  // backup must at least match the primary; matching keeps it simplest).
  const bayList = psusOf(base);
  while (bayList.length < target) bayList.push(base.primary);
  const [primary, secondary = null, tertiary = null] = bayList;

  // Reported budget = the best SOURCED matrix row whose PSU multiset is a subset of
  // what is installed. Equal set => a full sourced row (the extra PSU raises budget);
  // strict subset => the extras add redundancy, not sourced watts.
  const subsetRows = matrix.filter((r) => multisetSubset(psusOf(r), bayList));
  const best = subsetRows.reduce(
    (r, x) => (x.poe_budget_watts > (r?.poe_budget_watts ?? -1) ? x : r),
    null,
  );
  const fullRow = subsetRows.some((r) => psusOf(r).length === bayList.length);
  const out = { primary, secondary, tertiary, watts: best ? best.poe_budget_watts : base.watts };
  if (fullRow) {
    out.reason = target === 3 ? "triple PSU — sourced three-PSU budget" : "redundant matched pair";
  } else {
    if (best)
      out.watts_basis = `sourced ${psusOf(best).length}-PSU row (${psusOf(best).join(" + ")}); the added PSU(s) supply redundancy, not sourced budget`;
    out.reason =
      target === 3
        ? "third bay populated on request — adds redundancy, not budget"
        : "redundant matched pair";
  }
  return out;

  // --- helpers ---------------------------------------------------------------
  function poeBase() {
    if (matrix.length === 0)
      return {
        primary: dp,
        secondary: null,
        tertiary: null,
        watts: null,
        reason: "default single",
      };
    const dpRows = matrix.filter((r) => r.primary === dp);
    const dpSingle = dpRows.find((r) => r.secondary == null);
    if (dpSingle && meets(dpSingle))
      return {
        primary: dp,
        secondary: null,
        tertiary: null,
        watts: dpSingle.poe_budget_watts,
        reason:
          need == null ? "base default (no PoE budget specified)" : "default single meets load",
      };
    // keep the default primary; add the fewest/smallest extra PSUs that meet the load
    // (prefer a 2-PSU pair over a 3-PSU combo, then the smallest secondary/tertiary).
    const dpPairs = dpRows
      .filter((r) => r.secondary != null && meets(r))
      .sort(
        (a, b) =>
          (a.tertiary ? 1 : 0) - (b.tertiary ? 1 : 0) ||
          w(a.secondary) - w(b.secondary) ||
          w(a.tertiary) - w(b.tertiary),
      );
    if (dpPairs.length) {
      const r = dpPairs[0];
      return {
        primary: dp,
        secondary: r.secondary,
        tertiary: r.tertiary ?? null,
        watts: r.poe_budget_watts,
        reason: r.tertiary
          ? "added secondary+tertiary to meet load"
          : "added secondary to meet load",
      };
    }
    // upsize: fewest PSUs, then smallest primary/secondary/tertiary, that meets the load
    const feasible = matrix
      .filter(meets)
      .sort(
        (a, b) =>
          (a.tertiary ? 1 : 0) - (b.tertiary ? 1 : 0) ||
          w(a.primary) - w(b.primary) ||
          w(a.secondary) - w(b.secondary) ||
          w(a.tertiary) - w(b.tertiary),
      );
    if (feasible.length) {
      const r = feasible[0];
      return {
        primary: r.primary,
        secondary: r.secondary,
        tertiary: r.tertiary ?? null,
        watts: r.poe_budget_watts,
        reason: "upsized primary (no secondary covered the load)",
      };
    }
    return null;
  }

  // Is multiset `a` contained in multiset `b`? (PSU SKU ids, order-independent.)
  function multisetSubset(a, b) {
    const cnt = new Map();
    for (const x of b) cnt.set(x, (cnt.get(x) ?? 0) + 1);
    for (const x of a) {
      const c = cnt.get(x) ?? 0;
      if (c <= 0) return false;
      cnt.set(x, c - 1);
    }
    return true;
  }
}

// License tier is locked on DNA -E/-A models and selectable on Meraki -M
// models; term (a must_resolve configuration variable) resolves the concrete
// subscription SKU.
function resolveLicense(model, query, kb) {
  const lic = model.configurables?.license;
  if (!lic) return null;
  const wantRegime = pickValue(query, "license_regime");
  const wantTier = pickValue(query, "license_tier");
  const wantTerm = pickValue(query, "license_term");

  const groups = [lic.group, ...(lic.additional_groups ?? [])]
    .map((id) => getLicenseGroup(kb, id))
    .filter(Boolean)
    .filter((g) => wantRegime == null || g.regime === wantRegime);

  const offeredTiers = [...new Set(groups.map((g) => g.tier))];
  // apply a tier pick only where the model actually offers it (never eliminates)
  const shown =
    wantTier != null && offeredTiers.includes(wantTier)
      ? groups.filter((g) => g.tier === wantTier)
      : groups;

  const out = shown.map((g) => {
    const terms = g.term_variable?.choices_years ?? [];
    let chosen_term = null;
    if (wantTerm != null) {
      if (terms.length === 0) {
        // term not applicable (e.g. Meraki subscription-L: one device-tied SKU)
        chosen_term = {
          term_years: null,
          not_applicable: true,
          subscription_sku: (g.subscription_members ?? [])[0] ?? null,
        };
      } else {
        const sku = (g.subscription_members ?? []).find((s) =>
          new RegExp(`-${wantTerm}Y$`).test(s),
        );
        chosen_term = { term_years: wantTerm, subscription_sku: sku ?? null, available: !!sku };
      }
    }
    return {
      id: g.id,
      regime: g.regime,
      tier: g.tier,
      port_class: g.port_class,
      perpetual_member: g.perpetual_member,
      subscription_members: g.subscription_members ?? [],
      term_choices_years: terms,
      chosen_term,
    };
  });
  return {
    regime_offered: lic.regime_offered ?? [],
    tier_locked: lic.tier_locked ?? (offeredTiers.length === 1 ? offeredTiers[0] : null),
    tier_selectable: !lic.tier_locked && offeredTiers.length > 1,
    offered_tiers: offeredTiers,
    groups: out,
  };
}

function resolveAccessories(model, query, kb) {
  const cfg = model.configurables ?? {};
  const out = {};
  const stack = getStackCableGroup(kb, cfg.stack_cables?.group);
  if (stack)
    out.stack_cables = cableInfo(
      stack,
      kb._index.stack_cables,
      kb,
      hardBoolTrue(query, "stacking_capable"),
    );
  const sp = getStackpowerCableGroup(kb, cfg.stackpower_cables?.group);
  if (sp)
    out.stackpower_cables = cableInfo(
      sp,
      kb._index.stackpower_cables,
      kb,
      hardBoolTrue(query, "stackpower_capable"),
    );
  if (cfg.ssd_accessory) out.ssd_accessory = cfg.ssd_accessory;
  return out;
}

function hardBoolTrue(query, name) {
  return (query ?? []).some(
    (c) =>
      c.variable === name &&
      c.condition === "==" &&
      c.value === true &&
      (c.severity ?? "hard") === "hard",
  );
}

// A standalone switch needs no cable: default to the group's none_option. If
// the matching stacking/stackpower capability is a hard requirement, the model
// must actually stack, so resolve a real default:
//   - adapter-kit series (group.stack_kit set): the kit is the prerequisite and
//     ships with a bundled cable — lead with the kit and default the cable to the
//     kit's included_cable (never a bare cable that would not stack without the kit).
//   - backplane-native series (no kit): default to the shortest cable.
// `prerequisite` is the first-class kit (or null); renderers surface it as the
// primary BOM line, with `members` as the cable-length options / upgrades.
function cableInfo(group, catIndex, kb, required) {
  const withLen = (group.members ?? [])
    .map((id) => ({ id, len: catIndex.get(id)?.length_cm ?? Infinity }))
    .sort((a, b) => a.len - b.len);
  const shortest = withLen[0]?.id ?? null;
  const kit = group.stack_kit ? getStackKit(kb, group.stack_kit) : null;
  const prerequisite = kit ? { id: kit.id, included_cable: kit.included_cable ?? null } : null;
  const defaultCable = required
    ? ((prerequisite ? (prerequisite.included_cable ?? shortest) : shortest) ?? group.none_option)
    : group.none_option;
  return {
    group: group.id,
    prerequisite,
    default: defaultCable,
    none_option: group.none_option,
    shortest,
    members: group.members ?? [],
    // Retained for back-compat with any consumer reading the flat id; renderers
    // should prefer `prerequisite`.
    stack_kit: group.stack_kit,
  };
}

// --- helpers ----------------------------------------------------------------
function stripComment(obj) {
  if (!obj || typeof obj !== "object") return obj;
  const { _comment, ...rest } = obj;
  return rest;
}
// Most-restrictive >= bound across ALL constraints on a variable (an explicit
// control and a demand-derived constraint intersect — the highest wins).
function numericMin(query, name) {
  const vals = (query ?? [])
    .filter((c) => c.variable === name && c.condition === ">=")
    .map((c) => c.value);
  return vals.length ? Math.max(...vals) : null;
}
/** The pinned (==) value of a variable in the query, or null. Whether a pin
 *  filters models or only refines this BOM is the registry's `eliminates`
 *  declaration — by the time we are here, filtering already happened. */
function pickValue(query, name) {
  const c = (query ?? []).find((c) => c.variable === name && c.condition === "==");
  return c ? c.value : null;
}
