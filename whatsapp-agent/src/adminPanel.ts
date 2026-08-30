import crypto from "crypto";
import express from "express";
import { config } from "./config";
import { loadContacts } from "./data/contactsStore";
import { listDesignatedGroups } from "./concierge/groupRegistry";
import { initSchema } from "./postings/db";
import { getV4OperationalStatus } from "./postings/status";
import { getSyncStatus } from "./watchfacts/inventoryDb";

const SESSION_COOKIE = "luxfi_admin";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const sessions = new Map<string, number>();

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function cookieValue(req: express.Request, name: string): string | undefined {
  const cookies = req.headers.cookie?.split(";") ?? [];
  for (const cookie of cookies) {
    const [key, ...value] = cookie.trim().split("=");
    if (key === name) return decodeURIComponent(value.join("="));
  }
  return undefined;
}

export function hasAdminSession(req: express.Request): boolean {
  const id = cookieValue(req, SESSION_COOKIE);
  if (!id) return false;
  const expires = sessions.get(id);
  if (!expires || expires <= Date.now()) {
    sessions.delete(id);
    return false;
  }
  return true;
}

/** Existing API clients may keep using ?token=; the browser panel uses an HttpOnly session. */
export function isAdminAuthenticated(req: express.Request): boolean {
  const token = typeof req.query.token === "string" ? req.query.token : "";
  return tokenMatches(token) || hasAdminSession(req);
}

function tokenMatches(candidate: string): boolean {
  // Fail closed when WEBHOOK_TOKEN is absent. Besides protecting the login form, this
  // prevents an omitted ?token query from comparing equal to an omitted configuration.
  if (!config.server.webhookToken || !candidate) return false;
  const expected = Buffer.from(config.server.webhookToken);
  const supplied = Buffer.from(candidate);
  return expected.length === supplied.length && crypto.timingSafeEqual(expected, supplied);
}

function badge(ok: boolean, yes: string, no: string): string {
  return `<span class="badge ${ok ? "ok" : "off"}">${escapeHtml(ok ? yes : no)}</span>`;
}

function row(label: string, value: unknown): string {
  return `<div class="row"><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`;
}

function card(title: string, body: string, state = ""): string {
  return `<section class="card ${state}"><h2>${escapeHtml(title)}</h2>${body}</section>`;
}

function endpointHost(value: string): string {
  try { return new URL(value).host; } catch { return "Configured endpoint"; }
}

function page(content: string, title = "LuxFi Admin"): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title><style>
:root{color-scheme:dark;--bg:#090c0f;--panel:#11161b;--line:#27313a;--gold:#d3b06f;--text:#eef2f5;--muted:#91a0ac;--green:#5bd29a;--red:#f07b7b}*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at top,#182129 0,#090c0f 46%);color:var(--text);font:15px/1.5 Inter,system-ui,sans-serif}main{max-width:1180px;margin:auto;padding:42px 24px 64px}header{display:flex;align-items:end;justify-content:space-between;gap:20px;margin-bottom:28px}h1{margin:0;font:500 34px/1.1 Georgia,serif;color:var(--gold)}.eyebrow{color:var(--muted);letter-spacing:.18em;text-transform:uppercase;font-size:11px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:16px}.card{background:linear-gradient(145deg,#141a20,#0e1317);border:1px solid var(--line);border-radius:14px;padding:20px;box-shadow:0 14px 35px #0005}.card h2{font-size:14px;text-transform:uppercase;letter-spacing:.1em;color:var(--gold);margin:0 0 15px}.row{display:grid;grid-template-columns:minmax(125px,1fr) minmax(0,1.3fr);gap:12px;padding:8px 0;border-bottom:1px solid #20272d}.row:last-child{border:0}dt{color:var(--muted)}dd{margin:0;text-align:right;overflow-wrap:anywhere}.badge{display:inline-block;padding:3px 9px;border-radius:999px;background:#29323a;color:var(--muted);font-size:12px}.badge.ok{background:#12372a;color:var(--green)}.badge.off{background:#3c2022;color:var(--red)}.login{max-width:420px;margin:14vh auto}.login input,.upload input{width:100%;padding:12px;border:1px solid var(--line);border-radius:8px;background:#080b0e;color:var(--text);margin:8px 0 14px}button{border:0;border-radius:8px;background:var(--gold);color:#17120a;padding:11px 16px;font-weight:700;cursor:pointer}.error{color:var(--red)}.muted,small{color:var(--muted)}form.inline{margin:0}form.inline button{background:transparent;color:var(--muted);border:1px solid var(--line);padding:7px 12px}code{color:#d9c28e}.wide{grid-column:1/-1}</style></head><body><main>${content}</main></body></html>`;
}

function loginPage(error = false): string {
  return page(`<section class="card login"><div class="eyebrow">Operations console</div><h1>LuxFi</h1><p class="muted">Sign in with the deployment WEBHOOK_TOKEN. The token is verified server-side and is never shown in the panel.</p>${error ? '<p class="error">Invalid token.</p>' : ""}<form method="post" action="/admin/login"><label for="token">WEBHOOK_TOKEN</label><input id="token" name="token" type="password" required autocomplete="current-password"><button type="submit">Open admin panel</button></form></section>`, "LuxFi Admin Login");
}

async function safe<T>(work: () => Promise<T>): Promise<{ value: T | null; error: string | null }> {
  try { return { value: await work(), error: null }; }
  catch (error) { return { value: null, error: error instanceof Error ? error.message : "Unavailable" }; }
}

async function dashboard(): Promise<string> {
  const [schema, operational, sync, groups] = await Promise.all([
    safe(async () => { await initSchema(); return true; }),
    safe(getV4OperationalStatus),
    safe(() => getSyncStatus(config.watchfacts.enableWtbSync)),
    safe(listDesignatedGroups),
  ]);
  let contacts = 0;
  try { contacts = loadContacts().length; } catch { /* surfaced as zero rather than leaking paths */ }
  const aiCredentialConfigured = config.aiMatching.provider === "openai" ? !!config.aiMatching.openaiApiKey : !!config.aiMatching.apiKey;
  const groupList = groups.value?.map((g) => escapeHtml(`${g.groupName || "Unnamed"} — ${g.chatId} (${g.isActive ? "active" : "inactive"})`)).join("<br>") || "None configured";
  const syncValue = sync.value;
  const ops = operational.value;

  return page(`<header><div><div class="eyebrow">WhatsApp agent · read-only overview</div><h1>Operations</h1></div><form class="inline" method="post" action="/admin/logout"><button>Sign out</button></form></header><div class="grid">
  ${card("Whapi", badge(!!config.whapi.token, "Configured", "Not configured") + row("Endpoint", endpointHost(config.whapi.baseUrl)) + row("Webhook authentication", "Enabled"))}
  ${card("PostgreSQL & schema", badge(!!schema.value, "Schema ready", "Unavailable") + row("Database", config.database.url ? "Configured" : "Not configured") + (schema.error ? row("Status", "Schema check failed") : ""))}
  ${card("Market updates", badge(config.marketUpdates.enabled && !!config.whapi.token, "Scheduler ready", "Not ready") + row("Feature", config.marketUpdates.enabled ? "Enabled" : "Disabled") + row("Morning update", config.marketUpdates.morningTime) + row("Afternoon update", config.marketUpdates.afternoonTime) + row("Timezone", config.marketUpdates.timezone) + row("Delivery grace", `${config.marketUpdates.graceMinutes} minutes`) + row("Unchanged updates", config.marketUpdates.allowUnchanged ? "Allowed" : "Skipped"))}
  ${card("V4 postings", badge(config.postingsV4.enabled, "Enabled", "Disabled") + row("Allowed groups", config.postingsV4.allowedChatIds.length ? config.postingsV4.allowedChatIds.join(", ") : "None") + row("Active FS / WTB", ops ? `${ops.activeFsMonitors} / ${ops.activeWtbMonitors}` : "Unavailable") + row("Active matches", ops?.activeMatches ?? "Unavailable") + row("Notifications sent / failed", ops ? `${ops.notificationsSent} / ${ops.notificationsFailed}` : "Unavailable"))}
  ${card("Allowed groups", `<div class="muted">${groupList}</div>` + (groups.error ? row("Status", "Registry unavailable") : ""))}
  ${card("WatchFacts synchronization", badge(!!config.watchfacts.email && !!config.watchfacts.password, "Credentials configured", "Not configured") + row("FS", syncValue?.fs.status ?? "Unavailable") + row("FS active", syncValue?.fs.activeCount ?? "Unavailable") + row("WTB", syncValue?.wtb.status ?? (config.watchfacts.enableWtbSync ? "Unavailable" : "Disabled")) + row("Last attempt", syncValue?.lastAttemptAt ?? "Never"))}
  ${card("AI matching", badge(config.aiMatching.enabled, "Enabled", "Disabled") + row("Provider", config.aiMatching.provider) + row("Model", config.aiMatching.provider === "openai" ? (config.aiMatching.openaiModel || "Not configured") : config.aiMatching.model) + row("Provider credential", aiCredentialConfigured ? "Configured" : "Not configured") + row("Pilot phones", config.aiMatching.testPhones.length) + row("Inventory enrichment", config.aiMatching.enrichmentEnabled ? `Enabled (max ${config.aiMatching.enrichmentMaxPerSync}/sync)` : "Disabled"))}
  ${card("Deployment health", badge(true, "Process online", "Offline") + row("Uptime", `${Math.floor(process.uptime())} seconds`) + row("Environment", process.env.NODE_ENV ?? "development") + row("Node", process.version) + row("Memory RSS", `${Math.round(process.memoryUsage().rss / 1024 / 1024)} MB`) + row("Checked", new Date().toISOString()))}
  ${card("Contact upload", `<p class="muted">${contacts} contacts currently loaded. Uploading replaces the contact CSV. Only CSV contents and the resulting count are returned.</p><div class="upload"><input id="contacts" type="file" accept=".csv,text/csv"><button id="upload" type="button">Upload contacts CSV</button><p id="upload-result" class="muted"></p></div><script>document.getElementById('upload').onclick=async()=>{const f=document.getElementById('contacts').files[0],o=document.getElementById('upload-result');if(!f){o.textContent='Choose a CSV file first.';return}o.textContent='Uploading…';try{const r=await fetch('/admin/upload/contacts',{method:'POST',headers:{'Content-Type':'text/csv'},body:await f.text()});const j=await r.json();o.textContent=r.ok?'Loaded '+j.contacts+' contacts.':(j.error||'Upload failed.')}catch(e){o.textContent='Upload failed.'}};</script>`, "wide")}
  </div>`);
}

export function registerAdminPanel(app: express.Express): void {
  app.use(express.urlencoded({ extended: false }));
  app.get("/admin", async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!hasAdminSession(req)) return res.status(200).type("html").send(loginPage());
    res.type("html").send(await dashboard());
  });
  app.post("/admin/login", (req, res) => {
    if (!tokenMatches(typeof req.body?.token === "string" ? req.body.token : "")) return res.status(401).type("html").send(loginPage(true));
    const id = crypto.randomBytes(32).toString("base64url");
    sessions.set(id, Date.now() + SESSION_TTL_MS);
    const secure = req.secure || req.header("x-forwarded-proto") === "https" ? "; Secure" : "";
    res.setHeader("Set-Cookie", `${SESSION_COOKIE}=${id}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_TTL_MS / 1000}${secure}`);
    res.redirect(303, "/admin");
  });
  app.post("/admin/logout", (req, res) => {
    const id = cookieValue(req, SESSION_COOKIE);
    if (id) sessions.delete(id);
    res.setHeader("Set-Cookie", `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
    res.redirect(303, "/admin");
  });
}
