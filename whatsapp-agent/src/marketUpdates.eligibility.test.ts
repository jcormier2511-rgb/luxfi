import test from "node:test";
import assert from "node:assert/strict";
process.env.NODE_ENV="test"; process.env.WEBHOOK_TOKEN="test"; process.env.ADMIN_SESSION_SECRET="test-secret";
const {isMarketUpdateEligible}=require("./marketUpdates") as typeof import("./marketUpdates");
const eligible=(plan:"tier1"|"tier2"|"tier3"|null, paymentAuthorized:boolean|null, paymentStatus:string|null)=>isMarketUpdateEligible({plan,paymentAuthorized,paymentStatus});
test("briefings reject trial, unpaid, missing-status, and blocked accounts",()=>{ assert.equal(eligible(null,null,null),false); assert.equal(eligible("tier1",false,"active"),false); assert.equal(eligible("tier1",true,null),false); assert.equal(eligible("tier1",true,"blocked"),false); assert.equal(eligible(null,true,"paid"),false); });
test("briefings allow active paid members",()=>{ assert.equal(eligible("tier1",true,"active"),true); assert.equal(eligible("tier3",true,"paid"),true); });
