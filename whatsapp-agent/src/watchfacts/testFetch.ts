import { openWatchFactsSession } from "./scraper";

const profileId = process.argv[2];
if (!profileId) {
  console.error("Usage: npm run wf:test -- <profileId>");
  process.exit(1);
}

openWatchFactsSession()
  .then(async (session) => {
    const listing = await session.getLatestListing(profileId);
    console.log("Latest listing:", listing);
    await session.close();
    process.exit(listing ? 0 : 1);
  })
  .catch((err) => {
    console.error("WatchFacts session failed:", err);
    process.exit(1);
  });
