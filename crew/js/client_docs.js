/* =============================================================
   client_docs.js
   "Client Docs": reference files (a designer's plant list, a site
   plan, photos...) the office has attached to a client. Shown as a
   drop-down row on the client info card (crew panel) and in the
   client profile (Clients page).

   How it works
   - One request per page load (GET /clients/docs) returns
     { byFolder: { <Drive Folder ID>: [files] } } for every client
     that has any files, so a card only shows the row when there is
     something to show, with no per-card requests.
   - Cards render immediately; rows are emitted as empty hidden
     "slots" if the list has not arrived yet, and filled in when it
     does (fillClientDocsSlots), so nothing waits on this.
   - Files open in a new tab through the backend
     (/clients/docs/file/<id>), so crew need no Google/Drive access.
   - Any failure leaves the rows hidden; it never blocks the card.

   Loaded by mantis_crew_panel.html and mantis_clients.html.
   loadClientDocsIndex() is called from applyClientsData() (crew_api.js)
   and loadClients() (crew_clients.js).
   ============================================================= */

var CLIENT_DOCS = { byFolder: {}, loaded: false, loading: false };

function _cdEsc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function _cdBase() {
  return (typeof MANTIS_CONFIG !== 'undefined' && MANTIS_CONFIG.SCRIPT_URL) ? MANTIS_CONFIG.SCRIPT_URL : '';
}

function _cdToken() {
  var t = '';
  try { t = sessionStorage.getItem('mg_id_token') || ''; } catch (e) {}
  if (!t) {
    try {
      var ls = localStorage.getItem('mg_id_token') || '';
      var exp = parseInt(localStorage.getItem('mg_id_token_expiry') || '0', 10);
      if (ls && Date.now() < exp) t = ls;
    } catch (e) {}
  }
  return t;
}

(function injectClientDocsStyle() {
  if (document.getElementById('client-docs-style')) return;
  var st = document.createElement('style');
  st.id = 'client-docs-style';
  st.textContent =
    '.cd-details{margin:0}' +
    '.cd-details>summary{cursor:pointer;font-weight:600;color:var(--g,#2d6a4f);list-style:revert;padding:2px 0}' +
    '.cd-list{display:flex;flex-direction:column;gap:2px;margin:6px 0 2px;padding:0}' +
    '.cd-doc{display:block;padding:7px 10px;border:1px solid var(--g4,#cfe3d8);background:var(--g3,#eef6f1);' +
    'border-radius:6px;color:var(--g,#2d6a4f);text-decoration:none;font-size:var(--fs-small,13px);' +
    'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-height:20px}' +
    '.cd-doc:hover{text-decoration:underline}';
  document.head.appendChild(st);
})();

function _cdIcon(mime) {
  if (/^image\//.test(mime || '')) return '🖼️';
  if (mime === 'application/pdf') return '📕';
  return '📄';
}

function _cdDocsFor(folderId) {
  return (CLIENT_DOCS.byFolder && CLIENT_DOCS.byFolder[folderId]) || [];
}

function _cdFileUrl(id) {
  return _cdBase() + '/clients/docs/file/' + encodeURIComponent(id) + '?id_token=' + encodeURIComponent(_cdToken());
}

// The <details> drop-down for one client's files ('' when there are none).
function _cdDropdownHtml(folderId) {
  var files = _cdDocsFor(folderId);
  if (!files.length) return '';
  var items = files.map(function (f) {
    return '<a class="cd-doc" href="' + _cdEsc(_cdFileUrl(f.id)) + '" target="_blank" rel="noopener" title="' + _cdEsc(f.name) + '">' +
      _cdIcon(f.mimeType) + ' ' + _cdEsc(f.name) + '</a>';
  }).join('');
  return '<details class="cd-details"><summary>📎 Client Docs (' + files.length + ')</summary><div class="cd-list">' + items + '</div></details>';
}

function _cdSlotInner(variant, folderId) {
  var dd = _cdDropdownHtml(folderId);
  if (!dd) return '';
  return variant === 'profile'
    ? '<span class="profile-label">Client Docs</span><span class="profile-val">' + dd + '</span>'
    : '<span class="dlabel">Docs</span><span class="dval">' + dd + '</span>';
}

// HTML for the row on a client card (variant 'card', default) or in the
// Clients-page profile ('profile'). '' if the client has no Drive folder.
function clientDocsRowHtml(client, variant) {
  var folderId = String((client && client['Drive Folder ID']) || '').trim();
  if (!folderId) return '';
  variant = variant === 'profile' ? 'profile' : 'card';
  var inner = _cdSlotInner(variant, folderId);
  return '<div class="' + (variant === 'profile' ? 'profile-row' : 'drow') + ' client-docs-slot"' +
    ' data-folder="' + _cdEsc(folderId) + '" data-variant="' + variant + '"' +
    (inner ? '' : ' style="display:none"') +
    ' onclick="event.stopPropagation()">' + inner + '</div>';
}

// Fills (or hides) every slot currently in the page.
function fillClientDocsSlots() {
  var slots = document.querySelectorAll('.client-docs-slot');
  for (var i = 0; i < slots.length; i++) {
    var el = slots[i];
    var inner = _cdSlotInner(el.getAttribute('data-variant'), el.getAttribute('data-folder'));
    // Don't rebuild a slot that is already showing the same files; that
    // would collapse a drop-down the crew member has just opened.
    var sig = _cdDocsFor(el.getAttribute('data-folder')).map(function (f) { return f.id; }).join(',');
    if (el.getAttribute('data-sig') === sig) continue;
    el.setAttribute('data-sig', sig);
    el.innerHTML = inner;
    el.style.display = inner ? '' : 'none';
  }
}

// Loads the index once per page load (call again with force=true to refresh).
function loadClientDocsIndex(force) {
  if (CLIENT_DOCS.loading || (CLIENT_DOCS.loaded && !force)) return;
  var base = _cdBase(), token = _cdToken();
  if (!base || !token) return;
  CLIENT_DOCS.loading = true;
  var controller = new AbortController();
  var timer = setTimeout(function () { controller.abort(); }, 12000);
  fetch(base + '/clients/docs?id_token=' + encodeURIComponent(token), { signal: controller.signal })
    .then(function (r) { return r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status)); })
    .then(function (data) {
      CLIENT_DOCS.byFolder = (data && data.byFolder) || {};
      CLIENT_DOCS.loaded = true;
      fillClientDocsSlots();
    })
    .catch(function (e) { console.warn('Client docs unavailable:', e.message); })
    .then(function () { clearTimeout(timer); CLIENT_DOCS.loading = false; });
}
