import test from "node:test";
import assert from "node:assert/strict";
import { MORE_COMMAND, MORE_NO_CONTEXT } from "./moreContext";

test("MORE command recognition is deterministic and intentionally narrow",()=>{
  for(const text of ["MORE","more","show me more","more listings","more matches","more!"]) assert.equal(MORE_COMMAND.test(text),true,text);
  for(const text of ["more rolex","some more information","approve 4",""]) assert.equal(MORE_COMMAND.test(text),false,text);
});

test("MORE no-context response is safe and contains no decision side effect",()=>{
  assert.match(MORE_NO_CONTEXT,/don’t have a recent WatchFacts match/);
  assert.doesNotMatch(MORE_NO_CONTEXT,/approved|passed|contact_phone/i);
});
