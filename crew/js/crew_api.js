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
// Per-action overrides for data that changes frequently enough that
// the 24h default would serve visibly stale content. Morning brief
// specifically: the Owner Portal invalidates the server-side cache
// whenever notes are saved, but the browser's localStorage copy
// bypasses that entirely on a plain refresh. Matching the server's
// own 20-minute TTL (src/config.js CACHE_TTL.morning_brief) means
// the local copy never outlives what the server would serve anyway.
const PERSIST_TTL_OVERRIDES = {
  morning_brief: 20 * 60 * 1000,  // 20 min -- matches server CACHE_TTL.morning_brief
};
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
  const ttl = PERSIST_TTL_OVERRIDES[action] || PERSIST_TTL;
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
    const ttl = PERSIST_TTL_OVERRIDES[action] || PERSIST_TTL;
    if (Date.now() - ts > ttl) return null;  // too stale
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

function setStatus(id, state, msg) {
  document.getElementById(`sd-${id}`).className =
    `sdot ${state === 'live' ? 'live' : state === 'loading' ? 'loading' : state === 'error' ? 'error' : ''}`;
  document.getElementById(`sl-${id}`).textContent = msg;
}

// -- Apply-data helpers --------------------------------------------
// Each takes a raw section payload -- same shape whether it came from a
// fresh network response or the 24-hour offline snapshot (useOffline()
// below, used only when the network call actually fails) -- and updates
// the corresponding global state (+ status pill, when opts.live is
// set). Pulled out of loadAll()'s inline per-section handling just to
// keep that function shorter; each section's data-shape logic lives in
// exactly one place either way.
function applyClientsData(data, opts) {
  opts = opts || {};
  sheetClients = data.clients || [];
  clientCache  = {};
  sheetClients.forEach(c => {
    const name = (c['Name(s)'] || '').toLowerCase();
    // Index by all words including short ones like "Rae"
    name.split(/[\s,&()+\-\/]+/).filter(w => w.length > 1)
      .forEach(w => {
        if (!clientCache[w]) clientCache[w] = [];
        clientCache[w].push(c);
      });
    // Also index by last name (first word before comma) with a "last:" prefix
    // for stronger matching -- avoids false positives from common words
    const lastName = name.split(',')[0].trim().split(/[\s\-]+/)[0];
    if (lastName && lastName.length > 1) {
      const key = 'last:' + lastName;
      if (!clientCache[key]) clientCache[key] = [];
      clientCache[key].push(c);
    }
  });
  if (opts.live) setStatus('clients', 'live', `Clients: ${sheetClients.length} active loaded`);
}

function applyScheduleData(data, opts) {
  opts = opts || {};
  SCHEDULE  = data.days || {};

  // Build sorted day list
  DAYS      = Object.keys(SCHEDULE).sort();
  DAY_LABELS = DAYS.map(d => {
    const dt = new Date(d + 'T12:00:00');
    return dt.toLocaleDateString('en-US', { weekday:'short', month:'short', day:'numeric' });
  });

  // Snap to today if in the window.
  // On Sunday, jump straight to next Monday so last week isn't prominent.
  // Otherwise snap to the nearest future day, else the first available day.
  const todayKey = todayDateKey();
  const isSunday = new Date().getDay() === 0;
  if (!isSunday && DAYS.includes(todayKey)) {
    currentDay = todayKey;
  } else if (isSunday) {
    // Find the Monday immediately following today
    const nextMonday = new Date();
    nextMonday.setDate(nextMonday.getDate() + 1);  // Sunday + 1 = Monday
    const nextMondayKey = `${nextMonday.getFullYear()}-${String(nextMonday.getMonth()+1).padStart(2,'0')}-${String(nextMonday.getDate()).padStart(2,'0')}`;
    const future = DAYS.find(d => d >= nextMondayKey);
    currentDay = future || DAYS[0] || null;
  } else {
    // Find nearest day >= today
    const future = DAYS.find(d => d >= todayKey);
    currentDay = future || DAYS[0] || null;
  }

  if (opts.live) {
    const total = DAYS.reduce((sum, d) => {
      const day = SCHEDULE[d] || {};
      return sum + (day.t1||[]).length + (day.t2||[]).length + (day.t3||[]).length + (day.tInstall||[]).length;
    }, 0);
    setStatus('calendar', 'live', `Calendar: ${total} events across ${DAYS.length} days`);
    // If no days came back, show a helpful message in the status bar
    if (!DAYS.length) {
      setStatus('calendar', 'error', 'Calendar: connected but no events returned -- check script timezone and calendar permissions');
    }
  }
  updateWeekLabel();
}

function applyMorningBriefData(data, opts) {
  opts = opts || {};
  morningBrief = data;
  if (opts.live) {
    const ac  = morningBrief.all_crew || {};
    const dbg = morningBrief._debug || {};
    const parts = [];
    if ((ac.birthdays||[]).length)     parts.push(`${ac.birthdays.length} birthday${ac.birthdays.length > 1 ? 's' : ''}`);
    if ((ac.time_off||[]).length)       parts.push(`${ac.time_off.length} time off`);
    if ((ac.special_events||[]).length) parts.push(`${ac.special_events.length} event${ac.special_events.length > 1 ? 's' : ''}`);
    if (dbg.bdayError)                  parts.push(`birthdays: ${dbg.bdayError}`);
    const detail = parts.length ? ' -- ' + parts.join(', ') : '';
    setStatus('brief', 'live', `Morning brief: loaded${detail}`);
  }
}

function applyCrewTeamsData(data) {
  crewTeams = data;
  // Rebuild crew datalist now that we have names
  const dl = document.getElementById('dl-crew-global');
  if (dl) {
    dl.innerHTML = '';
    const allNames = [...(crewTeams.t1||[]), ...(crewTeams.t2||[]), ...(crewTeams.t3||[]), ...(crewTeams.tInstall||[])];
    allNames.forEach(name => {
      const opt = document.createElement('option');
      opt.value = name;
      dl.appendChild(opt);
    });
  }
}

function applyManagerScheduleData(data) {
  MANAGER_SCHEDULE = data;
}

// loadAll() fires ONE combined request (crew_load_all / crew_load_all_fresh)
// so the crew panel's initial load and manual reload are each a single
// round trip rather than four or five separate ones.
async function loadAll(forceFresh) {
  document.getElementById('reload-btn').disabled = true;
  // Re-show status pills during reload so crew can see progress
  document.querySelectorAll('.status-pill').forEach(p => p.style.display = '');
  setStatus('clients',  'loading', 'Clients: loading...');
  setStatus('brief',    'loading', 'Morning brief: loading...');
  setStatus('calendar', 'loading', 'Calendar: loading...');

  // -- Show/hide Managers tab based on role --------------------
  // Done early so the tab appears/disappears before data loads.
  const _isManager = isManagerUser();
  const _mgrTab    = document.getElementById('ttab-managers');
  if (_mgrTab) _mgrTab.style.display = _isManager ? '' : 'none';

  // -- Single combined fetch ------------------------------------
  // Ask for manager_schedule only when it'll actually be used.
  let bundle = null, bundleErr = null;
  _slowLoadTimer = setTimeout(showSlowLoadBanner, SLOW_LOAD_MS);
  try {
    const mgrExtra = _isManager ? '&mgr=1' : '';
    bundle = forceFresh
      ? await apiFetch('crew_load_all_fresh', mgrExtra)
      : await fetchCrewLoadAllWithFallback(mgrExtra);
  } catch(e) { bundleErr = e; }
  clearSlowLoadBanner();

  // Reconstruct the per-section {status, value|reason} shape the rest
  // of this function expects. A section-level {error: '...'} from the
  // backend (one sheet/calendar failed) or a hard network failure
  // (bundleErr) both surface as 'rejected'.
  function toResult(section) {
    if (bundleErr) return { status: 'rejected', reason: bundleErr };
    const val = bundle ? bundle[section] : undefined;
    if (val && val.error) return { status: 'rejected', reason: new Error(val.error) };
    return { status: 'fulfilled', value: val === undefined ? null : val };
  }

  const results = [
    toResult('active_clients'),
    toResult('schedule'),
    toResult('morning_brief'),
    toResult('crew_teams'),
    _isManager ? toResult('manager_schedule') : { status: 'fulfilled', value: null },
  ];

  // -- Track which items fell back to offline cache --------------
  let offlineCacheTs = null;   // timestamp of oldest stale item used

  function useOffline(action, staleResult, label) {
    const persisted = persistLoad(action);
    if (persisted) {
      if (!offlineCacheTs || persisted.ts < offlineCacheTs) offlineCacheTs = persisted.ts;
      setStatus(label, 'loading', `${label.charAt(0).toUpperCase() + label.slice(1)}: cached`);
      return persisted.data;
    }
    setStatus(label, 'error', `${label.charAt(0).toUpperCase() + label.slice(1)}: ${staleResult.reason && staleResult.reason.message}`);
    return null;
  }

  // -- Clients --
  const clientsData = results[0].status === 'fulfilled'
    ? results[0].value
    : useOffline('active_clients', results[0], 'clients');

  if (clientsData) {
    if (results[0].status === 'fulfilled') persistSave('active_clients', clientsData);
    applyClientsData(clientsData, { live: results[0].status === 'fulfilled' });
  }

  // -- Calendar / Schedule --
  const calData = results[1].status === 'fulfilled'
    ? results[1].value
    : useOffline('schedule', results[1], 'calendar');

  if (calData) {
    if (results[1].status === 'fulfilled') {
      // Clear any old persist entry before saving the new window
      // (old entries may cover a different date range)
      persistClear('schedule');
      persistSave('schedule', calData);
    }
    applyScheduleData(calData, { live: results[1].status === 'fulfilled' });
  } else {
    SCHEDULE   = {};
    DAYS       = [];
    DAY_LABELS = [];
    currentDay = null;
  }

  // -- Morning brief --
  const briefData = results[2].status === 'fulfilled'
    ? results[2].value
    : useOffline('morning_brief', results[2], 'brief');

  if (briefData) {
    if (results[2].status === 'fulfilled') persistSave('morning_brief', briefData);
    applyMorningBriefData(briefData, { live: results[2].status === 'fulfilled' });
  }

  // -- Crew teams (silent -- no status pill) --
  const teamsData = results[3] && results[3].status === 'fulfilled'
    ? results[3].value
    : (persistLoad('crew_teams') || {}).data || null;

  if (teamsData) {
    if (results[3] && results[3].status === 'fulfilled') persistSave('crew_teams', teamsData);
    applyCrewTeamsData(teamsData);
  }

  // -- Manager schedule (managers only) -----------------------
  const mgrResult = results[4];
  if (_isManager && mgrResult) {
    const mgrData = mgrResult.status === 'fulfilled'
      ? mgrResult.value
      : (persistLoad('manager_schedule') || {}).data || null;

    if (mgrData) {
      if (mgrResult.status === 'fulfilled') persistSave('manager_schedule', mgrData);
      applyManagerScheduleData(mgrData);
    }
  }

  // -- Offline banner ----------------------------------------------
  if (offlineCacheTs) {
    showOfflineBanner(offlineCacheTs);
  } else {
    clearOfflineBanner();
  }

  document.getElementById('reload-btn').disabled = false;

  // -- Hide status pills when all loaded successfully --------------
  // The reload button always stays visible so crew can force-refresh
  // if David updates the calendar early morning.
  // If any pill has an error, all pills stay visible.
  setTimeout(() => {
    const dots   = document.querySelectorAll('.sdot');
    const allLive = Array.from(dots).every(d => d.classList.contains('live'));
    document.querySelectorAll('.status-pill').forEach(p => {
      p.style.display = allLive ? 'none' : '';
    });
  }, 800);

  // -- Debug panel (set display:none -> block on the div to enable) --
  const dbg = document.getElementById('debug-panel');
  if (dbg && dbg.style.display !== 'none') {
    const calResult = results[1];
    const calVal    = calResult.status === 'fulfilled' ? calResult.value : null;
    dbg.innerHTML =
      `<b>Calendar status:</b> ${calResult.status}<br>` +
      `<b>DAYS.length:</b> ${DAYS.length}<br>` +
      `<b>currentDay:</b> ${currentDay}<br>` +
      `<b>SCHEDULE keys:</b> ${Object.keys(SCHEDULE).join(', ') || 'none'}<br>` +
      (calVal ? `<b>window_start:</b> ${calVal.window_start || '?'} &nbsp; <b>window_end:</b> ${calVal.window_end || '?'}<br>` : '') +
      (calResult.status === 'rejected' ? `<b>Error:</b> ${calResult.reason.message}` : '') +
      `<b>Clients:</b> ${sheetClients.length}<br>` +
      `<b>MorningBrief:</b> ${morningBrief ? 'loaded' : 'null'}`;
    dbg.style.display = 'block';
  }

  render();
}
