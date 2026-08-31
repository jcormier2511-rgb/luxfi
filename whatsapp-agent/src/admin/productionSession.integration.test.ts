import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import bcrypt from "bcryptjs";
import { Pool } from "pg";

process.env.NODE_ENV="production";
process.env.DATABASE_URL??="postgres://postgres:postgres@127.0.0.1:5432/luxfi_test";
process.env.ADMIN_SESSION_SECRET="production-session-integration-secret-32-bytes-minimum";
process.env.WEBHOOK_TOKEN="production-webhook-test-secret";
process.env.WHAPI_TOKEN="";

// Requires must follow the production environment setup above.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const adminStore=require("./store") as typeof import("./store");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const {createServer}=require("../server") as typeof import("../server");

const database=new Pool({connectionString:process.env.DATABASE_URL});
const app=createServer();
let server:Server;
let baseUrl="";

before(async()=>{
  await adminStore.initAdminSchema();
  await database.query("DELETE FROM admin_audit_log");
  await database.query("DELETE FROM admin_login_attempts");
  await database.query("DELETE FROM administrators");
  await database.query("INSERT INTO administrators(name,username,email,password_hash,role,status) VALUES($1,$2,$3,$4,'owner','active')",["Production Owner","production-owner","owner@example.com",await bcrypt.hash("production-passphrase",12)]);
  await new Promise<void>(resolve=>{server=app.listen(0,resolve)});
  baseUrl=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async()=>{
  await new Promise<void>(resolve=>server.close(()=>resolve()));
  await database.end();
});

test("production login survives Railway HTTPS proxy redirect and grants GET /admin access",async()=>{
  assert.equal(app.get("trust proxy"),1);
  const login=await fetch(`${baseUrl}/admin/login`,{method:"POST",redirect:"manual",headers:{"Content-Type":"application/x-www-form-urlencoded","X-Forwarded-Proto":"https","X-Forwarded-For":"203.0.113.9"},body:new URLSearchParams({username:"production-owner",password:"production-passphrase"})});
  assert.equal(login.status,303);
  assert.equal(login.headers.get("location"),"/admin");
  const setCookie=login.headers.get("set-cookie");
  assert.ok(setCookie);
  assert.match(setCookie,/Path=\/admin/);
  assert.match(setCookie,/HttpOnly/);
  assert.match(setCookie,/Secure/);
  assert.match(setCookie,/SameSite=Strict/);

  const cookie=setCookie.split(";",1)[0];
  const tamperedDashboard=await fetch(`${baseUrl}/admin`,{headers:{Cookie:`${cookie}x`,"X-Forwarded-Proto":"https","X-Forwarded-For":"203.0.113.9"}});
  assert.equal(tamperedDashboard.status,401);

  const dashboard=await fetch(`${baseUrl}/admin`,{headers:{Cookie:cookie,"X-Forwarded-Proto":"https","X-Forwarded-For":"203.0.113.9"}});
  assert.equal(dashboard.status,200);
  assert.match(await dashboard.text(),/Whapi connectivity/);
});
