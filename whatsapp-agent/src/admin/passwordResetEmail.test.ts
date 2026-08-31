import { test, mock } from "node:test";
import assert from "node:assert/strict";

process.env.RESEND_API_KEY="re_test_key";
process.env.ADMIN_PASSWORD_RESET_FROM_EMAIL="LuxFi <admin@example.com>";
process.env.ADMIN_PASSWORD_RESET_BASE_URL="https://admin.example.com/";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const email=require("./passwordResetEmail") as typeof import("./passwordResetEmail");

test("password reset email contains the one-time HTTPS link and authenticates only to Resend",async()=>{
  const fetchMock=mock.method(globalThis,"fetch",async(input:string|URL|Request,init?:RequestInit)=>{
    assert.equal(String(input),"https://api.resend.com/emails");
    assert.equal((init?.headers as Record<string,string>).Authorization,"Bearer re_test_key");
    const body=JSON.parse(String(init?.body));
    assert.deepEqual(body.to,["owner@example.com"]);
    assert.match(body.text,/https:\/\/admin\.example\.com\/admin\/reset-password\?token=one-time-token/);
    return new Response("{}",{status:200});
  });
  await email.sendAdministratorPasswordReset("owner@example.com","one-time-token");
  assert.equal(fetchMock.mock.callCount(),1);
});
