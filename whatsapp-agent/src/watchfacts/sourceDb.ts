/**
 * Read-only access to WatchFacts' OWN database — thecollective_inventory, MySQL on the
 * mysql-production droplet (161.35.0.209). (Originally assumed to be the Postgres instance on
 * wf-postgres-prod; confirmed by direct inspection that thecollective_inventory has only ever
 * existed as a MySQL database — that assumption was wrong and cost real time to work out, so a
 * postgres:// URL is still accepted here in case some other WatchFacts-owned database is ever
 * genuinely Postgres, but it is no longer the only URL scheme understood.)
 *
 * Fi has so far mirrored WatchFacts through its flash-sales API: a browser session, paged
 * requests, and — critically — no server-side status filter, so a full sync meant paging
 * through the ENTIRE historical catalogue (auctions has ~1.5M rows total; only ~38k are
 * currently `status='open'`) via a login-gated endpoint that a session hiccup can break at any
 * point. With direct database access the mirror can filter to open listings in one query
 * against the real table, with real timestamps, no browser and no pagination.
 *
 * Nothing here writes. Every statement is a SELECT, and the introspection helpers mask any
 * column that looks like a contact detail before returning sample rows.
 */
import { Pool as PgPool } from "pg";
import mysql, { Pool as MysqlPool } from "mysql2/promise";
import { config } from "../config";

export type SourceDialect = "postgres" | "mysql";

export function detectDialect(url: string): SourceDialect | null {
  const scheme = url.trim().split(":")[0]?.toLowerCase();
  if (scheme === "postgres" || scheme === "postgresql") return "postgres";
  if (scheme === "mysql") return "mysql";
  return null;
}

/** @deprecated kept for the existing call sites/tests that only ever cared about Postgres. */
export function isPostgresUrl(url: string): boolean {
  return detectDialect(url) === "postgres";
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
  dialect: SourceDialect;
  tls: "verified" | "unverified" | "off";
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  close(): Promise<void>;
}

async function openPostgres(url: string, ca: string | undefined): Promise<SourceDb> {
  const ssl = sslOptionsFor(url, ca);
  // pg would otherwise read sslmode from the string itself; passing ssl explicitly makes the
  // decision above the only one in force.
  const connectionString = url.replace(/([?&])sslmode=[^&]*&?/, "$1").replace(/[?&]$/, "");
  const pool = new PgPool({ connectionString, ssl: ssl === false ? false : ssl, max: 2, statement_timeout: 30_000, connectionTimeoutMillis: 10_000 });
  return {
    dialect: "postgres",
    tls: ssl === false ? "off" : ssl.rejectUnauthorized ? "verified" : "unverified",
    async query<T>(sql: string, params: unknown[] = []) { return (await pool.query(sql, params)).rows as T[]; },
    async close() { await pool.end(); },
  };
}

/**
 * Unlike Postgres (where sslOptionsFor's "encrypted unless explicitly disabled" default is the
 * right call — every droplet in this codebase speaks TLS unless sslmode=disable says
 * otherwise), MySQL here defaults the other way: OFF unless a CA is supplied or the URL
 * explicitly opts in (?ssl=true or ?sslmode=require). mysql-production (161.35.0.209) has been
 * directly confirmed to accept only plain connections; requesting TLS against a server that
 * doesn't speak it doesn't fail fast; the handshake stalls and the connection just hangs
 * (indistinguishable from a slow query without digging into what's actually stuck), which cost
 * real time to diagnose. If a future MySQL source does speak TLS, opt it in explicitly rather
 * than changing this default.
 */
function mysqlWantsTls(url: string, ca: string | undefined): boolean {
  if (ca) return true;
  let parsed: URL | null = null;
  try { parsed = new URL(url); } catch { return false; }
  return parsed.searchParams.get("ssl") === "true" || parsed.searchParams.get("sslmode") === "require";
}

async function openMysql(url: string, ca: string | undefined): Promise<SourceDb> {
  const wantsTls = mysqlWantsTls(url, ca);
  const pool: MysqlPool = mysql.createPool({
    uri: url,
    ssl: wantsTls ? (ca ? { ca, rejectUnauthorized: true } : { rejectUnauthorized: false }) : undefined,
    connectionLimit: 2,
    connectTimeout: 10_000,
  });
  return {
    dialect: "mysql",
    tls: !wantsTls ? "off" : ca ? "verified" : "unverified",
    // No per-query timeout in mysql2's pool config (unlike pg's statement_timeout above) — a
    // stuck connection (bad TLS negotiation, a runaway query) would otherwise hang forever and,
    // via runInventorySync's syncRunning flag, wedge every future sync attempt behind it with
    // no way to recover short of a restart. This is exactly what happened once already.
    async query<T>(sql: string, params: unknown[] = []) {
      const timeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("MySQL query timed out after 30s")), 30_000)
      );
      const [rows] = await Promise.race([pool.query(sql, params), timeout]);
      return rows as T[];
    },
    async close() { await pool.end(); },
  };
}

export async function openSourceDb(url = config.watchfacts.sourceDbUrl, ca = config.watchfacts.sourceDbSslCa): Promise<SourceDb> {
  if (!url) throw new Error("WATCHFACTS_DB_URL is not set");
  const dialect = detectDialect(url);
  if (!dialect) throw new Error(`WATCHFACTS_DB_URL must be a postgres:// or mysql:// URL (got "${url.split(":")[0]}://")`);
  return dialect === "postgres" ? openPostgres(url, ca) : openMysql(url, ca);
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

function quoteIdent(dialect: SourceDialect, name: string): string {
  if (!/^[A-Za-z0-9_]+$/.test(name)) throw new Error(`invalid identifier: ${name}`);
  return dialect === "mysql" ? `\`${name}\`` : `"${name}"`;
}

export async function listTables(db: SourceDb): Promise<string[]> {
  if (db.dialect === "mysql") {
    const rows = await db.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE' ORDER BY table_name`
    );
    return rows.map((r) => r.table_name);
  }
  const rows = await db.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_type = 'BASE TABLE' ORDER BY table_name`
  );
  return rows.map((r) => r.table_name);
}

export async function describeTable(db: SourceDb, table: string, sampleRows = 3): Promise<TableReport> {
  const columnsRaw =
    db.dialect === "mysql"
      ? await db.query<{ column_name: string; data_type: string; is_nullable: string }>(
          `SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? ORDER BY ordinal_position`,
          [table]
        )
      : await db.query<{ column_name: string; data_type: string; is_nullable: string }>(
          `SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1 ORDER BY ordinal_position`,
          [table]
        );
  const columns: ColumnInfo[] = columnsRaw.map((c) => ({ name: c.column_name, type: c.data_type, nullable: c.is_nullable.toUpperCase() === "YES" }));
  if (columns.length === 0) return { table, exists: false, rowCount: null, columns: [], sample: [] };

  const q = quoteIdent(db.dialect, table);
  const countRows =
    db.dialect === "mysql"
      ? await db.query<{ n: number }>(`SELECT COUNT(*) AS n FROM ${q}`)
      : await db.query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM ${q}`);
  const rowCount = Number(countRows[0]?.n ?? 0);
  const sampleRaw = await db.query<Record<string, unknown>>(`SELECT * FROM ${q} LIMIT ${Math.max(0, Math.min(sampleRows, 10))}`);
  const sample = sampleRaw.map((row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, maskValue(k, v)])));
  return { table, exists: true, rowCount, columns, sample };
}
