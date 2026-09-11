import test, { after } from "node:test";
import assert from "node:assert/strict";
process.env.NODE_ENV="test"; process.env.WEBHOOK_TOKEN="test";
import { formatBriefing, formatDormant, localClock, runMorningBriefings, resendMorningBriefingToAll, setLifecycleSettings, BriefingTrend, pauseMorningBriefing, resumeMorningBriefing, getMorningBriefingPauseStatus } from "./lifecycle";
import { PostingRow } from "./postings/postingsStore";
import { _resetDbForTests, withSchema, _closePoolForTests } from "./postings/db";
import { initAdminSchema } from "./admin/store";
import { getOrCreateCanonicalUser } from "./postings/identity";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const channels = require("./channels") as typeof import("./channels");

after(async () => { await _closePoolForTests(); });
const posting=(type:"FS"|"WTB",extra:Partial<PostingRow>={}):PostingRow=>({id:1,source_platform:"whatsapp",source_type:"direct",source_chat_id:null,source_message_id:null,external_listing_id:null,canonical_user_id:1,source_identity:"15551234567",type,original_text:"",brand:"Rolex",model:"Daytona",reference:"116500LN",dial:"black dial",condition:"",price:null,currency:"USD",location:"",contact_name:"John",contact_phone:"15551234567",detail_url:"",status:"active",approved_match_count:0,expires_at:"2099-01-01",reminder_sent_for_expires_at:null,...extra});
test("briefing preserves watch detail and current/new counts",()=>{const text=formatBriefing("John",[{posting:posting("WTB"),count:3,newCount:2,hasPrior:true}]);assert.match(text,/Morning, John/);assert.match(text,/Rolex Daytona 116500LN black dial/);assert.match(text,/3 sellers match/);assert.match(text,/\(\+2 new\)/);});
test("FS wording counts active buyers and omits zero new",()=>{const text=formatBriefing(null,[{posting:posting("FS"),count:4,newCount:0,hasPrior:true}]);assert.match(text,/4 buyers want this/);assert.doesNotMatch(text,/\+0 new/);});
test("zero matches has natural monitoring copy",()=>{const text=formatBriefing(null,[{posting:posting("WTB"),count:0,newCount:0,hasPrior:false}]);assert.match(text,/No matches yet/);assert.match(text,/Still watching/);});
test("multiple postings combine and excess tasks summarize",()=>{const text=formatBriefing("J",[{posting:posting("WTB"),count:1,newCount:0,hasPrior:false},{posting:posting("FS",{id:2,brand:"Patek Philippe",model:"Nautilus",reference:"5712G"}),count:2,newCount:0,hasPrior:false}],3);assert.match(text,/Rolex/);assert.match(text,/Patek Philippe/);assert.match(text,/3 more listings I'm watching/);});
test("required: each requested item is numbered, in order, so a reply like 'listing 2' can reference it unambiguously",()=>{const text=formatBriefing("J",[{posting:posting("WTB"),count:1,newCount:0,hasPrior:false},{posting:posting("FS",{id:2,brand:"Patek Philippe",model:"Nautilus",reference:"5712G"}),count:2,newCount:0,hasPrior:false}]);assert.match(text,/1\. 🔍 Rolex Daytona 116500LN black dial/);assert.match(text,/2\. 🏷️ Patek Philippe Nautilus 5712G/);});
test("required: the briefing points people to watchfacts.com so they can check listings themselves",()=>{const text=formatBriefing("John",[{posting:posting("WTB"),count:3,newCount:2,hasPrior:true}]);assert.match(text,/watchfacts\.com/);});

function trend(overrides:Partial<BriefingTrend>={}):BriefingTrend{return {fsCount:8,wtbCount:3,averageFsAsk:24500,fsDelta:2,wtbDelta:-1,priceDelta:500,...overrides};}
test("required: a posting with trend data shows supply/demand/price and their deltas, compressed onto one line",()=>{
  const text=formatBriefing("John",[{posting:posting("WTB"),count:1,newCount:0,hasPrior:true,trend:trend()}]);
  assert.match(text,/📊 8 for sale \(\+2\) · 3 want it \(-1\) · avg \$24,500 \(\+\$500\)/);
});
test("required: a posting's FIRST briefing (no prior snapshot) states today's numbers plainly, with no invented delta",()=>{
  const text=formatBriefing("John",[{posting:posting("WTB"),count:1,newCount:0,hasPrior:false,trend:trend({fsDelta:null,wtbDelta:null,priceDelta:null})}]);
  assert.match(text,/📊 8 for sale · 3 want it · avg \$24,500\n/);
});
test("required: a zero delta reads as 'no change', never a bare '+0'",()=>{
  const text=formatBriefing("John",[{posting:posting("WTB"),count:1,newCount:0,hasPrior:true,trend:trend({fsDelta:0,priceDelta:0})}]);
  assert.match(text,/8 for sale \(no change\)/);
  assert.match(text,/avg \$24,500 \(no change\)/);
});
test("required: an unresolvable average ask still shows Unavailable, same as Market Pulse itself",()=>{
  const text=formatBriefing("John",[{posting:posting("WTB"),count:1,newCount:0,hasPrior:true,trend:trend({averageFsAsk:null,priceDelta:null})}]);
  assert.match(text,/avg Unavailable\n/);
});
test("required: a posting with no resolvable reference (trend omitted entirely) never shows the 📊 market line",()=>{
  const text=formatBriefing("John",[{posting:posting("WTB"),count:1,newCount:0,hasPrior:true}]);
  assert.doesNotMatch(text,/📊/);
});
test("required: the market trend line is clearly distinct from the personal match line right above it, even when both show the same number",()=>{
  const text=formatBriefing("John",[{posting:posting("WTB"),count:3,newCount:0,hasPrior:true,trend:trend({fsCount:3})}]);
  // Both happen to be "3" here on purpose -- different icon (✅ vs 📊) and different wording
  // ("sellers match" vs "for sale") is what prevents them reading as the same statistic.
  assert.match(text,/✅ 3 sellers match!\n   📊 3 for sale/);
});
test("required: the briefing tells people how to remove or edit a numbered item, using the same command syntax the app already supports",()=>{
  const text=formatBriefing("John",[{posting:posting("WTB"),count:1,newCount:0,hasPrior:false},{posting:posting("FS",{id:2,brand:"Patek Philippe",model:"Nautilus",reference:"5712G"}),count:2,newCount:0,hasPrior:false}]);
  assert.match(text,/Reply "close listing <#>" to remove one, or "change listing <#> price\/location\/dial to \.\.\." to edit it\./);
});
test("required: an account with nothing active gets no manage hint -- there's nothing to close or edit yet",()=>{
  const text=formatBriefing(null,[]);
  assert.doesNotMatch(text,/close listing/);
});
test("dormant copy personalizes and has clean fallback",()=>{const t="Hi {{first_name}}, checking in.";assert.equal(formatDormant(t,"Ana"),"Hi Ana, checking in.");assert.equal(formatDormant(t,null),"Hi, checking in.");});
test("local clock respects user timezone",()=>{const at=new Date("2026-09-01T12:00:00Z");assert.deepEqual(localClock(at,"America/New_York"),{date:"2026-09-01",hour:8});assert.deepEqual(localClock(at,"Pacific/Honolulu"),{date:"2026-09-01",hour:2});});

test("required: runMorningBriefings computes and persists the supply/demand/price trend, then shows real deltas the next day", async (t) => {
  await _resetDbForTests();
  await initAdminSchema();
  await setLifecycleSettings({
    MORNING_BRIEFING_ENABLED: "true",
    MORNING_BRIEFING_LOCAL_HOUR: "8",
    MORNING_BRIEFING_DEFAULT_TIMEZONE: "UTC",
    MORNING_BRIEFING_MAX_POSTINGS: "5",
  });

  const sent: { identity: string; message: string }[] = [];
  t.mock.method(channels, "sendText", async (identity: string, message: string) => { sent.push({ identity, message }); });

  const userId = await withSchema(async (db) => {
    const u = (await db.query("INSERT INTO canonical_users DEFAULT VALUES RETURNING id")).rows[0].id;
    await db.query(
      `INSERT INTO user_lifecycle(canonical_user_id,channel,identity,first_name,last_inbound_at,last_direct_inbound_at)
       VALUES($1,'whatsapp','15550009999','Ana',now(),now())`,
      [u]
    );
    await db.query(
      `INSERT INTO postings(source_platform,source_type,source_chat_id,source_message_id,external_listing_id,canonical_user_id,type,original_text,brand,model,reference,price,currency,status,expires_at)
       VALUES('whatsapp','direct',NULL,NULL,NULL,$1,'WTB','WTB Rolex Daytona 116500LN','Rolex','Daytona','116500LN',30000,'USD','active',now()+interval '1 day')`,
      [u]
    );
    // Other-side FS listings for the SAME reference so Market Pulse (and this posting's own
    // trend, which reads from it) has real supply/price data to report.
    await db.query(
      `INSERT INTO postings(source_platform,source_type,source_chat_id,source_message_id,external_listing_id,type,original_text,reference,price,currency,status,expires_at)
       VALUES
       ('whatsapp','chat','g1','fs-1',NULL,'FS','FS Rolex Daytona 116500LN','116500LN',24000,'USD','active',now()+interval '1 day'),
       ('whatsapp','chat','g1','fs-2',NULL,'FS','FS Rolex Daytona 116500LN','116500LN',25000,'USD','active',now()+interval '1 day')`
    );
    return u;
  });

  const day1 = new Date("2026-09-01T08:00:00Z");
  const result1 = await runMorningBriefings(day1);
  assert.equal(result1.sent, 1);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].identity, "15550009999");
  // Day one: real numbers, no invented "since yesterday" -- nothing to compare against yet.
  assert.match(sent[0].message, /Supply: 2 active listings\n/);
  assert.match(sent[0].message, /Avg ask: \$24,500\n/);
  assert.doesNotMatch(sent[0].message, /since yesterday/);

  // Overnight: one more FS listing appears, and the average ask moves.
  await withSchema((db) =>
    db.query(
      `INSERT INTO postings(source_platform,source_type,source_chat_id,source_message_id,external_listing_id,type,original_text,reference,price,currency,status,expires_at)
       VALUES('whatsapp','chat','g1','fs-3',NULL,'FS','FS Rolex Daytona 116500LN','116500LN',29000,'USD','active',now()+interval '1 day')`
    )
  );

  const day2 = new Date("2026-09-02T08:00:00Z");
  const result2 = await runMorningBriefings(day2);
  assert.equal(result2.sent, 1);
  assert.equal(sent.length, 2);
  // Day two: 3 listings now (was 2, +1), and the average ask moved from $24,500 to $26,000.
  assert.match(sent[1].message, /Supply: 3 active listings \(\+1 since yesterday\)/);
  assert.match(sent[1].message, /Avg ask: \$26,000 \(\+\$1,500 since yesterday\)/);

  const row = await withSchema((db) => db.query("SELECT fs_count,wtb_count,avg_fs_ask_usd FROM briefing_posting_state WHERE canonical_user_id=$1", [userId]));
  assert.equal(row.rows[0].fs_count, 3);
  assert.equal(Number(row.rows[0].avg_fs_ask_usd), 26000);
});

test("required: resendMorningBriefingToAll sends to everyone right now, regardless of local hour, and blocks the regular scheduler from double-sending later today", async (t) => {
  await _resetDbForTests();
  await initAdminSchema();
  await setLifecycleSettings({
    MORNING_BRIEFING_ENABLED: "true",
    MORNING_BRIEFING_LOCAL_HOUR: "8",
    MORNING_BRIEFING_DEFAULT_TIMEZONE: "UTC",
    MORNING_BRIEFING_MAX_POSTINGS: "5",
  });
  const sent: { identity: string; message: string }[] = [];
  t.mock.method(channels, "sendText", async (identity: string, message: string) => { sent.push({ identity, message }); });

  const noon = new Date("2026-09-01T12:00:00Z"); // NOT the configured morning hour (8)
  await withSchema(async (db) => {
    const u = (await db.query("INSERT INTO canonical_users DEFAULT VALUES RETURNING id")).rows[0].id;
    await db.query(`INSERT INTO user_lifecycle(canonical_user_id,channel,identity,first_name,last_inbound_at,last_direct_inbound_at) VALUES($1,'whatsapp','15551110001','Sam',now(),now())`, [u]);
    await db.query(
      `INSERT INTO postings(source_platform,source_type,canonical_user_id,type,original_text,brand,reference,price,currency,status,expires_at)
       VALUES('whatsapp','direct',$1,'WTB','WTB Rolex 116500LN','Rolex','116500LN',30000,'USD','active',now()+interval '1 day')`,
      [u]
    );
  });

  // The regular scheduler must NOT send at noon (hour doesn't match the configured 8).
  const regular = await runMorningBriefings(noon);
  assert.equal(regular.sent, 0);
  assert.equal(sent.length, 0);

  const forced = await resendMorningBriefingToAll(noon);
  assert.equal(forced.sent, 1);
  assert.deepEqual(forced.recipients, ["15551110001"]);
  assert.equal(sent.length, 1);

  // The person's local morning hour (8) arriving LATER the same day must not send a duplicate --
  // the forced resend already claimed today's (their local) delivery.
  const laterSameDay = new Date("2026-09-01T08:00:00Z");
  const again = await runMorningBriefings(laterSameDay);
  assert.equal(again.sent, 0, "the regular scheduler must not double-send after a forced resend already covered today");
  assert.equal(sent.length, 1);
});

test("required: resendMorningBriefingToAll's dryRun sends nothing and touches no delivery record", async (t) => {
  await _resetDbForTests();
  await initAdminSchema();
  await setLifecycleSettings({ MORNING_BRIEFING_ENABLED: "true", MORNING_BRIEFING_LOCAL_HOUR: "8", MORNING_BRIEFING_DEFAULT_TIMEZONE: "UTC", MORNING_BRIEFING_MAX_POSTINGS: "5" });
  const sent: { identity: string }[] = [];
  t.mock.method(channels, "sendText", async (identity: string) => { sent.push({ identity }); });

  const u = await withSchema(async (db) => {
    const id = (await db.query("INSERT INTO canonical_users DEFAULT VALUES RETURNING id")).rows[0].id;
    await db.query(`INSERT INTO user_lifecycle(canonical_user_id,channel,identity,first_name,last_inbound_at,last_direct_inbound_at) VALUES($1,'whatsapp','15551110002','Dana',now(),now())`, [id]);
    await db.query(
      `INSERT INTO postings(source_platform,source_type,canonical_user_id,type,original_text,brand,reference,price,currency,status,expires_at)
       VALUES('whatsapp','direct',$1,'WTB','WTB Rolex 116500LN','Rolex','116500LN',30000,'USD','active',now()+interval '1 day')`,
      [id]
    );
    return id;
  });

  const now = new Date("2026-09-01T12:00:00Z");
  const preview = await resendMorningBriefingToAll(now, { dryRun: true });
  assert.equal(preview.sent, 1, "dryRun still reports what WOULD be sent");
  assert.equal(sent.length, 0, "dryRun must never actually call sendText");
  const claimed = await withSchema((db) => db.query("SELECT 1 FROM lifecycle_deliveries WHERE canonical_user_id=$1", [u]));
  assert.equal(claimed.rowCount, 0, "dryRun must never touch the delivery record either");
});

test("required: resendMorningBriefingToAll's testRecipient narrows to exactly that one identity", async (t) => {
  await _resetDbForTests();
  await initAdminSchema();
  await setLifecycleSettings({ MORNING_BRIEFING_ENABLED: "true", MORNING_BRIEFING_LOCAL_HOUR: "8", MORNING_BRIEFING_DEFAULT_TIMEZONE: "UTC", MORNING_BRIEFING_MAX_POSTINGS: "5" });
  const sent: string[] = [];
  t.mock.method(channels, "sendText", async (identity: string) => { sent.push(identity); });

  await withSchema(async (db) => {
    for (const phone of ["15551110003", "15551110004"]) {
      const id = (await db.query("INSERT INTO canonical_users DEFAULT VALUES RETURNING id")).rows[0].id;
      await db.query(`INSERT INTO user_lifecycle(canonical_user_id,channel,identity,first_name,last_inbound_at,last_direct_inbound_at) VALUES($1,'whatsapp',$2,'X',now(),now())`, [id, phone]);
      await db.query(
        `INSERT INTO postings(source_platform,source_type,canonical_user_id,type,original_text,brand,reference,price,currency,status,expires_at)
         VALUES('whatsapp','direct',$1,'WTB','WTB Rolex 116500LN','Rolex','116500LN',30000,'USD','active',now()+interval '1 day')`,
        [id]
      );
    }
  });

  const result = await resendMorningBriefingToAll(new Date("2026-09-01T12:00:00Z"), { testRecipient: "15551110003" });
  assert.equal(result.sent, 1);
  assert.deepEqual(sent, ["15551110003"]);
});

// --- pause/resume ("pause my morning updates for a day/week/month/indefinitely") ---

test("pauseMorningBriefing returns the correct end date for each finite duration", async () => {
  await _resetDbForTests();
  const now = new Date("2026-09-01T08:00:00Z");
  assert.equal((await pauseMorningBriefing("15559990001", "1day", now) as Date).toISOString(), "2026-09-02T08:00:00.000Z");
  assert.equal((await pauseMorningBriefing("15559990002", "1week", now) as Date).toISOString(), "2026-09-08T08:00:00.000Z");
  assert.equal((await pauseMorningBriefing("15559990003", "1month", now) as Date).toISOString(), "2026-10-01T08:00:00.000Z");
});

test("pauseMorningBriefing/getMorningBriefingPauseStatus/resumeMorningBriefing round-trip, both finite and indefinite", async () => {
  await _resetDbForTests();
  const phone = "15559990004";
  assert.equal(await getMorningBriefingPauseStatus(phone), null, "nothing paused yet");

  const until = await pauseMorningBriefing(phone, "1week", new Date("2026-09-01T08:00:00Z"));
  assert.deepEqual(await getMorningBriefingPauseStatus(phone), until);

  assert.equal(await pauseMorningBriefing(phone, "indefinite"), "indefinite");
  assert.equal(await getMorningBriefingPauseStatus(phone), "indefinite", "a later pause call replaces the earlier finite one");

  await resumeMorningBriefing(phone);
  assert.equal(await getMorningBriefingPauseStatus(phone), null);
});

// Goes through getOrCreateCanonicalUser (registers linked_identities), same as
// pauseMorningBriefing/resumeMorningBriefing do internally -- creating the canonical_users row
// directly (as the older setup blocks above do) leaves no linked_identities row, so a LATER call
// to pauseMorningBriefing for the same phone would resolve to a second, disconnected canonical
// user instead of the one these postings are actually attached to.
async function makeLifecycleUserWithActivePosting(phone: string): Promise<void> {
  const id = await getOrCreateCanonicalUser("whatsapp", phone);
  await withSchema(async (db) => {
    await db.query(`INSERT INTO user_lifecycle(canonical_user_id,channel,identity,first_name,last_inbound_at,last_direct_inbound_at) VALUES($1,'whatsapp',$2,'X',now(),now())`, [id, phone]);
    await db.query(
      `INSERT INTO postings(source_platform,source_type,canonical_user_id,type,original_text,brand,reference,price,currency,status,expires_at)
       VALUES('whatsapp','direct',$1,'WTB','WTB Rolex 116500LN','Rolex','116500LN',30000,'USD','active',now()+interval '1 day')`,
      [id]
    );
  });
}

test("required: runMorningBriefings skips an indefinitely-paused account but still sends to everyone else", async (t) => {
  await _resetDbForTests();
  await initAdminSchema();
  await setLifecycleSettings({ MORNING_BRIEFING_ENABLED: "true", MORNING_BRIEFING_LOCAL_HOUR: "8", MORNING_BRIEFING_DEFAULT_TIMEZONE: "UTC", MORNING_BRIEFING_MAX_POSTINGS: "5" });
  const sent: string[] = [];
  t.mock.method(channels, "sendText", async (identity: string) => { sent.push(identity); });

  await makeLifecycleUserWithActivePosting("15559990010");
  await makeLifecycleUserWithActivePosting("15559990011");
  await pauseMorningBriefing("15559990010", "indefinite");

  const result = await runMorningBriefings(new Date("2026-09-01T08:00:00Z"));
  assert.equal(result.sent, 1);
  assert.deepEqual(sent, ["15559990011"]);
});

test("required: a finite pause that has not yet expired is still honored, but one that already expired no longer blocks the briefing", async (t) => {
  await _resetDbForTests();
  await initAdminSchema();
  await setLifecycleSettings({ MORNING_BRIEFING_ENABLED: "true", MORNING_BRIEFING_LOCAL_HOUR: "8", MORNING_BRIEFING_DEFAULT_TIMEZONE: "UTC", MORNING_BRIEFING_MAX_POSTINGS: "5" });
  const sent: string[] = [];
  t.mock.method(channels, "sendText", async (identity: string) => { sent.push(identity); });

  await makeLifecycleUserWithActivePosting("15559990020"); // pause still in effect
  await makeLifecycleUserWithActivePosting("15559990021"); // pause already expired
  await pauseMorningBriefing("15559990020", "1week", new Date("2026-09-01T08:00:00Z"));
  await pauseMorningBriefing("15559990021", "1day", new Date("2026-08-01T08:00:00Z"));

  const result = await runMorningBriefings(new Date("2026-09-01T08:00:00Z"));
  assert.equal(result.sent, 1);
  assert.deepEqual(sent, ["15559990021"], "the expired pause must not keep blocking the briefing once its own end date has passed");
});

test("required: resendMorningBriefingToAll (the admin-forced broadcast) also respects an explicit pause", async (t) => {
  await _resetDbForTests();
  await initAdminSchema();
  await setLifecycleSettings({ MORNING_BRIEFING_ENABLED: "true", MORNING_BRIEFING_LOCAL_HOUR: "8", MORNING_BRIEFING_DEFAULT_TIMEZONE: "UTC", MORNING_BRIEFING_MAX_POSTINGS: "5" });
  const sent: string[] = [];
  t.mock.method(channels, "sendText", async (identity: string) => { sent.push(identity); });

  await makeLifecycleUserWithActivePosting("15559990030");
  await makeLifecycleUserWithActivePosting("15559990031");
  await pauseMorningBriefing("15559990030", "indefinite");

  const result = await resendMorningBriefingToAll(new Date("2026-09-01T12:00:00Z"));
  assert.equal(result.sent, 1);
  assert.deepEqual(sent, ["15559990031"], "a forced admin resend must not override a user's own explicit pause");
});
