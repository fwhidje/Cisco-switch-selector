// build-prices.mjs — Cisco SKU -> list-price map generator / updater.
//
// Step 1 of pricing: this tool does NOT price anything. It scrapes every family
// knowledge base for the set of real, orderable Cisco SKUs and maintains a flat
// map in DB/switching/list-prices.json:
//
//     { "<SKU>": <list price, or null until filled in> }
//
// Prices (USD list) are entered BY HAND into that file. Re-run this whenever
// Cisco adds/removes products: new SKUs are appended as null (preserving every
// price already entered), and SKUs that vanished from the KBs are reported and
// removed only after confirmation.
//
// SKUs are identified BY JSON PATH, never by regex — within a KB the `id` field
// names both real SKUs (C9550-24L4CD) and lowercase internal group ids
// (c9550-psus). Path disambiguates. Sources:
//   - models[].id                       — switch chassis SKUs
//   - catalog.<any-array>[].id          — components (PSUs, modules, licenses, …)
//   - configurables.*.option (per model)— orderable options not in catalog
//                                          (e.g. 9300LM-SSD-ACCKIT=), flagged
// Excluded: groups.*[].id and group/member references (not orderable / already
// captured via catalog), and *-NONE configurator sentinels.
//
// Run:  npm run prices            (interactive: confirms stale removals)
//       npm run prices -- --yes   (non-interactive: auto-confirm removals)
//       npm run prices -- --check (dry run: exit 1 if out of sync, writes nothing)
// Exit 0 = file is in sync / written; 1 = --check found drift.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";
import { createInterface } from "node:readline";

const HERE = dirname(fileURLToPath(import.meta.url));
const SWITCHING = resolvePath(HERE, "../../DB/switching");
const PRICES_PATH = resolvePath(SWITCHING, "list-prices.json");
const readJSON = (fullPath) => JSON.parse(readFileSync(fullPath, "utf8"));

const args = new Set(process.argv.slice(2));
const AUTO_YES = args.has("--yes") || args.has("-y");
const CHECK = args.has("--check");

// A *-NONE configurator sentinel ("remove the category"), not an orderable SKU.
// Match the suffix specifically: C9200-NM-BLANK is a real none_option and stays.
const isNoneSentinel = (id) => /-NONE$/.test(id);

// Cisco PIDs are uppercase/digit/-/=/. tokens; lowercase ids are internal group
// ids that should never reach here. Used ONLY to warn, never to add/drop.
const looksLikeSku = (id) => /^[A-Z0-9][A-Z0-9./=+-]*$/.test(id);

// --- extraction -------------------------------------------------------------

const families = readJSON(resolvePath(SWITCHING, "families.json"));

const skus = new Set(); // priceable SKU ids
const orphans = []; // {id, family} — orderable options referenced but not in catalog
const warnings = []; // {id, family, why} — SKU-shaped anomalies (non-authoritative)

for (const { series, dir, kbFile } of families) {
  const kb = readJSON(resolvePath(SWITCHING, dir, kbFile));

  // catalog: every array under `catalog` is a table of orderable components.
  const catalog = kb.catalog ?? {};
  const catalogIds = new Set();
  for (const value of Object.values(catalog)) {
    if (!Array.isArray(value)) continue; // skip _comment etc.
    for (const row of value) {
      const id = row?.id;
      if (typeof id !== "string") continue;
      catalogIds.add(id);
    }
  }

  const add = (id) => {
    if (isNoneSentinel(id)) return;
    if (!looksLikeSku(id)) warnings.push({ id, family: series, why: "id is not SKU-shaped" });
    skus.add(id);
  };

  for (const id of catalogIds) add(id);

  for (const m of kb.models ?? []) {
    if (typeof m?.id === "string") add(m.id);

    // configurables.*.option — orderable options that may not live in catalog.
    const cfg = m?.configurables ?? {};
    for (const sub of Object.values(cfg)) {
      const opt = sub?.option;
      if (typeof opt !== "string" || isNoneSentinel(opt)) continue;
      add(opt);
      if (!catalogIds.has(opt)) orphans.push({ id: opt, family: series });
    }
  }
}

// --- merge with the existing file -------------------------------------------

const existing = existsSync(PRICES_PATH) ? readJSON(PRICES_PATH) : {};
const existingKeys = new Set(Object.keys(existing));

const toAdd = [...skus].filter((id) => !existingKeys.has(id)).sort((a, b) => a.localeCompare(b));
const stale = [...existingKeys].filter((id) => !skus.has(id)).sort((a, b) => a.localeCompare(b));

// De-dup orphan reports (a shared option can appear on many models).
const orphanIds = [...new Map(orphans.map((o) => [o.id, o])).values()].sort((a, b) =>
  a.id.localeCompare(b.id),
);

// --- reporting --------------------------------------------------------------

const priced = Object.values(existing).filter((v) => v !== null && v !== undefined).length;
console.log(`Scanned ${families.length} families → ${skus.size} orderable SKUs.`);
console.log(`Existing file: ${existingKeys.size} SKUs (${priced} priced).`);
if (toAdd.length) {
  console.log(`\n+ ${toAdd.length} new SKU(s) (added as null):`);
  for (const id of toAdd) console.log(`    ${id}`);
}
if (orphanIds.length) {
  console.log(`\n⚠ ${orphanIds.length} orphan orderable SKU(s) (referenced in configurables, not in any catalog):`);
  for (const o of orphanIds) console.log(`    ${o.id}  (${o.family})`);
}
if (warnings.length) {
  console.log(`\n⚠ ${warnings.length} anomaly warning(s):`);
  for (const w of warnings) console.log(`    ${w.id}  (${w.family}) — ${w.why}`);
}

// --- check mode: report drift, write nothing --------------------------------

if (CHECK) {
  if (stale.length) {
    console.log(`\n- ${stale.length} stale SKU(s) (in file, no longer in any KB):`);
    for (const id of stale) console.log(`    ${id}  (price: ${JSON.stringify(existing[id])})`);
  }
  const drift = toAdd.length + stale.length;
  if (drift) {
    console.log(`\n✗ list-prices.json is out of sync (${toAdd.length} to add, ${stale.length} stale). Run \`npm run prices\`.`);
    process.exit(1);
  }
  console.log(`\n✓ list-prices.json is in sync.`);
  process.exit(0);
}

// --- write mode: build merged map, confirm stale removals -------------------

async function confirmStale() {
  if (!stale.length) return new Set();
  console.log(`\n- ${stale.length} stale SKU(s) (in file, no longer in any KB):`);
  for (const id of stale) console.log(`    ${id}  (price: ${JSON.stringify(existing[id])})`);
  if (AUTO_YES) {
    console.log(`  --yes: removing all ${stale.length}.`);
    return new Set(stale);
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((res) =>
    rl.question(`\nRemove these ${stale.length} stale SKU(s) from the file? [y/N] `, res),
  );
  rl.close();
  if (/^y(es)?$/i.test(answer.trim())) return new Set(stale);
  console.log("  Keeping stale SKUs.");
  return new Set();
}

const toRemove = await confirmStale();

// Preserve every entered price; add new as null; drop confirmed-stale.
const merged = {};
for (const id of [...skus, ...existingKeys].filter((id) => !toRemove.has(id))) {
  merged[id] = id in existing ? existing[id] : null;
}
const ordered = {};
for (const id of Object.keys(merged).sort((a, b) => a.localeCompare(b))) ordered[id] = merged[id];

writeFileSync(PRICES_PATH, JSON.stringify(ordered, null, 2) + "\n");

const total = Object.keys(ordered).length;
const stillNull = Object.values(ordered).filter((v) => v === null).length;
console.log(
  `\n✓ Wrote ${PRICES_PATH.replace(resolvePath(HERE, "../.."), ".")} — ` +
    `${total} SKUs, ${total - stillNull} priced, ${stillNull} need a price` +
    (toRemove.size ? `, ${toRemove.size} removed` : "") +
    `.`,
);
