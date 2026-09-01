import { withSchema, withTransaction } from "./db";

export const DEFAULT_MAX_MATCHES_PER_LISTING = 5;
export const DEFAULT_MAX_PUSH_GROUPS_PER_LISTING = 3;

export interface PushGroup { group_id:string; group_name:string; enabled:boolean; allow_fs:boolean; allow_wtb:boolean; priority:number }
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
    CREATE TABLE IF NOT EXISTS listing_push_groups (group_id TEXT PRIMARY KEY, group_name TEXT NOT NULL DEFAULT '', enabled BOOLEAN NOT NULL DEFAULT true, allow_fs BOOLEAN NOT NULL DEFAULT true, allow_wtb BOOLEAN NOT NULL DEFAULT true, priority INTEGER NOT NULL DEFAULT 100, updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
    CREATE TABLE IF NOT EXISTS listing_group_publications (id BIGSERIAL PRIMARY KEY, listing_id INTEGER NOT NULL REFERENCES postings(id), group_id TEXT NOT NULL, posted_at TIMESTAMPTZ NOT NULL DEFAULT now(), status TEXT NOT NULL, result TEXT, UNIQUE(listing_id,group_id));
    `);
  });
}
export async function getListingLimits():Promise<ListingLimits>{ await ready(); return withSchema(async pool=>{const r=await pool.query(`SELECT key,value FROM listing_settings WHERE key=ANY($1)`,[["MAX_MATCHES_PER_LISTING","MAX_PUSH_GROUPS_PER_LISTING"]]);const m=new Map(r.rows.map(x=>[x.key,Number(x.value)]));return {maxMatchesPerListing:m.get("MAX_MATCHES_PER_LISTING")??DEFAULT_MAX_MATCHES_PER_LISTING,maxPushGroupsPerListing:m.get("MAX_PUSH_GROUPS_PER_LISTING")??DEFAULT_MAX_PUSH_GROUPS_PER_LISTING};}); }
export async function setListingLimits(input:Partial<ListingLimits>):Promise<ListingLimits>{await ready();for(const [key,value] of [["MAX_MATCHES_PER_LISTING",input.maxMatchesPerListing],["MAX_PUSH_GROUPS_PER_LISTING",input.maxPushGroupsPerListing]] as const){if(value!==undefined){if(!Number.isInteger(value)||value<0)throw new Error(`${key} must be a non-negative integer`);await withSchema(pool=>pool.query(`INSERT INTO listing_settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=now()`,[key,value]));}}return getListingLimits();}
export async function listPushGroups():Promise<PushGroup[]>{await ready();return withSchema(async pool=>(await pool.query(`SELECT group_id,group_name,enabled,allow_fs,allow_wtb,priority FROM listing_push_groups ORDER BY priority,group_id`)).rows);}
export async function savePushGroup(g:PushGroup):Promise<PushGroup>{await ready();if(!g.group_id?.trim())throw new Error("group_id is required");const r=await withSchema(pool=>pool.query(`INSERT INTO listing_push_groups(group_id,group_name,enabled,allow_fs,allow_wtb,priority) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(group_id) DO UPDATE SET group_name=EXCLUDED.group_name,enabled=EXCLUDED.enabled,allow_fs=EXCLUDED.allow_fs,allow_wtb=EXCLUDED.allow_wtb,priority=EXCLUDED.priority,updated_at=now() RETURNING group_id,group_name,enabled,allow_fs,allow_wtb,priority`,[g.group_id.trim(),g.group_name||"",Boolean(g.enabled),Boolean(g.allow_fs),Boolean(g.allow_wtb),Number(g.priority)||0]));return r.rows[0];}
export async function eligiblePushGroups(type:"FS"|"WTB"):Promise<PushGroup[]>{const [groups,limits]=await Promise.all([listPushGroups(),getListingLimits()]);return groups.filter(g=>g.enabled&&(type==="FS"?g.allow_fs:g.allow_wtb)&&g.group_id.trim()).slice(0,limits.maxPushGroupsPerListing);}
export async function claimPublication(listingId:number,groupId:string):Promise<boolean>{await ready();const r=await withSchema(pool=>pool.query(`INSERT INTO listing_group_publications(listing_id,group_id,status) VALUES($1,$2,'sending') ON CONFLICT(listing_id,group_id) DO NOTHING RETURNING id`,[listingId,groupId]));return r.rows.length>0;}
export async function finishPublication(listingId:number,groupId:string,status:"posted"|"failed",result?:string):Promise<void>{await withSchema(pool=>pool.query(`UPDATE listing_group_publications SET status=$3,result=$4,posted_at=now() WHERE listing_id=$1 AND group_id=$2`,[listingId,groupId,status,result??null]));}
