// Verifies every category in MARKETPLACE_CATEGORIES and REAL_ESTATE_CATEGORIES
// against the live site: each must return results (no silent 404/ignored filter)
// and each marketplace slug must actually narrow vs the whole market.
import { searchListings, searchMarketplace } from "../src/api/search.js";
import { MARKETPLACE_CATEGORIES, REAL_ESTATE_CATEGORIES } from "../src/utils/constants.js";

function assert(label: string, cond: boolean, detail: string) {
  console.log(`${cond ? "PASS" : "FAIL"} | ${label} | ${detail}`);
  if (!cond) process.exitCode = 1;
}

async function main() {
  console.log("=== CATEGORY VERIFICATION (live) ===\n");

  console.log("--- Marketplace ---");
  const mpAll = await searchMarketplace({ rows: 1 });
  assert("marketplace unfiltered", mpAll.total > 0, `total=${mpAll.total}`);

  for (const [key, cat] of Object.entries(MARKETPLACE_CATEGORIES)) {
    try {
      const res = await searchMarketplace({ rows: 1, category: cat.path });
      // A silently-ignored filter comes back with the whole-market count.
      assert(`MP ${key}`, res.total > 0 && res.total < mpAll.total / 2, `path=${cat.path} total=${res.total}`);
    } catch (e) {
      assert(`MP ${key}`, false, `path=${cat.path} error=${e instanceof Error ? e.message : String(e)}`);
    }
  }

  console.log("\n--- Real estate ---");
  for (const [key, cat] of Object.entries(REAL_ESTATE_CATEGORIES)) {
    try {
      const res = await searchListings({ vertical: "real_estate", category: cat.path, rows: 1 });
      assert(`RE ${key}`, res.total > 0, `path=${cat.path} total=${res.total}`);
    } catch (e) {
      assert(`RE ${key}`, false, `path=${cat.path} error=${e instanceof Error ? e.message : String(e)}`);
    }
  }

  console.log("\n=== DONE ===");
}

main().catch((e) => { console.error("ERROR:", e); process.exit(1); });
