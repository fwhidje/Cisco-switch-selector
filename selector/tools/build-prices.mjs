// build-prices.mjs — Cisco SKU -> list-price map generator / updater.
//
// This tool does NOT price anything. It scrapes every family knowledge base for
// the set of real, orderable Cisco SKUs and maintains two hand-filled maps under
// DB/switching/:
//
//   list-prices.json     — hardware & components: { "<SKU>": <price|null> }.
//                          Absolute USD list price.
//
//   license-prices.json  — licenses, split by pricing basis:
//     { "subscription_monthly": { "<SKU>": <price|null> },   // 1-MONTH list price
//       "absolute":            { "<SKU>": <price|null> } }    // full list price
//     Subscriptions whose duration is NOT baked into the SKU (Cisco `unified` and
//     `meraki-subscription`, i.e. catalog shape "subscription-based") are the
//     one-SKU-variable-duration items: they carry a 1-MONTH rate that downstream
//     logic multiplies by the chosen term. Everything else — perpetual licenses
//     and term-based SKUs whose duration is in the id (…-3Y, …-1Y) — is absolute.
//
// Prices are entered BY HAND. Re-run this whenever Cisco adds/removes products:
// new SKUs are appended as null (preserving every price already entered), and
// SKUs that vanished from the KBs are reported and removed only after
// confirmation.
//
// SKUs are identified BY JSON PATH, never by regex — within a KB the `id` field
// names both real SKUs (C9550-24L4CD) and lowercase internal group ids
// (c9550-psus). Path disambiguates. Sources:
//   - models[].id                       — switch chassis SKUs        (hardware)
//   - catalog.<array>[].id              — components                 (hardware)
//   - catalog.licenses[].id             — licenses, routed by `shape`(licenses)
//   - configurables.*.option (per model)— orderable options not in catalog,
//                                          e.g. 9300LM-SSD-ACCKIT=   (hardware)
// Excluded: groups.*[].id and group/member references (not orderable / already
// captured via catalog), and *-NONE configurator sentinels.
//
// Run:  npm run prices            (interactive: confirms stale removals)
//       npm run prices -- --yes   (non-interactive: auto-confirm removals)
//       npm run prices -- --check (dry run: exit 1 if out of sync, writes nothing)
// Exit 0 = files are in sync / written; 1 = --check found drift.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";
import { createInterface } from "node:readline";

const HERE = dirname(fileURLToPath(import.meta.url));
const SWITCHING = resolvePath(HERE, "../../DB/switching");
const PRICES_PATH = resolvePath(SWITCHING, "list-prices.json");
const LICENSE_PATH = resolvePath(SWITCHING, "license-prices.json");
const readJSON = (fullPath) => JSON.parse(readFileSync(fullPath, "utf8"));
const rel = (p) => p.replace(resolvePath(HERE, "../.."), ".");
const cmp = (a, b) => a.localeCompare(b);

const args = new Set(process.argv.slice(2));
const AUTO_YES = args.has("--yes") || args.has("-y");
const CHECK = args.has("--check");

// License-file sections, in output order.
const SUB = "subscription_monthly";
const ABS = "absolute";

// A *-NONE configurator sentinel ("remove the category"), not an orderable SKU.
// Match the suffix specifically: C9200-NM-BLANK is a real none_option and stays.
const isNoneSentinel = (id) => /-NONE$/.test(id);

// Cisco PIDs are uppercase/digit/-/=/. tokens; lowercase ids are internal group
// ids that should never reach here. Used ONLY to warn, never to add/drop.
const looksLikeSku = (id) => /^[A-Z0-9][A-Z0-9./=+-]*$/.test(id);

// Variable-duration subscriptions (unified + meraki-subscription) carry the
// catalog shape "subscription-based" and have no term baked into the SKU; they
// are priced per-month. Everything else (perpetual, term-based) is absolute.
const licenseSection = (lic) => (lic.shape === "subscription-based" ? SUB : ABS);

// --- extraction -------------------------------------------------------------

const families = readJSON(resolvePath(SWITCHING, "families.json"));

const hardware = new Set(); // hardware/component/model SKU ids
const licenseOf = new Map(); // license SKU id -> section (SUB | ABS)
const orphans = []; // {id, family} — orderable options referenced but not in catalog
const warnings = []; // {id, family, why} — SKU-shaped anomalies (non-authoritative)

for (const { series, dir, kbFile } of families) {
  const kb = readJSON(resolvePath(SWITCHING, dir, kbFile));

  const addHw = (id) => {
    if (isNoneSentinel(id)) return;
    if (!looksLikeSku(id)) warnings.push({ id, family: series, why: "id is not SKU-shaped" });
    hardware.add(id);
  };

  // catalog: every array under `catalog` is a table of orderable components.
  // `licenses` is routed to the license file; every other array is hardware.
  const catalog = kb.catalog ?? {};
  const catalogIds = new Set();
  for (const [key, value] of Object.entries(catalog)) {
    if (!Array.isArray(value)) continue; // skip _comment etc.
    for (const row of value) {
      const id = row?.id;
      if (typeof id !== "string") continue;
      catalogIds.add(id);
      if (key === "licenses") {
        if (!isNoneSentinel(id)) licenseOf.set(id, licenseSection(row));
      } else {
        addHw(id);
      }
    }
  }

  for (const m of kb.models ?? []) {
    if (typeof m?.id === "string") addHw(m.id);

    // configurables.*.option — orderable options that may not live in catalog.
    const cfg = m?.configurables ?? {};
    for (const sub of Object.values(cfg)) {
      const opt = sub?.option;
      if (typeof opt !== "string" || isNoneSentinel(opt)) continue;
      addHw(opt);
      if (!catalogIds.has(opt)) orphans.push({ id: opt, family: series });
    }
  }
}

// --- read existing files ----------------------------------------------------

const existingHw = existsSync(PRICES_PATH) ? readJSON(PRICES_PATH) : {};

// license-prices.json is sectioned; flatten to id->price, and remember which
// section each existing id lived in (used to keep declined-stale entries put).
const existingLicRaw = existsSync(LICENSE_PATH) ? readJSON(LICENSE_PATH) : {};
const existingLic = {};
const existingLicSection = new Map();
for (const [section, map] of Object.entries(existingLicRaw)) {
  if (!map || typeof map !== "object") continue;
  for (const [id, price] of Object.entries(map)) {
    existingLic[id] = price;
    existingLicSection.set(id, section);
  }
}

// Prior price for any id: the license file wins for license ids, else the
// hardware file. Lets a license price survive being MOVED between files.
const priorPrice = (id) => (id in existingLic ? existingLic[id] : (existingHw[id] ?? null));

// --- diff -------------------------------------------------------------------

const hwKeys = new Set(Object.keys(existingHw));
const licKeys = new Set(Object.keys(existingLic));
const licIds = new Set(licenseOf.keys());

const hwAdd = [...hardware].filter((id) => !hwKeys.has(id)).sort(cmp);
// Existing hardware-file ids no longer hardware: licenses migrate out (moved,
// price carried), the rest are genuine discontinued SKUs (stale, confirm).
const notHardware = [...hwKeys].filter((id) => !hardware.has(id));
const moved = notHardware.filter((id) => licIds.has(id)).sort(cmp);
const hwStale = notHardware.filter((id) => !licIds.has(id)).sort(cmp);

const licAdd = [...licIds].filter((id) => !licKeys.has(id)).sort(cmp);
const licStale = [...licKeys].filter((id) => !licIds.has(id)).sort(cmp);

const orphanIds = [...new Map(orphans.map((o) => [o.id, o])).values()].sort((a, b) =>
  cmp(a.id, b.id),
);

// --- reporting --------------------------------------------------------------

const pricedCount = (m) => Object.values(m).filter((v) => v !== null && v !== undefined).length;
console.log(
  `Scanned ${families.length} families → ${hardware.size} hardware SKUs, ${licIds.size} licenses.`,
);
console.log(
  `Existing: list-prices ${hwKeys.size} (${pricedCount(existingHw)} priced), ` +
    `license-prices ${licKeys.size} (${pricedCount(existingLic)} priced).`,
);

const listBlock = (label, ids, fmt = (id) => id) => {
  if (!ids.length) return;
  console.log(`\n${label} (${ids.length}):`);
  for (const id of ids) console.log(`    ${fmt(id)}`);
};
listBlock("+ new hardware SKU(s) → list-prices.json (null)", hwAdd);
listBlock(
  `+ new license SKU(s) → license-prices.json (null)`,
  licAdd,
  (id) => `${id}  [${licenseOf.get(id)}]`,
);
listBlock("→ license SKU(s) moved out of list-prices.json (price carried over)", moved);
if (orphanIds.length) {
  console.log(
    `\n⚠ orphan orderable SKU(s) (referenced in configurables, not in any catalog) (${orphanIds.length}):`,
  );
  for (const o of orphanIds) console.log(`    ${o.id}  (${o.family})`);
}
if (warnings.length) {
  console.log(`\n⚠ anomaly warning(s) (${warnings.length}):`);
  for (const w of warnings) console.log(`    ${w.id}  (${w.family}) — ${w.why}`);
}

const staleAll = [
  ...hwStale.map((id) => ({ id, file: "list-prices.json", price: existingHw[id] })),
  ...licStale.map((id) => ({ id, file: "license-prices.json", price: existingLic[id] })),
];

// --- check mode: report drift, write nothing --------------------------------

if (CHECK) {
  if (staleAll.length) {
    console.log(`\n- stale SKU(s) (in a price file, no longer in any KB) (${staleAll.length}):`);
    for (const s of staleAll)
      console.log(`    ${s.id}  (${s.file}, price: ${JSON.stringify(s.price)})`);
  }
  const drift = hwAdd.length + licAdd.length + moved.length + staleAll.length;
  if (drift) {
    console.log(
      `\n✗ price files out of sync (` +
        `${hwAdd.length + licAdd.length} to add, ${moved.length} to move, ${staleAll.length} stale). ` +
        `Run \`npm run prices\`.`,
    );
    process.exit(1);
  }
  console.log(`\n✓ price files are in sync.`);
  process.exit(0);
}

// --- write mode: confirm stale removals, then write both files --------------

async function confirmStale() {
  if (!staleAll.length) return new Set();
  console.log(`\n- stale SKU(s) (in a price file, no longer in any KB) (${staleAll.length}):`);
  for (const s of staleAll)
    console.log(`    ${s.id}  (${s.file}, price: ${JSON.stringify(s.price)})`);
  if (AUTO_YES) {
    console.log(`  --yes: removing all ${staleAll.length}.`);
    return new Set(staleAll.map((s) => s.id));
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((res) =>
    rl.question(`\nRemove these ${staleAll.length} stale SKU(s)? [y/N] `, res),
  );
  rl.close();
  if (/^y(es)?$/i.test(answer.trim())) return new Set(staleAll.map((s) => s.id));
  console.log("  Keeping stale SKUs.");
  return new Set();
}

const toRemove = await confirmStale();

// Hardware file: current hardware SKUs + any declined-stale still kept. Moved
// licenses are always dropped here (they now live in license-prices.json).
const hwFinalIds = new Set(hardware);
for (const id of hwStale) if (!toRemove.has(id)) hwFinalIds.add(id);
const hwOut = {};
for (const id of [...hwFinalIds].sort(cmp)) hwOut[id] = existingHw[id] ?? null;
writeFileSync(PRICES_PATH, JSON.stringify(hwOut, null, 2) + "\n");

// License file: sectioned. Desired licenses by their computed section, plus any
// declined-stale kept in whichever section they were in before.
const sectionIds = { [SUB]: new Set(), [ABS]: new Set() };
for (const [id, section] of licenseOf) sectionIds[section].add(id);
for (const id of licStale) {
  if (toRemove.has(id)) continue;
  const section = existingLicSection.get(id) === SUB ? SUB : ABS;
  sectionIds[section].add(id);
}
const licOut = {};
for (const section of [SUB, ABS]) {
  licOut[section] = {};
  for (const id of [...sectionIds[section]].sort(cmp)) licOut[section][id] = priorPrice(id);
}
writeFileSync(LICENSE_PATH, JSON.stringify(licOut, null, 2) + "\n");

// --- summary ----------------------------------------------------------------

const summarize = (name, map) => {
  const nulls = Object.values(map).filter((v) => v === null).length;
  return `${name}: ${Object.keys(map).length} SKUs, ${Object.keys(map).length - nulls} priced, ${nulls} need a price`;
};
console.log(`\n✓ Wrote ${rel(PRICES_PATH)} — ${summarize("hardware", hwOut)}.`);
console.log(
  `✓ Wrote ${rel(LICENSE_PATH)} — ` +
    `${summarize(SUB, licOut[SUB])}; ${summarize(ABS, licOut[ABS])}.` +
    (toRemove.size ? `  (${toRemove.size} stale removed.)` : ""),
);
