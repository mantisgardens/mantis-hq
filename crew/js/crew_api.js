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

  const res  = await fetch(`${SCRIPT_URL}?action=${action}${authParam}${extra}&_=${Date.now()}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (data.error) throw new Error(data.error);

  // Store in cache
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

function setStatus(id, state, msg) {
  document.getElementById(`sd-${id}`).className =
    `sdot ${state === 'live' ? 'live' : state === 'loading' ? 'loading' : state === 'error' ? 'error' : ''}`;
  document.getElementById(`sl-${id}`).textContent = msg;
}

// loadAll() fires all four requests in parallel (Promise.allSettled)
// so a single slow sheet doesn't block the others.
// Loads all data (calendars, sheets)
async function loadAll() {
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

  const delay = ms => new Promise(res => setTimeout(res, ms));

  // Build parallel fetch list — manager schedule only for managers
  const fetches = [
    apiFetch('active_clients'),
    delay(300).then(() => apiFetch('schedule', '&weeks=3&offset=-1')),
    delay(600).then(() => apiFetch('morning_brief')),
    delay(900).then(() => apiFetch('crew_teams')),
    _isManager ? delay(1200).then(() => apiFetch('manager_schedule', '&weeks=3&offset=-1')) : Promise.resolve(null),
  ];

  const results = await Promise.allSettled(fetches);

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
    sheetClients = clientsData.clients || [];
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
    if (results[0].status === 'fulfilled') {
      setStatus('clients', 'live', `Clients: ${sheetClients.length} active loaded`);
    }
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
    SCHEDULE  = calData.days || {};

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

    const total = DAYS.reduce((sum, d) => {
      const day = SCHEDULE[d] || {};
      return sum + (day.t1||[]).length + (day.t2||[]).length + (day.t3||[]).length;
    }, 0);
    if (results[1].status === 'fulfilled') {
      setStatus('calendar', 'live', `Calendar: ${total} events across ${DAYS.length} days`);
      // If no days came back, show a helpful message in the status bar
      if (!DAYS.length) {
        setStatus('calendar', 'error', 'Calendar: connected but no events returned — check script timezone and calendar permissions');
      }
    }
    updateWeekLabel();
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
    morningBrief = briefData;
    if (results[2].status === 'fulfilled') {
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

  // ── Crew teams (silent — no status pill) ──
  const teamsData = results[3] && results[3].status === 'fulfilled'
    ? results[3].value
    : (persistLoad('crew_teams') || {}).data || null;

  if (teamsData) {
    if (results[3] && results[3].status === 'fulfilled') persistSave('crew_teams', teamsData);
    crewTeams = teamsData;
    // Rebuild crew datalist now that we have names
    const dl = document.getElementById('dl-crew-global');
    if (dl) {
      dl.innerHTML = '';
      const allNames = [...(crewTeams.t1||[]), ...(crewTeams.t2||[]), ...(crewTeams.t3||[])];
      allNames.forEach(name => {
        const opt = document.createElement('option');
        opt.value = name;
        dl.appendChild(opt);
      });
    }
  }

  // ── Manager schedule (managers only) ─────────────────────
  const mgrResult = results[4];
  if (_isManager && mgrResult) {
    const mgrData = mgrResult.status === 'fulfilled'
      ? mgrResult.value
      : (persistLoad('manager_schedule') || {}).data || null;

    if (mgrData) {
      if (mgrResult.status === 'fulfilled') persistSave('manager_schedule', mgrData);
      MANAGER_SCHEDULE = mgrData;
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
    const calResult = results[3];
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


