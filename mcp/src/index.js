// index.js — the Stage-2 MCP server: a stateless Worker over the unchanged
// solver core (selector/docs/mcp-solver-contract.md is normative).
//
// Exactly two tools, split on the axis a caller actually routes on: do you have
// a model id (lookup_model) or requirements (find_switch_kitlists)? Both are
// ONE-SHOT — the caller states the whole ask and gets kitlists back, each one
// marking what it decided and what still needs a choice (bom.decisions). There
// is deliberately no guided/dialogue surface: the selector is stateless and
// never asks questions, and the tools must not teach an ask-then-re-call loop.
//
// Queries are built ONLY via core/query.js; this file contains no selection
// logic. Tool DESCRIPTIONS are load-bearing — they are the entire interface a
// calling agent sees, so each one carries, in order: domain anchor, scope,
// trigger, and a cross-reference to its sibling.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpHandler } from "agents/mcp";

import { registry, kb } from "./data.js";
import { findKitlistsShape, lookupModelShape } from "./schema.js";
import { trimResponse, nearestModels } from "./respond.js";
import { solve, constraintCost } from "../../selector/js/core/solver.js";
import {
  constraint,
  portConstraint,
  translatePoeDemand,
  validateQuery,
} from "../../selector/js/core/query.js";

const json = (obj) => ({ content: [{ type: "text", text: JSON.stringify(obj, null, 1) }] });
const fail = (obj) => ({ ...json(obj), isError: true });

// Both tools read a KB snapshot bundled at build time: no writes, same answer for
// the same arguments, and a closed world (the loaded families are the whole
// catalogue). Hosts use these to decide what may run without a prompt.
const READ_ONLY = { readOnlyHint: true, idempotentHint: true, openWorldHint: false };

function createServer() {
  const server = new McpServer({
    name: "switch-selector",
    version: registry.registry_version,
  });

  server.registerTool(
    "lookup_model",
    {
      title: "Look up one Cisco switch model",
      description:
        "Cisco enterprise switching (Catalyst C9200/C9300/C9350/C9500/C9550, Meraki MS): the configurable option space for one exact switch SKU — uplink modules with port capabilities, PSU bays with the PoE-budget matrix, license groups and terms, cables — as a resolved default kitlist plus the full choice domain behind each decision. Use it when you already have a model id (a kitlist line, a quote, a customer's existing estate); it is cheap and repeatable, so call it once per SKU when walking a list. If you have requirements rather than a model id, use find_switch_kitlists instead. Unknown ids return an error listing the closest known ids.",
      annotations: READ_ONLY,
      inputSchema: lookupModelShape(),
    },
    async ({ model }) => {
      const res = solve([constraint("model_id", "==", model)], kb, registry);
      if (res.candidates.length === 0)
        return fail({
          error: `unknown model id '${model}'`,
          nearest_known_ids: nearestModels(kb.models, model),
          hint: "retry lookup_model with one of nearest_known_ids, or use find_switch_kitlists to search by requirements",
        });
      return json(
        trimResponse(res, [{ variable: "model_id", condition: "==", value: model }], registry, {
          limit: 1,
          allMatches: false,
        }),
      );
    },
  );

  server.registerTool(
    "find_switch_kitlists",
    {
      title: "Find Cisco switch kitlists from requirements",
      description:
        "Cisco enterprise switching (Catalyst C9200/C9300/C9350/C9500/C9550, Meraki MS): turn a customer requirement set — port counts and speeds, PoE demand, PSU redundancy, stacking, management and licensing — into complete orderable kitlists (switch + fitted uplink module + PSUs + license SKUs + cables). State the whole ask in ONE call: anything you leave out is treated as 'don't care', not as a question to come back for. Returns the top 'limit' kitlists in full detail (default 3, and 3 is usually right — each is dense), ordered smallest-sufficient-configuration first, plus all_matches: the SKU of every model that fits. Raise 'limit' only when you genuinely need more kitlists in full; to see what else exists read all_matches, and call lookup_model on any single SKU worth a closer look. Every kitlist marks what it decided: 'defaulted' choices have real alternatives worth raising with the customer, and a 'required' decision is left deliberately blank with its options because the order is incomplete without it (licensing, normally — a switch ships with no license and needs one). open_variables is the OPEN DECISION SPACE across the matches — only what is genuinely still in play, so anything narrowed to a single value is omitted as settled rather than listed. If the result is thinner than expected, read constraint_cost: it reports, per constraint, how many extra models would survive if you dropped that one — so the row at the top is what is actually costing you, and a zero means every survivor already satisfies it. Those numbers overlap and must not be added together. Give demands as the customer states them (counts and levels); never pre-compute watts. At least one of requirements, poe_demand or port_demand must be supplied. If you already know the exact model id, use lookup_model instead.",
      annotations: READ_ONLY,
      inputSchema: findKitlistsShape(registry),
    },
    async ({ requirements, poe_demand, port_demand, limit }) => {
      const query = [];
      for (const r of requirements ?? []) query.push(constraint(r.variable, r.condition, r.value));
      query.push(...translatePoeDemand(poe_demand ?? [], registry));
      for (const p of port_demand ?? []) {
        const where = { speed: p.speed };
        if (p.role) where.role = p.role;
        if (p.medium) where.medium = p.medium;
        query.push(portConstraint(where, ">=", p.count));
      }
      if (query.length === 0)
        return fail({ error: "empty query: provide requirements, poe_demand, or port_demand" });

      const problems = validateQuery(query, registry);
      if (problems.length) return fail({ error: "invalid query", problems }); // verbatim: the text names the legal values

      const res = solve(query, kb, registry);
      return json(
        trimResponse(res, query, registry, {
          limit: limit ?? 3,
          constraintCost: constraintCost(query, kb, registry, res),
        }),
      );
    },
  );

  return server;
}

export default {
  fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/" || url.pathname === "")
      return new Response(
        "switch-selector MCP server (registry v" +
          registry.registry_version +
          "). MCP endpoint: POST /mcp (streamable HTTP).\n",
        { headers: { "content-type": "text/plain" } },
      );
    return createMcpHandler(createServer())(request, env, ctx);
  },
};
