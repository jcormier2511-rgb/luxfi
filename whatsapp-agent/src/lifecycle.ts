import { sendText } from "./channels";
import { platformForIdentity } from "./channels/identity";
import { getOrCreateCanonicalUser } from "./postings/identity";
import { PostingRow } from "./postings/postingsStore";
import { scoreMatchWithCurrency } from "./postings/matching";
import { getMarketPulse } from "./postings/marketPulse";
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

/** "pause my morning updates for a day/week/month" (1day/1week/1month) or indefinitely. */
export type MorningBriefingPauseDuration = "1day" | "1week" | "1month" | "indefinite";

const PAUSE_DURATION_MS: Record<Exclude<MorningBriefingPauseDuration, "indefinite">, number> = {
  "1day": 24 * 60 * 60 * 1000,
  "1week": 7 * 24 * 60 * 60 * 1000,
  // A calendar month varies 28-31 days; 30 is a simple, predictable approximation rather than
  // real calendar-month arithmetic -- close enough for "leave me alone for about a month" and
  // never off by more than a day either way.
  "1month": 30 * 24 * 60 * 60 * 1000,
};

/** What getMorningBriefingPauseStatus/pauseMorningBriefing/resumeMorningBriefing operate on --
 *  an upsert so this also works before the user's first recordInboundActivity call (e.g. a
 *  direct unit test), though in real traffic that row already exists by the time any command
 *  reaches conversation/flow.ts (server.ts calls recordInboundActivity first on every message). */
async function upsertPauseColumns(identity: string, pausedUntil: Date | null, pausedIndefinitely: boolean): Promise<void> {
  const channel = platformForIdentity(identity);
  const userId = await getOrCreateCanonicalUser(channel, identity);
  await withSchema((db) =>
    db.query(
      `INSERT INTO user_lifecycle(canonical_user_id,channel,identity,last_inbound_at,morning_briefing_paused_until,morning_briefing_paused_indefinitely,updated_at)
       VALUES($1,$2,$3,now(),$4,$5,now())
       ON CONFLICT(canonical_user_id) DO UPDATE SET morning_briefing_paused_until=excluded.morning_briefing_paused_until,
         morning_briefing_paused_indefinitely=excluded.morning_briefing_paused_indefinitely,updated_at=now()`,
      [userId, channel, identity, pausedUntil, pausedIndefinitely]
    )
  );
}

/** Returns when the pause actually ends -- a concrete Date for a finite duration, or the literal
 *  string "indefinite" for indefinitely -- so the caller's confirmation message can state it. */
export async function pauseMorningBriefing(identity: string, duration: MorningBriefingPauseDuration, now = new Date()): Promise<Date | "indefinite"> {
  if (duration === "indefinite") {
    await upsertPauseColumns(identity, null, true);
    return "indefinite";
  }
  const until = new Date(now.getTime() + PAUSE_DURATION_MS[duration]);
  await upsertPauseColumns(identity, until, false);
  return until;
}

export async function resumeMorningBriefing(identity: string): Promise<void> {
  await upsertPauseColumns(identity, null, false);
}

/** null = not paused, "indefinite" = paused with no end date, a Date = paused until then (even
 *  one already in the past -- the caller decides what "expired" means; runMorningBriefings below
 *  treats it as no longer paused, same as this function's own callers should). */
export async function getMorningBriefingPauseStatus(identity: string): Promise<Date | "indefinite" | null> {
  const channel = platformForIdentity(identity);
  const userId = await getOrCreateCanonicalUser(channel, identity);
  const row = (
    await withSchema((db) =>
      db.query("SELECT morning_briefing_paused_until,morning_briefing_paused_indefinitely FROM user_lifecycle WHERE canonical_user_id=$1", [userId])
    )
  ).rows[0];
  if (!row) return null;
  if (row.morning_briefing_paused_indefinitely) return "indefinite";
  return row.morning_briefing_paused_until ? new Date(row.morning_briefing_paused_until) : null;
}

/** True when this user_lifecycle ROW (already SELECTed -- l.* -- by the two callers below) is
 *  currently paused. A pause with a past paused_until is no longer active, same rule
 *  getMorningBriefingPauseStatus's own callers apply. */
function isMorningBriefingPaused(user: { morning_briefing_paused_indefinitely: boolean; morning_briefing_paused_until: string | Date | null }, now: Date): boolean {
  if (user.morning_briefing_paused_indefinitely) return true;
  return Boolean(user.morning_briefing_paused_until && new Date(user.morning_briefing_paused_until) > now);
}

/**
 * True exactly once per identity: the first call ever made for a given identity claims it
 * (setting intro_sent_at) and returns true; every call after that returns false. A single
 * atomic upsert rather than a separate read-then-write -- two match notifications racing for
 * the same brand-new recipient (both sides of a match can resolve to the same person's OTHER
 * open posting) must never both see "not yet introduced" and both append the intro.
 *
 * Upserts the row rather than requiring one to already exist: recordInboundActivity normally
 * creates it first (server.ts calls it on every inbound message before anything else runs), but
 * a caller here should never depend on that ordering having already happened.
 */
export async function consumeFirstContact(identity: string): Promise<boolean> {
  const channel = platformForIdentity(identity);
  const userId = await getOrCreateCanonicalUser(channel, identity);
  const claimed = await withSchema((db) =>
    db.query(
      `INSERT INTO user_lifecycle(canonical_user_id,channel,identity,last_inbound_at,intro_sent_at)
       VALUES($1,$2,$3,now(),now())
       ON CONFLICT(canonical_user_id) DO UPDATE SET intro_sent_at=now()
         WHERE user_lifecycle.intro_sent_at IS NULL
       RETURNING canonical_user_id`,
      [userId, channel, identity]
    )
  );
  return claimed.rowCount === 1;
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
// The 🔍/🏷️ icon prefixed at each call site already says buy vs. sell -- repeating the word
// "WTB"/"FS" right next to it was redundant clutter, so this only names the watch itself now.
function title(p:PostingRow){ return [p.brand,p.model,p.reference,p.dial].filter(Boolean).join(" "); }

/** This posting's own reference's network-wide supply/demand/price, day-over-day -- distinct
 *  from `count` above (candidates that concretely MATCH this account's specific price/dial/
 *  condition), the same way Market Pulse's own FS/WTB counts are a broader, reference-level
 *  read than a personalized match list. Deltas are only ever shown once a PRIOR day's snapshot
 *  exists for this exact posting -- a brand-new posting's first briefing has nothing to compare
 *  against yet, so it just states today's numbers plainly. */
export interface BriefingTrend { fsCount:number; wtbCount:number; averageFsAsk:number|null; fsDelta:number|null; wtbDelta:number|null; priceDelta:number|null }

function countDeltaTag(delta:number|null):string {
  if (delta===null) return "";
  if (delta===0) return " (no change)";
  return ` (${delta>0?"+":""}${delta})`;
}
function priceLabel(value:number|null):string {
  return value===null ? "Unavailable" : new Intl.NumberFormat("en-US",{style:"currency",currency:"USD",maximumFractionDigits:0}).format(value);
}
function priceDeltaTag(delta:number|null):string {
  if (delta===null) return "";
  if (delta===0) return " (no change)";
  const formatted=new Intl.NumberFormat("en-US",{style:"currency",currency:"USD",maximumFractionDigits:0}).format(Math.abs(delta));
  return ` (${delta>0?"+":"-"}${formatted})`;
}

/**
 * Kept deliberately short and scannable -- one glance, no re-reading. Real feedback: the old
 * multi-sentence "Market trend for this reference:\nSupply: ... \nDemand: ... \nAvg ask: ..."
 * block was too dense to skim on a phone. Every number still appears (nothing here is lost,
 * only compressed) -- just as one "·"-separated line under its own 📊 marker instead of three
 * full sentences, so it still reads as a clearly separate, network-wide reference stat rather
 * than part of the personal match count on the line above it (that confusion is the one thing
 * the visual separation still has to prevent -- see the "required: the market trend is clearly
 * its own... section" test).
 */
function trendLine(trend:BriefingTrend):string {
  return `📊 ${trend.fsCount} for sale${countDeltaTag(trend.fsDelta)} · ${trend.wtbCount} want it${countDeltaTag(trend.wtbDelta)} · avg ${priceLabel(trend.averageFsAsk)}${priceDeltaTag(trend.priceDelta)}`;
}

export function formatBriefing(firstName:string|null, summaries:{posting:PostingRow;count:number;newCount:number;hasPrior:boolean;trend?:BriefingTrend|null}[], omitted=0):string {
  const greeting=`☀️ Morning${firstName?`, ${firstName}`:""}! Here's your Fi update:`;
  const blocks=summaries.map(({posting:p,count,newCount,hasPrior,trend},i)=>{
    const icon=p.type==="WTB"?"🔍":"🏷️";
    const matchLine=count===0
      ? "⏳ No matches yet."
      : `✅ ${count} ${p.type==="WTB"?"sellers match":"buyers want this"}!${hasPrior&&newCount>0?` (+${newCount} new)`:""}`;
    const trendLines=trend?`\n   ${trendLine(trend)}`:"";
    return `${i+1}. ${icon} ${title(p)}\n   ${matchLine}${trendLines}`;
  });
  if(omitted) blocks.push(`➕ ${omitted} more listing${omitted===1?"":"s"} I'm watching.`);
  // The items above are numbered specifically so a reply can reference one unambiguously (see
  // BriefingTrend's doc comment) -- but numbering alone doesn't tell anyone that's usable. Same
  // command syntax parseListingEditCommand already supports elsewhere (flow.ts's "listings"
  // summary), so a reply here behaves identically to one typed after "listings" -- this exact
  // phrasing must stay, it's what's actually parsed, not just instructional copy.
  const manageHint=summaries.length>0?`\n\n✏️ Reply "close listing <#>" to remove one, or "change listing <#> price/location/dial to ..." to edit it.`:"";
  const closing=summaries.some(s=>s.count)?"💪 Working 24/7 -- I'll ping you the moment something new shows up.":"👀 Still watching for you.";
  return `${greeting}\n\n${blocks.join("\n\n")}\n\n${closing}${manageHint}\n\n🔗 See everything anytime: watchfacts.com`;
}

/** Builds each posting's match/trend summary AND persists today's briefing_posting_state
 *  snapshot for it -- shared by the regular per-local-hour scheduler and the forced
 *  send-to-everyone-now broadcast below, so a resend computes numbers exactly the same way and
 *  still leaves tomorrow's regular briefing with a correct day-over-day delta to diff against. */
async function buildBriefingSummaries(canonicalUserId:number, postings:PostingRow[], now:Date) {
  const all=(await withSchema(db=>db.query<PostingRow>("SELECT * FROM postings WHERE status='active' AND expires_at>$1",[now]))).rows;
  const summaries=[];
  for(const posting of postings){
    const ids=await currentMatches(posting,all);
    const prior=(await withSchema(db=>db.query("SELECT known_match_ids, fs_count, wtb_count, avg_fs_ask_usd FROM briefing_posting_state WHERE canonical_user_id=$1 AND posting_id=$2",[canonicalUserId,posting.id]))).rows[0];
    const known:number[]=prior?.known_match_ids??[];
    // Reference-level supply/demand/price, same source Market Pulse itself reads from -- never
    // touches that command's own trial/weekly usage counter (marketPulseUsage.ts), since this is
    // Fi pushing it proactively, not the customer spending a look-up on it.
    let pulse:{fsCount:number;wtbCount:number;averageFsAsk:number|null}|null=null;
    if(posting.reference){ try{ pulse=await getMarketPulse(posting.reference); }catch(e){ console.error(`[lifecycle] market pulse lookup failed for posting ${posting.id} (omitting trend):`,e); } }
    const hasPriorTrend=prior && prior.fs_count!==null && prior.wtb_count!==null;
    const trend=pulse?{
      fsCount:pulse.fsCount, wtbCount:pulse.wtbCount, averageFsAsk:pulse.averageFsAsk,
      fsDelta:hasPriorTrend?pulse.fsCount-prior.fs_count:null,
      wtbDelta:hasPriorTrend?pulse.wtbCount-prior.wtb_count:null,
      priceDelta:hasPriorTrend&&pulse.averageFsAsk!==null&&prior.avg_fs_ask_usd!==null?pulse.averageFsAsk-prior.avg_fs_ask_usd:null,
    }:null;
    summaries.push({posting,count:ids.length,newCount:ids.filter(id=>!known.includes(id)).length,hasPrior:Boolean(prior),trend});
    await withSchema(db=>db.query(
      `INSERT INTO briefing_posting_state (canonical_user_id,posting_id,last_briefing_at,current_match_ids,known_match_ids,fs_count,wtb_count,avg_fs_ask_usd)
       VALUES($1,$2,$3,$4,$4,$5,$6,$7)
       ON CONFLICT(canonical_user_id,posting_id) DO UPDATE SET last_briefing_at=excluded.last_briefing_at,current_match_ids=excluded.current_match_ids,
         known_match_ids=(SELECT ARRAY(SELECT DISTINCT unnest(briefing_posting_state.known_match_ids||excluded.current_match_ids))),
         fs_count=excluded.fs_count,wtb_count=excluded.wtb_count,avg_fs_ask_usd=excluded.avg_fs_ask_usd`,
      [canonicalUserId,posting.id,now,ids,pulse?.fsCount??null,pulse?.wtbCount??null,pulse?.averageFsAsk??null]
    ));
  }
  return summaries;
}

export async function runMorningBriefings(now=new Date()):Promise<{sent:number;skipped:number}> {
  const s=await getLifecycleSettings(); if(!s.morningEnabled)return{sent:0,skipped:0}; let sent=0,skipped=0;
  const users=await withSchema(db=>db.query(`SELECT l.*,COALESCE(l.timezone,$1) effective_timezone FROM user_lifecycle l WHERE l.channel IN ('whatsapp','telegram')`,[s.defaultTimezone]));
  for(const user of users.rows){ let clock; try{clock=localClock(now,user.effective_timezone);}catch{clock=localClock(now,s.defaultTimezone);} if(clock.hour!==s.morningHour){skipped++;continue;}
    if(isMorningBriefingPaused(user,now)){skipped++;continue;}
    const postings=await withSchema(db=>db.query<PostingRow>("SELECT * FROM postings WHERE canonical_user_id=$1 AND status='active' AND expires_at>$2 ORDER BY created_at LIMIT $3",[user.canonical_user_id,now,s.maxPostings+1]));
    if(!postings.rowCount){skipped++;continue;} if(!await claim(user.canonical_user_id,"morning_briefing",clock.date)){skipped++;continue;}
    try{
      const summaries=await buildBriefingSummaries(user.canonical_user_id,postings.rows.slice(0,s.maxPostings),now);
      await sendText(user.identity,formatBriefing(user.first_name,summaries,Math.max(0,postings.rows.length-s.maxPostings)));await finish(user.canonical_user_id,"morning_briefing",clock.date);sent++;
    }catch(e){await finish(user.canonical_user_id,"morning_briefing",clock.date,e);}
  } return{sent,skipped};
}

/**
 * One-time admin-triggered broadcast: sends today's morning briefing (whatever format is
 * currently deployed) to every subscribed user RIGHT NOW, regardless of their own local morning
 * hour -- unlike runMorningBriefings above, which only ever sends once each person's own local
 * clock reaches the configured hour. Anyone whose local morning has already passed today (and
 * who already received today's regular briefing) WILL get a second one here -- that's the
 * explicit point of a forced resend (e.g. rolling out a format change to everyone immediately),
 * not a bug. Each recipient's delivery record is still updated to today's (their own local)
 * date so the regular scheduler doesn't ALSO send a third one later today once their local
 * morning hour arrives. `dryRun` previews who/how many without sending anything or touching any
 * delivery record; `testRecipient` narrows to one identity for a safe trial send.
 */
export async function resendMorningBriefingToAll(now=new Date(), opts:{dryRun?:boolean; testRecipient?:string}={}):Promise<{sent:number;skipped:number;recipients:string[]}> {
  const s=await getLifecycleSettings();
  const users=await withSchema(db=>db.query(
    `SELECT l.*,COALESCE(l.timezone,$1) effective_timezone FROM user_lifecycle l WHERE l.channel IN ('whatsapp','telegram')${opts.testRecipient?" AND l.identity=$2":""}`,
    opts.testRecipient?[s.defaultTimezone,opts.testRecipient]:[s.defaultTimezone]
  ));
  let sent=0,skipped=0; const recipients:string[]=[];
  for(const user of users.rows){
    // A forced resend is an operator rolling out a format change to everyone right now, but it
    // must still respect a user's own explicit "pause my updates" -- that choice means stop
    // sending morning updates, not "stop sending them except when an operator overrides it".
    if(isMorningBriefingPaused(user,now)){skipped++;continue;}
    const postings=await withSchema(db=>db.query<PostingRow>("SELECT * FROM postings WHERE canonical_user_id=$1 AND status='active' AND expires_at>$2 ORDER BY created_at LIMIT $3",[user.canonical_user_id,now,s.maxPostings+1]));
    if(!postings.rowCount){skipped++;continue;}
    try{
      const summaries=await buildBriefingSummaries(user.canonical_user_id,postings.rows.slice(0,s.maxPostings),now);
      const message=formatBriefing(user.first_name,summaries,Math.max(0,postings.rows.length-s.maxPostings));
      if(!opts.dryRun){
        await sendText(user.identity,message);
        let clock; try{clock=localClock(now,user.effective_timezone);}catch{clock=localClock(now,s.defaultTimezone);}
        await withSchema(db=>db.query(
          `INSERT INTO lifecycle_deliveries(canonical_user_id,kind,local_date,status,delivered_at) VALUES($1,'morning_briefing',$2,'delivered',now())
           ON CONFLICT(canonical_user_id,kind,local_date) DO UPDATE SET status='delivered',delivered_at=now(),error=NULL`,
          [user.canonical_user_id,clock.date]
        ));
      }
      sent++; recipients.push(user.identity);
    }catch(e){ console.error(`[lifecycle] forced morning-briefing resend failed for ${user.identity}:`,e); skipped++; }
  }
  return {sent,skipped,recipients};
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
