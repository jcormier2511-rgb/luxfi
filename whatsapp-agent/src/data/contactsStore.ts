import fs from "fs";
import path from "path";
import { parse } from "csv-parse/sync";
import { config } from "../config";
import { Contact, Tier } from "../types";

function resolveCsvPath(): string {
  if (fs.existsSync(config.data.contactsCsv)) return config.data.contactsCsv;
  const sample = path.resolve("./data/contacts.sample.csv");
  console.warn(
    `[contacts] ${config.data.contactsCsv} not found — falling back to sample data at ${sample}. ` +
      `Drop your real export at data/contacts.csv (see .env CONTACTS_CSV) to use it instead.`
  );
  return sample;
}

let cache: Contact[] | null = null;

export function loadContacts(forceReload = false): Contact[] {
  if (cache && !forceReload) return cache;
  const csvPath = resolveCsvPath();
  const raw = fs.readFileSync(csvPath, "utf-8");
  const rows = parse(raw, { columns: true, skip_empty_lines: true, trim: true }) as Record<string, string>[];
  cache = rows.map((row) => ({
    phone: row.phone,
    name: row.name,
    tier: (row.tier?.toUpperCase() as Tier) ?? "B",
    specialty: row.specialty || undefined,
    wfProfileId: row.wf_profile_id || undefined,
  }));
  return cache;
}

export function getTierABContacts(): Contact[] {
  return loadContacts().filter((c) => c.tier === "A" || c.tier === "B");
}
