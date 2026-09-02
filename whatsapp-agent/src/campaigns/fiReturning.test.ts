import test from "node:test";
import assert from "node:assert/strict";
process.env.NODE_ENV="test";
import { config } from "../config";
import { _resetDbForTests, withSchema } from "../postings/db";
import { initAdminSchema } from "../admin/store";
import { formatFiReturningMessage, previewFiReturningCampaign, runFiReturningCampaign } from "./fiReturning";

test("one-time returning-user campaign is selective, personalized, safe and idempotent",async()=>{
  config.fiReturningCampaign.publicPhoneNumber="+1 305 555 7272";config.fiReturningCampaign.ratePerHour=0;
  await _resetDbForTests();await initAdminSchema();await withSchema(db=>db.query("DELETE FROM approved_users"));
  const add=async(phone:string,name:string|null,direct:boolean,status="active",opt:string|null="opted_in")=>withSchema(async db=>{
    const u=(await db.query("INSERT INTO canonical_users DEFAULT VALUES RETURNING id")).rows[0].id;
    await db.query("INSERT INTO linked_identities(canonical_user_id,platform,identity) VALUES($1,'whatsapp',$2)",[u,phone]);
    await db.query("INSERT INTO user_lifecycle(canonical_user_id,channel,identity,first_name,last_inbound_at,last_direct_inbound_at) VALUES($1,'whatsapp',$2,$3,now(),CASE WHEN $4 THEN now() END)",[u,phone,name,direct]);
    await db.query("INSERT INTO approved_users(phone,name,access_status,opt_in_status) VALUES($1,$2,$3,$4)",[phone,name??"Unknown",status,opt]);return u;
  });
  const eligible=await add("13055550001","Ana Maria",true), fallback=await add("13055550002",null,true);
  await add("13055550003","Group",false);await add("13055550004","Out",true,"active","opted_out");await add("13055550005","Blocked",true,"blocked");
  const preview=await previewFiReturningCampaign();assert.equal(preview.eligible,2);assert.equal(preview.exclusions.no_direct_history,1);assert.equal(preview.exclusions.opted_out,1);assert.equal(preview.exclusions.blocked,1);
  const personalized=formatFiReturningMessage("Ana Maria");assert.match(personalized,/^Hi Ana, Fi here\./);assert.match(personalized,/\+1 305 555 7272/);assert.match(personalized,/\$50\/month flat rate/);assert.equal(formatFiReturningMessage(null).startsWith("Hi, Fi here."),true);
  const deliveries:{phone:string;body:string}[]=[];const sender=async(phone:string,_n:string,_l:string,_p:string[],body?:string)=>{deliveries.push({phone,body:body!});};
  const dry=await runFiReturningCampaign({dryRun:true,send:sender});assert.equal(dry.sent,0);assert.equal(deliveries.length,0);
  const testOnly=await runFiReturningCampaign({testRecipient:"13055550001",send:sender});assert.equal(testOnly.sent,1);assert.deepEqual(deliveries.map(x=>x.phone),["13055550001"]);
  const broad=await runFiReturningCampaign({send:sender});assert.equal(broad.sent,1);assert.equal(deliveries.length,2);
  await runFiReturningCampaign({send:sender});assert.equal(deliveries.length,2,"a second execution must not resend");
  const promos=await withSchema(db=>db.query("SELECT canonical_user_id,tasks_granted,tasks_used,campaign_sent_at FROM fi_returning_promotions ORDER BY canonical_user_id"));
  assert.deepEqual(promos.rows.map(r=>[r.canonical_user_id,r.tasks_granted,r.tasks_used,Boolean(r.campaign_sent_at)]),[[eligible,3,0,true],[fallback,3,0,true]]);
  await runFiReturningCampaign({send:sender});const grant=await withSchema(db=>db.query("SELECT tasks_granted FROM fi_returning_promotions WHERE canonical_user_id=$1",[eligible]));assert.equal(grant.rows[0].tasks_granted,3);
  const failing=await add("13055550006","Fail",true);const secret="super-secret-api-token";const logged:string[]=[];const old=console.error;console.error=(...v:unknown[])=>logged.push(JSON.stringify(v));
  const failure=await runFiReturningCampaign({testRecipient:"13055550006",send:async()=>{throw new Error("provider unavailable")}});console.error=old;
  assert.equal(failure.failed,1);const row=await withSchema(db=>db.query("SELECT status,reason FROM fi_returning_campaign_deliveries WHERE canonical_user_id=$1",[failing]));assert.equal(row.rows[0].status,"failed");assert.match(row.rows[0].reason,/provider unavailable/);assert.doesNotMatch(logged.join(" "),new RegExp(secret));
});
