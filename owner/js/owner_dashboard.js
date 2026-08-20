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

// The Client DB sheet isn't necessarily in any particular order — new
// clients just get appended to the next empty row — so this is applied
// every time the list is loaded rather than relying on sheet order.
function _sortClientsByName(clients) {
  return clients.slice().sort((a, b) =>
    String(a['Name(s)'] || '').localeCompare(String(b['Name(s)'] || ''), undefined, { sensitivity: 'base' })
  );
}

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
  // Also clear the persisted cross-tab-close session (owner_login.js's
  // OWNER_PERSIST_MS layer) — otherwise an explicit sign-out or an
  // inactivity-timeout sign-out (this function is session_timeout.js's
  // onSignOut) would still leave a valid persisted session behind, and
  // the owner would land back on the login page just to get silently
  // bounced straight back into the dashboard they were just signed out
  // of.
  localStorage.removeItem('owner_auth');
  localStorage.removeItem('owner_id_token');
  localStorage.removeItem('owner_user_email');
  localStorage.removeItem('owner_user_name');
  localStorage.removeItem('owner_auth_expiry');
  window.location.href = (typeof OWNER_CONFIG !== 'undefined')
    ? OWNER_CONFIG.LOGIN_URL : 'index.html';
}

// Only needed when invoice creation starts failing with a QuickBooks
// "token refresh failed" error (see routes/quickbooksOAuth.js on the
// backend). Opens in a new tab since it navigates through Intuit's
// own login/consent screen and back — losing the dashboard tab's
// state for that would be an annoying side effect of what's meant to
// be a quick, occasional fix.
function reconnectQuickBooks() {
  const base = (typeof OWNER_CONFIG !== 'undefined') ? OWNER_CONFIG.SCRIPT_URL : '';
  if (!base) { alert('SCRIPT_URL is not configured — cannot start QuickBooks reconnect.'); return; }
  const url = `${base}/owner/quickbooks/oauth-start?id_token=${encodeURIComponent(getIdToken())}`;
  window.open(url, '_blank');
}

// =============================================================
// SECTION 3 — API LAYER
// =============================================================
const CACHE_TTL = {
  ownerClients:  5 * 60 * 1000,
  ownerSchedule: 3 * 60 * 1000,
  ownerLoadAll:  3 * 60 * 1000,
};

function getIdToken() {
  return sessionStorage.getItem('owner_id_token') || '';
}

function clearOwnerCache() {
  Object.keys(sessionStorage)
    .filter(k => k.startsWith('oc_cache_'))
    .forEach(k => sessionStorage.removeItem(k));
}

// Cloud Run cutover: the "still warming up" banner
// (showWarmingBanner()/clearWarmingBanner()) that used to live here
// is gone -- this backend always does a live fetch on a cache miss
// (see build doc design decisions), so a response is always either
// real data or an error, never a known-stale warming placeholder.

// ── Slow-load banner ─────────────────────────────────────────────
// Same treatment as the crew panel's equivalent (crew_api.js). A load
// that's still going after SLOW_LOAD_MS — 
// _fetchJsonWithRetry() working through its retries after a transient
// serving glitch — gets a reassuring note instead of just sitting
// there looking frozen with no feedback at all, which is what a real
// report described happening here.
const SLOW_LOAD_MS = 6000;
let _slowLoadTimer = null;

function showSlowLoadBanner() {
  let banner = document.getElementById('slow-load-banner');
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'slow-load-banner';
    banner.className = 'offline-banner';
    const statusBar = document.querySelector('.status-bar');
    statusBar.parentNode.insertBefore(banner, statusBar);
  }
  banner.innerHTML =
    `<span class="offline-icon">&#8987;</span>` +
    `<span>Still loading — this can take longer than usual occasionally. Hang tight.</span>`;
}

function clearSlowLoadBanner() {
  clearTimeout(_slowLoadTimer);
  _slowLoadTimer = null;
  const b = document.getElementById('slow-load-banner');
  if (b) b.remove();
}

// ── Token refresh ─────────────────────────────────────────────
// Google ID tokens expire after 1 hour. The owner portal session
// is 2 hours, so tokens will expire mid-session. When ownerFetch/
// ownerPost receives an "Invalid token" error, _refreshOwnerToken()
// uses GIS to silently issue a new credential and retries the
// request — the owner sees nothing. Only if GIS silent refresh
// fails (rare) does it fall back to redirecting to the login page.
// The GIS script is loaded async on this page specifically to
// support this — it is separate from the session timeout.
//
// google.accounts.id.initialize() is only ever called ONCE per page
// life now (see _ensureOwnerGisInit()) even though a refresh can
// happen several times over a 2-hour session — this used to call
// initialize() fresh on every single refresh. Re-initializing while
// an earlier FedCM request might still be settling aborts it
// ("FedCM get() rejects with AbortError"), and enough of those trip
// Chrome's "FedCM was disabled...based on previous user action"
// cooldown for the site — which then makes the next sign-in fall back
// to GIS's much slower iframe-relay flow (the crew login page hit
// this exact bug; see gisInitialize() in mantis_landing.js). Since
// GIS's callback is fixed at initialize() time, the one stable
// callback registered here just dispatches to whichever
// _refreshOwnerToken() call is currently pending, instead of each
// call installing (and re-initializing for) its own callback.
let _tokenRefreshPromise = null;
let _ownerGisInitDone    = false;
let _pendingTokenResolve = null;
let _pendingTokenReject  = null;

function _ensureOwnerGisInit() {
  if (_ownerGisInitDone) return;
  google.accounts.id.initialize({
    client_id:   (typeof OWNER_CONFIG !== 'undefined') ? OWNER_CONFIG.GOOGLE_CLIENT_ID : '',
    auto_select: true,
    callback: (response) => {
      // Whether this came from the silent prompt or the owner clicking
      // the interactive re-auth button, either way the wait is over.
      _hideReauthPrompt_();
      const resolve = _pendingTokenResolve, reject = _pendingTokenReject;
      _pendingTokenResolve = _pendingTokenReject = null;
      _tokenRefreshPromise = null;
      if (response && response.credential) {
        sessionStorage.setItem('owner_id_token', response.credential);
        if (resolve) resolve(response.credential);
      } else {
        _handleTokenExpiry();
        if (reject) reject(new Error('No credential returned'));
      }
    },
  });
  _ownerGisInitDone = true;
}

// ── Interactive re-auth fallback ────────────────────────────────
// Silent refresh (google.accounts.id.prompt()) is increasingly blocked
// outright by browsers (Safari ITP, Chrome's FedCM restrictions) —
// this used to mean any owner who hit that immediately got their
// session wiped and redirected to a bare login page, losing whatever
// they were doing (a real report: adding a new client). A real user
// CLICK on a properly rendered Google Sign-In button isn't subject to
// that same silent-prompt blocking, since it's genuine user-initiated
// interaction, not an automatic background prompt. Showing that button
// inline — instead of immediately giving up — lets the owner
// re-authenticate in one tap without losing their place.
function _showReauthPrompt_() {
  const banner = document.getElementById('owner-reauth-banner');
  if (!banner) return;
  banner.style.display = 'block';
  try {
    google.accounts.id.renderButton(
      document.getElementById('owner-reauth-google-btn'),
      { theme: 'filled_blue', size: 'medium', text: 'signin', shape: 'pill' }
    );
  } catch(e) {
    console.warn('_showReauthPrompt_: renderButton failed', e);
  }
}

function _hideReauthPrompt_() {
  const banner = document.getElementById('owner-reauth-banner');
  if (banner) banner.style.display = 'none';
}

// Owner explicitly dismisses the banner rather than signing back in —
// rejects the still-pending refresh promise (so whatever action
// triggered it fails cleanly with a normal "Save failed" style
// message) without wiping the session or redirecting, so anything
// else already loaded keeps working and the failed action can just be
// retried once they're ready.
function _cancelReauthPrompt_() {
  _hideReauthPrompt_();
  const reject = _pendingTokenReject;
  _pendingTokenResolve = _pendingTokenReject = null;
  _tokenRefreshPromise = null;
  if (reject) reject(new Error('Sign-in cancelled'));
}

function _refreshOwnerToken() {
  if (_tokenRefreshPromise) return _tokenRefreshPromise;
  _tokenRefreshPromise = new Promise((resolve, reject) => {
    const tryRefresh = () => {
      if (typeof google === 'undefined' || !google.accounts) {
        _tokenRefreshPromise = null;
        reject(new Error('GIS not available'));
        return;
      }
      _pendingTokenResolve = resolve;
      _pendingTokenReject  = reject;
      _ensureOwnerGisInit();
      google.accounts.id.prompt((notification) => {
        if (notification.isNotDisplayed() || notification.isSkippedMoment()) {
          // Deliberately NOT rejecting or clearing _pendingTokenResolve/
          // _tokenRefreshPromise here — the promise stays pending, and
          // showing the interactive button below means the SAME GIS
          // callback in _ensureOwnerGisInit() resolves (or rejects) it
          // whichever way the owner's click goes. That means whatever
          // originally called _refreshOwnerToken() — ownerFetch()/
          // ownerPost()'s "await _refreshOwnerToken(); retry" pattern —
          // picks up and automatically retries on success, with no
          // separate retry plumbing needed here.
          _showReauthPrompt_();
        }
      });
    };

    // GIS script is loaded async — wait up to 3s for it if needed
    if (typeof google !== 'undefined' && google.accounts) {
      tryRefresh();
    } else {
      let waited = 0;
      const poll = setInterval(() => {
        waited += 100;
        if (typeof google !== 'undefined' && google.accounts) {
          clearInterval(poll);
          tryRefresh();
        } else if (waited >= 3000) {
          clearInterval(poll);
          _tokenRefreshPromise = null;
          _handleTokenExpiry();
          reject(new Error('GIS did not load in time'));
        }
      }, 100);
    }
  });
  return _tokenRefreshPromise;
}

function _handleTokenExpiry() {
  sessionStorage.removeItem('owner_auth');
  sessionStorage.removeItem('owner_id_token');
  sessionStorage.setItem('owner_token_expired', '1');
  // Also clear the persisted cross-tab-close session (see doSignOut's
  // comment) — this path means a real refresh attempt already failed
  // outright (GIS unavailable or no credential returned), not just a
  // routine expired-token retry. Without this, the login page's
  // persisted-session check would see a still-"valid" localStorage
  // session and silently redirect straight back to the dashboard,
  // which would immediately hit the same failure again — an infinite
  // redirect loop instead of landing on a normal, working login screen.
  localStorage.removeItem('owner_auth');
  localStorage.removeItem('owner_id_token');
  localStorage.removeItem('owner_user_email');
  localStorage.removeItem('owner_user_name');
  localStorage.removeItem('owner_auth_expiry');
  window.location.href = (typeof OWNER_CONFIG !== 'undefined')
    ? OWNER_CONFIG.LOGIN_URL : 'index.html';
}

function _isTokenError(err) {
  const msg = (err && err.message) || '';
  // 'Token expired' is Auth.gs's verifyGoogleToken() response for the
  // single most common, fully-expected failure — a Google ID token
  // past its own 1-hour expiry, which is exactly the case
  // _refreshOwnerToken() exists to recover from silently. It didn't
  // match any of the checks below, so this specific, very normal
  // failure skipped the refresh-and-retry path entirely and surfaced
  // as a raw "Save failed: Token expired" toast instead — a real
  // report from the owner hitting this on Save Client.
  return msg.includes('Invalid token') || msg.includes('Unauthorized') ||
         msg.includes('Token expired') ||
         msg.includes('HTTP 400')      || msg.includes('HTTP 401');
}

// Plain fetch() has NO built-in timeout — if a request stalls mid-
// flight (a dropped or degraded connection), the promise just sits
// pending forever, with no recovery but a manual page reload. A real
// report on the crew panel showed exactly that pattern (stuck on
// "still loading" indefinitely, resolved instantly by reloading —
// proving the backend wasn't the problem). AbortController forces a
// stalled request to actually fail after FETCH_TIMEOUT_MS, so
// _fetchJsonWithRetry() below treats it like any other failure.
// 7s — see the matching comment in crew_api.js. A HAR capture of a
// real slow load showed the actual failure mode: the initial /exec
// request always gets its redirect back in 1-2s, but the follow-up
// fetch of the redirect target (script.googleusercontent.com/macros/
// echo) can hang completely dead until aborted — at which point the
// existing retry below succeeds in under a second. There's no
// legitimate slow-but-progressing case a long timeout is protecting
// against here, so 30s was just making every dead connection sit that
// much longer before the retry (which reliably works) got a chance.
const FETCH_TIMEOUT_MS = 7000;
function _fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs === undefined ? FETCH_TIMEOUT_MS : timeoutMs);
  return fetch(url, { ...(options || {}), signal: controller.signal }).finally(() => clearTimeout(timer));
}

// Apps Script Web Apps intermittently fail the redirect they use to
// serve /exec responses (a 302 to script.googleusercontent.com/macros/
// echo, which occasionally 404s with an HTML page instead of the real
// JSON — a known Google-side serving glitch, not something this app's
// code controls). Same pattern as fetchJsonWithRetry() in crew_api.js,
// just also accepting fetch options so it covers ownerPost()'s POST
// requests too, not only GETs.
//
// 2 retries (not 1) — a real report showed this failing twice in a
// row on ownerLoadAll before recovering, meaning a single retry isn't
// always enough. Each retry re-runs the full live query, so this is a
// real tradeoff (worst case now 3x the load instead of 2x on a genuine
// failure) — accepted since the alternative is the owner dashboard
// visibly failing to load.
async function _fetchJsonWithRetry(url, options, retries, timeoutMs) {
  retries = retries === undefined ? 2 : retries;
  try {
    const res = await _fetchWithTimeout(url, options, timeoutMs);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch(err) {
    if (retries > 0) {
      await new Promise(resolve => setTimeout(resolve, 700));
      return _fetchJsonWithRetry(url, options, retries - 1, timeoutMs);
    }
    throw err;
  }
}

// crew-cloud/owner-cloud REST-path translation instead of Apps
// Script's single-endpoint ?action= dispatch. Shared by both
// ownerFetch() (GET) and ownerPost() (POST) below, since both build
// their request URL from the same action name.
const OWNER_ACTION_PATHS = {
  ownerClients: '/owner/clients',
  ownerLoadAll: '/owner/load-all',
  ownerLoadAllFresh: '/owner/load-all', // force=1 appended below
  ownerGetLoginLog: '/owner/login-log',
  ownerClearLoginLog: '/owner/login-log/clear',
  ownerGetNotes: '/owner/notes',
  ownerSaveNotes: '/owner/notes',
  ownerSaveClient: '/owner/clients',
  ownerDeleteClient: '/owner/clients/delete',
  ownerGetDocuments: '/owner/documents',
};
// The only *Fresh-style action on the owner side -- ownerLoadAllFresh
// maps to the same path as ownerLoadAll, just with force=1 added,
// matching the Cloud Run backend's query-param convention rather than
// a separate action/path per force level.
const OWNER_FORCE_ACTIONS = new Set(['ownerLoadAllFresh']);

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

  async function _fetch() {
    const idToken = encodeURIComponent(getIdToken());
    const path = OWNER_ACTION_PATHS[action] || ('/' + action);
    const forceParam = OWNER_FORCE_ACTIONS.has(action) ? '&force=1' : '';
    const data = await _fetchJsonWithRetry(`${SCRIPT_URL}${path}?id_token=${idToken}${forceParam}${extra}`);
    if (data.error) throw new Error(data.error);
    return data;
  }

  let data;
  try {
    data = await _fetch();
  } catch(err) {
    if (_isTokenError(err)) {
      await _refreshOwnerToken();
      data = await _fetch();
    } else {
      throw err;
    }
  }

  // No "is this a warming placeholder" check needed here anymore --
  // see crew_api.js's apiFetch() for the full reasoning (same backend,
  // same guarantee: always real data or a thrown error, never a
  // known-stale placeholder).
  if (ttl) {
    try {
      sessionStorage.setItem(cacheKey, JSON.stringify({ ts: Date.now(), data }));
    } catch(e) {}
  }
  return data;
}

// -- fetchOwnerLoadAllWithFallback --------------------------------
// owner-cloud/ simplification -- same reasoning as crew_api.js's
// fetchCrewLoadAllWithFallback(): Cloud Run has no GitHub-publish
// pipeline producing a static snapshot to check for, so checking for
// one here would only ever fail before falling through to the same
// live call anyway. Kept as its own named function purely so its one
// call site doesn't need to change.
async function fetchOwnerLoadAllWithFallback() {
  return ownerFetch('ownerLoadAll');
}

async function ownerPost(action, payload, timeoutMs) {
  async function _post() {
    const idToken = encodeURIComponent(getIdToken());
    // retries=0 — _fetchJsonWithRetry defaults to 2 automatic retries,
    // which is safe for a GET (ownerFetch) but not here: a stalled or
    // lost response to a create/save POST doesn't mean the request
    // never reached the server — Apps Script's serving layer is known
    // to occasionally lose the RESPONSE even after the server finishes
    // fine (documented extensively elsewhere in this codebase). Blindly
    // retrying a non-idempotent write like ownerSaveClient() — which
    // has no dedup/idempotency check at all — means each retry that
    // actually reaches the server creates ANOTHER new row. A real
    // report: the owner added one client, got "Save failed," and three
    // rows showed up in the Client Database — exactly 1 original + 2
    // retries, each one silently succeeding server-side while the
    // client kept timing out waiting on the response. _fetchWithTimeout
    // already hard-bounds this single attempt via AbortController, so
    // dropping the retry here doesn't reintroduce a hang — it just
    // stops after one attempt instead of silently trying three times.
    const path = OWNER_ACTION_PATHS[action] || ('/' + action);
    const data = await _fetchJsonWithRetry(`${SCRIPT_URL}${path}?id_token=${idToken}`, {
      method:  'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body:    JSON.stringify(payload),
    }, 0, timeoutMs);
    if (data.error) throw new Error(data.error);
    return data;
  }

  try {
    return await _post();
  } catch(err) {
    if (_isTokenError(err)) {
      await _refreshOwnerToken();
      return await _post();
    }
    throw err;
  }
}


function setStatus(id, state, msg) {
  const dot   = document.getElementById('sd-' + id);
  const label = document.getElementById('sl-' + id);
  if (dot)   dot.className = `sdot ${state}`;
  if (label) label.textContent = msg;
}

// forceFresh=true (used by the reload button) calls ownerLoadAllFresh
// instead of the normal ownerLoadAll — see Utilities.gs's doGet for
// what that changes server-side (forces a live schedule/manager_schedule
// refresh instead of reading the cache-only default). Same shape either
// way; everything below behaves identically.
async function loadAll(forceFresh) {
  document.querySelector('.reload-btn').disabled = true;
  setStatus('clients',  'loading', 'Clients: loading…');
  setStatus('schedule', 'loading', 'Schedule: loading…');
  setStatus('records',  'live',    'Documents: ready');

  // Fire a warm-up ping -- also tells us whether this signed-in user
  // is tech-allowlisted, to reveal the QuickBooks reconnect button.
  // Hidden by default in the HTML; this is the only place that ever
  // shows it, so a failed/slow ping just leaves it hidden rather than
  // flashing it visible first.
  fetch(`${SCRIPT_URL}/owner/ping?id_token=${encodeURIComponent(getIdToken())}`)
    .then(r => r.json())
    .then(data => {
      const btn = document.getElementById('qb-reconnect-btn');
      if (btn && data && data.isTech) btn.style.display = '';
    })
    .catch(()=>{});

  // ── Single combined fetch ──────────────────────────────────
  // Was 3 separate round trips (ownerClients / ownerSchedule /
  // ownerManagerSchedule), each independently re-verifying the same
  // Google ID token against Google's tokeninfo endpoint. Now it's one
  // request — the backend verifies the token once and bundles all
  // three sections into a single response.
  // forceFresh (the reload button) goes through ownerLoadAllFresh
  // (force=1 on the backend), bypassing its cache for a genuinely
  // live Calendar/Sheets read. The normal load still goes through
  // fetchOwnerLoadAllWithFallback() -- a thin passthrough to
  // ownerFetch('ownerLoadAll') now, see that function's own comment.
  let bundle = null, bundleErr = null;
  _slowLoadTimer = setTimeout(showSlowLoadBanner, SLOW_LOAD_MS);
  try {
    bundle = forceFresh
      ? await ownerFetch('ownerLoadAllFresh')
      : await fetchOwnerLoadAllWithFallback();
  } catch(e) { bundleErr = e; }
  clearSlowLoadBanner();

  function toResult(section) {
    if (bundleErr) return { status: 'rejected', reason: bundleErr };
    const val = bundle ? bundle[section] : undefined;
    if (val && val.error) return { status: 'rejected', reason: new Error(val.error) };
    return { status: 'fulfilled', value: val === undefined ? null : val };
  }

  const clientsRes     = toResult('clients');
  const scheduleRes    = toResult('schedule');
  const mgrScheduleRes = toResult('manager_schedule');

  if (clientsRes.status === 'fulfilled') {
    allClients = _sortClientsByName(clientsRes.value.clients || []);
    setStatus('clients', 'live', `Clients: ${allClients.length} loaded`);
    renderClients('');
    populateClientFilter();
  } else {
    setStatus('clients', 'error', `Clients: ${clientsRes.reason.message}`);
  }

  if (scheduleRes.status === 'fulfilled') {
    scheduleData = scheduleRes.value.days || {};
    // Merge manager schedule into scheduleData under a 'managers' key per day
    if (mgrScheduleRes.status === 'fulfilled') {
      const mgrDays = mgrScheduleRes.value.days || {};
      Object.keys(mgrDays).forEach(dk => {
        if (!scheduleData[dk]) scheduleData[dk] = {};
        const d = mgrDays[dk];
        // Flat sorted array for any code that needs all manager events
        scheduleData[dk].managers = [
          ...(d.ashley || []),
          ...(d.brooke || []),
          ...(d.mgr    || []),
        ].sort((a, b) => a.startMs - b.startMs);
        // Keep streams separate so the day-card can label Ashley / Brooke / General
        scheduleData[dk]._mgrStreams = {
          ashley: d.ashley || [],
          brooke: d.brooke || [],
          mgr:    d.mgr    || [],
        };
      });
    }
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
  // If leaving the Notes tab with unsaved changes, discard them and
  // restore the last-loaded/saved state. The owner explicitly did not
  // click Save, so returning to this tab later should show the real
  // saved notes, not a lingering edit that only ever existed in memory.
  const leavingNotesDirty = tab !== 'notes'
    && document.getElementById('tab-notes').classList.contains('active')
    && notesDirty;
  if (leavingNotesDirty) discardUnsavedNotes();

  document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  document.querySelector(`[data-tab="${tab}"]`).classList.add('active');
  document.getElementById(`tab-${tab}`).classList.add('active');
  // Lazy-load on first visit
  if (tab === 'notes'   && !notesData)    loadNotes();
  if (tab === 'logins'  && !loginsLoaded) loadLoginLog();
}

function discardUnsavedNotes() {
  if (notesPristine) notesData = JSON.parse(JSON.stringify(notesPristine));
  notesDirty = false;
  const btn = document.getElementById('notes-save-btn');
  if (btn) btn.classList.remove('unsaved');
  if (currentTeam === 'leads') renderLeadsEditor(); else renderNotesEditor();
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
  // Use local date components — toISOString() returns UTC which is off-by-one
  // for US timezones, causing Monday to appear as Sunday in the schedule.
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function renderSchedule() {
  const days  = getWeekDates(schedWeekDelta);
  const today = dateKey(new Date());

  // Week label
  const start = days[0].toLocaleDateString('en-US', { month:'short', day:'numeric' });
  const end   = days[6].toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' });
  document.getElementById('sched-week-label').textContent = `${start} – ${end}`;

  const grid = document.getElementById('schedule-grid');

  // ── Day-card layout ───────────────────────────────────────
  // Each weekday gets its own card. Inside each card the four
  // teams are stacked as labeled rows. Works on phone (single
  // column) and desktop (2-column card grid).
  const teams = [
    { key: 't1',       label: 'Maintenance — Team 1', cls: 't1' },
    { key: 't2',       label: 'Maintenance — Team 2', cls: 't2' },
    { key: 't3',       label: 'Maintenance — Team 3', cls: 't3' },
    { key: 'tInstall', label: 'Install Team',         cls: 'install' },
    { key: 'managers', label: 'Managers',             cls: 'mgr' },
  ];

  // Only weekdays (Mon–Fri)
  const weekdays = days.filter(d => d.getDay() !== 0 && d.getDay() !== 6);

  let html = '<div class="day-card-grid">';

  weekdays.forEach(day => {
    const dk      = dateKey(day);
    const dayData = scheduleData[dk] || {};
    const isToday = dk === today;
    const dayLabel = day.toLocaleDateString('en-US', { weekday:'long', month:'short', day:'numeric' });

    html += `<div class="day-card${isToday ? ' day-card-today' : ''}">
      <div class="day-card-header">
        <span class="day-card-name">${dayLabel}</span>
        ${isToday ? '<span class="today-badge">today</span>' : ''}
      </div>`;

    teams.forEach(t => {
      const jobs = dayData[t.key] || [];

      // For managers, group by stream (ashley / brooke / mgr general)
      // For other teams, flat list
      let teamHtml = '';
      if (t.key === 'managers') {
        const mgrDay = (scheduleData[dk] || {})._mgrStreams;
        const streams = [
          { label: 'Ashley',       events: (scheduleData[dk]?._mgrStreams?.ashley || []) },
          { label: 'Brooke',       events: (scheduleData[dk]?._mgrStreams?.brooke || []) },
          { label: 'All Managers', events: (scheduleData[dk]?._mgrStreams?.mgr    || []) },
        ];
        // Only render streams with events, unless all are empty
        const hasAny = streams.some(s => s.events.length);
        if (!hasAny) {
          teamHtml = '<div class="dc-empty">—</div>';
        } else {
          streams.forEach(s => {
            if (!s.events.length) return;
            teamHtml += `<div class="dc-stream-label">${s.label}</div>`;
            s.events.forEach(j => {
              const hrs = j.dur ? `<span class="sched-dur">${esc(j.dur)}</span>` : '';
              teamHtml += `<div class="sched-job mgr">
                <div class="sched-job-client">${esc(j.title || '—')}</div>
                <div class="sched-job-meta">${j.allDay ? 'All day' : esc(j.time)} ${hrs}</div>
              </div>`;
            });
          });
        }
      } else {
        if (!jobs.length) {
          teamHtml = '<div class="dc-empty">—</div>';
        } else {
          jobs.forEach(j => {
            const hrs = j.dur ? `<span class="sched-dur">${esc(j.dur)}</span>` : '';
            teamHtml += `<div class="sched-job">
              <div class="sched-job-client">${esc(j.client || j.title || '—')}</div>
              <div class="sched-job-meta">${j.allDay ? 'All day' : esc(j.time)} ${hrs}</div>
            </div>`;
          });
        }
      }

      html += `<div class="dc-team dc-${t.cls}">
        <div class="dc-team-label ${t.cls}">${t.label}</div>
        <div class="dc-team-jobs">${teamHtml}</div>
      </div>`;
    });

    html += `</div>`; // close day-card
  });

  html += '</div>'; // close day-card-grid
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

// One-click Google Maps link for a client's address — same approach as
// the crew panel's renderAddressLink() (crew_render.js). The
// "?api=1&query=" search-URL form needs no API key and works with a
// raw human-typed address string, no geocoding needed.
function renderAddressLink(raw) {
  const text = String(raw || '').trim();
  if (!text) return '';
  const mapsUrl = 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(text);
  return `<a class="addr-a" href="${mapsUrl}" target="_blank" rel="noopener">${esc(text)}</a>`;
}

// Tap-to-call phone links — same pattern/regex as the crew panel's
// renderPhoneLinks() (crew_render.js), since the client Phone field is
// just as human-entered here: multiple numbers, name labels,
// extensions, en dashes instead of hyphens, etc.
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

// ── Modal overlay click-to-dismiss ──────────────────────────────
// A plain onclick="if (e.target === overlay) close()" check isn't
// enough on its own: per the DOM click-event spec, "click" fires on
// the deepest common ancestor of the mousedown target and the mouseup
// target — so starting a text selection inside a modal's content
// (e.g. dragging to select text in the Morning Notes editor) and
// releasing the mouse past the overlay backdrop computes e.target as
// the OVERLAY itself (the common ancestor of "deep inside the
// content" and "the backdrop"), even though the user never intended
// to dismiss the modal, just to select text. Tracking whether the
// MOUSEDOWN itself started on the backdrop (not inside the modal's
// content) closes that gap: dismissal now requires the whole
// gesture — both the mousedown and the resulting click — to
// originate on the backdrop, not just end up computing that way.
// Shared across all three modals (client, profile, note editor),
// which each wire onmousedown="_modalOverlayMouseDown(event)" +
// onclick="closeXModal(event)" on their overlay div.
let _modalOverlayMouseDownOnBackdrop = false;

function _modalOverlayMouseDown(event) {
  _modalOverlayMouseDownOnBackdrop = (event.target === event.currentTarget);
}

function closeProfileModal(e) {
  if (e && (e.target !== document.getElementById('profile-modal') || !_modalOverlayMouseDownOnBackdrop)) return;
  document.getElementById('profile-modal').classList.remove('open');
  document.body.style.overflow = '';
}

// ── Add / Edit Client Modal ────────────────────────────────
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
    // 20s, not the default 7s — adding a new client is one of the
    // heaviest operations in the app (Drive folder + subfolders + a
    // whole new Historical Data Google Sheet, on top of the row write),
    // and the default timeout was tight enough for it to occasionally
    // time out client-side even though the server finished fine.
    const result = await ownerPost('ownerSaveClient', payload, 20000);
    showToast(currentEditId ? 'Client updated ✓' : `Client added ✓ (${result.clientId})`);
    closeClientModal();
    // Clear cache and reload clients
    sessionStorage.removeItem('oc_cache_ownerClients');
    const fresh = await ownerFetch('ownerClients');
    allClients = _sortClientsByName(fresh.clients || []);
    renderClients(document.getElementById('client-search').value || '');
    populateClientFilter();
  } catch(err) {
    showToast('Save failed: ' + err.message);
  } finally {
    saveBtn.disabled = false;
    saveBtn.textContent = 'Save Client';
  }
}

// Archives the client currently open in the edit modal (see
// ownerDeleteClient() in OwnerPortal.gs) — moves their row to the
// Retired Clients tab rather than deleting it outright, so Drive
// folder/records/history stay intact and the row is recoverable by
// moving it back manually. A confirm() dialog gates this since it's
// otherwise a single click away with no in-app undo, same pattern as
// the Login Log's "Clear" button (clearCrewLoginLog() above).
async function deleteCurrentClient() {
  if (!currentEditId) return;
  const c    = allClients.find(x => x['Client ID'] === currentEditId);
  const name = (c && c['Name(s)']) || 'this client';
  if (!confirm(`Delete ${name}? This moves them out of the active client list into Retired Clients — their Drive folder and records stay intact, but this can't be undone from within the app.`)) return;

  const delBtn = document.getElementById('cf-delete-btn');
  delBtn.disabled = true;
  delBtn.textContent = 'Deleting…';

  try {
    // 20s, not the default 7s — same requestCachePublish_() reasoning
    // as ownerSaveClient/saveClient above.
    await ownerPost('ownerDeleteClient', { clientId: currentEditId }, 20000);
    showToast('Client deleted ✓');
    closeClientModal();
    sessionStorage.removeItem('oc_cache_ownerClients');
    const fresh = await ownerFetch('ownerClients');
    allClients = _sortClientsByName(fresh.clients || []);
    renderClients(document.getElementById('client-search').value || '');
    populateClientFilter();
  } catch(err) {
    showToast('Delete failed: ' + err.message);
  } finally {
    delBtn.disabled = false;
    delBtn.textContent = 'Delete Client';
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
  sel.innerHTML = '';
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

  if (!clientName) {
    list.innerHTML = `<div class="empty-state">Select a client to view their documents.</div>`;
    setStatus('records', 'live', 'Documents: ready');
    return;
  }

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
      list.innerHTML = `<div class="empty-state">No documents found for ${esc(clientName)}${period}.</div>`;
      return;
    }

    list.innerHTML = docs.map(d => docRow(d)).join('');

  } catch(err) {
    setStatus('records', 'error', 'Documents: error');
    list.innerHTML = `<div class="empty-state">Failed to load documents: ${esc(err.message)}</div>`;
  }
}

function docRow(d) {
  const { label, icon } = mimeInfo(d.mimeType);
  return `<div class="doc-row">
    <span class="doc-icon">${icon}</span>
    <div class="doc-info">
      <a class="doc-name" href="${esc(d.url)}" target="_blank" rel="noopener">${esc(d.name)}</a>
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

let notesData     = null;   // { t1, t2, t3, install } — sections per team
let notesPristine = null;   // deep-cloned snapshot of the last loaded/saved state
let currentTeam   = 't1';   // which team tab is active
let notesDirty    = false;  // unsaved changes flag

const NOTES_TEAM_LABELS = {
  t1: 'Maint Team 1', t2: 'Maint Team 2', t3: 'Maint Team 3',
  install: 'Install', allcrew: 'All Crew', managers: 'Managers', leads: 'Leads'
};

// ── Note item rich-text sanitizer ───────────────────────────────
// Note items are stored as small HTML fragments (bold/italic/font-size/
// color only) instead of plain text, so the owner can format them via
// the Note Editor popup below. This allow-list keeps that safe and
// keeps the stored HTML predictable — nothing else survives a save,
// including anything pasted in from elsewhere. It's applied again at
// render time too (defensively — in case a cell was ever hand-edited
// directly in Google Sheets rather than through this editor).
const NOTE_ALLOWED_TAGS = new Set(['B','STRONG','I','EM','SPAN','BR']);
function sanitizeNoteHtml(html) {
  const tmp = document.createElement('div');
  tmp.innerHTML = html || '';

  function walk(parent) {
    let node = parent.firstChild;
    while (node) {
      const next = node.nextSibling;
      if (node.nodeType === Node.ELEMENT_NODE) {
        if (!NOTE_ALLOWED_TAGS.has(node.tagName)) {
          if (node.tagName === 'SCRIPT' || node.tagName === 'STYLE') {
            parent.removeChild(node);
            node = next;
            continue;
          }
          // Disallowed element — unwrap it, keep its text/children
          while (node.firstChild) parent.insertBefore(node.firstChild, node);
          parent.removeChild(node);
        } else {
          if (node.tagName === 'SPAN') {
            const color    = node.style.color;
            const fontSize = node.style.fontSize;
            [...node.attributes].forEach(a => node.removeAttribute(a.name));
            let style = '';
            if (color)    style += `color:${color};`;
            if (fontSize) style += `font-size:${fontSize};`;
            if (style) {
              node.setAttribute('style', style);
              walk(node);
            } else {
              // Empty span (no allowed style survived) — unwrap
              while (node.firstChild) parent.insertBefore(node.firstChild, node);
              parent.removeChild(node);
            }
          } else {
            [...node.attributes].forEach(a => node.removeAttribute(a.name));
            walk(node);
          }
        }
      } else if (node.nodeType !== Node.TEXT_NODE) {
        parent.removeChild(node); // comments, etc.
      }
      node = next;
    }
  }
  walk(tmp);
  return tmp.innerHTML.trim();
}

// ── Note Editor popup ────────────────────────────────────────────
// Opens on click of any note item (team sections or leads columns).
// Minimal toolbar — bold, italic, three font sizes, and a small preset
// color palette — applied via the Selection API rather than the
// deprecated document.execCommand, so the output is exactly the
// b/i/span[style] markup sanitizeNoteHtml() expects.
let _neTarget = null; // { kind:'section', si, ii } or { kind:'lead', ci, ii }

function openNoteEditor(si, ii) {
  _neTarget = { kind: 'section', si, ii };
  const item = notesData[currentTeam][si].items[ii] || '';
  _openNoteEditorModal(item);
}

function openNoteEditorLead(ci, ii) {
  _neTarget = { kind: 'lead', ci, ii };
  const item = notesData.leads.columns[ci][ii] || '';
  _openNoteEditorModal(item);
}

function _openNoteEditorModal(item) {
  const canvas = document.getElementById('note-editor-canvas');
  canvas.innerHTML = sanitizeNoteHtml(item);
  _neActiveSpan = null;
  document.getElementById('note-editor-modal').classList.add('open');
  document.body.style.overflow = 'hidden';
  canvas.focus();
}

function closeNoteEditor(e) {
  if (e && (e.target !== document.getElementById('note-editor-modal') || !_modalOverlayMouseDownOnBackdrop)) return;
  document.getElementById('note-editor-modal').classList.remove('open');
  document.body.style.overflow = '';
  _neTarget = null;
}

function saveNoteEditor() {
  if (!_neTarget) return;
  const canvas = document.getElementById('note-editor-canvas');
  const clean  = sanitizeNoteHtml(canvas.innerHTML);
  const target = _neTarget;
  if (target.kind === 'section') {
    updateItem(target.si, target.ii, clean);
  } else {
    updateLeadItem(target.ci, target.ii, clean);
  }
  document.getElementById('note-editor-modal').classList.remove('open');
  document.body.style.overflow = '';
  _neTarget = null;
  if (target.kind === 'lead') renderLeadsEditor(); else renderNotesEditor();
}

// Wraps the current selection inside the canvas with a new element built
// by makeEl(). With nothing selected, wraps the whole note instead —
// friendlier for these short single-line items than requiring a select-all.
function neWrapSelection(makeEl) {
  const canvas = document.getElementById('note-editor-canvas');
  const sel = window.getSelection();
  let range = null;
  if (sel.rangeCount) {
    const r = sel.getRangeAt(0);
    if (canvas.contains(r.commonAncestorContainer) && !r.collapsed) range = r;
  }
  if (!range) {
    range = document.createRange();
    range.selectNodeContents(canvas);
  }
  const el = makeEl();
  try {
    range.surroundContents(el);
  } catch (e) {
    // surroundContents throws if the range's boundaries cross element
    // edges awkwardly — fall back to extract-then-wrap.
    const frag = range.extractContents();
    el.appendChild(frag);
    range.insertNode(el);
  }
  const newRange = document.createRange();
  newRange.selectNodeContents(el);
  sel.removeAllRanges();
  sel.addRange(newRange);
  canvas.focus();
}

function neBold()          { neWrapSelection(() => document.createElement('b')); }
function neItalic()        { neWrapSelection(() => document.createElement('i')); }
function neSize(size)      { neApplyStyle('fontSize', size); }
function neColor(color)    { neApplyStyle('color', color); }

// Size ladder for the -/+ buttons. 1 (normal) stores no font-size at
// all — same as today's untouched text. Each click steps one notch
// from wherever the current selection actually is, so repeated clicks
// keep growing/shrinking instead of snapping between two fixed values
// (which only ever looked like it worked "once": a second "+" click
// just reapplied the same 1.3em on top of itself, with no visible
// change).
const NE_SIZE_STEPS = [0.7, 0.85, 1, 1.15, 1.3, 1.5, 1.75];

function neSizeStep(dir) {
  const canvas = document.getElementById('note-editor-canvas');
  let currentEm = 1;

  if (_neActiveSpan && _neActiveSpan.style.fontSize) {
    currentEm = parseFloat(_neActiveSpan.style.fontSize) || 1;
  } else {
    // Walk up from the current selection to find the nearest element
    // (within the canvas) that already has an explicit font-size.
    const sel = window.getSelection();
    if (sel.rangeCount) {
      let node = sel.getRangeAt(0).startContainer;
      if (node.nodeType === Node.TEXT_NODE) node = node.parentNode;
      while (node && node !== canvas && canvas.contains(node)) {
        if (node.nodeType === Node.ELEMENT_NODE && node.style && node.style.fontSize) {
          currentEm = parseFloat(node.style.fontSize) || 1;
          break;
        }
        node = node.parentNode;
      }
    }
  }

  let idx = 0, bestDist = Infinity;
  NE_SIZE_STEPS.forEach((v, i) => {
    const d = Math.abs(v - currentEm);
    if (d < bestDist) { bestDist = d; idx = i; }
  });
  idx = Math.max(0, Math.min(NE_SIZE_STEPS.length - 1, idx + dir));
  const newVal = NE_SIZE_STEPS[idx];
  neApplyStyle('fontSize', newVal === 1 ? '' : newVal + 'em');
}

function neSizeUp()   { neSizeStep(1); }
function neSizeDown() { neSizeStep(-1); }

// Tracks the span currently being edited by consecutive size/color
// toolbar clicks, so the second, third, etc. click updates that same
// span instead of nesting a new one. This is deliberately NOT derived
// from window.getSelection() on each click — the selection state left
// behind after a DOM mutation (surroundContents/insertNode) is exactly
// the kind of thing that varies subtly across engines, and got this
// wrong badly in testing (a later click resolved against the wrong
// ancestor and wrapped the *entire note* instead of just the word).
// An explicit variable, reset whenever the owner actually changes their
// selection in the canvas, is simple and unambiguous instead.
let _neActiveSpan = null;

function neResetActiveSpan() { _neActiveSpan = null; }

// Narrow, safe check: does the current selection consist of exactly one
// text node, whose entire content is selected, whose parent is a <span>
// with no other children? If so return that span. Deliberately does NOT
// also match at the element-boundary level (e.g. a range produced by
// selectNodeContents on the span itself) — that broader version existed
// briefly and occasionally resolved against the wrong ancestor,
// corrupting the whole note instead of just the selected word.
function _neExactSpanForSelection(canvas) {
  const sel = window.getSelection();
  if (!sel.rangeCount) return null;
  const range = sel.getRangeAt(0);
  const s = range.startContainer;
  if (s !== range.endContainer || s.nodeType !== Node.TEXT_NODE) return null;
  const span = s.parentNode;
  if (!span || span.tagName !== 'SPAN' || span.childNodes.length !== 1) return null;
  if (range.startOffset !== 0 || range.endOffset !== s.length) return null;
  if (!canvas.contains(span)) return null;
  return span;
}

// If the current selection is exactly the contents of a single <span>
// (e.g. re-clicking a size or color button on a word already styled by
// a previous click), update that span's property in place rather than
// wrapping it in a second, nested span. Nesting is both messy markup
// and actively wrong for font-size specifically — nested "em" values
// compound multiplicatively instead of the later click just replacing
// the earlier one.
function neApplyStyle(prop, value) {
  const canvas = document.getElementById('note-editor-canvas');

  // If we're not already tracking a span from earlier clicks, check
  // whether the owner's current manual selection happens to be exactly
  // the contents of an existing span (e.g. they closed and reopened, or
  // clicked elsewhere and came back to a word already styled from a
  // previous save). Deliberately narrow: only matches when the
  // selection boundary is the text node itself, never derived from an
  // element boundary — that broader check was what caused an earlier
  // version of this to occasionally resolve against the wrong ancestor
  // and style the entire note instead of one word.
  if (!_neActiveSpan || !canvas.contains(_neActiveSpan)) {
    _neActiveSpan = _neExactSpanForSelection(canvas);
  }

  if (_neActiveSpan && canvas.contains(_neActiveSpan)) {
    if (value) _neActiveSpan.style[prop] = value;
    else _neActiveSpan.style[prop] = '';
    // Deliberately NOT unwrapping/removing the span here even if it now
    // has no meaningful style left — doing so would lose track of
    // exactly which text is being edited, so the *next* click (e.g.
    // growing the size again after shrinking to normal) would have
    // nothing to reuse and would fall back to styling the whole note
    // instead of just this word. A style-less span is visually inert
    // (identical to plain text) while editing, and sanitizeNoteHtml()
    // already strips it automatically on save and on every render, so
    // nothing empty ever actually persists.
    canvas.focus();
    return;
  }

  // No span currently being edited — wrap the current selection (or the
  // whole note, if nothing is selected) in a fresh span, and remember it
  // so subsequent clicks (until the owner picks a new selection) update
  // this same span instead of nesting another one.
  const sel = window.getSelection();
  let range = null;
  if (sel.rangeCount) {
    const r = sel.getRangeAt(0);
    if (canvas.contains(r.commonAncestorContainer) && !r.collapsed) range = r;
  }
  if (!range) {
    range = document.createRange();
    range.selectNodeContents(canvas);
  }
  const el = document.createElement('span');
  if (value) el.style[prop] = value;
  try {
    range.surroundContents(el);
  } catch (e) {
    const frag = range.extractContents();
    el.appendChild(frag);
    range.insertNode(el);
  }
  _neActiveSpan = el;
  const newRange = document.createRange();
  newRange.selectNodeContents(el);
  sel.removeAllRanges();
  sel.addRange(newRange);
  canvas.focus();
}

async function loadNotes() {
  setStatus('notes', 'loading', 'Notes: loading…');
  const editor = document.getElementById('notes-editor');
  editor.innerHTML = `<div class="empty-state"><span class="doc-loading-spinner"></span> Loading notes…</div>`;
  try {
    const data = await ownerFetch('ownerGetNotes');
    notesData  = data.tabs || { t1: [], t2: [], t3: [], install: [] };
    notesPristine = JSON.parse(JSON.stringify(notesData));
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
    // Revert the team/leads being left back to its last-saved state —
    // clearing the dirty flag alone would leave the in-memory edit
    // sitting there, so switching back to it later would still show it.
    if (notesPristine) {
      if (currentTeam === 'leads') {
        notesData.leads = JSON.parse(JSON.stringify(notesPristine.leads));
      } else {
        notesData[currentTeam] = JSON.parse(JSON.stringify(notesPristine[currentTeam] || []));
      }
    }
    notesDirty = false;
    const btn = document.getElementById('notes-save-btn');
    if (btn) btn.classList.remove('unsaved');
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
        <div class="notes-item-input" onclick="openNoteEditorLead(${ci},${ii})">${noteItemPreviewHtml(item)}</div>
        <div class="notes-item-move">
          <button class="notes-item-move-btn" onclick="moveLeadItem(${ci},${ii},-1)" title="Move up" ${ii === 0 ? 'disabled' : ''}>&#9650;</button>
          <button class="notes-item-move-btn" onclick="moveLeadItem(${ci},${ii},1)" title="Move down" ${ii === items.length - 1 ? 'disabled' : ''}>&#9660;</button>
        </div>
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
  openNoteEditorLead(ci, notesData.leads.columns[ci].length - 1);
}

function deleteLeadItem(ci, ii) {
  notesData.leads.columns[ci].splice(ii, 1);
  markDirty();
  renderLeadsEditor();
}

function moveLeadItem(ci, ii, dir) {
  const arr = notesData.leads.columns[ci];
  const jj = ii + dir;
  if (!arr || jj < 0 || jj >= arr.length) return;
  [arr[ii], arr[jj]] = [arr[jj], arr[ii]];
  markDirty();
  renderLeadsEditor();
}

function noteSectionHtml(sec, si) {
  const items = (sec.items || []);
  const itemsHtml = items.map((item, ii) => `
    <div class="notes-item-row" data-si="${si}" data-ii="${ii}">
      <span class="notes-bullet">•</span>
      <div class="notes-item-input" onclick="openNoteEditor(${si},${ii})">${noteItemPreviewHtml(item)}</div>
      <div class="notes-item-move">
        <button class="notes-item-move-btn" onclick="moveItem(${si},${ii},-1)" title="Move up" ${ii === 0 ? 'disabled' : ''}>&#9650;</button>
        <button class="notes-item-move-btn" onclick="moveItem(${si},${ii},1)" title="Move down" ${ii === items.length - 1 ? 'disabled' : ''}>&#9660;</button>
      </div>
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
      ${itemsHtml}
    </div>
    <button class="notes-add-item" onclick="addItem(${si})">+ Add item</button>
  </div>`;
}

// Shows a placeholder for empty items, otherwise the item's sanitized
// rich-text HTML (re-sanitized on every render — defensive, in case the
// sheet cell was ever edited directly in Google Sheets rather than
// through this editor).
function noteItemPreviewHtml(item) {
  const clean = sanitizeNoteHtml(item || '');
  return clean || `<span class="notes-item-placeholder">Click to add note…</span>`;
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
  const newIndex = notesData[currentTeam][si].items.length - 1;
  openNoteEditor(si, newIndex);
}

function deleteItem(si, ii) {
  notesData[currentTeam][si].items.splice(ii, 1);
  markDirty();
  renderNotesEditor();
}

function moveItem(si, ii, dir) {
  const arr = notesData[currentTeam][si].items;
  const jj = ii + dir;
  if (!arr || jj < 0 || jj >= arr.length) return;
  [arr[ii], arr[jj]] = [arr[jj], arr[ii]];
  markDirty();
  renderNotesEditor();
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
    // 20s, not the default 7s — same reasoning as ownerSaveClient above:
    // ownerSaveNotes() also calls requestCachePublish_(), which (outside
    // the 45s debounce window — the normal case for a one-off note edit)
    // runs a full live cache publish in-line before returning: two live
    // schedule rebuilds plus GitHub Contents API commits. That routinely
    // takes longer than 7s even though the note write itself is fast and
    // already committed. A real report: the owner saw "Save failed:
    // signal is aborted without reason" every time, and the note was
    // always actually saved — the client-side abort fired after the
    // write but during the trailing publish, which Apps Script keeps
    // running to completion regardless of the aborted connection.
    await ownerPost('ownerSaveNotes', payload, 20000);
    notesDirty = false;
    if (btn) btn.classList.remove('unsaved');
    // Only the currently-selected team/leads was actually persisted —
    // update just that slice of the pristine snapshot, not the whole
    // thing, so other teams' last-known-saved state stays accurate.
    if (notesPristine) {
      if (currentTeam === 'leads') {
        notesPristine.leads = JSON.parse(JSON.stringify(notesData.leads));
      } else {
        notesPristine[currentTeam] = JSON.parse(JSON.stringify(notesData[currentTeam] || []));
      }
    }
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
// SECTION 8b — CREW LOGIN LOG
// =============================================================
let loginsLoaded   = false;
let allLoginRows   = [];

async function loadLoginLog() {
  const el = document.getElementById('logins-list');
  el.innerHTML = '<div class="logins-empty">Loading…</div>';
  loginsLoaded = false;

  try {
    const data = await ownerFetch('ownerGetLoginLog', '&limit=300');
    if (data.error) throw new Error(data.error);
    allLoginRows = data.logins || [];
    loginsLoaded = true;
    renderLogins(allLoginRows);
  } catch(e) {
    el.innerHTML = `<div class="logins-empty logins-error">Could not load login log: ${esc(e.message)}</div>`;
  }
}

async function clearLoginLog() {
  if (!confirm('Clear all entries from the Login Log? This cannot be undone.')) return;
  const btn = document.querySelector('.action-btn-danger');
  if (btn) { btn.disabled = true; btn.textContent = 'Clearing…'; }
  try {
    const data = await ownerFetch('ownerClearLoginLog');
    if (data.error) throw new Error(data.error);
    allLoginRows = [];
    loginsLoaded = true;
    renderLogins([]);
    showToast('Login log cleared.');
  } catch(e) {
    showToast('Clear failed: ' + e.message);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '✕ Clear'; }
  }
}

function filterLogins(query) {
  if (!loginsLoaded) return;
  const q = query.trim().toLowerCase();
  if (!q) { renderLogins(allLoginRows); return; }
  renderLogins(allLoginRows.filter(r =>
    r.name.toLowerCase().includes(q)     ||
    r.email.toLowerCase().includes(q)    ||
    r.category.toLowerCase().includes(q) ||
    r.role.toLowerCase().includes(q)
  ));
}

function renderLogins(rows) {
  const el = document.getElementById('logins-list');
  if (!rows.length) {
    el.innerHTML = '<div class="logins-empty">No login records found.</div>';
    return;
  }

  // Group by date (MM/DD/YYYY extracted from the ts string)
  const groups = {};
  const order  = [];
  rows.forEach(r => {
    // ts is like "Jan 5, 2025, 7:42 AM" — extract date label
    const dateLabel = r.ts.replace(/,\s*\d+:\d+\s*(AM|PM)$/i, '').trim();
    if (!groups[dateLabel]) { groups[dateLabel] = []; order.push(dateLabel); }
    groups[dateLabel].push(r);
  });

  const html = order.map(dateLabel => {
    const dayRows = groups[dateLabel].map(r => `
      <div class="login-row">
        <span class="login-time">${esc(r.ts.match(/\d+:\d+\s*(AM|PM)/i)?.[0] || '')}</span>
        <span class="login-name">${esc(r.name || r.email)}</span>
        <span class="login-team">${esc(r.category)}${r.role ? ' · ' + esc(r.role) : ''}</span>
        <span class="login-email">${esc(r.email)}</span>
      </div>`).join('');
    return `
      <div class="login-date-group">
        <div class="login-date-header">${esc(dateLabel)}</div>
        ${dayRows}
      </div>`;
  }).join('');

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
// Small settle delay before the first fetch — unlike the crew login
// page (which shows a home screen and waits for an explicit tap
// before ever loading data), this page goes straight from a Google
// sign-in redirect landing here to firing loadAll() as the very next
// thing that happens, with no pause at all. Reported flakiness was
// worse on desktop Chrome than on phone; this doesn't prove the
// adjacency of "just finished a Google sign-in redirect" and "already
// hitting Google's infrastructure again" is the cause, but it's cheap
// to test and easy to remove if it doesn't help.
setTimeout(loadAll, 400);
