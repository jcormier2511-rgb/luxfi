import crypto from "crypto";
import fs from "fs";
import bcrypt from "bcryptjs";
import { Pool } from "pg";
import { parse } from "csv-parse/sync";
import { config } from "../config";
import { getActiveGroupCounts } from "../postings/groupActivity";

export type AdminRole = "owner" | "administrator" | "support" | "read_only";
export interface Administrator { id:number; name:string; username:string; email:string; role:AdminRole; status:"active"|"inactive"; last_login_at:string|null; created_at:string; updated_at:string }
export const USER_CSV_HEADER = "phone,name,company,email,tier,specialty,wf_profile_id,membership_status,subscription_status,access_status,trial_limit,complimentary_access,opt_in_status,opt_in_source,notes";
export const USER_CSV_SAMPLE = `${USER_CSV_HEADER}\n13055551234,Marco D.,Marco Watches,marco@example.com,A,watches,12345,active,trial,active,3,false,opted_in,manual_admin,Approved dealer\n`;
// Syntactically valid bcrypt hash (never a real password's) compared against when no matching
// administrator row exists, so authenticate() always pays bcrypt's ~100ms+ cost and an unknown
// username can't be distinguished from a wrong password by response timing.
const DUMMY_BCRYPT_HASH = "$2a$12$CwTycUXWue0Thq9StjUM0uJ8i8LnBW4rILz.OZ8i.wt.Q0jY9BQq";

let pool: Pool | null = null;
let adminSchemaReady: Promise<void> | null = null;
const db = () => pool ??= new Pool({ connectionString: config.database.url });
// pg returns BIGSERIAL values as strings. Sessions require an integer administrator ID, so
// normalize it at the database boundary before signing it into the production session cookie.
const publicAdmin = (r:any): Administrator => ({ id:Number(r.id), name:r.name, username:r.username, email:r.email, role:r.role, status:r.status, last_login_at:r.last_login_at?.toISOString?.() ?? r.last_login_at, created_at:r.created_at?.toISOString?.() ?? r.created_at, updated_at:r.updated_at?.toISOString?.() ?? r.updated_at });
export function normalizePhone(value:string):string { const phone=value.replace(/[^0-9]/g,""); if (!/^[1-9][0-9]{7,14}$/.test(phone)) throw new Error("phone must contain 8-15 digits including country code"); return phone; }
export async function hashPassword(password:string):Promise<string> { if(password.length<12) throw new Error("password must be at least 12 characters"); return bcrypt.hash(password,12); }

async function createAdminSchema():Promise<void> {
  const client=await db().connect();
  try { await client.query("BEGIN"); await client.query("SELECT pg_advisory_xact_lock(hashtext('luxfi_admin_schema'))"); await client.query(`
    CREATE TABLE IF NOT EXISTS administrators (id BIGSERIAL PRIMARY KEY,name TEXT NOT NULL,username TEXT NOT NULL,email TEXT NOT NULL,password_hash TEXT NOT NULL,role TEXT NOT NULL CHECK(role IN ('owner','administrator','support','read_only')),status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','inactive')),last_login_at TIMESTAMPTZ,created_at TIMESTAMPTZ NOT NULL DEFAULT now(),updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
    CREATE UNIQUE INDEX IF NOT EXISTS administrators_username_ci ON administrators(lower(username)); CREATE UNIQUE INDEX IF NOT EXISTS administrators_email_ci ON administrators(lower(email));
    CREATE TABLE IF NOT EXISTS admin_audit_log (id BIGSERIAL PRIMARY KEY,administrator_id BIGINT REFERENCES administrators(id) ON DELETE SET NULL,administrator_label TEXT NOT NULL,action TEXT NOT NULL,target_type TEXT NOT NULL,target_id TEXT,metadata JSONB NOT NULL DEFAULT '{}',created_at TIMESTAMPTZ NOT NULL DEFAULT now());
    CREATE TABLE IF NOT EXISTS admin_login_attempts (id BIGSERIAL PRIMARY KEY,identifier_hash TEXT NOT NULL,ip_hash TEXT NOT NULL,succeeded BOOLEAN NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT now()); CREATE INDEX IF NOT EXISTS admin_login_attempts_recent ON admin_login_attempts(identifier_hash,ip_hash,created_at);
    CREATE TABLE IF NOT EXISTS approved_users (id BIGSERIAL PRIMARY KEY,phone TEXT NOT NULL UNIQUE,name TEXT NOT NULL,company TEXT,email TEXT,tier TEXT,specialty TEXT,wf_profile_id TEXT,membership_status TEXT,subscription_status TEXT,access_status TEXT NOT NULL DEFAULT 'active' CHECK(access_status IN ('active','inactive','blocked')),trial_limit INTEGER NOT NULL DEFAULT 3 CHECK(trial_limit>=0),trial_approvals_used INTEGER NOT NULL DEFAULT 0 CHECK(trial_approvals_used>=0),complimentary_access BOOLEAN NOT NULL DEFAULT false,opt_in_status TEXT,opt_in_source TEXT,opt_in_at TIMESTAMPTZ,last_interaction_at TIMESTAMPTZ,notes TEXT,created_at TIMESTAMPTZ NOT NULL DEFAULT now(),updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
    CREATE TABLE IF NOT EXISTS approved_groups (id BIGSERIAL PRIMARY KEY,group_name TEXT NOT NULL,whatsapp_chat_id TEXT NOT NULL UNIQUE,status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','inactive')),monitoring_enabled BOOLEAN NOT NULL DEFAULT false,concierge_enabled BOOLEAN NOT NULL DEFAULT false,categories TEXT[] NOT NULL DEFAULT '{}',country TEXT,timezone TEXT,last_message_at TIMESTAMPTZ,last_posting_at TIMESTAMPTZ,member_count INTEGER CHECK(member_count>=0),notes TEXT,created_at TIMESTAMPTZ NOT NULL DEFAULT now(),updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
    ALTER TABLE approved_groups ADD COLUMN IF NOT EXISTS platform TEXT NOT NULL DEFAULT 'whatsapp';
    ALTER TABLE approved_groups ADD COLUMN IF NOT EXISTS monitor_fs BOOLEAN NOT NULL DEFAULT true;
    ALTER TABLE approved_groups ADD COLUMN IF NOT EXISTS monitor_wtb BOOLEAN NOT NULL DEFAULT true;
    ALTER TABLE approved_groups ADD COLUMN IF NOT EXISTS last_successful_ingest_at TIMESTAMPTZ;
    ALTER TABLE approved_groups ADD COLUMN IF NOT EXISTS ingestion_status TEXT;
    ALTER TABLE approved_groups ADD COLUMN IF NOT EXISTS ingestion_error TEXT;

    -- Unified Group Registry (real reported ask): approved_groups becomes the single canonical
    -- table for BOTH monitoring (inbound ingestion) and pushing (outbound listing distribution,
    -- previously the entirely separate listing_push_groups table -- see postings/listingConfig.ts),
    -- plus Whapi-discovery bookkeeping. "group_id" replaces the WhatsApp-specific name
    -- whatsapp_chat_id now that this table has long since covered Telegram too.
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='approved_groups' AND column_name='whatsapp_chat_id')
         AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='approved_groups' AND column_name='group_id')
      THEN
        ALTER TABLE approved_groups RENAME COLUMN whatsapp_chat_id TO group_id;
      END IF;
    END $$;
    ALTER TABLE approved_groups ADD COLUMN IF NOT EXISTS push_enabled BOOLEAN NOT NULL DEFAULT false;
    ALTER TABLE approved_groups ADD COLUMN IF NOT EXISTS allow_fs BOOLEAN NOT NULL DEFAULT true;
    ALTER TABLE approved_groups ADD COLUMN IF NOT EXISTS allow_wtb BOOLEAN NOT NULL DEFAULT true;
    ALTER TABLE approved_groups ADD COLUMN IF NOT EXISTS priority INTEGER NOT NULL DEFAULT 100;
    ALTER TABLE approved_groups ADD COLUMN IF NOT EXISTS category TEXT;
    ALTER TABLE approved_groups ADD COLUMN IF NOT EXISTS source_account TEXT;
    -- NULL = never checked (unknown); only Whapi discovery or an explicit manual verification
    -- ever sets this true/false -- a group is never assumed accessible just because a row exists.
    ALTER TABLE approved_groups ADD COLUMN IF NOT EXISTS fi_is_member BOOLEAN;
    -- KNOWN (a row exists) vs ACCESSIBLE (this column) are deliberately different states -- see
    -- the module comment on isApprovedMonitoringGroup. Defaults true so every group created
    -- before this column existed, and every manually-added group, reads as accessible until a
    -- Whapi sync says otherwise.
    ALTER TABLE approved_groups ADD COLUMN IF NOT EXISTS accessible BOOLEAN NOT NULL DEFAULT true;
    ALTER TABLE approved_groups ADD COLUMN IF NOT EXISTS last_verified_at TIMESTAMPTZ;
    ALTER TABLE approved_groups ADD COLUMN IF NOT EXISTS last_push_at TIMESTAMPTZ;
    ALTER TABLE approved_groups ADD COLUMN IF NOT EXISTS last_push_result TEXT;

    -- Platform-qualified uniqueness (a WhatsApp group and a Telegram group could theoretically
    -- share the same literal id string) replaces the old single-column constraint.
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='approved_groups_platform_group_id_key') THEN
        ALTER TABLE approved_groups DROP CONSTRAINT IF EXISTS approved_groups_whatsapp_chat_id_key;
        ALTER TABLE approved_groups ADD CONSTRAINT approved_groups_platform_group_id_key UNIQUE (platform, group_id);
      END IF;
    END $$;

    -- One-time migration marker table -- see postings/listingConfig.ts's ready(), which performs
    -- the actual backfill of pre-unification push-group data into this table (it, not this
    -- module, is guaranteed to run after listing_push_groups exists).
    CREATE TABLE IF NOT EXISTS admin_schema_migrations (key TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now());

    -- Multiple Whapi-connected WhatsApp numbers can eventually feed this same Group Registry --
    -- a group accessible through more than one account must never be duplicated as two logical
    -- groups, so per-account accessibility lives here, separate from the canonical
    -- approved_groups row. Only one account exists today (config.whapi.accountLabel); this is
    -- the seam a second one plugs into later. approved_groups.accessible is a derived summary
    -- (true if ANY linked account currently reports accessible) -- see recordGroupAccountAccess.
    CREATE TABLE IF NOT EXISTS group_account_access (
      id BIGSERIAL PRIMARY KEY,
      approved_group_id BIGINT NOT NULL REFERENCES approved_groups(id) ON DELETE CASCADE,
      source_account TEXT NOT NULL,
      accessible BOOLEAN NOT NULL DEFAULT true,
      last_verified_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE(approved_group_id, source_account)
    );
  `); await client.query("COMMIT"); } catch(error){await client.query("ROLLBACK");throw error} finally{client.release()}
  const count=Number((await db().query("SELECT count(*) n FROM administrators")).rows[0].n);
  if(count===0 && config.admin.initial.username && config.admin.initial.passwordHash) await db().query("INSERT INTO administrators(name,username,email,password_hash,role) VALUES($1,$2,$3,$4,'owner')",[config.admin.initial.name,config.admin.initial.username,config.admin.initial.email,config.admin.initial.passwordHash]);
  // One-way, non-destructive bridge for the current contacts file. Existing PostgreSQL rows
  // win, and rerunning this migration is harmless because normalized phone is unique.
  if(fs.existsSync(config.data.contactsCsv)) {
    const legacy=parse(fs.readFileSync(config.data.contactsCsv,"utf8"),{columns:true,skip_empty_lines:true,trim:true}) as any[];
    for(const row of legacy) try { const phone=normalizePhone(row.phone||""); if(!row.name)continue; await db().query("INSERT INTO approved_users(phone,name,tier,specialty,wf_profile_id,opt_in_source) VALUES($1,$2,$3,$4,$5,'legacy_contacts_migration') ON CONFLICT(phone) DO NOTHING",[phone,row.name,row.tier||null,row.specialty||null,row.wf_profile_id||null]); } catch { /* invalid legacy rows remain untouched in their source file */ }
  }
}
/** A single shared migration promise prevents createServer/startup from racing the owner seed. */
export function initAdminSchema():Promise<void> {
  return adminSchemaReady ??= createAdminSchema();
}
export async function audit(admin:Administrator|null,action:string,targetType:string,targetId?:string,metadata:Record<string,unknown>={}):Promise<void>{ const safe=JSON.parse(JSON.stringify(metadata,(k,v)=>/password|secret|token|api.?key|message/i.test(k)?"[REDACTED]":v)); await db().query("INSERT INTO admin_audit_log(administrator_id,administrator_label,action,target_type,target_id,metadata) VALUES($1,$2,$3,$4,$5,$6)",[admin?.id??null,admin?`${admin.username} (${admin.role})`:"anonymous",action,targetType,targetId??null,safe]); }
export async function authenticate(username:string,password:string,ip:string):Promise<{admin?:Administrator;limited?:boolean}>{ const ih=crypto.createHash("sha256").update(username.toLowerCase()).digest("hex"), ph=crypto.createHash("sha256").update(ip).digest("hex"); const recent=Number((await db().query("SELECT count(*) n FROM admin_login_attempts WHERE identifier_hash=$1 AND ip_hash=$2 AND NOT succeeded AND created_at>now()-interval '15 minutes'",[ih,ph])).rows[0].n); if(recent>=5)return{limited:true}; const r=await db().query("SELECT * FROM administrators WHERE lower(username)=lower($1)",[username]); const row=r.rows[0]; const passwordMatches=await bcrypt.compare(password,row?.password_hash??DUMMY_BCRYPT_HASH); const ok=Boolean(row&&row.status==='active'&&passwordMatches); await db().query("INSERT INTO admin_login_attempts(identifier_hash,ip_hash,succeeded) VALUES($1,$2,$3)",[ih,ph,ok]); const admin=ok?publicAdmin(row):null; await audit(admin,ok?"administrator.login_success":"administrator.login_failure","session",undefined,{username,ipHash:ph}); if(!admin)return{}; await db().query("UPDATE administrators SET last_login_at=now() WHERE id=$1",[admin.id]); return{admin}; }
export async function getAdministrator(id:number):Promise<Administrator|null>{const r=await db().query("SELECT * FROM administrators WHERE id=$1 AND status='active'",[id]);return r.rows[0]?publicAdmin(r.rows[0]):null}
export async function listAdministrators():Promise<Administrator[]>{return(await db().query("SELECT * FROM administrators ORDER BY created_at")).rows.map(publicAdmin)}
export async function saveAdministrator(actor:Administrator,input:any,id?:number):Promise<Administrator>{
  if(actor.role!=="owner")throw new Error("owner role required");
  const role=input.role as AdminRole;
  if(!["owner","administrator","support","read_only"].includes(role))throw new Error("invalid role");
  if(id){
    const client=await db().connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(710013)");
      const current=(await client.query("SELECT role,status FROM administrators WHERE id=$1 FOR UPDATE",[id])).rows[0];
      if(!current)throw new Error("administrator not found");
      if(current.role==='owner'&&current.status==='active'&&(role!=='owner'||input.status!=='active')){
        const otherOwners=Number((await client.query("SELECT count(*) n FROM administrators WHERE role='owner' AND status='active' AND id<>$1",[id])).rows[0].n);
        if(otherOwners===0)throw new Error("at least one active owner is required");
      }
      await client.query("UPDATE administrators SET name=$1,username=$2,email=$3,role=$4,status=$5,updated_at=now() WHERE id=$6",[input.name,input.username,input.email,role,input.status,id]);
      await client.query("COMMIT");
    } catch(error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  }else{
    if(!input.password)throw new Error("password required");
    await db().query("INSERT INTO administrators(name,username,email,password_hash,role) VALUES($1,$2,$3,$4,$5)",[input.name,input.username,input.email,await hashPassword(input.password),role]);
  }
  const r=await db().query("SELECT * FROM administrators WHERE "+(id?"id=$1":"lower(username)=lower($1)"),[id??input.username]);const out=publicAdmin(r.rows[0]);await audit(actor,id?"administrator.updated":"administrator.created","administrator",String(out.id));return out
}
export async function resetAdministratorPassword(actor:Administrator,id:number,password:string){if(actor.role!=="owner")throw new Error("owner role required");await db().query("UPDATE administrators SET password_hash=$1,updated_at=now() WHERE id=$2",[await hashPassword(password),id]);await audit(actor,"administrator.password_reset","administrator",String(id));}

const allowedUserFields=["phone","name","company","email","tier","specialty","wf_profile_id","membership_status","subscription_status","access_status","trial_limit","complimentary_access","opt_in_status","opt_in_source","notes"];
/**
 * Adds the "groups active in" signal (see postings/groupActivity.ts) to each approved-user row
 * as active_groups_count, resolved phone -> linked_identities -> canonical user in one batch.
 * Best-effort: the Users page must still render when the postings schema is absent or the
 * lookup fails, so any error degrades to 0 for every row rather than failing the listing.
 * Not part of allowedUserFields, so it is display-only and can never be written back.
 */
async function withActiveGroupCounts(rows:any[]):Promise<any[]>{
  if(rows.length===0)return rows;
  let counts=new Map<string,number>();
  try{
    const phones=[...new Set(rows.map(r=>String(r.phone)))];
    const links=(await db().query("SELECT identity,canonical_user_id FROM linked_identities WHERE identity=ANY($1::text[])",[phones])).rows as {identity:string;canonical_user_id:number}[];
    const byUser=await getActiveGroupCounts(links.map(l=>Number(l.canonical_user_id)));
    for(const l of links)counts.set(l.identity,Math.max(counts.get(l.identity)??0,byUser.get(Number(l.canonical_user_id))??0));
  }catch(err){console.error("[admin] active group count lookup failed (showing 0):",err);counts=new Map();}
  return rows.map(r=>({...r,active_groups_count:counts.get(String(r.phone))??0}));
}
export async function listUsers(q="",status="",page=1,limit=25){const values:any[]=[];let where="WHERE 1=1";if(q){values.push(`%${q}%`);where+=` AND (phone ILIKE $${values.length} OR name ILIKE $${values.length} OR company ILIKE $${values.length})`;}if(status){values.push(status);where+=` AND access_status=$${values.length}`;}values.push(limit,(page-1)*limit);const rows=await withActiveGroupCounts((await db().query(`SELECT * FROM approved_users ${where} ORDER BY created_at DESC LIMIT $${values.length-1} OFFSET $${values.length}`,values)).rows);const count=Number((await db().query(`SELECT count(*) n FROM approved_users ${where}`,values.slice(0,-2))).rows[0].n);return{rows,count,page,limit}}
export async function saveUser(actor:Administrator,input:any,id?:number){const phone=normalizePhone(String(input.phone));if(!String(input.name??"").trim())throw new Error("name required");const values=allowedUserFields.map(f=>f==='phone'?phone:f==='trial_limit'?Number(input[f]??3):f==='complimentary_access'?input[f]===true||input[f]==='true':input[f]||null);let row;if(id){values.push(id);row=(await db().query(`UPDATE approved_users SET ${allowedUserFields.map((f,i)=>`${f}=$${i+1}`).join(',')},updated_at=now() WHERE id=$${values.length} RETURNING *`,values)).rows[0]}else row=(await db().query(`INSERT INTO approved_users(${allowedUserFields.join(',')}) VALUES(${values.map((_,i)=>`$${i+1}`).join(',')}) RETURNING *`,values)).rows[0];await audit(actor,id?"user.updated":"user.created","approved_user",String(row.id));return row}
export async function deleteUser(actor:Administrator,id:number){await db().query("DELETE FROM approved_users WHERE id=$1",[id]);await audit(actor,"user.deleted","approved_user",String(id))}
export async function importUsersCsv(actor:Administrator,csv:string){const rows=parse(csv,{columns:true,skip_empty_lines:true,trim:true}) as any[];let added=0,updated=0,skipped=0;const errors:any[]=[];for(let i=0;i<rows.length;i++){try{const raw=rows[i],phone=normalizePhone(raw.phone||"");if(!raw.name)throw new Error("name required");const existing=(await db().query("SELECT * FROM approved_users WHERE phone=$1",[phone])).rows[0];if(existing){const patch:any={...existing};for(const f of allowedUserFields)if(raw[f]!==undefined&&raw[f]!=="")patch[f]=raw[f];await saveUser(actor,patch,existing.id);updated++;}else{await saveUser(actor,{...raw,phone},undefined);added++;}}catch(e){errors.push({row:i+2,error:(e as Error).message});}}await audit(actor,"users.csv_import","approved_user",undefined,{added,updated,skipped,errorCount:errors.length});return{added,updated,skipped,errors}}
export async function exportUsersCsv(){const rows=(await db().query(`SELECT ${allowedUserFields.join(',')} FROM approved_users ORDER BY id`)).rows;const esc=(v:any)=>v==null?'':/[",\n]/.test(String(v))?`"${String(v).replace(/"/g,'""')}"`:String(v);return USER_CSV_HEADER+'\n'+rows.map(r=>allowedUserFields.map(f=>esc(r[f])).join(',')).join('\n')+'\n'}
const groupColumns=["group_name","group_id","status","monitoring_enabled","concierge_enabled","categories","country","timezone","member_count","notes","platform","monitor_fs","monitor_wtb","push_enabled","allow_fs","allow_wtb","priority","category","source_account","fi_is_member","accessible","last_verified_at"] as const;
function groupValues(input:any):any[]{
  return [
    input.group_name,
    String(input.group_id),
    input.status||'active',
    !!input.monitoring_enabled,
    !!input.concierge_enabled,
    Array.isArray(input.categories)?input.categories:String(input.categories||'').split(',').filter(Boolean),
    input.country||null,
    input.timezone||null,
    input.member_count?Number(input.member_count):null,
    input.notes||null,
    input.platform==='telegram'?'telegram':'whatsapp',
    input.monitor_fs!==false,
    input.monitor_wtb!==false,
    !!input.push_enabled,
    input.allow_fs!==false,
    input.allow_wtb!==false,
    input.priority!=null&&input.priority!==''?Number(input.priority):100,
    input.category||null,
    input.source_account||null,
    input.fi_is_member===true?true:input.fi_is_member===false?false:null,
    input.accessible!==false,
    input.last_verified_at||null,
  ];
}
export async function listGroups(q="",status=""){const vals:any[]=[];let w="WHERE 1=1";if(q){vals.push(`%${q}%`);w+=` AND (group_name ILIKE $${vals.length} OR group_id ILIKE $${vals.length})`}if(status){vals.push(status);w+=` AND status=$${vals.length}`}return(await db().query(`SELECT * FROM approved_groups ${w} ORDER BY group_name`,vals)).rows}
/**
 * Manual add/edit, CSV import, and (a later phase's) Whapi sync all funnel through this one
 * function -- the single validation/write path the unified Group Registry requires. Editing an
 * already-loaded row (an `id` given) updates that exact row by primary key. Adding one without an
 * `id` upserts by (platform, group_id) instead: entering a group_id that already exists loads and
 * updates that existing record rather than raising a duplicate-key error or creating a second row.
 */
export async function saveGroup(actor:Administrator,input:any,id?:number){
  if(!input.group_name||!input.group_id||input.group_id==='*')throw new Error("group name and a specific group ID are required");
  const vals=groupValues(input);
  let row;
  if(id){
    vals.push(id);
    row=(await db().query(`UPDATE approved_groups SET ${groupColumns.map((c,i)=>`${c}=$${i+1}`).join(',')},updated_at=now() WHERE id=$${vals.length} RETURNING *`,vals)).rows[0];
    if(!row)throw new Error("group not found");
  }else{
    row=(await db().query(
      `INSERT INTO approved_groups(${groupColumns.join(',')}) VALUES(${vals.map((_,i)=>`$${i+1}`).join(',')})
       ON CONFLICT (platform, group_id) DO UPDATE SET ${groupColumns.filter(c=>c!=='group_id').map(c=>`${c}=EXCLUDED.${c}`).join(',')},updated_at=now()
       RETURNING *`,
      vals
    )).rows[0];
  }
  await audit(actor,id?"group.updated":"group.created","approved_group",String(row.id));
  return row;
}
/** Delete is destructive and unrecoverable -- `confirmed` must be explicitly true (the admin UI
 *  only sends it after its own confirm() dialog), never inferred from the request merely
 *  reaching this far, so a scripted/accidental call without confirmation is rejected server-side
 *  too rather than trusting the client alone. */
export async function deleteGroup(actor:Administrator,id:number,confirmed:boolean){
  if(!confirmed)throw new Error("delete requires explicit confirmation");
  await db().query("DELETE FROM approved_groups WHERE id=$1",[id]);
  await audit(actor,"group.deleted","approved_group",String(id));
}
export async function isApprovedMonitoringGroup(chatId:string,type?:"FS"|"WTB"){if(chatId==='*')return false;await initAdminSchema();const r=await db().query("SELECT EXISTS(SELECT 1 FROM approved_groups WHERE group_id=$1 AND status='active' AND monitoring_enabled AND ($2::text IS NULL OR $2='FS' AND monitor_fs OR $2='WTB' AND monitor_wtb)) ok",[chatId,type??null]);return Boolean(r.rows[0].ok)}
export async function hasDatabaseGroupAllowlist(){await initAdminSchema();const r=await db().query("SELECT EXISTS(SELECT 1 FROM approved_groups) ok");return Boolean(r.rows[0].ok)}
export interface PushEligibleGroup { group_id:string; group_name:string; platform:"whatsapp"|"telegram"; allow_fs:boolean; allow_wtb:boolean; priority:number }
/** The real push-routing gate (see postings/listingConfig.ts's eligiblePushGroups) -- reads from
 *  the SAME unified registry manual entries and CSV imports write to, so there is exactly one
 *  place that decides where a confirmed listing gets pushed. */
export async function listActivePushEligibleGroups(type:"FS"|"WTB"):Promise<PushEligibleGroup[]>{
  await initAdminSchema();
  const column=type==="FS"?"allow_fs":"allow_wtb";
  const r=await db().query(`SELECT group_id,group_name,platform,allow_fs,allow_wtb,priority FROM approved_groups WHERE status='active' AND push_enabled AND ${column} ORDER BY priority,group_name`);
  return r.rows;
}
/** Records the outcome of one push attempt against the group it was sent to -- "show last push
 *  result where available" (real reported ask). group_id alone (platform not always known at
 *  the call site) is precise enough in practice; a WhatsApp/Telegram id collision is vanishingly
 *  unlikely given how differently the two platforms shape their ids. */
export async function recordGroupPushResult(groupId:string,status:"posted"|"failed",result?:string):Promise<void>{
  await db().query("UPDATE approved_groups SET last_push_at=now(),last_push_result=$2 WHERE group_id=$1",[groupId,status==="posted"?"posted":`failed: ${result??"unknown error"}`]);
}
/** Records that Fi actually saw a new inbound message from this group -- "show last message
 *  seen / last ingestion" (real reported ask). Best-effort: called from the group-monitoring
 *  ingestion path (conversation/groupMonitor.ts) and must never itself block or fail ingestion. */
export async function recordGroupIngestion(chatId:string,ok:boolean,error?:string):Promise<void>{
  await db().query(
    "UPDATE approved_groups SET last_message_at=now(),last_successful_ingest_at=CASE WHEN $2 THEN now() ELSE last_successful_ingest_at END,ingestion_status=CASE WHEN $2 THEN 'ok' ELSE 'error' END,ingestion_error=$3 WHERE group_id=$1",
    [chatId,ok,ok?null:error??"unknown error"]
  );
}
/** Recomputes the canonical row's summary accessible flag from every linked account's own
 *  access record -- true the moment ANY account can currently reach it, so one account losing
 *  access never falsely reads as the group being gone entirely while another still sees it. */
async function recomputeGroupAccessibility(approvedGroupId:number):Promise<void>{
  await db().query(
    `UPDATE approved_groups SET accessible=EXISTS(SELECT 1 FROM group_account_access WHERE approved_group_id=$1 AND accessible=true), updated_at=now() WHERE id=$1`,
    [approvedGroupId]
  );
}
/** Records (or updates) one account's ability to reach this group, then recomputes the
 *  canonical summary flag -- see the group_account_access table comment (multiple Whapi-
 *  connected numbers can each report accessibility for the SAME logical group). */
export async function recordGroupAccountAccess(approvedGroupId:number,sourceAccount:string,accessible:boolean,lastVerifiedAt:string):Promise<void>{
  await db().query(
    `INSERT INTO group_account_access(approved_group_id,source_account,accessible,last_verified_at)
     VALUES($1,$2,$3,$4)
     ON CONFLICT (approved_group_id,source_account) DO UPDATE SET accessible=EXCLUDED.accessible,last_verified_at=EXCLUDED.last_verified_at,updated_at=now()`,
    [approvedGroupId,sourceAccount,accessible,lastVerifiedAt]
  );
  await recomputeGroupAccessibility(approvedGroupId);
}
/**
 * Whapi-discovery upsert -- creates a KNOWN, accessible-via-this-account row for a newly-seen
 * group, or updates an already-known one's name/last_verified_at/access WITHOUT ever touching
 * its monitor/push settings: discovery only ever advises that a group exists and is currently
 * reachable, it never opts a group into monitoring or pushing on its own (real reported
 * requirement). The FIRST account to discover a group keeps the canonical row's summary
 * source_account label; every account's own access is still tracked precisely in
 * group_account_access regardless.
 */
export async function upsertGroupFromWhapiDiscovery(input:{groupId:string;groupName:string;platform:"whatsapp"|"telegram";sourceAccount:string;lastVerifiedAt:string}):Promise<{id:number;created:boolean}>{
  await initAdminSchema();
  const r=await db().query(
    `INSERT INTO approved_groups(group_name,group_id,platform,source_account,fi_is_member,last_verified_at)
     VALUES($1,$2,$3,$4,true,$5)
     ON CONFLICT (platform, group_id) DO UPDATE SET
       group_name=CASE WHEN EXCLUDED.group_name<>'' THEN EXCLUDED.group_name ELSE approved_groups.group_name END,
       source_account=COALESCE(approved_groups.source_account,EXCLUDED.source_account),
       fi_is_member=true, last_verified_at=EXCLUDED.last_verified_at, updated_at=now()
     RETURNING id, (xmax = 0) AS inserted`,
    [input.groupName,input.groupId,input.platform,input.sourceAccount,input.lastVerifiedAt]
  );
  const id=Number(r.rows[0].id);
  await recordGroupAccountAccess(id,input.sourceAccount,true,input.lastVerifiedAt);
  return { id, created: Boolean(r.rows[0].inserted) };
}
/**
 * A later Whapi sync for this account no longer reports these WhatsApp group ids as accessible
 * -- marks only THIS account's access row false (never deletes, never touches monitor/push
 * settings, and never downgrades a group still reachable through a DIFFERENT account) and
 * recomputes each affected group's summary accessible flag. "Groups that disappear from a
 * later sync must NOT be deleted... mark them inaccessible/unverified" (real reported
 * requirement) -- history and configuration are preserved for if access returns.
 */
export async function markGroupsInaccessibleForAccount(sourceAccount:string,stillAccessibleGroupIds:string[]):Promise<number>{
  await initAdminSchema();
  const affected=await db().query(
    `SELECT gaa.id AS access_id, ag.id AS group_id
     FROM group_account_access gaa JOIN approved_groups ag ON ag.id=gaa.approved_group_id
     WHERE gaa.source_account=$1 AND gaa.accessible=true AND ag.platform='whatsapp' AND NOT (ag.group_id = ANY($2::text[]))`,
    [sourceAccount,stillAccessibleGroupIds]
  );
  if(affected.rows.length===0)return 0;
  await db().query(`UPDATE group_account_access SET accessible=false, updated_at=now() WHERE id=ANY($1::bigint[])`,[affected.rows.map((r:any)=>r.access_id)]);
  for(const row of affected.rows) await recomputeGroupAccessibility(Number(row.group_id));
  return affected.rows.length;
}
export type GroupBulkAction="enable_monitoring"|"disable_monitoring"|"enable_push_fs"|"enable_push_wtb"|"disable_push"|"set_priority"|"set_category";
/**
 * Bulk admin actions (real reported requirement: "Select All, Enable Monitoring, Disable
 * Monitoring, Enable Push FS, Enable Push WTB, Disable Push, Set Priority, Set Category") --
 * every action still goes through this one function, never a separate ad hoc query, so bulk
 * edits stay auditable exactly like a single manual save.
 */
export async function bulkUpdateGroups(actor:Administrator,ids:number[],action:GroupBulkAction,value?:unknown):Promise<number>{
  const cleanIds=ids.map(Number).filter(Number.isInteger);
  if(cleanIds.length===0)return 0;
  let sql:string,params:any[];
  switch(action){
    case "enable_monitoring": sql=`UPDATE approved_groups SET monitoring_enabled=true, updated_at=now() WHERE id=ANY($1::bigint[])`; params=[cleanIds]; break;
    case "disable_monitoring": sql=`UPDATE approved_groups SET monitoring_enabled=false, updated_at=now() WHERE id=ANY($1::bigint[])`; params=[cleanIds]; break;
    case "enable_push_fs": sql=`UPDATE approved_groups SET push_enabled=true, allow_fs=true, updated_at=now() WHERE id=ANY($1::bigint[])`; params=[cleanIds]; break;
    case "enable_push_wtb": sql=`UPDATE approved_groups SET push_enabled=true, allow_wtb=true, updated_at=now() WHERE id=ANY($1::bigint[])`; params=[cleanIds]; break;
    case "disable_push": sql=`UPDATE approved_groups SET push_enabled=false, updated_at=now() WHERE id=ANY($1::bigint[])`; params=[cleanIds]; break;
    case "set_priority": {
      const p=Number(value);
      if(!Number.isFinite(p))throw new Error("priority must be a number");
      sql=`UPDATE approved_groups SET priority=$2, updated_at=now() WHERE id=ANY($1::bigint[])`; params=[cleanIds,p];
      break;
    }
    case "set_category": sql=`UPDATE approved_groups SET category=$2, updated_at=now() WHERE id=ANY($1::bigint[])`; params=[cleanIds,String(value??"").trim()||null]; break;
    default: throw new Error(`unknown bulk action: ${action}`);
  }
  const r=await db().query(sql,params);
  await audit(actor,`group.bulk_${action}`,"approved_group",undefined,{ids:cleanIds,value});
  return r.rowCount??0;
}
export interface GroupRegistryMetrics {
  known:number; accessibleViaWhapi:number; monitoringEnabled:number; pushEnabled:number;
  missingOrInaccessible:number; lastSeenUnder24h:number; noActivityOver7d:number;
}
/** Reconciliation metrics for the admin dashboard (real reported requirement) -- distinguishes
 *  KNOWN (a row exists at all) from ACCESSIBLE (currently reachable via Whapi) from
 *  MONITORING/PUSH enabled, exactly like isApprovedMonitoringGroup's own module comment insists
 *  on never conflating these states. */
export async function getGroupRegistryMetrics():Promise<GroupRegistryMetrics>{
  await initAdminSchema();
  const r=await db().query(`
    SELECT
      count(*)::int AS known,
      count(*) FILTER (WHERE accessible)::int AS accessible,
      count(*) FILTER (WHERE monitoring_enabled)::int AS monitoring_enabled,
      count(*) FILTER (WHERE push_enabled)::int AS push_enabled,
      count(*) FILTER (WHERE NOT accessible)::int AS missing,
      count(*) FILTER (WHERE last_message_at >= now() - interval '24 hours')::int AS seen_24h,
      count(*) FILTER (WHERE status='active' AND (last_message_at IS NULL OR last_message_at < now() - interval '7 days'))::int AS no_activity_7d
    FROM approved_groups
  `);
  const row=r.rows[0];
  return {
    known:row.known, accessibleViaWhapi:row.accessible, monitoringEnabled:row.monitoring_enabled,
    pushEnabled:row.push_enabled, missingOrInaccessible:row.missing, lastSeenUnder24h:row.seen_24h,
    noActivityOver7d:row.no_activity_7d,
  };
}
export async function isPostingMonitoringEnabled(posting:{source_type:string;source_chat_id:string|null;type?:"FS"|"WTB"}){
  if(posting.source_type!=="chat")return true;
  if(!posting.source_chat_id||!config.postingsV4.enabled)return false;
  return await hasDatabaseGroupAllowlist()
    ? isApprovedMonitoringGroup(posting.source_chat_id,posting.type)
    : config.postingsV4.allowedChatIds.includes(posting.source_chat_id)
      || (process.env.NODE_ENV !== "production" && config.postingsV4.allowedChatIds.includes("*"));
}
/** Test-only: releases the admin pool so a test process can exit promptly. */
export async function _closePoolForTests():Promise<void>{await pool?.end();pool=null;adminSchemaReady=null}
