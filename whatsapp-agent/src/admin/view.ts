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

// A quiet nod to "luxury watch dealer" rather than a generic dev-tool look: a warm parchment
// background instead of stark white/gray, a brass accent for headings/actions instead of the
// usual all-blue admin palette, and a serif brand mark — while keeping data-dense sections
// (tables, dl rows, badges) in a plain, highly legible sans so status information never suffers
// for the sake of style.
const PAGE_STYLES = `
:root {
  color-scheme: light dark;
  --bg: #f7f3ec;
  --surface: #ffffff;
  --border: #e6ddcc;
  --ink: #211d16;
  --muted: #6f6656;
  --brass: #96702f;
  --brass-dark: #7a5a23;
  --brass-tint: #f1e6d0;
  --ok-bg: #dcfce7; --ok-fg: #166534;
  --bad-bg: #fee2e2; --bad-fg: #991b1b;
  --unknown-bg: #ece7db; --unknown-fg: #5b5343;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #17140f; --surface: #221e16; --border: #3a3324; --ink: #f1ebdd; --muted: #b9ae95;
    --brass: #d3a75c; --brass-dark: #e6bf7c; --brass-tint: #2c2517;
    --ok-bg: #123324; --ok-fg: #4ade80; --bad-bg: #3a1414; --bad-fg: #f87171;
    --unknown-bg: #2c2718; --unknown-fg: #cbbf9e;
  }
}
* { box-sizing: border-box; }
body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; margin: 0; background: var(--bg); color: var(--ink); }
a { color: var(--brass-dark); }
header { padding: 18px 28px; border-bottom: 1px solid var(--border); display: flex; justify-content: space-between; align-items: center; gap: 16px; background: var(--surface); }
header .brand { font-family: Georgia, "Times New Roman", serif; font-size: 19px; font-weight: 600; letter-spacing: .01em; margin: 0; }
header .brand small { display: block; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; font-size: 10px; letter-spacing: .12em; text-transform: uppercase; color: var(--muted); font-weight: 500; margin-top: 2px; }
header a { color: var(--muted); text-decoration: none; font-size: 13px; }
header nav { display:flex; gap:16px; align-items:center; flex-wrap:wrap; }
header nav a:hover, header nav a.active { color: var(--brass-dark); }
main { max-width: 1080px; margin: 0 auto; padding: 22px 28px 60px; }
.hero { display: grid; gap: 14px; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); margin-bottom: 20px; }
.stat { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 18px 20px; border-top: 3px solid var(--brass); }
.stat-value { font-size: 30px; font-weight: 700; line-height: 1.1; font-family: Georgia, "Times New Roman", serif; }
.stat-label { font-size: 12px; color: var(--muted); margin-top: 4px; text-transform: uppercase; letter-spacing: .04em; }
h3.section-label { font-size: 12px; text-transform: uppercase; letter-spacing: .08em; color: var(--brass-dark); margin: 26px 0 10px; font-weight: 700; }
.grid { display: grid; gap: 16px; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); }
.card { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 16px 18px; }
.card h2 { margin: 0 0 10px; font-size: 13px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); }
.card dl { margin: 8px 0 0; display: grid; grid-template-columns: auto 1fr; gap: 5px 12px; font-size: 13px; }
.card dt { color: var(--muted); }
.card dd { margin: 0; word-break: break-word; }
.badge { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 600; margin-right: 6px; }
.badge.ok { background: var(--ok-bg); color: var(--ok-fg); }
.badge.bad { background: var(--bad-bg); color: var(--bad-fg); }
.badge.unknown { background: var(--unknown-bg); color: var(--unknown-fg); }
ul.plain, ol.plain { margin: 8px 0 0; padding-left: 18px; font-size: 13px; }
.full { grid-column: 1 / -1; }
.card table, main table { width: 100%; border-collapse: collapse; font-size: 12.5px; margin-top: 8px; }
.card th, .card td, main th, main td { text-align: left; padding: 7px 8px; border-bottom: 1px solid var(--border); }
main th { color: var(--muted); font-weight: 600; font-size: 11.5px; text-transform: uppercase; letter-spacing: .03em; }
details.system-status { margin-top: 26px; }
details.system-status > summary { cursor: pointer; font-size: 12px; text-transform: uppercase; letter-spacing: .08em; color: var(--muted); font-weight: 700; padding: 4px 0; }
details.system-status[open] > summary { color: var(--brass-dark); }
details.system-status .grid { margin-top: 14px; }
form.login { max-width: 340px; margin: 90px auto; padding: 26px; border: 1px solid var(--border); border-radius: 10px; background: var(--surface); }
form.login h1 { font-family: Georgia, "Times New Roman", serif; font-size: 17px; margin: 0 0 16px; font-weight: 600; }
input, select, textarea { background: var(--surface); color: var(--ink); border: 1px solid var(--border); }
form.login input, .card input, .card select, .card textarea, main input, main select, main textarea { width: 100%; padding: 9px 10px; border-radius: 6px; margin-bottom: 12px; font-size: 14px; font-family: inherit; }
form.login button, .card button, main button, .btn { padding: 8px 14px; border-radius: 6px; border: 1px solid var(--brass-dark); background: var(--brass); color: #fff; font-size: 13px; cursor: pointer; font-weight: 600; }
form.login button:hover, .card button:hover, main button:hover, .btn:hover { background: var(--brass-dark); }
button.secondary, .btn.secondary { background: transparent; color: var(--brass-dark); }
button.secondary:hover, .btn.secondary:hover { background: var(--brass-tint); }
button.danger, .btn.danger { background: var(--bad-fg); border-color: var(--bad-fg); }
form.login button { width: 100%; }
.error { color: var(--bad-fg); font-size: 13px; margin-bottom: 12px; }
.muted { color: var(--muted); font-size: 12px; margin-top: 8px; }
input[type=file] { font-size: 13px; margin-top: 8px; width: auto; }
input[type=checkbox] { width: auto; margin: 0 6px 0 0; }
label.checkbox { display: flex; align-items: center; font-size: 13px; margin-bottom: 12px; }
footer { text-align: center; color: var(--muted); font-size: 11px; padding: 10px 0 30px; }
dialog { border: none; border-radius: 12px; padding: 0; max-width: 480px; width: 92vw; background: var(--surface); color: var(--ink); }
dialog::backdrop { background: rgba(20,17,10,.45); }
dialog form { padding: 22px; }
dialog h2 { margin: 0 0 16px; font-size: 15px; font-family: Georgia, "Times New Roman", serif; }
dialog label { display: block; font-size: 12px; color: var(--muted); margin-bottom: 4px; }
.dialog-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 6px; }
.toolbar { display: flex; gap: 8px; margin-bottom: 14px; align-items: center; flex-wrap: wrap; }
.toolbar .spacer { flex: 1; }
.row-actions { display: flex; gap: 6px; }
.row-actions button { padding: 4px 9px; font-size: 12px; }
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
    <h1>LuxFi — Admin</h1>
    ${error ? `<div class="error">${escapeHtml(error)}</div>` : ""}
    <input type="text" name="username" placeholder="Username" autocomplete="username" autofocus required>
    <input type="password" name="password" placeholder="Password" autocomplete="current-password" required>
    <button type="submit">Sign in</button>
  </form>
</body>
</html>`;
}

type ManagementKind = "users" | "groups" | "administrators" | "coverage";

/** Field schemas the client-side script below uses to render add/edit forms and table columns
 *  for each entity — kept in one place so the shape sent to the existing POST/PUT routes always
 *  matches what admin/store.ts's saveUser/saveGroup/saveAdministrator actually accept. */
const FIELD_SCHEMAS: Record<string, unknown> = {
  users: [
    { name: "phone", label: "Phone", type: "text", required: true },
    { name: "name", label: "Name", type: "text", required: true },
    { name: "company", label: "Company", type: "text" },
    { name: "email", label: "Email", type: "email" },
    { name: "tier", label: "Tier", type: "select", options: ["", "A", "B", "C"] },
    { name: "specialty", label: "Specialty", type: "text" },
    { name: "wf_profile_id", label: "WatchFacts Profile ID", type: "text" },
    { name: "membership_status", label: "Membership Status", type: "text" },
    { name: "subscription_status", label: "Subscription Status", type: "text" },
    { name: "access_status", label: "Access Status", type: "select", options: ["active", "inactive", "blocked"], default: "active" },
    { name: "trial_limit", label: "Trial Limit", type: "number", default: 3 },
    { name: "complimentary_access", label: "Complimentary Access", type: "checkbox" },
    { name: "opt_in_status", label: "Opt-in Status", type: "text" },
    { name: "opt_in_source", label: "Opt-in Source", type: "text" },
    { name: "notes", label: "Notes", type: "textarea" },
  ],
  groups: [
    { name: "group_name", label: "Group Name", type: "text", required: true },
    { name: "whatsapp_chat_id", label: "Chat ID", type: "text", required: true },
    { name: "platform", label: "Platform", type: "select", options: ["whatsapp", "telegram"], default: "whatsapp" },
    { name: "status", label: "Status", type: "select", options: ["active", "inactive"], default: "active" },
    { name: "monitoring_enabled", label: "Monitoring Enabled", type: "checkbox" },
    { name: "concierge_enabled", label: "Concierge Enabled", type: "checkbox" },
    { name: "monitor_fs", label: "Monitor FS", type: "checkbox", default: true },
    { name: "monitor_wtb", label: "Monitor WTB", type: "checkbox", default: true },
    { name: "categories", label: "Categories (comma-separated)", type: "text" },
    { name: "country", label: "Country", type: "text" },
    { name: "timezone", label: "Timezone", type: "text" },
    { name: "member_count", label: "Member Count", type: "number" },
    { name: "notes", label: "Notes", type: "textarea" },
  ],
  administrators: [
    { name: "name", label: "Name", type: "text", required: true },
    { name: "username", label: "Username", type: "text", required: true },
    { name: "email", label: "Email", type: "email", required: true },
    { name: "role", label: "Role", type: "select", options: ["owner", "administrator", "support", "read_only"], default: "administrator" },
    { name: "status", label: "Status", type: "select", options: ["active", "inactive"], default: "active", editOnly: true },
    { name: "password", label: "Password (min 12 characters)", type: "password", createOnly: true },
  ],
};

export function renderManagementPage(kind: ManagementKind): string {
  const title = kind === "users" ? "Approved Users" : kind === "groups" ? "Group Management" : kind === "coverage" ? "WTB Coverage / Dealer Specialists" : "Administrators";
  const empty = kind === "groups" ? "No approved groups yet. Add the exact WhatsApp chat ID after the number is restored; wildcards are never accepted." : `No ${title.toLowerCase()} found.`;
  const editable = kind === "users" || kind === "groups" || kind === "administrators";
  const deletable = kind === "users" || kind === "groups";
  const idKey = "id";
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>LuxFi — ${title}</title><style>${PAGE_STYLES} main{max-width:1200px}</style></head><body>
<header>
  <div class="brand">LuxFi<small>Admin</small></div>
  <nav><a href="/admin#business">Dashboard</a><a href="/admin/users" class="${kind === "users" ? "active" : ""}">Users</a><a href="/admin/groups" class="${kind === "groups" ? "active" : ""}">Groups</a><a href="/admin/coverage" class="${kind === "coverage" ? "active" : ""}">WTB Coverage</a><a href="/admin/administrators" class="${kind === "administrators" ? "active" : ""}">Administrators</a><a href="/admin/logout">Sign out</a></nav>
</header>
<main>
  <h1 style="font-family:Georgia,'Times New Roman',serif;font-size:20px;margin:22px 0 14px">${title}</h1>
  <section class="card">
    ${kind === "groups" ? '<p class="muted">Groups Fi listens to for passive monitoring, and/or actively posts into (push groups are configured independently under listing settings).</p>' : ""}
    <div class="toolbar">
      <input id="q" placeholder="Search" style="max-width:220px;margin-bottom:0">
      <select id="status" style="max-width:160px;margin-bottom:0"><option value="">All statuses</option><option>active</option><option>inactive</option>${kind === "users" ? "<option>blocked</option>" : ""}</select>
      <button onclick="load()">Search</button>
      ${kind === "users" ? '<a href="/admin/api/users/template.csv">CSV template</a> <a href="/admin/api/users/export.csv">Export CSV</a>' : ""}
      <span class="spacer"></span>
      ${editable ? '<button id="addBtn" class="btn">+ Add new</button>' : ""}
    </div>
    <div id="empty" class="muted">Loading…</div>
    <table id="table" hidden><thead></thead><tbody></tbody></table>
    <pre id="error" class="error"></pre>
  </section>
</main>
${editable ? `<dialog id="formDialog"><form id="entityForm"><h2 id="formTitle">Add</h2><div id="formFields"></div><input type="hidden" id="formId"><div class="dialog-actions"><button type="button" class="secondary" onclick="document.getElementById('formDialog').close()">Cancel</button><button type="submit">Save</button></div><div id="formError" class="error"></div></form></dialog>` : ""}
<script>
  const kind=${JSON.stringify(kind)}, endpoint='/admin/api/'+kind, idKey=${JSON.stringify(idKey)};
  const editable=${JSON.stringify(editable)}, deletable=${JSON.stringify(deletable)};
  const schema=${JSON.stringify((FIELD_SCHEMAS as any)[kind] ?? [])};
  let csrf='', myRole='';
  const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

  async function session(){const s=await fetch('/admin/api/session').then(r=>r.json());csrf=s.csrfToken||'';myRole=(s.administrator&&s.administrator.role)||'';return s}

  async function load(){
    await session();
    const u=new URL(endpoint,location.origin);u.searchParams.set('q',document.querySelector('#q').value);u.searchParams.set('status',document.querySelector('#status').value);
    const response=await fetch(u);if(response.status===403){document.querySelector('#empty').textContent='Owner role required.';document.querySelector('#empty').hidden=false;document.querySelector('#table').hidden=true;return}
    const data=await response.json(),rows=Array.isArray(data)?data:data.rows||[];
    document.querySelector('#empty').hidden=Boolean(rows.length);document.querySelector('#empty').textContent=${JSON.stringify(empty)};
    const table=document.querySelector('#table');table.hidden=!rows.length;if(!rows.length)return;
    const hidden=['password_hash'];const keys=Object.keys(rows[0]).filter(k=>!hidden.includes(k));
    const canModify=editable&&myRole!=='read_only'&&(kind!=='administrators'||myRole==='owner');
    table.querySelector('thead').innerHTML='<tr>'+keys.map(k=>'<th>'+esc(k)+'</th>').join('')+(canModify?'<th></th>':'')+'</tr>';
    table.querySelector('tbody').innerHTML=rows.map(r=>'<tr>'+keys.map(k=>'<td>'+esc(Array.isArray(r[k])?r[k].join(', '):r[k])+'</td>').join('')+(canModify?'<td class="row-actions">'+
      '<button type="button" class="secondary" onclick="openEdit('+JSON.stringify(JSON.stringify(r)).replace(/"/g,'&quot;')+')">Edit</button>'+
      (kind==='administrators'?'<button type="button" class="secondary" onclick="resetPassword('+r[idKey]+')">Reset PW</button>':'')+
      (deletable?'<button type="button" class="danger" onclick="removeRow('+r[idKey]+')">Delete</button>':'')+
      '</td>':'')+'</tr>').join('')
  }
  load().catch(e=>document.querySelector('#error').textContent=e.message);

  if(editable){
    const dialog=document.getElementById('formDialog'), form=document.getElementById('entityForm'), fieldsEl=document.getElementById('formFields');
    function fieldHtml(f,value){
      const v=value===undefined?(f.default!==undefined?f.default:''):value;
      if(f.type==='checkbox')return '<label class="checkbox"><input type="checkbox" name="'+f.name+'"'+(v?' checked':'')+'> '+esc(f.label)+'</label>';
      if(f.type==='select')return '<label>'+esc(f.label)+'</label><select name="'+f.name+'">'+f.options.map(o=>'<option value="'+esc(o)+'"'+(o===v?' selected':'')+'>'+esc(o||'—')+'</option>').join('')+'</select>';
      if(f.type==='textarea')return '<label>'+esc(f.label)+'</label><textarea name="'+f.name+'" rows="3">'+esc(v)+'</textarea>';
      return '<label>'+esc(f.label)+(f.required?' *':'')+'</label><input type="'+f.type+'" name="'+f.name+'" value="'+esc(f.type==='password'?'':v)+'"'+(f.required&&!value?' required':'')+'>';
    }
    function openForm(title,row){
      document.getElementById('formTitle').textContent=title;
      document.getElementById('formId').value=row&&row[idKey]?row[idKey]:'';
      document.getElementById('formError').textContent='';
      fieldsEl.innerHTML=schema.filter(f=>!(row&&f.createOnly)).map(f=>fieldHtml(f,row?row[f.name]:undefined)).join('');
      dialog.showModal();
    }
    document.getElementById('addBtn')?.addEventListener('click',()=>openForm('Add',null));
    window.openEdit=function(json){openForm('Edit',JSON.parse(json))};
    form.addEventListener('submit',async function(e){
      e.preventDefault();
      const id=document.getElementById('formId').value;
      const payload={};
      for(const f of schema){
        if(row_skip(f,id))continue;
        const el=form.elements[f.name];if(!el)continue;
        payload[f.name]=f.type==='checkbox'?el.checked:(f.type==='number'?(el.value===''?null:Number(el.value)):el.value);
      }
      function row_skip(f,id){return id&&f.createOnly}
      try{
        await session();
        const res=await fetch(id?endpoint+'/'+id:endpoint,{method:id?'PUT':'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':csrf},body:JSON.stringify(payload)});
        const body=await res.json();
        if(!res.ok){document.getElementById('formError').textContent=body.error||'Save failed';return}
        dialog.close();load();
      }catch(err){document.getElementById('formError').textContent=String(err)}
    });
  }
  window.removeRow=async function(id){
    if(!confirm('Delete this '+kind.replace(/s$/,'')+'? This cannot be undone.'))return;
    await session();
    const res=await fetch(endpoint+'/'+id,{method:'DELETE',headers:{'X-CSRF-Token':csrf}});
    if(!res.ok){alert('Delete failed: '+(await res.json().catch(()=>({}))).error);return}
    load();
  };
  window.resetPassword=async function(id){
    const pw=prompt('New password (min 12 characters):');if(!pw)return;
    await session();
    const res=await fetch(endpoint+'/'+id+'/reset-password',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':csrf},body:JSON.stringify({password:pw})});
    if(!res.ok){alert('Reset failed: '+(await res.json().catch(()=>({}))).error);return}
    alert('Password reset.');
  };
</script>
</body></html>`;
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

/** The three things that actually make Fi valuable, at a glance: the matching engine working
 *  (active matches), the multi-channel concierge's real reach (network-wide known users), and
 *  market intelligence in motion (live FS/WTB requests currently being monitored). Falls back to
 *  "—" per-tile rather than hiding the row, since a partial-data page is still more useful than
 *  losing the whole hero when only one dependency (e.g. Postgres) is having a bad day. */
function renderHeroStats(data: AdminDashboardData): string {
  const fmt = (n: number | null) => (n === null ? "—" : n.toLocaleString());
  const activeMatches = data.postingsV4.operational ? data.postingsV4.operational.activeMatches : null;
  const liveListings = data.postingsV4.operational
    ? data.postingsV4.operational.activeFsMonitors + data.postingsV4.operational.activeWtbMonitors
    : null;
  const networkUsers = data.metrics ? data.metrics.networkReach.total.knownUniqueUsers : null;
  return `<section class="hero">
    <div class="stat"><div class="stat-value">${fmt(activeMatches)}</div><div class="stat-label">Active matches</div></div>
    <div class="stat"><div class="stat-value">${fmt(liveListings)}</div><div class="stat-label">Live FS/WTB requests monitored</div></div>
    <div class="stat"><div class="stat-value">${fmt(networkUsers)}</div><div class="stat-label">Network reach (unique users)</div></div>
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
    <div class="brand">LuxFi<small>Admin</small></div>
    <nav><a href="#business">Dashboard</a><a href="/admin/users">Users</a><a href="/admin/groups">Groups</a><a href="/admin/coverage">WTB Coverage</a><a href="/admin/logout">Sign out</a></nav>
  </header>
  <main>
    ${renderHeroStats(data)}
    <div id="business"></div>
    <div class="grid">
      ${renderMembershipCard(data.metrics, data.metricsError)}
      ${renderPaymentsCard(data.metrics)}
      ${renderTopRequestsCard(data.metrics)}
      ${renderMarketUpdatesCard(data.marketUpdates)}
      ${renderPostingsV4Card(data.postingsV4)}
      ${renderNetworkReachCard(data.metrics)}
      ${renderContactsCard(data.contacts)}
      ${renderActivityCard(data.metrics)}
    </div>
    <details class="system-status">
      <summary>System status (Whapi, database, WatchFacts sync, AI matching, deployment)</summary>
      <div class="grid">
        ${renderWhapiCard(data.whapi)}
        ${renderDatabaseCard(data.database)}
        ${renderWatchfactsCard(data.watchfacts)}
        ${renderAiMatchingCard(data.aiMatching)}
        ${renderDeploymentCard(data.deployment)}
      </div>
    </details>
  </main>
  <footer>Read-only status — generated at ${escapeHtml(data.generatedAt)}. Only the contacts upload and the Users/Groups/Administrators pages change anything.</footer>
</body>
</html>`;
}
