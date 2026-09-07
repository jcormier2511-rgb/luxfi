import { parse } from "csv-parse/sync";
import { withSchema, withTransaction } from "./db";
import { initAdminSchema, listActivePushEligibleGroups, recordGroupPushResult } from "../admin/store";

export const DEFAULT_MAX_MATCHES_PER_LISTING = 3;
export const DEFAULT_MAX_PUSH_GROUPS_PER_LISTING = 3;

export interface PushGroup { group_id:string; group_name:string; platform?:"whatsapp"|"telegram"; enabled:boolean; allow_fs:boolean; allow_wtb:boolean; priority:number; notes?:string }
export const PUSH_GROUP_CSV_HEADER = "group_id,group_name,platform,enabled,allow_fs,allow_wtb,priority,notes";
export const PUSH_GROUP_CSV_SAMPLE = `${PUSH_GROUP_CSV_HEADER}\n-1001234567890,Miami Dealers,telegram,true,true,true,100,\n15551234567,Vintage Rolex Group,whatsapp,true,true,false,50,FS only\n`;
export interface ListingLimits { maxMatchesPerListing:number; maxPushGroupsPerListing:number }

async function ready():Promise<void>{
  // PostgreSQL's CREATE TABLE IF NOT EXISTS is idempotent after an object exists, but two
  // transactions creating the same table concurrently can still race while pg_type rows are
  // being installed (23505 on pg_type_typname_nsp_index). Serialize only this tiny migration
  // with a transaction-scoped advisory lock; normal listing/config operations remain fully
  // concurrent, and the lock is automatically released on commit or rollback.
  await withTransaction(async client=>{
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('luxfi_listing_config_schema'))`);
    await client.query(`
    CREATE TABLE IF NOT EXISTS listing_settings (key TEXT PRIMARY KEY, value INTEGER NOT NULL CHECK(value >= 0), updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
    CREATE TABLE IF NOT EXISTS listing_push_groups (group_id TEXT PRIMARY KEY, group_name TEXT NOT NULL DEFAULT '', platform TEXT NOT NULL DEFAULT 'whatsapp', enabled BOOLEAN NOT NULL DEFAULT true, allow_fs BOOLEAN NOT NULL DEFAULT true, allow_wtb BOOLEAN NOT NULL DEFAULT true, priority INTEGER NOT NULL DEFAULT 100, notes TEXT, last_post_at TIMESTAMPTZ, last_result TEXT, status_error TEXT, updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
    CREATE TABLE IF NOT EXISTS listing_group_publications (id BIGSERIAL PRIMARY KEY, listing_id INTEGER NOT NULL REFERENCES postings(id), group_id TEXT NOT NULL, posted_at TIMESTAMPTZ NOT NULL DEFAULT now(), status TEXT NOT NULL, result TEXT, UNIQUE(listing_id,group_id));
    ALTER TABLE listing_push_groups ADD COLUMN IF NOT EXISTS platform TEXT NOT NULL DEFAULT 'whatsapp';
    ALTER TABLE listing_push_groups ADD COLUMN IF NOT EXISTS notes TEXT;
    ALTER TABLE listing_push_groups ADD COLUMN IF NOT EXISTS last_post_at TIMESTAMPTZ;
    ALTER TABLE listing_push_groups ADD COLUMN IF NOT EXISTS last_result TEXT;
    ALTER TABLE listing_push_groups ADD COLUMN IF NOT EXISTS status_error TEXT;
    `);
  });
  // Unified Group Registry cutover: approved_groups (admin/store.ts) is now the single source of
  // truth for push eligibility too -- see listPushGroups/savePushGroup/eligiblePushGroups below,
  // which all read/write it instead of this table now. One-time-only backfill of whatever was
  // configured here before the cutover, so a real deployment's existing push configuration is
  // never silently lost -- gated so it never re-runs and clobbers a later edit made directly on
  // the unified registry with what's now orphaned data sitting in listing_push_groups.
  await initAdminSchema();
  await withTransaction(async client=>{
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('luxfi_push_groups_backfill'))`);
    const already=await client.query(`SELECT 1 FROM admin_schema_migrations WHERE key='backfill_push_groups_into_registry'`);
    if(already.rows.length===0){
      await client.query(`
        INSERT INTO approved_groups (group_name, group_id, platform, push_enabled, allow_fs, allow_wtb, priority, notes)
        SELECT group_name, group_id, CASE WHEN platform='telegram' THEN 'telegram' ELSE 'whatsapp' END, enabled, allow_fs, allow_wtb, priority, notes
        FROM listing_push_groups
        ON CONFLICT (platform, group_id) DO UPDATE SET
          push_enabled = EXCLUDED.push_enabled, allow_fs = EXCLUDED.allow_fs, allow_wtb = EXCLUDED.allow_wtb,
          priority = EXCLUDED.priority, updated_at = now();
        INSERT INTO admin_schema_migrations(key) VALUES ('backfill_push_groups_into_registry');
      `);
    }
  });
}
export async function getListingLimits():Promise<ListingLimits>{ await ready(); return withSchema(async pool=>{const r=await pool.query(`SELECT key,value FROM listing_settings WHERE key=ANY($1)`,[["MAX_MATCHES_PER_LISTING","MAX_PUSH_GROUPS_PER_LISTING"]]);const m=new Map(r.rows.map(x=>[x.key,Number(x.value)]));return {maxMatchesPerListing:m.get("MAX_MATCHES_PER_LISTING")??DEFAULT_MAX_MATCHES_PER_LISTING,maxPushGroupsPerListing:m.get("MAX_PUSH_GROUPS_PER_LISTING")??DEFAULT_MAX_PUSH_GROUPS_PER_LISTING};}); }
export async function setListingLimits(input:Partial<ListingLimits>):Promise<ListingLimits>{await ready();for(const [key,value] of [["MAX_MATCHES_PER_LISTING",input.maxMatchesPerListing],["MAX_PUSH_GROUPS_PER_LISTING",input.maxPushGroupsPerListing]] as const){if(value!==undefined){if(!Number.isInteger(value)||value<0)throw new Error(`${key} must be a non-negative integer`);await withSchema(pool=>pool.query(`INSERT INTO listing_settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=now()`,[key,value]));}}return getListingLimits();}
/** Reads the unified Group Registry (approved_groups), not this module's own legacy
 *  listing_push_groups table -- see ready()'s one-time backfill comment above. */
export async function listPushGroups():Promise<PushGroup[]>{
  await initAdminSchema();
  return withSchema(async pool=>(await pool.query(
    `SELECT group_id,group_name,platform,push_enabled AS enabled,allow_fs,allow_wtb,priority,notes,
            last_push_at AS last_post_at,last_push_result AS last_result,NULL::text AS status_error
     FROM approved_groups ORDER BY priority,group_id`
  )).rows);
}
/** Manual push-group save (the legacy /admin/push-groups page) writes into the SAME unified
 *  registry table the new /admin/groups page and CSV imports use -- upserts by (platform,
 *  group_id), same contract as before. */
export async function savePushGroup(g:PushGroup):Promise<PushGroup>{
  await initAdminSchema();
  if(!g.group_id?.trim())throw new Error("group_id is required");
  const platform=g.platform==='telegram'?'telegram':'whatsapp';
  const r=await withSchema(pool=>pool.query(
    `INSERT INTO approved_groups(group_name,group_id,platform,push_enabled,allow_fs,allow_wtb,priority,notes)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (platform, group_id) DO UPDATE SET
       group_name=EXCLUDED.group_name,push_enabled=EXCLUDED.push_enabled,allow_fs=EXCLUDED.allow_fs,
       allow_wtb=EXCLUDED.allow_wtb,priority=EXCLUDED.priority,notes=EXCLUDED.notes,updated_at=now()
     RETURNING group_id,group_name,platform,push_enabled AS enabled,allow_fs,allow_wtb,priority,notes`,
    [g.group_name||"",g.group_id.trim(),platform,Boolean(g.enabled),Boolean(g.allow_fs),Boolean(g.allow_wtb),Number(g.priority)||0,g.notes||null]
  ));
  return r.rows[0];
}
export async function deletePushGroup(groupId:string):Promise<void>{
  await initAdminSchema();
  await withSchema(pool=>pool.query(`DELETE FROM approved_groups WHERE group_id=$1`,[groupId]));
}
/**
 * Bulk push-group setup from a CSV upload — the user has 4 WhatsApp groups and 6 Telegram
 * groups to configure at once, one row per group rather than one save through the form per
 * group. Same upsert-by-group_id contract as savePushGroup (a re-upload of the same group_id
 * updates it in place), mirroring admin/store.ts's importUsersCsv/exportUsersCsv pattern.
 */
export async function importPushGroupsCsv(csv:string):Promise<{added:number;updated:number;errors:{row:number;error:string}[]}>{
  await initAdminSchema();
  const rows=parse(csv,{columns:true,skip_empty_lines:true,trim:true}) as any[];
  let added=0,updated=0;
  const errors:{row:number;error:string}[]=[];
  for(let i=0;i<rows.length;i++){
    try{
      const raw=rows[i];
      const groupId=String(raw.group_id||"").trim();
      if(!groupId)throw new Error("group_id is required");
      const isFalse=(v:unknown)=>["false","0"].includes(String(v??"").trim().toLowerCase());
      const platform=raw.platform==="telegram"?"telegram":"whatsapp";
      const existing=await withSchema(pool=>pool.query(`SELECT 1 FROM approved_groups WHERE platform=$1 AND group_id=$2`,[platform,groupId]));
      await savePushGroup({
        group_id:groupId,
        group_name:raw.group_name||"",
        platform:raw.platform==="telegram"?"telegram":"whatsapp",
        enabled:!isFalse(raw.enabled),
        allow_fs:!isFalse(raw.allow_fs),
        allow_wtb:!isFalse(raw.allow_wtb),
        priority:raw.priority?Number(raw.priority):100,
        notes:raw.notes||undefined,
      });
      if(existing.rows.length>0)updated++;else added++;
    }catch(e){errors.push({row:i+2,error:(e as Error).message});}
  }
  return {added,updated,errors};
}
export async function exportPushGroupsCsv():Promise<string>{
  const rows=await listPushGroups();
  const esc=(v:unknown)=>v==null?"":/[",\n]/.test(String(v))?`"${String(v).replace(/"/g,'""')}"`:String(v);
  const fields=["group_id","group_name","platform","enabled","allow_fs","allow_wtb","priority","notes"] as const;
  return PUSH_GROUP_CSV_HEADER+"\n"+rows.map(r=>fields.map(f=>esc(r[f])).join(",")).join("\n")+(rows.length?"\n":"");
}
/** Reads the unified registry directly (not listPushGroups, which shapes every group for
 *  display) -- already filtered to active+push_enabled+allow_{fs,wtb} and priority-ordered. */
export async function eligiblePushGroups(type:"FS"|"WTB"):Promise<PushGroup[]>{
  const [groups,limits]=await Promise.all([listActivePushEligibleGroups(type),getListingLimits()]);
  return groups.slice(0,limits.maxPushGroupsPerListing).map(g=>({
    group_id:g.group_id,group_name:g.group_name,platform:g.platform,
    enabled:true,allow_fs:g.allow_fs,allow_wtb:g.allow_wtb,priority:g.priority,
  }));
}
export async function claimPublication(listingId:number,groupId:string):Promise<boolean>{await ready();const r=await withSchema(pool=>pool.query(`INSERT INTO listing_group_publications(listing_id,group_id,status) VALUES($1,$2,'sending') ON CONFLICT(listing_id,group_id) DO NOTHING RETURNING id`,[listingId,groupId]));return r.rows.length>0;}
/** Also records the outcome against the group itself in the unified registry -- "show last push
 *  result where available" (real reported ask) -- best-effort, must never throw and block/mask
 *  the actual publication-status update above. */
export async function finishPublication(listingId:number,groupId:string,status:"posted"|"failed",result?:string):Promise<void>{
  await withSchema(pool=>pool.query(`UPDATE listing_group_publications SET status=$3,result=$4,posted_at=now() WHERE listing_id=$1 AND group_id=$2`,[listingId,groupId,status,result??null]));
  await recordGroupPushResult(groupId,status,result).catch(()=>{});
}
