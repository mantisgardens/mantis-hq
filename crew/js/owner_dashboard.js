/* =============================================================
   owner_dashboard.js
   Mantis Gardens — Owner Portal Dashboard

   Sections:
     1.  Config & State
     2.  Auth Guard & Sign Out
     3.  API Layer
     4.  Tab Navigation
     5.  Schedule Tab
     6.  Clients Tab  (list, search, add, edit, profile)
     7.  Work Records Tab
     8.  Crew Hours Tab
     9.  Utilities  (esc, toast, formatDate)
     10. Startup
   ============================================================= */

// =============================================================
// SECTION 1 — CONFIG & STATE
// =============================================================
const SCRIPT_URL = (typeof OWNER_CONFIG !== 'undefined') ? OWNER_CONFIG.SCRIPT_URL : '';

let allClients      = [];
let allRecords      = [];
let scheduleData    = {};
let schedWeekDelta  = 0;
let currentEditId   = null;  // Client ID being edited

// =============================================================
// SECTION 2 — AUTH GUARD & SIGN OUT
// =============================================================
if (sessionStorage.getItem('owner_auth') !== '1') {
  window.location.href = (typeof OWNER_CONFIG !== 'undefined')
    ? OWNER_CONFIG.LOGIN_URL : 'index.html';
}

document.getElementById('user-name').textContent =
  sessionStorage.getItem('owner_user_name') || '';

// Session timeout — 2 hours for owner portal (more sensitive data)
initSessionTimeout({
  timeoutMs:  2 * 60 * 60 * 1000,
  warningMs:  5 * 60 * 1000,
  sessionKey: 'owner_auth',
  loginUrl:   (typeof OWNER_CONFIG !== 'undefined') ? OWNER_CONFIG.LOGIN_URL : 'index.html',
  onSignOut:  doSignOut,
});

function doSignOut() {
  const email = sessionStorage.getItem('owner_user_email');
  if (email && typeof google !== 'undefined') {
    google.accounts.id.revoke(email, () => {});
  }
  sessionStorage.clear();
  window.location.href = (typeof OWNER_CONFIG !== 'undefined')
    ? OWNER_CONFIG.LOGIN_URL : 'index.html';
}

// =============================================================
// SECTION 3 — API LAYER
// =============================================================
const CACHE_TTL = {
  ownerClients:  5 * 60 * 1000,
  ownerRecords:  3 * 60 * 1000,
  ownerSchedule: 3 * 60 * 1000,
};

function getIdToken() {
  return sessionStorage.getItem('owner_id_token') || '';
}

function clearOwnerCache() {
  Object.keys(sessionStorage)
    .filter(k => k.startsWith('oc_cache_'))
    .forEach(k => sessionStorage.removeItem(k));
}

async function ownerFetch(action, extra) {
  extra = extra || '';
  const cacheKey = `oc_cache_${action}${extra}`;
  const ttl      = CACHE_TTL[action];
  if (ttl) {
    try {
      const cached = sessionStorage.getItem(cacheKey);
      if (cached) {
        const { ts, data } = JSON.parse(cached);
        if (Date.now() - ts < ttl) return data;
      }
    } catch(e) {}
  }

  const idToken = encodeURIComponent(getIdToken());
  const res = await fetch(`${SCRIPT_URL}?action=${action}&id_token=${idToken}${extra}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (data.error) throw new Error(data.error);

  if (ttl) {
    try {
      sessionStorage.setItem(cacheKey, JSON.stringify({ ts: Date.now(), data }));
    } catch(e) {}
  }
  return data;
}

async function ownerPost(action, payload) {
  const idToken = encodeURIComponent(getIdToken());
  const res = await fetch(`${SCRIPT_URL}?action=${action}&id_token=${idToken}`, {
    method:  'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body:    JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data;
}

function setStatus(id, state, msg) {
  const dot   = document.getElementById('sd-' + id);
  const label = document.getElementById('sl-' + id);
  if (dot)   dot.className = `sdot ${state}`;
  if (label) label.textContent = msg;
}

async function loadAll() {
  document.querySelector('.reload-btn').disabled = true;
  setStatus('clients',  'loading', 'Clients: loading…');
  setStatus('schedule', 'loading', 'Schedule: loading…');
  setStatus('records',  'loading', 'Records: loading…');

  const [clientsRes, scheduleRes, recordsRes] = await Promise.allSettled([
    ownerFetch('ownerClients'),
    ownerFetch('ownerSchedule'),
    ownerFetch('ownerRecords'),
  ]);

  if (clientsRes.status === 'fulfilled') {
    allClients = clientsRes.value.clients || [];
    setStatus('clients', 'live', `Clients: ${allClients.length} loaded`);
    renderClients('');
    populateClientFilter();
  } else {
    setStatus('clients', 'error', `Clients: ${clientsRes.reason.message}`);
  }

  if (scheduleRes.status === 'fulfilled') {
    scheduleData = scheduleRes.value.days || {};
    setStatus('schedule', 'live', `Schedule: loaded`);
    renderSchedule();
  } else {
    setStatus('schedule', 'error', `Schedule: ${scheduleRes.reason.message}`);
  }

  if (recordsRes.status === 'fulfilled') {
    allRecords = recordsRes.value.records || [];
    setStatus('records', 'live', `Records: ${allRecords.length} loaded`);
    filterRecords();
    buildHoursSummary();
  } else {
    setStatus('records', 'error', `Records: ${recordsRes.reason.message}`);
  }

  document.querySelector('.reload-btn').disabled = false;
}

// =============================================================
// SECTION 4 — TAB NAVIGATION
// =============================================================
function switchTab(tab) {
  document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  document.querySelector(`[data-tab="${tab}"]`).classList.add('active');
  document.getElementById(`tab-${tab}`).classList.add('active');
}

// =============================================================
// SECTION 5 — SCHEDULE TAB
// =============================================================
function schedWeekOffset(delta) {
  schedWeekDelta += delta;
  renderSchedule();
}

function getWeekDates(delta) {
  const now  = new Date();
  const dow  = now.getDay();
  const monday = new Date(now);
  monday.setDate(now.getDate() - (dow === 0 ? 6 : dow - 1) + delta * 7);
  const days = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    days.push(d);
  }
  return days;
}

function dateKey(d) {
  return d.toISOString().slice(0, 10);
}

function renderSchedule() {
  const days = getWeekDates(schedWeekDelta);
  const today = dateKey(new Date());

  // Week label
  const start = days[0].toLocaleDateString('en-US', { month:'short', day:'numeric' });
  const end   = days[6].toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' });
  document.getElementById('sched-week-label').textContent = `${start} – ${end}`;

  const grid = document.getElementById('schedule-grid');

  // Build team columns header + days
  const teams = [
    { key: 't1', label: 'Maintenance — Team 1', cls: 't1' },
    { key: 't2', label: 'Maintenance — Team 2', cls: 't2' },
    { key: 't3', label: 'Install Team',         cls: 't3' },
  ];

  let html = `<div class="sched-table">`;

  // Header row
  html += `<div class="sched-header-row">
    <div class="sched-day-col sched-col-label"></div>`;
  teams.forEach(t => {
    html += `<div class="sched-team-col sched-col-header ${t.cls}">${t.label}</div>`;
  });
  html += `</div>`;

  // Day rows
  days.forEach(day => {
    const dk   = dateKey(day);
    const dayData = scheduleData[dk] || {};
    const isToday = dk === today;
    const dayLabel = day.toLocaleDateString('en-US', { weekday:'short', month:'short', day:'numeric' });

    html += `<div class="sched-row${isToday ? ' sched-today' : ''}">
      <div class="sched-day-col">
        <div class="sched-day-name">${dayLabel}</div>
        ${isToday ? '<div class="today-badge">today</div>' : ''}
      </div>`;

    teams.forEach(t => {
      const jobs = dayData[t.key] || [];
      html += `<div class="sched-team-col ${t.cls}">`;
      if (!jobs.length) {
        html += `<div class="sched-empty">—</div>`;
      } else {
        jobs.forEach(j => {
          const hrs = j.dur ? `<span class="sched-dur">${esc(j.dur)}</span>` : '';
          html += `<div class="sched-job">
            <div class="sched-job-client">${esc(j.client)}</div>
            <div class="sched-job-meta">${j.allDay ? 'All day' : esc(j.time)} ${hrs}</div>
          </div>`;
        });
      }
      html += `</div>`;
    });
    html += `</div>`;
  });

  html += `</div>`;
  grid.innerHTML = html;
}

// =============================================================
// SECTION 6 — CLIENTS TAB
// =============================================================
function renderClients(query) {
  const list = document.getElementById('client-list');
  const q    = (query || '').toLowerCase().trim();

  const filtered = q
    ? allClients.filter(c =>
        (c['Name(s)']||'').toLowerCase().includes(q) ||
        (c['Address']||'').toLowerCase().includes(q) ||
        (c['Phone']||'').toLowerCase().includes(q))
    : allClients;

  if (!filtered.length) {
    list.innerHTML = `<div class="empty-state">No clients found</div>`;
    return;
  }

  list.innerHTML = filtered.map(c => {
    const active = c['Active'] === '✓';
    const name   = c['Name(s)'] || '—';
    const addr   = c['Address'] || '';
    const phone  = c['Phone']   || '';
    const notes  = c['General Service Notes'] || '';
    const cid    = c['Client ID'] || '';

    return `<div class="client-row" onclick="openProfile('${esc(cid)}')">
      <div class="client-row-main">
        <div class="client-row-name">${esc(name)}</div>
        <div class="client-row-meta">
          ${addr  ? `<span>&#128205; ${esc(addr)}</span>` : ''}
          ${phone ? `<span>&#128222; ${esc(phone)}</span>` : ''}
        </div>
        ${notes ? `<div class="client-row-notes">${esc(notes.slice(0,100))}${notes.length>100?'…':''}</div>` : ''}
      </div>
      <div class="client-row-right">
        ${cid ? `<span class="client-id-badge">${esc(cid)}</span>` : ''}
        <span class="active-badge ${active?'active':'inactive'}">${active?'Active':'Inactive'}</span>
      </div>
    </div>`;
  }).join('');
}

function filterClients(q) {
  renderClients(q);
}

// ── Client Profile Modal ───────────────────────────────────
function openProfile(clientId) {
  const c = allClients.find(x => x['Client ID'] === clientId);
  if (!c) return;
  currentEditId = clientId;

  document.getElementById('profile-modal-title').textContent = c['Name(s)'] || 'Client Profile';

  const fields = [
    ['Client ID',            c['Client ID']],
    ['Address',              c['Address']],
    ['Phone',                c['Phone']],
    ['Visit Interval',       c['Visit Interval']],
    ['Labor Hours',          c['Labor Hours']],
    ['Scheduling Notes',     c['Scheduling Notes']],
    ['General Service Notes',c['General Service Notes']],
    ['Gate / Access',        c['Gate / Access']],
    ['Irrigation Notes',     c['Irrigation Notes']],
    ['Dogs / Animals',       c['Dogs / Animals']],
    ['Billing Notes',        c['Billing Notes']],
  ];

  // Recent work records for this client
  const clientRecords = allRecords
    .filter(r => (r.client||'').toLowerCase().includes((c['Name(s)']||'').split(',')[0].toLowerCase()))
    .slice(0, 10);

  let body = `<div class="profile-fields">`;
  fields.forEach(([label, val]) => {
    if (!val) return;
    body += `<div class="profile-row">
      <span class="profile-label">${esc(label)}</span>
      <span class="profile-val">${esc(val)}</span>
    </div>`;
  });
  body += `</div>`;

  if (clientRecords.length) {
    body += `<div class="profile-section-title">Recent Work Records</div>`;
    body += `<div class="profile-records">`;
    clientRecords.forEach(r => {
      body += `<div class="profile-record">
        <span class="pr-date">${esc(r.date||'')}</span>
        <span class="pr-team">${esc(r.team||'')}</span>
        <span class="pr-workers">${esc((r.workers||[]).map(w=>w.name).join(', '))}</span>
        ${r.serviceNotes ? `<div class="pr-notes">${esc(r.serviceNotes.slice(0,120))}${r.serviceNotes.length>120?'…':''}</div>` : ''}
      </div>`;
    });
    body += `</div>`;
  } else {
    body += `<div class="profile-section-title">Work Records</div>
      <div class="empty-state small">No work records found for this client</div>`;
  }

  document.getElementById('profile-modal-body').innerHTML = body;
  document.getElementById('profile-modal').classList.add('open');
  document.body.style.overflow = 'hidden';
}

function closeProfileModal(e) {
  if (e && e.target !== document.getElementById('profile-modal')) return;
  document.getElementById('profile-modal').classList.remove('open');
  document.body.style.overflow = '';
}

// ── Add / Edit Client Modal ────────────────────────────────
function openAddClient() {
  currentEditId = null;
  document.getElementById('client-modal-title').textContent = 'Add Client';
  clearClientForm();
  document.getElementById('client-modal').classList.add('open');
  document.body.style.overflow = 'hidden';
  document.getElementById('cf-name').focus();
}

function editCurrentClient() {
  const c = allClients.find(x => x['Client ID'] === currentEditId);
  if (!c) return;
  closeProfileModal();

  document.getElementById('client-modal-title').textContent = 'Edit Client — ' + (c['Name(s)']||'');
  document.getElementById('cf-name').value         = c['Name(s)']              || '';
  document.getElementById('cf-address').value      = c['Address']              || '';
  document.getElementById('cf-phone').value        = c['Phone']                || '';
  document.getElementById('cf-interval').value     = c['Visit Interval']       || '';
  document.getElementById('cf-hours').value        = c['Labor Hours']          || '';
  document.getElementById('cf-active').value       = c['Active']               || '';
  document.getElementById('cf-service-notes').value= c['General Service Notes']|| '';
  document.getElementById('cf-gate').value         = c['Gate / Access']        || '';
  document.getElementById('cf-irrigation').value   = c['Irrigation Notes']     || '';
  document.getElementById('cf-dogs').value         = c['Dogs / Animals']       || '';
  document.getElementById('cf-scheduling').value   = c['Scheduling Notes']     || '';
  document.getElementById('cf-billing').value      = c['Billing Notes']        || '';

  document.getElementById('client-modal').classList.add('open');
  document.body.style.overflow = 'hidden';
}

function closeClientModal(e) {
  if (e && e.target !== document.getElementById('client-modal')) return;
  document.getElementById('client-modal').classList.remove('open');
  document.body.style.overflow = '';
}

function clearClientForm() {
  ['cf-name','cf-address','cf-phone','cf-interval','cf-hours',
   'cf-service-notes','cf-gate','cf-irrigation','cf-dogs','cf-scheduling','cf-billing']
    .forEach(id => {
      const el = document.getElementById(id);
      if (el) el.value = '';
    });
  document.getElementById('cf-active').value = '✓';
}

async function saveClient() {
  const name = document.getElementById('cf-name').value.trim();
  if (!name) { showToast('Client name is required'); return; }

  const saveBtn = document.querySelector('#client-modal .fbtn-save');
  saveBtn.disabled = true;
  saveBtn.textContent = 'Saving…';

  const payload = {
    clientId:     currentEditId || null,
    name,
    address:      document.getElementById('cf-address').value.trim(),
    phone:        document.getElementById('cf-phone').value.trim(),
    interval:     document.getElementById('cf-interval').value,
    laborHours:   document.getElementById('cf-hours').value.trim(),
    active:       document.getElementById('cf-active').value,
    serviceNotes: document.getElementById('cf-service-notes').value.trim(),
    gate:         document.getElementById('cf-gate').value.trim(),
    irrigation:   document.getElementById('cf-irrigation').value.trim(),
    dogs:         document.getElementById('cf-dogs').value.trim(),
    scheduling:   document.getElementById('cf-scheduling').value.trim(),
    billing:      document.getElementById('cf-billing').value.trim(),
  };

  try {
    const result = await ownerPost('ownerSaveClient', payload);
    showToast(currentEditId ? 'Client updated ✓' : `Client added ✓ (${result.clientId})`);
    closeClientModal();
    // Clear cache and reload clients
    sessionStorage.removeItem('oc_cache_ownerClients');
    const fresh = await ownerFetch('ownerClients');
    allClients = fresh.clients || [];
    renderClients(document.getElementById('client-search').value || '');
    populateClientFilter();
  } catch(err) {
    showToast('Save failed: ' + err.message);
  } finally {
    saveBtn.disabled = false;
    saveBtn.textContent = 'Save Client';
  }
}

// =============================================================
// SECTION 7 — WORK RECORDS TAB
// =============================================================
function populateClientFilter() {
  const sel = document.getElementById('records-filter-client');
  const cur = sel.value;
  sel.innerHTML = '<option value="">All clients</option>';
  const names = [...new Set(allClients.map(c => c['Name(s)']).filter(Boolean))].sort();
  names.forEach(n => {
    const opt = document.createElement('option');
    opt.value = n;
    opt.textContent = n;
    if (n === cur) opt.selected = true;
    sel.appendChild(opt);
  });
}

function filterRecords() {
  const clientFilter = document.getElementById('records-filter-client').value;
  const days         = parseInt(document.getElementById('records-filter-days').value) || 30;
  const cutoff       = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const cutoffStr    = cutoff.toISOString().slice(0, 10);

  // days=0 means "All time" — no date filter
  let filtered = days === 0
    ? allRecords.slice()
    : allRecords.filter(r => !r.date || r.date >= cutoffStr);
  if (clientFilter) {
    filtered = filtered.filter(r =>
      (r.client||'').toLowerCase().includes(clientFilter.toLowerCase()));
  }

  // Sort newest first
  filtered.sort((a, b) => (b.date||'') > (a.date||'') ? 1 : -1);

  const list = document.getElementById('records-list');
  if (!filtered.length) {
    list.innerHTML = `<div class="empty-state">
      No records found${days > 0 ? ' in the last ' + days + ' days' : ''}.
      ${allRecords.length === 0 ? ' (0 total records loaded — check Work Records Log sheet)' : ' (' + allRecords.length + ' total records, none match filter)'}
    </div>`;
    return;
  }

  list.innerHTML = filtered.map(r => {
    const workers  = (r.workers||[]).map(w => `${w.name}${w.hours?' ('+w.hours+'h)':''}`).join(', ');
    const ferts    = (r.fertilizers||[]).map(f => f.item).join(', ');
    const mats     = (r.otherMaterials||[]).map(m => m.item).join(', ');

    return `<div class="record-row">
      <div class="record-header">
        <span class="record-date">${esc(r.date||'—')}</span>
        <span class="record-client">${esc(r.client||'—')}</span>
        <span class="record-team">${esc(r.team||'')}</span>
        ${r.recordId ? `<span class="record-id">${esc(r.recordId)}</span>` : ''}
      </div>
      ${workers ? `<div class="record-detail"><span class="rd-label">Crew</span> ${esc(workers)}</div>` : ''}
      ${ferts   ? `<div class="record-detail"><span class="rd-label">Fertilizers</span> ${esc(ferts)}</div>` : ''}
      ${mats    ? `<div class="record-detail"><span class="rd-label">Materials</span> ${esc(mats)}</div>` : ''}
      ${r.serviceNotes  ? `<div class="record-notes">${esc(r.serviceNotes)}</div>` : ''}
      ${r.internalNotes ? `<div class="record-internal">&#128274; ${esc(r.internalNotes)}</div>` : ''}
    </div>`;
  }).join('');
}

// =============================================================
// SECTION 8 — CREW HOURS TAB
// =============================================================
function buildHoursSummary() {
  const days    = parseInt(document.getElementById('hours-filter-period').value) || 30;
  const cutoff  = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const cutoffStr = cutoff.toISOString().slice(0, 10);

  const filtered = allRecords.filter(r => !r.date || r.date >= cutoffStr);

  // Tally hours per worker
  const workerHours  = {};
  const workerVisits = {};
  const workerClients = {};

  filtered.forEach(r => {
    (r.workers||[]).forEach(w => {
      if (!w.name) return;
      const hrs = parseFloat(w.hours) || 0;
      workerHours[w.name]  = (workerHours[w.name]  || 0) + hrs;
      workerVisits[w.name] = (workerVisits[w.name] || 0) + 1;
      if (!workerClients[w.name]) workerClients[w.name] = new Set();
      if (r.client) workerClients[w.name].add(r.client);
    });
  });

  const workers = Object.keys(workerHours).sort((a,b) => workerHours[b] - workerHours[a]);
  const totalHrs = Object.values(workerHours).reduce((s,h) => s+h, 0);

  const el = document.getElementById('hours-summary');
  if (!workers.length) {
    el.innerHTML = `<div class="empty-state">No records found for selected period</div>`;
    return;
  }

  let html = `<div class="hours-table">
    <div class="hours-header">
      <span>Crew Member</span>
      <span>Visits</span>
      <span>Clients</span>
      <span>Total Hours</span>
    </div>`;

  workers.forEach(name => {
    const hrs     = workerHours[name] || 0;
    const visits  = workerVisits[name] || 0;
    const clients = workerClients[name] ? workerClients[name].size : 0;
    const pct     = totalHrs > 0 ? (hrs / totalHrs * 100) : 0;

    html += `<div class="hours-row">
      <span class="hours-name">${esc(name)}</span>
      <span class="hours-visits">${visits}</span>
      <span class="hours-clients">${clients}</span>
      <span class="hours-total">
        <span class="hours-num">${hrs % 1 === 0 ? hrs : hrs.toFixed(1)}</span>
        <div class="hours-bar-wrap">
          <div class="hours-bar" style="width:${pct.toFixed(1)}%"></div>
        </div>
      </span>
    </div>`;
  });

  html += `<div class="hours-footer">
    <span>Total</span>
    <span>${filtered.length} visits</span>
    <span></span>
    <span class="hours-num">${totalHrs % 1 === 0 ? totalHrs : totalHrs.toFixed(1)} hrs</span>
  </div>`;

  html += `</div>`;
  el.innerHTML = html;
}

// =============================================================
// SECTION 9 — UTILITIES
// =============================================================
function esc(s) {
  return String(s || '')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 3000);
}

// =============================================================
// SECTION 10 — STARTUP
// =============================================================
loadAll();
