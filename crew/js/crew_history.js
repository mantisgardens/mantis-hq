/* =============================================================
   crew_history.js
   Mantis Gardens — Historical Data Panel

   Contains:
     19. Historical data panel  (openHistory, openHistoryForClient,
                                  loadHistory, switchHistoryTab,
                                  filterHistory, closeHistory,
                                  populateHistoryClientList)
   ============================================================= */

// SECTION 19 — HISTORICAL DATA PANEL
// openHistory()               — opens modal, populates client list
// openHistoryForClient(name)  — opens modal pre-selected to client
// loadHistory(clientName)     — fetches from Historical Data sheet
// switchHistoryTab(tab)       — switches Notes/Fert/Labor/Photos
// filterHistory(query)        — real-time search across all tabs
// closeHistory()              — closes the modal
// =============================================================

let _historyData   = null;    // last fetched payload
let _historyClient = '';      // currently loaded client name
let _historyTab    = 'notes'; // active tab: 'notes'|'fert'|'records'|'photos'
let _historyQuery  = '';      // current search string

// ── Open / close ──────────────────────────────────────────────

function openHistory() {
  _populateHistorySelect();
  document.getElementById('history-modal').classList.add('open');
  document.body.style.overflow = 'hidden';
}

function openHistoryForClient(clientName) {
  _populateHistorySelect();
  document.getElementById('history-modal').classList.add('open');
  document.body.style.overflow = 'hidden';
  if (clientName) {
    const matched = _matchClientName(clientName);
    const selName = matched || clientName;
    const sel = document.getElementById('history-client-select');
    if (sel) sel.value = selName;
    loadHistory(selName);
  }
}

function closeHistory() {
  document.getElementById('history-modal').classList.remove('open');
  document.body.style.overflow = '';
}

function closeHistoryOutside(e) {
  if (e.target.id === 'history-modal') closeHistory();
}

// ── Client name matching (calendar title → sheet client name) ─

function _matchClientName(calName) {
  if (!sheetClients.length) return null;
  const norm = s => s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
  const calNorm = norm(calName);

  function findMatch(nameToCheck) {
    const n      = norm(nameToCheck);
    const nWords = n.split(/\s+/).filter(w => w.length > 2);
    if (!nWords.length) return null;
    const exact = sheetClients.find(c => norm(c['Name(s)'] || c['name'] || '') === n);
    if (exact) return exact;
    return sheetClients.find(c => {
      const cn      = norm(c['Name(s)'] || c['name'] || '');
      const cnWords = cn.split(/\s+/);
      if (n.length <= cn.length) return nWords.every(w => cnWords.includes(w));
      const cnW = cnWords.filter(w => w.length > 2);
      return cnW.every(w => nWords.includes(w));
    });
  }

  const exact = sheetClients.find(c => norm(c['Name(s)'] || c['name'] || '') === calNorm);
  if (exact) return exact['Name(s)'] || exact['name'];

  const contains = findMatch(calName);
  if (contains) return contains['Name(s)'] || contains['name'];

  const people = calName.split(/\s*&\s*/);
  for (const person of people) {
    const surname = person.trim().split(/[\s,]+/)[0];
    if (surname && surname.length > 2) {
      const surnameLow = surname.toLowerCase();
      const m = sheetClients.find(c => {
        const cn = c['Name(s)'] || c['name'] || '';
        return cn.toLowerCase().split(/[\s,&]+/).includes(surnameLow);
      });
      if (m) return m['Name(s)'] || m['name'];
    }
  }

  const calWords = calNorm.split(' ').filter(w => w.length > 2);
  let best = null, bestScore = 0;
  sheetClients.forEach(c => {
    const cWords = norm(c['Name(s)'] || c['name'] || '').split(' ').filter(w => w.length > 2);
    const overlap = calWords.filter(w => cWords.includes(w)).length;
    if (overlap > bestScore) { bestScore = overlap; best = c['Name(s)'] || c['name']; }
  });
  return bestScore >= 1 ? best : null;
}

// ── Populate client dropdown ───────────────────────────────────

function _populateHistorySelect() {
  const sel = document.getElementById('history-client-select');
  while (sel.options.length > 1) sel.remove(1);
  sel.value = '';
  [...sheetClients]
    .sort((a, b) => (a['Name(s)'] || '').localeCompare(b['Name(s)'] || ''))
    .forEach(c => {
      const name = c['Name(s)'] || c['name'] || '';
      if (!name) return;
      const opt = document.createElement('option');
      opt.value = opt.textContent = name;
      sel.appendChild(opt);
    });
}

// ── Load history ───────────────────────────────────────────────

async function loadHistory(clientName) {
  if (!clientName) {
    _historyShowEmpty('Select a client above to view their historical data.');
    return;
  }

  _historyClient = clientName;
  _historyData   = null;
  _historyQuery  = '';

  const search = document.getElementById('history-search');
  const clear  = document.getElementById('history-search-clear');
  const label  = document.getElementById('history-client-label');
  if (search) search.value = '';
  if (clear)  clear.style.display  = 'none';
  if (label)  label.textContent    = clientName;

  document.getElementById('history-tabs').style.display        = 'none';
  document.getElementById('history-search-wrap').style.display = 'none';
  ['htab-ct-notes','htab-ct-records','htab-ct-fert','htab-ct-photos'].forEach(id => {
    const el = document.getElementById(id); if (el) el.textContent = '';
  });

  document.getElementById('history-body').innerHTML =
    `<div class="history-loading"><div class="history-spinner"></div>Loading history for ${esc(clientName)}…</div>`;

  try {
    // Look up Hist Data ID and folder ID from client database
    const sc = findSheetClient(clientName);

    const histId   = (sc && sc['Hist Data ID'])    ? sc['Hist Data ID'].trim()    : '';
    const folderId = (sc && sc['Drive Folder ID']) ? sc['Drive Folder ID'].trim() : '';

    const idToken   = sessionStorage.getItem('mg_id_token') || '';
    const authParam = idToken ? `&id_token=${encodeURIComponent(idToken)}` : '';
    const url = `${SCRIPT_URL}?action=historical_data${authParam}`
              + `&client=${encodeURIComponent(clientName)}`
              + `&histId=${encodeURIComponent(histId)}`
              + `&folderId=${encodeURIComponent(folderId)}`
              + `&_=${Date.now()}`;

    const res  = await fetch(url);
    const data = await res.json();
    if (data.error) throw new Error(data.error);

    _historyData = data;
    _historyTab  = 'notes';

    // Show tabs and search
    document.getElementById('history-tabs').style.display        = 'flex';
    document.getElementById('history-search-wrap').style.display = 'flex';

    // Update tab counts
    const nc = document.getElementById('htab-ct-notes');
    const rc = document.getElementById('htab-ct-records');
    const fc = document.getElementById('htab-ct-fert');
    const pc = document.getElementById('htab-ct-photos');
    if (nc) nc.textContent = (data.notes        || []).length || '';
    if (rc) rc.textContent = (data.labor        || []).length || '';
    if (fc) fc.textContent = (data.fertilizers  || []).length || '';
    if (pc) pc.textContent = Array.isArray(data.photos) && data.photos.length ? data.photos.length : '';

    // Activate Notes tab
    document.querySelectorAll('.htab').forEach(t => t.classList.remove('active'));
    const notesTab = document.getElementById('htab-notes');
    if (notesTab) notesTab.classList.add('active');

    _renderHistoryTab();

  } catch(e) {
    document.getElementById('history-body').innerHTML =
      `<div class="history-error">&#9888; Could not load history: ${esc(e.message)}</div>`;
  }
}

function _historyShowEmpty(msg) {
  document.getElementById('history-body').innerHTML =
    `<div class="history-empty">${esc(msg)}</div>`;
  document.getElementById('history-tabs').style.display        = 'none';
  document.getElementById('history-search-wrap').style.display = 'none';
  const label = document.getElementById('history-client-label');
  if (label) label.textContent = '';
}

// ── Tab switching ──────────────────────────────────────────────

function switchHistoryTab(tab) {
  _historyTab = tab;
  document.querySelectorAll('.htab').forEach(t => t.classList.remove('active'));
  const el = document.getElementById('htab-' + tab);
  if (el) el.classList.add('active');
  _renderHistoryTab();
}

// ── Search ─────────────────────────────────────────────────────

function filterHistory(query) {
  _historyQuery = query.toLowerCase().trim();
  const clear = document.getElementById('history-search-clear');
  if (clear) clear.style.display = _historyQuery ? '' : 'none';
  _renderHistoryTab();
}

function clearHistorySearch() {
  const search = document.getElementById('history-search');
  if (search) search.value = '';
  filterHistory('');
}

// ── Render dispatcher ──────────────────────────────────────────

function _renderHistoryTab() {
  if (!_historyData) return;
  const body = document.getElementById('history-body');
  const q    = _historyQuery;
  if      (_historyTab === 'notes')   _renderNotes(body, q);
  else if (_historyTab === 'fert')    _renderFertilizers(body, q);
  else if (_historyTab === 'records') _renderLabor(body, q);
  else if (_historyTab === 'photos')  _renderPhotos(body, q);
}

// Highlight matching text
function _hl(text, q) {
  if (!q || !text) return esc(text);
  const safeQ = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return esc(text).replace(new RegExp(`(${safeQ})`, 'gi'), '<mark class="hl">$1</mark>');
}

// ── Notes tab ─────────────────────────────────────────────────
// Each date is a collapsed card; click to expand the note text.

function _renderNotes(body, q) {
  let notes = (_historyData.notes || []).filter(n => n.text || n.date);
  if (q) notes = notes.filter(n =>
    (n.date  || '').toLowerCase().includes(q) ||
    (n.text  || '').toLowerCase().includes(q)
  );

  if (!notes.length) {
    body.innerHTML = q
      ? `<div class="history-empty">No notes match "<strong>${esc(q)}</strong>"</div>`
      : '<div class="history-empty">No service notes found for this client.</div>';
    return;
  }

  body.innerHTML = notes.map((n, i) => `
    <div class="hn-card" id="hn-${i}" onclick="toggleNote(${i})">
      <div class="hn-header">
        <span class="hn-date">${esc(n.date)}</span>
        <span class="hn-arrow">&#8250;</span>
      </div>
      <div class="hn-body">
        ${n.text ? `<p class="hn-text">${_hl(n.text, q)}</p>` : ''}
      </div>
    </div>`).join('');

  // Auto-expand all when searching
  if (q) body.querySelectorAll('.hn-card').forEach(c => c.classList.add('open'));
}

function toggleNote(i) {
  const card = document.getElementById('hn-' + i);
  if (card) card.classList.toggle('open');
}

// ── Fertilizer tab ────────────────────────────────────────────
// Each date is a collapsed card; click to expand the products.
// Multiple products per date are pipe-delimited in the value.

function _renderFertilizers(body, q) {
  let entries = (_historyData.fertilizers || []).filter(e => e.product || e.date);
  if (q) entries = entries.filter(e =>
    (e.date    || '').toLowerCase().includes(q) ||
    (e.product || '').toLowerCase().includes(q)
  );

  if (!entries.length) {
    body.innerHTML = q
      ? `<div class="history-empty">No fertilizers match "<strong>${esc(q)}</strong>"</div>`
      : '<div class="history-empty">No fertilizer records found for this client.</div>';
    return;
  }

  body.innerHTML = entries.map((e, i) => {
    // Split pipe-delimited products into individual lines
    const products = (e.product || '').split(' | ').filter(p => p.trim());
    const productHTML = products.map(p =>
      `<div class="hf-item">${_hl(p.trim(), q)}</div>`
    ).join('');
    return `
      <div class="hn-card" id="hf-${i}" onclick="toggleFert(${i})">
        <div class="hn-header">
          <span class="hn-date">${esc(e.date)}</span>
          <span class="hf-preview">${esc(products[0] || '')}${products.length > 1 ? ` +${products.length - 1} more` : ''}</span>
          <span class="hn-arrow">&#8250;</span>
        </div>
        <div class="hn-body hf-body">${productHTML}</div>
      </div>`;
  }).join('');

  if (q) body.querySelectorAll('.hn-card').forEach(c => c.classList.add('open'));
}

function toggleFert(i) {
  const card = document.getElementById('hf-' + i);
  if (card) card.classList.toggle('open');
}

// ── Labor tab ─────────────────────────────────────────────────
// Each date is a collapsed card; click to expand the description.

function _renderLabor(body, q) {
  let entries = (_historyData.labor || []).filter(e => e.description || e.date);
  if (q) entries = entries.filter(e =>
    (e.date        || '').toLowerCase().includes(q) ||
    (e.description || '').toLowerCase().includes(q)
  );

  if (!entries.length) {
    body.innerHTML = q
      ? `<div class="history-empty">No labor records match "<strong>${esc(q)}</strong>"</div>`
      : '<div class="history-empty">No labor records found for this client.</div>';
    return;
  }

  body.innerHTML = entries.map((e, i) => {
    // Split pipe-delimited descriptions
    const items = (e.description || '').split(' | ').filter(d => d.trim());
    const itemsHTML = items.map(d =>
      `<div class="hr-item">${_hl(d.trim(), q)}</div>`
    ).join('');
    return `
      <div class="hn-card" id="hr-${i}" onclick="toggleRecord(${i})">
        <div class="hn-header">
          <span class="hn-date">${esc(e.date)}</span>
          <span class="hr-preview">${esc((items[0] || '').slice(0, 60))}${(items[0] || '').length > 60 || items.length > 1 ? '…' : ''}</span>
          <span class="hn-arrow">&#8250;</span>
        </div>
        <div class="hn-body">${itemsHTML}</div>
      </div>`;
  }).join('');

  if (q) body.querySelectorAll('.hn-card').forEach(c => c.classList.add('open'));
}

function toggleRecord(i) {
  const card = document.getElementById('hr-' + i);
  if (card) card.classList.toggle('open');
}

// ── Photos tab ────────────────────────────────────────────────
// Flat list of photos with date and filename. Filename links to
// the file in Google Drive.

function _renderPhotos(body, q) {
  let photos = (_historyData.photos || []).filter(p => p.fileId || p.filename);
  if (q) photos = photos.filter(p =>
    (p.date     || '').toLowerCase().includes(q) ||
    (p.filename || '').toLowerCase().includes(q)
  );

  if (!photos.length) {
    body.innerHTML = q
      ? `<div class="history-empty">No photos match "<strong>${esc(q)}</strong>"</div>`
      : '<div class="history-empty">No photos found for this client.</div>';
    return;
  }

  body.innerHTML = `<div class="hp-list">` +
    photos.map(p => {
      const driveUrl = p.fileId
        ? `https://drive.google.com/file/d/${esc(p.fileId)}/view`
        : '#';
      const name = _hl(p.filename || p.fileId || '(unnamed)', q);
      return `
        <div class="hp-row">
          <span class="hp-date">${esc(p.date)}</span>
          <a class="hp-link" href="${driveUrl}" target="_blank" rel="noopener">
            &#128247; ${name}
          </a>
        </div>`;
    }).join('') +
  `</div>`;
}

// ── Open / close ──────────────────────────────────────────────
function openHistory() {
  _populateHistorySelect();
  document.getElementById('history-modal').classList.add('open');
  document.body.style.overflow = 'hidden';
}

function openHistoryForClient(clientName) {
  _populateHistorySelect();
  document.getElementById('history-modal').classList.add('open');
  document.body.style.overflow = 'hidden';
  if (clientName) {
    const matched = _matchClientName(clientName);
    const selName = matched || clientName;
    document.getElementById('history-client-select').value = selName;
    loadHistory(selName);
  }
}

// Try to find the closest sheetClient name to a calendar event title
function _matchClientName(calName) {
  if (!sheetClients.length) return null;
  const norm = s => s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
  const calNorm = norm(calName);

  // Helper to check a name against all sheet clients using word overlap
  function findMatch(nameToCheck) {
    const n      = norm(nameToCheck);
    const nWords = n.split(/\s+/).filter(w => w.length > 2);
    if (!nWords.length) return null;
    const exact = sheetClients.find(c => norm(c['Name(s)'] || c['name'] || '') === n);
    if (exact) return exact;
    return sheetClients.find(c => {
      const cn      = norm(c['Name(s)'] || c['name'] || '');
      const cnWords = cn.split(/\s+/);
      if (n.length <= cn.length) {
        return nWords.every(w => cnWords.includes(w));
      } else {
        const cnW = cnWords.filter(w => w.length > 2);
        return cnW.every(w => nWords.includes(w));
      }
    });
  }

  const exact = sheetClients.find(c =>
    norm(c['Name(s)'] || c['name'] || '') === calNorm
  );
  if (exact) return exact['Name(s)'] || exact['name'];

  const contains = findMatch(calName);
  if (contains) return contains['Name(s)'] || contains['name'];

  const people = calName.split(/\s*&\s*/);
  for (const person of people) {
    const surname = person.trim().split(/[\s,]+/)[0];
    if (surname && surname.length > 2) {
      const surnameLow = surname.toLowerCase();
      const m = sheetClients.find(c => {
        const cn = c['Name(s)'] || c['name'] || '';
        return cn.toLowerCase().split(/[\s,&]+/).includes(surnameLow);
      });
      if (m) return m['Name(s)'] || m['name'];
    }
  }

  const calWords = calNorm.split(' ').filter(w => w.length > 2);
  let best = null, bestScore = 0;
  sheetClients.forEach(c => {
    const n = c['Name(s)'] || c['name'] || '';
    const cWords = norm(n).split(' ').filter(w => w.length > 2);
    const overlap = calWords.filter(w => cWords.includes(w)).length;
    if (overlap > bestScore) { bestScore = overlap; best = n; }
  });
  return bestScore >= 1 ? best : null;
}

function closeHistory() {
  document.getElementById('history-modal').classList.remove('open');
  document.body.style.overflow = '';
}

function closeHistoryOutside(e) {
  if (e.target.id === 'history-modal') closeHistory();
}

function _populateHistorySelect() {
  const sel = document.getElementById('history-client-select');
  while (sel.options.length > 1) sel.remove(1);
  sel.value = '';
  const sorted = [...sheetClients].sort((a, b) => {
    const na = (a['Name(s)'] || a['name'] || '').toLowerCase();
    const nb = (b['Name(s)'] || b['name'] || '').toLowerCase();
    return na.localeCompare(nb);
  });
  sorted.forEach(c => {
    const name = c['Name(s)'] || c['name'] || '';
    if (!name) return;
    const opt = document.createElement('option');
    opt.value = opt.textContent = name;
    sel.appendChild(opt);
  });
}

// ── Load history from Historical Data sheet ───────────────────
