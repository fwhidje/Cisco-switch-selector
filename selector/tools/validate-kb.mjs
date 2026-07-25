// validate-kb.mjs — registry -> schema -> KB consistency validator.
//
// The knowledge files are a projection chain; this tool is the mechanical guard
// that keeps them honest (it replaces the phantom "validate2.py" the docs
// historically referenced). It REUSES the solver's own loaders/index so it
// validates the exact structures the engine consumes.
//
// Validates EVERY series target against the shared registry and its own
// per-series schema. Add a series by appending to ../../DB/switching/families.json.
//
// Run: `npm run validate`  (or `node selector/tools/validate-kb.mjs`)
// Exit 0 = all checks pass; 1 = at least one violation.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";
import { buildIndex } from "../js/core/kb.js";
import {
  getVariables,
  isCountAtLevel,
  portModel,
  isModelDimension,
  isConfigurationDimension,
  storageOf,
  binding,
  defaultRule,
  legalValues,
} from "../js/core/registry.js";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const HERE = dirname(fileURLToPath(import.meta.url));
const SWITCHING = resolvePath(HERE, "../../DB/switching");
const readJSON = (fullPath) => JSON.parse(readFileSync(fullPath, "utf8"));

// Per-series validation targets, derived from the shared family manifest
// (also read by the UI loader) so a new series is registered in one place.
// Each carries its own schema + KB; all share the one registry. The KB may
// have an empty `models` (a series mid-build): the catalog/group checks
// still run; the per-model checks simply find nothing.
const families = readJSON(resolvePath(SWITCHING, "families.json"));
const TARGETS = families.map(({ series, dir, kbFile }) => ({ label: series, dir, kbFile }));

// One shared schema for every family (the per-family copies were unified into
// DB/switching/switch-kb.schema.json).
const SHARED_SCHEMA_PATH = resolvePath(SWITCHING, "switch-kb.schema.json");
const SHARED_SCHEMA = readJSON(SHARED_SCHEMA_PATH);

// Formal JSON-Schema SHAPE validation (types, required, enums, oneOf/anyOf,
// if/then, additionalProperties, format). strict:false because the schema
// embeds non-vocabulary annotation keywords ($authoring, schema_version, ...).
const ajv = new Ajv2020({ allErrors: true, strict: false, allowUnionTypes: true });
addFormats(ajv);
const validateShape = ajv.compile(SHARED_SCHEMA);

const violations = [];
const warnings = [];
const fail = (file, path, message) => violations.push({ file, path, message });
const warn = (file, path, message) => warnings.push({ file, path, message });

// --- shared registry (one vocabulary for every series) ----------------------
const registry = readJSON(resolvePath(SWITCHING, "switching-axes.json"));
const variables = getVariables(registry);
const axisByName = new Map(variables.map((a) => [a.name, a]));
// Model-dimension variables stored under axis_values (what the schema projects).
const storedAxes = variables.filter((v) => isModelDimension(v) && storageOf(v) === "axis_values");
const pm = portModel(registry);
const LEGAL_ROLE = new Set(pm?.selector_enums?.port_role ?? []);
const LEGAL_MEDIUM = new Set(pm?.selector_enums?.port_medium ?? []);
const LEGAL_SPEED = new Set(pm?.selector_enums?.port_speed?.order ?? []);
// stacking_technology is no longer an axis_values scalar (v2.0.0 demoted it to a
// display-only attribute); its enum is validated by the schema on model.attributes.
const SCALAR_ENUMS = ["series", "poe_type"];

// --- Check 0: formal JSON-Schema SHAPE (ajv, against the shared schema) ------
function checkShape(kb, kbFail) {
  if (validateShape(kb)) return;
  for (const e of validateShape.errors ?? []) {
    const params = e.params && Object.keys(e.params).length ? " " + JSON.stringify(e.params) : "";
    kbFail(`shape ${e.instancePath || "(root)"}`, `${e.message}${params}`);
  }
}

// --- Check versions agree ---------------------------------------------------
function checkVersions(schema, kb, kbFail, schemaFail) {
  if (kb.header?.registry_version !== registry.registry_version)
    kbFail(
      "header.registry_version",
      `KB ${kb.header?.registry_version} vs registry ${registry.registry_version}`,
    );
  if (kb.header?.schema_version !== schema.schema_version)
    kbFail(
      "header.schema_version",
      `KB ${kb.header?.schema_version} vs schema ${schema.schema_version}`,
    );
  if (schema.registry_version !== registry.registry_version)
    schemaFail(
      "registry_version",
      `schema ${schema.registry_version} vs registry ${registry.registry_version}`,
    );
}

// --- Check 1: registry internal integrity (v1.0.0 variable metadata) --------
// The unified variable list carries structural metadata the consumers rely on;
// keep it well-formed so the UI/solver/MCP never read a half-declared variable.
const BINDING_SOURCES = new Set([
  "network_module_group",
  "license_group_terms",
  "power_supply_group",
  "stack_cable_group",
  "stackpower_cable_group",
]);
const DEFAULT_KINDS = new Set(["fixed", "none_option", "kb_ref", "policy", "must_resolve"]);
function checkRegistryIntegrity(regFail) {
  const groups = new Set(registry.presentation_groups ?? []);
  for (const v of variables) {
    if (!isModelDimension(v) && !isConfigurationDimension(v))
      regFail(`${v.name}.dimension`, `'${v.dimension}' is not model|configuration`);
    const pg = v.presentation?.group;
    if (pg == null) regFail(`${v.name}.presentation`, "missing presentation.group");
    else if (!groups.has(pg))
      regFail(`${v.name}.presentation.group`, `'${pg}' not in presentation_groups`);
    const dep = v.presentation?.depends_on;
    if (dep) {
      const target = variables.find((t) => t.name === dep.variable);
      if (!target)
        regFail(`${v.name}.presentation.depends_on`, `unknown variable '${dep.variable}'`);
      else if (
        dep.value !== "any" &&
        typeof dep.value !== "boolean" &&
        (target.legal_values ?? []).length &&
        !(target.legal_values ?? []).includes(dep.value)
      )
        regFail(
          `${v.name}.presentation.depends_on`,
          `'${dep.value}' not a legal value of '${dep.variable}'`,
        );
    }
    const d = defaultRule(v);
    if (d && !DEFAULT_KINDS.has(d.kind))
      regFail(`${v.name}.default.kind`, `'${d.kind}' not one of ${[...DEFAULT_KINDS].join("|")}`);
    if (d?.kind === "fixed" && !("value" in d))
      regFail(`${v.name}.default`, "kind 'fixed' requires a value");
    if (d?.kind === "must_resolve" && ("value" in d || "ref" in d))
      regFail(`${v.name}.default`, "must_resolve means NO safe default — it cannot also carry one");
    if (isConfigurationDimension(v)) {
      const b = binding(v);
      if (!b && legalValues(v).length === 0)
        regFail(`${v.name}`, "configuration variable needs a binding or closed legal_values");
      if (b && !BINDING_SOURCES.has(b.source))
        regFail(`${v.name}.binding.source`, `'${b.source}' not a known binding source`);
      if (v.required_on_model)
        regFail(
          `${v.name}.required_on_model`,
          "only model-dimension variables are stored on models",
        );
    }
  }
}

// --- Check 2: registry <-> schema axis_values projection --------------------
// Stored model-dimension variables must project to a schema axis_values
// property. Parametrised port variables (storage "ports") and identity
// variables (model_id) must NOT; configuration variables have no projection.
function checkRegistrySchema(schema, schemaFail) {
  const props = schema?.$defs?.axis_values?.properties ?? {};
  const storedNames = new Set(storedAxes.map((a) => a.name));
  for (const v of variables) {
    if (storedNames.has(v.name)) {
      if (!(v.name in props))
        schemaFail(
          "axis_values.properties",
          `registry variable '${v.name}' has no schema projection`,
        );
    } else if (v.name in props) {
      schemaFail(
        `axis_values.${v.name}`,
        "non-stored variable must not be a stored axis_values field",
      );
    }
  }
  for (const p of Object.keys(props)) {
    if (p === "_comment") continue;
    if (!axisByName.has(p)) schemaFail(`axis_values.${p}`, "schema field is not a registered axis");
  }
  for (const r of schema?.$defs?.axis_values?.required ?? [])
    if (!axisByName.has(r))
      schemaFail("axis_values.required", `requires '${r}', not a registered axis`);
  // poe_type.level_watts must cover every non-'none' level (drives the demand translation)
  const pt = axisByName.get("poe_type");
  for (const lv of pt?.legal_values ?? [])
    if (lv !== "none" && !(pt.level_watts && lv in pt.level_watts))
      schemaFail("registry:poe_type.level_watts", `missing per-port watts for '${lv}'`);
}

// --- Check 3: KB axis_values <= registry ------------------------------------
function checkKbAxisValues(kb, kbFail) {
  for (const m of kb.models ?? []) {
    const av = m.axis_values ?? {};
    for (const key of Object.keys(av)) {
      if (key === "_comment") continue;
      const variable = axisByName.get(key);
      if (!variable) {
        kbFail(`${m.id}.axis_values.${key}`, "not a registered variable");
        continue;
      }
      if (isCountAtLevel(variable))
        kbFail(
          `${m.id}.axis_values.${key}`,
          "parametrised port variable must not be stored (resolves via model.ports)",
        );
      if (!isModelDimension(variable) || storageOf(variable) !== "axis_values")
        kbFail(
          `${m.id}.axis_values.${key}`,
          "only stored model-dimension variables live in axis_values",
        );
    }
    for (const axis of storedAxes)
      if (axis.required_on_model === true && !(axis.name in av))
        kbFail(`${m.id}.axis_values`, `missing required variable '${axis.name}'`);
    if (av.stacking_capable === true && !(m.attributes && "stacking_technology" in m.attributes))
      kbFail(
        `${m.id}.attributes`,
        "stacking_capable=true requires attributes.stacking_technology (display-only since v2.0.0)",
      );
    if (av.poe_capable === true && !("poe_budget_watts" in av))
      kbFail(`${m.id}.axis_values`, "poe_capable=true requires poe_budget_watts");
    for (const ea of SCALAR_ENUMS)
      if (ea in av && !(axisByName.get(ea)?.legal_values ?? []).includes(av[ea]))
        kbFail(`${m.id}.axis_values.${ea}`, `'${av[ea]}' not in registry legal_values`);
    for (const r of av.license_regime ?? [])
      if (!(axisByName.get("license_regime")?.legal_values ?? []).includes(r))
        kbFail(`${m.id}.axis_values.license_regime`, `'${r}' not in registry legal_values`);
    for (const t of av.license_tier ?? [])
      if (!(axisByName.get("license_tier")?.legal_values ?? []).includes(t))
        kbFail(`${m.id}.axis_values.license_tier`, `'${t}' not in registry legal_values`);
    // license_tier must equal the union of the model's license-group tiers (guards the duplication)
    const lic = m.configurables?.license;
    if (lic) {
      const union = new Set(
        [lic.group, ...(lic.additional_groups ?? [])]
          .filter(Boolean)
          .map((g) => kb._index.license_groups.get(g)?.tier)
          .filter(Boolean),
      );
      const declared = new Set(av.license_tier ?? []);
      if (union.size !== declared.size || [...union].some((t) => !declared.has(t)))
        kbFail(
          `${m.id}.axis_values.license_tier`,
          `offered [${[...declared]}] != license-group tiers [${[...union]}]`,
        );
    }
  }
}

// --- Check 4: port-group integrity (v0.4.0 port model) ----------------------
function checkPortGroup(kbFail, where, p, allowedRoles) {
  if (!LEGAL_ROLE.has(p.role)) kbFail(`${where}.role`, `'${p.role}' not a legal port_role`);
  else if (!allowedRoles.has(p.role)) kbFail(`${where}.role`, `role '${p.role}' not allowed here`);
  if (!LEGAL_MEDIUM.has(p.medium))
    kbFail(`${where}.medium`, `'${p.medium}' not a legal port_medium`);
  for (const s of p.speeds ?? [])
    if (!LEGAL_SPEED.has(s)) kbFail(`${where}.speeds`, `'${s}' not a legal port_speed`);
  if (!(Number.isInteger(p.count) && p.count >= 1))
    kbFail(`${where}.count`, `bad count ${p.count}`);
}

// Validate a combinable-pair bank {pairs, low, high}: pairs>=1, both sides
// present with ports_per_pair>=1 and a legal {medium,speeds} of the given role.
function checkPairBlock(kbFail, where, pb, role, allowedRoles) {
  if (!(Number.isInteger(pb.pairs) && pb.pairs >= 1))
    kbFail(`${where}.pairs`, `bad pairs ${pb.pairs}`);
  for (const side of ["low", "high"]) {
    const s = pb[side];
    if (!s) {
      kbFail(`${where}.${side}`, "missing");
      continue;
    }
    if (!(Number.isInteger(s.ports_per_pair) && s.ports_per_pair >= 1))
      kbFail(`${where}.${side}.ports_per_pair`, `bad ${s.ports_per_pair}`);
    checkPortGroup(
      kbFail,
      `${where}.${side}`,
      { count: 1, role, medium: s.medium, speeds: s.speeds },
      allowedRoles,
    );
  }
}

function checkPorts(kb, kbFail) {
  const uplinkOnly = new Set(["uplink"]);
  // catalog modules: ports are role=uplink only. A module carries EITHER ports
  // (fixed config) OR modes (mutually-exclusive alternatives) — walk both.
  for (const nm of kb.catalog?.network_modules ?? []) {
    (nm.ports ?? []).forEach((p, i) =>
      checkPortGroup(kbFail, `module ${nm.id}.ports[${i}]`, p, uplinkOnly),
    );
    (nm.modes ?? []).forEach((mode, mi) =>
      (mode.ports ?? []).forEach((p, i) =>
        checkPortGroup(
          kbFail,
          `module ${nm.id}.modes[${mi}:${mode.name}].ports[${i}]`,
          p,
          uplinkOnly,
        ),
      ),
    );
  }

  for (const m of kb.models ?? []) {
    const av = m.axis_values ?? {};
    const modular = av.uplink_modular === true;
    // modular models carry access only; fixed-uplink models may carry uplink rows too
    const allowed = modular ? new Set(["access"]) : new Set(["access", "uplink"]);
    (m.ports ?? []).forEach((p, i) => checkPortGroup(kbFail, `${m.id}.ports[${i}]`, p, allowed));

    // uplink_pair_block: a bank of combinable pairs on a fixed-uplink model
    // (each pair: low.ports_per_pair×low OR high.ports_per_pair×high). Validate
    // its two port sides as role=uplink groups (resolve.js expands it at solve time).
    const pb = m.uplink_pair_block;
    if (pb) checkPairBlock(kbFail, `${m.id}.uplink_pair_block`, pb, "uplink", uplinkOnly);

    // access_pair_block: a bank of combinable ACCESS pairs on a homogeneous model
    // (C9500-32QC). Validate its two sides as role=access groups. Feasibility-only:
    // resolve.js accessConfigs() expands it at solve time; it never reaches the BOM.
    const accessOnly = new Set(["access"]);
    const apb = m.access_pair_block;
    if (apb) checkPairBlock(kbFail, `${m.id}.access_pair_block`, apb, "access", accessOnly);

    // sum of access ports == total_port_count. An access_pair_block contributes
    // its all-low baseline (the nameplate port count: pairs × low.ports_per_pair).
    const staticAccessSum = (m.ports ?? [])
      .filter((p) => p.role === "access")
      .reduce((s, p) => s + p.count, 0);
    const apbBaseline = apb && apb.low?.ports_per_pair ? apb.pairs * apb.low.ports_per_pair : 0;
    const accessSum = staticAccessSum + apbBaseline;
    if (accessSum !== av.total_port_count)
      kbFail(
        `${m.id}.ports`,
        `access port sum ${accessSum} != total_port_count ${av.total_port_count}`,
      );
    // a model must carry SOME access-port capability: static ports OR a pair block.
    if ((m.ports ?? []).length === 0 && !apb)
      kbFail(
        `${m.id}.ports`,
        "empty ports array requires an access_pair_block covering the port bank",
      );

    // uplink_modular <-> network_modules presence
    const hasNM = !!m.configurables?.network_modules;
    if (modular && !hasNM)
      kbFail(`${m.id}.configurables`, "uplink_modular=true but no network_modules group");
    if (!modular && hasNM)
      kbFail(`${m.id}.configurables`, "uplink_modular=false but has a network_modules group");
    // a fixed-uplink model must carry exactly one uplink shape: inline role=uplink
    // rows, OR a uplink_pair_block, OR no_uplink_ports.
    const hasUplinkRow = (m.ports ?? []).some((p) => p.role === "uplink");
    if (modular && pb)
      kbFail(
        `${m.id}.uplink_pair_block`,
        "uplink_pair_block only valid on a fixed-uplink model (uplink_modular=false)",
      );
    if (pb && hasUplinkRow)
      kbFail(
        `${m.id}.uplink_pair_block`,
        "uplink_pair_block and inline role=uplink rows are mutually exclusive",
      );
    if (pb && m.no_uplink_ports)
      kbFail(
        `${m.id}.uplink_pair_block`,
        "uplink_pair_block and no_uplink_ports are mutually exclusive",
      );
    if (!modular && !m.no_uplink_ports && !hasUplinkRow && !pb)
      kbFail(
        `${m.id}.ports`,
        "fixed-uplink model must carry role=uplink port rows inline, a uplink_pair_block, or no_uplink_ports",
      );
    if (m.no_uplink_ports && hasUplinkRow)
      kbFail(`${m.id}.ports`, "no_uplink_ports=true but model carries role=uplink port rows");
  }
}

// --- Check 5: group integrity (model-independent) ---------------------------
// Every group member must resolve to a catalog SKU. Runs even when models is
// empty, so the shared scaffolding is validated on its own.
function checkGroups(kb, kbFail) {
  const idx = kb._index;
  const has = (map, id) => id != null && map.has(id);
  const g = kb.groups ?? {};
  const memberCheck = (groups, index, kind) => {
    for (const grp of groups ?? [])
      for (const m of grp.members ?? [])
        if (!has(index, m)) kbFail(`${kind} ${grp.id}.members`, `unknown ${kind} member '${m}'`);
  };
  memberCheck(g.network_module_groups, idx.network_modules, "network_module");
  memberCheck(g.power_supply_groups, idx.power_supplies, "power_supply");
  memberCheck(g.stack_cable_groups, idx.stack_cables, "stack_cable");
  memberCheck(g.stackpower_cable_groups, idx.stackpower_cables, "stackpower_cable");
  // Adapter-kit stacking: a group's stack_kit must resolve to a catalog stack_kit,
  // and that kit's included_cable must be a real cable AND a member of the group
  // (so the BOM never double-orders the bundled cable).
  for (const grp of g.stack_cable_groups ?? []) {
    if (grp.stack_kit == null) continue;
    const kit = idx.stack_kits.get(grp.stack_kit);
    if (!kit) {
      kbFail(`stack_cable_group ${grp.id}.stack_kit`, `unknown stack_kit '${grp.stack_kit}'`);
      continue;
    }
    if (!has(idx.stack_cables, kit.included_cable))
      kbFail(`stack_kit ${kit.id}.included_cable`, `unknown stack_cable '${kit.included_cable}'`);
    else if (!(grp.members ?? []).includes(kit.included_cable))
      kbFail(
        `stack_kit ${kit.id}.included_cable`,
        `'${kit.included_cable}' not a member of group '${grp.id}'`,
      );
  }
  for (const grp of g.license_groups ?? []) {
    for (const m of grp.subscription_members ?? [])
      if (!has(idx.licenses, m))
        kbFail(`license_group ${grp.id}.subscription_members`, `unknown license '${m}'`);
    if (grp.perpetual_member != null && !has(idx.licenses, grp.perpetual_member))
      kbFail(
        `license_group ${grp.id}.perpetual_member`,
        `unknown license '${grp.perpetual_member}'`,
      );
  }
}

// --- Check 6: reference integrity (model -> group) --------------------------
function checkReferences(kb, kbFail) {
  const idx = kb._index;
  const has = (map, id) => id != null && map.has(id);
  for (const m of kb.models ?? []) {
    const cfg = m.configurables ?? {};
    const nmgId = cfg.network_modules?.group;
    if (nmgId != null) {
      const grp = idx.network_module_groups.get(nmgId);
      if (!grp) kbFail(`${m.id}.configurables.network_modules.group`, `unknown group '${nmgId}'`);
      else
        for (const mem of grp.members ?? [])
          if (!has(idx.network_modules, mem))
            kbFail(`group ${nmgId}.members`, `unknown network_module '${mem}'`);
    }
    const psu = cfg.power_supplies;
    if (psu?.group != null) {
      const grp = idx.power_supply_groups.get(psu.group);
      if (!grp)
        kbFail(`${m.id}.configurables.power_supplies.group`, `unknown group '${psu.group}'`);
      else
        for (const p of psu.valid_primary ?? [])
          if (!(grp.members ?? []).includes(p))
            kbFail(
              `${m.id}.power_supplies.valid_primary`,
              `'${p}' not in PSU group '${psu.group}'`,
            );
      if (psu.default_primary && !(psu.valid_primary ?? []).includes(psu.default_primary))
        kbFail(
          `${m.id}.power_supplies.default_primary`,
          `'${psu.default_primary}' not in valid_primary`,
        );
    }
    const lic = cfg.license;
    for (const gid of [lic?.group, ...(lic?.additional_groups ?? [])].filter(Boolean))
      if (!has(idx.license_groups, gid))
        kbFail(`${m.id}.configurables.license`, `unknown license group '${gid}'`);
    if (cfg.stack_cables?.group && !has(idx.stack_cable_groups, cfg.stack_cables.group))
      kbFail(
        `${m.id}.configurables.stack_cables.group`,
        `unknown group '${cfg.stack_cables.group}'`,
      );
    if (
      cfg.stackpower_cables?.group &&
      !has(idx.stackpower_cable_groups, cfg.stackpower_cables.group)
    )
      kbFail(
        `${m.id}.configurables.stackpower_cables.group`,
        `unknown group '${cfg.stackpower_cables.group}'`,
      );
  }
}

// --- Check 6b: configuration-variable bindings ------------------------------
// Each configuration variable's domain is DERIVED from the KB via its declared
// binding. Where a model carries the corresponding configurable, the bound
// group must support the variable's declared default (none_option present when
// the default is none_option; default_primary present for the psu-default
// policy). Group-reference resolution itself is covered by checks 5/6.
function checkBindings(kb, kbFail) {
  const idx = kb._index;
  const noneNeeded = new Map(); // binding source -> variable name defaulting to none_option
  for (const v of variables) {
    if (!isConfigurationDimension(v)) continue;
    const b = binding(v);
    if (b && defaultRule(v)?.kind === "none_option") noneNeeded.set(b.source, v.name);
  }
  const seen = new Set();
  const needNone = (source, grp) => {
    if (!noneNeeded.has(source) || !grp || seen.has(`${source}:${grp.id}`)) return;
    seen.add(`${source}:${grp.id}`);
    if (grp.none_option == null)
      kbFail(
        `${source} ${grp.id}`,
        `variable '${noneNeeded.get(source)}' defaults to none_option but the group declares none`,
      );
  };
  for (const m of kb.models ?? []) {
    const cfg = m.configurables ?? {};
    if (cfg.network_modules?.group)
      needNone("network_module_group", idx.network_module_groups.get(cfg.network_modules.group));
    if (cfg.stack_cables?.group)
      needNone("stack_cable_group", idx.stack_cable_groups.get(cfg.stack_cables.group));
    if (cfg.stackpower_cables?.group)
      needNone(
        "stackpower_cable_group",
        idx.stackpower_cable_groups.get(cfg.stackpower_cables.group),
      );
    if (cfg.power_supplies && !cfg.power_supplies.default_primary)
      kbFail(
        `${m.id}.configurables.power_supplies`,
        "the psu-default policy requires default_primary",
      );
    // No matrix row may populate more PSUs than the chassis holds. An integrated
    // supply (bays: 0) still holds its one fixed PSU, so the cap is max(bays, 1).
    if (cfg.power_supplies) {
      const ps = cfg.power_supplies;
      const bays = ps.bays ?? idx.power_supply_groups.get(ps.group)?.bays ?? 0;
      const cap = bays === 0 ? 1 : bays;
      for (const r of ps.poe_budget_matrix ?? []) {
        const n = 1 + (r.secondary != null ? 1 : 0) + (r.tertiary != null ? 1 : 0);
        if (n > cap)
          kbFail(
            `${m.id}.poe_budget_matrix`,
            `a row populates ${n} PSUs but the chassis holds at most ${cap} (bays: ${bays})`,
          );
      }
    }
  }
  // Group invariant: a secondary_none_option (a bay to decline) exists iff bays >= 2.
  for (const g of kb.groups?.power_supply_groups ?? []) {
    const hasNone = g.secondary_none_option != null;
    if (g.bays === 0 && hasNone)
      kbFail(
        `power_supply_group ${g.id}`,
        "bays: 0 (integrated supply) must not declare a secondary_none_option",
      );
    if (g.bays >= 2 && !hasNone)
      kbFail(
        `power_supply_group ${g.id}`,
        `bays: ${g.bays} needs a secondary_none_option (a secondary bay to decline)`,
      );
  }
}

// --- Check 7: derived-value coherence ---------------------------------------
function checkDerived(kb, kbFail, kbWarn) {
  for (const m of kb.models ?? []) {
    const av = m.axis_values ?? {};
    const incomplete = new Set(m._incomplete ?? []);
    const matrix = m.configurables?.power_supplies?.poe_budget_matrix ?? [];
    if (av.poe_capable === true) {
      const max = matrix.reduce((mx, r) => Math.max(mx, r.poe_budget_watts ?? 0), 0);
      if (av.poe_budget_watts !== max) {
        // The matrix may be unsourced (e.g. 48HM: not in datasheet Table 9) while
        // the headline poe_budget_watts IS sourced — warn instead of fail.
        if (incomplete.has("poe_budget_matrix"))
          kbWarn(
            `${m.id}.axis_values.poe_budget_watts`,
            `is ${av.poe_budget_watts} but matrix max is ${max} (poe_budget_matrix unsourced)`,
          );
        else
          kbFail(
            `${m.id}.axis_values.poe_budget_watts`,
            `is ${av.poe_budget_watts}, matrix max is ${max}`,
          );
      }
    } else if (matrix.length > 0) {
      kbFail(`${m.id}.poe_budget_matrix`, "non-PoE model must have an empty PoE matrix");
    }
    // Permutation consistency: a PSU population has exactly ONE budget, so the same
    // primary + the same multiset of other-bay PSUs must give the same watts. Catches
    // the 48HXN class where 850+850+1600 and 850+1600+850 disagreed (3670 vs 3220).
    const seen = new Map();
    for (const r of matrix) {
      const others = [r.secondary, r.tertiary].filter((x) => x != null).sort();
      const key = `${r.primary} + ${others.join(" + ") || "(single)"}`;
      const prev = seen.get(key);
      if (prev != null && prev !== r.poe_budget_watts)
        kbFail(
          `${m.id}.poe_budget_matrix`,
          `PSU set [${key}] has conflicting budgets ${prev}W vs ${r.poe_budget_watts}W`,
        );
      else seen.set(key, r.poe_budget_watts);
    }
  }
}

// --- Check: fan-tray coupling (unified-schema optional block) ----------------
// fan_trays is OPTIONAL at the shape level (only C9500/C9550 use it). Enforce
// that when a family uses it, the pieces hang together: catalog.fan_trays
// present <-> groups.fan_tray_groups present; each configurables.fan_trays.group
// resolves; fan-tray group members + a model's valid_options/default_option all
// resolve. (This enforces CONSISTENCY, not "family X must have fans".)
function checkFanTrays(kb, kbFail) {
  const catFans = kb.catalog?.fan_trays;
  const fanGroups = kb.groups?.fan_tray_groups;
  const hasCat = Array.isArray(catFans) && catFans.length > 0;
  const hasGroups = Array.isArray(fanGroups) && fanGroups.length > 0;
  if (hasCat !== hasGroups)
    kbFail(
      "catalog.fan_trays / groups.fan_tray_groups",
      `fan-tray coupling: catalog.fan_trays ${hasCat ? "present" : "absent"} but groups.fan_tray_groups ${hasGroups ? "present" : "absent"} — both or neither`,
    );
  const catIds = new Set((catFans ?? []).map((f) => f.id));
  const groupById = new Map((fanGroups ?? []).map((g) => [g.id, g]));
  for (const g of fanGroups ?? [])
    for (const m of g.members ?? [])
      if (!catIds.has(m)) kbFail(`fan_tray_group ${g.id}.members`, `unknown fan_tray '${m}'`);
  for (const m of kb.models ?? []) {
    const ft = m.configurables?.fan_trays;
    if (!ft) continue;
    const grp = groupById.get(ft.group);
    if (!grp) {
      kbFail(`${m.id}.configurables.fan_trays.group`, `unknown fan_tray_group '${ft.group}'`);
      continue;
    }
    const members = new Set(grp.members ?? []);
    for (const o of ft.valid_options ?? [])
      if (!members.has(o))
        kbFail(
          `${m.id}.configurables.fan_trays.valid_options`,
          `'${o}' not in fan_tray_group '${ft.group}'`,
        );
    if (ft.default_option && !(ft.valid_options ?? []).includes(ft.default_option))
      kbFail(
        `${m.id}.configurables.fan_trays.default_option`,
        `'${ft.default_option}' not in valid_options`,
      );
  }
}

// --- Check 8: incomplete-field flags ----------------------------------------
// A model may list fields it could not source from authoritative docs. Surface
// each as a WARNING (not a failure) so the build stays green while the gaps are
// loud and tracked (DB/switching/THINGS-TO-COMPLETE.md).
function checkIncomplete(kb, kbWarn) {
  for (const m of kb.models ?? [])
    for (const f of m._incomplete ?? [])
      kbWarn(
        `${m.id}._incomplete`,
        `field '${f}' is UNCONFIRMED — not sourced from datasheet/OG; see THINGS-TO-COMPLETE.md`,
      );
}

// --- Check: Example-pointer integrity (schema-level, runs once) -------------
// Every "Example: <FAMILY>/<id>" in a schema $comment must resolve to a real
// token in that family's KB, so the greppable pointers can't rot.
function checkExamplesIntegrity(schemaFail) {
  const schemaText = readFileSync(SHARED_SCHEMA_PATH, "utf8");
  const kbText = {};
  for (const { label, dir, kbFile } of TARGETS)
    kbText[label] = readFileSync(resolvePath(SWITCHING, dir, kbFile), "utf8");
  const re = /Example:\s*([A-Z][A-Z0-9]+)\/([A-Za-z0-9][A-Za-z0-9._-]*)/g;
  const seen = new Set();
  let m;
  while ((m = re.exec(schemaText))) {
    const fam = m[1];
    const id = m[2].replace(/[._-]+$/, ""); // strip trailing sentence punctuation
    const key = `${fam}/${id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!(fam in kbText)) {
      schemaFail(`Example ${key}`, `unknown family '${fam}'`);
      continue;
    }
    if (!kbText[fam].includes(id))
      schemaFail(`Example ${key}`, `id '${id}' not found in ${fam} KB`);
  }
}

// --- per-target driver ------------------------------------------------------
function validateTarget({ label, dir, kbFile }) {
  const base = resolvePath(SWITCHING, dir);
  const schema = SHARED_SCHEMA;
  const kb = readJSON(resolvePath(base, kbFile));
  const kbFail = (path, message) => fail(`${label}:KB`, path, message);
  const schemaFail = (path, message) => fail(`${label}:schema`, path, message);
  const kbWarn = (path, message) => warn(`${label}:KB`, path, message);

  // SHAPE-check the raw KB first, before we attach the non-schema _index below
  // (the schema's top-level additionalProperties:false would reject _index).
  checkShape(kb, kbFail);

  kb._index = buildIndex(kb);
  checkVersions(schema, kb, kbFail, schemaFail);
  checkRegistrySchema(schema, schemaFail);
  checkKbAxisValues(kb, kbFail);
  checkPorts(kb, kbFail);
  checkGroups(kb, kbFail);
  checkReferences(kb, kbFail);
  checkBindings(kb, kbFail);
  checkFanTrays(kb, kbFail);
  checkDerived(kb, kbFail, kbWarn);
  checkIncomplete(kb, kbWarn);

  const incomplete = (kb.models ?? []).filter((m) => (m._incomplete ?? []).length > 0).length;
  return {
    label,
    schemaVersion: schema.schema_version,
    models: (kb.models ?? []).length,
    incomplete,
  };
}

checkRegistryIntegrity((path, message) => fail("registry", path, message));
const summaries = TARGETS.map(validateTarget);
checkExamplesIntegrity((path, message) => fail("schema:examples", path, message));

if (warnings.length > 0) {
  console.warn(
    `INCOMPLETE — ${warnings.length} warning(s) (unsourced fields, see THINGS-TO-COMPLETE.md):`,
  );
  for (const w of warnings) console.warn(`  [${w.file}] ${w.path}\n      ${w.message}`);
  console.warn("");
}

if (violations.length === 0) {
  console.log(`PASS — registry v${registry.registry_version}.`);
  for (const s of summaries)
    console.log(
      `  ${s.label}: schema v${s.schemaVersion}, ${s.models} model(s)` +
        `${s.incomplete ? `, ${s.incomplete} with unsourced fields` : ""}. All checks green.`,
    );
  process.exit(0);
}
console.error(`FAIL — ${violations.length} violation(s):\n`);
for (const v of violations) console.error(`  [${v.file}] ${v.path}\n      ${v.message}`);
process.exit(1);
