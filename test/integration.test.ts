// Integration test for willhaben MCP - tests actual API calls
import { scrapeSearchResults, extractNextData } from "../src/api/scraper.js";
import { searchListings, searchRealEstate, searchCars, searchMarketplace } from "../src/api/search.js";
import { searchJobs } from "../src/api/jobs.js";
import { getListingDetail } from "../src/api/detail.js";

async function testSearch(urlPath: string, description: string) {
  console.log(`\n--- Testing: ${description} ---`);
  console.log(`URL: ${urlPath}`);
  try {
    const { result, isInitial } = await scrapeSearchResults(urlPath);
    if (!result) {
      console.log("❌ No search result found");
      return false;
    }
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
    console.log(`❌ Error: ${error instanceof Error ? error.message : String(error)}`);
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
    console.log(`❌ Jobs API Error: ${error instanceof Error ? error.message : String(error)}`);
  }

  // Test 5: Real Estate search
  console.log("\n--- Testing: Real Estate search ---");
  try {
    const reResult = await searchRealEstate({ rows: 3 });
    console.log(`✅ Found ${reResult.total} listings (${reResult.listings.length} returned)`);
    for (const listing of reResult.listings.slice(0, 3)) {
      console.log(`   - ${listing.title} | Price: ${listing.price ?? "N/A"} | Location: ${listing.location ?? "N/A"}`);
    }
  } catch (error) {
    console.log(`❌ Real Estate Error: ${error instanceof Error ? error.message : String(error)}`);
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
    console.log(`❌ Car search Error: ${error instanceof Error ? error.message : String(error)}`);
  }

  // Test 7: Detail page
  console.log("\n--- Testing: Listing detail ---");
  try {
    const detail = await getListingDetail("1370327604");
    if (detail) {
      console.log(`✅ Got detail for listing ${detail.id}`);
      console.log(`   Title: ${detail.title}`);
      console.log(`   Price: ${detail.price}`);
      console.log(`   Images: ${detail.images.length}`);
      console.log(`   Vertical: ${detail.vertical}`);
    } else {
      console.log("❌ No detail found");
    }
  } catch (error) {
    console.log(`❌ Detail Error: ${error instanceof Error ? error.message : String(error)}`);
  }

  console.log("\n=====================================");
  console.log("🧪 Testing complete!");
}

main().catch(console.error);