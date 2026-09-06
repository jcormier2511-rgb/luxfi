import { parse } from "csv-parse/sync";
import { withSchema, withTransaction } from "./db";

export const DEFAULT_MAX_MATCHES_PER_LISTING = 5;
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
}
export async function getListingLimits():Promise<ListingLimits>{ await ready(); return withSchema(async pool=>{const r=await pool.query(`SELECT key,value FROM listing_settings WHERE key=ANY($1)`,[["MAX_MATCHES_PER_LISTING","MAX_PUSH_GROUPS_PER_LISTING"]]);const m=new Map(r.rows.map(x=>[x.key,Number(x.value)]));return {maxMatchesPerListing:m.get("MAX_MATCHES_PER_LISTING")??DEFAULT_MAX_MATCHES_PER_LISTING,maxPushGroupsPerListing:m.get("MAX_PUSH_GROUPS_PER_LISTING")??DEFAULT_MAX_PUSH_GROUPS_PER_LISTING};}); }
export async function setListingLimits(input:Partial<ListingLimits>):Promise<ListingLimits>{await ready();for(const [key,value] of [["MAX_MATCHES_PER_LISTING",input.maxMatchesPerListing],["MAX_PUSH_GROUPS_PER_LISTING",input.maxPushGroupsPerListing]] as const){if(value!==undefined){if(!Number.isInteger(value)||value<0)throw new Error(`${key} must be a non-negative integer`);await withSchema(pool=>pool.query(`INSERT INTO listing_settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=now()`,[key,value]));}}return getListingLimits();}
export async function listPushGroups():Promise<PushGroup[]>{await ready();return withSchema(async pool=>(await pool.query(`SELECT * FROM listing_push_groups ORDER BY priority,group_id`)).rows);}
export async function savePushGroup(g:PushGroup):Promise<PushGroup>{await ready();if(!g.group_id?.trim())throw new Error("group_id is required");const r=await withSchema(pool=>pool.query(`INSERT INTO listing_push_groups(group_id,group_name,platform,enabled,allow_fs,allow_wtb,priority,notes) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(group_id) DO UPDATE SET group_name=EXCLUDED.group_name,platform=EXCLUDED.platform,enabled=EXCLUDED.enabled,allow_fs=EXCLUDED.allow_fs,allow_wtb=EXCLUDED.allow_wtb,priority=EXCLUDED.priority,notes=EXCLUDED.notes,updated_at=now() RETURNING *`,[g.group_id.trim(),g.group_name||"",g.platform==='telegram'?'telegram':'whatsapp',Boolean(g.enabled),Boolean(g.allow_fs),Boolean(g.allow_wtb),Number(g.priority)||0,g.notes||null]));return r.rows[0];}
export async function deletePushGroup(groupId:string):Promise<void>{await ready();await withSchema(pool=>pool.query(`DELETE FROM listing_push_groups WHERE group_id=$1`,[groupId]));}
/**
 * Bulk push-group setup from a CSV upload — the user has 4 WhatsApp groups and 6 Telegram
 * groups to configure at once, one row per group rather than one save through the form per
 * group. Same upsert-by-group_id contract as savePushGroup (a re-upload of the same group_id
 * updates it in place), mirroring admin/store.ts's importUsersCsv/exportUsersCsv pattern.
 */
export async function importPushGroupsCsv(csv:string):Promise<{added:number;updated:number;errors:{row:number;error:string}[]}>{
  await ready();
  const rows=parse(csv,{columns:true,skip_empty_lines:true,trim:true}) as any[];
  let added=0,updated=0;
  const errors:{row:number;error:string}[]=[];
  for(let i=0;i<rows.length;i++){
    try{
      const raw=rows[i];
      const groupId=String(raw.group_id||"").trim();
      if(!groupId)throw new Error("group_id is required");
      const isFalse=(v:unknown)=>["false","0"].includes(String(v??"").trim().toLowerCase());
      const existing=await withSchema(pool=>pool.query(`SELECT 1 FROM listing_push_groups WHERE group_id=$1`,[groupId]));
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
export async function eligiblePushGroups(type:"FS"|"WTB"):Promise<PushGroup[]>{const [groups,limits]=await Promise.all([listPushGroups(),getListingLimits()]);return groups.filter(g=>g.enabled&&(type==="FS"?g.allow_fs:g.allow_wtb)&&g.group_id.trim()).slice(0,limits.maxPushGroupsPerListing);}
export async function claimPublication(listingId:number,groupId:string):Promise<boolean>{await ready();const r=await withSchema(pool=>pool.query(`INSERT INTO listing_group_publications(listing_id,group_id,status) VALUES($1,$2,'sending') ON CONFLICT(listing_id,group_id) DO NOTHING RETURNING id`,[listingId,groupId]));return r.rows.length>0;}
export async function finishPublication(listingId:number,groupId:string,status:"posted"|"failed",result?:string):Promise<void>{await withSchema(pool=>pool.query(`UPDATE listing_group_publications SET status=$3,result=$4,posted_at=now() WHERE listing_id=$1 AND group_id=$2`,[listingId,groupId,status,result??null]));}
