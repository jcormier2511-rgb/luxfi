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
      approvedCount: 0,
      hired: false,
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
