import fs from "fs";
import path from "path";
import { config } from "../config";
import { ConversationState } from "../types";

const filePath = path.join(config.storageDir, "conversations.json");

function readAll(): Record<string, ConversationState> {
  if (!fs.existsSync(filePath)) return {};
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return {};
  }
}

function writeAll(data: Record<string, ConversationState>): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

export function getState(phone: string): ConversationState {
  const all = readAll();
  return (
    all[phone] ?? {
      phone,
      stage: "new",
      hired: false,
      preferencesCollected: false,
      updatedAt: new Date().toISOString(),
    }
  );
}

export function saveState(state: ConversationState): void {
  const all = readAll();
  all[state.phone] = { ...state, updatedAt: new Date().toISOString() };
  writeAll(all);
}

/** Drops a phone's saved state so their next message is treated as brand new (for testing). */
export function resetState(phone: string): void {
  const all = readAll();
  delete all[phone];
  writeAll(all);
}

/**
 * Arms the one-shot "did they want the escrow/inspection offer" check (see
 * ConversationState.pendingEscrowOffer and conversation/flow.ts's handling of it) for a phone
 * that just received an escrow suggestion — used by the v4 automatic-matching reveal points
 * (server.ts's formatApprovalOutcome-based replies, postings/notify.ts's one-time introduction
 * push) that don't otherwise touch this JSON conversation state at all, so a bare "yes" from
 * either flow's suggestion is recognized the same way.
 */
export function markPendingEscrowOffer(phone: string): void {
  const state = getState(phone);
  state.pendingEscrowOffer = true;
  saveState(state);
}

/** De-dupe Whapi webhook retries by remembering processed message ids. */
const processedIdsPath = path.join(config.storageDir, "processed-messages.json");

export function alreadyProcessed(messageId: string | undefined): boolean {
  if (!messageId) return false;
  const ids: string[] = fs.existsSync(processedIdsPath)
    ? JSON.parse(fs.readFileSync(processedIdsPath, "utf-8"))
    : [];
  if (ids.includes(messageId)) return true;
  const trimmed = [...ids.slice(-999), messageId];
  fs.mkdirSync(path.dirname(processedIdsPath), { recursive: true });
  fs.writeFileSync(processedIdsPath, JSON.stringify(trimmed));
  return false;
}

/** How long a repeat of the exact same (phone, text, image) is treated as a duplicate delivery
 *  rather than a second, deliberate message. Short on purpose -- long enough to absorb a
 *  same-instant duplicate webhook, short enough that a person who impatiently retypes the same
 *  word because Fi hasn't replied yet (a real, separately reported complaint) still gets through. */
const DUPLICATE_CONTENT_WINDOW_MS = 5_000;
let recentContent: { key: string; at: number }[] = [];

/**
 * De-dupes a genuine duplicate delivery that `alreadyProcessed` above cannot catch because it
 * arrives under a DIFFERENT message id for the same real message -- observed live: WhatsApp
 * multi-device echoes / a Whapi retry delivered one real "Hi, I want to join LuxFi network" as
 * two distinct ids, milliseconds apart. Each passed the id-based check, so it was processed
 * twice: the first pass opened a fresh buy-intake draft and asked "What would you like to buy?",
 * the second pass then answered that just-created (still-empty) draft with "I kept your request
 * draft open." followed by the same question again -- three replies to one message. Keyed on
 * phone (so two different senders' identical text, e.g. two people both typing "yes" in a group,
 * never collide) plus text plus image, and windowed rather than permanent, so it only ever
 * suppresses a true near-instant repeat.
 */
export function alreadyProcessedContent(phone: string, text: string, imageUrl?: string): boolean {
  // A genuinely content-less message (a document/sticker with no caption -- see whapi/client.ts)
  // has nothing to compare: two real, distinct ones would collide on the same empty key. Only
  // id-based dedup (alreadyProcessed above) applies to those.
  if (!text.trim() && !imageUrl) return false;
  const now = Date.now();
  recentContent = recentContent.filter((r) => now - r.at < DUPLICATE_CONTENT_WINDOW_MS);
  const key = `${phone}:${text.trim().toLowerCase()}:${imageUrl ?? ""}`;
  if (recentContent.some((r) => r.key === key)) return true;
  recentContent.push({ key, at: now });
  return false;
}

/** Test-only -- clears the in-memory content-dedup window between tests. */
export function _resetContentDedupeForTests(): void {
  recentContent = [];
}

export interface OpenDraftSummary {
  phone: string;
  type: "WTB" | "FS";
  step: string;
  brand?: string;
  model?: string;
  reference: string | null;
  description: string;
}

/**
 * Every identity with a currently open, unconfirmed buy or sell draft -- until now, invisible to
 * anyone but the customer themselves, since a draft lives only in this per-phone conversation
 * state and never in postings. An admin chasing a stuck or confused conversation (the recurring
 * "I kept your request draft open" reports this session) had no way to see which identities
 * actually have an open draft, or what's in it, without asking the customer or reading the raw
 * state file by hand.
 */
export function listOpenDrafts(): OpenDraftSummary[] {
  const drafts: OpenDraftSummary[] = [];
  for (const [phone, state] of Object.entries(readAll())) {
    if (state.pendingBuyIntake) {
      const p = state.pendingBuyIntake;
      drafts.push({ phone, type: "WTB", step: p.step, brand: p.brand, model: p.model, reference: p.reference, description: p.description });
    }
    if (state.pendingSellIntake) {
      const p = state.pendingSellIntake;
      drafts.push({ phone, type: "FS", step: p.step, brand: p.brand, model: p.model, reference: p.reference, description: p.description });
    }
  }
  return drafts;
}
