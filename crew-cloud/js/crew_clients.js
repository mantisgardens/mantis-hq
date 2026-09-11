/* =============================================================
   crew_clients.js
   Mantis Gardens — Clients (Operations Manager, crew app)

   This page reuses the Owner Portal's Clients tab code (owner_
   dashboard.js/html/owner.css) essentially unchanged -- same client
   list rendering, sort/group logic, Add/Edit/Profile modals, and the
   Copy Client Emails feature. The ONLY things adapted for the crew
   app are: (1) auth guard + token storage (mg_id_token, matching
   every other crew page, instead of owner_id_token), (2) a small
   self-contained crewFetch()/crewPost() pair instead of owner_
   dashboard.js's ownerFetch()/ownerPost() (which carry a caching /
   action-name-mapping layer this single-purpose page doesn't need),
   and (3) no sessionStorage caching between loads -- this page always
   fetches fresh on open, since it's not part of a larger dashboard
   session the way the Owner Portal is.

   Every route this page calls (/owner/clients, /owner/clients/delete,
   /owner/client-emails) is requireOwner-gated on the backend, exactly
   the same as when the Owner Portal calls them. This page adds NO
   new backend authorization of its own -- it works because the
   Operations Manager's account is already in OWNER_EMAILS. The role
   check that decides whether the landing page even shows the
   "Clients" card (mantis_landing.js) is a UI convenience only, same
   category as TECH_EMAILS gating the QuickBooks reconnect button in
   the Owner Portal -- not a security boundary. If OWNER_EMAILS and
   the Operations Manager's account ever diverge, this page will fail
   with "Unauthorized" regardless of whether the card is shown.
   ============================================================= */

// ── Auth guard + session timeout (matches every other crew page) ──
if (sessionStorage.getItem('mg_auth') !== '1') {
  window.location.href = 'index.html';
} else {
  initSessionTimeout({
    timeoutMs:  4 * 60 * 60 * 1000,
    warningMs:  5 * 60 * 1000,
    sessionKey: 'mg_auth',
    loginUrl:   'index.html',
    onSignOut:  () => { sessionStorage.clear(); },
  });
}

const SCRIPT_URL = (typeof MANTIS_CONFIG !== 'undefined') ? MANTIS_CONFIG.SCRIPT_URL : '';

// Same sessionStorage-then-localStorage fallback as every other crew
// page's getIdToken() (see crew_timecard.js) -- mobile browsers can
// clear sessionStorage on a backgrounded-tab restore even though the
// token itself is still valid for up to an hour.
function getIdToken() {
  let token = sessionStorage.getItem('mg_id_token') || '';
  if (!token) {
    const lsToken  = localStorage.getItem('mg_id_token') || '';
    const lsExpiry = parseInt(localStorage.getItem('mg_id_token_expiry') || '0');
    if (lsToken && Date.now() < lsExpiry) {
      sessionStorage.setItem('mg_id_token', lsToken);
      token = lsToken;
    }
  }
  return token;
}

// ── Minimal network layer (see header comment for why this isn't
//    owner_dashboard.js's ownerFetch()/ownerPost()) ────────────────
async function crewFetch(path) {
  const token = getIdToken();
  const sep = path.indexOf('?') === -1 ? '?' : '&';
  const res = await fetch(`${SCRIPT_URL}${path}${sep}id_token=${encodeURIComponent(token)}`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) throw new Error(data.error || ('HTTP ' + res.status));
  return data;
}

async function crewPost(path, payload, timeoutMs) {
  const token = getIdToken();
  const controller = new AbortController();
  const timer = timeoutMs ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const res = await fetch(`${SCRIPT_URL}${path}?id_token=${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload || {}),
      signal: controller.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) throw new Error(data.error || ('HTTP ' + res.status));
    return data;
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('Request timed out -- try again.');
    throw e;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ── State (mirrors owner_dashboard.js's client-related state) ─────
let allClients       = [];
let currentEditId    = null; // Client ID being edited
let _clientSortOrder = 'name'; // 'name' | 'active' | 'interval'
const VISIT_INTERVAL_RANK = { 'monthly': 0, 'bi-monthly': 1, 'quarterly': 2, 'annual': 3, 'install': 4 };

// The Client DB sheet isn't necessarily in any particular order --
// new clients just get appended to the next empty row -- so this is
// applied every time the list is loaded rather than relying on
// sheet order.
function _sortClientsByName(clients) {
  return clients.slice().sort((a, b) =>
    String(a['Name(s)'] || '').localeCompare(String(b['Name(s)'] || ''), undefined, { sensitivity: 'base' })
  );
}

async function loadClients() {
  const list = document.getElementById('client-list');
  list.innerHTML = `<div class="empty-state">Loading…</div>`;
  try {
    const data = await crewFetch('/owner/clients');
    allClients = _sortClientsByName(data.clients || []);
    renderClients(document.getElementById('client-search').value || '');
  } catch (e) {
    list.innerHTML = `<div class="empty-state">Could not load clients: ${esc(e.message)}</div>`;
  }
}

// ── Sort / group / render (verbatim from owner_dashboard.js) ──────
function setClientSortOrder(order) {
  _clientSortOrder = order;
  renderClients(document.getElementById('client-search').value);
}

function sortClients(list, order) {
  const byName = (a, b) => (a['Name(s)'] || '').localeCompare(b['Name(s)'] || '');
  const sorted = [...list];

  if (order === 'active') {
    sorted.sort((a, b) => {
      const aActive = a['Active'] === '\u2713' ? 0 : 1;
      const bActive = b['Active'] === '\u2713' ? 0 : 1;
      return aActive !== bActive ? aActive - bActive : byName(a, b);
    });
  } else if (order === 'interval') {
    sorted.sort((a, b) => {
      const aRank = VISIT_INTERVAL_RANK[(a['Visit Interval'] || '').trim().toLowerCase()];
      const bRank = VISIT_INTERVAL_RANK[(b['Visit Interval'] || '').trim().toLowerCase()];
      const aR = aRank === undefined ? 99 : aRank;
      const bR = bRank === undefined ? 99 : bRank;
      return aR !== bR ? aR - bR : byName(a, b);
    });
  } else {
    sorted.sort(byName);
  }
  return sorted;
}

function clientGroupLabel(c, order) {
  if (order === 'active') return c['Active'] === '\u2713' ? 'Active' : 'Inactive';
  if (order === 'interval') return (c['Visit Interval'] || '').trim() || 'No interval set';
  return null;
}

function renderClients(query) {
  const list = document.getElementById('client-list');
  const q    = (query || '').toLowerCase().trim();

  const filtered = q
    ? allClients.filter(c =>
        (c['Name(s)']||'').toLowerCase().includes(q) ||
        (c['Address']||'').toLowerCase().includes(q) ||
        (c['Phone']||'').toLowerCase().includes(q))
    : allClients;

  const sorted = sortClients(filtered, _clientSortOrder);

  if (!sorted.length) {
    list.innerHTML = `<div class="empty-state">No clients found</div>`;
    return;
  }

  let lastGroup = undefined;
  list.innerHTML = sorted.map(c => {
    const active = c['Active'] === '✓';
    const name   = c['Name(s)'] || '—';
    const addr   = c['Address'] || '';
    const phone  = c['Phone']   || '';
    const notes  = c['General Service Notes'] || '';
    const cid    = c['Client ID'] || '';

    const group = clientGroupLabel(c, _clientSortOrder);
    const groupHtml = (group !== null && group !== lastGroup)
      ? `<div class="client-group-header">${esc(group)}</div>`
      : '';
    lastGroup = group;

    return `${groupHtml}<div class="client-row" onclick="openProfile('${esc(cid)}')">
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

// One-click Google Maps link for a client's address -- same approach
// as the crew panel's renderAddressLink() (crew_render.js).
function renderAddressLink(raw) {
  const text = String(raw || '').trim();
  if (!text) return '';
  const mapsUrl = 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(text);
  return `<a class="addr-a" href="${mapsUrl}" target="_blank" rel="noopener">${esc(text)}</a>`;
}

// Tap-to-call phone links -- same pattern/regex as the crew panel's
// renderPhoneLinks() (crew_render.js).
const PHONE_PATTERN = /\(?\d{3}\)?[-.\s–—]?\d{3}[-.\s–—]?\d{4}(?:\s*(?:x|ext\.?)\s*\d+)?/gi;
function renderPhoneLinks(raw) {
  const text = String(raw || '').trim();
  if (!text) return '';
  return esc(text).replace(PHONE_PATTERN, m => {
    const stripped = m.replace(/\s*(?:x|ext\.?)\s*\d+\s*$/i, '');
    const dialable = stripped.replace(/[^\d+]/g, '');
    return `<a class="phone-a" href="tel:${dialable}">${m}</a>`;
  });
}

// ── Client Profile Modal ────────────────────────────────────
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
    let display;
    if (label === 'Email') {
      display = val
        ? `<a href="mailto:${esc(val)}" style="color:var(--g)">${esc(val)}</a>`
        : `<span style="color:var(--ink3);font-style:italic">not on file</span>`;
    } else if (label === 'Address') {
      display = renderAddressLink(val);
    } else if (label === 'Phone') {
      display = renderPhoneLinks(val);
    } else {
      display = esc(val);
    }
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

// ── Modal overlay click-to-dismiss (see owner_dashboard.js's
//    identical helper for the full reasoning) ─────────────────────
let _modalOverlayMouseDownOnBackdrop = false;
function _modalOverlayMouseDown(event) {
  _modalOverlayMouseDownOnBackdrop = (event.target === event.currentTarget);
}

function closeProfileModal(e) {
  if (e && (e.target !== document.getElementById('profile-modal') || !_modalOverlayMouseDownOnBackdrop)) return;
  document.getElementById('profile-modal').classList.remove('open');
  document.body.style.overflow = '';
}

// ── Add / Edit Client Modal ─────────────────────────────────
function openAddClient() {
  currentEditId = null;
  document.getElementById('client-modal-title').textContent = 'Add Client';
  clearClientForm();
  document.getElementById('cf-delete-btn').style.display = 'none';
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

  document.getElementById('cf-delete-btn').style.display = 'inline-block';
  document.getElementById('client-modal').classList.add('open');
  document.body.style.overflow = 'hidden';
}

function closeClientModal(e) {
  if (e && (e.target !== document.getElementById('client-modal') || !_modalOverlayMouseDownOnBackdrop)) return;
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
    // 20s, not a shorter default -- adding a new client is one of the
    // heaviest operations in the app (Drive folder + subfolders + a
    // whole new Historical Data Google Sheet, on top of the row write).
    const result = await crewPost('/owner/clients', payload, 20000);
    showToast(currentEditId ? 'Client updated ✓' : `Client added ✓ (${result.clientId})`);
    closeClientModal();
    await loadClients();
  } catch(err) {
    showToast('Save failed: ' + err.message);
  } finally {
    saveBtn.disabled = false;
    saveBtn.textContent = 'Save Client';
  }
}

// Archives the client currently open in the edit modal -- moves their
// row to the Retired Clients tab rather than deleting it outright, so
// Drive folder/records/history stay intact and the row is recoverable
// by moving it back manually. A confirm() dialog gates this since
// it's otherwise a single click away with no in-app undo.
async function deleteCurrentClient() {
  if (!currentEditId) return;
  const c    = allClients.find(x => x['Client ID'] === currentEditId);
  const name = (c && c['Name(s)']) || 'this client';
  if (!confirm(`Delete ${name}? This moves them out of the active client list into Retired Clients — their Drive folder and records stay intact, but this can't be undone from within the app.`)) return;

  const delBtn = document.getElementById('cf-delete-btn');
  delBtn.disabled = true;
  delBtn.textContent = 'Deleting…';

  try {
    await crewPost('/owner/clients/delete', { clientId: currentEditId }, 20000);
    showToast('Client deleted ✓');
    closeClientModal();
    await loadClients();
  } catch(err) {
    showToast('Delete failed: ' + err.message);
  } finally {
    delBtn.disabled = false;
    delBtn.textContent = 'Delete Client';
  }
}

// ── Client Emails (copy-paste list, no send capability) ────────────
async function openClientEmailsModal() {
  const modal = document.getElementById('client-emails-modal');
  const countEl = document.getElementById('ce-count');
  const textarea = document.getElementById('ce-textarea');
  const missingSection = document.getElementById('ce-missing-section');
  const missingList = document.getElementById('ce-missing-list');

  modal.classList.add('open');
  document.body.style.overflow = 'hidden';
  countEl.textContent = 'Loading\u2026';
  textarea.value = '';
  missingSection.style.display = 'none';
  missingList.innerHTML = '';

  try {
    const data = await crewFetch('/owner/client-emails');
    countEl.textContent = `${data.count} active client${data.count === 1 ? '' : 's'} with an email on file`;
    textarea.value = data.emails || '';

    const missing = data.missingEmail || [];
    if (missing.length) {
      document.getElementById('ce-missing-count').textContent = missing.length;
      missingList.innerHTML = missing.map(m => `
        <div class="ce-missing-item">
          <span class="ce-missing-name">${esc(m.name)}</span>
          <span class="ce-missing-address">${esc(m.address)}</span>
        </div>
      `).join('');
      missingSection.style.display = '';
    }
  } catch (err) {
    countEl.textContent = 'Could not load client emails: ' + err.message;
  }
}

function closeClientEmailsModal(e) {
  if (e && (e.target !== document.getElementById('client-emails-modal') || !_modalOverlayMouseDownOnBackdrop)) return;
  document.getElementById('client-emails-modal').classList.remove('open');
  document.body.style.overflow = '';
}

async function copyClientEmailsToClipboard() {
  const textarea = document.getElementById('ce-textarea');
  if (!textarea.value) { showToast('Nothing to copy yet'); return; }
  try {
    await navigator.clipboard.writeText(textarea.value);
    showToast('Copied \u2713 \u2014 paste into BCC');
  } catch (e) {
    textarea.focus();
    textarea.select();
    showToast('Selected \u2014 press Ctrl/Cmd+C to copy');
  }
}

// ── Utilities ────────────────────────────────────────────────
function esc(s) {
  return String(s || '')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function jsStr(s) {
  return esc(String(s || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'"));
}

function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 3000);
}

// ── Startup ──────────────────────────────────────────────────
// No client-side role gate here on purpose: the landing page's role
// check (mantis_landing.js) only decides whether the CARD is shown,
// and duplicating that check here would risk getting it wrong for
// anyone in OWNER_EMAILS who isn't specifically "Operations Manager"
// in Crew Info -- the owner's own account, for instance, has a
// completely different Crew Info role. The real access control is
// requireOwner on the backend; if someone without access lands on
// this page directly, loadClients()'s own error handling already
// surfaces that clearly ("Could not load clients: Unauthorized")
// without this file needing to reimplement that decision.
loadClients();
