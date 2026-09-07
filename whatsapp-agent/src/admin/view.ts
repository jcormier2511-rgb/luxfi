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
:root {
  color-scheme: light dark;
  --bg: #f5f6f8;
  --surface: #ffffff;
  --surface-2: #f8f9fb;
  --border: #e2e4e8;
  --text: #16181d;
  --text-muted: #6b7280;
  --text-faint: #9aa1ac;
  --accent: #4f46e5;
  --accent-hover: #4338ca;
  --accent-bg: #eef2ff;
  --danger: #dc2626;
  --danger-hover: #b91c1c;
  --danger-bg: #fee2e2;
  --danger-text: #991b1b;
  --ok-bg: #dcfce7;
  --ok-text: #166534;
  --unknown-bg: #e5e7eb;
  --unknown-text: #374151;
  --radius: 12px;
  --radius-sm: 8px;
  --shadow: 0 1px 2px rgba(16,24,40,.04), 0 2px 8px rgba(16,24,40,.05);
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #101115;
    --surface: #1a1c22;
    --surface-2: #212329;
    --border: #2c2f37;
    --text: #e8e9ec;
    --text-muted: #9aa1ac;
    --text-faint: #6b7280;
    --accent: #818cf8;
    --accent-hover: #a5b4fc;
    --accent-bg: #23253a;
    --danger: #f87171;
    --danger-hover: #fca5a5;
    --danger-bg: #3a1e1e;
    --danger-text: #fca5a5;
    --ok-bg: #133523;
    --ok-text: #4ade80;
    --unknown-bg: #2a2d34;
    --unknown-text: #c7cad1;
    --shadow: 0 1px 2px rgba(0,0,0,.4);
  }
}
* { box-sizing: border-box; }
body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; margin: 0; background: var(--bg); color: var(--text); line-height: 1.45; }
h1, h2, h3 { font-weight: 600; }
a { color: var(--accent); }
header { position: sticky; top: 0; z-index: 10; padding: 14px 28px; border-bottom: 1px solid var(--border); background: var(--surface); display: flex; justify-content: space-between; align-items: center; gap: 16px; flex-wrap: wrap; }
header h1 { font-size: 16px; margin: 0; letter-spacing: -.01em; }
header nav { display: flex; gap: 4px; align-items: center; flex-wrap: wrap; }
header nav a { color: var(--text-muted); text-decoration: none; font-size: 13px; font-weight: 500; padding: 6px 12px; border-radius: 999px; transition: background-color .12s, color .12s; }
header nav a:hover { background: var(--surface-2); color: var(--text); }
header nav a[href="/admin/logout"] { color: var(--text-faint); }
header nav a.active { background: var(--accent-bg); color: var(--accent); font-weight: 600; }
.jumpnav { display: flex; gap: 6px; flex-wrap: wrap; margin: -6px 0 18px; grid-column: 1 / -1; }
.jumpnav a { font-size: 12.5px; font-weight: 500; color: var(--text-muted); background: var(--surface); border: 1px solid var(--border); padding: 5px 11px; border-radius: 999px; text-decoration: none; transition: background-color .12s, color .12s; }
.jumpnav a:hover { background: var(--surface-2); color: var(--text); }
main { max-width: 1080px; margin: 0 auto; padding: 24px 28px 56px; display: grid; gap: 18px; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); }
main.stack { display: block; }
.card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 20px 22px; box-shadow: var(--shadow); overflow-x: auto; }
.card h2 { margin: 0 0 4px; font-size: 12px; text-transform: uppercase; letter-spacing: .06em; color: var(--text-muted); }
.card h2 + p.muted { margin-top: 2px; }
.card > h2:not(:first-child) { margin-top: 18px; padding-top: 16px; border-top: 1px solid var(--border); }
.card dl { margin: 12px 0 0; display: grid; grid-template-columns: auto 1fr; gap: 7px 14px; font-size: 13px; }
.card dt { color: var(--text-muted); }
.card dd { margin: 0; word-break: break-word; }
.badge { display: inline-block; padding: 3px 10px; border-radius: 999px; font-size: 11px; font-weight: 600; margin: 6px 6px 0 0; }
.badge.ok { background: var(--ok-bg); color: var(--ok-text); }
.badge.bad { background: var(--danger-bg); color: var(--danger-text); }
.badge.unknown { background: var(--unknown-bg); color: var(--unknown-text); }
ul.plain, ol.plain { margin: 10px 0 0; padding-left: 20px; font-size: 13px; }
ul.plain li, ol.plain li { margin-bottom: 3px; }
.full { grid-column: 1 / -1; }
table { width: 100%; border-collapse: collapse; font-size: 13px; margin-top: 10px; }
.card table { font-size: 12px; }
th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--border); }
thead th { color: var(--text-muted); font-size: 11px; text-transform: uppercase; letter-spacing: .04em; font-weight: 600; background: var(--surface-2); }
tbody tr:hover { background: var(--surface-2); }
.field { display: flex; flex-direction: column; gap: 4px; flex: 1; min-width: 160px; }
.field label { font-size: 12px; font-weight: 600; color: var(--text-muted); }
.field.checkbox { flex-direction: row; align-items: center; gap: 6px; min-width: auto; }
.field.checkbox label { font-size: 13px; font-weight: 500; color: var(--text); }
label.inline { display: flex; align-items: center; gap: 6px; font-size: 13px; color: var(--text); white-space: nowrap; }
input, select, textarea { padding: 9px 11px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--surface); color: var(--text); font-size: 13px; font-family: inherit; }
input:focus, select:focus, textarea:focus { outline: 2px solid var(--accent); outline-offset: 1px; }
input[type=checkbox] { width: 15px; height: 15px; accent-color: var(--accent); }
button { padding: 9px 16px; border-radius: var(--radius-sm); border: 1px solid var(--accent); background: var(--accent); color: #fff; font-size: 13px; font-weight: 600; cursor: pointer; transition: background-color .12s, border-color .12s, opacity .12s; }
button:hover { background: var(--accent-hover); border-color: var(--accent-hover); }
button:active { opacity: .85; }
button.btn-outline { background: transparent; color: var(--text); border-color: var(--border); }
button.btn-outline:hover { background: var(--surface-2); border-color: var(--text-faint); }
button.btn-danger { background: var(--danger); border-color: var(--danger); }
button.btn-danger:hover { background: var(--danger-hover); border-color: var(--danger-hover); }
button.btn-danger.btn-outline { background: transparent; color: var(--danger); border-color: var(--danger-bg); }
button.btn-danger.btn-outline:hover { background: var(--danger-bg); }
.toolbar { display: flex; gap: 10px; margin-bottom: 14px; align-items: flex-end; flex-wrap: wrap; }
.toolbar input, .toolbar select { flex: 1; min-width: 140px; }
form.login { max-width: 360px; margin: 100px auto; padding: 30px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface); box-shadow: var(--shadow); }
form.login h1 { font-size: 16px; margin: 0 0 18px; font-weight: 600; }
form.login .field { margin-bottom: 12px; }
form.login input { width: 100%; padding: 10px 12px; font-size: 14px; }
form.login button { width: 100%; padding: 10px 14px; }
.error { color: var(--danger-text); background: var(--danger-bg); border-radius: var(--radius-sm); font-size: 13px; padding: 0; margin: 0; }
.error:not(:empty) { padding: 9px 12px; margin-bottom: 12px; }
pre { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
pre:not(.error):not(:empty) { background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 10px 12px; font-size: 12px; margin-top: 10px; }
.muted { color: var(--text-muted); font-size: 12px; margin-top: 8px; }
input[type=file] { font-size: 13px; margin-top: 8px; }
footer { text-align: center; color: var(--text-faint); font-size: 11px; padding: 14px 0 32px; }
@media (max-width: 640px) {
  header { padding: 12px 16px; }
  main { padding: 16px 16px 40px; }
  .card { padding: 16px; }
}
`;

/** Highlights whichever nav link matches the current page, so it's always visible at a glance
 *  which of the 7 admin pages you're on — resolved against each link's own href rather than
 *  hard-coded per page, so the same snippet works unmodified on every page that includes it. */
const NAV_ACTIVE_SCRIPT = `(function(){var path=location.pathname.replace(/\\/$/,'')||'/';document.querySelectorAll('header nav a').forEach(function(a){var href=a.getAttribute('href');var linkPath;try{linkPath=new URL(href,location.href).pathname.replace(/\\/$/,'')||'/'}catch(e){return}if(linkPath===path)a.classList.add('active')})})();`;

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
    <div class="field">
      <label for="login-username">Username</label>
      <input id="login-username" type="text" name="username" placeholder="Username" autocomplete="username" autofocus required>
    </div>
    <div class="field">
      <label for="login-password">Password</label>
      <input id="login-password" type="password" name="password" placeholder="Password" autocomplete="current-password" required>
    </div>
    <button type="submit">Sign in</button>
  </form>
</body>
</html>`;
}

const GROUP_FORM = `<section class="card" id="group-form-card">
  <h2 id="group-form-title">Add group</h2>
  <p class="muted">The chat ID is platform-specific: a WhatsApp group's digits, or a Telegram group/supergroup's numeric chat id (negative, e.g. -1001234567890) — grab it from the server logs after Fi is added and someone posts, or GET /admin/group-listings. Wildcards are never accepted.</p>
  <div class="toolbar">
    <div class="field"><label for="gf-name">Group name</label><input id="gf-name" placeholder="e.g. Miami Dealers"></div>
    <div class="field"><label for="gf-platform">Platform</label><select id="gf-platform"><option value="whatsapp">WhatsApp</option><option value="telegram">Telegram</option></select></div>
    <div class="field"><label for="gf-chatid">Chat ID</label><input id="gf-chatid" placeholder="Group chat id"></div>
  </div>
  <div class="toolbar">
    <div class="field"><label for="gf-status">Status</label><select id="gf-status"><option value="active">active</option><option value="inactive">inactive</option></select></div>
    <label class="inline"><input type="checkbox" id="gf-monitoring" checked> Monitoring enabled</label>
    <label class="inline"><input type="checkbox" id="gf-fs" checked> Monitor FS</label>
    <label class="inline"><input type="checkbox" id="gf-wtb" checked> Monitor WTB</label>
  </div>
  <div class="toolbar">
    <div class="field"><label for="gf-country">Country (optional)</label><input id="gf-country" placeholder="e.g. USA"></div>
    <div class="field"><label for="gf-notes">Notes (optional)</label><input id="gf-notes" placeholder="Anything worth remembering"></div>
  </div>
  <div class="toolbar">
    <button onclick="groupSave()" id="gf-save">Save group</button>
    <button onclick="groupReset()" class="btn-outline">Clear / new</button>
  </div>
  <pre id="gf-error" class="error"></pre>
</section>`;

export function renderManagementPage(kind:"users"|"groups"|"administrators"|"coverage"):string {
  const title=kind==="users"?"Approved Users":kind==="groups"?"Group Management":kind==="coverage"?"WTB Coverage / Dealer Specialists":"Administrators";
  const empty=kind==="groups"?"No approved groups yet. Add one below.":`No ${title.toLowerCase()} found.`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>LuxFi — ${title}</title><style>${PAGE_STYLES} main{display:block;max-width:1200px}pre{white-space:pre-wrap}</style></head><body><header><h1>${title}</h1><nav><a href="/admin#members">Members</a><a href="/admin/users">Users</a><a href="/admin/groups">Groups</a><a href="/admin/push-groups">Push Groups</a><a href="/admin/coverage">WTB Coverage</a><a href="/admin/administrators">Administrators</a><a href="/admin/tools">Tools</a><a href="/admin/logout">Sign out</a></nav></header><script>${NAV_ACTIVE_SCRIPT}</script><main>${kind==='groups'?GROUP_FORM:''}<section class="card">${kind==='groups'?'<h2>Monitoring Groups</h2><p class="muted">Groups Fi listens to (read-only — never posts here)</p>':''}<div class="toolbar"><div class="field"><label for="q">Search</label><input id="q" placeholder="Search"></div><div class="field"><label for="status">Status</label><select id="status"><option value="">All statuses</option><option>active</option><option>inactive</option>${kind==='users'?'<option>blocked</option>':''}</select></div><button onclick="load()">Search</button>${kind==='users'?'<a href="/admin/api/users/template.csv">CSV template</a> <a href="/admin/api/users/export.csv">Export CSV</a>':''}</div><div id="empty" class="muted">Loading…</div><table id="table" hidden><thead></thead><tbody></tbody></table><pre id="error" class="error"></pre></section></main><script>
  const kind=${JSON.stringify(kind)}, endpoint='/admin/api/'+kind; let csrf='', lastRows=[];
  const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  async function ensureCsrf(){if(csrf)return csrf;const session=await fetch('/admin/api/session').then(r=>r.json());csrf=session.csrfToken||'';return csrf}
  async function load(){await ensureCsrf();const u=new URL(endpoint,location.origin);u.searchParams.set('q',document.querySelector('#q').value);u.searchParams.set('status',document.querySelector('#status').value);const response=await fetch(u);if(response.status===403){location.href='/admin';return}const data=await response.json(),rows=Array.isArray(data)?data:data.rows||[];lastRows=rows;document.querySelector('#empty').textContent=rows.length?'':${JSON.stringify(empty)};const table=document.querySelector('#table');table.hidden=!rows.length;if(!rows.length)return;const hidden=['password_hash'];const keys=Object.keys(rows[0]).filter(k=>!hidden.includes(k));const cols=kind==='groups'?[...keys,'actions']:keys;table.querySelector('thead').innerHTML='<tr>'+cols.map(k=>'<th>'+esc(k)+'</th>').join('')+'</tr>';table.querySelector('tbody').innerHTML=rows.map(r=>'<tr>'+keys.map(k=>'<td>'+esc(Array.isArray(r[k])?r[k].join(', '):r[k])+'</td>').join('')+(kind==='groups'?'<td><button class="btn-outline" onclick="groupEdit('+r.id+')">Edit</button> <button class="btn-danger btn-outline" onclick="groupDelete('+r.id+')">Delete</button></td>':'')+'</tr>').join('')}
  load().catch(e=>document.querySelector('#error').textContent=e.message);
  ${kind==='groups'?`
  let gfEditId=null;
  function groupReset(){gfEditId=null;document.querySelector('#group-form-title').textContent='Add group';document.querySelector('#gf-name').value='';document.querySelector('#gf-platform').value='whatsapp';document.querySelector('#gf-chatid').value='';document.querySelector('#gf-status').value='active';document.querySelector('#gf-monitoring').checked=true;document.querySelector('#gf-fs').checked=true;document.querySelector('#gf-wtb').checked=true;document.querySelector('#gf-country').value='';document.querySelector('#gf-notes').value='';document.querySelector('#gf-error').textContent=''}
  function groupEdit(id){const r=lastRows.find(x=>x.id===id);if(!r)return;gfEditId=id;document.querySelector('#group-form-title').textContent='Edit group #'+id;document.querySelector('#gf-name').value=r.group_name||'';document.querySelector('#gf-platform').value=r.platform||'whatsapp';document.querySelector('#gf-chatid').value=r.whatsapp_chat_id||'';document.querySelector('#gf-status').value=r.status||'active';document.querySelector('#gf-monitoring').checked=!!r.monitoring_enabled;document.querySelector('#gf-fs').checked=r.monitor_fs!==false;document.querySelector('#gf-wtb').checked=r.monitor_wtb!==false;document.querySelector('#gf-country').value=r.country||'';document.querySelector('#gf-notes').value=r.notes||'';document.querySelector('#gf-error').textContent='';window.scrollTo(0,0)}
  async function groupDelete(id){if(!confirm('Delete group #'+id+'? This cannot be undone.'))return;try{const token=await ensureCsrf();const res=await fetch('/admin/api/groups/'+id,{method:'DELETE',headers:{'X-CSRF-Token':token}});if(res.status===403){location.href='/admin';return}if(!res.ok){const data=await res.json().catch(()=>({}));document.querySelector('#error').textContent=data.error||'Delete failed';return}load()}catch(e){document.querySelector('#error').textContent=e.message}}
  async function groupSave(){
    document.querySelector('#gf-error').textContent='';
    const body={group_name:document.querySelector('#gf-name').value.trim(),platform:document.querySelector('#gf-platform').value,whatsapp_chat_id:document.querySelector('#gf-chatid').value.trim(),status:document.querySelector('#gf-status').value,monitoring_enabled:document.querySelector('#gf-monitoring').checked,monitor_fs:document.querySelector('#gf-fs').checked,monitor_wtb:document.querySelector('#gf-wtb').checked,country:document.querySelector('#gf-country').value.trim(),notes:document.querySelector('#gf-notes').value.trim()};
    if(!body.group_name||!body.whatsapp_chat_id){document.querySelector('#gf-error').textContent='Group name and chat ID are required';return}
    try{
      const token=await ensureCsrf();
      const url=gfEditId?'/admin/api/groups/'+gfEditId:'/admin/api/groups';
      const res=await fetch(url,{method:gfEditId?'PUT':'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':token},body:JSON.stringify(body)});
      if(res.status===403){location.href='/admin';return}
      const data=await res.json();
      if(!res.ok){document.querySelector('#gf-error').textContent=data.error||'Save failed';return}
      groupReset();load();
    }catch(e){document.querySelector('#gf-error').textContent=e.message}
  }
  `:''}
  </script></body></html>`;
}

/**
 * Groups Fi actively POSTS a confirmed listing into (see postings/groupPublishing.ts) — distinct
 * from, and configured independently of, the read-only Monitoring Groups on /admin/groups. Was
 * previously curl-only (PUT /admin/api/listing-settings/push-groups/:groupId, no way to even
 * delete one); this is the first browser UI for it.
 */
export function renderPushGroupsPage(): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>LuxFi — Push Groups</title><style>${PAGE_STYLES} main{display:block;max-width:1200px}pre{white-space:pre-wrap}</style></head><body><header><h1>Push Groups</h1><nav><a href="/admin#members">Members</a><a href="/admin/users">Users</a><a href="/admin/groups">Groups</a><a href="/admin/push-groups">Push Groups</a><a href="/admin/coverage">WTB Coverage</a><a href="/admin/administrators">Administrators</a><a href="/admin/tools">Tools</a><a href="/admin/logout">Sign out</a></nav></header><script>${NAV_ACTIVE_SCRIPT}</script><main>

<section class="card" id="pg-form-card">
  <h2 id="pg-form-title">Add push group</h2>
  <p class="muted">Groups Fi actively posts a confirmed FS/WTB listing into (with the photo, when the listing has one) — separate from Monitoring Groups, which only listen. The chat ID is platform-specific: a WhatsApp group's digits, or a Telegram group/supergroup's numeric chat id (negative, e.g. -1001234567890).</p>
  <div class="toolbar">
    <div class="field"><label for="pg-id">Chat ID</label><input id="pg-id" placeholder="Group chat id"></div>
    <div class="field"><label for="pg-name">Group name</label><input id="pg-name" placeholder="e.g. Miami Dealers"></div>
    <div class="field"><label for="pg-platform">Platform</label><select id="pg-platform"><option value="whatsapp">WhatsApp</option><option value="telegram">Telegram</option></select></div>
    <div class="field"><label for="pg-priority">Priority</label><input id="pg-priority" type="number" value="100" placeholder="Lower posts first"></div>
  </div>
  <div class="toolbar">
    <label class="inline"><input type="checkbox" id="pg-enabled" checked> Enabled</label>
    <label class="inline"><input type="checkbox" id="pg-fs" checked> Allow FS</label>
    <label class="inline"><input type="checkbox" id="pg-wtb" checked> Allow WTB</label>
  </div>
  <div class="toolbar">
    <div class="field"><label for="pg-notes">Notes (optional)</label><input id="pg-notes" placeholder="Anything worth remembering"></div>
  </div>
  <div class="toolbar">
    <button onclick="pgSave()" id="pg-save">Save push group</button>
    <button onclick="pgReset()" class="btn-outline">Clear / new</button>
  </div>
  <pre id="pg-error" class="error"></pre>
</section>

<section class="card">
  <h2>Bulk upload (CSV)</h2>
  <p class="muted">Add or update many push groups at once — upload a CSV instead of using the form above for each one. A row's group_id must match an existing group to update it; a new group_id creates it. Columns: group_id, group_name, platform (whatsapp/telegram), enabled, allow_fs, allow_wtb, priority, notes.</p>
  <div class="toolbar">
    <input type="file" id="pg-csv-file" accept=".csv,text/csv">
    <button type="button" id="pg-csv-upload">Upload CSV</button>
    <a href="/admin/api/push-groups/template.csv">Download CSV template</a>
    <a href="/admin/api/push-groups/export.csv">Export current groups as CSV</a>
  </div>
  <div id="pg-csv-result" class="muted"></div>
</section>

<section class="card">
  <h2>Configured push groups</h2>
  <div id="pg-empty" class="muted">Loading…</div>
  <table id="pg-table" hidden><thead></thead><tbody></tbody></table>
</section>

</main><script>
  const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  let csrf='', lastRows=[], pgEditId=null;
  async function ensureCsrf(){if(csrf)return csrf;const session=await fetch('/admin/api/session').then(r=>r.json());csrf=session.csrfToken||'';return csrf}
  async function load(){
    await ensureCsrf();
    const res=await fetch('/admin/api/push-groups');
    if(res.status===403){location.href='/admin';return}
    const rows=await res.json();
    lastRows=rows;
    document.querySelector('#pg-empty').textContent=rows.length?'':'No push groups configured yet. Add one above.';
    const table=document.querySelector('#pg-table');table.hidden=!rows.length;if(!rows.length)return;
    const cols=['group_id','group_name','platform','enabled','allow_fs','allow_wtb','priority','notes','last_post_at','last_result','status_error','actions'];
    table.querySelector('thead').innerHTML='<tr>'+cols.map(k=>'<th>'+esc(k)+'</th>').join('')+'</tr>';
    table.querySelector('tbody').innerHTML=rows.map(r=>'<tr>'+cols.slice(0,-1).map(k=>'<td>'+esc(r[k])+'</td>').join('')+'<td><button class="btn-outline" onclick="pgEdit('+JSON.stringify(r.group_id)+')">Edit</button> <button class="btn-danger btn-outline" onclick="pgDelete('+JSON.stringify(r.group_id)+')">Delete</button></td></tr>').join('');
  }
  load().catch(e=>document.querySelector('#pg-empty').textContent=e.message);
  document.getElementById('pg-csv-upload').addEventListener('click',async function(){
    var input=document.getElementById('pg-csv-file');
    var result=document.getElementById('pg-csv-result');
    if(!input.files||!input.files[0]){result.textContent='Choose a CSV file first.';return}
    result.textContent='Uploading…';
    try{
      var text=await input.files[0].text();
      var token=await ensureCsrf();
      var res=await fetch('/admin/api/push-groups/import',{method:'POST',headers:{'Content-Type':'text/csv','X-CSRF-Token':token},credentials:'same-origin',body:text});
      if(res.status===403){location.href='/admin';return}
      var body=await res.json();
      if(!res.ok){result.textContent=body.error||'Upload failed';return}
      result.textContent=body.added+' added, '+body.updated+' updated'+(body.errors&&body.errors.length?', '+body.errors.length+' row(s) skipped: '+body.errors.map(function(e){return 'row '+e.row+': '+e.error}).join('; '):'');
      input.value='';
      load();
    }catch(e){result.textContent=e.message}
  });
  function pgReset(){pgEditId=null;document.querySelector('#pg-form-title').textContent='Add push group';document.querySelector('#pg-id').value='';document.querySelector('#pg-id').disabled=false;document.querySelector('#pg-name').value='';document.querySelector('#pg-platform').value='whatsapp';document.querySelector('#pg-priority').value='100';document.querySelector('#pg-enabled').checked=true;document.querySelector('#pg-fs').checked=true;document.querySelector('#pg-wtb').checked=true;document.querySelector('#pg-notes').value='';document.querySelector('#pg-error').textContent=''}
  function pgEdit(groupId){const r=lastRows.find(x=>x.group_id===groupId);if(!r)return;pgEditId=groupId;document.querySelector('#pg-form-title').textContent='Edit push group';document.querySelector('#pg-id').value=r.group_id;document.querySelector('#pg-id').disabled=true;document.querySelector('#pg-name').value=r.group_name||'';document.querySelector('#pg-platform').value=r.platform||'whatsapp';document.querySelector('#pg-priority').value=r.priority??100;document.querySelector('#pg-enabled').checked=!!r.enabled;document.querySelector('#pg-fs').checked=r.allow_fs!==false;document.querySelector('#pg-wtb').checked=r.allow_wtb!==false;document.querySelector('#pg-notes').value=r.notes||'';document.querySelector('#pg-error').textContent='';window.scrollTo(0,0)}
  async function pgDelete(groupId){if(!confirm('Delete push group '+groupId+'? This cannot be undone.'))return;try{const token=await ensureCsrf();const res=await fetch('/admin/api/listing-settings/push-groups/'+encodeURIComponent(groupId),{method:'DELETE',headers:{'X-CSRF-Token':token}});if(res.status===403){location.href='/admin';return}if(!res.ok){const data=await res.json().catch(()=>({}));document.querySelector('#pg-error').textContent=data.error||'Delete failed';return}if(pgEditId===groupId)pgReset();load()}catch(e){document.querySelector('#pg-error').textContent=e.message}}
  async function pgSave(){
    document.querySelector('#pg-error').textContent='';
    const groupId=(pgEditId||document.querySelector('#pg-id').value.trim());
    const body={group_name:document.querySelector('#pg-name').value.trim(),platform:document.querySelector('#pg-platform').value,priority:Number(document.querySelector('#pg-priority').value)||100,enabled:document.querySelector('#pg-enabled').checked,allow_fs:document.querySelector('#pg-fs').checked,allow_wtb:document.querySelector('#pg-wtb').checked,notes:document.querySelector('#pg-notes').value.trim()};
    if(!groupId){document.querySelector('#pg-error').textContent='Chat ID is required';return}
    try{
      const token=await ensureCsrf();
      const res=await fetch('/admin/api/listing-settings/push-groups/'+encodeURIComponent(groupId),{method:'PUT',headers:{'Content-Type':'application/json','X-CSRF-Token':token},body:JSON.stringify(body)});
      if(res.status===403){location.href='/admin';return}
      const data=await res.json();
      if(!res.ok){document.querySelector('#pg-error').textContent=data.error||'Save failed';return}
      pgReset();load();
    }catch(e){document.querySelector('#pg-error').textContent=e.message}
  }
  </script></body></html>`;
}

/**
 * Panel-session UI for the testing tools that previously only existed as curl-only, token-gated
 * endpoints (/admin/market-guide/debug, /admin/inventory-search, /admin/user/reset) — same
 * underlying logic (see server.ts's /admin/api/tools/* routes), just reachable from the browser
 * once signed in, with CSRF on the destructive action.
 */
export function renderToolsPage(): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>LuxFi — Tools</title><style>${PAGE_STYLES} main{display:block;max-width:1000px}.card{margin-bottom:18px}</style></head><body><header><h1>Tools</h1><nav><a href="/admin#members">Members</a><a href="/admin/users">Users</a><a href="/admin/groups">Groups</a><a href="/admin/push-groups">Push Groups</a><a href="/admin/coverage">WTB Coverage</a><a href="/admin/administrators">Administrators</a><a href="/admin/tools">Tools</a><a href="/admin/logout">Sign out</a></nav></header><script>${NAV_ACTIVE_SCRIPT}</script><main>

<nav class="jumpnav">
  <a href="#mg-section">Market Guide debug</a>
  <a href="#inv-section">Inventory search</a>
  <a href="#reset-section">Full account reset</a>
  <a href="#ent-section">Membership / entitlement</a>
  <a href="#id-section">All known identities</a>
  <a href="#drafts-section">Open drafts</a>
</nav>

<section class="card" id="mg-section">
  <h2>Market Guide debug</h2>
  <p class="muted">Every raw comparable row behind a reference's Market Guide — raw price, raw currency, inferred currency, USD conversion.</p>
  <div class="toolbar"><div class="field"><label for="mg-ref">Reference</label><input id="mg-ref" placeholder="e.g. 116500LN"></div><button onclick="mgLookup()">Look up</button></div>
  <div id="mg-empty" class="muted"></div>
  <table id="mg-table" hidden><thead></thead><tbody></tbody></table>
  <pre id="mg-error" class="error"></pre>
</section>

<section class="card" id="inv-section">
  <h2>Inventory search</h2>
  <p class="muted">Searches WatchFacts inventory (ref/item/description, active AND inactive rows).</p>
  <div class="toolbar"><div class="field"><label for="inv-q">Search term</label><input id="inv-q" placeholder="e.g. 116500"></div><button onclick="invLookup()">Search</button></div>
  <div id="inv-empty" class="muted"></div>
  <table id="inv-table" hidden><thead></thead><tbody></tbody></table>
  <pre id="inv-error" class="error"></pre>
</section>

<section class="card" id="reset-section">
  <h2>Full account reset</h2>
  <p class="muted">Closes every active listing and clears conversation state + notification preference for every identity linked to the given one (e.g. both halves of a linked WhatsApp/Telegram pair). Cannot be undone. Requires administrator or owner role.</p>
  <div class="toolbar"><div class="field"><label for="reset-id">Identity</label><input id="reset-id" placeholder="e.g. telegram:5703391972 or 13053897000"></div><button class="btn-danger" onclick="resetAccount()">Reset account</button></div>
  <pre id="reset-result"></pre>
  <pre id="reset-error" class="error"></pre>
</section>

<section class="card" id="ent-section">
  <h2>Membership / entitlement</h2>
  <p class="muted">The only way to unlock further approvals or assign a paid plan — no live payment processor exists, so this is never self-service and never a real charge. Granting an override or plan requires administrator or owner role.</p>
  <div class="toolbar"><div class="field"><label for="ent-phone">Phone</label><input id="ent-phone" placeholder="Digits only, no +, e.g. 13053897000"></div><button onclick="entLookup()">Look up</button></div>
  <pre id="ent-result"></pre>
  <pre id="ent-error" class="error"></pre>
  <div class="toolbar">
    <button onclick="entOverride(true)">Grant unlimited override</button>
    <button class="btn-danger btn-outline" onclick="entOverride(false)">Revoke override</button>
  </div>
  <div class="toolbar">
    <div class="field"><label for="ent-plan">Plan</label><select id="ent-plan">
      <option value="tier1">Tier 1 — $50/month, 5/week</option>
      <option value="tier2">Tier 2 — $150/month, 20/week</option>
      <option value="tier3">Tier 3 — $300/month, unlimited</option>
      <option value="none">No plan (locked)</option>
    </select></div>
    <button onclick="entSetPlan()">Set plan</button>
  </div>
</section>

<section class="card" id="id-section">
  <h2>All known identities</h2>
  <p class="muted">Every phone number / Telegram ID that has ever contacted Fi at all, unfiltered — this is the raw list behind the dashboard's "Total users" and "Known unique users" figures. Both halves of an already-linked WhatsApp/Telegram pair share the same Canonical ID and each get their own row.</p>
  <div class="toolbar"><button onclick="idLookup()">Load all identities</button></div>
  <div id="id-empty" class="muted"></div>
  <table id="id-table" hidden><thead></thead><tbody></tbody></table>
  <pre id="id-error" class="error"></pre>
</section>

<section class="card" id="drafts-section">
  <h2>Open drafts</h2>
  <p class="muted">Every identity with a currently open, unconfirmed buy or sell draft — until now, invisible to anyone but the customer, since a draft lives only in that phone's own conversation state and never in postings. Useful for spotting a stuck conversation (e.g. an old, abandoned draft that keeps intercepting an unrelated later message) without asking the customer or reading the state file by hand.</p>
  <div class="toolbar"><button onclick="draftsLookup()">Load open drafts</button></div>
  <div id="drafts-empty" class="muted"></div>
  <table id="drafts-table" hidden><thead></thead><tbody></tbody></table>
  <pre id="drafts-error" class="error"></pre>
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
  async function idLookup(){
    document.querySelector('#id-error').textContent='';
    try{
      await ensureCsrf();
      const res=await fetch('/admin/api/tools/identities');
      if(res.status===401){location.href='/admin';return}
      const data=await res.json();
      if(!res.ok){document.querySelector('#id-error').textContent=data.error||'Lookup failed';return}
      renderTable('id',data.rows||[]);
    }catch(e){document.querySelector('#id-error').textContent=e.message}
  }
  async function draftsLookup(){
    document.querySelector('#drafts-error').textContent='';
    try{
      await ensureCsrf();
      const res=await fetch('/admin/api/tools/open-drafts');
      if(res.status===401){location.href='/admin';return}
      const data=await res.json();
      if(!res.ok){document.querySelector('#drafts-error').textContent=data.error||'Lookup failed';return}
      renderTable('drafts',data.rows||[]);
    }catch(e){document.querySelector('#drafts-error').textContent=e.message}
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

function renderFxCard(fx: AdminDashboardData["fx"]): string {
  if ("error" in fx) {
    return `<section class="card">
      <h2>FX / currency conversion</h2>
      ${badge("rates", false)}
      <dl><dt>Error</dt><dd>${escapeHtml(fx.error)}</dd></dl>
    </section>`;
  }
  // Not configured or stale is reported as an ERROR badge, not "unknown" — the whole point of
  // this card is that this exact failure mode (OPEN_EXCHANGE_RATES_APP_ID unset) previously had
  // no visible signal anywhere and silently dropped non-USD listings from every price average.
  const state = !fx.configured ? false : fx.stale ? false : true;
  return `<section class="card">
    <h2>FX / currency conversion</h2>
    ${badge("rates", state)}
    <dl>
      <dt>Configured</dt><dd>${fx.configured ? "yes" : "no — OPEN_EXCHANGE_RATES_APP_ID not set"}</dd>
      <dt>Cached rates</dt><dd>${
        fx.hasCachedRates ? `yes — ${fx.ratesCount} currencies, base ${escapeHtml(fx.baseCurrency ?? "—")}` : "no"
      }</dd>
      <dt>Rates age</dt><dd>${fx.ratesAgeHours === null ? "—" : `${fx.ratesAgeHours.toFixed(1)}h`}</dd>
      <dt>Stale</dt><dd>${fx.stale ? "yes — non-USD conversions are being skipped, not guessed" : "no"}</dd>
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
      distinguish an actual downgrade from someone who simply never converted past their trial.
      Grant an override or assign a plan in <a href="/admin/tools#ent-section">Tools → Membership / entitlement</a>.</p>
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
    <h2>Activity by user — searches or approvals only (top 20, most recent first)</h2>
    <p class="muted">Excludes anyone who has messaged Fi but never run a search or approved a match yet — those users still count toward "Total users" and "Known unique users" above, they just won't appear in this table. See every one of them, unfiltered, in <a href="/admin/tools#id-section">Tools → All known identities</a>.</p>
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
    <nav><a href="#members">Members</a><a href="/admin/users">Users</a><a href="/admin/groups">Groups</a><a href="/admin/push-groups">Push Groups</a><a href="/admin/coverage">WTB Coverage</a><a href="/admin/tools">Tools</a><a href="/admin/logout">Sign out</a></nav>
  </header>
  <script>${NAV_ACTIVE_SCRIPT}</script>
  <main>
    ${renderWhapiCard(data.whapi)}
    ${renderFxCard(data.fx)}
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
