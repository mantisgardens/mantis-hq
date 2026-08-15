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

// ── "Still warming up" banner ────────────────────────────────────
// Shown when the backend returned valid-but-empty placeholder data
// because its cache was cold and this request didn't force a live
// fetch (see the matching "Cache-only mode" note in Schedule.gs's
// getSchedule()). Should be rare and short-lived — the prewarmCache
// trigger refreshes the cache every 5 minutes — but worth explaining
// rather than leaving a crew member wondering why their schedule
// looks empty.
function showWarmingBanner() {
  let banner = document.getElementById('warming-banner');
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'warming-banner';
    banner.className = 'offline-banner';
    const statusBar = document.querySelector('.status-bar');
    statusBar.parentNode.insertBefore(banner, statusBar);
  }
  banner.innerHTML =
    `<span class="offline-icon">&#8987;</span>` +
    `<span>Data is still warming up — this refreshes automatically every few minutes.</span>` +
    `<span class="offline-retry" onclick="reloadAll()">Reload now</span>`;
}

function clearWarmingBanner() {
  const b = document.getElementById('warming-banner');
  if (b) b.remove();
}

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

  const data = await fetchJsonWithRetry(`${SCRIPT_URL}?action=${action}${authParam}${extra}&_=${Date.now()}`);
  if (data.error) throw new Error(data.error);

  // Don't cache a "still warming up" result — see Schedule.gs's
  // getSchedule() and loadAll() below for what that means. It's
  // known-stale placeholder data; caching it client-side would just
  // delay picking up the real data once the server-side cache
  // populates a moment later (up to this action's own TTL, e.g. 3
  // minutes for crew_load_all — comparable to the ~5 minute prewarm
  // trigger interval, so skipping this would meaningfully extend how
  // long a placeholder could linger instead of showing real data).
  const isWarmingResult = data && typeof data === 'object' &&
    ['active_clients','schedule','morning_brief','crew_teams'].some(k => data[k] && data[k].warming);

  // Store in cache
  if (ttl && !isWarmingResult) {
    try {
      sessionStorage.setItem(
        `mg_cache_${action}${extra}`,
        JSON.stringify({ ts: Date.now(), data })
      );
    } catch(e) { /* storage full — skip */ }
  }

  return data;
}

// ── fetchCrewLoadAllWithFallback ──────────────────────────────
// Apps Script's own serving path (script.google.com → redirect to
// script.googleusercontent.com/macros/echo) is the one that's been
// stalling — see the FETCH_TIMEOUT_MS comment above for the full HAR
// evidence. This bypasses that path entirely for the ordinary
// (non-forceFresh) load: Apps Script event-driven-publishes a static
// snapshot of crew_load_all's data as a plain JSON file into the same
// repo (see requestCachePublish_() in Utilities.gs), served by GitHub
// Pages from the same origin as this page — so fetch() never touches
// script.google.com at all for this call, and never hits the redirect
// that's been the actual source of every stall we've captured.
//
// Falls back to the normal apiFetch('crew_load_all', ...) path (with
// its own timeout/retry) on ANY failure — missing file, stale/failed
// deploy, network error, doesn't matter. Returns the exact same bundle
// shape either way, so nothing downstream in loadAll() needs to know
// or care which path actually supplied the data. That makes this
// strictly additive: when the static file is there, it's fast; when
// it isn't (or is failing) for whatever reason, behavior is identical
// to before this existed.
//
// A short timeout (well under FETCH_TIMEOUT_MS) is deliberate — a
// same-origin static file on GitHub Pages' CDN should resolve in well
// under a second when it's working at all; there's no legitimate slow
// case here to wait out, only "works fast" or "doesn't work," so this
// should fail over to the live path quickly rather than eating into
// the crew member's wait before the real fallback even starts.
const STATIC_CACHE_URL      = 'data/crew_load_all.json';
const STATIC_CACHE_TIMEOUT_MS = 4000;

async function fetchCrewLoadAllWithFallback(extra) {
  try {
    const res = await fetchWithTimeout(`${STATIC_CACHE_URL}?_=${Date.now()}`, STATIC_CACHE_TIMEOUT_MS);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!data || typeof data !== 'object') throw new Error('Malformed static cache payload');
    // Visible confirmation the static path actually served this load —
    // useful while we're still verifying this in the field. Remove
    // once confident, or gate behind a debug flag if it turns out to
    // be more noise than signal for daily crew use.
    if (typeof showToast === 'function') showToast('Loaded from GitHub cache');
    return data;
  } catch(err) {
    console.warn('Static cache fetch failed, falling back to live request:', err.message);
    return apiFetch('crew_load_all', extra);
  }
}

function setStatus(id, state, msg) {
  document.getElementById(`sd-${id}`).className =
    `sdot ${state === 'live' ? 'live' : state === 'loading' ? 'loading' : state === 'error' ? 'error' : ''}`;
  document.getElementById(`sl-${id}`).textContent = msg;
}

// ── Apply-data helpers ──────────────────────────────────────────
// Each takes a raw section payload — same shape whether it came from a
// fresh network response or the 24-hour offline snapshot (useOffline()
// below, used only when the network call actually fails) — and updates
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
    // for stronger matching — avoids false positives from common words
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
      setStatus('calendar', 'error', 'Calendar: connected but no events returned — check script timezone and calendar permissions');
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
    if (dbg.bdayError)                  parts.push(`⚠ birthdays: ${dbg.bdayError}`);
    const detail = parts.length ? ' — ' + parts.join(', ') : '';
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

// loadAll() fires ONE combined request (action=crew_load_all) so the
// crew panel's initial load pays the Apps Script per-request dispatch
// overhead once instead of four or five times. The backend splits the
// work into named sections (active_clients / schedule / morning_brief /
// crew_teams / manager_schedule) and we reconstruct the same
// {status, value|reason} shape Promise.allSettled used to give us, so
// none of the per-section handling below had to change.
// Loads all data (calendars, sheets). forceFresh=true (used by the
// "Reload Database" button) calls crew_load_all_fresh instead of the
// normal crew_load_all — see Utilities.gs's doGet for what that
// changes server-side. Every other line below behaves identically
// either way; the two actions return the same shape, just one always
// forces a live fetch and the other reads the cache as-is.
async function loadAll(forceFresh) {
  document.getElementById('reload-btn').disabled = true;
  // Re-show status pills during reload so crew can see progress
  document.querySelectorAll('.status-pill').forEach(p => p.style.display = '');
  setStatus('clients',  'loading', 'Clients: loading...');
  setStatus('brief',    'loading', 'Morning brief: loading...');
  setStatus('calendar', 'loading', 'Calendar: loading...');

  // ── Show/hide Managers tab based on role ─────────────────
  // Done early so the tab appears/disappears before data loads.
  const _isManager = isManagerUser();
  const _mgrTab    = document.getElementById('ttab-managers');
  if (_mgrTab) _mgrTab.style.display = _isManager ? '' : 'none';

  // ── Single combined fetch ──────────────────────────────────
  // Ask for manager_schedule only when it'll actually be used.
  // forceFresh (the "Reload Database" button) always goes through the
  // live apiFetch path, since it's explicitly asking for a fresh
  // Calendar/Sheets read — the static file can't serve that. The
  // normal load tries the static cache file first; see
  // fetchCrewLoadAllWithFallback()'s comment for why.
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
  // (bundleErr) both surface as 'rejected', same as before.
  //
  // A "still warming up" placeholder (val.warming === true — a cold
  // cache under the cache-only architecture, see getSchedule()'s
  // "Cache-only mode" comment in Schedule.gs) is ALSO treated as
  // 'rejected' here, deliberately — not because it's an error, but so
  // it automatically routes through the exact same per-section
  // fallback logic below as a real failure: fall back to the 24-hour
  // offline snapshot (persistLoad) if one exists, and — critically —
  // skip persistSave() for it. An earlier version of this let a
  // warming result fall through as 'fulfilled', which overwrote
  // sheetClients/SCHEDULE/morningBrief/crewTeams/MANAGER_SCHEDULE with
  // empty data on every warming event, AND persisted that empty
  // placeholder into the 24-hour offline cache — silently destroying a
  // crew member's last good offline snapshot. If they then actually
  // lost signal, the "offline" fallback would have shown nothing
  // instead of their last real data, defeating the whole point of it.
  function toResult(section) {
    if (bundleErr) return { status: 'rejected', reason: bundleErr };
    const val = bundle ? bundle[section] : undefined;
    if (val && val.error) return { status: 'rejected', reason: new Error(val.error) };
    if (val && val.warming) return { status: 'rejected', reason: new Error('Still warming up') };
    return { status: 'fulfilled', value: val === undefined ? null : val };
  }

  // ── "Still warming up" banner ──────────────────────────────────
  // Read directly off the raw bundle (not the results[] built from
  // toResult() below) since toResult() already folds warming sections
  // into 'rejected' for the fallback logic — this just needs to know
  // whether ANY section was warming, to show the explanatory banner.
  const isWarming = !bundleErr && bundle && ['active_clients','schedule','morning_brief','crew_teams']
    .some(k => bundle[k] && bundle[k].warming);
  if (isWarming) showWarmingBanner(); else clearWarmingBanner();

  const results = [
    toResult('active_clients'),
    toResult('schedule'),
    toResult('morning_brief'),
    toResult('crew_teams'),
    _isManager ? toResult('manager_schedule') : { status: 'fulfilled', value: null },
  ];

  // ── Track which items fell back to offline cache ──────────────
  let offlineCacheTs = null;   // timestamp of oldest stale item used

  function useOffline(action, staleResult, label) {
    const persisted = persistLoad(action);
    if (persisted) {
      if (!offlineCacheTs || persisted.ts < offlineCacheTs) offlineCacheTs = persisted.ts;
      setStatus(label, 'loading', `${label.charAt(0).toUpperCase() + label.slice(1)}: cached ↙`);
      return persisted.data;
    }
    setStatus(label, 'error', `${label.charAt(0).toUpperCase() + label.slice(1)}: ${staleResult.reason && staleResult.reason.message}`);
    return null;
  }

  // ── Clients ──
  const clientsData = results[0].status === 'fulfilled'
    ? results[0].value
    : useOffline('active_clients', results[0], 'clients');

  if (clientsData) {
    if (results[0].status === 'fulfilled') persistSave('active_clients', clientsData);
    applyClientsData(clientsData, { live: results[0].status === 'fulfilled' });
  }

  // ── Calendar / Schedule ──
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

  // ── Morning brief ──
  const briefData = results[2].status === 'fulfilled'
    ? results[2].value
    : useOffline('morning_brief', results[2], 'brief');

  if (briefData) {
    if (results[2].status === 'fulfilled') persistSave('morning_brief', briefData);
    applyMorningBriefData(briefData, { live: results[2].status === 'fulfilled' });
  }

  // ── Crew teams (silent — no status pill) ──
  const teamsData = results[3] && results[3].status === 'fulfilled'
    ? results[3].value
    : (persistLoad('crew_teams') || {}).data || null;

  if (teamsData) {
    if (results[3] && results[3].status === 'fulfilled') persistSave('crew_teams', teamsData);
    applyCrewTeamsData(teamsData);
  }

  // ── Manager schedule (managers only) ─────────────────────
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

  // ── Offline banner ────────────────────────────────────────────
  if (offlineCacheTs) {
    showOfflineBanner(offlineCacheTs);
  } else {
    clearOfflineBanner();
  }

  document.getElementById('reload-btn').disabled = false;

  // ── Hide status pills when all loaded successfully ────────────
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

  // ── Debug panel (set display:none -> block on the div to enable) ──
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


