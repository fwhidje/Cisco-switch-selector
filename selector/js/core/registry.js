// registry.js — thin accessors over the decision-variable registry (switching-axes.json).
//
// The registry is the SINGLE SOURCE of the constrainable vocabulary. The UI
// (form controls + panel layout), the solver (query validation, condition
// evaluation, residual-domain reporting), and a future MCP server all read the
// legal variables from here — nothing is constrainable unless declared.
//
// v1.0.0: one flat `variables` list over configurations. Per variable the
// registry declares its DIMENSION (model | configuration), whether a constraint
// on it can ELIMINATE models, its DEFAULT rule (incl. must_resolve = no safe
// default exists), its BINDING (where a configuration variable's domain lives
// in the KB), and PRESENTATION metadata (panel group, ask priority).
//
// Pure module: no DOM, no globals. loadRegistry does the one fetch; everything
// else operates on the already-parsed object so the solver stays IO-free.

/**
 * Fetch + parse the registry.
 * @param {string} url
 * @returns {Promise<object>} parsed switching-axes.json
 */
export async function loadRegistry(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`registry fetch failed: ${res.status} ${url}`);
  return res.json();
}

/** All decision-variable definitions, in registry order. */
export function getVariables(registry) {
  return registry.variables ?? [];
}

/** One variable definition by name, or undefined. */
export function getVariable(registry, name) {
  return getVariables(registry).find((v) => v.name === name);
}

/** Legal enum values for an enum variable (empty for non-enum / open-enum). */
export function legalValues(variable) {
  return variable?.legal_values ?? [];
}

/** Conditions a variable accepts (e.g. [">="] or ["==", "in"]). */
export function acceptedConditions(variable) {
  return variable?.accepted_conditions ?? [];
}

/** Model-dimension: value supplied by the model entry itself. */
export const isModelDimension = (v) => (v?.dimension ?? "model") === "model";

/** Configuration-dimension: domain derived from the KB via the binding. */
export const isConfigurationDimension = (v) => v?.dimension === "configuration";

/** Can a hard constraint on this variable remove models? (declared, not inferred) */
export const eliminates = (v) => v?.eliminates !== false;

/** Where a model-dimension value is stored: "axis_values" (default) | "identity" | "ports". */
export const storageOf = (v) => v?.storage ?? "axis_values";

/** The variable's default rule ({kind, ...}) or null when leaving it open means "don't care". */
export const defaultRule = (v) => v?.default ?? null;

/** True when no safe silent default exists — a caller must settle this variable. */
export const mustResolve = (v) => v?.default?.kind === "must_resolve";

/** Agent-facing description: when to constrain this variable, what it eliminates,
 *  what a wrong guess costs. Distinct from `notes`, which is written for
 *  maintainers (storage, validator remarks). Consumed by the MCP tool schema. */
export const agentNote = (v) => v?.agent_note ?? null;

/** A configuration variable's KB binding ({source, via}) or null. */
export const binding = (v) => v?.binding ?? null;

/** Presentation dependency ({variable, value|"any"}) for sequential front-ends
 *  (guided UI, agent question ordering): ask this variable only after its
 *  dependency is answered accordingly. Never affects the solver. */
export const dependsOn = (v) => v?.presentation?.depends_on ?? null;

/**
 * Parametrised port variable: kind "count-at-level". It is NOT stored as a
 * scalar field in axis_values — it resolves against a variant's port pool
 * (model.ports access groups + the fitted module's uplink groups). See the
 * port_model block in switching-axes.json. `port_count` is the only one today.
 */
export function isCountAtLevel(variable) {
  return variable?.kind === "count-at-level";
}

/** Legal values declared by the registry's port_model selector enums. */
export function portModel(registry) {
  return registry.port_model ?? null;
}

/** Per-port PoE wattage by level (single source for the ports×level → watts demand translation). */
export function poeLevelWatts(registry) {
  return getVariable(registry, "poe_type")?.level_watts ?? {};
}

/**
 * Panel layout for the UI: the registry's ordered presentation_groups, each
 * with its variables in registry order. Variables without a presentation group
 * land in a trailing "Other" group so nothing silently disappears.
 * @returns {Array<{group: string, variables: object[]}>}
 */
export function variablesByGroup(registry) {
  const order = registry.presentation_groups ?? [];
  const byGroup = new Map(order.map((g) => [g, []]));
  const other = [];
  for (const v of getVariables(registry)) {
    const g = v.presentation?.group;
    if (g != null && byGroup.has(g)) byGroup.get(g).push(v);
    else other.push(v);
  }
  const out = [...byGroup.entries()].map(([group, variables]) => ({ group, variables }));
  if (other.length) out.push({ group: "Other", variables: other });
  return out.filter((g) => g.variables.length > 0);
}
