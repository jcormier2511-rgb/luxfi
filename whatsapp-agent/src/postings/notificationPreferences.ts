import crypto from "crypto";
import { withSchema } from "./db";
import { ChannelPlatform } from "../channels/identity";

/**
 * Where you TALK to Fi and where Fi ALERTS you don't have to be the same channel — a dealer
 * might manage listings on Telegram but want matches pushed by SMS. This is the canonical-user
 * layer that makes that possible: a preferred channel, optional fallback, and the identity
 * links a preference actually resolves against. Extends the existing
 * canonical_notification_preferences/linked_identities schema (see postings/db.ts and
 * postings/identity.ts) rather than adding a parallel preference store.
 */

export interface NotificationPreference {
  preferredChannel: ChannelPlatform | null;
  fallbackEnabled: boolean;
  wtbAlertsPaused: boolean;
}

export interface LinkedIdentity {
  platform: ChannelPlatform;
  identity: string;
}

export async function getNotificationPreference(canonicalUserId: number): Promise<NotificationPreference> {
  return withSchema(async (pool) => {
    const r = await pool.query(
      `SELECT preferred_channel, fallback_enabled, wtb_alerts_paused FROM canonical_notification_preferences WHERE canonical_user_id=$1`,
      [canonicalUserId]
    );
    const row = r.rows[0];
    return {
      preferredChannel: row?.preferred_channel ?? null,
      fallbackEnabled: row?.fallback_enabled ?? false,
      wtbAlertsPaused: row?.wtb_alerts_paused ?? false,
    };
  });
}

export async function setPreferredChannel(canonicalUserId: number, channel: ChannelPlatform): Promise<void> {
  await withSchema((pool) =>
    pool.query(
      `INSERT INTO canonical_notification_preferences(canonical_user_id, preferred_channel) VALUES($1,$2)
       ON CONFLICT(canonical_user_id) DO UPDATE SET preferred_channel=$2`,
      [canonicalUserId, channel]
    )
  );
}

export async function setFallbackEnabled(canonicalUserId: number, enabled: boolean): Promise<void> {
  await withSchema((pool) =>
    pool.query(
      `INSERT INTO canonical_notification_preferences(canonical_user_id, fallback_enabled) VALUES($1,$2)
       ON CONFLICT(canonical_user_id) DO UPDATE SET fallback_enabled=$2`,
      [canonicalUserId, enabled]
    )
  );
}

export async function getLinkedIdentities(canonicalUserId: number): Promise<LinkedIdentity[]> {
  return withSchema(async (pool) => {
    const r = await pool.query(`SELECT platform, identity FROM linked_identities WHERE canonical_user_id=$1 ORDER BY id`, [canonicalUserId]);
    return r.rows as LinkedIdentity[];
  });
}

export type LinkIdentityResult = { ok: true } | { ok: false; reason: "already_linked_elsewhere" | "already_linked_here" };

/**
 * Attaches a NEW identity to an EXISTING canonical user — the operation getOrCreateCanonicalUser
 * (postings/identity.ts) deliberately never performs, since it always mints a fresh canonical
 * user for an identity it hasn't seen. Never merges two canonical users that already each own
 * their own identity/history — that would mean re-pointing every posting/match/approval one of
 * them owns, which is out of scope here; the caller must have already resolved that this exact
 * (platform, identity) pair has never been linked to anyone before calling this for a genuinely
 * new one, or accept the already_linked_* rejection otherwise.
 */
export async function linkIdentity(canonicalUserId: number, platform: ChannelPlatform, identity: string): Promise<LinkIdentityResult> {
  return withSchema(async (pool) => {
    const existing = await pool.query(`SELECT canonical_user_id FROM linked_identities WHERE platform=$1 AND identity=$2`, [platform, identity]);
    if (existing.rows.length > 0) {
      return existing.rows[0].canonical_user_id === canonicalUserId ? { ok: false, reason: "already_linked_here" } : { ok: false, reason: "already_linked_elsewhere" };
    }
    try {
      await pool.query(`INSERT INTO linked_identities(canonical_user_id, platform, identity) VALUES($1,$2,$3)`, [canonicalUserId, platform, identity]);
      return { ok: true };
    } catch (err) {
      if ((err as { code?: string }).code === "23505") return { ok: false, reason: "already_linked_elsewhere" }; // lost a race with a concurrent link
      throw err;
    }
  });
}

const LINK_CODE_TTL_MINUTES = 15;

/**
 * A short-lived, single-use code — the only way to link a chat-id-based identity (Telegram),
 * since there's no phone number the user can type in for it the way there is for SMS/WhatsApp.
 * Requiring the code (rather than trusting whatever chat_id says "yes, link me") stops a
 * different Telegram user from claiming someone else's Fi account by guessing.
 */
export async function createPendingIdentityLink(canonicalUserId: number, platform: ChannelPlatform): Promise<string> {
  return withSchema(async (pool) => {
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = crypto.randomBytes(4).toString("hex").toUpperCase();
      try {
        await pool.query(
          `INSERT INTO pending_identity_links(code, canonical_user_id, platform, expires_at) VALUES($1,$2,$3, now() + interval '${LINK_CODE_TTL_MINUTES} minutes')`,
          [code, canonicalUserId, platform]
        );
        return code;
      } catch (err) {
        if ((err as { code?: string }).code === "23505") continue; // collided on the tiny code space -- try another
        throw err;
      }
    }
    throw new Error("could not generate a unique identity-link code");
  });
}

export type ConsumeLinkCodeResult = { ok: true; canonicalUserId: number } | { ok: false; reason: "not_found" | "expired" | "wrong_platform" };

/**
 * Single-use, but ONLY on an actual successful consumption (or a now-expired code, cleaned up
 * as a courtesy) — a wrong-platform check must never burn the code, or a message that merely
 * arrived on the wrong channel first would permanently strand a link the user hasn't even
 * attempted correctly yet.
 */
export async function consumePendingIdentityLink(code: string, platform: ChannelPlatform): Promise<ConsumeLinkCodeResult> {
  return withSchema(async (pool) => {
    const normalized = code.toUpperCase();
    const r = await pool.query(`SELECT canonical_user_id, platform, expires_at FROM pending_identity_links WHERE code=$1`, [normalized]);
    const row = r.rows[0];
    if (!row) return { ok: false, reason: "not_found" };
    if (new Date(row.expires_at) < new Date()) {
      await pool.query(`DELETE FROM pending_identity_links WHERE code=$1`, [normalized]);
      return { ok: false, reason: "expired" };
    }
    if (row.platform !== platform) return { ok: false, reason: "wrong_platform" };
    await pool.query(`DELETE FROM pending_identity_links WHERE code=$1`, [normalized]);
    return { ok: true, canonicalUserId: row.canonical_user_id };
  });
}

/**
 * The identity a notification should go to: the linked identity matching the stated preference
 * when one exists, otherwise whichever identity IS linked (oldest first) -- stating "SMS" as a
 * preference before an SMS number is actually linked must never silently drop a notification
 * that a real, existing channel could have delivered. Returns null only when nothing at all is
 * linked (e.g. an API-mirrored FS listing's canonical user, which has no chat identity ever).
 */
export async function resolveNotifyIdentity(canonicalUserId: number): Promise<string | null> {
  return withSchema(async (pool) => {
    const identities = (await pool.query(`SELECT platform, identity FROM linked_identities WHERE canonical_user_id=$1 ORDER BY id`, [canonicalUserId])).rows as LinkedIdentity[];
    if (identities.length === 0) return null;
    const pref = await pool.query(`SELECT preferred_channel FROM canonical_notification_preferences WHERE canonical_user_id=$1`, [canonicalUserId]);
    const preferredChannel = pref.rows[0]?.preferred_channel as ChannelPlatform | undefined;
    const match = preferredChannel && identities.find((i) => i.platform === preferredChannel);
    return (match || identities[0]).identity;
  });
}

/**
 * The next linked identity to try after `failedIdentity` didn't deliver. Only ever consulted by
 * the caller when the RECIPIENT has explicitly opted into fallback delivery (fallback_enabled) --
 * this function itself doesn't gate on that, since it has no side effects on its own; the gate
 * belongs where the actual send-and-retry happens (postings/notify.ts).
 */
export async function resolveFallbackIdentity(canonicalUserId: number, failedIdentity: string): Promise<string | null> {
  return withSchema(async (pool) => {
    const r = await pool.query(`SELECT identity FROM linked_identities WHERE canonical_user_id=$1 AND identity <> $2 ORDER BY id`, [canonicalUserId, failedIdentity]);
    return r.rows[0]?.identity ?? null;
  });
}

export function channelLabel(channel: ChannelPlatform): string {
  return channel === "whatsapp" ? "WhatsApp" : channel === "telegram" ? "Telegram" : "SMS";
}
