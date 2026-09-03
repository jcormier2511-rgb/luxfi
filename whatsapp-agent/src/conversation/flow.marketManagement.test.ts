import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
process.env.NODE_ENV="test"; process.env.WEBHOOK_TOKEN="test";
const db=require("../postings/db") as typeof import("../postings/db");
const inventory=require("../watchfacts/inventoryDb") as typeof import("../watchfacts/inventoryDb");
const store=require("../postings/postingsStore") as typeof import("../postings/postingsStore");
const {handleIncomingMessage}=require("./flow") as typeof import("./flow");
const {resetState,getState}=require("./stateStore") as typeof import("./stateStore");
after(async()=>{await db._closePoolForTests();await inventory._closePoolForTests();});
beforeEach(async()=>{await db._resetDbForTests();await inventory._resetDbForTests();});
async function listing(phone:string,type:"FS"|"WTB",reference:string,price:number,extra:Partial<import("../postings/postingsStore").DirectSellPostingInput>={}) {
 return store.createDirectPosting({phone,type,description:"historical raw text 999999",brand:"Rolex",model:"Daytona",reference,price,currency:"USD",...extra});
}
test("live briefing/edit/list sequence is deterministic and preserves identity",async()=>{
 const phone="sms:15550100001";resetState(phone);const made=[];
 for(let i=1;i<=6;i++)made.push(await listing(phone,i%2?"WTB":"FS",`REF${i}X`,30000+i));
 const briefing=await handleIncomingMessage(phone,"market briefing");
 assert.match(briefing.messages.join("\n"),/^Your Market Briefing/);assert.doesNotMatch(briefing.messages.join("\n"),/Try "buy:/);
 const changed=await handleIncomingMessage(phone,"change listing 6 price to 35000");
 assert.match(changed.messages.join("\n"),/Updated:[\s\S]*REF6X[\s\S]*Asking: \$35,000/);
 const row=await store.getPosting(made[5].id);assert.equal(row?.reference,"REF6X");assert.equal(row?.model,"Daytona");assert.equal(Number(row?.price),35000);
 const shown=await handleIncomingMessage(phone,"my listings");assert.match(shown.messages.join("\n"),/6\. FS — Rolex Daytona REF6X[\s\S]*Asking: \$35,000/);
});
test("budget/region and lifecycle commands update only their targets",async()=>{
 const phone="telegram:551010002";resetState(phone);const first=await listing(phone,"WTB","16233",20000,{location:"USA",dialColor:"Champagne"});
 await handleIncomingMessage(phone,"change listing 1 budget to 25000");let row=await store.getPosting(first.id);
 assert.equal(Number(row?.price),25000);assert.equal(row?.reference,"16233");assert.equal(row?.location,"USA");
 await handleIncomingMessage(phone,"expand listing 1 to worldwide");row=await store.getPosting(first.id);assert.equal(row?.location,"worldwide");assert.equal(Number(row?.price),25000);
 await handleIncomingMessage(phone,"pause listing 1");assert.equal((await store.getPosting(first.id))?.status,"paused");
 await handleIncomingMessage(phone,"resume listing 1");assert.equal((await store.getPosting(first.id))?.status,"active");
 await handleIncomingMessage(phone,"close listing 1");assert.equal((await store.getPosting(first.id))?.status,"stopped");
});
test("brand-only pulse reports scoped counts without reference pricing",async()=>{
 const phone="whatsapp:15550100003";resetState(phone);
 await store.createDirectPosting({phone,type:"WTB",description:"WTB Rolex",brand:"Rolex",reference:null,price:null});
 await store.createDirectPosting({phone:"other",type:"FS",description:"FS Rolex",brand:"Rolex",reference:null,price:50000});
 const pulse=await handleIncomingMessage(phone,"market pulse");
 assert.match(pulse.messages.join("\n"),/Market Pulse — Rolex[\s\S]*FS: 1 active listings[\s\S]*Average ask: unavailable/i);
 assert.doesNotMatch(pulse.messages.join("\n"),/Average FS ask: \$/);
});

/**
 * The codex branch wired a network-wide briefing to "market briefing", colliding with the
 * per-listing briefing of the same name. It is kept, but placed where the per-listing one has
 * nothing to say — an account with no listings — and given its own explicit command.
 */
test("an account with no listings gets the network snapshot instead of a dead end",async()=>{
 const phone="telegram:551990001";resetState(phone);
 await store.createDirectPosting({phone:"other",type:"FS",description:"FS Rolex",brand:"Rolex",model:"Daytona",reference:"116500LN",price:30000,currency:"USD"});
 await store.createDirectPosting({phone:"other2",type:"WTB",description:"WTB Rolex",brand:"Rolex",model:"Daytona",reference:"116500LN",price:28000,currency:"USD"});
 const reply=await handleIncomingMessage(phone,"market briefing");
 const text=reply.messages.join("\n");
 assert.match(text,/don’t have any active listings to brief yet/);
 assert.match(text,/Market Overview — everything Fi is monitoring/);
 assert.match(text,/FS: 1 active listings/);
 assert.match(text,/WTB: 1 active requests/);
});

test("market overview always reports the whole network, even with listings of your own",async()=>{
 const phone="telegram:551990002";resetState(phone);
 await store.createDirectPosting({phone,type:"FS",description:"mine",brand:"Rolex",model:"Daytona",reference:"116500LN",price:30000,currency:"USD"});
 await store.createDirectPosting({phone:"other",type:"FS",description:"theirs",brand:"Rolex",model:"Submariner",reference:"126610LN",price:14000,currency:"USD"});
 for(const command of ["market overview","overall market","network market","market snapshot"]){
  const reply=await handleIncomingMessage(phone,command);
  const text=reply.messages.join("\n");
  assert.match(text,/Market Overview — everything Fi is monitoring/,`"${command}" was not recognized`);
  assert.match(text,/FS: 2 active listings/,`"${command}" must count the whole network, not just this account`);
 }
 // The per-listing briefing is untouched and still scoped to this account's own listings.
 const briefing=await handleIncomingMessage(phone,"market briefing");
 assert.match(briefing.messages.join("\n"),/^Your Market Briefing/);
});

test("confirming a WTB shows what WatchFacts already has, without a second command",async()=>{
 const phone="telegram:551990003";resetState(phone);
 await inventory.upsertListings([
  {id:"wf-live-1",type:"FS",category:"watches",item:"Daytona",brand:"Rolex",ref:"116500LN",condition:"pre-owned",price:"$28,000",location:"USA",contactName:"A",contactPhone:"1",rating:"",description:"Rolex Daytona 116500LN"},
 ],new Date().toISOString());
 await handleIncomingMessage(phone,"WTB Rolex 116500LN, black dial, pre-owned, usa, max $35,000");
 assert.equal(getState(phone).pendingBuyIntake?.step,"confirm","precondition: the draft is ready to confirm");

 const confirmed=await handleIncomingMessage(phone,"confirm");
 const text=confirmed.messages.join("\n");
 assert.match(text,/request is active/i,"the acknowledgment still comes first");
 assert.match(text,/116500LN/,"and the available inventory is shown straight away");
 assert.equal(getState(phone).pendingBuyIntake,undefined,"the draft is cleared afterwards");
});
