// modes/lookup.js — exact-model lookup: one text field, Enter (or an exact
// match while typing) resolves the model and renders its choice domains as
// readable option tables — the "saves me the datasheet" view. Same engine
// call as everything else: solve([model_id == X]).

import { solve } from "../../core/solver.js";
import { getModels } from "../../core/kb.js";
import { el, buildCopyBOM } from "../shared.js";

const summarisePorts = (ports) =>
  (ports ?? []).map((p) => `${p.count}× ${p.medium} ${p.speeds.join("/")}`).join(", ") || "—";

function table(headers, rows) {
  const t = el("table", "option-table");
  const thead = el("thead");
  const hr = el("tr");
  headers.forEach((h) => hr.appendChild(el("th", null, h)));
  thead.appendChild(hr);
  t.appendChild(thead);
  const tbody = el("tbody");
  for (const cells of rows) {
    const tr = el("tr");
    cells.forEach((c) => tr.appendChild(el("td", null, c)));
    tbody.appendChild(tr);
  }
  t.appendChild(tbody);
  return t;
}

function section(title, ...children) {
  const s = el("section", "lookup-section");
  s.appendChild(el("h3", null, title));
  children.forEach((c) => s.appendChild(c));
  return s;
}

export function mount(root, ctx) {
  const { registry, kb } = ctx;
  const ids = getModels(kb).map((m) => m.id);

  root.innerHTML = "";
  const wrap = el("section", "lookup-mode");
  const bar = el("div", "lookup-bar");
  const input = el("input", "lookup-input");
  input.type = "text";
  input.placeholder = "exact model, e.g. C9300-48UXM-E";
  input.setAttribute("list", "lookup-known-ids");
  const dl = el("datalist");
  dl.id = "lookup-known-ids";
  for (const id of ids) {
    const o = el("option");
    o.value = id;
    dl.appendChild(o);
  }
  bar.appendChild(input);
  bar.appendChild(dl);
  wrap.appendChild(bar);
  const out = el("div", "lookup-result");
  out.id = "lookup-result";
  wrap.appendChild(out);
  root.appendChild(wrap);

  // Idempotency guard: never re-render for unchanged text. Without it, the
  // blur-triggered change event re-renders the miss list between a suggestion
  // button's mousedown and mouseup, detaching the button before its click.
  let lastHandled = null;
  const tryResolve = (commit) => {
    const text = input.value.trim();
    if (!text) {
      out.innerHTML = "";
      lastHandled = null;
      return;
    }
    if (text === lastHandled) return;
    const exact = ids.find((id) => id.toLowerCase() === text.toLowerCase());
    if (exact) {
      lastHandled = text;
      render(exact);
    } else if (commit) {
      lastHandled = text;
      renderMiss(text);
    }
  };
  input.addEventListener("change", () => tryResolve(true));
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      tryResolve(true);
    }
  });
  input.addEventListener("input", () => tryResolve(false));
  input.focus();

  function renderMiss(text) {
    out.innerHTML = "";
    const hits = ids.filter((id) => id.toLowerCase().includes(text.toLowerCase())).slice(0, 12);
    out.appendChild(
      el("p", "lookup-miss", `no exact model '${text}'` + (hits.length ? " — did you mean:" : "")),
    );
    if (hits.length) {
      const ul = el("ul", "lookup-suggestions");
      for (const id of hits) {
        const li = el("li");
        const btn = el("button", "linklike", id);
        btn.type = "button";
        btn.addEventListener("click", () => {
          input.value = id;
          render(id);
        });
        li.appendChild(btn);
        ul.appendChild(li);
      }
      out.appendChild(ul);
    }
  }

  function render(id) {
    const r = solve(
      [{ variable: "model_id", condition: "==", value: id, severity: "hard" }],
      kb,
      registry,
    );
    const cand = r.candidates[0];
    out.innerHTML = "";
    if (!cand) {
      out.appendChild(el("p", "lookup-miss", `model '${id}' resolved to no candidate`));
      return;
    }
    const bom = cand.bom;
    const model = getModels(kb).find((m) => m.id === id);
    const av = model?.axis_values ?? {};

    const head = el("div", "lookup-head");
    head.appendChild(el("h2", null, cand.model.id));
    head.appendChild(el("p", "desc", cand.model.description));
    const chips = el("div", "spec-chips");
    const chip = (t) => chips.appendChild(el("span", "spec-chip", t));
    if (av.series) chip(av.series);
    if (av.total_port_count) chip(`${av.total_port_count} access ports`);
    chip(av.poe_capable ? `${av.poe_type} · ${av.poe_budget_watts}W budget` : "no PoE");
    chip(av.uplink_modular ? "modular uplinks" : "fixed uplinks");
    chip(av.stacking_capable ? av.stacking_technology : "no stacking");
    for (const reg of av.license_regime ?? []) chip(reg);
    head.appendChild(chips);
    const copy = el("button", "copy-bom-btn", "copy default BOM");
    copy.type = "button";
    copy.addEventListener("click", () => {
      navigator.clipboard.writeText(buildCopyBOM(bom)).then(() => {
        copy.textContent = "copied!";
        setTimeout(() => {
          copy.textContent = "copy default BOM";
        }, 1500);
      });
    });
    head.appendChild(copy);
    out.appendChild(head);

    // access ports — the switch's own downlink capability (inherent to the SKU)
    {
      const access = cand.model.ports ?? [];
      const rows = access.map((p) => [`${p.count}×`, p.medium, p.speeds.join(" / ")]);
      const pieces = [];
      if (rows.length) pieces.push(table(["count", "medium", "speeds"], rows));
      const pb = cand.model.access_pair_block;
      if (pb)
        pieces.push(
          el(
            "p",
            "lookup-note",
            `combinable bank: ${pb.pairs} pairs — each ${pb.low.ports_per_pair}× ${pb.low.medium} ${pb.low.speeds.join("/")} OR ${pb.high.ports_per_pair}× ${pb.high.medium} ${pb.high.speeds.join("/")}`,
          ),
        );
      if (pieces.length) out.appendChild(section("Access ports", ...pieces));
    }

    // uplinks
    if (bom.uplinks.modular) {
      const rows = bom.uplinks.options
        .filter((o) => o.moduleId)
        .map((o) => [
          o.moduleId,
          o.mode ?? "—",
          summarisePorts(o.ports),
          o.id === bom.uplinks.default ? "default" : "",
        ]);
      rows.push([
        "(none fitted)",
        "—",
        "—",
        bom.uplinks.options.find((o) => o.id === bom.uplinks.default)?.moduleId ? "" : "default",
      ]);
      out.appendChild(
        section("Uplink module options", table(["module", "mode", "ports", ""], rows)),
      );
    } else if (bom.uplinks.options.length > 1) {
      // fixed-uplink pair bank (e.g. C9550 CD uplinks): every valid pair
      // arrangement is one real simultaneous configuration — list them all
      const rows = bom.uplinks.options.map((o) => [
        o.mode ?? o.id,
        summarisePorts(o.ports),
        o.id === bom.uplinks.default ? "default" : "",
      ]);
      out.appendChild(
        section("Fixed uplink configurations", table(["configuration", "ports", ""], rows)),
      );
    } else {
      out.appendChild(
        section("Fixed uplinks", el("p", null, summarisePorts(bom.uplinks.options[0]?.ports))),
      );
    }

    // power
    if (bom.power) {
      const dc = bom.power.default_config;
      const matrix = bom.power.poe_budget_matrix ?? [];
      const primaries = bom.power.valid_primary ?? [];
      // Bays (a chassis fact) drive redundancy — NOT the matrix. bays >= 2: a spare
      // bay accepts any group member; bays: 0: integrated supply, no redundancy.
      const bays = bom.power.bays ?? 0;
      const addOpts = bom.power.additional_bay_options ?? [];
      const maxAdd = bom.power.max_additional ?? 0;
      const baysNote = bays === 0 ? "integrated supply (no PSU bay)" : `${bays} PSU bays`;
      const ships = dc
        ? ` — ships as ${[dc.primary, dc.secondary, dc.tertiary].filter(Boolean).join(" + ")} (${dc.reason})`
        : "";
      if (matrix.length) {
        // PoE model: each row is one orderable (primary[,secondary[,tertiary]]) arrangement.
        const prov = bom.power.poe_budget_matrix_unconfirmed
          ? " · budget UNCONFIRMED (derived, not datasheet-sourced)"
          : "";
        const note = el(
          "p",
          "lookup-note",
          `${baysNote} · valid primary: ${primaries.join(", ") || "—"} · default: ${bom.power.default_primary}${ships}${prov}`,
        );
        const rows = matrix.map((m) => [
          m.primary,
          m.secondary ?? "—",
          m.tertiary ?? "—",
          `${m.poe_budget_watts}W`,
        ]);
        out.appendChild(
          section(
            "PSU configurations (PoE budget)",
            note,
            table(["primary", "secondary", "tertiary", "PoE budget"], rows),
          ),
        );
      } else if (bays >= 2) {
        // Multi-bay, no PoE budget to tabulate: up to `maxAdd` more PSU(s) may be
        // fitted for redundancy. Options are the group members (the compatibility list).
        const note = el(
          "p",
          "lookup-note",
          `${baysNote} · ships as a single ${bom.power.default_primary}; up to ${maxAdd} more PSU${maxAdd === 1 ? "" : "s"} may be added for redundancy${ships}`,
        );
        const primaryOpts =
          primaries
            .map((p) => (p === bom.power.default_primary ? `${p} (default)` : p))
            .join(", ") || "—";
        const addLabel = `none — single (default) · additional: ${addOpts.join(" / ") || "—"}`;
        out.appendChild(
          section(
            "PSU options",
            note,
            table(
              ["slot", "options"],
              [
                ["primary", primaryOpts],
                [`additional (${maxAdd} bay${maxAdd === 1 ? "" : "s"})`, addLabel],
              ],
            ),
          ),
        );
      } else {
        // Integrated / fixed supply (bays: 0): no bay to add a PSU to.
        out.appendChild(
          section(
            "PSU",
            el(
              "p",
              "lookup-note",
              `${bom.power.default_primary} — integrated supply (no PSU bay, no redundancy).`,
            ),
          ),
        );
      }
    }

    // license
    if (bom.license) {
      const rows = bom.license.groups.map((g) => [
        g.regime,
        g.tier,
        g.perpetual_member ?? "—",
        (g.subscription_members ?? []).join(", ") || "—",
        g.term_choices_years.join(" / ") || "—",
      ]);
      const tierNote = el(
        "p",
        "lookup-note",
        bom.license.tier_selectable
          ? "tier selectable on this model"
          : `tier locked: ${bom.license.tier_locked ?? "—"}`,
      );
      out.appendChild(
        section(
          "License options",
          tierNote,
          table(["regime", "tier", "perpetual", "subscription SKUs", "terms (yr)"], rows),
        ),
      );
    }

    // accessories
    const a = bom.accessories ?? {};
    const accRows = [];
    if (a.stack_cables) {
      const b = a.stack_cables;
      // Adapter-kit series: the kit is the prerequisite — give it its own row.
      if (b.prerequisite)
        accRows.push([
          "stacking kit",
          b.prerequisite.id,
          "prerequisite",
          b.prerequisite.included_cable ? `includes ${b.prerequisite.included_cable}` : "—",
        ]);
      accRows.push([
        "stack cable",
        (b.members ?? []).join(", "),
        b.prerequisite ? "via kit" : "—",
        b.default === b.none_option ? "(none — standalone)" : b.default,
      ]);
    }
    if (a.stackpower_cables)
      accRows.push([
        "stackpower cable",
        (a.stackpower_cables.members ?? []).join(", "),
        "—",
        a.stackpower_cables.default === a.stackpower_cables.none_option
          ? "(none — standalone)"
          : a.stackpower_cables.default,
      ]);
    if (a.ssd_accessory) accRows.push(["ssd", a.ssd_accessory, "—", "—"]);
    if (accRows.length)
      out.appendChild(
        section("Accessories", table(["part", "options", "kit", "default"], accRows)),
      );

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
      if (parts.length)
        out.appendChild(section("Included by default", el("p", null, parts.join(" · "))));
    }
  }
}
