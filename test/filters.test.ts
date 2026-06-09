// Verifies the filter fixes from the code review actually work end-to-end.
import { searchListings, searchRealEstate, searchCars, searchMarketplace } from "../src/api/search.js";
import { resolveLocationToAreaId } from "../src/api/geo.js";

function assert(label: string, cond: boolean, detail: string) {
  console.log(`${cond ? "PASS" : "FAIL"} | ${label} | ${detail}`);
  if (!cond) process.exitCode = 1;
}

async function main() {
  console.log("=== FILTER VERIFICATION (code-review fixes) ===\n");

  const reAll = await searchRealEstate({ rows: 2 });

  const rePrice = await searchRealEstate({ rows: 2, price_from: 200000, price_to: 250000 });
  assert("RE price 200-250k", rePrice.total < reAll.total && rePrice.total > 0, `all=${reAll.total} filtered=${rePrice.total}`);

  const reRooms = await searchRealEstate({ rows: 2, rooms: 3 });
  assert("RE rooms=3", reRooms.total < reAll.total && reRooms.total > 0, `${reRooms.total}`);

  const reArea = await searchRealEstate({ rows: 2, area_from: 60, area_to: 90 });
  assert("RE area 60-90m2", reArea.total < reAll.total && reArea.total > 0, `${reArea.total}`);

  const reWien = await searchRealEstate({ rows: 2, location: "Wien" });
  assert("RE location=Wien (static)", reWien.total < reAll.total && reWien.total > 0, `${reWien.total}`);

  const reGraz = await searchRealEstate({ rows: 2, location: "Graz" });
  assert("RE location=Graz (dynamic city)", reGraz.total < reAll.total && reGraz.total > 0, `${reGraz.total}`);

  const rePlz = await searchRealEstate({ rows: 2, location: "6020" });
  assert("RE location=6020 (dynamic PLZ)", rePlz.total < reAll.total, `${rePlz.total}`);

  // Universal search must respect a real-estate category (was silently dropped).
  const uniHaus = await searchListings({ vertical: "real_estate", category: "haus-kaufen/haus-angebote", rows: 2 });
  assert("universal RE category=haus", uniHaus.total > 0 && uniHaus.total !== reAll.total,
    `default=${reAll.total} haus=${uniHaus.total}`);

  const carsAll = await searchCars({ rows: 2 });

  const carsBmw = await searchCars({ rows: 2, make: "BMW", price_from: 5000, price_to: 15000 });
  assert("Cars BMW + price 5-15k", carsBmw.total < carsAll.total && carsBmw.total > 0, `all=${carsAll.total} filtered=${carsBmw.total}`);

  const carsElec = await searchCars({ rows: 2, fuel_type: "electric", transmission: "automatic" });
  assert("Cars electric+automatic", carsElec.total < carsAll.total && carsElec.total > 0, `${carsElec.total}`);

  const carsWien = await searchCars({ rows: 2, location: "Wien" });
  assert("Cars location=Wien", carsWien.total < carsAll.total && carsWien.total > 0, `${carsWien.total}`);

  // Category slug must actually narrow (a bare numeric ID silently doesn't).
  const mpUnfiltered = await searchMarketplace({ rows: 2 });
  const mpComputer = await searchMarketplace({ rows: 2, category: "computer-software-5824" });
  assert("MP category=computer-software", mpComputer.total > 0 && mpComputer.total < mpUnfiltered.total / 10,
    `all=${mpUnfiltered.total} computer=${mpComputer.total}`);

  const mpAll = await searchMarketplace({ keyword: "iphone", rows: 2 });
  const mpNew = await searchMarketplace({ keyword: "iphone", rows: 2, condition: "neu" });
  assert("MP iphone condition=neu", mpNew.total < mpAll.total && mpNew.total > 0, `all=${mpAll.total} neu=${mpNew.total}`);

  const areaGraz = await resolveLocationToAreaId("Graz");
  const areaWien = await resolveLocationToAreaId("Wien");
  const areaNum = await resolveLocationToAreaId("900");
  const areaBad = await resolveLocationToAreaId("Nonexistentplace12345");
  assert("resolver Graz/Wien/900/bad", !!areaGraz && areaWien === "900" && areaNum === "900" && areaBad === null,
    `Graz=${areaGraz} Wien=${areaWien} 900=${areaNum} bad=${areaBad}`);

  console.log("\n=== DONE ===");
}

main().catch((e) => { console.error("ERROR:", e); process.exit(1); });
