// shared.js — pieces shared by the three UI modes (full / lookup / guided).
//
// The modes are three renderings of ONE contract (solve()'s response); this
// module holds what they share so no mode re-implements query semantics or
// kitlist rendering:
//   - the DRAFT: the UI-side requirement state (scalar picks, port minimums,
//     PoE demand rows) that toQuery() turns into the canonical constraint
//     list via core/query.js. Guided builds a draft step by step and hands it
//     to full, which writes its controls from it — same object, no re-parse.
//   - control builders generated from the registry (control type from KIND,
//     must-resolve badges, datalists for open enums).
//   - the structured kit card: default parts as line items, alternatives as
//     compact rows, raw solver JSON only behind a "show raw result" button.

import {
  legalValues,
  mustResolve,
  isConfigurationDimension,
  binding,
  storageOf,
} from "../core/registry.js";
import { getModels } from "../core/kb.js";
import { constraint, portConstraint, translatePoeDemand } from "../core/query.js";

// --- tiny DOM helpers --------------------------------------------------------
export function el(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text != null) e.textContent = text;
  return e;
}

export function badge() {
  const b = el("span", "must-resolve", "must resolve");
  b.title = "No safe default exists — settle this before the BOM is orderable.";
  return b;
}

// --- the draft ---------------------------------------------------------------
// scalars: { [variable]: { condition, value } }   (value already typed)
// ports:   [ { role?, medium?, speed, min } ]
// poeDemand: [ { count, level } ]
export const emptyDraft = () => ({ scalars: {}, ports: [], poeDemand: [] });

/** Canonical constraint list for a draft — the ONE place UI state becomes a query. */
export function toQuery(draft, registry) {
  const q = [];
  for (const [variable, s] of Object.entries(draft.scalars)) {
    if (s == null) continue;
    if (Array.isArray(s)) {
      for (const one of s) q.push(constraint(variable, one.condition, one.value));
      continue;
    }
    q.push(constraint(variable, s.condition, s.value));
  }
  for (const p of draft.ports) {
    const where = { speed: p.speed };
    if (p.role) where.role = p.role;
    if (p.medium) where.medium = p.medium;
    q.push(portConstraint(where, ">=", p.min));
  }
  q.push(...translatePoeDemand(draft.poeDemand, registry));
  return q;
}

// --- registry-driven controls ------------------------------------------------
// Every control carries data-variable + data-kind; readDraft() below and the
// guided step engine both read them. `kb` is needed for open-enum datalists.

export function knownValues(variable, kb) {
  if (storageOf(variable) === "identity") return getModels(kb).map((m) => m.id);
  const src = binding(variable)?.source;
  const out = new Set();
  for (const s of kb._sources ?? []) {
    if (src === "network_module_group")
      for (const nm of s.catalog?.network_modules ?? []) out.add(nm.id);
    if (src === "stack_cable_group") for (const c of s.catalog?.stack_cables ?? []) out.add(c.id);
    if (src === "stackpower_cable_group")
      for (const c of s.catalog?.stackpower_cables ?? []) out.add(c.id);
  }
  return [...out].sort();
}

export function row(labelText, title, withBadge, ...controls) {
  const wrap = el("label", "control");
  const name = el("span", "axis-name", labelText);
  if (title) name.title = title;
  if (withBadge) name.appendChild(badge());
  wrap.appendChild(name);
  const box = el("span", "control-inputs");
  controls.forEach((c) => box.appendChild(c));
  wrap.appendChild(box);
  return wrap;
}

export function numInput(variable, bound, placeholder) {
  const e = el("input");
  e.type = "number";
  e.min = "0";
  e.placeholder = placeholder;
  e.dataset.variable = variable;
  e.dataset.kind = "integer";
  e.dataset.bound = bound;
  return e;
}

export function select(variable, kind, optionPairs) {
  const e = el("select");
  e.dataset.variable = variable;
  e.dataset.kind = kind;
  for (const [value, label] of optionPairs) {
    const o = el("option", null, label);
    o.value = value;
    e.appendChild(o);
  }
  return e;
}

export function skuInput(v, kb) {
  const e = el("input");
  e.type = "text";
  e.placeholder = "any";
  e.dataset.variable = v.name;
  e.dataset.kind = "sku";
  const listId = `known-${v.name}`;
  e.setAttribute("list", listId);
  const dl = el("datalist");
  dl.id = listId;
  for (const x of knownValues(v, kb)) {
    const o = el("option");
    o.value = x;
    dl.appendChild(o);
  }
  const wrap = el("span");
  wrap.appendChild(e);
  wrap.appendChild(dl);
  return wrap;
}

/** One control row for a registry variable (kind drives the control type). */
export function controlFor(v, kb) {
  const withBadge = mustResolve(v);
  if (v.kind === "ordered") {
    const sel = select(v.name, "ordered", [["", "any"], ...legalValues(v).map((x) => [x, x])]);
    const cond = el("select", "cond");
    cond.dataset.condFor = v.name;
    for (const [val, t] of [
      [">=", "at least"],
      ["==", "exactly"],
    ]) {
      const o = el("option", null, t);
      o.value = val;
      cond.appendChild(o);
    }
    return row(v.name, v.notes, withBadge, sel, cond);
  }
  if (v.type === "integer" && legalValues(v).length === 0) {
    return row(
      v.name,
      v.notes,
      withBadge,
      numInput(v.name, "min", "min"),
      numInput(v.name, "max", "max"),
    );
  }
  if (v.type === "integer") {
    // closed integer choice (license_term)
    return row(
      v.name,
      v.notes,
      withBadge,
      select(v.name, "int-enum", [
        ["", "any"],
        ...legalValues(v).map((x) => [String(x), String(x)]),
      ]),
    );
  }
  if (v.type === "boolean") {
    const opts =
      v.kind === "monotonic-capability" || isConfigurationDimension(v)
        ? [
            ["", "any"],
            ["true", "required"],
          ]
        : [
            ["", "any"],
            ["true", "yes"],
            ["false", "no"],
          ];
    return row(v.name, v.notes, withBadge, select(v.name, "boolean", opts));
  }
  if (legalValues(v).length === 0) {
    // open enum (uplink_module, cables)
    return row(v.name, v.notes, withBadge, skuInput(v, kb));
  }
  return row(
    v.name,
    v.notes,
    withBadge,
    select(v.name, "enum", [["", "any"], ...legalValues(v).map((x) => [x, x])]),
  );
}

/** Read one control's draft entry ({condition,value} or null) from its element. */
export function readControl(elm, scopeRoot) {
  const raw = elm.value;
  if (raw === "" || raw == null) return null;
  const kind = elm.dataset.kind;
  if (kind === "integer")
    return { condition: elm.dataset.bound === "max" ? "<=" : ">=", value: Number(raw) };
  if (kind === "int-enum") return { condition: "==", value: Number(raw) };
  if (kind === "boolean") return { condition: "==", value: raw === "true" };
  if (kind === "ordered") {
    const cond =
      scopeRoot.querySelector(`[data-cond-for="${elm.dataset.variable}"]`)?.value ?? ">=";
    return { condition: cond, value: raw };
  }
  return { condition: "==", value: raw }; // enum + sku
}

/** Write a draft entry back into a control (guided → full handoff). */
export function writeControl(elm, entry, scopeRoot) {
  if (entry == null) return;
  const kind = elm.dataset.kind;
  if (kind === "integer") {
    const isMax = elm.dataset.bound === "max";
    if ((isMax && entry.condition === "<=") || (!isMax && entry.condition === ">="))
      elm.value = String(entry.value);
    return;
  }
  elm.value = String(entry.value);
  if (kind === "ordered") {
    const cond = scopeRoot.querySelector(`[data-cond-for="${elm.dataset.variable}"]`);
    if (cond) cond.value = entry.condition;
  }
}

// --- structured kit card -----------------------------------------------------
const summarisePorts = (ports) =>
  (ports ?? []).map((p) => `${p.count}× ${p.medium} ${p.speeds.join("/")}`).join(", ") || "—";

function kitLine(part, choice, why, alternatives) {
  const line = el("div", "kit-line");
  const head = el("div", "kit-line-head");
  head.appendChild(el("span", "kit-part", part));
  head.appendChild(el("span", "kit-choice", choice));
  line.appendChild(head);
  if (why) line.appendChild(el("div", "kit-why", why));
  if (alternatives?.length) {
    const alts = el("div", "kit-alts");
    alts.appendChild(el("span", "kit-alts-label", "options:"));
    for (const a of alternatives) alts.appendChild(el("span", "kit-alt", a));
    line.appendChild(alts);
  }
  return line;
}

const psuComboText = (row) =>
  [row.primary, row.secondary, row.tertiary].filter(Boolean).join(" + ") +
  ` → ${row.poe_budget_watts}W`;

/**
 * The structured kitlist for one candidate's BOM: default parts as line
 * items, remaining alternatives as compact rows. No JSON — the raw response
 * is the caller's "show raw result" concern.
 */
export function kitList(bom, model) {
  const kit = el("div", "kitlist");

  // access ports — inherent capability, shown for reading, never ordered
  if (model?.ports?.length || model?.access_pair_block) {
    const label = summarisePorts(model?.ports);
    const pb = model?.access_pair_block;
    const why = pb
      ? `+ combinable bank: ${pb.pairs} pairs, each ${pb.low.ports_per_pair}× ${pb.low.speeds.join("/")} or ${pb.high.ports_per_pair}× ${pb.high.speeds.join("/")}`
      : null;
    kit.appendChild(kitLine("access ports", label, why));
  }

  // uplinks
  const upOpt = bom.uplinks.options.find((o) => o.id === bom.uplinks.default);
  if (bom.uplinks.modular) {
    const label = upOpt?.moduleId
      ? `${upOpt.moduleId}${upOpt.mode ? ` (${upOpt.mode})` : ""} — ${summarisePorts(upOpt.ports)}`
      : "(none fitted)";
    const alts = bom.uplinks.options
      .filter((o) => o.id !== bom.uplinks.default && o.moduleId)
      .map((o) => `${o.moduleId}${o.mode ? ` (${o.mode})` : ""} — ${summarisePorts(o.ports)}`);
    kit.appendChild(kitLine("uplink module", label, null, alts));
  } else if (bom.uplinks.options.length > 1) {
    // fixed-uplink pair bank: the other valid pair arrangements are real alternatives
    const label = `${upOpt?.mode ?? ""} — ${summarisePorts(upOpt?.ports)}`;
    const alts = bom.uplinks.options
      .filter((o) => o.id !== bom.uplinks.default)
      .map((o) => `${o.mode ?? o.id}: ${summarisePorts(o.ports)}`);
    kit.appendChild(
      kitLine("fixed uplinks", label, "combinable uplink bank — one configuration at a time", alts),
    );
  } else {
    kit.appendChild(
      kitLine("fixed uplinks", summarisePorts(upOpt?.ports ?? bom.uplinks.options[0]?.ports)),
    );
  }

  // power
  if (bom.power) {
    const dc = bom.power.default_config;
    if (!dc) {
      kit.appendChild(kitLine("power", "no PSU configuration meets the requested PoE load"));
    } else {
      const label =
        [dc.primary, dc.secondary, dc.tertiary].filter(Boolean).join(" + ") +
        (dc.watts != null ? ` → ${dc.watts}W PoE` : "");
      const matrix = bom.power.poe_budget_matrix ?? [];
      const bays = bom.power.bays ?? 0;
      let alts;
      if (matrix.length) {
        // PoE model: alternatives are the other orderable (primary,secondary,…) arrangements.
        const chosen = psuComboText({ ...dc, poe_budget_watts: dc.watts });
        alts = matrix.map(psuComboText).filter((t) => t !== chosen);
      } else if (bays >= 2 && !dc.secondary) {
        // Multi-bay, no matrix: a matched second PSU is available for redundancy.
        alts = ["+ matched redundant PSU (optional)"];
      }
      // watts_basis explains a budget carried over from a sourced subset (extra PSUs
      // add redundancy, not sourced watts) — surface it next to the reason.
      const reason = dc.watts_basis ? `${dc.reason} — ${dc.watts_basis}` : dc.reason;
      kit.appendChild(kitLine("power", label, reason, alts));
    }
  }

  // license
  if (bom.license) {
    const tierNote = bom.license.tier_selectable
      ? "tier selectable"
      : `tier: ${bom.license.tier_locked ?? "?"}`;
    for (const g of bom.license.groups) {
      let label,
        why = null,
        alts = [];
      if (g.chosen_term) {
        label = g.chosen_term.subscription_sku ?? `(no ${g.chosen_term.term_years}yr SKU)`;
        if (g.chosen_term.not_applicable) why = "term not applicable — single device-tied SKU";
      } else {
        label = g.perpetual_member ?? "(subscription only)";
        alts = (g.subscription_members ?? []).slice();
      }
      kit.appendChild(kitLine(`license ${g.tier}/${g.regime}`, label, why ?? tierNote, alts));
    }
    if (bom.license.groups.length === 0)
      kit.appendChild(kitLine("license", "(none for the chosen regime)"));
  }

  // accessories
  const a = bom.accessories ?? {};
  for (const [part, block] of [
    ["stack cable", a.stack_cables],
    ["stackpower cable", a.stackpower_cables],
  ]) {
    if (!block) continue;
    const isNone = block.default === block.none_option;
    // Adapter-kit series: the kit is the prerequisite that enables stacking —
    // surface it as its own primary line ahead of the cable.
    if (block.prerequisite && !isNone) {
      const inc = block.prerequisite.included_cable;
      kit.appendChild(
        kitLine(
          "stacking kit",
          block.prerequisite.id,
          inc ? `prerequisite — includes ${inc}` : "prerequisite",
        ),
      );
    }
    const includedByKit = block.prerequisite && block.default === block.prerequisite.included_cable;
    const label = isNone ? "(none — standalone)" : block.default;
    const why = isNone ? null : includedByKit ? "included with kit" : "shortest available";
    const alts = (block.members ?? []).filter((m) => m !== block.default);
    kit.appendChild(kitLine(part, label, why, alts.length ? alts : null));
  }
  if (a.ssd_accessory) kit.appendChild(kitLine("ssd", a.ssd_accessory));

  // included
  const inc = bom.included_by_default;
  if (inc && Object.keys(inc).length) {
    const parts = [];
    for (const [k, v] of Object.entries(inc)) {
      if (v === true) parts.push(k.replaceAll("_", " "));
      else if (typeof v === "string") parts.push(`${k.replaceAll("_", " ")}: ${v}`);
      else if (v && typeof v === "object" && "count" in v)
        parts.push(`${v.count}× ${k.replaceAll("_", " ")}`);
    }
    if (parts.length) kit.appendChild(kitLine("included", parts.join(" · ")));
  }

  return kit;
}

export function buildCopyBOM(r) {
  const lines = [r.switch.id];
  if (r.uplinks.modular) {
    const opt = r.uplinks.options.find((o) => o.id === r.uplinks.default);
    if (opt?.moduleId) lines.push(opt.moduleId);
  }
  const dc = r.power?.default_config;
  if (dc) {
    if (dc.primary && dc.primary !== r.power.default_primary) lines.push(dc.primary);
    if (dc.secondary) lines.push(dc.secondary);
    if (dc.tertiary) lines.push(dc.tertiary);
  }
  const a = r.accessories ?? {};
  if (a.stack_cables && a.stack_cables.default !== a.stack_cables.none_option) {
    const b = a.stack_cables;
    if (b.prerequisite) {
      lines.push(b.prerequisite.id);
      // The kit ships with its included_cable; only add a cable line for an upgrade.
      if (b.default !== b.prerequisite.included_cable) lines.push(b.default);
    } else {
      lines.push(b.default);
    }
  }
  if (a.stackpower_cables && a.stackpower_cables.default !== a.stackpower_cables.none_option)
    lines.push(a.stackpower_cables.default);
  for (const g of r.license?.groups ?? []) {
    if (g.perpetual_member) lines.push(g.perpetual_member);
    if (g.chosen_term?.subscription_sku) lines.push(g.chosen_term.subscription_sku);
  }
  return lines.join("\n");
}

/** Full candidate card: header, structured kitlist, copy-BOM, raw behind a button. */
export function candidateCard(cand, isDefault) {
  const card = el("article", "candidate" + (isDefault ? " default" : ""));
  const h = el("h3", null, cand.model.id + (isDefault ? "  ★ default" : ""));
  card.appendChild(h);

  const btns = el("div", "card-buttons");
  const copyBtn = el("button", "copy-bom-btn", "copy BOM");
  copyBtn.type = "button";
  copyBtn.addEventListener("click", () => {
    const text = buildCopyBOM(cand.bom);
    navigator.clipboard
      .writeText(text)
      .then(() => {
        copyBtn.textContent = "copied!";
        setTimeout(() => {
          copyBtn.textContent = "copy BOM";
        }, 1500);
      })
      .catch(() => {
        const fb = el("pre", "copy-bom-fallback", text);
        btns.after(fb);
        const sel = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(fb);
        sel.removeAllRanges();
        sel.addRange(range);
      });
  });
  const rawBtn = el("button", "raw-btn", "show raw result");
  rawBtn.type = "button";
  let rawPre = null;
  rawBtn.addEventListener("click", () => {
    if (rawPre) {
      rawPre.remove();
      rawPre = null;
      rawBtn.textContent = "show raw result";
      return;
    }
    rawPre = el("pre", "bundle", JSON.stringify(cand.bom, null, 2));
    card.appendChild(rawPre);
    rawBtn.textContent = "hide raw result";
  });
  btns.appendChild(copyBtn);
  btns.appendChild(rawBtn);
  card.appendChild(btns);

  card.appendChild(el("p", "desc", cand.model.description));
  card.appendChild(kitList(cand.bom, cand.model));
  return card;
}

/** The response's residual decision space, rendered as the "still open" strip. */
export function renderOpenVariables(container, result) {
  container.innerHTML = "";
  container.appendChild(el("div", "section-head", "still open (residual choice)"));
  const ul = el("ul");
  for (const ov of result.open_variables) {
    const li = el("li");
    const domain = Array.isArray(ov.domain)
      ? ov.domain.length > 8
        ? `${ov.domain.slice(0, 8).join(", ")}, … (${ov.domain.length})`
        : ov.domain.join(", ")
      : ov.domain
        ? `${ov.domain.min}–${ov.domain.max}`
        : "—";
    const dflt = ov.must_resolve
      ? ""
      : ov.default
        ? `  · default: ${ov.default.kind === "fixed" ? ov.default.value : (ov.default.policy ?? ov.default.kind)}`
        : "";
    li.textContent = `${ov.name}: {${domain}}${dflt}`;
    if (ov.must_resolve) li.appendChild(badge());
    ul.appendChild(li);
  }
  container.appendChild(ul);
}

// --- PoE demand section (shared by full + guided) ----------------------------
export function poeDemandSection(poeLevels, idPrefix = "poe-demand") {
  const wrap = el("div", "demand-section");
  wrap.appendChild(el("div", "section-head", "PoE demand — ports at level (sizes the PSU)"));
  const list = el("div");
  list.id = idPrefix;
  list.appendChild(demandRow(poeLevels));
  wrap.appendChild(list);
  return wrap;
}

export function demandRow(poeLevels) {
  const r = el("label", "control demand-row");
  r.appendChild(el("span", "axis-name", "ports @"));
  const box = el("span", "control-inputs");
  const cnt = el("input");
  cnt.type = "number";
  cnt.min = "0";
  cnt.placeholder = "count";
  cnt.dataset.demandCount = "1";
  const lvl = el("select");
  lvl.dataset.demandLevel = "1";
  for (const [v, t] of [["", "level…"], ...poeLevels.map((x) => [x, x])]) {
    const o = el("option", null, t);
    o.value = v;
    lvl.appendChild(o);
  }
  box.appendChild(cnt);
  box.appendChild(lvl);
  r.appendChild(box);
  return r;
}

/** Keep one trailing blank demand row; read the filled ones. */
export function syncDemandRows(list, poeLevels) {
  if (!list?.lastElementChild) return;
  const last = list.lastElementChild;
  const cnt = Number(last.querySelector("[data-demand-count]").value) || 0;
  const lvl = last.querySelector("[data-demand-level]").value;
  if (cnt > 0 && lvl) list.appendChild(demandRow(poeLevels));
}

export function readDemandRows(list) {
  const out = [];
  for (const r of list?.querySelectorAll(".demand-row") ?? []) {
    const count = Number(r.querySelector("[data-demand-count]").value) || 0;
    const level = r.querySelector("[data-demand-level]").value;
    if (count > 0 && level) out.push({ count, level });
  }
  return out;
}

export function writeDemandRows(list, rows, poeLevels) {
  list.innerHTML = "";
  for (const d of rows) {
    const r = demandRow(poeLevels);
    r.querySelector("[data-demand-count]").value = String(d.count);
    r.querySelector("[data-demand-level]").value = d.level;
    list.appendChild(r);
  }
  list.appendChild(demandRow(poeLevels));
}
