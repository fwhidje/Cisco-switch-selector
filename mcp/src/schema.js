// schema.js — project the decision-variable registry into the tool input schema.
//
// The registry is the SINGLE SOURCE of the constrainable vocabulary (contract
// §1.4): every variable, its legal values, and its accepted conditions land in
// the generated zod schema, so a connected agent sees the whole legal language
// in the tool definition before its first call. Nothing here is hand-written
// per variable; a registry change reprojects on next deploy. validateQuery()
// remains the semantic backstop behind the shape check.

import { z } from "zod";
import {
  getVariables,
  legalValues,
  acceptedConditions,
  isCountAtLevel,
  mustResolve,
  agentNote,
  portModel,
} from "../../selector/js/core/registry.js";

/** zod type for one scalar value of a variable. */
function valueType(v) {
  if (v.type === "boolean") return z.boolean();
  const lv = legalValues(v);
  if (lv.length) {
    if (lv.every((x) => typeof x === "string")) return z.enum(lv);
    return z.union(lv.map((x) => z.literal(x))); // e.g. license_term years (integers)
  }
  if (v.type === "integer") return z.number().int();
  return z.string(); // open enum (model_id, KB-derived domains like uplink_module)
}

/** One branch of the requirements union: { variable, condition, value }.
 *
 *  The description COMPOSES rather than falling back: the registry's agent_note
 *  (written for the calling agent — when to constrain this, what it eliminates,
 *  what a wrong guess costs) plus the mechanical hints derived from the variable's
 *  kind. The previous `a || b || c` chain made these mutually exclusive, so an
 *  ordered or no-default variable lost its explanation entirely and the rest were
 *  truncated mid-word at 160 chars. `notes` stays untouched: it is written for
 *  maintainers (storage, validator remarks), which is a different audience. */
function requirementBranch(v) {
  const conds = acceptedConditions(v);
  const scalar = valueType(v);
  const value = conds.includes("in") ? z.union([scalar, z.array(scalar)]) : scalar;
  const parts = [
    agentNote(v),
    v.kind === "ordered"
      ? `Ordered ${JSON.stringify(v.order ?? legalValues(v))} — ">=" means this level or better.`
      : null,
    mustResolve(v) ? "No default — the kitlist is not orderable until this is chosen." : null,
  ].filter(Boolean);
  return z
    .object({
      variable: z.literal(v.name),
      condition: conds.length === 1 ? z.literal(conds[0]) : z.enum(conds),
      value,
    })
    .describe(parts.join(" ") || v.name);
}

/** The variables an agent can constrain directly: accepted conditions declared,
 *  and not the parametrised port variable (that is the port_demand field). */
export function constrainableVariables(registry) {
  return getVariables(registry).filter(
    (v) => acceptedConditions(v).length > 0 && !isCountAtLevel(v),
  );
}

/** Raw shape for the find_switch_kitlists tool input. */
export function findKitlistsShape(registry) {
  const branches = constrainableVariables(registry).map(requirementBranch);
  const pm = portModel(registry)?.selector_enums ?? {};
  const speeds = pm.port_speed?.order ?? [];
  return {
    requirements: z
      .array(z.discriminatedUnion("variable", branches))
      .optional()
      .describe(
        "Scalar constraints in the registry vocabulary, e.g. {variable:'license_regime', condition:'in', value:[...]}. Leave a variable out for 'don't care'.",
      ),
    poe_demand: z
      .array(
        z.object({
          count: z.number().int().positive(),
          level: z.enum(
            Object.keys(registry.variables.find((v) => v.name === "poe_type")?.level_watts ?? {}),
          ),
        }),
      )
      .optional()
      .describe(
        "Ports-shaped PoE ask: rows of 'count ports at level'. Translated server-side into budget/level/port-count constraints — never compute watts yourself. For a watts-shaped ask, constrain poe_budget_watts in requirements instead.",
      ),
    port_demand: z
      .array(
        z.object({
          count: z.number().int().positive(),
          speed: z.enum(speeds),
          role: z.enum(pm.port_role ?? ["access", "uplink"]).optional(),
          medium: z.enum(pm.port_medium ?? ["copper", "fiber"]).optional(),
        }),
      )
      .optional()
      .describe(
        "'count ports able to run speed' — role-agnostic unless role/medium given; pool feasibility decides whether access ports or an uplink module supplies them.",
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(20)
      .optional()
      .describe(
        "How many kitlists come back in FULL detail (default 3, and 3 is usually right — each one is dense). Raising this is rarely what you want: all_matches already lists the SKU of every model that fits, and total_candidates reports the full survivor count.",
      ),
  };
}

/** Raw shape for the lookup_model tool input. */
export function lookupModelShape() {
  return {
    model: z
      .string()
      .describe(
        "Exact model id, e.g. 'C9300-48UXM-E'. Near misses return an error listing the closest known ids.",
      ),
  };
}
