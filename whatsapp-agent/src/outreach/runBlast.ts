import { runOutreachBlast } from "./blast";

runOutreachBlast()
  .then((summary) => {
    console.log("Outreach blast complete:", JSON.stringify(summary, null, 2));
    process.exit(summary.failed.length > 0 ? 1 : 0);
  })
  .catch((err) => {
    console.error("Outreach blast failed:", err);
    process.exit(1);
  });
