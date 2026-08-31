import crypto from "crypto";
import fs from "fs";
import bcrypt from "bcryptjs";
import { Pool } from "pg";
import { parse } from "csv-parse/sync";
import { config } from "../config";

export type AdminRole = "owner" | "administrator" | "support" | "read_only";
export interface Administrator { id:number; name:string; username:string; email:string; role:AdminRole; status:"active"|"inactive"; last_login_at:string|null; created_at:string; updated_at:string }
export const USER_CSV_HEADER = "phone,name,company,email,tier,specialty,wf_profile_id,membership_status,subscription_status,access_status,trial_limit,complimentary_access,opt_in_status,opt_in_source,notes";
export const USER_CSV_SAMPLE = `${USER_CSV_HEADER}\n13055551234,Marco D.,Marco Watches,marco@example.com,A,watches,12345,active,trial,active,3,false,opted_in,manual_admin,Approved dealer\n`;

let pool: Pool | null = null;
let adminSchemaReady: Promise<void> | null = null;
const db = () => pool ??= new Pool({ connectionString: config.database.url });
// pg returns BIGSERIAL values as strings. Sessions require an integer administrator ID, so
// normalize it at the database boundary before signing it into the production session cookie.
const publicAdmin = (r:any): Administrator => ({ id:Number(r.id), name:r.name, username:r.username, email:r.email, role:r.role, status:r.status, last_login_at:r.last_login_at?.toISOString?.() ?? r.last_login_at, created_at:r.created_at?.toISOString?.() ?? r.created_at, updated_at:r.updated_at?.toISOString?.() ?? r.updated_at });
export function normalizePhone(value:string):string { const phone=value.replace(/[^0-9]/g,""); if (!/^[1-9][0-9]{7,14}$/.test(phone)) throw new Error("phone must contain 8-15 digits including country code"); return phone; }
export async function hashPassword(password:string):Promise<string> { if(password.length<12) throw new Error("password must be at least 12 characters"); return bcrypt.hash(password,12); }

async function createAdminSchema():Promise<void> {
  await db().query(`
    CREATE TABLE IF NOT EXISTS administrators (id BIGSERIAL PRIMARY KEY,name TEXT NOT NULL,username TEXT NOT NULL,email TEXT NOT NULL,password_hash TEXT NOT NULL,role TEXT NOT NULL CHECK(role IN ('owner','administrator','support','read_only')),status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','inactive')),last_login_at TIMESTAMPTZ,created_at TIMESTAMPTZ NOT NULL DEFAULT now(),updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
    CREATE UNIQUE INDEX IF NOT EXISTS administrators_username_ci ON administrators(lower(username)); CREATE UNIQUE INDEX IF NOT EXISTS administrators_email_ci ON administrators(lower(email));
    CREATE TABLE IF NOT EXISTS admin_audit_log (id BIGSERIAL PRIMARY KEY,administrator_id BIGINT REFERENCES administrators(id) ON DELETE SET NULL,administrator_label TEXT NOT NULL,action TEXT NOT NULL,target_type TEXT NOT NULL,target_id TEXT,metadata JSONB NOT NULL DEFAULT '{}',created_at TIMESTAMPTZ NOT NULL DEFAULT now());
    CREATE TABLE IF NOT EXISTS admin_login_attempts (id BIGSERIAL PRIMARY KEY,identifier_hash TEXT NOT NULL,ip_hash TEXT NOT NULL,succeeded BOOLEAN NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT now()); CREATE INDEX IF NOT EXISTS admin_login_attempts_recent ON admin_login_attempts(identifier_hash,ip_hash,created_at);
    CREATE TABLE IF NOT EXISTS approved_users (id BIGSERIAL PRIMARY KEY,phone TEXT NOT NULL UNIQUE,name TEXT NOT NULL,company TEXT,email TEXT,tier TEXT,specialty TEXT,wf_profile_id TEXT,membership_status TEXT,subscription_status TEXT,access_status TEXT NOT NULL DEFAULT 'active' CHECK(access_status IN ('active','inactive','blocked')),trial_limit INTEGER NOT NULL DEFAULT 3 CHECK(trial_limit>=0),trial_approvals_used INTEGER NOT NULL DEFAULT 0 CHECK(trial_approvals_used>=0),complimentary_access BOOLEAN NOT NULL DEFAULT false,opt_in_status TEXT,opt_in_source TEXT,opt_in_at TIMESTAMPTZ,last_interaction_at TIMESTAMPTZ,notes TEXT,created_at TIMESTAMPTZ NOT NULL DEFAULT now(),updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
    CREATE TABLE IF NOT EXISTS approved_groups (id BIGSERIAL PRIMARY KEY,group_name TEXT NOT NULL,whatsapp_chat_id TEXT NOT NULL UNIQUE,status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','inactive')),monitoring_enabled BOOLEAN NOT NULL DEFAULT false,concierge_enabled BOOLEAN NOT NULL DEFAULT false,categories TEXT[] NOT NULL DEFAULT '{}',country TEXT,timezone TEXT,last_message_at TIMESTAMPTZ,last_posting_at TIMESTAMPTZ,member_count INTEGER CHECK(member_count>=0),notes TEXT,created_at TIMESTAMPTZ NOT NULL DEFAULT now(),updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
  `);
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
export async function authenticate(username:string,password:string,ip:string):Promise<{admin?:Administrator;limited?:boolean}>{ const ih=crypto.createHash("sha256").update(username.toLowerCase()).digest("hex"), ph=crypto.createHash("sha256").update(ip).digest("hex"); const recent=Number((await db().query("SELECT count(*) n FROM admin_login_attempts WHERE identifier_hash=$1 AND ip_hash=$2 AND NOT succeeded AND created_at>now()-interval '15 minutes'",[ih,ph])).rows[0].n); if(recent>=5)return{limited:true}; const r=await db().query("SELECT * FROM administrators WHERE lower(username)=lower($1)",[username]); const row=r.rows[0]; const ok=Boolean(row&&row.status==='active'&&await bcrypt.compare(password,row.password_hash)); await db().query("INSERT INTO admin_login_attempts(identifier_hash,ip_hash,succeeded) VALUES($1,$2,$3)",[ih,ph,ok]); const admin=ok?publicAdmin(row):null; await audit(admin,ok?"administrator.login_success":"administrator.login_failure","session",undefined,{username,ipHash:ph}); if(!admin)return{}; await db().query("UPDATE administrators SET last_login_at=now() WHERE id=$1",[admin.id]); return{admin}; }
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
export async function listUsers(q="",status="",page=1,limit=25){const values:any[]=[];let where="WHERE 1=1";if(q){values.push(`%${q}%`);where+=` AND (phone ILIKE $${values.length} OR name ILIKE $${values.length} OR company ILIKE $${values.length})`;}if(status){values.push(status);where+=` AND access_status=$${values.length}`;}values.push(limit,(page-1)*limit);const rows=(await db().query(`SELECT * FROM approved_users ${where} ORDER BY created_at DESC LIMIT $${values.length-1} OFFSET $${values.length}`,values)).rows;const count=Number((await db().query(`SELECT count(*) n FROM approved_users ${where}`,values.slice(0,-2))).rows[0].n);return{rows,count,page,limit}}
export async function saveUser(actor:Administrator,input:any,id?:number){const phone=normalizePhone(String(input.phone));if(!String(input.name??"").trim())throw new Error("name required");const values=allowedUserFields.map(f=>f==='phone'?phone:f==='trial_limit'?Number(input[f]??3):f==='complimentary_access'?input[f]===true||input[f]==='true':input[f]||null);let row;if(id){values.push(id);row=(await db().query(`UPDATE approved_users SET ${allowedUserFields.map((f,i)=>`${f}=$${i+1}`).join(',')},updated_at=now() WHERE id=$${values.length} RETURNING *`,values)).rows[0]}else row=(await db().query(`INSERT INTO approved_users(${allowedUserFields.join(',')}) VALUES(${values.map((_,i)=>`$${i+1}`).join(',')}) RETURNING *`,values)).rows[0];await audit(actor,id?"user.updated":"user.created","approved_user",String(row.id));return row}
export async function deleteUser(actor:Administrator,id:number){await db().query("DELETE FROM approved_users WHERE id=$1",[id]);await audit(actor,"user.deleted","approved_user",String(id))}
export async function importUsersCsv(actor:Administrator,csv:string){const rows=parse(csv,{columns:true,skip_empty_lines:true,trim:true}) as any[];let added=0,updated=0,skipped=0;const errors:any[]=[];for(let i=0;i<rows.length;i++){try{const raw=rows[i],phone=normalizePhone(raw.phone||"");if(!raw.name)throw new Error("name required");const existing=(await db().query("SELECT * FROM approved_users WHERE phone=$1",[phone])).rows[0];if(existing){const patch:any={...existing};for(const f of allowedUserFields)if(raw[f]!==undefined&&raw[f]!=="")patch[f]=raw[f];await saveUser(actor,patch,existing.id);updated++;}else{await saveUser(actor,{...raw,phone},undefined);added++;}}catch(e){errors.push({row:i+2,error:(e as Error).message});}}await audit(actor,"users.csv_import","approved_user",undefined,{added,updated,skipped,errorCount:errors.length});return{added,updated,skipped,errors}}
export async function exportUsersCsv(){const rows=(await db().query(`SELECT ${allowedUserFields.join(',')} FROM approved_users ORDER BY id`)).rows;const esc=(v:any)=>v==null?'':/[",\n]/.test(String(v))?`"${String(v).replace(/"/g,'""')}"`:String(v);return USER_CSV_HEADER+'\n'+rows.map(r=>allowedUserFields.map(f=>esc(r[f])).join(',')).join('\n')+'\n'}
export async function listGroups(q="",status=""){const vals:any[]=[];let w="WHERE 1=1";if(q){vals.push(`%${q}%`);w+=` AND (group_name ILIKE $${vals.length} OR whatsapp_chat_id ILIKE $${vals.length})`}if(status){vals.push(status);w+=` AND status=$${vals.length}`}return(await db().query(`SELECT * FROM approved_groups ${w} ORDER BY group_name`,vals)).rows}
export async function saveGroup(actor:Administrator,input:any,id?:number){if(!input.group_name||!input.whatsapp_chat_id||input.whatsapp_chat_id==='*')throw new Error("group name and a specific group ID are required");const vals=[input.group_name,input.whatsapp_chat_id,input.status||'active',!!input.monitoring_enabled,!!input.concierge_enabled,Array.isArray(input.categories)?input.categories:String(input.categories||'').split(',').filter(Boolean),input.country||null,input.timezone||null,input.member_count?Number(input.member_count):null,input.notes||null];let row;if(id){vals.push(id);row=(await db().query("UPDATE approved_groups SET group_name=$1,whatsapp_chat_id=$2,status=$3,monitoring_enabled=$4,concierge_enabled=$5,categories=$6,country=$7,timezone=$8,member_count=$9,notes=$10,updated_at=now() WHERE id=$11 RETURNING *",vals)).rows[0]}else row=(await db().query("INSERT INTO approved_groups(group_name,whatsapp_chat_id,status,monitoring_enabled,concierge_enabled,categories,country,timezone,member_count,notes) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *",vals)).rows[0];await audit(actor,id?"group.updated":"group.created","approved_group",String(row.id));return row}
export async function deleteGroup(actor:Administrator,id:number){await db().query("DELETE FROM approved_groups WHERE id=$1",[id]);await audit(actor,"group.deleted","approved_group",String(id))}
export async function isApprovedMonitoringGroup(chatId:string){if(chatId==='*')return false;await initAdminSchema();const r=await db().query("SELECT EXISTS(SELECT 1 FROM approved_groups WHERE whatsapp_chat_id=$1 AND status='active' AND monitoring_enabled) ok",[chatId]);return Boolean(r.rows[0].ok)}
export async function hasDatabaseGroupAllowlist(){await initAdminSchema();const r=await db().query("SELECT EXISTS(SELECT 1 FROM approved_groups) ok");return Boolean(r.rows[0].ok)}
export async function isPostingMonitoringEnabled(posting:{source_type:string;source_chat_id:string|null}){
  if(posting.source_type!=="chat")return true;
  if(!posting.source_chat_id||!config.postingsV4.enabled)return false;
  return await hasDatabaseGroupAllowlist()
    ? isApprovedMonitoringGroup(posting.source_chat_id)
    : config.postingsV4.allowedChatIds.includes(posting.source_chat_id)
      || (process.env.NODE_ENV !== "production" && config.postingsV4.allowedChatIds.includes("*"));
}
