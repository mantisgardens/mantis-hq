/* =============================================================
   mantis_crew_panel.js
   BUILD: checklist-no-spinner
   Mantis Gardens — Crew Assignment Panel
   
   Sections:
     1.  Configuration  (SCRIPT_URL, KEY, calendar IDs)
     2.  Schedule Data  (DAYS, DAY_LABELS, SCHEDULE object)
     3.  Application State  (currentDay, expanded, statuses, etc.)
     4.  API Layer  (apiFetch, setStatus, loadAll)
     5.  Date Helpers  (todayDateKey, isToday, updateWeekLabel, shiftWeek)
     6.  Client Matching  (findClient, clientCache)
     7.  HTML Escaping  (esc utility)
     8.  Morning Brief Rendering  (renderBrief, toggleBrief)
     9.  Job Card Rendering  (renderJobs, typeTag, statusIcon, calcHrs)
     10. Day Tabs & Main Render  (buildTabs, render, toggle, setSt)
     11. Startup  (currentDay init, loadAll call)
     12. Work Record Form  (openWorkRecord, closeModal)
     13. Workers  (addWorker)
     14. Materials  (addMaterial, COMMON_MATERIALS)
     15. Photos  (handlePhotos)
     16. Form Actions  (collectFormData, saveForm, submitForm, clearForm)
     17. Toast Notification  (showToast)
   ============================================================= */

// =============================================================
// SECTION 1 — CONFIGURATION
// Edit SCRIPT_URL after each Apps Script redeployment.
// KEY must match the SECRET constant in the Apps Script.
// =============================================================
// Read from mantis_config.js — edit that file to update the URL
const SCRIPT_URL = (typeof MANTIS_CONFIG !== 'undefined') ? MANTIS_CONFIG.SCRIPT_URL : "PASTE_YOUR_EXEC_URL_HERE";
const KEY        = (typeof MANTIS_CONFIG !== 'undefined') ? (MANTIS_CONFIG.KEY || '') : '';  // legacy — no longer used


// =============================================================
// SECTION 3 — APPLICATION STATE
// All mutable state lives here. Mutate only via setSt(),
// toggle(), or the loadAll() handlers.
// =============================================================
// ── State ─────────────────────────────────────────────────────
let SCHEDULE     = {};          // populated from Google Calendar via Apps Script

// =============================================================
// SECTION 2 — SCHEDULE DATA
// DAYS, DAY_LABELS, and SCHEDULE are populated at runtime by
// the Apps Script ?action=schedule call. They start empty and
// are filled in loadAll() when the page first opens.
// =============================================================
let DAYS         = [];          // sorted date keys e.g. ["2026-04-16", ...]
let activeTeam   = 't1';       // currently visible team tab
let DAY_LABELS   = [];          // display labels e.g. ["Thu Apr 16", ...]
let currentDay   = null;

// getUserTeamSlug() reads mg_user_category from sessionStorage at call time
// (not at parse time) so it's always evaluated after login has completed.
// Managers get null (all panels unlocked). Unknown category also returns null
// (fail open — better than accidentally locking out a valid user).
function getUserTeamSlug() {
  const cat = (sessionStorage.getItem('mg_user_category')
            || localStorage.getItem('mg_user_category') || '').toLowerCase();
  if (!cat || cat.includes('manager')) return null;
  if (cat.includes('team 1'))  return 't1';
  if (cat.includes('team 2'))  return 't2';
  if (cat.includes('team 3'))  return 't3';
  if (cat.includes('install')) return 'install';
  return null;
}

let expanded     = {}, statuses = {}, briefOpen = { t1:true, t2:true, install:true };
let clientCache  = {}, sheetClients = [], morningBrief = null;
let crewTeams    = { t1: [], t2: [], t3: [] };  // team rosters from Crew Info sheet


// =============================================================
// SECTION 4 — API LAYER
// apiFetch() wraps all calls to the Apps Script web app.
// loadAll() fires all four requests in parallel (Promise.allSettled)
// so a single slow sheet doesn't block the others.
// =============================================================
// ── API ───────────────────────────────────────────────────────
// Cache TTLs (milliseconds)
const CACHE_TTL = {
  active_clients:   10 * 60 * 1000,
  morning_brief:     5 * 60 * 1000,
  schedule:          3 * 60 * 1000,
  crew_teams:       60 * 60 * 1000,   // 60 min — team rosters change rarely
};

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
  // Falls back to legacy key if no token (e.g. local dev).
  const idToken = sessionStorage.getItem('mg_id_token') || '';
  const authParam = idToken
    ? `&id_token=${encodeURIComponent(idToken)}`
    : `&key=${encodeURIComponent(KEY)}`;

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

async function loadAll() {
  document.getElementById('reload-btn').disabled = true;
  // Re-show status pills during reload so crew can see progress
  document.querySelectorAll('.status-pill').forEach(p => p.style.display = '');
  setStatus('clients',  'loading', 'Clients: loading...');
  setStatus('brief',    'loading', 'Morning brief: loading...');
  setStatus('calendar', 'loading', 'Calendar: loading...');



  const delay = ms => new Promise(res => setTimeout(res, ms));
  const results = await Promise.allSettled([
    apiFetch('active_clients'),
    delay(300).then(() => apiFetch('schedule', '&weeks=2')),
    delay(600).then(() => apiFetch('morning_brief')),
    delay(900).then(() => apiFetch('crew_teams')),
  ]);

  // ── Clients ──
  if (results[0].status === 'fulfilled') {
    sheetClients = results[0].value.clients || [];
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
    setStatus('clients', 'live', `Clients: ${sheetClients.length} active loaded`);
  } else {
    setStatus('clients', 'error', `Clients: ${results[0].reason.message}`);
  }

  // ── Calendar / Schedule ──
  if (results[1].status === 'fulfilled') {
    const cal = results[1].value;
    SCHEDULE  = cal.days || {};

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
    setStatus('calendar', 'live', `Calendar: ${total} events across ${DAYS.length} days`);
    updateWeekLabel();

    // If no days came back, show a helpful message in the status bar
    if (!DAYS.length) {
      setStatus('calendar', 'error', 'Calendar: connected but no events returned — check script timezone and calendar permissions');
    }
  } else {
    setStatus('calendar', 'error', `Calendar: ${results[1].reason.message}`);
    SCHEDULE   = {};
    DAYS       = [];
    DAY_LABELS = [];
    currentDay = null;
  }

  // ── Morning brief ──
  if (results[2].status === 'fulfilled') {
    morningBrief = results[2].value;
    const ac  = morningBrief.all_crew || {};
    const dbg = morningBrief._debug || {};
    const parts = [];
    if ((ac.birthdays||[]).length)     parts.push(`${ac.birthdays.length} birthday${ac.birthdays.length > 1 ? 's' : ''}`);
    if ((ac.time_off||[]).length)       parts.push(`${ac.time_off.length} time off`);
    if ((ac.special_events||[]).length) parts.push(`${ac.special_events.length} event${ac.special_events.length > 1 ? 's' : ''}`);
    if (dbg.bdayError)                  parts.push(`⚠ birthdays: ${dbg.bdayError}`);
    const detail = parts.length ? ' — ' + parts.join(', ') : '';
    setStatus('brief', 'live', `Morning brief: loaded${detail}`);
  } else {
    setStatus('brief', 'error', `Morning brief: ${results[2].reason && results[2].reason.message}`);
  }

  // ── Crew teams (silent — no status pill) ──
  if (results[3] && results[3].status === 'fulfilled') {
    crewTeams = results[3].value;
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


// =============================================================
// SECTION 5 — DATE HELPERS
// todayDateKey()    → "YYYY-MM-DD" for today
// isToday(key)      → boolean
// updateWeekLabel() → sets the header "Week of ..." text
// shiftWeek(dir)    → navigate prev/next week by ±5 weekdays
// =============================================================
// ── Date helpers ──────────────────────────────────────────────
function todayDateKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function isToday(dateKey) {
  return dateKey === todayDateKey();
}

function updateWeekLabel() {
  if (!DAYS.length || !currentDay) {
    document.getElementById('week-label').textContent = 'No events found';
    return;
  }
  const d      = new Date(currentDay + 'T12:00:00');
  const dow    = d.getDay();
  const monday = new Date(d);
  monday.setDate(d.getDate() - (dow === 0 ? 6 : dow - 1));
  const label  = monday.toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' });
  document.getElementById('week-label').textContent = 'Week of ' + label;
}

function shiftWeek(dir) {
  if (!DAYS.length) return;

  // Find the Monday of the current week, then jump ±7 days to get
  // the Monday of the target week — works regardless of how many
  // event days exist in each week.
  const cur = new Date(currentDay + 'T12:00:00');
  const dow = cur.getDay();
  const monday = new Date(cur);
  monday.setDate(cur.getDate() - (dow === 0 ? 6 : dow - 1));
  monday.setDate(monday.getDate() + (dir * 7));

  // Build the date key for Monday of the target week, then find
  // the first DAYS entry that falls within that Mon–Fri window.
  const weekKeys = [];
  for (let i = 0; i < 5; i++) {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    weekKeys.push(`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`);
  }
  const found = DAYS.find(d => weekKeys.includes(d));
  if (!found) return;  // no events that week — don't navigate

  currentDay = found;
  updateWeekLabel();
  render();  // render() handles scrollIntoView internally
}


// =============================================================
// SECTION 6 — CLIENT MATCHING
// findClient(name) does a fuzzy word-score match between the
// calendar event title and client names from Google Sheets.
// clientCache is a word-indexed lookup built in loadAll().
// =============================================================
// ── Client matching ───────────────────────────────────────────
function findClient(name) {
  if (!sheetClients.length) return null;
  const lower = name.toLowerCase();
  const words  = lower.split(/[\s,&()+\-\/]+/).filter(w => w.length > 1);
  const scores = new Map();

  words.forEach(w => {
    // Regular word match — score 1
    (clientCache[w] || []).forEach(c => scores.set(c, (scores.get(c)||0) + 1));
    // Last-name match — score 3 (much stronger signal)
    (clientCache['last:' + w] || []).forEach(c => scores.set(c, (scores.get(c)||0) + 3));
  });

  if (!scores.size) {
    console.log('[findClient] no scores for:', name, '| words:', words);
    return null;
  }
  let best = null, top = 0;
  scores.forEach((s, c) => { if (s > top) { top = s; best = c; } });
  if (top < 1) {
    console.log('[findClient] no match for:', name, '| words:', words, '| top score:', top);
    return null;
  }
  //console.log('[findClient]', name, '→', best['Name(s)'], '(score:', top, ')');
  return best;
}


// =============================================================
// SECTION 7 — HTML ESCAPING UTILITY
// esc() must be called on every piece of user/sheet data
// before inserting into innerHTML to prevent XSS.
// =============================================================
// ── HTML escaping ─────────────────────────────────────────────
function esc(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}


// =============================================================
// SECTION 8 — MORNING BRIEF RENDERING
// renderBrief(wrapId, team) builds the morning brief panel for each
// team column. Uses morningBrief data (from getMorningBrief()) for
// team-specific notes and the shared all-crew section (time off,
// birthdays, special events). toggleBrief() flips open/closed state.
// =============================================================
// ── Morning Brief ─────────────────────────────────────────────
function renderBrief(wrapId, team) {
  const wrap   = document.getElementById(wrapId);
  if (!wrap) return;
  const isOpen = briefOpen[team];
  let body     = '';

  if (!morningBrief) {
    body = '<div class="brief-empty">Click &#8635; Load all sheets to load the morning brief.</div>';

  } else {
    const mb = morningBrief;

    // ── Date header ──
    if (mb.date) {
      body += `<div class="bsec"><div class="bsec-label">${esc(mb.date)}</div></div>`;
    }

    // ── Team-specific notes ───────────────────────────────────
    let teamNotes  = [];
    let teamLabel  = '';
    if      (team === 't1')      { teamNotes = mb.team1_notes   || []; teamLabel = 'Team 1'; }
    else if (team === 't2')      { teamNotes = mb.team2_notes   || []; teamLabel = 'Team 2'; }
    else if (team === 'install') { teamNotes = mb.install_notes  || []; teamLabel = 'Install'; }
    else if (team === 'install') { teamNotes = mb.install_notes || []; teamLabel = 'Install'; }

    if (teamNotes.length) {
      body += `<div class="bsec bsec-team"><div class="bsec-label">${esc(teamLabel)}</div>`;
      teamNotes.forEach(sec => {
        if (sec.title) body += `<div class="bsec-sublabel">${esc(sec.title)}</div>`;
        (sec.items || []).forEach(item => {
          body += `<div class="note-item">&#8226; ${esc(item)}</div>`;
        });
      });
      body += `</div>`;
    }

    // ── Role-based notes (Managers or Leads only) ────────────
    // Read the logged-in user's category and role from sessionStorage,
    // set during login. Managers see manager_notes. Leads see their
    // column of lead_notes (one column per team in the sheet).
    const _userCategory = (sessionStorage.getItem('mg_user_category')
                        || localStorage.getItem('mg_user_category') || '').toLowerCase();
    const _userRole     = (sessionStorage.getItem('mg_user_role')
                        || localStorage.getItem('mg_user_role')     || '').toLowerCase();
    const _isManager    = _userCategory.includes('manager');
    const _isLead       = _userRole === 'lead';

    if (_isManager) {
      const mgNotes = mb.manager_notes || [];
      if (mgNotes.length) {
        body += `<div class="bsec bsec-manager"><div class="bsec-label">&#128203; Managers</div>`;
        mgNotes.forEach(sec => {
          if (sec.title) body += `<div class="bsec-sublabel">${esc(sec.title)}</div>`;
          (sec.items || []).forEach(item => {
            body += `<div class="note-item">&#8226; ${esc(item)}</div>`;
          });
        });
        body += `</div>`;
      }
    } else if (_isLead) {
      // Lead notes: only show on the lead's own team brief, not on other panels.
      // Derive the lead's own team slug from their category (same logic as getUserTeamSlug).
      const _leadTeam = _userCategory.includes('team 1') ? 't1'
                      : _userCategory.includes('team 2') ? 't2'
                      : _userCategory.includes('team 3') ? 't3'
                      : _userCategory.includes('install') ? 'install'
                      : null;
      if (_leadTeam && _leadTeam === team) {
        // lead_notes has parallel columns: Team 1, Team 2, Team 3, Install
        const ln = mb.lead_notes || {};
        const headers = ln.headers || [];
        const columns = ln.columns || [];
        const _teamColMap = { t1: 0, t2: 1, t3: 2, install: 3 };
        const _colIdx    = _teamColMap[team];
        const _colHeader = headers[_colIdx] || '';
        const _colItems  = (_colIdx !== undefined && columns[_colIdx]) ? columns[_colIdx] : [];
        if (_colItems.length) {
          body += `<div class="bsec bsec-leads"><div class="bsec-label">&#128204; Leads</div>`;
          if (_colHeader) body += `<div class="bsec-sublabel">${esc(_colHeader)}</div>`;
          _colItems.forEach(item => {
            body += `<div class="note-item">&#8226; ${esc(item)}</div>`;
          });
          body += `</div>`;
        }
      }
    }

    // ── All-Crew section (shown on every team's brief) ────────
    const ac           = mb.all_crew || {};
    const allcrewNotes = mb.allcrew_notes || [];
    const hasTimeOff   = (ac.time_off||[]).length > 0;
    const hasBdays     = (ac.birthdays||[]).length > 0;
    const hasEvents    = (ac.special_events||[]).length > 0;

    if (allcrewNotes.length || hasTimeOff || hasBdays || hasEvents) {
      body += `<div class="bsec bsec-allcrew"><div class="bsec-label">All Crew</div>`;

      // Notes from the All Crew Notes sheet tab
      allcrewNotes.forEach(sec => {
        if (sec.title) body += `<div class="bsec-sublabel">${esc(sec.title)}</div>`;
        (sec.items || []).forEach(item => {
          body += `<div class="note-item">&#8226; ${esc(item)}</div>`;
        });
      });

      if (hasTimeOff) {
        body += `<div class="bsec-sublabel">&#127774; Time Off</div>`;
        ac.time_off.forEach(t => {
          body += `<div class="note-item"><strong>${esc(t.name)}</strong> &mdash; ${esc(t.dates)}</div>`;
        });
      }

      if (hasBdays) {
        const todayBdays    = ac.birthdays.filter(b => b.isToday);
        const upcomingBdays = ac.birthdays.filter(b => !b.isToday);
        body += `<div class="bsec-sublabel">&#127874; Birthdays</div>`;
        todayBdays.forEach(b => {
          body += `<div class="note-item note-bday"><strong>${esc(b.name)}</strong> &mdash; Today! &#127874;</div>`;
        });
        upcomingBdays.forEach(b => {
          body += `<div class="note-item">&#127874; It's ${esc(b.name)}'s birthday on ${esc(b.date)}!</div>`;
        });
      }

      if (hasEvents) {
        body += `<div class="bsec-sublabel">&#128197; Upcoming</div>`;
        ac.special_events.forEach(e => {
          body += `<div class="note-item">${esc(e.title)} <span style="opacity:0.65;font-size:11px">${esc(e.date)}</span></div>`;
        });
      }

      body += `</div>`;
    }

    if (!body.includes('bsec')) {
      body += `<div class="brief-empty">No notes for today.</div>`;
    }
  }

  const dotCls = morningBrief ? 'live' : '';
  wrap.className = `brief-wrap${isOpen ? ' open' : ''}`;
  wrap.innerHTML = `
    <div class="brief-toggle" onclick="toggleBrief('${team}')">
      <div class="brief-toggle-label">
        <div class="bdot ${dotCls}"></div>
        Morning Brief
      </div>
      <div class="brief-arrow">&#8250;</div>
    </div>
    <div class="brief-body">
      ${body}
      <button class="brief-hide-btn" onclick="toggleBrief('${team}');event.stopPropagation()">
        &#8679; Hide brief
      </button>
    </div>`;
}

function toggleBrief(team) {
  briefOpen[team] = !briefOpen[team];
  renderBrief(`brief-${team}`, team);
}


// =============================================================
// SECTION 9 — JOB CARD RENDERING
// renderJobs() builds each job card from calendar event data,
// optionally enriched with client sheet data (findClient).
// Expanded cards show full client detail + action buttons.
// =============================================================
// ── Job cards ─────────────────────────────────────────────────
function typeTag(j) {
  if (j.type === 'load-in')       return '<span class="tag tag-load">Load-in</span>';
  if (j.type === 'install')       return '<span class="tag tag-install">Install</span>';
  if (j.interval === 'Quarterly') return '<span class="tag tag-qtr">Quarterly</span>';
  if (j.interval === 'Install')   return '<span class="tag tag-install">Install</span>';
  return '<span class="tag tag-mo">Monthly</span>';
}

function statusIcon(id) {
  const s = statuses[id] || 'pending';
  return s === 'done' ? ' \u2705' : s === 'inprogress' ? ' \u1F504' : '';
}

function calcHrs(jobs) {
  let t = 0;
  (jobs || []).forEach(j => {
    const m = j.dur.match(/([\d.]+)/); if (m) t += parseFloat(m[1]);
  });
  return t === 0 ? '\u2014' : (Number.isInteger(t) ? `${t} hr` : `${t} hrs`);
}

function renderJobs(cid, jobs, teamClass) {
  const el = document.getElementById(cid);
  el.innerHTML = '';
  if (!DAYS.length) {
    el.innerHTML = '<div class="empty">Loading&#8230;</div>';
    return;
  }
  if (!jobs || !jobs.length) {
    el.innerHTML = '<div class="empty">No jobs scheduled</div>';
    return;
  }

  // Compute once per renderJobs call — which team's WR button to show
  const _slug   = getUserTeamSlug();
  const _showWR = !_slug || teamClass.startsWith(_slug);


  jobs.forEach(j => {
    const isLoad = j.type === 'load-in';
    const sc     = !isLoad ? findClient(j.client) : null;
    const isExp  = expanded[j.id];
    const card   = document.createElement('div');
    card.className = `job-card ${isLoad ? 'load-in' : teamClass}${isExp ? ' expanded' : ''}`;

    let clientBlock = '';
    if (isExp && !isLoad) {
      if (sc) {
        clientBlock = `
          <div class="client-detail">
            <div class="cd-hdr"><div class="live-dot"></div>Live from Google Sheets</div>
            ${sc['Name(s)']               ? `<div class="drow"><span class="dlabel">Client</span><span class="dval">${esc(sc['Name(s)'])}</span></div>` : ''}
            ${sc['Address']               ? `<div class="drow"><span class="dlabel">Address</span><span class="dval">${esc(sc['Address'])}</span></div>` : ''}
            ${(sc['Phone']||sc['Phone number(s)']) ? `<div class="drow"><span class="dlabel">Phone</span><span class="dval"><a class="phone-a" href="tel:${esc(sc['Phone']||sc['Phone number(s)'])}">${esc(sc['Phone']||sc['Phone number(s)'])}</a></span></div>` : ''}
            ${(sc['Visit Interval']||sc['Visit interval']) ? `<div class="drow"><span class="dlabel">Interval</span><span class="dval">${esc(sc['Visit Interval']||sc['Visit interval'])}</span></div>` : ''}
            ${sc['Labor Hours']           ? `<div class="drow"><span class="dlabel">Est. hours</span><span class="dval">${esc(sc['Labor Hours'])}</span></div>` : ''}
            ${(sc['Scheduling Notes']||sc['Scheduling notes']) ? `<div class="drow"><span class="dlabel">Scheduling</span><span class="dval">${esc(sc['Scheduling Notes']||sc['Scheduling notes'])}</span></div>` : ''}
            ${sc['General Service Notes'] ? `<div class="drow"><span class="dlabel">Notes</span><span class="dval note">${esc(sc['General Service Notes'])}</span></div>` : ''}
            ${(sc['Gate / Access']||sc['Gate/Access']) ? `<div class="drow"><span class="dlabel">Gate</span><span class="dval">${esc(sc['Gate / Access']||sc['Gate/Access'])}</span></div>` : ''}
            ${sc['Dogs / Animals']        ? `<div class="drow"><span class="dlabel">Dogs</span><span class="dval">${esc(sc['Dogs / Animals'])}</span></div>` : ''}
          </div>`;
      } else {
        clientBlock = `<div class="drow"><span class="dlabel">Sheet</span><span class="dval" style="color:var(--ink3);font-size:11px">${sheetClients.length ? 'No exact match found' : 'Load sheets above to see client detail'}</span></div>`;
      }
      // Also show calendar description if present
      if (j.description && j.description.trim()) {
        clientBlock += `<div class="drow"><span class="dlabel">Cal notes</span><span class="dval note">${esc(j.description)}</span></div>`;
      }
    }

    card.innerHTML = `
      <div class="job-top" onclick="toggle('${j.id}')">
        <div class="jtc">
          <div class="jtime">${j.allDay ? 'All day' : j.time}</div>
          <div class="jdur">${j.dur}</div>
        </div>
        <div class="vline"></div>
        <div class="jinfo">
          <div class="jclient">${esc(j.client)}${statusIcon(j.id)}</div>
          ${j.addr ? `<div class="jaddr">${esc(j.addr)}</div>` : ''}
          <div class="jtags">
            ${typeTag(j)}
            ${sc     ? '<span class="tag tag-live">&#9679; live</span>' : ''}
            ${j.warn ? '<span class="tag tag-warn">&#9888;</span>' : ''}
          </div>
        </div>
      </div>
      <div class="job-body">
        ${j.warn ? `<div class="drow"><span class="dlabel">Alert</span><span class="dval warn">${esc(j.warn)}</span></div>` : ''}
        ${!j.allDay ? `<div class="drow"><span class="dlabel">Time</span><span class="dval">${j.time} &ndash; ${j.end} (${j.dur})</span></div>` : ''}
        ${clientBlock}
        ${!isLoad ? `
          <div class="action-row">
            <button class="abtn ${statuses[j.id]==='done'?'abtn-done':'abtn-prog abtn-status'}"
                    onclick="toggleJobStatus('${j.id}');event.stopPropagation()">
              ${statuses[j.id]==='done' ? '&#10003; Done' : statuses[j.id]==='inprogress' ? '&#9654; In progress' : '&#9654; In progress'}
            </button>
            <button class="abtn abtn-history"
                    onclick="openHistoryForClient('${esc(j.client)}');event.stopPropagation()">
              &#128196; Historical Data
            </button>
            <button class="abtn abtn-checklist" id="cl-btn-${j.id}"
                    onclick="toggleChecklist('${j.id}');event.stopPropagation()"
                    style="display:none">
              &#9989; Checklist
            </button>
            ${_showWR ? `<button class="abtn" id="wr-btn-${j.id}"
                    style="background:var(--b3);color:var(--b);border-color:var(--b4)"
                    onclick="openWorkRecord('${j.id}');event.stopPropagation()">
              &#128203; Create Work Record
            </button>` : ''}
            <button class="abtn abtn-hide" onclick="hideJob('${j.id}');event.stopPropagation()">&#8722; Minimize</button>
          </div>` : ''}
      </div>`;

    el.appendChild(card);
  });
}


// =============================================================
// SECTION 10 — TABS & MAIN RENDER LOOP
// ── switchTeam ────────────────────────────────────────────────
// Shows the selected team panel and updates the tab highlight.
// Works with any number of teams — just add more panels + tabs.

function switchTeam(teamId) {
  activeTeam = teamId;
  // Update tab highlights
  document.querySelectorAll('.team-tab').forEach(t => {
    t.classList.toggle('active', t.id === 'ttab-' + teamId);
  });
  // Show the selected panel, hide others
  document.querySelectorAll('.team-panel').forEach(p => {
    p.classList.toggle('hidden', p.id !== 'panel-' + teamId);
  });
}

// buildTabs() generates the day tab bar from DAYS[].
// render() is the single entry point that redraws everything —
// tabs, all three job columns, all three brief panels, and
// the summary bar. Call it after any state change.
// =============================================================
// ── Tabs & render ─────────────────────────────────────────────
function buildTabs() {
  const el = document.getElementById('day-tabs');
  el.innerHTML = '';

  if (!DAYS.length) {
    const calStatus = document.getElementById('sl-calendar') ?
      document.getElementById('sl-calendar').textContent : '';
    const msg = calStatus.includes('error') ? calStatus.replace('Calendar: ','') :
                calStatus.includes('live')  ? 'No events found in window' :
                'Loading calendar…';
    el.innerHTML = `<div style="padding:10px 16px;font-family:'DM Mono',monospace;font-size:10px;color:var(--ink3);letter-spacing:0.06em">${msg}</div>`;
    return;
  }

  DAYS.forEach((d, i) => {
    const day   = SCHEDULE[d] || { t1:[], t2:[], t3:[] };
    const total = (day.t1||[]).length + (day.t2||[]).length + (day.t3||[]).length;
    const tab   = document.createElement('div');
    tab.className = `day-tab${d === currentDay ? ' active' : ''}`;
    tab.innerHTML = DAY_LABELS[i]
      + (isToday(d) ? '<span class="today-badge">TODAY</span>' : '')
      + `<span class="dcnt">${total}</span>`;
    tab.onclick = () => { currentDay = d; render(); };
    el.appendChild(tab);
  });
}

function toggle(id)   { expanded[id] = !expanded[id]; render(); }
function setSt(id, s) { statuses[id] = s; render(); }

function toggleJobStatus(id) {
  // Cycles: pending → inprogress → pending
  // 'done' is set only by Submit — not manually
  const current = statuses[id] || 'pending';
  statuses[id] = current === 'inprogress' ? 'pending' : 'inprogress';
  render();
}

function hideJob(id) {
  // Collapse the card without changing its status
  expanded[id] = false;
  render();
}

function render() {
  buildTabs();

  const d   = currentDay ? (SCHEDULE[currentDay] || { t1:[], t2:[], t3:[] }) : { t1:[], t2:[], t3:[] };
  renderJobs('t1-jobs', d.t1, 't1-card');
  renderJobs('t2-jobs', d.t2, 't2-card');
  renderJobs('install-jobs', d.t3, 'install-card');
  renderBrief('brief-t1', 't1');
  renderBrief('brief-t2', 't2');
  renderBrief('brief-install', 'install');
  renderBrief('brief-install', 'install');
  document.getElementById('t1-hrs').textContent = calcHrs(d.t1);
  document.getElementById('t2-hrs').textContent = calcHrs(d.t2);
  document.getElementById('install-hrs').textContent = calcHrs(d.t3);

  const all   = [...(d.t1||[]),...(d.t2||[]),...(d.t3||[])].filter(j => j.type !== 'load-in');
  const prog      = all.filter(j => statuses[j.id] === 'inprogress').length;
  const submitted = all.filter(j => savedRecords[j.id] && savedRecords[j.id].submitted).length;
  let fh = 0;
  [...(d.t1||[]),...(d.t2||[]),...(d.t3||[])].forEach(j => {
    const m = j.dur.match(/([\d.]+)/); if (m) fh += parseFloat(m[1]);
  });

  // Restore active team tab (re-render resets DOM)
  switchTeam(activeTeam);

  document.getElementById('summary-bar').innerHTML = `
    <div class="sitem"><span class="snum k">${all.length}</span>&nbsp;jobs today</div>
    <div class="sitem"><span class="snum a">${prog}</span>&nbsp;in progress</div>
    <div class="sitem"><span class="snum b">${submitted}</span>&nbsp;submitted</div>
    <div class="sitem" style="margin-left:auto"><span class="snum k">${fh}</span>&nbsp;field hrs</div>`;

  // Always scroll the active day tab into view after the DOM is rebuilt
  setTimeout(() => {
    const active = document.querySelector('.day-tab.active');
    if (active) active.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
  }, 50);
}


// =============================================================
// SECTION 11 — STARTUP
// Sets currentDay to today then fires loadAll().
// loadAll() is also wired to the "↺ Load all sheets" button.
// =============================================================
// ── Sign out ─────────────────────────────────────────────────
function doSignOut() {
  const email = sessionStorage.getItem('mg_user_email') || localStorage.getItem('mg_user_email');
  // Revoke Google session if GIS library is available
  if (email && typeof google !== 'undefined' && google.accounts) {
    google.accounts.id.revoke(email, () => {});
  }
  // Clear both storage layers
  localStorage.removeItem('mg_auth');
  localStorage.removeItem('mg_user_email');
  localStorage.removeItem('mg_user_name');
  localStorage.removeItem('mg_auth_expiry');
  sessionStorage.clear();
  window.location.href = 'index.html';
}

// ── Cache clear (called by the reload button) ────────────────
function clearCrewCache() {
  // Clear client-side sessionStorage cache
  Object.keys(sessionStorage)
    .filter(k => k.startsWith('mg_cache_'))
    .forEach(k => sessionStorage.removeItem(k));
  // Also bust server-side CacheService so force-reload gets truly fresh data
  apiFetch('clear_server_cache').catch(() => {});
}

// ── Session timeout — 10 hours inactivity for crew ───────────
// sessionStorage is seeded from localStorage by mantis_landing.js on resume,
// so this check covers both fresh logins and restored sessions.
if (sessionStorage.getItem('mg_auth') === '1') {
  initSessionTimeout({
    timeoutMs:  10 * 60 * 60 * 1000,  // 10 hours
    warningMs:  5  * 60 * 1000,        // warn 5 min before
    sessionKey: 'mg_auth',
    loginUrl:   'index.html',
    onSignOut:  doSignOut,
  });
}

// ── Start: load all data ──────────────────────────────────────
// keepWarm trigger handles cold starts during business hours.
currentDay = todayDateKey();
loadAll();


// =============================================================
// SECTION 12 — WORK RECORD FORM
// openWorkRecord(jobId) slides up the modal for a given job.
// The form captures workers + hours, materials used,
// service notes (client-visible), internal notes, and photos.
// Data is saved to localStorage (Save) or marked submitted
// (Submit). A future version will POST to Apps Script → Drive.
// =============================================================
// ════════════════════════════════════════════════════════════
//  WORK RECORD FORM
// ════════════════════════════════════════════════════════════

let currentJobId   = null;
let currentJobData = null;
let photoFiles     = [];
// Saved records: { jobId: { workers, materials, serviceNotes, internalNotes, savedAt } }
let savedRecords   = JSON.parse(localStorage.getItem('mg_work_records') || '{}');

// Fertilizer/spray names — populated from FERT_PRODUCTS once loaded.
// Falls back to a hardcoded list if the spreadsheet hasn't loaded yet.
function getFertNames() {
  if (typeof FERT_PRODUCTS !== 'undefined' && FERT_PRODUCTS.length) {
    return FERT_PRODUCTS.map(f => f.abbrev ? `${f.name} (${f.abbrev})` : f.name);
  }
  return [
    "Urban Farms Liquid Fertilizer (UF)",
    "Maxsea: Grow (MG)","Maxsea: Acid (MA)","Maxsea: Bloom (MB)",
    "CitrusTone (CT)","HollyTone (HT)","RoseTone (RT)",
    "BioTone Starter (BT)","Worm Castings (WC)",
    "Sulfur / Hort Oil (SHO)","Isopropyl Dip (IPA)",
    "Vinegar Sprayer (mix)","RoundUp (RU)","Sluggo","Antifungal Spray (AF)",
  ];
}

// Returns grouped irrigation items for the dropdown.
// Uses IRRIGATION_ITEMS and SPRAY_HEADS from mantis_data_loader.js
// (populated from the Micro & Drip Irrigation and Spray Heads & Valves tabs).
// Groups items by detecting section header rows (name contains '──').
function getIrrigationGroups() {
  const allItems = [
    ...(typeof IRRIGATION_ITEMS !== 'undefined' ? IRRIGATION_ITEMS : []),
    ...(typeof SPRAY_HEADS      !== 'undefined' ? SPRAY_HEADS      : []),
  ];

  if (!allItems.length) {
    // Fallback hardcoded list while data loads
    return [{ label: 'Common Items', items: [
      '1/4" Dripline (6" spacing)', '1/2" Poly Line', '1/4" Poly Line',
      'Netafim .4/12"', 'Swing Pipe', '1/2" PVC slip-fix',
      '3/4" PVC slip-fix', 'Drip emitter, .5, 1 or 2 gph',
      'Waterproof wire nut, small (black)', '6-inch round-top landscape staple',
    ]}];
  }

  // Build groups from section header rows
  const groups = [];
  let current  = { label: 'Irrigation Items', items: [] };

  allItems.forEach(item => {
    if (!item.name) return;
    if (item.name.includes('──')) {
      // Section divider — start a new group (strip the ── markers for display)
      if (current.items.length) groups.push(current);
      current = { label: item.name.replace(/──+/g, '').trim(), items: [] };
    } else {
      current.items.push(item.name);
    }
  });
  if (current.items.length) groups.push(current);
  return groups;
}

function openWorkRecord(jobId) {
  const d   = SCHEDULE[currentDay] || {};
  const all = [...(d.t1||[]),...(d.t2||[]),...(d.t3||[])];
  const job = all.find(j => j.id === jobId);
  if (!job) return;

  currentJobId   = jobId;
  currentJobData = job;

  // Determine team
  const teamKey  = d.t1 && d.t1.find(j=>j.id===jobId) ? 't1'
                 : d.t2 && d.t2.find(j=>j.id===jobId) ? 't2' : 'install';
  const teamName = teamKey === 't1' ? 'Maintenance — Team 1'
                 : teamKey === 't2' ? 'Maintenance — Team 2'
                 : 'Install Team';

  document.getElementById('modal-title').textContent  = 'Work Record';
  document.getElementById('modal-client').textContent = job.client + (job.addr ? '  ·  ' + job.addr : '');
  document.getElementById('wr-team').value  = teamName;
  document.getElementById('wr-date').value  = currentDay;

  // Reset form
  document.getElementById('workers-list').innerHTML         = '';
  document.getElementById('fert-list').innerHTML            = '';
  document.getElementById('other-materials-list').innerHTML = '';
  document.getElementById('wr-service-notes').value         = '';
  document.getElementById('wr-internal-notes').value        = '';
  document.getElementById('photo-previews').innerHTML       = '';
  photoFiles = [];

  // Ensure crew name datalist exists
  _ensureCrewDatalist();

  // Show modal immediately
  document.getElementById('work-modal').classList.add('open');

  // Restore saved draft if exists
  const saved = savedRecords[jobId];
  if (saved && !saved.submitted) {
    (saved.workers        || []).forEach(w => addWorker(w.name, w.hours));
    (saved.fertilizers    || []).forEach(f => addFert(f.item, f.qty, f.unit));
    (saved.otherMaterials || []).forEach(m => addOtherMaterial(m.item, m.qty, m.unit));
    if (!saved.fertilizers && !saved.otherMaterials) {
      (saved.materials || []).forEach(m => addOtherMaterial(m.item, m.qty, m.unit));
    }
    document.getElementById('wr-service-notes').value  = saved.serviceNotes  || '';
    document.getElementById('wr-internal-notes').value = saved.internalNotes || '';
    return;
  }

  // Load service data (fert/materials lists) then auto-populate
  const fertList = document.getElementById('fert-list');
  const irrList  = document.getElementById('other-materials-list');
  const needsLoad = typeof FERT_PRODUCTS === 'undefined' || !FERT_PRODUCTS.length;

  const afterServiceDataLoaded = () => {
    refreshFertDatalist();

    // ── Auto-populate workers from today's team brief ──────
    const brief = _historyData && _historyData._teamBrief;  // not available here
    // Use the team's crew names from the morning brief all_crew list if available
    const teamWorkers = _getTeamWorkers(teamKey);
    if (teamWorkers.length) {
      teamWorkers.forEach(name => addWorker(name, ''));
    } else {
      addWorker();  // blank row if no names available
    }

    // ── Auto-populate fertilizers from most recent visit ───
    // Fetch from Historical Data sheet in background
    _prefillLastFertilizers(job.client, fertList, irrList, jobId);
  };

  if (needsLoad && typeof loadServiceData === 'function') {
    const loadingHtml = `<div class="sm-loading-row"><span class="sm-spinner"></span> Loading…</div>`;
    fertList.innerHTML = loadingHtml;
    irrList.innerHTML  = loadingHtml;
    loadServiceData()
      .then(() => {
        if (fertList.querySelector('.sm-loading-row')) fertList.innerHTML = '';
        if (irrList.querySelector('.sm-loading-row'))  irrList.innerHTML  = '';
        afterServiceDataLoaded();
      })
      .catch(() => {
        if (fertList.querySelector('.sm-loading-row')) fertList.innerHTML = '';
        if (irrList.querySelector('.sm-loading-row'))  irrList.innerHTML  = '';
        afterServiceDataLoaded();
      });
  } else {
    afterServiceDataLoaded();
  }

  // Prefetch folder ID in background for faster submit
  if (job.client && SCRIPT_URL && SCRIPT_URL !== 'PASTE_YOUR_EXEC_URL_HERE') {
    prefetchClientFolder(job.client);
  }
}

// Cache: client name → Drive folder ID
const _folderIdCache = {};

// ── Crew name datalist ────────────────────────────────────────
// Built from the all_crew list returned by getMorningBrief.
// Gives crew members name autocomplete when filling out workers.

function _ensureCrewDatalist() {
  if (document.getElementById('dl-crew-global')) return;
  const dl = document.createElement('datalist');
  dl.id = 'dl-crew-global';
  const allNames = [...(crewTeams.t1||[]), ...(crewTeams.t2||[]), ...(crewTeams.t3||[])];
  allNames.forEach(name => {
    const opt = document.createElement('option');
    opt.value = name;
    dl.appendChild(opt);
  });
  document.body.appendChild(dl);
}

// ── Get workers for a team from crewTeams ─────────────────────

function _getTeamWorkers(teamKey) {
  return crewTeams[teamKey] || [];
}

// ── Auto-fill last fertilizers ────────────────────────────────
// Fetches the most recent Fertilizer entry from the Historical Data
// sheet and pre-populates the fert rows. Falls back to one empty row.

function _prefillLastFertilizers(clientName, fertList, irrList, jobId) {
  // Look up Hist Data ID from sheetClients
  const sc = sheetClients.find(c => {
    const n = (c['Name(s)'] || '').toLowerCase().trim();
    const q = (clientName || '').toLowerCase().trim();
    return n === q || n.includes(q) || q.includes(n);
  });
  const histId   = sc && sc['Hist Data ID']    ? sc['Hist Data ID'].trim()    : '';
  const folderId = sc && sc['Drive Folder ID'] ? sc['Drive Folder ID'].trim() : '';

  if (!histId && !folderId) {
    // No IDs — just add blank rows
    if (!fertList.children.length) addFert();
    if (!irrList.children.length)  addOtherMaterial();
    return;
  }

  // Show loading message while fetching last visit data
  const loadingHtml = `<div class="sm-loading-row"><span class="sm-spinner"></span> Loading last visit…</div>`;
  fertList.innerHTML = loadingHtml;
  irrList.innerHTML  = loadingHtml;

  const idToken   = sessionStorage.getItem('mg_id_token') || '';
  const authParam = idToken ? `&id_token=${encodeURIComponent(idToken)}` : `&key=${encodeURIComponent(KEY)}`;
  const url = `${SCRIPT_URL}?action=historical_data${authParam}`
            + `&client=${encodeURIComponent(clientName)}`
            + `&histId=${encodeURIComponent(histId)}`
            + `&folderId=${encodeURIComponent(folderId)}`
            + `&_=${Date.now()}`;

  fetch(url)
    .then(r => r.json())
    .then(data => {
      // Discard if user has already moved to a different job
      if (currentJobId !== jobId) return;
      fertList.innerHTML = '';
      irrList.innerHTML  = '';
      if (data.error || !data.fertilizers || !data.fertilizers.length) {
        if (!fertList.children.length) addFert();
        if (!irrList.children.length)  addOtherMaterial();
        return;
      }
      // Most recent fertilizer entry (already sorted newest-first)
      const lastEntry = data.fertilizers[0];
      const products  = (lastEntry.product || '').split(' | ').filter(p => p.trim());
      if (products.length) {
        products.forEach(p => {
          // Parse "Product Name — qty unit"
          const dashIdx = p.indexOf(' — ');
          if (dashIdx > 0) {
            const item    = p.slice(0, dashIdx).trim();
            const qtyPart = p.slice(dashIdx + 3).trim();
            const parts   = qtyPart.split(' ');
            const qty     = parts[0] || '';
            const unit    = parts.slice(1).join(' ') || '';
            addFert(item, qty, unit);
          } else {
            addFert(p.trim());
          }
        });
      } else {
        addFert();
      }
      if (!irrList.children.length) addOtherMaterial();
    })
    .catch(() => {
      if (currentJobId !== jobId) return;
      fertList.innerHTML = '';
      irrList.innerHTML  = '';
      if (!fertList.children.length) addFert();
      if (!irrList.children.length)  addOtherMaterial();
    });
}

function prefetchClientFolder(clientName) {
  if (_folderIdCache[clientName]) return;  // already cached
  const idToken  = sessionStorage.getItem('mg_id_token') || '';
  const authParam = idToken ? `&id_token=${encodeURIComponent(idToken)}` : `&key=${encodeURIComponent(KEY)}`;
  const url = `${SCRIPT_URL}?action=prefetchClientFolder${authParam}&client=${encodeURIComponent(clientName)}`;
  fetch(url)
    .then(r => r.json())
    .then(json => {
      if (json.folderId) {
        _folderIdCache[clientName] = json.folderId;
      }
    })
    .catch(() => {});  // silent fail — submit will find it the slow way
}

function closeModal() {
  document.getElementById('work-modal').classList.remove('open');
  // Hide checklist so it's closed fresh next time
  const panel = document.getElementById('checklist-panel');
  if (panel) panel.style.display = 'none';
  document.body.style.overflow = '';
  currentJobId = null;
}

function closeModalOutside(e) {
  if (e.target === document.getElementById('work-modal')) closeModal();
}


// =============================================================
// SECTION 13 — WORKERS
// addWorker(name?, hours?) appends a name+hours input row.
// Called once on modal open, then by the "+ Add worker" button.
// =============================================================
// ── Workers ───────────────────────────────────────────────────
function addWorker(name, hours) {
  const list = document.getElementById('workers-list');
  const row  = document.createElement('div');
  row.className = 'dynamic-row';
  row.innerHTML = `
    <input class="form-input" type="text" placeholder="Worker name"
           list="dl-crew-global" autocomplete="off"
           value="${esc(name||'')}" style="flex:2"/>
    <input class="form-input" type="number" placeholder="Hours" min="0" step="0.25"
           value="${hours||''}" style="flex:1;max-width:90px"/>
    <button class="remove-btn" onclick="this.parentElement.remove()">&#10005;</button>`;
  list.appendChild(row);
}


// =============================================================
// SECTION 14 — MATERIALS & COMMON MATERIALS LIST
// COMMON_MATERIALS provides autocomplete suggestions drawn from
// the install sheet and standard maintenance supplies.
// addMaterial(item?, qty?, unit?) appends a material row.
// =============================================================
// ── Materials helpers ─────────────────────────────────────────

// ── Fertilizer row — datalist with unit auto-suggest ─────────
// All fert rows share a single datalist 'dl-fert-global' which is
// refreshed when the modal opens (refreshFertDatalist).
// This avoids the timing problem where rows were created before
// FERT_PRODUCTS had loaded from the server.

function refreshFertDatalist() {
  let dl = document.getElementById('dl-fert-global');
  if (!dl) {
    dl = document.createElement('datalist');
    dl.id = 'dl-fert-global';
    document.body.appendChild(dl);
  }
  dl.innerHTML = getFertNames().map(n => `<option value="${esc(n)}">`).join('');
}

function makeFertRow(item, qty, unit) {
  const list = document.getElementById('fert-list');
  if (!list) return;
  const row  = document.createElement('div');
  row.className = 'dynamic-row';

  row.innerHTML = `
    <input class="form-input fert-item-input" type="text" placeholder="Fertilizer / Spray"
           list="dl-fert-global" value="${esc(item||'')}" style="flex:3"/>
    <input class="form-input" type="text" placeholder="Qty"
           value="${esc(qty||'')}" style="flex:1;max-width:72px"/>
    <input class="form-input fert-unit-input" type="text" placeholder="Unit"
           value="${esc(unit||'')}" style="flex:1;max-width:72px"/>
    <button class="remove-btn" onclick="this.parentElement.remove()">&#10005;</button>`;

  // Auto-suggest unit when product is selected
  const itemInput = row.querySelector('.fert-item-input');
  const unitInput = row.querySelector('.fert-unit-input');
  function tryFillUnit() {
    if (unitInput.value) return;  // don't overwrite if crew already typed a unit
    const raw   = itemInput.value.trim();
    // Strip " (abbrev)" suffix that getFertNames() appends, e.g. "Maxsea Acid (MA)"
    const typed = raw.replace(/\s*\([^)]+\)\s*$/, '').trim().toLowerCase();
    if (!typed) return;
    const prods = typeof FERT_PRODUCTS !== 'undefined' ? FERT_PRODUCTS : [];
    // Try exact name match first, then partial starts-with match
    let product = prods.find(f => f.name.toLowerCase() === typed);
    if (!product) product = prods.find(f => f.name.toLowerCase().startsWith(typed));
    if (product && product.unit && product.unit !== 'n/a') {
      unitInput.value = product.unit;
    }
  }
  // Fire on both change and input — covers desktop and mobile datalist behaviour
  itemInput.addEventListener('change', tryFillUnit);
  itemInput.addEventListener('input',  tryFillUnit);
  // Also fire when field loses focus as a final fallback
  itemInput.addEventListener('blur',   tryFillUnit);

  list.appendChild(row);
}

function addFert(item, qty, unit) {
  makeFertRow(item, qty, unit);
}

// ── Irrigation/materials row — grouped select dropdown ────────
// 130+ irrigation items are grouped into subsections (Micro Sprayers,
// 1/4" Fittings, Netafim, PVC, etc.) so a searchable grouped select
// is much easier to use than a freetext datalist.

function makeIrrRow(item, qty, unit) {
  const list = document.getElementById('other-materials-list');
  if (!list) return;
  const row  = document.createElement('div');
  row.className = 'dynamic-row';

  // Build grouped <select> options
  const groups  = getIrrigationGroups();
  let optHtml   = '<option value="">— select item —</option>';
  groups.forEach(g => {
    optHtml += `<optgroup label="${esc(g.label)}">`;
    g.items.forEach(name => {
      const sel = (name === (item||'')) ? ' selected' : '';
      optHtml  += `<option value="${esc(name)}"${sel}>${esc(name)}</option>`;
    });
    optHtml += '</optgroup>';
  });

  // Also allow freetext override via a text input toggled by a small link
  row.innerHTML = `
    <select class="form-input irr-select" style="flex:3">${optHtml}</select>
    <input  class="form-input irr-custom" type="text" placeholder="Or type item…"
            style="flex:3;display:none" value="${esc(item||'')}"/>
    <button class="btn-link irr-toggle" type="button"
            style="font-size:11px;padding:0 4px;white-space:nowrap">other</button>
    <input class="form-input" type="text" placeholder="Qty"
           value="${esc(qty||'')}" style="flex:1;max-width:72px"/>
    <input class="form-input" type="text" placeholder="Unit"
           value="${esc(unit||'')}" style="flex:1;max-width:72px"/>
    <button class="remove-btn" onclick="this.parentElement.remove()">&#10005;</button>`;

  // Toggle between select and freetext
  const sel     = row.querySelector('.irr-select');
  const custom  = row.querySelector('.irr-custom');
  const toggle  = row.querySelector('.irr-toggle');
  toggle.addEventListener('click', () => {
    const showCustom = sel.style.display !== 'none';
    sel.style.display    = showCustom ? 'none'  : '';
    custom.style.display = showCustom ? ''      : 'none';
    toggle.textContent   = showCustom ? 'list'  : 'other';
    if (!showCustom) sel.focus(); else custom.focus();
  });

  // If restoring a saved item that isn't in the dropdown, show freetext
  if (item && !groups.some(g => g.items.includes(item))) {
    sel.style.display    = 'none';
    custom.style.display = '';
    toggle.textContent   = 'list';
  }

  list.appendChild(row);
}

function addOtherMaterial(item, qty, unit) {
  makeIrrRow(item, qty, unit);
}

// Legacy alias — keep in case anything else references addMaterial
function addMaterial(item, qty, unit) {
  addOtherMaterial(item, qty, unit);
}


// =============================================================
// SECTION 15 — PHOTOS
// handlePhotos() reads selected files into FileReader and shows
// thumbnails. photoFiles[] holds the File objects for upload.
// =============================================================
// ── Photo settings ────────────────────────────────────────────
const PHOTO_MAX_DIM  = 1600;   // max width or height in pixels
const PHOTO_QUALITY  = 0.80;   // JPEG quality 0–1
const PHOTO_MAX_COUNT = 5;     // warn if more than this selected

// ── Compress a File to a JPEG data URL via canvas ─────────────
function compressPhoto(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = reject;
    reader.onload = ev => {
      const img = new Image();
      img.onerror = reject;
      img.onload = () => {
        // Calculate new dimensions keeping aspect ratio
        let w = img.naturalWidth;
        let h = img.naturalHeight;
        if (w > PHOTO_MAX_DIM || h > PHOTO_MAX_DIM) {
          if (w >= h) { h = Math.round(h * PHOTO_MAX_DIM / w); w = PHOTO_MAX_DIM; }
          else        { w = Math.round(w * PHOTO_MAX_DIM / h); h = PHOTO_MAX_DIM; }
        }
        const canvas = document.createElement('canvas');
        canvas.width  = w;
        canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL('image/jpeg', PHOTO_QUALITY));
      };
      img.src = ev.target.result;
    };
    reader.readAsDataURL(file);
  });
}

// ── Photos ────────────────────────────────────────────────────
function handlePhotos(e) {
  const files    = Array.from(e.target.files);
  const previews = document.getElementById('photo-previews');

  // Warning if too many photos selected
  if (photoFiles.length + files.length > PHOTO_MAX_COUNT) {
    showToast(`Max ${PHOTO_MAX_COUNT} photos per record. Select fewer.`);
    e.target.value = '';  // clear the input
    return;
  }

  files.forEach(file => {
    photoFiles.push(file);

    // Compress and show thumbnail
    compressPhoto(file).then(dataUrl => {
      const wrap = document.createElement('div');
      wrap.className = 'photo-thumb-wrap';
      wrap.innerHTML = `
        <img class="photo-thumb" src="${dataUrl}"/>
        <button class="photo-remove" onclick="removePhoto(this, '${esc(file.name)}')">&#10005;</button>
        <div class="photo-size-label" id="photo-size-${esc(file.name.replace(/[^a-z0-9]/gi,'_'))}">
          ${(file.size / 1024 / 1024).toFixed(1)}MB
        </div>`;
      previews.appendChild(wrap);

      // Show compressed size estimate
      const compressedKb = Math.round(dataUrl.length * 0.75 / 1024);
      const origMb = (file.size / 1024 / 1024).toFixed(1);
      const sizeLabel = wrap.querySelector('.photo-size-label');
      if (sizeLabel) sizeLabel.textContent = `${origMb}MB → ~${compressedKb}KB`;
    }).catch(() => {
      // Fallback: show without compression
      const reader = new FileReader();
      reader.onload = ev => {
        const img = document.createElement('img');
        img.className = 'photo-thumb';
        img.src = ev.target.result;
        previews.appendChild(img);
      };
      reader.readAsDataURL(file);
    });
  });
}

function removePhoto(btn, fileName) {
  photoFiles = photoFiles.filter(f => f.name !== fileName);
  btn.closest('.photo-thumb-wrap').remove();
}


// =============================================================
// SECTION 16 — FORM ACTIONS
// collectFormData()  — gathers all form fields into one object
// saveForm()         — persists to localStorage, shows badge
// submitForm()       — validates, saves, marks job Done, closes
// clearForm()        — resets all fields to blank
// =============================================================
// ── Collect form data ─────────────────────────────────────────
function collectFormData() {
  const workers = [];
  document.querySelectorAll('#workers-list .dynamic-row').forEach(row => {
    const inputs = row.querySelectorAll('input');
    const name   = inputs[0].value.trim();
    const hours  = inputs[1].value.trim();
    if (name) workers.push({ name, hours });
  });

  function collectRows(listId) {
    const rows = [];
    document.querySelectorAll(`#${listId} .dynamic-row`).forEach(row => {
      // Irrigation rows use a <select> or custom text input for the item.
      // Fert rows use a text input. Handle both cases.
      const sel    = row.querySelector('.irr-select');
      const custom = row.querySelector('.irr-custom');
      let item;
      if (sel && sel.style.display !== 'none') {
        item = sel.value.trim();
      } else if (custom && custom.style.display !== 'none') {
        item = custom.value.trim();
      } else {
        // Fert row — first input is the item
        const firstInput = row.querySelector('input.fert-item-input') ||
                           row.querySelectorAll('input')[0];
        item = firstInput ? firstInput.value.trim() : '';
      }
      // Qty and unit are always the last two text inputs
      const allInputs = Array.from(row.querySelectorAll('input[type="text"]'))
        .filter(i => !i.classList.contains('fert-item-input') &&
                     !i.classList.contains('irr-custom') &&
                     !i.classList.contains('fert-unit-input'));
      // Actually just grab qty/unit by placeholder
      const qtyEl  = row.querySelector('input[placeholder="Qty"]');
      const unitEl = row.querySelector('input[placeholder="Unit"]');
      const qty    = qtyEl  ? qtyEl.value.trim()  : '';
      const unit   = unitEl ? unitEl.value.trim() : '';
      if (item) rows.push({ item, qty, unit });
    });
    return rows;
  }

  const fertilizers    = collectRows('fert-list');
  const otherMaterials = collectRows('other-materials-list');

  // Look up Hist Data ID and folder ID from client database for fast submit
  const _sc = sheetClients.find(c => {
    const n = (c['Name(s)'] || '').toLowerCase().trim();
    const q = (currentJobData ? currentJobData.client : '').toLowerCase().trim();
    return n === q || n.includes(q) || q.includes(n);
  });

  return {
    jobId:         currentJobId,
    client:        currentJobData ? currentJobData.client : '',
    addr:          currentJobData ? currentJobData.addr   : '',
    team:          document.getElementById('wr-team').value,
    date:          document.getElementById('wr-date').value,
    workers,
    fertilizers,
    otherMaterials,
    serviceNotes:  document.getElementById('wr-service-notes').value.trim(),
    internalNotes: document.getElementById('wr-internal-notes').value.trim(),
    photoCount:    photoFiles.length,
    savedAt:       new Date().toISOString(),
    histId:        (_sc && _sc['Hist Data ID'])    ? _sc['Hist Data ID'].trim()    : '',
    cachedFolderId:(_sc && _sc['Drive Folder ID']) ? _sc['Drive Folder ID'].trim() : '',
  };
}

// ── Save (local storage) ──────────────────────────────────────
function saveForm() {
  if (!currentJobId) return;
  const data = collectFormData();
  const dataForStorage2 = Object.assign({}, data, { photos: [] });
  savedRecords[currentJobId] = dataForStorage2;
  safeLocalSave();
  showToast('Record saved ✓');
  // Update badge on the job card button
  const btn = document.getElementById('wr-btn-' + currentJobId);
  if (btn && !btn.querySelector('.saved-badge')) {
    btn.innerHTML += '<span class="saved-badge">saved</span>';
  }
}

// ── Submit ────────────────────────────────────────────────────
function submitForm() {
  const data = collectFormData();

  // Validate minimum
  if (!data.workers.length || !data.workers[0].name) {
    showToast('Please add at least one worker');
    return;
  }

  // Disable submit button and show progress indicator
  const submitBtn = document.getElementById('wr-submit-btn');
  if (submitBtn) { submitBtn.disabled = true; }
  showSubmitProgress('Saving record…', 20);

  data.submitted   = true;
  data.submittedAt = new Date().toISOString();

  // Save locally first — ensures record is never lost even if network fails
  // Strip photos before saving to localStorage (they are large base64 strings
  // and don't need to be persisted — they're already in memory as photoFiles[])
  const dataForStorage = Object.assign({}, data, { photos: [] });
  savedRecords[currentJobId] = dataForStorage;
  safeLocalSave();

  // POST to Apps Script if configured
  if (SCRIPT_URL && SCRIPT_URL !== 'PASTE_YOUR_EXEC_URL_HERE') {

    // Compress photos via canvas then encode as base64
    const encodePhotos = () => {
      if (!photoFiles.length) return Promise.resolve([]);
      return Promise.all(photoFiles.map(file =>
        compressPhoto(file).then(dataUrl => ({
          name:     file.name.replace(/\.heic$/i, '.jpg'),  // HEIC → JPEG on output
          mimeType: 'image/jpeg',
          base64:   dataUrl.split(',')[1],
        })).catch(() => new Promise((res, rej) => {
          // Fallback to uncompressed if canvas fails
          const reader = new FileReader();
          reader.onload  = e => res({
            name:     file.name,
            mimeType: file.type || 'image/jpeg',
            base64:   e.target.result.split(',')[1],
          });
          reader.onerror = rej;
          reader.readAsDataURL(file);
        }))
      ));
    };

    encodePhotos()
      .then(photos => {
        data.photos = photos;
        data.cachedFolderId = _folderIdCache[data.client] || null;
        showSubmitProgress('Uploading to Drive…', 50);
        const idToken   = sessionStorage.getItem('mg_id_token') || '';
        const authParam = idToken ? `&id_token=${encodeURIComponent(idToken)}` : `&key=${encodeURIComponent(KEY)}`;
        return fetch(`${SCRIPT_URL}?action=submitWorkRecord${authParam}`, {
          method:  'POST',
          headers: { 'Content-Type': 'text/plain;charset=utf-8' },
          body:    JSON.stringify(data),
        });
      })
      .then(r => {
        showSubmitProgress('Saving documents…', 80);
        return r.json();
      })
      .then(json => {
        if (json.error) throw new Error(json.error);
        // Clear checklist state for this job
        if (currentJobId) delete _checklistStates[currentJobId];
        const panel = document.getElementById('checklist-panel');
        if (panel) {
          panel.style.display = 'none';
          panel.dataset.jobId = '';
          panel.querySelectorAll('input[type=checkbox]').forEach(cb => cb.checked = false);
        }
        savedRecords[currentJobId] = {
          submitted: true,
          savedAt:   new Date().toISOString(),
          client:    data.client || '',
          date:      data.date   || '',
        };
        safeLocalSave();

        showSubmitProgress('Done ✓', 100);
        if (currentJobId) setSt(currentJobId, 'done');
        setTimeout(() => {
          hideSubmitProgress();
          showToast('Submitted ✓');
          setTimeout(() => closeModal(), 1500);
        }, 600);
      })
      .catch(err => {
        console.error('Submit error:', err);
        hideSubmitProgress();
        if (currentJobId) setSt(currentJobId, 'done');
        showToast('Saved locally — sync failed: ' + err.message);
        setTimeout(() => closeModal(), 2500);
      })
      .finally(() => {
        if (submitBtn) { submitBtn.disabled = false; }
      });
  } else {
    // No script URL — local only
    if (currentJobId) setSt(currentJobId, 'done');
    hideSubmitProgress();
    showToast('Work record saved ✓ (local only)');
    setTimeout(() => closeModal(), 1200);
    if (submitBtn) { submitBtn.disabled = false; }
  }
}

// ── Clear ─────────────────────────────────────────────────────
// ── toggleChecklist ───────────────────────────────────────────
// Shows/hides the end-of-job checklist panel above the modal footer.
// Checkboxes reset each time the panel is opened so it's fresh per job.

// Cached checklist data — fetched once per session on first open
let _checklistData   = null;
// Per-job checkbox state: { jobId: { itemIndex: true/false } }
let _checklistStates = {};


function toggleChecklist(jobId) {
  const panel = document.getElementById('checklist-panel');
  if (!panel) return;

  // Close button passes null — just close
  const isOpen = panel.style.display !== 'none';
  if (!jobId || (isOpen && panel.dataset.jobId === jobId)) {
    saveChecklistState(panel.dataset.jobId);
    panel.style.display = 'none';
    return;
  }

  // Save state of previous job if switching
  if (panel.dataset.jobId && panel.dataset.jobId !== jobId) {
    saveChecklistState(panel.dataset.jobId);
  }
  panel.dataset.jobId = jobId;
  panel.style.display = 'block';

  // If we already have data, restore state for this job and show
  if (_checklistData && _checklistData.length) {
    restoreChecklistState(jobId);
    return;
  }

  // Show the hardcoded checklist immediately — no spinner needed.
  // Then silently fetch live data from the Google Doc in the background.
  // If live data arrives it replaces the hardcoded content seamlessly.
  const body = panel.querySelector('.checklist-body');
  restoreChecklistState(jobId);

  const auth = sessionStorage.getItem('mg_id_token')
    ? `&id_token=${encodeURIComponent(sessionStorage.getItem('mg_id_token'))}` : '';

  fetch(`${MANTIS_CONFIG.SCRIPT_URL}?action=getChecklist${auth}`)
    .then(r => r.json())
    .then(json => {
      if (json.error) throw new Error(json.error);
      _checklistData = json.checklist || [];
      if (_checklistData.length && body) {
        // Live data available — swap in the Google Doc version
        body.innerHTML = buildChecklistHtml(_checklistData);
        restoreChecklistState(jobId);
      }
      // If empty, keep the hardcoded HTML as-is — no visible change
    })
    .catch(() => {
      // Fetch failed — hardcoded HTML already showing, nothing to do
    });
}

// Save current checkbox state for a job
function saveChecklistState(jobId) {
  if (!jobId) return;
  const panel = document.getElementById('checklist-panel');
  if (!panel) return;
  const state = {};
  panel.querySelectorAll('input[type=checkbox]').forEach((cb, i) => {
    state[i] = cb.checked;
  });
  _checklistStates[jobId] = state;
}

// Restore checkbox state for a job (or leave all unchecked if no state yet)
function restoreChecklistState(jobId) {
  const state = _checklistStates[jobId] || {};
  const panel = document.getElementById('checklist-panel');
  if (!panel) return;
  panel.querySelectorAll('input[type=checkbox]').forEach((cb, i) => {
    cb.checked = state[i] || false;
  });
}

// Builds checklist HTML from the structured array returned by the Apps Script.
// Each section has a title and an array of items with type 'item' or 'note'.
function buildChecklistHtml(sections) {
  let html = '';
  sections.forEach(section => {
    html += `<div class="checklist-section">${esc(section.title)}</div>`;
    (section.items || []).forEach(item => {
      if (item.type === 'item') {
        html += `<label class="checklist-item">
          <input type="checkbox"> ${esc(item.text)}
        </label>`;
      } else if (item.type === 'note') {
        html += `<p class="checklist-note">${esc(item.text)}</p>`;
      }
    });
  });
  return html;
}

function clearForm() {
  document.getElementById('workers-list').innerHTML         = '';
  document.getElementById('fert-list').innerHTML            = '';
  document.getElementById('other-materials-list').innerHTML = '';
  document.getElementById('wr-service-notes').value         = '';
  document.getElementById('wr-internal-notes').value        = '';
  document.getElementById('photo-previews').innerHTML       = '';
  photoFiles = [];
  addWorker();
  addFert();
  addOtherMaterial();
}


// =============================================================
// SECTION 16b — SAFE LOCAL SAVE
// Saves savedRecords to localStorage, catching quota errors.
// Automatically prunes old submitted records if storage is full.
// =============================================================
function safeLocalSave() {
  try {
    localStorage.setItem('mg_work_records', JSON.stringify(savedRecords));
  } catch(e) {
    if (e.name === 'QuotaExceededError') {
      // Storage full — prune submitted records older than 7 days
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - 7);
      const cutoffStr = cutoff.toISOString();
      let pruned = 0;
      Object.keys(savedRecords).forEach(key => {
        const rec = savedRecords[key];
        // Prune submitted records older than 7 days
        if (rec.submitted && rec.savedAt && rec.savedAt < cutoffStr) {
          delete savedRecords[key];
          pruned++;
        }
        // Also prune unsubmitted drafts older than 7 days —
        // if not submitted after a week it's stale
        if (!rec.submitted && rec.savedAt && rec.savedAt < cutoffStr) {
          delete savedRecords[key];
          pruned++;
        }
      });
      if (pruned > 0) {
        console.log(`localStorage full — pruned ${pruned} old submitted records`);
        try {
          localStorage.setItem('mg_work_records', JSON.stringify(savedRecords));
          return;
        } catch(e2) {}
      }
      // If still full, clear all submitted records
      Object.keys(savedRecords).forEach(key => {
        if (savedRecords[key].submitted) delete savedRecords[key];
      });
      try {
        localStorage.setItem('mg_work_records', JSON.stringify(savedRecords));
      } catch(e3) {
        console.warn('localStorage still full after pruning — record not persisted locally');
      }
    }
  }
}

// =============================================================
// SECTION 17 — SUBMIT PROGRESS INDICATOR
// Shows a slim progress bar + status message inside the modal
// footer while the record is being written to Drive.
// =============================================================
function showSubmitProgress(message, pct) {
  let bar = document.getElementById('submit-progress');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'submit-progress';
    bar.style.cssText = [
      'position:absolute','bottom:0','left:0','right:0',
      'background:rgba(31,78,61,0.96)','color:#fff',
      'padding:10px 16px','font-family:Arial,sans-serif',
      'font-size:13px','display:flex','align-items:center','gap:12px',
      'z-index:10'
    ].join(';');
    bar.innerHTML = `
      <span id="submit-progress-msg" style="flex:1"></span>
      <div style="width:120px;height:4px;background:rgba(255,255,255,0.25);border-radius:2px;flex-shrink:0">
        <div id="submit-progress-bar" style="height:100%;background:#7ec8a0;border-radius:2px;transition:width 0.4s ease;width:0%"></div>
      </div>`;
    // Insert into modal
    const modal = document.querySelector('.modal');
    if (modal) { modal.style.position = 'relative'; modal.appendChild(bar); }
  }
  document.getElementById('submit-progress-msg').textContent = message;
  document.getElementById('submit-progress-bar').style.width = pct + '%';
}

function hideSubmitProgress() {
  const bar = document.getElementById('submit-progress');
  if (bar) {
    bar.style.transition = 'opacity 0.3s';
    bar.style.opacity = '0';
    setTimeout(() => bar.remove(), 350);
  }
}

// =============================================================
// SECTION 18 — TOAST NOTIFICATION
// showToast(msg) displays a brief overlay message at the bottom
// of the screen. Auto-hides after 2.4 seconds.
// =============================================================
// ── Toast ─────────────────────────────────────────────────────
function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2400);
}

// =============================================================
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
    const sc = sheetClients.find(c => {
      const n = (c['Name(s)'] || '').toLowerCase().trim();
      const q = clientName.toLowerCase().trim();
      return n === q || n.includes(q) || q.includes(n);
    });

    const histId   = (sc && sc['Hist Data ID'])    ? sc['Hist Data ID'].trim()    : '';
    const folderId = (sc && sc['Drive Folder ID']) ? sc['Drive Folder ID'].trim() : '';

    const idToken   = sessionStorage.getItem('mg_id_token') || '';
    const authParam = idToken ? `&id_token=${encodeURIComponent(idToken)}` : `&key=${encodeURIComponent(KEY)}`;
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
