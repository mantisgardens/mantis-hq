/* =============================================================
   crew_api.js
   Mantis Gardens — API Layer

   Contains:
     - Cache TTLs and persistent offline cache (localStorage)
     - Offline banner display
     - apiFetch() — all calls to the Apps Script web app
     - setStatus() — status pill updates
     - loadAll() — parallel load of all four data sources
   ============================================================= */

// Cache TTLs (milliseconds)
const CACHE_TTL = {
  active_clients:    10 * 60 * 1000,
  morning_brief:      5 * 60 * 1000,
  schedule:           3 * 60 * 1000,
  manager_schedule:   3 * 60 * 1000,
  crew_teams:        60 * 60 * 1000,   // 60 min — team rosters change rarely
  crew_load_all:      3 * 60 * 1000,   // combined endpoint — matches schedule's TTL,
                                       // the most volatile section it bundles
};

// ── Persistent offline cache (localStorage) ───────────────────
// Separate from the session cache (mg_cache_*). Survives tab close
// and browser restart so crew can open the panel on a job site
// with no signal and still see the last known schedule.
// TTL is 24 hours — stale enough to be safe, fresh enough to matter.
const PERSIST_TTL  = 24 * 60 * 60 * 1000;
const PERSIST_KEYS = {
  active_clients:   'mg_persist_clients',
  schedule:         'mg_persist_schedule',
  morning_brief:    'mg_persist_brief',
  crew_teams:       'mg_persist_crew_teams',
  manager_schedule: 'mg_persist_mgr_schedule',
};

function persistSave(action, data) {
  const key = PERSIST_KEYS[action];
  if (!key) return;
  try {
    localStorage.setItem(key, JSON.stringify({ ts: Date.now(), data }));
  } catch(e) { /* storage full — skip */ }
}

function persistClear(action) {
  const key = PERSIST_KEYS[action];
  if (key) try { localStorage.removeItem(key); } catch(e) {}
}

function persistLoad(action) {
  const key = PERSIST_KEYS[action];
  if (!key) return null;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const { ts, data } = JSON.parse(raw);
    if (Date.now() - ts > PERSIST_TTL) return null;  // too stale
    return { data, ts };
  } catch(e) { return null; }
}

// ── Offline banner ─────────────────────────────────────────────
// Shown whenever any data is served from the persistent cache.
// Injected just above the status-bar div (already in the DOM).
function showOfflineBanner(cachedAt) {
  let banner = document.getElementById('offline-banner');
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'offline-banner';
    banner.className = 'offline-banner';
    const statusBar = document.querySelector('.status-bar');
    statusBar.parentNode.insertBefore(banner, statusBar);
  }
  const when = cachedAt
    ? new Date(cachedAt).toLocaleString('en-US', { weekday:'short', month:'short', day:'numeric', hour:'numeric', minute:'2-digit' })
    : 'unknown time';
  banner.innerHTML =
    `<span class="offline-icon">&#9888;</span>` +
    `<span>No network — showing cached data from ${when}.</span>` +
    `<span class="offline-retry" onclick="reloadAll()">Retry</span>`;
}

function clearOfflineBanner() {
  const b = document.getElementById('offline-banner');
  if (b) b.remove();
}

// ── Slow-load banner ─────────────────────────────────────────────
// An Apps Script cold start (container spin-up after the deployment
// has sat idle) plus a cold CacheService entry can make the very
// first load after a long gap — e.g. logging back in after being
// timed out by session_timeout.js — take noticeably longer than
// normal, with nothing on screen to explain why. If the request is
// still running after SLOW_LOAD_MS, show a reassuring note so it
// reads as "this is normal, just wait" instead of looking hung.
// Cleared the moment the request actually finishes, however long
// it took, and never gets a chance to appear at all on a fast load
// since the timer is cancelled first.
const SLOW_LOAD_MS = 6000;
let _slowLoadTimer = null;

function showSlowLoadBanner() {
  let banner = document.getElementById('slow-load-banner');
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'slow-load-banner';
    banner.className = 'offline-banner slow-load-banner';
    const statusBar = document.querySelector('.status-bar');
    statusBar.parentNode.insertBefore(banner, statusBar);
  }
  banner.innerHTML =
    `<span class="offline-icon">&#8987;</span>` +
    `<span>Still loading — this can take longer than usual the first time after being away for a while or after a reload of Mantis database.</span>`;
}

function clearSlowLoadBanner() {
  clearTimeout(_slowLoadTimer);
  _slowLoadTimer = null;
  const b = document.getElementById('slow-load-banner');
  if (b) b.remove();
}

// Cloud Run cutover: the "still warming up" banner that used to live
// here (showWarmingBanner()/clearWarmingBanner()) was already unused
// dead code even before this cutover -- nothing ever called it. This
// backend never returns a warming placeholder in the first place (see
// apiFetch() below), so there's no reason to bring the concept back.

// ── fetchWithTimeout ──────────────────────────────────────────────
// Plain fetch() has NO built-in timeout — if a request stalls mid-
// flight (a dropped or degraded connection, common on job-site cell
// signal), the promise just sits pending forever.
// AbortController forces a stalled request to actually fail
// after TIMEOUT_MS, which lets fetchJsonWithRetry()'s existing retry
// logic below treat it exactly like any other failure instead of
// hanging forever with no recovery but a manual reload.
// Once aborted, fetchJsonWithRetry's existing retry succeeds in under a
// second across every test so far. TIME_OUT of 7s gives comfortable margin over
// every observed real response while cutting how long a dead
// connection is allowed to sit before the retry (which reliably
// works) gets a chance.
const FETCH_TIMEOUT_MS = 7000;
function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs === undefined ? FETCH_TIMEOUT_MS : timeoutMs);
  return fetch(url, { signal: controller.signal }).finally(() => clearTimeout(timer));
}

// ── fetchJsonWithRetry ──────────────────────────────────────────
// Apps Script Web Apps intermittently fail the redirect they use to
// serve /exec responses (a 302 to script.googleusercontent.com/macros/
// echo, which occasionally 404s with an HTML page instead of the real
// JSON, or — per a HAR capture of a real failure — just hangs at zero
// bytes until FETCH_TIMEOUT_MS aborts it) — a known Google-side serving
// glitch, not something this app's code controls.
//
// 2 retries (not 1) — same reasoning as owner_dashboard.js's
// _fetchJsonWithRetry: a HAR capture on this side showed the same
// stall hitting twice in a row (initial attempt AND the first retry
// both aborted at the timeout) before a third attempt succeeded
// cleanly in under a second, meaning a single retry isn't always
// enough here either. Each retry re-runs the full request, so this is
// a real tradeoff (worst case now 3x the load instead of 2x on a
// genuine failure) — accepted since the alternative is falling back to
// the stale offline cache and making the crew member notice and
// manually retry.
async function fetchJsonWithRetry(url, retries) {
  retries = retries === undefined ? 2 : retries;
  try {
    const res = await fetchWithTimeout(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch(err) {
    if (retries > 0) {
      await new Promise(resolve => setTimeout(resolve, 700));
      return fetchJsonWithRetry(url, retries - 1);
    }
    throw err;
  }
}

// apiFetch() wraps all calls to the Apps Script web app.
// Main interaction method to Apps Script code.
async function apiFetch(action, extra) {
  extra = extra || '';

  // ── sessionStorage cache ──────────────────────────────────
  const ttl = CACHE_TTL[action];
  if (ttl) {
    const cacheKey = `mg_cache_${action}${extra}`;
    const cached   = sessionStorage.getItem(cacheKey);
    if (cached) {
      try {
        const { ts, data } = JSON.parse(cached);
        if (Date.now() - ts < ttl) return data;   // still fresh
      } catch(e) { /* corrupt cache — fall through */ }
    }
  }

  // Include Google ID token for server-side verification.
  const idToken = sessionStorage.getItem('mg_id_token') || '';
  const authParam = idToken ? `&id_token=${encodeURIComponent(idToken)}` : '';

  // crew-cloud/ REST-path translation instead of Apps Script's
  // single-endpoint ?action= dispatch -- SCRIPT_URL here actually
  // holds CLOUD_RUN_URL's value (see mantis_config.js). Only two
  // actions are ever passed to apiFetch() (crew_load_all and its
  // _fresh variant) -- everything else in this app calls fetch()
  // directly and is translated at its own call site instead.
  const ACTION_PATHS = {
    crew_load_all: '/crew-load-all',
    crew_load_all_fresh: '/crew-load-all-fresh',
  };
  const path = ACTION_PATHS[action] || ('/' + action);
  // Build the query string from non-empty fragments explicitly rather
  // than concatenating pieces that each assume a leading '&' -- that
  // pattern (inherited from the original ?action= construction) only
  // works when every piece is guaranteed non-empty, which authParam
  // isn't (no id_token yet is a real, if brief, state during load).
  const queryParts = [authParam.replace(/^&/, ''), extra.replace(/^&/, ''), `_=${Date.now()}`].filter(Boolean);
  const data = await fetchJsonWithRetry(`${SCRIPT_URL}${path}?${queryParts.join('&')}`);
  if (data.error) throw new Error(data.error);

  // Store in cache. No "is this a warming placeholder" check needed
  // here anymore -- this backend always does a live fetch on a cache
  // miss (see the build doc's design decisions on why the cache-only
  // + warming-placeholder architecture was never ported), so a
  // response is always either real data or a thrown error, never a
  // known-stale placeholder worth avoiding caching.
  if (ttl) {
    try {
      sessionStorage.setItem(
        `mg_cache_${action}${extra}`,
        JSON.stringify({ ts: Date.now(), data })
      );
    } catch(e) { /* storage full — skip */ }
  }

  return data;
}

// -- fetchCrewLoadAllWithFallback --------------------------------
// crew-cloud/ simplification: the original checked a static JSON
// snapshot (published via Apps Script's GitHub-publish pipeline,
// requestCachePublish_() in Utilities.gs) before falling back to a
// live request -- a workaround for Apps Script's own serving-layer
// stalls. Cloud Run doesn't have that problem (see the build doc's
// load-test results: 100% success across every concurrency level
// tested) and has no such pipeline producing a snapshot to check for
// in the first place, so checking for one here would only ever fail
// and add a wasted round trip before falling through to the same
// live call anyway. Kept as its own named function (rather than
// inlining apiFetch() at its one call site) purely so that call site
// doesn't need to change.
async function fetchCrewLoadAllWithFallback(extra) {
  return apiFetch('crew_load_all', extra);
}


