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
     7.  Work Documents Tab
     8.  Morning Notes Tab
     9.  Utilities  (esc, toast, formatDate)
     10. Startup
   ============================================================= */

// =============================================================
// SECTION 1 — CONFIG & STATE
// =============================================================
const SCRIPT_URL = (typeof OWNER_CONFIG !== 'undefined') ? OWNER_CONFIG.SCRIPT_URL : '';

let allClients      = [];
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
  setStatus('records',  'live',    'Documents: ready');

  // Fire a warm-up ping
  fetch(`${SCRIPT_URL}?action=ping&id_token=${encodeURIComponent(getIdToken())}`).catch(()=>{});

  const [clientsRes, scheduleRes] = await Promise.allSettled([
    ownerFetch('ownerClients'),
    ownerFetch('ownerSchedule'),
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
  // Lazy-load notes on first visit
  if (tab === 'notes' && !notesData) loadNotes();
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
    ['Email',                c['Email']],
    ['Visit Interval',       c['Visit Interval']],
    ['Labor Hours',          c['Labor Hours']],
    ['Scheduling Notes',     c['Scheduling Notes']],
    ['General Service Notes',c['General Service Notes']],
    ['Gate / Access',        c['Gate / Access']],
    ['Irrigation Notes',     c['Irrigation Notes']],
    ['Dogs / Animals',       c['Dogs / Animals']],
    ['Billing Notes',        c['Billing Notes']],
  ];

  let body = `<div class="profile-fields">`;
  fields.forEach(([label, val]) => {
    if (!val && label !== 'Email') return;
    const display = label === 'Email'
      ? (val
          ? `<a href="mailto:${esc(val)}" style="color:var(--g)">${esc(val)}</a>`
          : `<span style="color:var(--ink3);font-style:italic">not on file</span>`)
      : esc(val);
    body += `<div class="profile-row">
      <span class="profile-label">${esc(label)}</span>
      <span class="profile-val">${display}</span>
    </div>`;
  });
  body += `</div>`;

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
  document.getElementById('cf-email').value        = c['Email']                || '';
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
  ['cf-name','cf-address','cf-phone','cf-email','cf-interval','cf-hours',
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
    email:        document.getElementById('cf-email').value.trim(),
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
// SECTION 7 — WORK DOCUMENTS TAB
// =============================================================

// MIME type → human label + icon
const MIME_LABELS = {
  'application/vnd.google-apps.document':     { label: 'Doc',      icon: '📄' },
  'application/vnd.google-apps.spreadsheet':  { label: 'Sheet',    icon: '📊' },
  'application/pdf':                          { label: 'PDF',      icon: '📋' },
  'image/jpeg':                               { label: 'Photo',    icon: '🖼️' },
  'image/png':                                { label: 'Photo',    icon: '🖼️' },
  'image/heic':                               { label: 'Photo',    icon: '🖼️' },
};

function mimeInfo(mimeType) {
  return MIME_LABELS[mimeType] || { label: 'File', icon: '📎' };
}

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

async function loadDocuments() {
  const clientName = document.getElementById('records-filter-client').value;
  const days       = parseInt(document.getElementById('records-filter-days').value) || 0;
  const list       = document.getElementById('records-list');

  list.innerHTML = `<div class="empty-state">
    <span class="doc-loading-spinner"></span> Loading documents…
  </div>`;
  setStatus('records', 'loading', 'Documents: loading…');

  try {
    const data = await ownerPost('ownerGetDocuments', { clientName, days });
    const docs = data.documents || [];

    setStatus('records', 'live', `Documents: ${docs.length} found`);

    if (!docs.length) {
      const period = days > 0 ? ` in the last ${days} days` : '';
      const who    = clientName ? ` for ${clientName}` : '';
      list.innerHTML = `<div class="empty-state">No documents found${who}${period}.</div>`;
      return;
    }

    // Group by client when showing all clients
    if (!clientName) {
      // Group docs by client name
      const groups = {};
      docs.forEach(d => {
        if (!groups[d.client]) groups[d.client] = [];
        groups[d.client].push(d);
      });

      list.innerHTML = Object.entries(groups).map(([name, clientDocs]) => `
        <div class="doc-group">
          <div class="doc-group-name">${esc(name)}</div>
          ${clientDocs.map(d => docRow(d, false)).join('')}
        </div>`).join('');
    } else {
      list.innerHTML = docs.map(d => docRow(d, true)).join('');
    }

  } catch(err) {
    setStatus('records', 'error', 'Documents: error');
    list.innerHTML = `<div class="empty-state">Failed to load documents: ${esc(err.message)}</div>`;
  }
}

async function rebuildDocsCache() {
  const btn = document.getElementById('rebuild-cache-btn');
  if (btn) { btn.disabled = true; btn.textContent = '⚙ Rebuilding…'; }
  setStatus('records', 'loading', 'Documents: rebuilding cache…');
  try {
    const data = await ownerPost('ownerRebuildDocsCache', {});
    setStatus('records', 'live', `Cache rebuilt — ${data.count} documents indexed`);
    showToast(`Cache rebuilt ✓ — ${data.count} documents`);
    // Reload the current view from the fresh cache
    loadDocuments();
  } catch(err) {
    setStatus('records', 'error', 'Rebuild failed');
    showToast('Cache rebuild failed: ' + err.message);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '⚙ Rebuild Cache'; }
  }
}

function docRow(d, showClient) {
  const { label, icon } = mimeInfo(d.mimeType);
  return `<div class="doc-row">
    <span class="doc-icon">${icon}</span>
    <div class="doc-info">
      <a class="doc-name" href="${esc(d.url)}" target="_blank" rel="noopener">${esc(d.name)}</a>
      ${showClient ? `<span class="doc-client">${esc(d.client)}</span>` : ''}
    </div>
    <span class="doc-meta">
      <span class="doc-type">${esc(label)}</span>
      <span class="doc-date">${esc(d.modified)}</span>
    </span>
  </div>`;
}

// =============================================================
// SECTION 8 — MORNING NOTES TAB
// =============================================================

let notesData    = null;   // { t1, t2, t3, install } — sections per team
let currentTeam  = 't1';   // which team tab is active
let notesDirty   = false;  // unsaved changes flag

const NOTES_TEAM_LABELS = {
  t1: 'Maint Team 1', t2: 'Maint Team 2', t3: 'Maint Team 3',
  install: 'Install', allcrew: 'All Crew', managers: 'Managers', leads: 'Leads'
};

async function loadNotes() {
  setStatus('notes', 'loading', 'Notes: loading…');
  const editor = document.getElementById('notes-editor');
  editor.innerHTML = `<div class="empty-state"><span class="doc-loading-spinner"></span> Loading notes…</div>`;
  try {
    const data = await ownerFetch('ownerGetNotes');
    notesData  = data.tabs || { t1: [], t2: [], t3: [], install: [] };
    setStatus('notes', 'live', 'Notes: loaded');
    renderNotesEditor();
  } catch(err) {
    setStatus('notes', 'error', 'Notes: error');
    editor.innerHTML = `<div class="empty-state">Failed to load notes: ${esc(err.message)}</div>`;
  }
}

function switchNotesTeam(team) {
  if (notesDirty) {
    if (!confirm('You have unsaved changes. Switch team anyway?')) return;
    notesDirty = false;
  }
  currentTeam = team;
  document.querySelectorAll('.notes-tab').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.notesteam === team);
  });
  renderNotesEditor();
}

function renderNotesEditor() {
  const editor = document.getElementById('notes-editor');
  if (!notesData) {
    editor.innerHTML = `<div class="empty-state">Click &#8635; Refresh to load notes.</div>`;
    return;
  }

  if (currentTeam === 'leads') {
    renderLeadsEditor();
    return;
  }

  const sections = (notesData[currentTeam] || []);
  let html = `<div class="notes-sections" id="notes-sections">`;
  sections.forEach((sec, si) => { html += noteSectionHtml(sec, si); });
  html += `</div>
    <button class="notes-add-section" onclick="addSection()">+ Add Section</button>`;
  editor.innerHTML = html;
}

function renderLeadsEditor() {
  const editor  = document.getElementById('notes-editor');
  const leads   = notesData.leads || { headers: [], columns: [] };
  const { headers, columns } = leads;

  if (!headers.length) {
    editor.innerHTML = `<div class="empty-state">No lead columns found in the Leads tab.</div>`;
    return;
  }

  let html = `<div class="leads-grid">`;
  headers.forEach((header, ci) => {
    const items = columns[ci] || [];
    html += `<div class="leads-column">
      <div class="leads-column-header">${esc(header)}</div>
      <div class="leads-items" id="lead-col-${ci}">`;
    items.forEach((item, ii) => {
      html += `<div class="notes-item-row">
        <input class="notes-item-input" value="${esc(item)}"
          oninput="updateLeadItem(${ci},${ii},this.value)"
          onkeydown="leadItemKeydown(event,${ci},${ii})"/>
        <button class="notes-item-del" onclick="deleteLeadItem(${ci},${ii})" title="Remove">&#10005;</button>
      </div>`;
    });
    html += `</div>
      <button class="notes-add-item" onclick="addLeadItem(${ci})">+ Add note</button>
    </div>`;
  });
  html += `</div>`;
  editor.innerHTML = html;
}

function updateLeadItem(ci, ii, val) {
  notesData.leads.columns[ci][ii] = val;
  markDirty();
}

function addLeadItem(ci) {
  if (!notesData.leads.columns[ci]) notesData.leads.columns[ci] = [];
  notesData.leads.columns[ci].push('');
  markDirty();
  renderLeadsEditor();
  const inputs = document.querySelectorAll(`#lead-col-${ci} .notes-item-input`);
  if (inputs.length) inputs[inputs.length - 1].focus();
}

function deleteLeadItem(ci, ii) {
  notesData.leads.columns[ci].splice(ii, 1);
  markDirty();
  renderLeadsEditor();
}

function leadItemKeydown(e, ci, ii) {
  if (e.key === 'Enter') { e.preventDefault(); addLeadItem(ci); }
  else if (e.key === 'Backspace' && e.target.value === '') {
    e.preventDefault(); deleteLeadItem(ci, ii);
  }
}

function noteSectionHtml(sec, si) {
  const items = (sec.items || []).map((item, ii) => `
    <div class="notes-item-row" data-si="${si}" data-ii="${ii}">
      <span class="notes-bullet">•</span>
      <input class="notes-item-input" value="${esc(item)}"
        oninput="updateItem(${si},${ii},this.value)"
        onkeydown="itemKeydown(event,${si},${ii})"/>
      <button class="notes-item-del" onclick="deleteItem(${si},${ii})" title="Remove">&#10005;</button>
    </div>`).join('');

  return `<div class="notes-section" data-si="${si}">
    <div class="notes-section-header">
      <input class="notes-title-input" value="${esc(sec.title || '')}"
        placeholder="Section title…"
        oninput="updateTitle(${si},this.value)"/>
      <button class="notes-section-del" onclick="deleteSection(${si})" title="Delete section">&#128465;</button>
    </div>
    <div class="notes-items" id="items-${si}">
      ${items}
    </div>
    <button class="notes-add-item" onclick="addItem(${si})">+ Add item</button>
  </div>`;
}

function markDirty() {
  notesDirty = true;
  const btn = document.getElementById('notes-save-btn');
  if (btn) btn.classList.add('unsaved');
}

function updateTitle(si, val) {
  notesData[currentTeam][si].title = val;
  markDirty();
}

function updateItem(si, ii, val) {
  notesData[currentTeam][si].items[ii] = val;
  markDirty();
}

function addSection() {
  if (!notesData[currentTeam]) notesData[currentTeam] = [];
  notesData[currentTeam].push({ title: '', items: [] });
  markDirty();
  renderNotesEditor();
  // Focus the new title input
  const sections = document.querySelectorAll('.notes-title-input');
  if (sections.length) sections[sections.length - 1].focus();
}

function deleteSection(si) {
  notesData[currentTeam].splice(si, 1);
  markDirty();
  renderNotesEditor();
}

function addItem(si) {
  notesData[currentTeam][si].items.push('');
  markDirty();
  renderNotesEditor();
  // Focus the new item input
  const inputs = document.querySelectorAll(`#items-${si} .notes-item-input`);
  if (inputs.length) inputs[inputs.length - 1].focus();
}

function deleteItem(si, ii) {
  notesData[currentTeam][si].items.splice(ii, 1);
  markDirty();
  renderNotesEditor();
}

function itemKeydown(e, si, ii) {
  if (e.key === 'Enter') {
    e.preventDefault();
    addItem(si);
  } else if (e.key === 'Backspace') {
    const input = e.target;
    if (input.value === '') {
      e.preventDefault();
      deleteItem(si, ii);
    }
  }
}

async function saveNotes() {
  const btn = document.getElementById('notes-save-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
  setStatus('notes', 'loading', 'Notes: saving…');
  try {
    const payload = { tab: currentTeam };
    if (currentTeam === 'leads') {
      payload.leadsData = notesData.leads;
    } else {
      payload.sections = notesData[currentTeam] || [];
    }
    await ownerPost('ownerSaveNotes', payload);
    notesDirty = false;
    if (btn) btn.classList.remove('unsaved');
    setStatus('notes', 'live', 'Notes: saved ✓');
    showToast('Notes saved ✓');
  } catch(err) {
    setStatus('notes', 'error', 'Notes: save failed');
    showToast('Save failed: ' + err.message);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '✓ Save'; }
  }
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
