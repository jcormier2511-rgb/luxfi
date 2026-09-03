/**
 * Read-only access to WatchFacts' OWN database — the Postgres behind watchfacts.com, on the
 * DigitalOcean droplet wf-postgres-prod (database thecollective_inventory).
 *
 * Fi has so far mirrored WatchFacts through its flash-sales API: a browser session, paged
 * requests, a promotional subset of the inventory, and no posted date on anything. With direct
 * database access the mirror can read the whole catalogue (auctions) and the reference
 * identity table (master_catalog) as they are, with their real timestamps.
 *
 * Nothing here writes. Every statement is a SELECT, and the introspection helpers mask any
 * column that looks like a contact detail before returning sample rows.
 */
import { Pool } from "pg";
import { config } from "../config";

export function isPostgresUrl(url: string): boolean {
  const scheme = url.trim().split(":")[0]?.toLowerCase();
  return scheme === "postgres" || scheme === "postgresql";
}

/**
 * TLS follows the URL's own sslmode, because a self-hosted droplet may not speak TLS at all:
 *   sslmode=disable            -> plain connection
 *   sslmode=require (or unset) -> TLS; verified against WATCHFACTS_DB_SSL_CA when supplied,
 *                                 otherwise encrypted but unauthenticated
 *   localhost                  -> plain, whatever the URL says
 * The introspection output reports which mode was actually used.
 */
export function sslOptionsFor(url: string, ca: string | undefined): { ca?: string; rejectUnauthorized: boolean } | false {
  let parsed: URL | null = null;
  try { parsed = new URL(url); } catch { /* unparsable: fall through to remote defaults */ }
  const host = parsed?.hostname ?? "";
  if (host === "localhost" || host === "127.0.0.1" || host === "::1") return false;
  if (parsed?.searchParams.get("sslmode") === "disable") return false;
  return ca ? { ca, rejectUnauthorized: true } : { rejectUnauthorized: false };
}

export interface SourceDb {
  tls: "verified" | "unverified" | "off";
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  close(): Promise<void>;
}

export async function openSourceDb(url = config.watchfacts.sourceDbUrl, ca = config.watchfacts.sourceDbSslCa): Promise<SourceDb> {
  if (!url) throw new Error("WATCHFACTS_DB_URL is not set");
  if (!isPostgresUrl(url)) throw new Error(`WATCHFACTS_DB_URL must be a postgres:// URL (got "${url.split(":")[0]}://")`);
  const ssl = sslOptionsFor(url, ca);
  // pg would otherwise read sslmode from the string itself; passing ssl explicitly makes the
  // decision above the only one in force.
  const connectionString = url.replace(/([?&])sslmode=[^&]*&?/, "$1").replace(/[?&]$/, "");
  const pool = new Pool({ connectionString, ssl: ssl === false ? false : ssl, max: 2, statement_timeout: 30_000, connectionTimeoutMillis: 10_000 });
  return {
    tls: ssl === false ? "off" : ssl.rejectUnauthorized ? "verified" : "unverified",
    async query<T>(sql: string, params: unknown[] = []) { return (await pool.query(sql, params)).rows as T[]; },
    async close() { await pool.end(); },
  };
}

// --------------------------------------------------------------------------------------------
// Introspection
// --------------------------------------------------------------------------------------------

export interface ColumnInfo { name: string; type: string; nullable: boolean }
export interface TableReport { table: string; exists: boolean; rowCount: number | null; columns: ColumnInfo[]; sample: Record<string, unknown>[] }

/** Columns whose sample values are never returned in full — masked to their shape. */
const SENSITIVE_COLUMN = /(phone|mobile|whatsapp|email|password|passwd|secret|token|api_key|apikey|ssn|card|iban|address)/i;

export function maskValue(column: string, value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (SENSITIVE_COLUMN.test(column)) {
    const s = String(value);
    return s.length <= 4 ? "***" : `${s.slice(0, 2)}${"*".repeat(Math.min(s.length - 4, 12))}${s.slice(-2)}`;
  }
  if (typeof value === "string" && value.length > 120) return `${value.slice(0, 120)}… (${value.length} chars)`;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") { try { return JSON.parse(JSON.stringify(value)); } catch { return String(value); } }
  return value;
}

function quoteIdent(name: string): string {
  if (!/^[A-Za-z0-9_]+$/.test(name)) throw new Error(`invalid identifier: ${name}`);
  return `"${name}"`;
}

export async function listTables(db: SourceDb): Promise<string[]> {
  const rows = await db.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_type = 'BASE TABLE' ORDER BY table_name`
  );
  return rows.map((r) => r.table_name);
}

export async function describeTable(db: SourceDb, table: string, sampleRows = 3): Promise<TableReport> {
  const columnsRaw = await db.query<{ column_name: string; data_type: string; is_nullable: string }>(
    `SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1 ORDER BY ordinal_position`,
    [table]
  );
  const columns: ColumnInfo[] = columnsRaw.map((c) => ({ name: c.column_name, type: c.data_type, nullable: c.is_nullable.toUpperCase() === "YES" }));
  if (columns.length === 0) return { table, exists: false, rowCount: null, columns: [], sample: [] };

  const q = quoteIdent(table);
  const countRows = await db.query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM ${q}`);
  const rowCount = Number(countRows[0]?.n ?? 0);
  const sampleRaw = await db.query<Record<string, unknown>>(`SELECT * FROM ${q} LIMIT ${Math.max(0, Math.min(sampleRows, 10))}`);
  const sample = sampleRaw.map((row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, maskValue(k, v)])));
  return { table, exists: true, rowCount, columns, sample };
}
