import { openWatchFactsSession } from "./scraper";
import { ListingType } from "../types";

const arg = (process.argv[2] ?? "sale").toLowerCase();
const type: ListingType = arg === "wtb" ? "WTB" : "FS";

openWatchFactsSession()
  .then(async (session) => {
    const listings = await session.fetchTradingListings(type);
    console.log(`Fetched ${listings.length} ${type} listings:\n`);
    for (const l of listings) console.log(JSON.stringify(l));
    await session.close();
    process.exit(listings.length > 0 ? 0 : 1);
  })
  .catch((err) => {
    console.error("WatchFacts trading feed test failed:", err);
    process.exit(1);
  });
