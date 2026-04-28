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

let expanded     = {}, statuses = {}, briefOpen = { t1:true, t2:true, t3:true };
let clientCache  = {}, sheetClients = [], morningBrief = null;


// =============================================================
// SECTION 4 — API LAYER
// apiFetch() wraps all calls to the Apps Script web app.
// loadAll() fires all four requests in parallel (Promise.allSettled)
// so a single slow sheet doesn't block the others.
// =============================================================
// ── API ───────────────────────────────────────────────────────
// Cache TTLs (milliseconds)
const CACHE_TTL = {
  active_clients:   10 * 60 * 1000,   // 10 min  — client list rarely changes during a day
  morning_brief:     5 * 60 * 1000,   //  5 min  — cached for fast navigation returns; busted by reload button
  schedule:          3 * 60 * 1000,   //  3 min  — calendar most likely to change
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
  // Re-show status bar during reload so crew can see progress
  const statusBar = document.querySelector('.status-bar');
  if (statusBar) statusBar.style.display = '';
  setStatus('clients',  'loading', 'Clients: loading...');
  setStatus('brief',    'loading', 'Morning brief: loading...');
  setStatus('calendar', 'loading', 'Calendar: loading...');



  const delay = ms => new Promise(res => setTimeout(res, ms));
  const results = await Promise.allSettled([
    apiFetch('active_clients'),
    delay(300).then(() => apiFetch('schedule', '&weeks=2')),
    delay(600).then(() => apiFetch('morning_brief')),
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

    // Snap to today if in the window, else nearest future day, else first day
    const todayKey = todayDateKey();
    if (DAYS.includes(todayKey)) {
      currentDay = todayKey;
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

  document.getElementById('reload-btn').disabled = false;

  // ── Hide status bar if all items loaded successfully ─────────
  // If any item has an error the bar stays visible so crew can see it.
  // A small delay lets the final status text render before hiding.
  setTimeout(() => {
    const dots = document.querySelectorAll('.sdot');
    const allLive = Array.from(dots).every(d => d.classList.contains('live'));
    const bar = document.querySelector('.status-bar');
    if (bar) bar.style.display = allLive ? 'none' : '';
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
  render();

  // Scroll the active tab into view after render rebuilds the DOM
  requestAnimationFrame(() => {
    const active = document.querySelector('.day-tab.active');
    if (active) active.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
  });
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
    let teamNotes = [];
    if      (team === 't1') teamNotes = mb.team1_notes  || [];
    else if (team === 't2') teamNotes = mb.team2_notes  || [];
    else if (team === 't3') teamNotes = mb.team3_notes  || [];

    const mgrNotes = mb.manager_notes || [];

    if (teamNotes.length || mgrNotes.length) {
      body += `<div class="bsec"><div class="bsec-label">Daily Notes</div>`;
      teamNotes.forEach(n => { body += `<div class="note-item">${esc(n)}</div>`; });
      mgrNotes.forEach(n  => { body += `<div class="note-item note-mgr">&#128337; ${esc(n)}</div>`; });
      body += `</div>`;
    }

    // ── All-Crew section (shown on every team's brief) ────────
    const ac = mb.all_crew || {};
    const hasTimeOff = (ac.time_off||[]).length > 0;
    const hasBdays   = (ac.birthdays||[]).length > 0;
    const hasEvents  = (ac.special_events||[]).length > 0;

    if (hasTimeOff || hasBdays || hasEvents) {
      body += `<div class="bsec bsec-allcrew"><div class="bsec-label">All Crew</div>`;

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
            <button class="abtn" id="wr-btn-${j.id}"
                    style="background:var(--b3);color:var(--b);border-color:var(--b4)"
                    onclick="openWorkRecord('${j.id}');event.stopPropagation()">
              &#128203; Work record
            </button>
            <button class="abtn abtn-history"
                    onclick="openHistoryForClient('${esc(j.client)}');event.stopPropagation()">
              &#128196; History
            </button>
            <button class="abtn abtn-checklist" id="cl-btn-${j.id}"
                    onclick="toggleChecklist('${j.id}');event.stopPropagation()"
                    style="display:none">
              &#9989; Checklist
            </button>
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
  renderJobs('t3-jobs', d.t3, 't3-card');
  renderBrief('brief-t1', 't1');
  renderBrief('brief-t2', 't2');
  renderBrief('brief-t3', 't3');
  document.getElementById('t1-hrs').textContent = calcHrs(d.t1);
  document.getElementById('t2-hrs').textContent = calcHrs(d.t2);
  document.getElementById('t3-hrs').textContent = calcHrs(d.t3);

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
  Object.keys(sessionStorage)
    .filter(k => k.startsWith('mg_cache_'))
    .forEach(k => sessionStorage.removeItem(k));
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

  // Checklist state persists per job — reset happens on submit
  currentJobData = job;

  // Determine team name
  const teamName = d.t1 && d.t1.find(j=>j.id===jobId) ? 'Maintenance — Team 1'
                 : d.t2 && d.t2.find(j=>j.id===jobId) ? 'Maintenance — Team 2'
                 : 'Install Team';

  // Set header
  document.getElementById('modal-title').textContent  = 'Work Record';
  document.getElementById('modal-client').textContent = job.client + (job.addr ? '  ·  ' + job.addr : '');
  document.getElementById('wr-team').value  = teamName;
  document.getElementById('wr-date').value  = currentDay;

  // Reset form
  document.getElementById('workers-list').innerHTML        = '';
  document.getElementById('fert-list').innerHTML           = '';
  document.getElementById('other-materials-list').innerHTML = '';
  document.getElementById('wr-service-notes').value        = '';
  document.getElementById('wr-internal-notes').value       = '';
  document.getElementById('photo-previews').innerHTML      = '';
  photoFiles = [];

  // Restore saved data if exists
  const saved = savedRecords[jobId];
  if (saved) {
    (saved.workers       || []).forEach(w => addWorker(w.name, w.hours));
    (saved.fertilizers   || []).forEach(f => addFert(f.item, f.qty, f.unit));
    (saved.otherMaterials|| []).forEach(m => addOtherMaterial(m.item, m.qty, m.unit));
    // Legacy: if old record only had 'materials', restore into otherMaterials
    if (!saved.fertilizers && !saved.otherMaterials) {
      (saved.materials || []).forEach(m => addOtherMaterial(m.item, m.qty, m.unit));
    }
    document.getElementById('wr-service-notes').value  = saved.serviceNotes  || '';
    document.getElementById('wr-internal-notes').value = saved.internalNotes || '';
  }

  // Show modal now so the crew member sees it open immediately
  document.getElementById('work-modal').classList.add('open');

  // Load service data (fertilizers + irrigation) if not yet available,
  // showing a brief loading message in the fert/materials sections.
  const fertList  = document.getElementById('fert-list');
  const irrList   = document.getElementById('other-materials-list');
  const needsLoad = typeof FERT_PRODUCTS === 'undefined' || !FERT_PRODUCTS.length;

  if (needsLoad && typeof loadServiceData === 'function') {
    // Show loading placeholder in both sections
    const loadingHtml = `<div class="sm-loading-row">
      <span class="sm-spinner"></span> Loading product list…
    </div>`;
    if (!fertList.children.length) fertList.innerHTML  = loadingHtml;
    if (!irrList.children.length)  irrList.innerHTML   = loadingHtml;

    loadServiceData()
      .then(() => {
        // Clear loading placeholders and populate rows
        if (fertList.querySelector('.sm-loading-row'))  fertList.innerHTML  = '';
        if (irrList.querySelector('.sm-loading-row'))   irrList.innerHTML   = '';
        refreshFertDatalist();
        if (!fertList.children.length)  addFert();
        if (!irrList.children.length)   addOtherMaterial();
      })
      .catch(() => {
        // On failure fall back to hardcoded list
        if (fertList.querySelector('.sm-loading-row'))  fertList.innerHTML  = '';
        if (irrList.querySelector('.sm-loading-row'))   irrList.innerHTML   = '';
        refreshFertDatalist();
        if (!fertList.children.length)  addFert();
        if (!irrList.children.length)   addOtherMaterial();
      });
  } else {
    // Data already loaded — populate immediately
    refreshFertDatalist();
    if (!fertList.children.length)  addFert();
    if (!irrList.children.length)   addOtherMaterial();
  }

  // (modal open is handled above so we skip the duplicate call below)
  return;

  // Update submit button state based on whether record was already submitted
  const submitBtn = document.getElementById('wr-submit-btn');
  const alreadySubmitted = saved && saved.submitted && saved.recordId;
  if (submitBtn) {
    submitBtn.disabled    = !!alreadySubmitted;
    submitBtn.textContent = alreadySubmitted ? 'Submitted ✓' : 'Submit';
    submitBtn.style.background   = alreadySubmitted ? 'var(--g)'  : '';
    submitBtn.style.borderColor  = alreadySubmitted ? 'var(--g)'  : '';
    submitBtn.style.opacity      = alreadySubmitted ? '0.6'       : '';
    submitBtn.style.cursor       = alreadySubmitted ? 'not-allowed' : '';
  }

  // (modal already opened above)
  document.body.style.overflow = 'hidden';

  // Pre-fetch the client's Drive folder ID in the background.
  // By the time the crew member fills the form and hits Submit,
  // the folder is already found — skipping the slowest step.
  if (job.client && SCRIPT_URL && SCRIPT_URL !== 'PASTE_YOUR_EXEC_URL_HERE') {
    prefetchClientFolder(job.client);
  }
}

// Cache: client name → Drive folder ID
const _folderIdCache = {};

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
    savedAt:       new Date().toISOString()
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
        data.recordId = json.recordId;
        // Clear checklist state for this job — it's been submitted
        if (currentJobId) delete _checklistStates[currentJobId];
        const panel = document.getElementById('checklist-panel');
        if (panel) {
          panel.style.display = 'none';
          panel.dataset.jobId = '';
          if (panel.querySelector('.checklist-body')) {
            panel.querySelectorAll('input[type=checkbox]').forEach(cb => cb.checked = false);
          }
        }
        // Keep a minimal stub so the Submit button stays disabled on reopen.
        // Strip heavy fields (photos, notes) to keep localStorage lean.
        savedRecords[currentJobId] = {
          submitted:  true,
          recordId:   json.recordId,
          savedAt:    new Date().toISOString(),
          client:     data.client || '',
          date:       data.date   || '',
        };
        safeLocalSave();

        showSubmitProgress('Done ✓', 100);
        if (currentJobId) setSt(currentJobId, 'done');
        setTimeout(() => {
          hideSubmitProgress();
          showToast('Submitted ✓  ' + json.recordId);
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
// SECTION 19 — SERVICE HISTORY
// openHistory()            — opens modal, populates client list
// openHistoryForClient(name) — opens modal pre-selected to client
// loadHistory(clientName)  — fetches + renders history
// switchHistoryTab(tab)    — switches Notes/Records/Fertilizers
// filterHistory(query)     — real-time keyword search across all
// closeHistory()           — closes the modal
// =============================================================

let _historyData       = null;   // last fetched history payload
let _historyClient     = '';     // currently loaded client name
let _historyTab        = 'notes'; // active tab
let _historyQuery      = '';     // current search string

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

  // Helper to check a name against all sheet clients
  function findMatch(nameToCheck) {
    const n = norm(nameToCheck);
    return sheetClients.find(c => {
      const cn = norm(c['Name(s)'] || c['name'] || '');
      return cn === n || cn.includes(n) || n.includes(cn);
    });
  }

  // 1. Exact norm match
  const exact = sheetClients.find(c =>
    norm(c['Name(s)'] || c['name'] || '') === calNorm
  );
  if (exact) return exact['Name(s)'] || exact['name'];

  // 2. Direct contains match
  const contains = findMatch(calName);
  if (contains) return contains['Name(s)'] || contains['name'];

  // 3. For compound names split on " & ", try each person's surname
  const people = calName.split(/\s*&\s*/);
  for (const person of people) {
    const surname = person.trim().split(/[\s,]+/)[0];
    if (surname && surname.length > 2) {
      const m = sheetClients.find(c => {
        const cn = c['Name(s)'] || c['name'] || '';
        return cn.toLowerCase().includes(surname.toLowerCase());
      });
      if (m) return m['Name(s)'] || m['name'];
    }
  }

  // 4. Word overlap fallback
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
  // Clear all but the placeholder and reset to it
  while (sel.options.length > 1) sel.remove(1);
  sel.value = '';
  // Add all active clients sorted alphabetically
  const sorted = [...sheetClients].sort((a, b) => {
    const na = (a['Name(s)'] || a['name'] || '').toLowerCase();
    const nb = (b['Name(s)'] || b['name'] || '').toLowerCase();
    return na.localeCompare(nb);
  });
  sorted.forEach(c => {
    const name = c['Name(s)'] || c['name'] || '';
    if (!name) return;
    const opt  = document.createElement('option');
    opt.value       = name;
    opt.textContent = name;
    sel.appendChild(opt);
  });
}

// ── Load history for a client ──────────────────────────────────
async function loadHistory(clientName) {
  if (!clientName) {
    document.getElementById('history-body').innerHTML =
      '<div class="history-empty">Select a client above to view their service history.</div>';
    document.getElementById('history-tabs').style.display       = 'none';
    document.getElementById('history-search-wrap').style.display = 'none';
    document.getElementById('history-client-label').textContent  = '';
    return;
  }

  _historyClient = clientName;
  _historyQuery  = '';
  _historyData   = null;   // clear stale data immediately
  document.getElementById('history-search').value           = '';
  document.getElementById('history-search-clear').style.display = 'none';
  document.getElementById('history-client-label').textContent   = clientName;
  document.getElementById('history-body').innerHTML =
    '<div class="history-loading"><div class="history-spinner"></div>Loading history for ' + esc(clientName) + '…</div>';
  document.getElementById('history-tabs').style.display        = 'none';
  document.getElementById('history-search-wrap').style.display = 'none';
  // Reset tab counts so stale numbers don't show if load fails
  document.getElementById('htab-ct-notes').textContent   = '';
  document.getElementById('htab-ct-records').textContent = '';
  document.getElementById('htab-ct-fert').textContent    = '';

  try {
    // Look up folderId — cache keys may use calendar event titles (e.g. "Paiva - Monthly")
    // while clientName is the sheet name (e.g. "Paiva, Michael & Alison").
    // Search all cache entries for any key that shares a surname with clientName.
    let folderId = _folderIdCache[clientName] || '';
    if (!folderId) {
      const nameLow = clientName.toLowerCase();
      const surnames = clientName.split(/[\s,&]+/).filter(p => p.length > 2)
                                 .map(p => p.toLowerCase());
      for (const [key, id] of Object.entries(_folderIdCache)) {
        const keyLow = key.toLowerCase();
        if (surnames.some(s => keyLow.includes(s))) { folderId = id; break; }
      }
    }
    const idToken  = sessionStorage.getItem('mg_id_token') || '';
    const authParam = idToken
      ? `&id_token=${encodeURIComponent(idToken)}`
      : `&key=${encodeURIComponent(KEY)}`;
    const url = `${SCRIPT_URL}?action=service_history${authParam}`
              + `&client=${encodeURIComponent(clientName)}`
              + `&folderId=${encodeURIComponent(folderId)}`
              + `&_=${Date.now()}`;

    const res  = await fetch(url);
    const data = await res.json();
    if (data.error) throw new Error(data.error);

    _historyData = data;
    _historyTab  = 'notes';

    // Show tabs + search
    document.getElementById('history-tabs').style.display        = 'flex';
    document.getElementById('history-search-wrap').style.display = 'flex';

    // Update tab counts
    document.getElementById('htab-ct-notes').textContent   = data.notes.length       || '';
    document.getElementById('htab-ct-records').textContent = data.workRecords.length  || '';
    document.getElementById('htab-ct-fert').textContent    = data.fertilizers.length  || '';

    // Reset tab highlight
    document.querySelectorAll('.htab').forEach(t => t.classList.remove('active'));
    document.getElementById('htab-notes').classList.add('active');

    _renderHistoryTab();

    // Prefetch folder ID for future work record submits
    if (data.folderId && !_folderIdCache[clientName]) {
      _folderIdCache[clientName] = data.folderId;
    }

  } catch(e) {
    document.getElementById('history-body').innerHTML =
      `<div class="history-error">&#9888; Could not load history: ${esc(e.message)}</div>`;
  }
}

// ── Tab switching ─────────────────────────────────────────────
function switchHistoryTab(tab) {
  _historyTab = tab;
  document.querySelectorAll('.htab').forEach(t => t.classList.remove('active'));
  document.getElementById('htab-' + tab).classList.add('active');
  _renderHistoryTab();
}

// ── Search / filter ───────────────────────────────────────────
function filterHistory(query) {
  _historyQuery = query.toLowerCase().trim();
  document.getElementById('history-search-clear').style.display =
    _historyQuery ? '' : 'none';
  _renderHistoryTab();
}

function clearHistorySearch() {
  document.getElementById('history-search').value = '';
  filterHistory('');
}

// ── Render current tab with current search query ──────────────
function _renderHistoryTab() {
  if (!_historyData) return;
  const body = document.getElementById('history-body');
  const q    = _historyQuery;

  if (_historyTab === 'notes') {
    _renderNotes(body, q);
  } else if (_historyTab === 'records') {
    _renderWorkRecords(body, q);
  } else {
    _renderFertilizers(body, q);
  }
}

// highlight matching text in a string
function _hl(text, q) {
  if (!q || !text) return esc(text);
  const safe  = esc(text);
  const safeQ = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return safe.replace(new RegExp(`(${safeQ})`, 'gi'),
    '<mark class="hl">$1</mark>');
}

// ── Notes tab ────────────────────────────────────────────────
function _renderNotes(body, q) {
  let notes = _historyData.notes || [];
  if (q) {
    notes = notes.filter(n =>
      n.text.toLowerCase().includes(q) ||
      n.date.toLowerCase().includes(q)
    );
  }

  if (!notes.length) {
    body.innerHTML = q
      ? `<div class="history-empty">No notes match <strong>${esc(q)}</strong></div>`
      : '<div class="history-empty">No service notes found for this client.</div>';
    return;
  }

  body.innerHTML = notes.map((n, i) => `
    <div class="hn-card" id="hn-${i}" onclick="toggleNote(${i})">
      <div class="hn-header">
        <div class="hn-date">${esc(n.date)}</div>
        <div class="hn-arrow">&#8250;</div>
      </div>
      <div class="hn-body">
        <p class="hn-text">${_hl(n.text, q)}</p>
      </div>
    </div>
  `).join('');

  // Auto-expand all when searching
  if (q) {
    body.querySelectorAll('.hn-card').forEach(c => c.classList.add('open'));
  }
}

function toggleNote(i) {
  const card = document.getElementById('hn-' + i);
  if (card) card.classList.toggle('open');
}

// ── Work Records tab ─────────────────────────────────────────
function _renderWorkRecords(body, q) {
  let recs = _historyData.workRecords || [];
  if (q) {
    recs = recs.filter(r =>
      r.date.toLowerCase().includes(q)           ||
      r.team.toLowerCase().includes(q)           ||
      r.workers.toLowerCase().includes(q)        ||
      r.fertilizers.toLowerCase().includes(q)    ||
      r.materials.toLowerCase().includes(q)      ||
      r.serviceNotes.toLowerCase().includes(q)   ||
      r.internalNotes.toLowerCase().includes(q)
    );
  }

  if (!recs.length) {
    body.innerHTML = q
      ? `<div class="history-empty">No records match <strong>${esc(q)}</strong></div>`
      : '<div class="history-empty">No work records found for this client.</div>';
    return;
  }

  body.innerHTML = recs.map((r, i) => `
    <div class="hr-card open" id="hr-${i}">
      <div class="hr-header" onclick="toggleRecord(${i})">
        <div class="hr-meta">
          <span class="hr-date">${esc(r.date)}</span>
          <span class="hr-team">${esc(r.team)}</span>
          ${r.hours ? `<span class="hr-hours">${esc(r.hours)} hrs</span>` : ''}
        </div>
        ${r.serviceNotes ? `<div class="hr-preview">${_hl(r.serviceNotes.slice(0,90) + (r.serviceNotes.length > 90 ? '…' : ''), q)}</div>` : ''}
        <div class="hn-arrow">&#8250;</div>
      </div>
      <div class="hr-body">
        ${r.workers       ? `<div class="hr-row"><span class="hr-label">Crew</span><span class="hr-val">${_hl(r.workers, q)}</span></div>` : ''}
        ${r.fertilizers   ? `<div class="hr-row"><span class="hr-label">&#127807; Fertilizers</span><span class="hr-val fert-val">${_hl(r.fertilizers, q)}</span></div>` : ''}
        ${r.materials     ? `<div class="hr-row"><span class="hr-label">&#128295; Materials</span><span class="hr-val">${_hl(r.materials, q)}</span></div>` : ''}
        ${r.serviceNotes  ? `<div class="hr-row"><span class="hr-label">Service Notes</span><span class="hr-val">${_hl(r.serviceNotes, q)}</span></div>` : ''}
        ${r.internalNotes ? `<div class="hr-row"><span class="hr-label" style="color:var(--rd)">Internal</span><span class="hr-val" style="color:var(--rd)">${_hl(r.internalNotes, q)}</span></div>` : ''}
      </div>
    </div>
  `).join('');

  if (q) {
    body.querySelectorAll('.hr-card').forEach(c => c.classList.add('open'));
  }
}

function toggleRecord(i) {
  const card = document.getElementById('hr-' + i);
  if (card) card.classList.toggle('open');
}

// ── Fertilizers tab ──────────────────────────────────────────
function _renderFertilizers(body, q) {
  let entries = _historyData.fertilizers || [];
  if (q) {
    entries = entries.filter(e =>
      e.date.toLowerCase().includes(q) ||
      e.items.some(it =>
        it.name.toLowerCase().includes(q) ||
        it.qty.toLowerCase().includes(q)
      )
    );
  }

  if (!entries.length) {
    body.innerHTML = q
      ? `<div class="history-empty">No fertilizers match <strong>${esc(q)}</strong></div>`
      : '<div class="history-empty">No fertilizer records found for this client.</div>';
    return;
  }

  body.innerHTML = entries.map(e => `
    <div class="hf-entry">
      <div class="hf-date">${esc(e.date)}</div>
      <div class="hf-items">
        ${e.items.map(it => `
          <div class="hf-item">
            <span class="hf-name">${_hl(it.name, q)}</span>
            ${it.qty ? `<span class="hf-qty">${_hl(it.qty, q)}${it.unit ? ' ' + esc(it.unit) : ''}</span>` : ''}
          </div>
        `).join('')}
      </div>
    </div>
  `).join('');
}