import fs from "fs";
import path from "path";
import { config } from "../config";

const statusPath = path.join(config.storageDir, "blast-status.json");

export interface BlastStatus {
  state: "idle" | "running" | "completed" | "failed";
  startedAt?: string;
  finishedAt?: string;
  batchSize: number;
  sent: number;
  failed: { phone: string; error: string }[];
  error?: string;
}

export function readBlastStatus(): BlastStatus {
  if (!fs.existsSync(statusPath)) {
    return { state: "idle", batchSize: 0, sent: 0, failed: [] };
  }
  return JSON.parse(fs.readFileSync(statusPath, "utf-8"));
}

export function writeBlastStatus(status: BlastStatus): void {
  fs.mkdirSync(path.dirname(statusPath), { recursive: true });
  fs.writeFileSync(statusPath, JSON.stringify(status, null, 2));
}
