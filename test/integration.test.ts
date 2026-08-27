// Integration test for willhaben MCP - tests actual API calls
import { scrapeSearchResults } from "../src/api/scraper.js";
import { searchListings, searchRealEstate, searchCars, searchMarketplace } from "../src/api/search.js";
import { searchJobs } from "../src/api/jobs.js";
import { getListingDetail } from "../src/api/detail.js";

// This suite used to print ❌ for every failed check and still exit 0, so a CI
// job running it stayed green while the scraper was completely broken. Every
// failure now lands in `failures`, and the process exits non-zero if any did.
const failures: string[] = [];

function fail(message: string): void {
  failures.push(message);
  console.log(message);
}

async function testSearch(urlPath: string, description: string) {
  console.log(`\n--- Testing: ${description} ---`);
  console.log(`URL: ${urlPath}`);
  try {
    const { result, isInitial } = await scrapeSearchResults(urlPath);
    console.log(`✅ Found ${result.rowsFound} results (${result.rowsReturned} returned)`);
    console.log(`   Description: ${result.description}`);
    console.log(`   Vertical: ${result.verticalId}`);
    console.log(`   Is Initial: ${isInitial}`);
    console.log(`   First 3 ads:`);
    const ads = result.advertSummaryList?.advertSummary ?? [];
    for (const ad of ads.slice(0, 3)) {
      const attrs: Record<string, string> = {};
      ad.attributes?.attribute?.forEach(a => { attrs[a.name] = a.values?.[0] ?? ""; });
      console.log(`   - ${attrs.HEADING ?? attrs.ORGNAME ?? ad.description?.substring(0, 50)} | Price: ${attrs.PRICE_FOR_DISPLAY ?? "N/A"} | Location: ${attrs.LOCATION ?? "N/A"}`);
    }
    return true;
  } catch (error) {
    fail(`❌ Error: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

async function main() {
  console.log("🧪 Testing Willhaben MCP Integration\n");
  console.log("=====================================");

  // Test 1: Immobilien search
  await testSearch("/iad/immobilien/eigentumswohnung/eigentumswohnung-angebote?rows=5", "Immobilien (Eigentumswohnung)");

  // Test 2: Auto search
  await testSearch("/iad/gebrauchtwagen/auto/gebrauchtwagenboerse?rows=5", "Auto (Gebrauchtwagen)");

  // Test 3: Marktplatz search
  await testSearch("/iad/kaufen-und-verkaufen/marktplatz?keyword=iphone&rows=5", "Marktplatz (iPhone)");

  // Test 4: Jobs search via public API
  console.log("\n--- Testing: Jobs API ---");
  try {
    const jobsResult = await searchJobs({ keyword: "Software", rows: 3 });
    console.log(`✅ Found ${jobsResult.total} jobs (${jobsResult.listings.length} returned)`);
    for (const job of jobsResult.listings.slice(0, 3)) {
      console.log(`   - ${job.title} | Location: ${job.location ?? "N/A"} | URL: ${job.url}`);
    }
  } catch (error) {
    fail(`❌ Jobs API Error: ${error instanceof Error ? error.message : String(error)}`);
  }

  // Test 5: Real Estate search
  // Also captures a currently-live ad id for the detail test below: hard-coding
  // one makes this suite go red as soon as that ad expires (willhaben serves
  // expired ads as HTTP 200 with no `advertDetails` in __NEXT_DATA__).
  let liveAdId: string | null = null;
  console.log("\n--- Testing: Real Estate search ---");
  try {
    const reResult = await searchRealEstate({ rows: 3 });
    liveAdId = reResult.listings[0]?.id ?? null;
    console.log(`✅ Found ${reResult.total} listings (${reResult.listings.length} returned)`);
    for (const listing of reResult.listings.slice(0, 3)) {
      console.log(`   - ${listing.title} | Price: ${listing.price ?? "N/A"} | Location: ${listing.location ?? "N/A"}`);
    }
  } catch (error) {
    fail(`❌ Real Estate Error: ${error instanceof Error ? error.message : String(error)}`);
  }

  // Test 6: Car search
  console.log("\n--- Testing: Car search ---");
  try {
    const carResult = await searchCars({ rows: 3 });
    console.log(`✅ Found ${carResult.total} cars (${carResult.listings.length} returned)`);
    for (const listing of carResult.listings.slice(0, 3)) {
      console.log(`   - ${listing.title} | Price: ${listing.price ?? "N/A"} | Location: ${listing.location ?? "N/A"}`);
    }
  } catch (error) {
    fail(`❌ Car search Error: ${error instanceof Error ? error.message : String(error)}`);
  }

  // Test 7: Detail page (uses an ad id observed live in Test 5)
  console.log("\n--- Testing: Listing detail ---");
  if (!liveAdId) {
    console.log("⏭️  Skipped - the real estate search returned no ad id to look up");
  } else {
    try {
      console.log(`Ad ID: ${liveAdId} (taken from the live search above)`);
      const detail = await getListingDetail(liveAdId);
      if (detail) {
        console.log(`✅ Got detail for listing ${detail.id}`);
        console.log(`   Title: ${detail.title}`);
        console.log(`   Price: ${detail.price}`);
        console.log(`   Images: ${detail.images.length}`);
        console.log(`   Vertical: ${detail.vertical}`);
      } else {
        fail("❌ No detail found");
      }
    } catch (error) {
      fail(`❌ Detail Error: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  console.log("\n=====================================");
  if (failures.length > 0) {
    console.log(`🧪 Testing complete — ${failures.length} check(s) FAILED:`);
    for (const failure of failures) {
      console.log(`   ${failure}`);
    }
    console.log(
      "\nThis suite hits live willhaben, so a failure can also mean a blocked IP\n" +
        "or markup drift rather than a code regression — check before assuming a bug."
    );
    process.exitCode = 1;
    return;
  }
  console.log("🧪 Testing complete — all checks passed.");
}

main().catch((error) => {
  // Catching to console.error alone would also have exited 0.
  console.error(error);
  process.exitCode = 1;
});