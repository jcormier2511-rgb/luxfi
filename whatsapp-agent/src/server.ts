import express from "express";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { config, isConciergeAdminPhone } from "./config";
import { extractIncomingMessages, IncomingWebhook } from "./whapi/client";
import { sendText, NormalizedIncomingMessage } from "./channels";
import { platformForIdentity } from "./channels/identity";
import { verifyTelegramSecret, extractIncomingMessages as extractTelegramMessages } from "./channels/telegram";
import { verifyTwilioSignature, extractIncomingMessage as extractSmsMessage } from "./channels/sms";
import { alreadyProcessed, getState, resetState, markPendingEscrowOffer } from "./conversation/stateStore";
import { handleIncomingMessage } from "./conversation/flow";
import { handleGroupMessage } from "./conversation/groupMonitor";
import { getTierABContacts, loadContacts } from "./data/contactsStore";
import { getActiveListings, getSyncStatus, searchListingsForDiagnostics } from "./watchfacts/inventoryDb";
import {
  getEntitlement,
  setManualOverride,
  setPlan,
  getCheckoutSession,
  markCheckoutSessionStatus,
  setCheckoutSessionProfileId,
  findCheckoutSessionByProfileId,
  activateMembership,
  cancelMembership,
  findPhoneByAuthnetSubscriptionId,
  claimCheckoutSessionForActivation,} from "./billing/entitlementStore";
import { isPlanKey } from "./billing/plans";
import {
  isAuthorizeNetConfigured,
  createCustomerProfile,
  createHostedProfilePageToken,
  hostedProfilePageFormActionUrl,
  createProfileTransaction,
  createArbSubscription,
  verifyWebhookSignature as verifyAuthorizeNetSignature,
  AuthorizeNetWebhookEvent,
} from "./billing/authorizeNet";
import { recordMembershipPayment } from "./postings/approvalUsage";
import { handleIncomingSellerPhoto } from "./matching/photoRequests";
import { approveMatch, passMatch, ApprovalOutcome, formatMatchPresentation } from "./postings/notify";
import { runCheckoutReconciliation, activateClaimedCheckout } from "./billing/checkoutReconciliation";
import { runReconciliation } from "./postings/matching";
import { getOrCreateCanonicalUser } from "./postings/identity";
import { getPosting, extendPosting, getOwnPostingForMatch } from "./postings/postingsStore";
import { getV4OperationalStatus } from "./postings/status";
import { initSchema } from "./postings/db";
import { handleCoverageCommand } from "./fulfillment/coverage";
import { handleOpportunityResponse, listCoverageAdmin } from "./fulfillment/service";
import { planOutreachBatch, executeOutreachBatch } from "./outreach/blast";
import { readBlastStatus } from "./outreach/status";
import { runInventorySync } from "./watchfacts/syncInventory";
import { previewFiReturningCampaign, runFiReturningCampaign } from "./campaigns/fiReturning";
import { runOpenAiDiagnosticCall } from "./ai/providers/openai";
import { listDesignatedGroups, enableGroup, disableGroup, setReferenceRequestsEnabled } from "./concierge/groupRegistry";
import {
  SESSION_COOKIE_NAME,
  buildLogoutCookieHeader,
  buildSessionCookieHeader,
  createSessionToken,
  createAdministratorSession,
  isHttpsRequest,
  isValidAdminToken,
  isValidSessionToken,
  readAdministratorSession,
  parseCookies,
} from "./admin/session";
import { Administrator, authenticate, deleteGroup, deleteUser, exportUsersCsv, getAdministrator, importUsersCsv, initAdminSchema, listAdministrators, listGroups, listUsers, resetAdministratorPassword, saveAdministrator, saveGroup, saveUser, USER_CSV_SAMPLE } from "./admin/store";
import { buildAdminDashboardData } from "./admin/dashboard";
import { renderDashboard, renderLoginPage, renderManagementPage } from "./admin/view";
import { getListingLimits, listPushGroups, savePushGroup, setListingLimits } from "./postings/listingConfig";
import { getLifecycleSettings, recordInboundActivity, setLifecycleSettings } from "./lifecycle";

// Fi Build Spec v4 §9: notifications from the new Postgres-backed automatic matching system
// (src/postings/) carry their own numeric match id — distinct from the v3 on-demand flow's
// per-conversation "approve <n>" list index (src/conversation/flow.ts). Both use the same
// "approve <n>" / "pass <n>" wording, so v3's own pending-match list always takes priority
// when one is open; only when there's nothing pending in v3 is the number tried as a v4
// Postgres match id, falling through to the ordinary flow if it doesn't resolve to one.
const V4_DECISION_PATTERN = /^(approve|pass)\s+(\d+)\b/i;

export function formatApprovalOutcome(outcome: ApprovalOutcome, matchId: number): string {
  const approved = outcome.match ? formatMatchPresentation(matchId, "Seller/Buyer", outcome.match, "Approved Match") : `Approved Match ${matchId}`;
  switch (outcome.status) {
    case "approved":
      return outcome.counterpart
        ? `${approved}\n\nYou're connected! ${outcome.counterpart.name}: ${outcome.counterpart.phone}\n\n${config.fiFlow.escrowSuggestion}`
        : `${approved}.`;
    case "pending_confirmation":
      return `${approved}\n\nI'll let you know as soon as the other side confirms too.`;
    case "posting_closed":
      return `That listing has already reached its match limit, so this one can't be approved.`;
    case "locked":
      return outcome.lockReason === "weekly_cap"
        ? config.fiFlow.weeklyCapMessage(outcome.plan!, outcome.weeklyLimit!)
        : config.fiFlow.noPlanMessage;
    case "invalid":
      return `I couldn't find match ${matchId}.`;
  }
}

export async function tryHandleV4Decision(phone: string, text: string): Promise<string | null> {
  if (!config.postingsV4.enabled) return null; // whole v4 surface stays inert until verified
  if (getState(phone).pendingMatches) return null; // v3 flow owns this reply
  const m = text.trim().match(V4_DECISION_PATTERN);
  if (!m) return null;
  const matchId = parseInt(m[2], 10);

  if (m[1].toLowerCase() === "approve") {
    const outcome = await approveMatch(matchId, phone);
    if (outcome.status === "invalid") return null; // not a real v4 match id either — fall through
    if (outcome.status === "approved" && outcome.counterpart) markPendingEscrowOffer(phone);
    return formatApprovalOutcome(outcome, matchId);
  }

  const result = await passMatch(matchId, phone);
  if (result === "invalid") return null;
  return result === "passed" ? `Passing on match ${matchId}.` : `You already decided on match ${matchId}.`;
}

/**
 * A person's own "sell a watch" conversational intake (conversation/flow.ts, source_type=
 * 'direct') gets matched to buyers even though ENABLE_V4_POSTINGS-gated group-chat monitoring
 * is off — it's a narrower, always-on, explicit-consent feature, not the broad rollout that
 * flag controls. So its "approve <matchId>"/"pass <matchId>" replies need their own handler,
 * deliberately NOT behind that flag — tryHandleV4Decision above stays exactly as it is (and as
 * server.v4Decision.test.ts requires: it must stay a total no-op while the flag is off) for
 * every other posting. Scoping is by ownership + source_type: only a match where the sender
 * owns a 'direct'-sourced side is handled here; anything else falls through (returns null) so
 * tryHandleV4Decision (when enabled) or the ordinary flow gets a turn at it.
 */
export async function tryHandleDirectPostingDecision(phone: string, text: string): Promise<string | null> {
  if (getState(phone).pendingMatches) return null; // v3 flow owns this reply
  const m = text.trim().match(V4_DECISION_PATTERN);
  if (!m) return null;
  const matchId = parseInt(m[2], 10);

  const canonicalUserId = await getOrCreateCanonicalUser(platformForIdentity(phone), phone);
  const mine = await getOwnPostingForMatch(matchId, canonicalUserId);
  if (!mine || mine.source_type !== "direct") return null; // not a direct-sourced decision

  if (m[1].toLowerCase() === "approve") {
    const outcome = await approveMatch(matchId, phone);
    if (outcome.status === "invalid") return null;
    if (outcome.status === "approved" && outcome.counterpart) markPendingEscrowOffer(phone);
    return formatApprovalOutcome(outcome, matchId);
  }

  const result = await passMatch(matchId, phone);
  if (result === "invalid") return null;
  return result === "passed" ? `Passing on match ${matchId}.` : `You already decided on match ${matchId}.`;
}

const V4_EXTEND_PATTERN = /^extend\s+(\d+)\b/i;

/**
 * Spec: prove the "extend" action a reminder promises actually works. Ownership is checked
 * before extending (a posting id belongs to whoever's canonical_user_id it carries) — an
 * unrecognized or not-mine id returns null (falls through to the ordinary flow) rather than
 * confirming or denying that a given id exists, so this can't be used to probe ids.
 */
export async function tryHandleV4Extend(phone: string, text: string): Promise<string | null> {
  if (!config.postingsV4.enabled) return null;
  const m = text.trim().match(V4_EXTEND_PATTERN);
  if (!m) return null;
  const postingId = parseInt(m[1], 10);

  const canonicalUserId = await getOrCreateCanonicalUser(platformForIdentity(phone), phone);
  const posting = await getPosting(postingId);
  if (!posting || posting.canonical_user_id !== canonicalUserId) return null;

  const extended = await extendPosting(postingId);
  if (!extended) return `That listing is no longer active, so it can't be extended.`;
  return `Renewed — active for 15 more days.`;
}

/**
 * Channel-agnostic per-message pipeline, shared by every webhook route (WhatsApp, Telegram,
 * SMS — see channels/). Each channel's own route parses its provider's raw payload into this
 * same normalized shape (channels/types.ts's NormalizedIncomingMessage) before calling this.
 */
export async function processIncomingMessages(incoming: NormalizedIncomingMessage[]): Promise<void> {
  const filtered = incoming.filter((m) => !alreadyProcessed(m.id));

  for (const message of filtered) {
    try {
      await recordInboundActivity(message.phone, message.senderName, new Date(), !message.isGroup);
      if (message.isGroup) {
        await handleGroupMessage(message.id, message.groupId!, message.phone, message.senderName, message.text, message.imageUrl);
        continue;
      }
      if (message.imageUrl && await handleIncomingSellerPhoto(message.phone, message.imageUrl)) continue;

      const fulfillmentReply = await handleOpportunityResponse(message.phone, message.text) ?? await handleCoverageCommand(message.phone, message.text);
      if (fulfillmentReply !== null) { await sendText(message.phone, fulfillmentReply); continue; }

      const directReply = await tryHandleDirectPostingDecision(message.phone, message.text);
      if (directReply !== null) {
        await sendText(message.phone, directReply);
        continue;
      }

      const v4Reply = await tryHandleV4Decision(message.phone, message.text);
      if (v4Reply !== null) {
        await sendText(message.phone, v4Reply);
        continue;
      }
      const v4ExtendReply = await tryHandleV4Extend(message.phone, message.text);
      if (v4ExtendReply !== null) {
        await sendText(message.phone, v4ExtendReply);
        continue;
      }

      const contact = getTierABContacts().find((c) => c.phone === message.phone);
      const { messages } = await handleIncomingMessage(message.phone, message.text, contact, message.imageUrl);
      for (const reply of messages) await sendText(message.phone, reply);
    } catch (err) {
      console.error(`[webhook] failed handling message from ${message.phone}:`, err);
    }
  }
}

/** Processes the payload received by the live /webhook (WhatsApp) route after its immediate ACK. */
export async function handleWebhookPayload(body: IncomingWebhook): Promise<void> {
  await processIncomingMessages(extractIncomingMessages(body));
}

/**
 * Processes one verified Authorize.net webhook event after POST /webhook/authorizenet's
 * immediate ACK. Exported (mirroring handleWebhookPayload above) so tests can drive it directly
 * without needing a live signed HTTP request.
 *
 * net.authorize.customer.paymentProfile.created: the ONLY successful-checkout path — fires once
 * the CIM Hosted Profile Page (see billing/authorizeNet.ts's createHostedProfilePageToken)
 * actually saves a card, which is the one unambiguous signal that a payment method exists to
 * charge (three earlier live attempts to infer this from Accept Hosted's checkout flow instead
 * all came back with no profile at all). Looks up which checkout session created this
 * customerProfileId (findCheckoutSessionByProfileId -- the only correlation Authorize.net's
 * side gives us for this event), charges month 1 directly against the new payment profile, sets
 * up ARB for month 2 onward, activates the membership, and records the real charge in
 * billing_ledger. Guards against replays/unknown sessions by only acting on a still-"pending"
 * checkout session.
 *
 * subscription suspended/cancelled/terminated: treated identically (revoke the membership) —
 * Authorize.net's own docs describe "suspended" narrowly (first payment after creation/edit
 * declined), but there's no safe reading where an account keeps an active plan while its
 * subscription is in any of these three states, so all three clear it the same way.
 */
export async function handleAuthorizeNetWebhookEvent(event: AuthorizeNetWebhookEvent): Promise<void> {
  // Every branch below that stops processing logs WHY -- a fully successful run used to print
  // nothing at all, which was indistinguishable in Railway's logs from "the webhook never
  // arrived." Confirmed live: a real sandbox payment showed no membership activation and no
  // log line either, with no way to tell which of the two had happened.
  console.log(`[webhook/authorizenet] received eventType=${event.eventType} notificationId=${event.notificationId} payloadId=${event.payload.id}`);

  if (event.eventType === "net.authorize.customer.paymentProfile.created") {
    const customerPaymentProfileId = event.payload.id;
    const customerProfileId = typeof event.payload.customerProfileId === "string" ? event.payload.customerProfileId : undefined;
    if (!customerPaymentProfileId || !customerProfileId) {
      console.warn("[webhook/authorizenet] paymentProfile.created event missing id/customerProfileId -- ignoring");
      return;
    }
    const found = await findCheckoutSessionByProfileId(customerProfileId);
    console.log(`[webhook/authorizenet] paymentProfile ${customerPaymentProfileId} for profile ${customerProfileId}: checkoutSession=${found?.id ?? "none"}`);
    if (!found) {
      console.warn(`[webhook/authorizenet] checkout session for profile ${customerProfileId} not found -- skipping`);
      return;
    }
    // Claiming, rather than reading the status and then acting on it: the reconciliation sweep
    // (billing/checkoutReconciliation.ts) can now activate the same checkout, and a read-then-act
    // check cannot keep two activators from both seeing "pending" and both charging the card.
    // Exactly one claim succeeds; the loser stops here.
    const session = await claimCheckoutSessionForActivation(found.id);
    if (!session) {
      console.warn(`[webhook/authorizenet] checkout session ${found.id} is "${found.status}" or already claimed -- skipping (duplicate delivery or reconciliation in flight)`);
      return;
    }
    await activateClaimedCheckout(session, customerProfileId, customerPaymentProfileId, "webhook");
    return;
  }

  if (event.payload.entityName === "subscription" && /\.(suspended|cancelled|terminated)$/.test(event.eventType)) {
    const subscriptionId = event.payload.id;
    if (!subscriptionId) {
      console.warn("[webhook/authorizenet] subscription event had no payload.id -- ignoring");
      return;
    }
    const phone = await findPhoneByAuthnetSubscriptionId(subscriptionId);
    if (!phone) {
      console.warn(`[webhook/authorizenet] no account found for subscriptionId=${subscriptionId} -- nothing to cancel`);
      return;
    }
    await cancelMembership(phone);
    console.log(`[webhook/authorizenet] canceled membership for phone=${phone} (subscriptionId=${subscriptionId})`);
  }
}

function verifyWhatsAppSignature(rawBody: Buffer, signature: string | undefined): boolean {
  if (!config.server.whatsappAppSecret || !signature?.startsWith("sha256=")) return false;
  const supplied = signature.slice("sha256=".length);
  if (!/^[a-fA-F0-9]{64}$/.test(supplied)) return false;
  const expected = crypto.createHmac("sha256", config.server.whatsappAppSecret).update(rawBody).digest();
  return crypto.timingSafeEqual(expected, Buffer.from(supplied, "hex"));
}

export function createServer() {
  const app = express();
  // Railway terminates TLS at its nearest proxy. Trust exactly that hop so Express derives
  // req.secure and the throttling client IP from Railway's X-Forwarded-* headers.
  app.set("trust proxy", 1);
  // Meta signs the exact bytes sent on the wire. Keep those bytes alongside the parsed JSON;
  // re-serializing req.body can change whitespace/key ordering and invalidate a genuine event.
  app.use(express.json({
    verify: (req, _res, body) => {
      (req as express.Request & { rawBody?: Buffer }).rawBody = Buffer.from(body);
    },
  }));
  const adminReady = initAdminSchema();

  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  function hasAdminSession(req: express.Request): boolean {
    const cookies = parseCookies(req.headers.cookie);
    return isValidSessionToken(cookies[SESSION_COOKIE_NAME]);
  }
  async function adminContext(req:express.Request):Promise<{admin:Administrator;csrfToken:string}|null>{await adminReady;const session=readAdministratorSession(parseCookies(req.headers.cookie)[SESSION_COOKIE_NAME]);if(!session)return null;const admin=await getAdministrator(session.administratorId);return admin?{admin,csrfToken:session.csrfToken}:null}
  const csrfOk=(req:express.Request,csrf:string)=>typeof req.headers["x-csrf-token"]==='string'&&req.headers["x-csrf-token"]===csrf;
  const api=(handler:(req:express.Request,res:express.Response,ctx:{admin:Administrator;csrfToken:string})=>Promise<any>,modify=false)=>async(req:express.Request,res:express.Response)=>{try{const ctx=await adminContext(req);if(!ctx)return res.status(401).json({error:"not signed in"});if(modify&&(!csrfOk(req,ctx.csrfToken)||ctx.admin.role==='read_only'))return res.status(ctx.admin.role==='read_only'?403:419).json({error:ctx.admin.role==='read_only'?"read-only role":"invalid CSRF token"});await handler(req,res,ctx)}catch(e){res.status(400).json({error:(e as Error).message})}};

  // Visual admin panel — read-only status for Whapi, Postgres/schema, market updates, v4
  // postings, WatchFacts sync, and AI matching (no secrets), plus the contacts CSV upload
  // workflow. Authenticated against WEBHOOK_TOKEN like every other /admin/* route, but via a
  // login form + signed session cookie (see ./admin/session) rather than a token in the URL —
  // a URL is logged, cached, and shared far more casually than a submitted form value.
  app.get("/admin", async (req, res) => {
    const ctx=await adminContext(req).catch(()=>null);
    if (!ctx && !hasAdminSession(req)) {
      return res.status(401).type("html").send(renderLoginPage());
    }
    const data = await buildAdminDashboardData();
    res.type("html").send(renderDashboard(data));
  });
  for(const kind of ["users","groups","administrators","coverage"] as const) app.get(`/admin/${kind}`,async(req,res)=>{const ctx=await adminContext(req).catch(()=>null);if(!ctx)return res.status(401).type('html').send(renderLoginPage());if(kind==='administrators'&&ctx.admin.role!=='owner')return res.status(403).send('Owner role required');res.type('html').send(renderManagementPage(kind))});

  app.post("/admin/login", express.urlencoded({ extended: false }), async (req, res) => {
    await adminReady;
    // The old token form exists only for the pre-Phase-1 regression suite. It is deliberately
    // checked before account throttling so empty usernames from that form cannot pollute the
    // real administrator login-attempt ledger or rate-limit later compatibility requests.
    const legacy=process.env.NODE_ENV==='test'&&typeof req.body?.token==='string'&&isValidAdminToken(req.body.token);
    if(legacy){res.setHeader("Set-Cookie", buildSessionCookieHeader(createSessionToken(), isHttpsRequest(req)));return res.redirect(303,"/admin")}
    if(process.env.NODE_ENV==='test'&&typeof req.body?.token==='string')return res.status(401).type("html").send(renderLoginPage("Invalid token."));
    const username=typeof req.body?.username==='string'?req.body.username:'';const password=typeof req.body?.password==='string'?req.body.password:'';
    const result=await authenticate(username,password,req.ip||"unknown");
    if(result.limited)return res.status(429).type("html").send(renderLoginPage("Too many attempts. Try again later."));
    if(result.admin){res.setHeader("Set-Cookie",buildSessionCookieHeader(createAdministratorSession(result.admin.id),isHttpsRequest(req)));return res.redirect(303,"/admin")}
    return res.status(401).type("html").send(renderLoginPage("Invalid username or password."));
  });

  app.get("/admin/api/session",api(async(_q,res,ctx)=>res.json({administrator:ctx.admin,csrfToken:ctx.csrfToken})));
  app.get("/admin/api/administrators",api(async(_q,res,ctx)=>{if(ctx.admin.role!=="owner")return res.status(403).json({error:"owner role required"});res.json(await listAdministrators())}));
  app.post("/admin/api/administrators",api(async(req,res,ctx)=>res.status(201).json(await saveAdministrator(ctx.admin,req.body)),true));
  app.put("/admin/api/administrators/:id",api(async(req,res,ctx)=>res.json(await saveAdministrator(ctx.admin,req.body,Number(req.params.id))),true));
  app.post("/admin/api/administrators/:id/reset-password",api(async(req,res,ctx)=>{await resetAdministratorPassword(ctx.admin,Number(req.params.id),String(req.body.password||''));res.json({ok:true})},true));
  app.get("/admin/api/users",api(async(req,res)=>res.json(await listUsers(String(req.query.q||''),String(req.query.status||''),Number(req.query.page||1)))));
  app.post("/admin/api/users",api(async(req,res,ctx)=>res.status(201).json(await saveUser(ctx.admin,req.body)),true));
  app.put("/admin/api/users/:id",api(async(req,res,ctx)=>res.json(await saveUser(ctx.admin,req.body,Number(req.params.id))),true));
  app.delete("/admin/api/users/:id",api(async(req,res,ctx)=>{await deleteUser(ctx.admin,Number(req.params.id));res.json({ok:true})},true));
  app.post("/admin/api/users/import",express.text({type:"*/*",limit:"20mb"}),api(async(req,res,ctx)=>res.json(await importUsersCsv(ctx.admin,String(req.body))),true));
  app.get("/admin/api/users/template.csv",(_q,res)=>res.type("text/csv").attachment("approved-users-template.csv").send(USER_CSV_SAMPLE));
  app.get("/admin/api/users/export.csv",api(async(_q,res)=>res.type("text/csv").attachment("approved-users.csv").send(await exportUsersCsv())));
  app.get("/admin/api/groups",api(async(req,res)=>res.json(await listGroups(String(req.query.q||''),String(req.query.status||'')))));
  app.get("/admin/api/coverage",api(async(_req,res)=>res.json(await listCoverageAdmin())));
  app.post("/admin/api/groups",api(async(req,res,ctx)=>res.status(201).json(await saveGroup(ctx.admin,req.body)),true));
  app.put("/admin/api/groups/:id",api(async(req,res,ctx)=>res.json(await saveGroup(ctx.admin,req.body,Number(req.params.id))),true));
  app.delete("/admin/api/groups/:id",api(async(req,res,ctx)=>{await deleteGroup(ctx.admin,Number(req.params.id));res.json({ok:true})},true));
  app.get("/admin/api/listing-settings",api(async(_req,res)=>res.json({limits:await getListingLimits(),pushGroups:await listPushGroups()})));
  app.put("/admin/api/listing-settings/limits",api(async(req,res)=>res.json(await setListingLimits(req.body)),true));
  app.get("/admin/api/campaigns/fi-returning",api(async(_req,res)=>res.json(await previewFiReturningCampaign())));
  app.post("/admin/api/campaigns/fi-returning",api(async(req,res,ctx)=>{
    if(ctx.admin.role==='read_only'||ctx.admin.role==='support')return res.status(403).json({error:'administrator role required'});
    const dryRun=req.body?.dryRun===true;const testRecipient=typeof req.body?.testRecipient==='string'?req.body.testRecipient:undefined;
    if(!dryRun&&req.body?.confirm!==true)return res.status(400).json({error:'confirm=true is required to send'});
    res.json(await runFiReturningCampaign({dryRun,testRecipient}));
  },true));
  app.put("/admin/api/listing-settings/push-groups/:groupId",api(async(req,res)=>res.json(await savePushGroup({...req.body,group_id:req.params.groupId})),true));

  app.get("/admin/logout", (req, res) => {
    res.setHeader("Set-Cookie", buildLogoutCookieHeader(isHttpsRequest(req)));
    res.redirect(303, "/admin");
  });

  function saveContactsCsv(body: string): number {
    fs.mkdirSync(path.dirname(config.data.contactsCsv), { recursive: true });
    fs.writeFileSync(config.data.contactsCsv, body);
    return loadContacts(true).length;
  }

  // Session-authenticated counterpart to POST /admin/upload/contacts below, for the panel's own
  // upload form — same effect (replace + reload contacts.csv), just gated on the browser session
  // instead of a token query param, since the panel deliberately never puts the token in a URL.
  app.post("/admin/panel/upload-contacts", express.text({ type: "*/*", limit: "20mb" }), async (req, res) => {
    const ctx=await adminContext(req);
    const legacyTestSession=process.env.NODE_ENV==='test'&&hasAdminSession(req);
    if(!ctx&&!legacyTestSession)return res.status(401).json({error:"not signed in"});
    if(ctx&&ctx.admin.role==='read_only')return res.status(403).json({error:"read-only role"});
    if(ctx&&!csrfOk(req,ctx.csrfToken))return res.status(419).json({error:"invalid CSRF token"});
    const contacts = saveContactsCsv(req.body);
    res.json({ ok: true, bytes: req.body.length, contacts });
  });

  // Whapi.Cloud webhook receiver. Configure this URL as the channel's webhook (Settings →
  // Webhooks) with the "messages" event enabled.
  app.post("/webhook", async (req, res) => {
    if (!isValidAdminToken(String(req.query.token ?? ""))) {
      return res.status(401).json({ error: "invalid token" });
    }
    // Ack immediately — Whapi retries on slow/failed responses.
    res.status(200).json({ ok: true });

    await handleWebhookPayload(req.body as IncomingWebhook);
  });

  app.get("/webhook/whatsapp", (req, res) => {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];
    if (config.server.whatsappWebhookVerifyToken && mode === "subscribe" &&
        token === config.server.whatsappWebhookVerifyToken && typeof challenge === "string") {
      return res.status(200).type("text/plain").send(challenge);
    }
    return res.sendStatus(403);
  });

  app.post("/webhook/whatsapp", (req, res) => {
    if (!config.server.whatsappAppSecret) {
      return res.status(503).json({ error: "WHATSAPP_APP_SECRET is not configured" });
    }
    const rawBody = (req as express.Request & { rawBody?: Buffer }).rawBody;
    if (!rawBody || !verifyWhatsAppSignature(rawBody, req.header("x-hub-signature-256"))) {
      return res.sendStatus(401);
    }
    return res.sendStatus(200);
  });

  // Telegram Bot API webhook receiver. Register via a one-time
  // `POST https://api.telegram.org/bot<token>/setWebhook` call with
  // url=<this deployment>/webhook/telegram and secret_token=TELEGRAM_WEBHOOK_SECRET — Telegram
  // then echoes that secret back on every call in X-Telegram-Bot-Api-Secret-Token, which is how
  // this route authenticates inbound updates (Telegram has no HMAC-signed body). Fails closed
  // (503) while TELEGRAM_WEBHOOK_SECRET is unset, same posture as every other channel here.
  app.post("/webhook/telegram", async (req, res) => {
    if (!config.channels.telegram.webhookSecret) {
      return res.status(503).json({ error: "TELEGRAM_WEBHOOK_SECRET is not configured" });
    }
    if (!verifyTelegramSecret(req.header("x-telegram-bot-api-secret-token"))) {
      return res.sendStatus(401);
    }
    res.sendStatus(200);
    try {
      const messages = await extractTelegramMessages(req.body);
      await processIncomingMessages(messages);
    } catch (err) {
      console.error("[webhook/telegram] failed handling update:", err);
    }
  });

  // Twilio SMS/MMS webhook receiver. Configure this URL as the number's "A message comes in"
  // webhook in the Twilio console. Verifies X-Twilio-Signature before processing anything —
  // fails closed (503) while TWILIO_AUTH_TOKEN is unset. Twilio expects an immediate response;
  // an empty TwiML body acknowledges without an auto-reply, since Fi replies via the separate
  // channels/sms.ts REST call instead.
  app.post("/webhook/sms", express.urlencoded({ extended: false }), async (req, res) => {
    if (!config.channels.sms.authToken) {
      return res.status(503).json({ error: "TWILIO_AUTH_TOKEN is not configured" });
    }
    const url = config.channels.sms.webhookBaseUrl
      ? `${config.channels.sms.webhookBaseUrl.replace(/\/$/, "")}${req.originalUrl}`
      : `${req.protocol}://${req.get("host")}${req.originalUrl}`;
    if (!verifyTwilioSignature(url, req.body, req.header("x-twilio-signature"))) {
      return res.sendStatus(401);
    }
    res.status(200).type("text/xml").send("<Response></Response>");
    try {
      const message = extractSmsMessage(req.body);
      if (message) await processIncomingMessages([message]);
    } catch (err) {
      console.error("[webhook/sms] failed handling message:", err);
    }
  });

  // Real payment link Fi sends in chat (see conversation/flow.ts's join/upgrade handling and
  // billing/entitlementStore.ts's createCheckoutSession) — a whatsapp-agent-hosted page whose
  // ONLY job is to auto-submit the CIM Hosted Profile Page token to Authorize.net's own
  // customer/manage page, since that page requires a POSTed form field rather than a plain URL.
  // The profile+token are (re)created fresh on every visit (the token itself expires 15 minutes
  // after issuance, and createCustomerProfile is idempotent -- see its own comment on E00039)
  // rather than up front when the checkout session is created, so a link sitting unread in chat
  // for a day still works the moment it's opened.
  app.get("/pay/:id", async (req, res) => {
    if (!isAuthorizeNetConfigured()) {
      return res.status(503).type("text/plain").send("Payments are not configured yet.");
    }
    const session = await getCheckoutSession(req.params.id);
    if (!session) {
      return res.status(404).type("text/plain").send("This payment link is invalid or has expired.");
    }
    if (session.status !== "pending") {
      return res.type("text/plain").send("This payment link has already been used.");
    }
    let token: string;
    try {
      const customerProfileId = await createCustomerProfile(session.id);
      await setCheckoutSessionProfileId(session.id, customerProfileId);
      token = await createHostedProfilePageToken({ customerProfileId, checkoutSessionId: session.id });
    } catch (err) {
      console.error("[GET /pay/:id] failed to create hosted profile page token:", err);
      return res.status(502).type("text/plain").send("Payments are temporarily unavailable — please try again in a moment.");
    }
    // Auto-submitting form, not a redirect: the hosted page requires the token as a POSTed form
    // field, not a query parameter. Escaped defensively even though the token is Authorize.net's
    // own API response, never user input.
    const escapedToken = token.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
    res.type("html").send(
      `<!doctype html><html><body onload="document.forms[0].submit()">` +
        `<form method="POST" action="${hostedProfilePageFormActionUrl()}"><input type="hidden" name="token" value="${escapedToken}"></form>` +
        `<p>Redirecting to secure payment…</p></body></html>`
    );
  });

  // Authorize.net webhook receiver — the ONLY non-admin path that can activate or cancel a Fi
  // membership (see handleAuthorizeNetWebhookEvent above). Register this exact URL (this
  // deployment's base URL + /webhook/authorizenet) in the Authorize.net Merchant Interface
  // under Account > Settings > Webhooks, subscribed to at least:
  // net.authorize.customer.paymentProfile.created, net.authorize.customer.subscription.suspended,
  // net.authorize.customer.subscription.cancelled, net.authorize.customer.subscription.terminated.
  // Fails closed (503) while AUTHORIZENET_SIGNATURE_KEY is unset, same posture as every other
  // webhook here.
  app.post("/webhook/authorizenet", async (req, res) => {
    if (!config.billing.authorizeNet.signatureKey) {
      console.warn("[webhook/authorizenet] request received but AUTHORIZENET_SIGNATURE_KEY is not configured -- rejecting with 503");
      return res.status(503).json({ error: "AUTHORIZENET_SIGNATURE_KEY is not configured" });
    }
    const rawBody = (req as express.Request & { rawBody?: Buffer }).rawBody;
    if (!rawBody || !verifyAuthorizeNetSignature(rawBody, req.header("x-anet-signature"))) {
      console.warn(`[webhook/authorizenet] request rejected: ${rawBody ? "invalid signature" : "no raw body captured"} (X-ANET-Signature present: ${Boolean(req.header("x-anet-signature"))})`);
      return res.sendStatus(401);
    }
    res.sendStatus(200); // ack immediately — Authorize.net retries on slow/failed responses
    try {
      await handleAuthorizeNetWebhookEvent(req.body as AuthorizeNetWebhookEvent);
    } catch (err) {
      console.error("[webhook/authorizenet] failed handling event:", (req.body as AuthorizeNetWebhookEvent)?.eventType, err);
    }
  });

  // Manual trigger to kick off the Tier A/B blast over HTTP instead of the CLI script.
  // At OUTREACH_RATE_PER_HOUR pacing a batch can take hours, so this only plans the
  // batch synchronously and returns immediately — the actual sends happen in the
  // background and progress is polled via GET /outreach/status.
  // Protect this behind the same webhook token since it sends real messages.
  app.post("/outreach/start", (req, res) => {
    if (!isValidAdminToken(String(req.query.token ?? ""))) {
      return res.status(401).json({ error: "invalid token" });
    }
    if (readBlastStatus().state === "running") {
      return res.status(409).json({ error: "a blast is already running — check /outreach/status" });
    }
    const plan = planOutreachBatch();
    res.json({
      started: true,
      batchSize: plan.batch.length,
      alreadyContacted: plan.alreadyContacted,
      remainingAfterBatch: plan.remainingAfterBatch,
      etaHours: config.outreach.ratePerHour > 0 ? +(plan.batch.length / config.outreach.ratePerHour).toFixed(1) : null,
    });
    executeOutreachBatch(plan).catch((err) => {
      console.error("[outreach] batch failed:", err);
    });
  });

  app.get("/outreach/status", (req, res) => {
    if (!isValidAdminToken(String(req.query.token ?? ""))) {
      return res.status(401).json({ error: "invalid token" });
    }
    res.json(readBlastStatus());
  });

  // Real contacts.csv is git-ignored on purpose, so a fresh deploy's persistent volume starts
  // empty. This lets you push the real file onto a running deployment (e.g.
  // `curl --data-binary @contacts.csv "https://<host>/admin/upload/contacts?token=..."`)
  // without needing shell/SSH access to the container. WatchFacts inventory has no equivalent
  // upload path — it's populated only by syncing from the real API (see /admin/sync-inventory).
  const csvUpload = express.text({ type: "*/*", limit: "20mb" });

  app.post("/admin/upload/contacts", csvUpload, (req, res) => {
    if (!isValidAdminToken(String(req.query.token ?? ""))) {
      return res.status(401).json({ error: "invalid token" });
    }
    const contacts = saveContactsCsv(req.body);
    res.json({ ok: true, bytes: req.body.length, contacts });
  });

  // Read-only view of what group monitoring has captured so far — since it accumulates
  // silently (no reply into the group), this is the only way to confirm it's working
  // without SSH/shell access to the container.
  app.get("/admin/group-listings", (req, res) => {
    if (!isValidAdminToken(String(req.query.token ?? ""))) {
      return res.status(401).json({ error: "invalid token" });
    }
    if (!fs.existsSync(config.data.groupListingsCsv)) {
      return res.json({ ok: true, count: 0, csv: "" });
    }
    const csv = fs.readFileSync(config.data.groupListingsCsv, "utf-8");
    const count = csv.trim().split("\n").length - 1; // minus header
    res.json({ ok: true, count, csv });
  });

  // Self-hosts the banner image when there's no third-party URL to point BANNER_IMAGE_URL at:
  // `curl --data-binary @banner.jpg "https://<host>/admin/upload/banner?token=..."` writes it
  // to the persisted assets dir, served back out at /assets/<file>. Whapi's /messages/image
  // endpoint fetches media from a URL server-side, so this host must be public — that's why
  // PUBLIC_BASE_URL has to be set for the response's suggested `url` field to be usable.
  app.post("/admin/upload/banner", express.raw({ type: "*/*", limit: "15mb" }), (req, res) => {
    if (!isValidAdminToken(String(req.query.token ?? ""))) {
      return res.status(401).json({ error: "invalid token" });
    }
    const ext = typeof req.query.ext === "string" ? req.query.ext.replace(/[^a-z0-9]/gi, "") || "jpg" : "jpg";
    const filename = `banner.${ext}`;
    fs.mkdirSync(config.assets.dir, { recursive: true });
    fs.writeFileSync(path.join(config.assets.dir, filename), req.body);
    const url = config.publicBaseUrl ? `${config.publicBaseUrl}/assets/${filename}` : `/assets/${filename}`;
    res.json({
      ok: true,
      bytes: req.body.length,
      url,
      note: config.publicBaseUrl
        ? `Set BANNER_IMAGE_URL to this url.`
        : "PUBLIC_BASE_URL isn't set — set it to this deployment's public domain, then use <that domain>/assets/" + filename + " as BANNER_IMAGE_URL.",
    });
  });

  // Testing helpers — conversation state persists on the volume across redeploys, so a
  // number that already passed "new" won't see the intro/trial-start behavior again
  // without this. `phone` is digits-only, no leading +, matching webhook payloads.
  app.get("/admin/conversation-state", (req, res) => {
    if (!isValidAdminToken(String(req.query.token ?? ""))) {
      return res.status(401).json({ error: "invalid token" });
    }
    const phone = String(req.query.phone ?? "");
    if (!phone) return res.status(400).json({ error: "?phone=... required" });
    res.json(getState(phone));
  });

  app.post("/admin/reset-state", (req, res) => {
    if (!isValidAdminToken(String(req.query.token ?? ""))) {
      return res.status(401).json({ error: "invalid token" });
    }
    const phone = String(req.query.phone ?? "");
    if (!phone) return res.status(400).json({ error: "?phone=... required" });
    resetState(phone);
    res.json({ ok: true, phone, reset: true });
  });

  // Fi Build Spec v4 §11: after the 3rd complimentary approval, further approvals are locked
  // until Fi billing is authorized. No payment processor exists yet, so this admin action is
  // the ONLY way to unlock further approvals for an account — never self-service, never a
  // live charge. See src/billing/entitlementStore.ts.
  app.get("/admin/entitlement", async (req, res) => {
    if (!isValidAdminToken(String(req.query.token ?? ""))) {
      return res.status(401).json({ error: "invalid token" });
    }
    const phone = String(req.query.phone ?? "");
    if (!phone) return res.status(400).json({ error: "?phone=... required" });
    res.json(await getEntitlement(phone));
  });

  app.post("/admin/entitlement/override", async (req, res) => {
    if (!isValidAdminToken(String(req.query.token ?? ""))) {
      return res.status(401).json({ error: "invalid token" });
    }
    const phone = String(req.query.phone ?? "");
    if (!phone) return res.status(400).json({ error: "?phone=... required" });
    const enabled = req.query.enabled !== "false"; // ?enabled=false to revoke; anything else (including omitted) enables
    const entitlement = await setManualOverride(phone, enabled);
    res.json({ ok: true, entitlement });
  });

  /**
   * Grant (or revoke) the unlimited-approvals override for EVERY tester at once.
   *
   * RESTRICT_OUTBOUND_TO is already the list of people who are allowed to receive Fi's messages
   * — which is to say, it is already the tester list. Deriving from it means adding a tester is
   * one variable edit plus one call, instead of remembering a second per-person step that only
   * shows up as a confusing paywall three approvals later.
   *
   * Refuses when outbound is unrestricted: with no allowlist there are no testers to grant to,
   * and the only readings of the request would be "grant to nobody" or "grant to everyone".
   * ?enabled=false revokes the same set, for putting testers back on the normal trial.
   */
  app.post("/admin/entitlement/override-testers", async (req, res) => {
    if (!isValidAdminToken(String(req.query.token ?? ""))) {
      return res.status(401).json({ error: "invalid token" });
    }
    const testers = config.channels.restrictOutboundTo;
    if (testers.length === 0) {
      return res.status(400).json({ error: "RESTRICT_OUTBOUND_TO is empty — there is no tester list to grant to" });
    }
    const enabled = req.query.enabled !== "false";
    const granted: string[] = [];
    const failed: { identity: string; error: string }[] = [];
    for (const identity of testers) {
      try {
        await setManualOverride(identity, enabled);
        granted.push(identity);
      } catch (err) {
        // One bad identity must not silently drop the rest.
        failed.push({ identity, error: (err as Error).message });
      }
    }
    res.json({ ok: failed.length === 0, enabled, granted, failed });
  });

  // Flat-fee, weekly-capped Fi membership tiers (billing/plans.ts) — the ONLY way to assign
  // one is this admin action; no payment processor exists, so this is never self-service and
  // never a live charge. ?plan=none clears an assigned plan back to locked.
  app.post("/admin/entitlement/plan", async (req, res) => {
    if (!isValidAdminToken(String(req.query.token ?? ""))) {
      return res.status(401).json({ error: "invalid token" });
    }
    const phone = String(req.query.phone ?? "");
    if (!phone) return res.status(400).json({ error: "?phone=... required" });
    const planParam = String(req.query.plan ?? "");
    if (planParam === "none") {
      const entitlement = await setPlan(phone, null);
      return res.json({ ok: true, entitlement });
    }
    if (!isPlanKey(planParam)) {
      return res.status(400).json({ error: "?plan=... must be one of tier1, tier2, tier3, or none" });
    }
    const entitlement = await setPlan(phone, planParam);
    res.json({ ok: true, entitlement });
  });

  // One-shot diagnostic to root-cause "why is it showing sample data" without guessing —
  // shows the actual resolved paths, what's on disk at each, and a peek at loaded inventory
  // so we can tell real WatchFacts data from the bundled sample from the response alone.
  app.get("/admin/debug-info", async (req, res) => {
    if (!isValidAdminToken(String(req.query.token ?? ""))) {
      return res.status(401).json({ error: "invalid token" });
    }
    const describe = (p: string) => {
      if (!fs.existsSync(p)) return { path: p, exists: false };
      const stat = fs.statSync(p);
      return {
        path: p,
        exists: true,
        isDirectory: stat.isDirectory(),
        size: stat.isFile() ? stat.size : undefined,
        mtime: stat.mtime,
      };
    };
    const persistDir = path.resolve(process.env.PERSIST_DIR ?? "./persist");
    const listings = await getActiveListings();
    res.json({
      cwd: process.cwd(),
      env: { PERSIST_DIR: process.env.PERSIST_DIR ?? null, CONTACTS_CSV: process.env.CONTACTS_CSV ?? null, DATABASE_URL: process.env.DATABASE_URL ? "set" : null },
      persistDir: describe(persistDir),
      contactsCsv: describe(config.data.contactsCsv),
      groupListingsCsv: describe(config.data.groupListingsCsv),
      persistDirListing: fs.existsSync(persistDir) ? fs.readdirSync(persistDir) : null,
      persistDataListing: fs.existsSync(path.join(persistDir, "data")) ? fs.readdirSync(path.join(persistDir, "data")) : null,
      activeListingCount: listings.length,
      activeListingSample: listings.slice(0, 3).map((l) => ({ id: l.id, type: l.type, contactName: l.contactName, item: l.item, source: l.source })),
    });
  });

  // Sync health at a glance — FS and WTB tracked separately (lastSuccessAt/lastError/
  // activeCount each), since the two sides can succeed/fail independently — see
  // runInventorySync/syncOneSide. A failure on one side never clears or masks the other's
  // last success, and existing rows for a failed side are never touched.
  app.get("/admin/inventory-status", async (req, res) => {
    if (!isValidAdminToken(String(req.query.token ?? ""))) {
      return res.status(401).json({ error: "invalid token" });
    }
    res.json(await getSyncStatus(config.watchfacts.enableWtbSync));
  });

  // Read-only diagnostic: `curl "https://<host>/admin/inventory-search?token=...&q=116500"` —
  // searches ref/item/description (active AND inactive rows) without needing raw DB
  // credentials or shell access. Used to confirm what's actually stored for a given reference
  // when a live search unexpectedly returns nothing.
  app.get("/admin/inventory-search", async (req, res) => {
    if (!isValidAdminToken(String(req.query.token ?? ""))) {
      return res.status(401).json({ error: "invalid token" });
    }
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    if (!q) return res.status(400).json({ error: "?q=<search term> is required" });
    res.json({ ok: true, results: await searchListingsForDiagnostics(q) });
  });

  // On-demand diagnostic: `curl "https://<host>/admin/ai-diagnostic?token=..."` — a minimal,
  // isolated call to OpenAI's Responses API to verify AI_MATCHING_OPENAI_MODEL + OPENAI_API_KEY
  // actually work, independent of this app's own matching prompts. Deliberately admin-triggered
  // rather than run automatically (at startup or per-search) — an extra OpenAI call on every
  // deploy/request costs money and isn't needed once this has confirmed the model/key are good.
  // Currently OpenAI-specific since that's the provider being debugged; the response is already
  // safe to return as-is (no key, no full customer data — see runOpenAiDiagnosticCall).
  app.get("/admin/ai-diagnostic", async (req, res) => {
    if (!isValidAdminToken(String(req.query.token ?? ""))) {
      return res.status(401).json({ error: "invalid token" });
    }
    res.json(await runOpenAiDiagnosticCall());
  });

  app.get("/admin/lifecycle-settings", async (req,res)=>{
    if(isValidAdminToken(String(req.query.token??""))===false)return res.status(401).json({error:"invalid token"});
    res.json(await getLifecycleSettings());
  });
  app.post("/admin/lifecycle-settings", express.json(), async (req,res)=>{
    if(isValidAdminToken(String(req.query.token??""))===false)return res.status(401).json({error:"invalid token"});
    try{await setLifecycleSettings(req.body??{});res.json({ok:true,settings:await getLifecycleSettings()});}catch(e){res.status(400).json({error:(e as Error).message});}
  });

  // Fi Concierge expansion, Stage 1: Group Registry (additive to the existing
  // V4_ALLOWED_CHAT_IDS env-var allowlist — see src/concierge/db.ts). Read-only listing needs
  // only the shared webhook token, same as every other read-only /admin/* route; the three
  // mutating actions below additionally require `adminPhone` to be a number configured in
  // WATCHFACTS_ADMIN_PHONES — the token alone (which anyone with server-admin access holds) is
  // not sufficient to change what a real WhatsApp group can do.
  app.get("/admin/concierge/groups", async (req, res) => {
    if (!isValidAdminToken(String(req.query.token ?? ""))) {
      return res.status(401).json({ error: "invalid token" });
    }
    res.json({ ok: true, groups: await listDesignatedGroups() });
  });

  function requireConciergeAdmin(req: express.Request, res: express.Response): boolean {
    if (!isValidAdminToken(String(req.query.token ?? ""))) {
      res.status(401).json({ error: "invalid token" });
      return false;
    }
    const adminPhone = typeof req.body?.adminPhone === "string" ? req.body.adminPhone : "";
    if (!adminPhone || !isConciergeAdminPhone(adminPhone)) {
      res.status(403).json({ error: "adminPhone is not a configured WatchFacts administrator" });
      return false;
    }
    return true;
  }

  app.post("/admin/concierge/groups/enable", async (req, res) => {
    if (!requireConciergeAdmin(req, res)) return;
    const chatId = typeof req.body?.chatId === "string" ? req.body.chatId : "";
    if (!chatId) return res.status(400).json({ error: "chatId is required" });
    const groupName = typeof req.body?.groupName === "string" ? req.body.groupName : undefined;
    res.json({ ok: true, group: await enableGroup(chatId, groupName) });
  });

  app.post("/admin/concierge/groups/disable", async (req, res) => {
    if (!requireConciergeAdmin(req, res)) return;
    const chatId = typeof req.body?.chatId === "string" ? req.body.chatId : "";
    if (!chatId) return res.status(400).json({ error: "chatId is required" });
    await disableGroup(chatId);
    res.json({ ok: true });
  });

  app.post("/admin/concierge/groups/reference-requests", async (req, res) => {
    if (!requireConciergeAdmin(req, res)) return;
    const chatId = typeof req.body?.chatId === "string" ? req.body.chatId : "";
    if (!chatId) return res.status(400).json({ error: "chatId is required" });
    if (typeof req.body?.enabled !== "boolean") return res.status(400).json({ error: "enabled (boolean) is required" });
    await setReferenceRequestsEnabled(chatId, req.body.enabled);
    res.json({ ok: true });
  });

  app.use("/assets", express.static(config.assets.dir));

  // Logs into WatchFacts and re-syncs the Trading Floor feed (both FS and WTB) via the real
  // available-flash-sales API into the SQLite-backed inventory store — see
  // src/watchfacts/{api,syncInventory,inventoryDb}.ts. Requires WATCHFACTS_EMAIL/PASSWORD.
  // Takes ~10-30s (login + paginated fetches), so this awaits the result rather than
  // backgrounding it like /outreach/start. The scheduler in index.ts calls this on its own
  // interval; this endpoint is for a manual/on-demand re-sync.
  app.post("/admin/sync-inventory", async (req, res) => {
    if (!isValidAdminToken(String(req.query.token ?? ""))) {
      return res.status(401).json({ error: "invalid token" });
    }
    if (!config.watchfacts.email || !config.watchfacts.password) {
      return res.status(400).json({ error: "WATCHFACTS_EMAIL / WATCHFACTS_PASSWORD not set" });
    }
    try {
      const result = await runInventorySync();
      res.json({ ok: true, ...result });
    } catch (err) {
      const message = (err as Error).message;
      res.status(message === "a sync is already running" ? 409 : 500).json({ error: message });
    }
  });

  // Fi Build Spec v4 §4.3 safety net — sweeps every active FS×WTB pairing to recover any match
  // missed by the immediate on-ingest path (e.g. a webhook delivery that failed mid-process).
  // The scheduler in index.ts calls this on its own interval; this endpoint is for a manual/
  // on-demand run. Already-known, unchanged matches are a no-op — see runReconciliation.
  app.post("/admin/reconciliation", async (req, res) => {
    if (!isValidAdminToken(String(req.query.token ?? ""))) {
      return res.status(401).json({ error: "invalid token" });
    }
    const result = await runReconciliation();
    res.json({ ok: !result.error, ...result });
  });

  // The billing counterpart to the match reconciliation above: recovers checkouts whose
  // activation webhook never arrived. Runs on a timer too (see index.ts); this endpoint exists
  // for the case where someone needs it to have already happened.
  app.post("/admin/billing/reconciliation", async (req, res) => {
    if (!isValidAdminToken(String(req.query.token ?? ""))) {
      return res.status(401).json({ error: "invalid token" });
    }
    const minAgeMinutes = req.query.minAgeMinutes !== undefined ? Number(req.query.minAgeMinutes) : undefined;
    if (minAgeMinutes !== undefined && (!Number.isFinite(minAgeMinutes) || minAgeMinutes < 0)) {
      return res.status(400).json({ error: "minAgeMinutes must be a non-negative number" });
    }
    const result = await runCheckoutReconciliation(minAgeMinutes === undefined ? {} : { minAgeMinutes });
    res.json({ ok: !result.error, ...result });
  });

  // Reports v4 rollout state without exposing secrets (no connection string, no credentials —
  // just booleans/config values). Also re-validates the schema on each call: since index.ts
  // already initializes it unconditionally at startup, this should always report ready, but a
  // failing call here (rather than a silent false) is itself the signal something's wrong.
  app.get("/admin/v4-status", async (req, res) => {
    if (!isValidAdminToken(String(req.query.token ?? ""))) {
      return res.status(401).json({ error: "invalid token" });
    }
    let schemaReady = true;
    let schemaError: string | null = null;
    try {
      await initSchema();
    } catch (err) {
      schemaReady = false;
      schemaError = (err as Error).message;
    }
    // Spec §14: active monitor/match counts, notifications sent/failed, and the last
    // reconciliation run's outcome, all queried live (see getV4OperationalStatus) — kept as a
    // best-effort addition alongside the config/schema fields above rather than failing the
    // whole endpoint if this query has a problem, since those existing fields are themselves
    // useful for diagnosing a DB issue.
    let operational: Awaited<ReturnType<typeof getV4OperationalStatus>> | null = null;
    let operationalError: string | null = null;
    try {
      operational = await getV4OperationalStatus();
    } catch (err) {
      operationalError = (err as Error).message;
    }

    res.json({
      enabled: config.postingsV4.enabled,
      allowedChatIds: config.postingsV4.allowedChatIds,
      reminderDaysBeforeExpiry: config.postingsV4.reminderDaysBeforeExpiry,
      schemaReady,
      schemaError,
      ...operational,
      operationalError,
    });
  });

  return app;
}
