import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs"; import os from "os"; import path from "path";
const dir=fs.mkdtempSync(path.join(os.tmpdir(),"luxfi-slots-")); process.env.PERSIST_DIR=dir; process.env.NODE_ENV="test"; process.env.WEBHOOK_TOKEN="test";
const {handleIncomingMessage}=require("./flow") as typeof import("./flow"); const {resetState}=require("./stateStore") as typeof import("./stateStore");
after(()=>fs.rmSync(dir,{recursive:true,force:true}));

test("WTB fills fields in any order, accepts multiple slots and corrections, then confirms",async()=>{
 const p="15550002001"; resetState(p);
 const first=await handleIncomingMessage(p,"WTB Rolex 116500LN in the US for 28000");
 assert.match(first.messages[0],/Fi/); assert.match(first.messages[1],/black dial, white dial, or either/);
 assert.equal(first.state.pendingBuyIntake?.budget,28000); assert.equal(first.state.pendingBuyIntake?.location,"US");
 const multi=await handleIncomingMessage(p,"white dial, pre-owned");
 assert.match(multi.messages[0],/I have: WTB/); assert.match(multi.messages[0],/white dial.*pre-owned.*US.*\$28,000/);
 const corrected=await handleIncomingMessage(p,"Actually my budget is 30k and I'm in Canada, new, black dial");
 assert.match(corrected.messages[0],/black dial.*new.*Canada.*\$30,000/);
 assert.equal(corrected.state.pendingBuyIntake?.reference,"116500LN");
});

test("any fills only the discussed slot and arbitrary questions do not corrupt the draft",async()=>{
 const p="15550002002"; resetState(p); await handleIncomingMessage(p,"WTB Rolex 116500LN under 25k");
 const any=await handleIncomingMessage(p,"any"); assert.match(any.messages[0],/condition/i); assert.equal(any.state.pendingBuyIntake?.dialColor,"either");
 const question=await handleIncomingMessage(p,"What does pre-owned mean?");
 assert.equal(question.state.pendingBuyIntake?.condition,undefined); assert.equal(question.state.pendingBuyIntake?.location,undefined);
 assert.match(question.messages.at(-1)!,/condition/i);
});

test("a new request during intake asks replace-or-add and replace starts cleanly",async()=>{
 const p="15550002003"; resetState(p); await handleIncomingMessage(p,"FS Rolex 116500LN 28500");
 const conflict=await handleIncomingMessage(p,"WTB Patek 5711 under 80k"); assert.match(conflict.messages[0],/replace.*add another/i);
 const replaced=await handleIncomingMessage(p,"replace"); assert.equal(replaced.state.pendingSellIntake,undefined); assert.equal(replaced.state.pendingBuyIntake?.reference,"5711");
 assert.equal(replaced.state.pendingBuyIntake?.budget,80000);
});

test("FS preserves parsed price/reference and never asks buyer price-range language",async()=>{
 const p="15550002004"; resetState(p); const r=await handleIncomingMessage(p,"FS Rolex 116500LN 28500");
 assert.equal(r.state.pendingSellIntake?.price,28500); assert.equal(r.state.pendingSellIntake?.reference,"116500LN");
 assert.doesNotMatch(r.messages.join("\n"),/price range|searching now|external .*disabled/i);
});
