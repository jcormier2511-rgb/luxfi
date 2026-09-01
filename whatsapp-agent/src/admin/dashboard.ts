import fs from "fs";
import path from "path";
import { config, isAiChatEnabled } from "../config";
import { checkWhapiHealth, WhapiHealthResult } from "../whapi/client";
import { initSchema } from "../postings/db";
import { getSyncStatus, SyncStatus } from "../watchfacts/inventoryDb";
import { getV4OperationalStatus, V4OperationalStatus } from "../postings/status";
import { getMarketUpdateDeliveryStatus, MarketUpdateDeliveryStatus } from "../marketUpdates";
import { listDesignatedGroups, DesignatedGroup } from "../concierge/groupRegistry";
import { getTierABContacts, loadContacts } from "../data/contactsStore";
import { getAdminMetrics, AdminMetrics } from "./metrics";

export interface AdminDashboardData {
  whapi: WhapiHealthResult;
  database: {
    schemaReady: boolean;
    schemaError: string | null;
    // Hostname/database name only — never the full connection string, which routinely embeds a password.
    host: string | null;
    databaseName: string | null;
  };
  marketUpdates: {
    enabled: boolean;
    morningTime: string;
    afternoonTime: string;
    timezone: string;
    graceMinutes: number;
    allowUnchanged: boolean;
    minimumObservations: number;
    delivery: MarketUpdateDeliveryStatus | { error: string };
  };
  postingsV4: {
    enabled: boolean;
    allowedChatIds: string[];
    reminderDaysBeforeExpiry: number;
    operational: V4OperationalStatus | null;
    operationalError: string | null;
    designatedGroups: DesignatedGroup[] | null;
    designatedGroupsError: string | null;
  };
  watchfacts: {
    credentialsConfigured: boolean;
    wtbSyncEnabled: boolean;
    sync: SyncStatus | { error: string };
  };
  aiMatching: {
    enabled: boolean;
    chatActive: boolean;
    provider: string;
    model: string;
    openaiModel: string;
    anthropicKeyConfigured: boolean;
    openaiKeyConfigured: boolean;
    enrichmentEnabled: boolean;
    enrichmentMaxPerSync: number;
    testPhones: string[];
  };
  contacts: {
    total: number;
    tierAB: number;
    csvPath: string;
    csvExists: boolean;
  };
  deployment: {
    nodeEnv: string;
    nodeVersion: string;
    port: number;
    publicBaseUrl: string;
    uptimeSeconds: number;
    startedAt: string;
    persistDirExists: boolean;
  };
  metrics: AdminMetrics | null;
  metricsError: string | null;
  generatedAt: string;
}

/** Never returns the full connection string (which routinely embeds a password) — only what's safe to show. */
function summarizeDatabaseUrl(url: string): { host: string | null; databaseName: string | null } {
  try {
    const parsed = new URL(url);
    return { host: parsed.hostname || null, databaseName: parsed.pathname.replace(/^\//, "") || null };
  } catch {
    return { host: null, databaseName: null };
  }
}

/**
 * Gathers every read-only status the admin panel shows, in parallel where independent. Mirrors
 * the existing /admin/v4-status convention: a failure in one section is captured and reported
 * alongside the rest rather than failing the whole page, since those other fields stay useful
 * even when one dependency (e.g. Postgres) is down.
 */
export async function buildAdminDashboardData(): Promise<AdminDashboardData> {
  const startedAt = new Date(Date.now() - process.uptime() * 1000).toISOString();

  const whapi = await checkWhapiHealth().catch(
    (err): WhapiHealthResult => ({
      configured: Boolean(config.whapi.token),
      reachable: false,
      authorized: null,
      statusText: null,
      version: null,
      error: (err as Error).message,
    })
  );

  let schemaReady = true;
  let schemaError: string | null = null;
  try {
    await initSchema();
  } catch (err) {
    schemaReady = false;
    schemaError = (err as Error).message;
  }
  const dbSummary = summarizeDatabaseUrl(config.database.url);

  let marketDelivery: MarketUpdateDeliveryStatus | { error: string };
  try {
    marketDelivery = await getMarketUpdateDeliveryStatus();
  } catch (err) {
    marketDelivery = { error: (err as Error).message };
  }

  let operational: V4OperationalStatus | null = null;
  let operationalError: string | null = null;
  try {
    operational = await getV4OperationalStatus();
  } catch (err) {
    operationalError = (err as Error).message;
  }

  let designatedGroups: DesignatedGroup[] | null = null;
  let designatedGroupsError: string | null = null;
  try {
    designatedGroups = await listDesignatedGroups();
  } catch (err) {
    designatedGroupsError = (err as Error).message;
  }

  let sync: SyncStatus | { error: string };
  try {
    sync = await getSyncStatus(config.watchfacts.enableWtbSync);
  } catch (err) {
    sync = { error: (err as Error).message };
  }

  // loadContacts() only ever throws if even the bundled sample CSV is missing from disk —
  // leave both counts at 0 rather than failing the whole dashboard over it.
  let contactsTotal = 0;
  let contactsTierAB = 0;
  try {
    contactsTotal = loadContacts().length;
    contactsTierAB = getTierABContacts().length;
  } catch {
    // see comment above
  }

  let metrics: AdminMetrics | null = null;
  let metricsError: string | null = null;
  try {
    metrics = await getAdminMetrics();
  } catch (err) {
    metricsError = (err as Error).message;
  }

  return {
    whapi,
    database: { schemaReady, schemaError, host: dbSummary.host, databaseName: dbSummary.databaseName },
    marketUpdates: {
      enabled: config.marketUpdates.enabled,
      morningTime: config.marketUpdates.morningTime,
      afternoonTime: config.marketUpdates.afternoonTime,
      timezone: config.marketUpdates.timezone,
      graceMinutes: config.marketUpdates.graceMinutes,
      allowUnchanged: config.marketUpdates.allowUnchanged,
      minimumObservations: config.marketUpdates.minimumObservations,
      delivery: marketDelivery,
    },
    postingsV4: {
      enabled: config.postingsV4.enabled,
      allowedChatIds: config.postingsV4.allowedChatIds,
      reminderDaysBeforeExpiry: config.postingsV4.reminderDaysBeforeExpiry,
      operational,
      operationalError,
      designatedGroups,
      designatedGroupsError,
    },
    watchfacts: {
      credentialsConfigured: Boolean(config.watchfacts.email && config.watchfacts.password),
      wtbSyncEnabled: config.watchfacts.enableWtbSync,
      sync,
    },
    aiMatching: {
      enabled: config.aiMatching.enabled,
      chatActive: isAiChatEnabled(),
      provider: config.aiMatching.provider,
      model: config.aiMatching.model,
      openaiModel: config.aiMatching.openaiModel,
      anthropicKeyConfigured: Boolean(config.aiMatching.apiKey),
      openaiKeyConfigured: Boolean(config.aiMatching.openaiApiKey),
      enrichmentEnabled: config.aiMatching.enrichmentEnabled,
      enrichmentMaxPerSync: config.aiMatching.enrichmentMaxPerSync,
      testPhones: config.aiMatching.testPhones,
    },
    contacts: {
      total: contactsTotal,
      tierAB: contactsTierAB,
      csvPath: config.data.contactsCsv,
      csvExists: fs.existsSync(config.data.contactsCsv),
    },
    deployment: {
      nodeEnv: process.env.NODE_ENV ?? "development",
      nodeVersion: process.version,
      port: config.server.port,
      publicBaseUrl: config.publicBaseUrl,
      uptimeSeconds: Math.floor(process.uptime()),
      startedAt,
      // config.storageDir is `${persistDir}/storage`; its parent is the persist root itself
      // (not exported on `config` directly — see config.ts).
      persistDirExists: fs.existsSync(path.dirname(config.storageDir)),
    },
    metrics,
    metricsError,
    generatedAt: new Date().toISOString(),
  };
}
