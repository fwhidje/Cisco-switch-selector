// solver.js — generic, stateless selection engine over configured variants.
//
// solve(query, kb, registry) -> { candidates, default, open_variables, eliminated }
//
// A query is a list of constraints (see query.js). Constraints are routed by
// the REGISTRY, not by a structural query class: model-dimension variables
// filter on stored values (or model identity); eliminating configuration
// variables (uplink_module) restrict the variant options; non-eliminating
// configuration picks never filter — resolveBOM reads them from the query.
//
// The response is the project's central contract — every front-end (web UI,
// MCP server, agent) is a renderer of it:
//   candidates      surviving configurations, ranked; each carries the model
//                   plus a resolved `bom` (default choices, each with a reason)
//                   whose blocks double as the per-candidate choice domains.
//   open_variables  the RESIDUAL DECISION SPACE: every variable the query left
//                   open, with its remaining domain across the survivors, its
//                   default rule, and must_resolve where no safe default exists.
//   eliminated      models removed, each with the FIRST violated constraint —
//                   an attribution, not a cost. Counting these by reason measures
//                   evaluation order, not what a constraint excludes.
//
// Derived projections that need extra solves are SEPARATE exports, never folded
// in here, so a caller pays only for what it reads (the web UI re-solves on
// interaction): facetDomains() for live per-variable values.
//
// The engine checks port demand against each model's uplink VARIANTS via
// pool-feasibility (a model survives if some fitted uplink option makes the
// whole demand feasible). No per-switch logic; new switches are new JSON.
// Pure: no DOM, no fetch, no globals.

import { uplinkOptions, accessConfigs, poolFeasible, resolveBOM } from "./resolve.js";
import { getModels } from "./kb.js";
import {
  getVariables,
  getVariable,
  isModelDimension,
  eliminates,
  storageOf,
  defaultRule,
  mustResolve,
  binding,
  legalValues,
  acceptedConditions,
  isCountAtLevel,
} from "./registry.js";

export function solve(query, kb, registry) {
  const cons = query ?? [];
  const isHard = (c) => (c.severity ?? "hard") === "hard";
  const soft = cons.filter((c) => c.severity === "soft");

  const hardScalar = [];
  const hardPort = [];
  const variantPicks = [];
  for (const c of cons) {
    if (!isHard(c)) continue;
    if (c.variable === "port_count") {
      hardPort.push(c);
      continue;
    }
    const v = getVariable(registry, c.variable);
    if (!v) continue; // unknown variable: a validateQuery() problem, never a silent filter
    if (isModelDimension(v)) hardScalar.push(c);
    else if (eliminates(v)) variantPicks.push(c); // uplink_module: restricts the variant domain
    // non-eliminating configuration picks are read from `cons` by resolveBOM
  }

  const survivors = [];
  const eliminated = [];

  for (const model of getModels(kb)) {
    const fail = firstFailingScalar(model, hardScalar, registry);
    if (fail) {
      eliminated.push({ id: model.id, reason: describe(fail) });
      continue;
    }

    const modelKb = model._kb ?? kb;
    let options = uplinkOptions(model, modelKb);
    // An eliminating configuration pick narrows the variant domain; a model
    // whose domain empties dies on that constraint (e.g. its module group
    // lacks the pinned uplink module).
    const pickFail = variantPicks.find((c) => {
      const next = options.filter((o) => optionMatches(o, c));
      if (next.length === 0) return true;
      options = next;
      return false;
    });
    if (pickFail) {
      eliminated.push({ id: model.id, reason: describe(pickFail) });
      continue;
    }

    const aConfigs = accessConfigs(model);
    const demands = hardPort.map((c) => ({ where: c.where, min: c.value }));
    // A uplink option survives if SOME access configuration makes the whole
    // port demand jointly feasible (each access-config × uplink-option pool is
    // one real simultaneous arrangement). Access configs are solver-internal;
    // only uplink options reach the BOM.
    const validOptions = demands.length
      ? options.filter((o) =>
          aConfigs.some((a) => poolFeasible(a.ports.concat(o.ports ?? []), demands)),
        )
      : options;

    if (demands.length && validOptions.length === 0) {
      eliminated.push({ id: model.id, reason: portDemandText(hardPort) });
      continue;
    }
    survivors.push({ model, validOptions });
  }

  rank(survivors, soft);

  const candidates = survivors.map((s) => ({
    model: modelSummary(s.model),
    bom: resolveBOM(s.model, cons, s.model._kb ?? kb, s.validOptions),
  }));

  return {
    candidates,
    default: candidates[0] ?? null,
    open_variables: openVariables(cons, survivors, registry),
    eliminated,
  };
}

/** Candidate model summary: identity plus the switch's own (access) port
 *  capability, so renderers can show "what the box is" without a KB re-lookup.
 *  Access ports are inherent to the SKU — capability, not an orderable part. */
function modelSummary(m) {
  const out = { id: m.id, description: m.description };
  const access = (m.ports ?? []).filter((p) => p.role === "access");
  if (access.length) out.ports = access;
  if (m.access_pair_block) out.access_pair_block = m.access_pair_block;
  return out;
}

/** Does a variant option satisfy an uplink_module pick? Matches the real
 *  orderable SKU (moduleId) or the option id (covers the none_option). */
function optionMatches(o, c) {
  const wanted = c.condition === "in" ? c.value : [c.value];
  return wanted.some((val) => o.moduleId === val || o.id === val);
}

/** First hard scalar constraint this model violates, or null. */
function firstFailingScalar(model, constraints, registry) {
  for (const c of constraints) {
    const v = getVariable(registry, c.variable);
    const value = storageOf(v) === "identity" ? model.id : (model.axis_values ?? {})[c.variable];
    if (!satisfiesScalar(value, c, v)) return c;
  }
  return null;
}

/**
 * Generic scalar condition evaluation. Ordered enums (e.g. poe_type) compare by
 * registry order so ">=" means "this level or better". Set-valued model values
 * (license_regime) are handled by membership. Absent optional variable -> fails.
 */
export function satisfiesScalar(value, c, variable) {
  if (value === undefined || value === null) return false;
  const ordered = variable?.kind === "ordered";
  const order = variable?.order ?? variable?.legal_values ?? [];

  switch (c.condition) {
    case ">=":
      if (ordered) return order.indexOf(value) >= order.indexOf(c.value);
      return typeof value === "number" && value >= c.value;
    case "<=":
      if (ordered) return order.indexOf(value) <= order.indexOf(c.value);
      return typeof value === "number" && value <= c.value;
    case "==":
      return Array.isArray(value) ? value.includes(c.value) : value === c.value;
    case "in": {
      const opts = Array.isArray(c.value) ? c.value : [c.value];
      return Array.isArray(value) ? value.some((v) => opts.includes(v)) : opts.includes(value);
    }
    default:
      return false;
  }
}

// --- residual decision space -------------------------------------------------

/**
 * The open variables of a result: every registry variable not pinned (hard ==)
 * by the query, with its remaining domain across the survivors, its default
 * rule, and must_resolve. Skipped by design: identity (model_id — its open
 * domain IS the candidate list), parametrised port variables (capability lives
 * in the candidates' port pools), and variables with no accepted conditions
 * (psu_config — per-candidate only, its domain is each candidate's PSU group
 * members over its bay count).
 */
export function openVariables(query, survivors, registry) {
  const out = [];
  for (const v of getVariables(registry)) {
    if (storageOf(v) === "identity" || isCountAtLevel(v)) continue;
    if (acceptedConditions(v).length === 0) continue;
    const pinned = (query ?? []).some(
      (c) => c.variable === v.name && c.condition === "==" && (c.severity ?? "hard") === "hard",
    );
    if (pinned) continue;
    out.push({
      name: v.name,
      domain: domainOf(v, query, survivors),
      default: defaultRule(v),
      must_resolve: mustResolve(v),
    });
  }
  return out;
}

/** Remaining domain of a variable across the survivors, intersected with the
 *  query's own bounds on it (an `in`-list or ordered/numeric >= / <= keeps the
 *  domain inside what the caller already asked for — a set-valued survivor may
 *  OFFER values outside the ask, but those are not honest residual answers).
 *  Enums/booleans return a value array (registry order where declared);
 *  numerics return {min, max}. */
function domainOf(v, query, survivors) {
  const own = (query ?? []).filter(
    (c) => c.variable === v.name && (c.severity ?? "hard") === "hard",
  );

  if (v.type === "integer" && v.kind === "numeric") {
    let min = null,
      max = null;
    for (const s of survivors) {
      const val = s.model.axis_values?.[v.name];
      if (typeof val !== "number") continue;
      min = min === null ? val : Math.min(min, val);
      max = max === null ? val : Math.max(max, val);
    }
    if (min === null) return null;
    for (const c of own) {
      if (c.condition === ">=") min = Math.max(min, c.value);
      if (c.condition === "<=") max = Math.min(max, c.value);
    }
    return { min, max };
  }

  const values = new Set();
  if (isModelDimension(v)) {
    for (const s of survivors) {
      const val = s.model.axis_values?.[v.name];
      if (val === undefined || val === null) continue;
      for (const x of Array.isArray(val) ? val : [val]) values.add(x);
    }
  } else {
    collectConfigurationDomain(v, query, survivors, values);
  }
  const inBounds = [...values].filter((x) => own.every((c) => satisfiesScalar(x, c, v)));
  return sortDomain(v, new Set(inBounds));
}

/** Union a configuration variable's per-survivor domain via its KB binding. */
function collectConfigurationDomain(v, query, survivors, values) {
  const source = binding(v)?.source;
  if (!source) {
    // closed-domain configuration variable (booleans)
    for (const x of legalValues(v)) values.add(x);
    return;
  }
  for (const s of survivors) {
    const kb = s.model._kb;
    switch (source) {
      case "network_module_group":
        // honest residual: validOptions already reflect any port demand
        for (const o of s.validOptions ?? []) if (o.moduleId != null) values.add(o.moduleId);
        break;
      case "stack_cable_group": {
        const g = kb?._index.stack_cable_groups.get(s.model.configurables?.stack_cables?.group);
        for (const m of g?.members ?? []) values.add(m);
        break;
      }
      case "stackpower_cable_group": {
        const g = kb?._index.stackpower_cable_groups.get(
          s.model.configurables?.stackpower_cables?.group,
        );
        for (const m of g?.members ?? []) values.add(m);
        break;
      }
      case "license_group_terms": {
        // respect regime/tier pins the same way resolveBOM does
        const wantRegime = pinValue(query, "license_regime");
        const wantTier = pinValue(query, "license_tier");
        const lic = s.model.configurables?.license;
        for (const gid of [lic?.group, ...(lic?.additional_groups ?? [])].filter(Boolean)) {
          const g = kb?._index.license_groups.get(gid);
          if (!g) continue;
          if (wantRegime != null && g.regime !== wantRegime) continue;
          if (wantTier != null && g.tier !== wantTier) continue;
          for (const y of g.term_variable?.choices_years ?? []) values.add(y);
        }
        break;
      }
    }
  }
}

function pinValue(query, name) {
  const c = (query ?? []).find((c) => c.variable === name && c.condition === "==");
  return c ? c.value : null;
}

function sortDomain(v, values) {
  const order = v.order ?? v.legal_values ?? [];
  const arr = [...values];
  arr.sort((a, b) => {
    const ia = order.indexOf(a),
      ib = order.indexOf(b);
    if (ia !== -1 && ib !== -1) return ia - ib;
    if (typeof a === "number" && typeof b === "number") return a - b;
    return String(a).localeCompare(String(b));
  });
  return arr;
}

/**
 * Facet domains for the UI: name -> Set of live values for every enum-rendered
 * variable. Unpinned variables read straight from mainResult.open_variables;
 * a pinned variable is re-solved WITHOUT its own constraints so its facet still
 * shows the live alternatives. (This replaces the per-value availableValues
 * brute force — the UI's greyed options and an agent's "what could I still
 * pick" are the same residual-domain computation.)
 */
export function facetDomains(query, kb, registry, mainResult) {
  const main = mainResult ?? solve(query, kb, registry);
  const domains = new Map();
  for (const ov of main.open_variables) {
    if (Array.isArray(ov.domain)) domains.set(ov.name, new Set(ov.domain));
  }
  for (const v of getVariables(registry)) {
    if (domains.has(v.name) || storageOf(v) === "identity" || isCountAtLevel(v)) continue;
    if (acceptedConditions(v).length === 0) continue;
    const rest = (query ?? []).filter((c) => c.variable !== v.name);
    const r = solve(rest, kb, registry);
    const ov = r.open_variables.find((o) => o.name === v.name);
    if (ov && Array.isArray(ov.domain)) domains.set(v.name, new Set(ov.domain));
  }
  return domains;
}

// --- ranking -----------------------------------------------------------------

function rank(survivors, soft) {
  survivors.sort((a, b) => {
    for (const c of soft) {
      const av = a.model.axis_values?.[c.variable];
      const bv = b.model.axis_values?.[c.variable];
      if (typeof av === "number" && typeof bv === "number" && av !== bv)
        return c.condition === "maximize" ? bv - av : av - bv;
    }
    // deterministic default order (no price data yet): fewer ports, then id —
    // the minimal configuration that satisfies the constraints ranks first
    const ap = a.model.axis_values?.total_port_count ?? 0;
    const bp = b.model.axis_values?.total_port_count ?? 0;
    if (ap !== bp) return ap - bp;
    return a.model.id.localeCompare(b.model.id);
  });
}

function describe(c) {
  const v = Array.isArray(c.value) ? `[${c.value.join(", ")}]` : c.value;
  return `${c.variable} ${c.condition} ${v}`;
}
function portDemandText(portCons) {
  return portCons
    .map(
      (c) =>
        `ports{${[c.where.role, c.where.medium, c.where.speed].filter(Boolean).join("/")}} ${c.condition} ${c.value}`,
    )
    .join(" & ");
}
