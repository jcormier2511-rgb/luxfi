import { AdminDashboardData } from "./dashboard";
import { channelLabel } from "../postings/notificationPreferences";

/** Every dynamic value below is run through this before landing in HTML — status strings can
 *  carry error text from external systems (Whapi, WatchFacts, Postgres), which must never be
 *  trusted as safe markup. */
export function escapeHtml(value: unknown): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function badge(label: string, state: boolean | null): string {
  const cls = state === true ? "ok" : state === false ? "bad" : "unknown";
  const text = state === true ? "OK" : state === false ? "ERROR" : "UNKNOWN";
  return `<span class="badge ${cls}">${escapeHtml(label)}: ${text}</span>`;
}

function formatUptime(totalSeconds: number): string {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  return `${h}h ${m}m ${s}s`;
}

const PAGE_STYLES = `
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; margin: 0; background: #f5f6f8; color: #1a1a1a; }
@media (prefers-color-scheme: dark) {
  body { background: #14161a; color: #e6e6e6; }
  .card, form.login { background: #1e2126 !important; border-color: #2c2f36 !important; }
  input, button { background: #20242b !important; color: #e6e6e6 !important; border-color: #3a3f47 !important; }
}
header { padding: 18px 28px; border-bottom: 1px solid #d8dade; display: flex; justify-content: space-between; align-items: center; gap: 16px; }
header h1 { font-size: 17px; margin: 0; }
header a { color: #4b5563; text-decoration: none; font-size: 13px; }
header nav { display:flex; gap:10px; align-items:center; flex-wrap:wrap; }
main { max-width: 1000px; margin: 0 auto; padding: 22px 28px 50px; display: grid; gap: 16px; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); }
.card { background: #fff; border: 1px solid #e2e4e8; border-radius: 10px; padding: 16px 18px; }
.card h2 { margin: 0 0 10px; font-size: 13px; text-transform: uppercase; letter-spacing: .04em; color: #6b7280; }
.card dl { margin: 8px 0 0; display: grid; grid-template-columns: auto 1fr; gap: 5px 12px; font-size: 13px; }
.card dt { color: #6b7280; }
.card dd { margin: 0; word-break: break-word; }
.badge { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 600; margin-right: 6px; }
.badge.ok { background: #dcfce7; color: #166534; }
.badge.bad { background: #fee2e2; color: #991b1b; }
.badge.unknown { background: #e5e7eb; color: #374151; }
ul.plain, ol.plain { margin: 8px 0 0; padding-left: 18px; font-size: 13px; }
.full { grid-column: 1 / -1; }
.card table { width: 100%; border-collapse: collapse; font-size: 12px; margin-top: 8px; }
.card th, .card td { text-align: left; padding: 5px 6px; border-bottom: 1px solid #e5e7eb; }
form.login { max-width: 340px; margin: 90px auto; padding: 26px; border: 1px solid #e2e4e8; border-radius: 10px; background: #fff; }
form.login h1 { font-size: 15px; margin: 0 0 16px; font-weight: 600; }
form.login input { width: 100%; padding: 9px 10px; border: 1px solid #d1d5db; border-radius: 6px; margin-bottom: 12px; font-size: 14px; }
form.login button, .card button { padding: 8px 14px; border-radius: 6px; border: 1px solid #d1d5db; background: #111827; color: #fff; font-size: 13px; cursor: pointer; }
form.login button { width: 100%; }
.error { color: #991b1b; font-size: 13px; margin-bottom: 12px; }
.muted { color: #6b7280; font-size: 12px; margin-top: 8px; }
input[type=file] { font-size: 13px; margin-top: 8px; }
footer { text-align: center; color: #9ca3af; font-size: 11px; padding: 10px 0 30px; }
`;

/** Never repopulates credentials and always uses generic errors to avoid account discovery. */
export function renderLoginPage(error?: string): string {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>LuxFi Admin — Sign in</title>
<style>${PAGE_STYLES}</style>
</head>
<body>
  <form class="login" method="post" action="/admin/login" autocomplete="off">
    <h1>LuxFi WhatsApp Agent — Admin</h1>
    ${error ? `<div class="error">${escapeHtml(error)}</div>` : ""}
    <input type="text" name="username" placeholder="Username" autocomplete="username" autofocus required>
    <input type="password" name="password" placeholder="Password" autocomplete="current-password" required>
    <button type="submit">Sign in</button>
  </form>
</body>
</html>`;
}

export function renderManagementPage(kind:"users"|"groups"|"administrators"|"coverage"):string {
  const title=kind==="users"?"Approved Users":kind==="groups"?"GROUP MANAGEMENT":kind==="coverage"?"WTB Coverage / Dealer Specialists":"Administrators";
  const empty=kind==="groups"?"No approved groups yet. Add the exact WhatsApp chat ID after the number is restored; wildcards are never accepted.":`No ${title.toLowerCase()} found.`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>LuxFi — ${title}</title><style>${PAGE_STYLES} main{display:block;max-width:1200px}.toolbar{display:flex;gap:8px;margin-bottom:14px}input,select{padding:8px;border:1px solid #d1d5db;border-radius:6px}table{width:100%;border-collapse:collapse;font-size:13px}th,td{text-align:left;padding:8px;border-bottom:1px solid #e5e7eb}pre{white-space:pre-wrap}</style></head><body><header><h1>${title}</h1><nav><a href="/admin#members">Members</a><a href="/admin/users">Users</a><a href="/admin/groups">Groups</a><a href="/admin/coverage">WTB Coverage</a><a href="/admin/administrators">Administrators</a><a href="/admin/tools">Tools</a><a href="/admin/logout">Sign out</a></nav></header><main><section class="card">${kind==='groups'?'<h2>Monitoring Groups</h2><p class="muted">Groups Fi listens to</p><h2>Push Groups</h2><p class="muted">Groups Fi may actively post into (configured independently under listing settings)</p>':''}<div class="toolbar"><input id="q" placeholder="Search"><select id="status"><option value="">All statuses</option><option>active</option><option>inactive</option>${kind==='users'?'<option>blocked</option>':''}</select><button onclick="load()">Search</button>${kind==='users'?'<a href="/admin/api/users/template.csv">CSV template</a> <a href="/admin/api/users/export.csv">Export CSV</a>':''}</div><div id="empty" class="muted">Loading…</div><table id="table" hidden><thead></thead><tbody></tbody></table><pre id="error" class="error"></pre></section></main><script>
  const kind=${JSON.stringify(kind)}, endpoint='/admin/api/'+kind; let csrf='';
  const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  async function load(){const session=await fetch('/admin/api/session').then(r=>r.json());csrf=session.csrfToken||'';const u=new URL(endpoint,location.origin);u.searchParams.set('q',document.querySelector('#q').value);u.searchParams.set('status',document.querySelector('#status').value);const response=await fetch(u);if(response.status===403){location.href='/admin';return}const data=await response.json(),rows=Array.isArray(data)?data:data.rows||[];document.querySelector('#empty').textContent=rows.length?'':${JSON.stringify(empty)};const table=document.querySelector('#table');table.hidden=!rows.length;if(!rows.length)return;const hidden=['password_hash'];const keys=Object.keys(rows[0]).filter(k=>!hidden.includes(k));table.querySelector('thead').innerHTML='<tr>'+keys.map(k=>'<th>'+esc(k)+'</th>').join('')+'</tr>';table.querySelector('tbody').innerHTML=rows.map(r=>'<tr>'+keys.map(k=>'<td>'+esc(Array.isArray(r[k])?r[k].join(', '):r[k])+'</td>').join('')+'</tr>').join('')}
  load().catch(e=>document.querySelector('#error').textContent=e.message);
  </script></body></html>`;
}

/**
 * Panel-session UI for the testing tools that previously only existed as curl-only, token-gated
 * endpoints (/admin/market-guide/debug, /admin/inventory-search, /admin/user/reset) — same
 * underlying logic (see server.ts's /admin/api/tools/* routes), just reachable from the browser
 * once signed in, with CSRF on the destructive action.
 */
export function renderToolsPage(): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>LuxFi — Tools</title><style>${PAGE_STYLES} main{display:block;max-width:1000px}.toolbar{display:flex;gap:8px;margin-bottom:14px}input,select{padding:8px;border:1px solid #d1d5db;border-radius:6px;flex:1}table{width:100%;border-collapse:collapse;font-size:12px;margin-top:10px}th,td{text-align:left;padding:6px 8px;border-bottom:1px solid #e5e7eb}pre{white-space:pre-wrap}.card{margin-bottom:18px}</style></head><body><header><h1>Tools</h1><nav><a href="/admin#members">Members</a><a href="/admin/users">Users</a><a href="/admin/groups">Groups</a><a href="/admin/coverage">WTB Coverage</a><a href="/admin/administrators">Administrators</a><a href="/admin/tools">Tools</a><a href="/admin/logout">Sign out</a></nav></header><main>

<section class="card">
  <h2>Market Guide debug</h2>
  <p class="muted">Every raw comparable row behind a reference's Market Guide — raw price, raw currency, inferred currency, USD conversion.</p>
  <div class="toolbar"><input id="mg-ref" placeholder="Reference, e.g. 116500LN"><button onclick="mgLookup()">Look up</button></div>
  <div id="mg-empty" class="muted"></div>
  <table id="mg-table" hidden><thead></thead><tbody></tbody></table>
  <pre id="mg-error" class="error"></pre>
</section>

<section class="card">
  <h2>Inventory search</h2>
  <p class="muted">Searches WatchFacts inventory (ref/item/description, active AND inactive rows).</p>
  <div class="toolbar"><input id="inv-q" placeholder="Search term, e.g. 116500"><button onclick="invLookup()">Search</button></div>
  <div id="inv-empty" class="muted"></div>
  <table id="inv-table" hidden><thead></thead><tbody></tbody></table>
  <pre id="inv-error" class="error"></pre>
</section>

<section class="card">
  <h2>Full account reset</h2>
  <p class="muted">Closes every active listing and clears conversation state + notification preference for every identity linked to the given one (e.g. both halves of a linked WhatsApp/Telegram pair). Cannot be undone. Requires administrator or owner role.</p>
  <div class="toolbar"><input id="reset-id" placeholder="Identity, e.g. telegram:5703391972 or 13053897000"><button onclick="resetAccount()">Reset account</button></div>
  <pre id="reset-result"></pre>
  <pre id="reset-error" class="error"></pre>
</section>

<section class="card">
  <h2>Membership / entitlement</h2>
  <p class="muted">The only way to unlock further approvals or assign a paid plan — no live payment processor exists, so this is never self-service and never a real charge. Granting an override or plan requires administrator or owner role.</p>
  <div class="toolbar"><input id="ent-phone" placeholder="Phone (digits only, no +), e.g. 13053897000"><button onclick="entLookup()">Look up</button></div>
  <pre id="ent-result"></pre>
  <pre id="ent-error" class="error"></pre>
  <div class="toolbar">
    <button onclick="entOverride(true)">Grant unlimited override</button>
    <button onclick="entOverride(false)">Revoke override</button>
  </div>
  <div class="toolbar">
    <select id="ent-plan">
      <option value="tier1">Tier 1 — $50/month, 5/week</option>
      <option value="tier2">Tier 2 — $150/month, 20/week</option>
      <option value="tier3">Tier 3 — $300/month, unlimited</option>
      <option value="none">No plan (locked)</option>
    </select>
    <button onclick="entSetPlan()">Set plan</button>
  </div>
</section>

</main><script>
  const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  let csrf='';
  async function ensureCsrf(){if(csrf)return csrf;const session=await fetch('/admin/api/session').then(r=>r.json());csrf=session.csrfToken||'';return csrf}
  function renderTable(prefix,rows){
    document.querySelector('#'+prefix+'-error').textContent='';
    document.querySelector('#'+prefix+'-empty').textContent=rows.length?'':'No rows found.';
    const table=document.querySelector('#'+prefix+'-table');table.hidden=!rows.length;if(!rows.length)return;
    const keys=Object.keys(rows[0]);
    table.querySelector('thead').innerHTML='<tr>'+keys.map(k=>'<th>'+esc(k)+'</th>').join('')+'</tr>';
    table.querySelector('tbody').innerHTML=rows.map(r=>'<tr>'+keys.map(k=>'<td>'+esc(r[k])+'</td>').join('')+'</tr>').join('');
  }
  async function mgLookup(){
    document.querySelector('#mg-error').textContent='';
    const reference=document.querySelector('#mg-ref').value.trim();if(!reference)return;
    try{
      await ensureCsrf();
      const res=await fetch('/admin/api/tools/market-guide-debug?reference='+encodeURIComponent(reference));
      if(res.status===401){location.href='/admin';return}
      const data=await res.json();
      if(!res.ok){document.querySelector('#mg-error').textContent=data.error||'Lookup failed';return}
      renderTable('mg',data.rows||[]);
    }catch(e){document.querySelector('#mg-error').textContent=e.message}
  }
  async function invLookup(){
    document.querySelector('#inv-error').textContent='';
    const q=document.querySelector('#inv-q').value.trim();if(!q)return;
    try{
      await ensureCsrf();
      const res=await fetch('/admin/api/tools/inventory-search?q='+encodeURIComponent(q));
      if(res.status===401){location.href='/admin';return}
      const data=await res.json();
      if(!res.ok){document.querySelector('#inv-error').textContent=data.error||'Search failed';return}
      renderTable('inv',data.results||[]);
    }catch(e){document.querySelector('#inv-error').textContent=e.message}
  }
  async function resetAccount(){
    document.querySelector('#reset-error').textContent='';document.querySelector('#reset-result').textContent='';
    const identity=document.querySelector('#reset-id').value.trim();if(!identity)return;
    if(!confirm('Reset '+identity+'? This closes every active listing and clears conversation state for every identity linked to it. This cannot be undone.'))return;
    try{
      const token=await ensureCsrf();
      const res=await fetch('/admin/api/tools/user-reset',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':token},body:JSON.stringify({identity})});
      if(res.status===401){location.href='/admin';return}
      const data=await res.json();
      if(!res.ok){document.querySelector('#reset-error').textContent=data.error||'Reset failed';return}
      document.querySelector('#reset-result').textContent=JSON.stringify(data,null,2);
    }catch(e){document.querySelector('#reset-error').textContent=e.message}
  }
  function entPhone(){return document.querySelector('#ent-phone').value.trim()}
  async function entLookup(){
    document.querySelector('#ent-error').textContent='';
    const phone=entPhone();if(!phone)return;
    try{
      await ensureCsrf();
      const res=await fetch('/admin/api/tools/entitlement?phone='+encodeURIComponent(phone));
      if(res.status===401){location.href='/admin';return}
      const data=await res.json();
      if(!res.ok){document.querySelector('#ent-error').textContent=data.error||'Lookup failed';return}
      document.querySelector('#ent-result').textContent=JSON.stringify(data.entitlement,null,2);
    }catch(e){document.querySelector('#ent-error').textContent=e.message}
  }
  async function entOverride(enabled){
    document.querySelector('#ent-error').textContent='';
    const phone=entPhone();if(!phone)return;
    if(!confirm((enabled?'Grant':'Revoke')+' the unlimited-approvals override for '+phone+'?'))return;
    try{
      const token=await ensureCsrf();
      const res=await fetch('/admin/api/tools/entitlement/override',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':token},body:JSON.stringify({phone,enabled})});
      if(res.status===401){location.href='/admin';return}
      const data=await res.json();
      if(!res.ok){document.querySelector('#ent-error').textContent=data.error||'Failed';return}
      document.querySelector('#ent-result').textContent=JSON.stringify(data.entitlement,null,2);
    }catch(e){document.querySelector('#ent-error').textContent=e.message}
  }
  async function entSetPlan(){
    document.querySelector('#ent-error').textContent='';
    const phone=entPhone();if(!phone)return;
    const plan=document.querySelector('#ent-plan').value;
    if(!confirm('Set plan for '+phone+' to '+plan+'? This is not a real charge — billing is not automated.'))return;
    try{
      const token=await ensureCsrf();
      const res=await fetch('/admin/api/tools/entitlement/plan',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':token},body:JSON.stringify({phone,plan})});
      if(res.status===401){location.href='/admin';return}
      const data=await res.json();
      if(!res.ok){document.querySelector('#ent-error').textContent=data.error||'Failed';return}
      document.querySelector('#ent-result').textContent=JSON.stringify(data.entitlement,null,2);
    }catch(e){document.querySelector('#ent-error').textContent=e.message}
  }
  </script></body></html>`;
}

function renderWhapiCard(w: AdminDashboardData["whapi"]): string {
  const state = !w.configured ? null : w.error ? false : w.authorized;
  return `<section class="card">
    <h2>Whapi connectivity</h2>
    ${badge("status", state)}
    <dl>
      <dt>Configured</dt><dd>${w.configured ? "yes" : "no — WHAPI_TOKEN not set"}</dd>
      <dt>Reachable</dt><dd>${w.configured ? (w.reachable ? "yes" : "no") : "—"}</dd>
      <dt>Channel status</dt><dd>${w.statusText ? escapeHtml(w.statusText) : "—"}</dd>
      <dt>Version</dt><dd>${w.version ? escapeHtml(w.version) : "—"}</dd>
      ${w.error ? `<dt>Error</dt><dd>${escapeHtml(w.error)}</dd>` : ""}
    </dl>
  </section>`;
}

function renderDatabaseCard(db: AdminDashboardData["database"]): string {
  return `<section class="card">
    <h2>PostgreSQL / schema</h2>
    ${badge("schema", db.schemaReady)}
    <dl>
      <dt>Host</dt><dd>${db.host ? escapeHtml(db.host) : "—"}</dd>
      <dt>Database</dt><dd>${db.databaseName ? escapeHtml(db.databaseName) : "—"}</dd>
      ${db.schemaError ? `<dt>Error</dt><dd>${escapeHtml(db.schemaError)}</dd>` : ""}
    </dl>
  </section>`;
}

function renderMarketUpdatesCard(mu: AdminDashboardData["marketUpdates"]): string {
  const delivery = "error" in mu.delivery
    ? `<dt>Delivery status</dt><dd>error: ${escapeHtml(mu.delivery.error)}</dd>`
    : `
      <dt>Last delivery</dt><dd>${
        mu.delivery.lastDeliveredAt
          ? `${escapeHtml(mu.delivery.lastDeliveredAt)} (${escapeHtml(mu.delivery.lastPeriod)}, ${mu.delivery.recipientsInLastBatch} recipient(s))`
          : "never"
      }</dd>
      <dt>Last failure</dt><dd>${
        mu.delivery.lastFailureAt ? `${escapeHtml(mu.delivery.lastFailureAt)}: ${escapeHtml(mu.delivery.lastFailureError ?? "")}` : "none"
      }</dd>`;
  return `<section class="card">
    <h2>Market updates</h2>
    ${badge("enabled", mu.enabled || null)}
    <dl>
      <dt>Schedule</dt><dd>${escapeHtml(mu.morningTime)} &amp; ${escapeHtml(mu.afternoonTime)}</dd>
      <dt>Timezone</dt><dd>${escapeHtml(mu.timezone)}</dd>
      <dt>Grace window</dt><dd>${mu.graceMinutes} min</dd>
      <dt>Allow unchanged</dt><dd>${mu.allowUnchanged ? "yes" : "no"}</dd>
      <dt>Min observations</dt><dd>${mu.minimumObservations}</dd>
      ${delivery}
    </dl>
  </section>`;
}

function renderPostingsV4Card(v4: AdminDashboardData["postingsV4"]): string {
  const groupIds = v4.allowedChatIds.length ? v4.allowedChatIds.map(escapeHtml).join(", ") : "none configured";
  const operational = v4.operational
    ? `
      <dt>Active FS / WTB monitors</dt><dd>${v4.operational.activeFsMonitors} / ${v4.operational.activeWtbMonitors}</dd>
      <dt>Active matches</dt><dd>${v4.operational.activeMatches}</dd>
      <dt>Notifications sent / failed</dt><dd>${v4.operational.notificationsSent} / ${v4.operational.notificationsFailed}</dd>`
    : `<dt>Operational status</dt><dd>error: ${escapeHtml(v4.operationalError ?? "unknown")}</dd>`;
  const groups = v4.designatedGroups
    ? v4.designatedGroups.length
      ? `<ul class="plain">${v4.designatedGroups
          .map((g) => `<li>${escapeHtml(g.groupName || g.chatId)} — ${g.isActive ? "active" : "inactive"}</li>`)
          .join("")}</ul>`
      : `<p class="muted">No concierge groups designated yet.</p>`
    : `<p class="muted">Designated groups unavailable: ${escapeHtml(v4.designatedGroupsError ?? "unknown error")}</p>`;
  return `<section class="card">
    <h2>V4 postings</h2>
    ${badge("enabled", v4.enabled || null)}
    <dl>
      <dt>Allowed group IDs</dt><dd>${groupIds}</dd>
      <dt>Reminder lead time</dt><dd>${v4.reminderDaysBeforeExpiry} day(s)</dd>
      ${operational}
    </dl>
    <h2 style="margin-top:14px">Designated concierge groups</h2>
    ${groups}
  </section>`;
}

function renderWatchfactsCard(wf: AdminDashboardData["watchfacts"]): string {
  if ("error" in wf.sync) {
    return `<section class="card">
      <h2>WatchFacts FS / WTB sync</h2>
      ${badge("sync", false)}
      <dl><dt>Error</dt><dd>${escapeHtml(wf.sync.error)}</dd></dl>
    </section>`;
  }
  const fsOk = wf.sync.fs.status === "ok";
  const wtbState = wf.sync.wtb.status === "ok" ? true : wf.sync.wtb.status === "disabled" ? null : false;
  return `<section class="card">
    <h2>WatchFacts FS / WTB sync</h2>
    ${badge("FS", fsOk)} ${badge("WTB", wtbState)}
    <dl>
      <dt>Credentials configured</dt><dd>${wf.credentialsConfigured ? "yes" : "no"}</dd>
      <dt>Last attempt</dt><dd>${wf.sync.lastAttemptAt ? escapeHtml(wf.sync.lastAttemptAt) : "never"}</dd>
      <dt>FS</dt><dd>${escapeHtml(wf.sync.fs.status)} — ${wf.sync.fs.activeCount} active${
        wf.sync.fs.lastError ? `, error: ${escapeHtml(wf.sync.fs.lastError)}` : ""
      }</dd>
      <dt>WTB</dt><dd>${escapeHtml(wf.sync.wtb.status)} — ${wf.sync.wtb.activeCount} active${
        wf.sync.wtb.lastError ? `, error: ${escapeHtml(wf.sync.wtb.lastError)}` : ""
      }</dd>
    </dl>
  </section>`;
}

function renderAiMatchingCard(ai: AdminDashboardData["aiMatching"]): string {
  const keyConfigured = ai.provider === "openai" ? ai.openaiKeyConfigured : ai.anthropicKeyConfigured;
  const model = ai.provider === "openai" ? ai.openaiModel || "—" : ai.model;
  return `<section class="card">
    <h2>AI matching</h2>
    ${badge("active", ai.chatActive || null)}
    <dl>
      <dt>Provider</dt><dd>${escapeHtml(ai.provider)}</dd>
      <dt>Model</dt><dd>${escapeHtml(model)}</dd>
      <dt>API key configured</dt><dd>${keyConfigured ? "yes" : "no"}</dd>
      <dt>Inventory enrichment</dt><dd>${ai.enrichmentEnabled ? `enabled (max ${ai.enrichmentMaxPerSync}/sync)` : "disabled"}</dd>
      <dt>Test phones</dt><dd>${ai.testPhones.length ? ai.testPhones.map(escapeHtml).join(", ") : "none configured"}</dd>
    </dl>
  </section>`;
}

function renderDeploymentCard(dep: AdminDashboardData["deployment"]): string {
  return `<section class="card">
    <h2>Deployment health</h2>
    ${badge("process", true)}
    <dl>
      <dt>Environment</dt><dd>${escapeHtml(dep.nodeEnv)}</dd>
      <dt>Node version</dt><dd>${escapeHtml(dep.nodeVersion)}</dd>
      <dt>Port</dt><dd>${dep.port}</dd>
      <dt>Public base URL</dt><dd>${dep.publicBaseUrl ? escapeHtml(dep.publicBaseUrl) : "not set"}</dd>
      <dt>Uptime</dt><dd>${formatUptime(dep.uptimeSeconds)}</dd>
      <dt>Started at</dt><dd>${escapeHtml(dep.startedAt)}</dd>
      <dt>Persist dir present</dt><dd>${dep.persistDirExists ? "yes" : "no"}</dd>
    </dl>
  </section>`;
}

function renderContactsCard(contacts: AdminDashboardData["contacts"]): string {
  return `<section class="card full">
    <h2>Contacts CSV upload</h2>
    <dl>
      <dt>Loaded contacts</dt><dd>${contacts.total} (${contacts.tierAB} tier A/B)</dd>
      <dt>CSV path</dt><dd>${escapeHtml(contacts.csvPath)}</dd>
      <dt>File present</dt><dd>${contacts.csvExists ? "yes" : "no — currently using bundled sample data"}</dd>
    </dl>
    <p class="muted">Replaces the persisted contacts.csv and reloads it immediately — the same workflow as
      <code>POST /admin/upload/contacts</code>, authenticated by this browser session instead of a token in the URL.</p>
    <input type="file" id="contactsFile" accept=".csv,text/csv">
    <div><button type="button" id="contactsUploadBtn">Upload</button></div>
    <div id="contactsUploadResult" class="muted"></div>
    <script>
      document.getElementById('contactsUploadBtn').addEventListener('click', async function () {
        var input = document.getElementById('contactsFile');
        var result = document.getElementById('contactsUploadResult');
        if (!input.files || !input.files[0]) { result.textContent = 'Choose a file first.'; return; }
        result.textContent = 'Uploading…';
        try {
          var text = await input.files[0].text();
          var session = await fetch('/admin/api/session', { credentials: 'same-origin' }).then(function (r) { return r.json(); });
          var res = await fetch('/admin/panel/upload-contacts', {
            method: 'POST',
            headers: { 'Content-Type': 'text/csv', 'X-CSRF-Token': session.csrfToken },
            credentials: 'same-origin',
            body: text,
          });
          var body = await res.json();
          result.textContent = res.ok
            ? 'Uploaded — ' + body.contacts + ' contact(s) loaded.'
            : 'Upload failed: ' + (body.error || res.status);
        } catch (err) {
          result.textContent = 'Upload failed: ' + err;
        }
      });
    </script>
  </section>`;
}

function renderMembershipCard(metrics: AdminDashboardData["metrics"], metricsError: string | null): string {
  if (!metrics) {
    return `<section class="card">
      <h2>Membership</h2>
      ${badge("metrics", false)}
      <dl><dt>Error</dt><dd>${escapeHtml(metricsError ?? "unknown error")}</dd></dl>
    </section>`;
  }
  const m = metrics.membership;
  return `<section class="card">
    <h2>Membership</h2>
    <dl>
      <dt>Total users</dt><dd>${m.totalUsers}</dd>
      <dt>Paid</dt><dd>${m.paid}</dd>
      <dt>Comped (admin override, no plan)</dt><dd>${m.comped}</dd>
      <dt>Trial (active)</dt><dd>${m.trial}</dd>
      <dt>Non-paying (trial exhausted)</dt><dd>${m.nonPaying}</dd>
      <dt>Canceled (approx.)</dt><dd>${m.canceledApprox}</dd>
    </dl>
    <p class="muted">"Canceled" is approximated: no live cancellation event is tracked anywhere yet, so this
      counts accounts with no active plan that have approved at least one match before -- it can't
      distinguish an actual downgrade from someone who simply never converted past their trial.</p>
  </section>`;
}

function renderNetworkReachCard(metrics: AdminDashboardData["metrics"]): string {
  if (!metrics) return "";
  const r = metrics.networkReach;
  const rows = (["whatsapp", "telegram", "sms"] as const).map((platform) => {
    const c = r.channels[platform];
    return `<tr><td>${escapeHtml(channelLabel(platform))}</td><td>${c.groupsConnected}</td><td>${c.groupMemberships.toLocaleString()}</td><td>${c.knownUniqueUsers.toLocaleString()}</td><td>${c.activeUsers30d.toLocaleString()}</td><td>${c.groupsMissingMemberCount}</td></tr>`;
  }).join("");
  return `<section class="card full" id="members">
    <h2>Members / Network Reach</h2>
    <table>
      <thead><tr><th>Channel</th><th>Groups</th><th>Group memberships</th><th>Known unique users</th><th>Active users (30d)</th><th>Groups missing count</th></tr></thead>
      <tbody>${rows}<tr><th>Total</th><th>${r.total.groupsConnected}</th><th>${r.total.groupMemberships.toLocaleString()}</th><th>${r.total.knownUniqueUsers.toLocaleString()}</th><th>${r.total.activeUsers30d.toLocaleString()}</th><th>${r.total.groupsMissingMemberCount}</th></tr></tbody>
    </table>
    <p class="muted">Group memberships are gross reach from the stored member count on each active group, so the same dealer can appear in more than one group. Known unique users are canonical Fi accounts; the Total row deduplicates people linked on multiple channels. SMS has no groups, so its group counts are always zero.</p>
  </section>`;
}

function renderPaymentsCard(metrics: AdminDashboardData["metrics"]): string {
  if (!metrics) return "";
  const fmt = (cents: number) => `$${(cents / 100).toFixed(2)}`;
  return `<section class="card">
    <h2>Payments</h2>
    <dl>
      <dt>Year to date</dt><dd>${fmt(metrics.payments.yearToDateCents)}</dd>
      <dt>Current month</dt><dd>${fmt(metrics.payments.currentMonthCents)}</dd>
    </dl>
    <p class="muted">No live payment processor is wired up yet (see "Not yet wired up" in the README) --
      every ledger entry is $0 by design. This will start reflecting real revenue automatically once one exists.</p>
  </section>`;
}

function renderTopRequestsCard(metrics: AdminDashboardData["metrics"]): string {
  if (!metrics) return "";
  const rows = metrics.topRequests.length
    ? `<ol class="plain">${metrics.topRequests.map((t) => `<li>${escapeHtml(t.query)} — ${t.count}</li>`).join("")}</ol>`
    : `<p class="muted">No searches logged yet.</p>`;
  return `<section class="card">
    <h2>Top requests (last 30 days)</h2>
    ${rows}
    <p class="muted">Tracking started when this feature shipped -- no historical backfill.</p>
  </section>`;
}

function renderActivityCard(metrics: AdminDashboardData["metrics"]): string {
  if (!metrics) return "";
  const rows = metrics.activityByUser.length
    ? `<table><thead><tr><th>Identity</th><th>Searches</th><th>Approvals</th><th>Last active</th><th>Preferred Channel</th><th>Linked Identities</th></tr></thead><tbody>${metrics.activityByUser
        .map(
          (a) =>
            `<tr><td>${escapeHtml(a.phone)}</td><td>${a.searches}</td><td>${a.approvals}</td><td>${
              a.lastActiveAt ? escapeHtml(a.lastActiveAt) : "—"
            }</td><td>${a.preferredChannel ? escapeHtml(channelLabel(a.preferredChannel)) : "—"}</td><td>${
              a.linkedIdentities.length
                ? escapeHtml(a.linkedIdentities.map((li) => `${channelLabel(li.platform)}: ${li.identity}`).join(", "))
                : "—"
            }</td></tr>`
        )
        .join("")}</tbody></table>`
    : `<p class="muted">No user activity recorded yet.</p>`;
  return `<section class="card full">
    <h2>Activity by user (top 20, most recent first)</h2>
    ${rows}
  </section>`;
}

export function renderDashboard(data: AdminDashboardData): string {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>LuxFi Admin</title>
<style>${PAGE_STYLES}</style>
</head>
<body>
  <header>
    <h1>LuxFi Admin</h1>
    <nav><a href="#members">Members</a><a href="/admin/users">Users</a><a href="/admin/groups">Groups</a><a href="/admin/coverage">WTB Coverage</a><a href="/admin/tools">Tools</a><a href="/admin/logout">Sign out</a></nav>
  </header>
  <main>
    ${renderWhapiCard(data.whapi)}
    ${renderDatabaseCard(data.database)}
    ${renderMembershipCard(data.metrics, data.metricsError)}
    ${renderNetworkReachCard(data.metrics)}
    ${renderPaymentsCard(data.metrics)}
    ${renderTopRequestsCard(data.metrics)}
    ${renderMarketUpdatesCard(data.marketUpdates)}
    ${renderPostingsV4Card(data.postingsV4)}
    ${renderWatchfactsCard(data.watchfacts)}
    ${renderAiMatchingCard(data.aiMatching)}
    ${renderDeploymentCard(data.deployment)}
    ${renderContactsCard(data.contacts)}
    ${renderActivityCard(data.metrics)}
  </main>
  <footer>Read-only status — generated at ${escapeHtml(data.generatedAt)}. Only the contacts upload above changes anything.</footer>
</body>
</html>`;
}
