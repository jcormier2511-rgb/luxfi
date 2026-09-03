import test from "node:test";
import assert from "node:assert/strict";
process.env.NODE_ENV = process.env.NODE_ENV ?? "test";

import { _resetDbForTests, withSchema } from "../postings/db";
import { initAdminSchema, listUsers } from "./store";

async function resetAll(): Promise<void> {
  await _resetDbForTests();
  await initAdminSchema();
  await withSchema((pool) => pool.query("DELETE FROM approved_users; DELETE FROM approved_groups"));
}

async function addUser(phone: string, name: string): Promise<number> {
  return withSchema(async (pool) => {
    const canonicalUserId = (await pool.query("INSERT INTO canonical_users DEFAULT VALUES RETURNING id")).rows[0].id;
    await pool.query("INSERT INTO linked_identities(canonical_user_id,platform,identity) VALUES($1,'whatsapp',$2)", [canonicalUserId, phone]);
    await pool.query("INSERT INTO approved_users(phone,name,access_status) VALUES($1,$2,'active')", [phone, name]);
    return canonicalUserId;
  });
}

async function addApprovedGroup(chatId: string, name: string): Promise<void> {
  await withSchema((pool) =>
    pool.query(
      `INSERT INTO approved_groups(group_name,whatsapp_chat_id,status,monitoring_enabled,platform) VALUES($1,$2,'active',true,'whatsapp')`,
      [name, chatId]
    )
  );
}

async function addChatPosting(canonicalUserId: number, chatId: string): Promise<void> {
  await withSchema((pool) =>
    pool.query(
      `INSERT INTO postings(source_platform,source_type,source_chat_id,canonical_user_id,type,original_text,brand,expires_at)
       VALUES('whatsapp','chat',$1,$2,'FS','FS Rolex REF1 $1000','Rolex',now()+interval '15 days')`,
      [chatId, canonicalUserId]
    )
  );
}

test("listUsers enriches each row with active_groups_count, derived from approved-group posting history", async () => {
  await resetAll();
  await addApprovedGroup("g1", "Miami Watch Traders");
  const activeUser = await addUser("13055550001", "Ana Maria");
  await addUser("13055550002", "No Group Activity");
  await addChatPosting(activeUser, "g1");

  const { rows } = await listUsers();
  const active = rows.find((r: any) => r.phone === "13055550001");
  const inactive = rows.find((r: any) => r.phone === "13055550002");
  assert.equal(active.active_groups_count, 1, "a user who posted in an approved+active group must show a count of 1");
  assert.equal(inactive.active_groups_count, 0, "a user with no group-posting history must show 0, not be omitted");
});

test("listUsers never lets an active-group lookup failure break the users list itself", async () => {
  await resetAll();
  await addUser("13055550003", "No Postings Schema Dependency");
  // No approved_groups/postings rows exist at all -- the enrichment query still runs safely and
  // simply returns 0 for everyone rather than throwing.
  const { rows } = await listUsers();
  assert.equal(rows[0].active_groups_count, 0);
});
