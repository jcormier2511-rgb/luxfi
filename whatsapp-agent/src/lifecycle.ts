import { sendText } from "./channels";
import { platformForIdentity } from "./channels/identity";
import { getOrCreateCanonicalUser } from "./postings/identity";
import { PostingRow } from "./postings/postingsStore";
import { scoreMatchWithCurrency } from "./postings/matching";
import { withSchema } from "./postings/db";
import { initAdminSchema } from "./admin/store";
import { getState } from "./conversation/stateStore";

export type LifecycleSettings = {
  morningEnabled:boolean; morningHour:number; defaultTimezone:string; maxPostings:number;
  dormantEnabled:boolean; dormantAfterDays:number; dormantRepeatDays:number; dormantHour:number; dormantTemplate:string;
};

export function localClock(at:Date, timezone:string):{date:string;hour:number} {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone:timezone, year:"numeric", month:"2-digit", day:"2-digit", hour:"2-digit", hourCycle:"h23" }).formatToParts(at);
  const get=(type:string)=>parts.find(p=>p.type===type)!.value;
  return { date:`${get("year")}-${get("month")}-${get("day")}`, hour:Number(get("hour")) };
}

export async function getLifecycleSettings():Promise<LifecycleSettings> {
  return withSchema(async db => {
    const rows=(await db.query("SELECT key,value FROM lifecycle_settings")).rows;
    const v=Object.fromEntries(rows.map(r=>[r.key,r.value]));
    return { morningEnabled:v.MORNING_BRIEFING_ENABLED==="true", morningHour:Number(v.MORNING_BRIEFING_LOCAL_HOUR), defaultTimezone:v.MORNING_BRIEFING_DEFAULT_TIMEZONE,
      maxPostings:Number(v.MORNING_BRIEFING_MAX_POSTINGS), dormantEnabled:v.DORMANT_REENGAGEMENT_ENABLED==="true", dormantAfterDays:Number(v.DORMANT_AFTER_DAYS),
      dormantRepeatDays:Number(v.DORMANT_REPEAT_DAYS), dormantHour:Number(v.DORMANT_LOCAL_SEND_HOUR), dormantTemplate:v.DORMANT_MESSAGE_TEMPLATE };
  });
}

export async function setLifecycleSettings(values:Record<string,string>):Promise<void> {
  const allowed=new Set(["MORNING_BRIEFING_ENABLED","MORNING_BRIEFING_LOCAL_HOUR","MORNING_BRIEFING_DEFAULT_TIMEZONE","MORNING_BRIEFING_MAX_POSTINGS","DORMANT_REENGAGEMENT_ENABLED","DORMANT_AFTER_DAYS","DORMANT_REPEAT_DAYS","DORMANT_LOCAL_SEND_HOUR","DORMANT_MESSAGE_TEMPLATE"]);
  await withSchema(async db=>{ for(const [key,value] of Object.entries(values)){ if(!allowed.has(key)) throw new Error(`unsupported lifecycle setting: ${key}`); await db.query("INSERT INTO lifecycle_settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=now()",[key,String(value)]); } });
}

/** Call only for provider-originated user events. Automated sendText calls never touch this state. */
export async function recordInboundActivity(identity:string, firstName?:string, at=new Date(), direct=true):Promise<void> {
  const channel=platformForIdentity(identity);
  if(!["whatsapp","telegram"].includes(channel)) return;
  const userId=await getOrCreateCanonicalUser(channel,identity);
  await withSchema(db=>db.query(`INSERT INTO user_lifecycle(canonical_user_id,channel,identity,first_name,last_inbound_at,last_direct_inbound_at)
    VALUES($1,$2,$3,$4,$5::timestamptz,CASE WHEN $6::boolean THEN $7::timestamptz ELSE NULL::timestamptz END) ON CONFLICT(canonical_user_id) DO UPDATE SET channel=excluded.channel,identity=excluded.identity,
    first_name=COALESCE(excluded.first_name,user_lifecycle.first_name),last_inbound_at=GREATEST(user_lifecycle.last_inbound_at,excluded.last_inbound_at),
    last_direct_inbound_at=CASE WHEN $6::boolean THEN GREATEST(COALESCE(user_lifecycle.last_direct_inbound_at,excluded.last_inbound_at),excluded.last_inbound_at) ELSE user_lifecycle.last_direct_inbound_at END,updated_at=now()`,[userId,channel,identity,firstName?.trim().split(/\s+/)[0]||null,at,direct,at]));
}

async function claim(userId:number,kind:"morning_briefing"|"dormant",date:string):Promise<boolean>{
  return withSchema(async db=>(await db.query(`INSERT INTO lifecycle_deliveries(canonical_user_id,kind,local_date,status) VALUES($1,$2,$3,'sending')
    ON CONFLICT(canonical_user_id,kind,local_date) DO UPDATE SET status='sending',claimed_at=now(),error=NULL
    WHERE lifecycle_deliveries.status='failed' OR (lifecycle_deliveries.status='sending' AND lifecycle_deliveries.claimed_at<now()-interval '30 minutes') RETURNING id`,[userId,kind,date])).rowCount===1);
}
async function finish(userId:number,kind:string,date:string,error?:unknown){ await withSchema(db=>db.query(`UPDATE lifecycle_deliveries SET status=$4,delivered_at=CASE WHEN $4='delivered' THEN now() END,error=$5 WHERE canonical_user_id=$1 AND kind=$2 AND local_date=$3`,[userId,kind,date,error?"failed":"delivered",error?String(error):null])); }

async function currentMatches(posting:PostingRow, all:PostingRow[]):Promise<number[]> {
  const ids:number[]=[];
  for(const other of all) {
    if(other.type===posting.type || (posting.canonical_user_id!==null && other.canonical_user_id===posting.canonical_user_id)) continue;
    const [fs,wtb]=posting.type==="FS"?[posting,other]:[other,posting];
    if(await scoreMatchWithCurrency(fs,wtb)) ids.push(other.id);
  }
  return [...new Set(ids)];
}
function title(p:PostingRow){ return [p.type,"—",p.brand,p.model,p.reference,p.dial].filter(Boolean).join(" "); }
export function formatBriefing(firstName:string|null, summaries:{posting:PostingRow;count:number;newCount:number;hasPrior:boolean}[], omitted=0):string {
  const greeting=`Good morning${firstName?`, ${firstName}`:""}. Here’s your Fi update:`;
  const blocks=summaries.map(({posting:p,count,newCount,hasPrior})=>`${title(p)}\n${count===0?"No active matches yet.":`${count} active ${p.type==="WTB"?"sellers":"buyers"} currently match your ${p.type==="WTB"?"request":"listing"}${hasPrior&&newCount>0?`\n+${newCount} new since yesterday`:""}`}`);
  if(omitted) blocks.push(`Plus ${omitted} more active task${omitted===1?"":"s"} I’m monitoring.`);
  return `${greeting}\n\n${blocks.join("\n\n")}\n\n${summaries.some(s=>s.count)?"I’ll keep working 24/7 and let you know when I find strong new opportunities.":"I’m still monitoring for you."}`;
}

export async function runMorningBriefings(now=new Date()):Promise<{sent:number;skipped:number}> {
  const s=await getLifecycleSettings(); if(!s.morningEnabled)return{sent:0,skipped:0}; let sent=0,skipped=0;
  const users=await withSchema(db=>db.query(`SELECT l.*,COALESCE(l.timezone,$1) effective_timezone FROM user_lifecycle l WHERE l.channel IN ('whatsapp','telegram')`,[s.defaultTimezone]));
  for(const user of users.rows){ let clock; try{clock=localClock(now,user.effective_timezone);}catch{clock=localClock(now,s.defaultTimezone);} if(clock.hour!==s.morningHour){skipped++;continue;}
    const postings=await withSchema(db=>db.query<PostingRow>("SELECT * FROM postings WHERE canonical_user_id=$1 AND status='active' AND expires_at>$2 ORDER BY created_at LIMIT $3",[user.canonical_user_id,now,s.maxPostings+1]));
    if(!postings.rowCount){skipped++;continue;} if(!await claim(user.canonical_user_id,"morning_briefing",clock.date)){skipped++;continue;}
    try{ const all=(await withSchema(db=>db.query<PostingRow>("SELECT * FROM postings WHERE status='active' AND expires_at>$1",[now]))).rows; const summaries=[];
      for(const posting of postings.rows.slice(0,s.maxPostings)){const ids=await currentMatches(posting,all);const prior=(await withSchema(db=>db.query("SELECT known_match_ids FROM briefing_posting_state WHERE canonical_user_id=$1 AND posting_id=$2",[user.canonical_user_id,posting.id]))).rows[0];const known:number[]=prior?.known_match_ids??[];summaries.push({posting,count:ids.length,newCount:ids.filter(id=>!known.includes(id)).length,hasPrior:Boolean(prior)});await withSchema(db=>db.query(`INSERT INTO briefing_posting_state VALUES($1,$2,$3,$4,$4) ON CONFLICT(canonical_user_id,posting_id) DO UPDATE SET last_briefing_at=excluded.last_briefing_at,current_match_ids=excluded.current_match_ids,known_match_ids=(SELECT ARRAY(SELECT DISTINCT unnest(briefing_posting_state.known_match_ids||excluded.current_match_ids)))`,[user.canonical_user_id,posting.id,now,ids]));}
      await sendText(user.identity,formatBriefing(user.first_name,summaries,Math.max(0,postings.rows.length-s.maxPostings)));await finish(user.canonical_user_id,"morning_briefing",clock.date);sent++;
    }catch(e){await finish(user.canonical_user_id,"morning_briefing",clock.date,e);}
  } return{sent,skipped};
}

export function formatDormant(template:string,firstName:string|null){return firstName?template.replace(/{{first_name}}/g,firstName):template.replace(/Hi\s*{{first_name}},?/g,"Hi,").replace(/{{first_name}}/g,"");}
export async function runDormantReengagement(now=new Date()):Promise<{sent:number;skipped:number}>{
  const s=await getLifecycleSettings();if(!s.dormantEnabled)return{sent:0,skipped:0};await initAdminSchema();let sent=0,skipped=0;
  const users=await withSchema(db=>db.query(`SELECT l.*,COALESCE(l.timezone,$1) effective_timezone,u.access_status,u.opt_in_status FROM user_lifecycle l LEFT JOIN approved_users u ON regexp_replace(u.phone,'[^0-9]','','g')=regexp_replace(l.identity,'[^0-9]','','g') WHERE l.channel IN ('whatsapp','telegram')`,[s.defaultTimezone]));
  for(const u of users.rows){let clock;try{clock=localClock(now,u.effective_timezone)}catch{clock=localClock(now,s.defaultTimezone)};const inactive=now.getTime()-new Date(u.last_inbound_at).getTime();const repeat=u.last_dormant_message_at&&now.getTime()-new Date(u.last_dormant_message_at).getTime()<s.dormantRepeatDays*86400000;
    const disallowed=["blocked","inactive"].includes(u.access_status)||u.opt_in_status==="opted_out"||getState(u.identity).stage==="opted_out";if(clock.hour!==s.dormantHour||inactive<s.dormantAfterDays*86400000||repeat||disallowed){skipped++;continue;}
    const briefing=(await withSchema(db=>db.query("SELECT 1 FROM lifecycle_deliveries WHERE canonical_user_id=$1 AND kind='morning_briefing' AND local_date=$2 AND status IN ('sending','delivered')",[u.canonical_user_id,clock.date]))).rowCount;if(briefing||!await claim(u.canonical_user_id,"dormant",clock.date)){skipped++;continue;}
    try{await sendText(u.identity,formatDormant(s.dormantTemplate,u.first_name));await withSchema(db=>db.query("UPDATE user_lifecycle SET last_dormant_message_at=$2 WHERE canonical_user_id=$1",[u.canonical_user_id,now]));await finish(u.canonical_user_id,"dormant",clock.date);sent++;}catch(e){await finish(u.canonical_user_id,"dormant",clock.date,e);}
  }return{sent,skipped};
}

export async function runLifecycleScheduler(now=new Date()){const morning=await runMorningBriefings(now);const dormant=await runDormantReengagement(now);return{morning,dormant};}
