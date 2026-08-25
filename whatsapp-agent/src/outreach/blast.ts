import { config } from "../config";
import { getTierABContacts } from "../data/contactsStore";
import { sendBannerImage, sendText } from "../greenapi/client";
import { getState, saveState } from "../conversation/stateStore";

function renderIntro(template: string, name: string): string {
  return template.replace(/\{\{\s*name\s*\}\}/g, name).replace(/\\n/g, "\n");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface BlastSummary {
  attempted: number;
  sent: number;
  skipped: number;
  failed: { phone: string; error: string }[];
}

/**
 * Sends the intro message + banner to every Tier A/B contact that hasn't
 * already been reached (state.stage === "new" with no history is fine to re-send;
 * anyone already past "new" is skipped so a re-run doesn't spam active trials).
 */
export async function runOutreachBlast(): Promise<BlastSummary> {
  const contacts = getTierABContacts();
  const summary: BlastSummary = { attempted: contacts.length, sent: 0, skipped: 0, failed: [] };

  for (const contact of contacts) {
    const state = getState(contact.phone);
    if (state.stage !== "new") {
      summary.skipped += 1;
      continue;
    }
    try {
      const message = renderIntro(config.outreach.introMessage, contact.name);
      if (config.outreach.bannerImageUrl) {
        await sendBannerImage(contact.phone, config.outreach.bannerImageUrl, message);
      } else {
        await sendText(contact.phone, message);
      }
      saveState({ ...state, stage: "new" }); // touch updatedAt so we can audit send time
      summary.sent += 1;
    } catch (err) {
      summary.failed.push({ phone: contact.phone, error: (err as Error).message });
    }
    await sleep(config.outreach.delayMs);
  }

  return summary;
}
