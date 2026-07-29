/* =============================================================
   crew_render.js
   Mantis Gardens — Rendering Layer

   Contains:
     5.  Date helpers        (todayDateKey, isToday, updateWeekLabel, shiftWeek)
     6.  Client matching     (findClient, clientCache)
     7.  HTML escaping       (esc)
     8.  Morning Brief       (renderBrief, toggleBrief)
     9.  Job card rendering  (renderJobs, typeTag, statusIcon, calcHrs)
     10. Tabs & main render  (buildTabs, render, toggle, setSt,
                               switchTeam, toggleJobStatus, hideJob)
   ============================================================= */

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
  const words  = lower.split(/[\s,&()+\-\/\:]+/).filter(w => w.length > 1);
  const scores = new Map();

  words.forEach(w => {
    // Regular word match — score 1
    (clientCache[w] || []).forEach(c => scores.set(c, (scores.get(c)||0) + 1));
    // Last-name match — score 3 (much stronger signal)
    (clientCache['last:' + w] || []).forEach(c => scores.set(c, (scores.get(c)||0) + 3));
  });

  // Address fallback: if the event title looks like "2305 Laredo - lawn care",
  // try matching the street number + name against the Address column.
  // Requires exact number match; street name comparison is lenient about
  // suffixes (St/Street/Rd/Road etc) and allows up to 2 Levenshtein edits.
  if (!scores.size) {
    const _addrM = name.match(/^(\d+)\s+(.+?)(?:\s*[-–—]|$)/);
    if (_addrM) {
      const _evNum = _addrM[1];
      const _evStreetRaw = _addrM[2].replace(/,.*$/, '').trim();
      const _sfx = new Set(['st','street','str','ave','avenue','av','dr','drive',
        'rd','road','blvd','boulevard','way','ct','court','ln','lane',
        'cir','circle','pl','place']);
      const _normSt = s => {
        const w = s.toLowerCase().replace(/[^\w\s]/g,'').trim().split(/\s+/);
        const bare = (w.length > 1 && _sfx.has(w[w.length-1])) ? w.slice(0,-1) : w;
        return { full: w.join(' '), bare: bare.join(' ') };
      };
      const ev = _normSt(_evStreetRaw);
      sheetClients.forEach(c => {
        const dbAddr = (c['Address'] || '').trim();
        const dbNumM = dbAddr.match(/^(\d+)\s+(.+?)(?:,|$)/);
        if (!dbNumM || dbNumM[1] !== _evNum) return;
        const db = _normSt(dbNumM[2]);
        const dist = Math.min(
          levenshtein(ev.bare, db.bare),
          levenshtein(ev.bare, db.full),
          levenshtein(ev.full, db.bare),
          levenshtein(ev.full, db.full),
        );
        if (dist <= 2) scores.set(c, (scores.get(c) || 0) + 5);
      });
    }
  }

  // Fuzzy fallback: if no scores, try Levenshtein distance 1 on the surname only.
  // Handles single-character typos like "Belloti" → "Bellotti".
  // Only runs when exact matching fully fails, so no performance impact
  // on the normal path.
  //
  // We restrict to the LAST WORD of the stripped title (i.e. the surname)
  // rather than testing every token. This prevents first names and service
  // words from fuzzy-matching surnames:
  //   "Pat Mahony - aesthetic pruning" → surname "mahony" (not "pat")
  //   "2305 Laredo - lawn care" → surname "laredo" (not "care")
  //
  // STOPLIST: words that are never surnames.
  const _fuzzyStoplist = new Set([
    'care', 'lawn', 'mow', 'mowing', 'trim', 'trimming', 'clean', 'cleanup',
    'install', 'initial', 'monthly', 'quarterly', 'annual', 'biannual',
    'maintenance', 'maint', 'service', 'visit', 'work', 'job', 'crew',
    'planting', 'mulch', 'irrigation', 'sprinkler', 'check', 'repair',
    'tree', 'shrub', 'hedge', 'leaf', 'leaves', 'debris', 'blow', 'edge',
    'weed', 'spray', 'fertilize', 'aerate', 'overseed', 'prune', 'pruning',
    'road', 'street', 'drive', 'lane', 'avenue', 'boulevard', 'court', 'way',
    'aesthetic', 'general', 'special', 'full', 'deep', 'light', 'heavy',
  ]);
  if (!scores.size) {
    // Strip event-title suffix ("- aesthetic pruning", "- monthly", etc.)
    // then extract the surname:
    //   "Last, First - suffix"  → text before comma → "last"
    //   "First Last - suffix"   → last word → "last"
    const stripped    = name.replace(/\s*[-\u2013\u2014].*$/, '').trim();
    const surnameCand = (stripped.indexOf(',') !== -1)
      ? stripped.split(',')[0].trim().toLowerCase()
      : (stripped.split(/\s+/).filter(w => w.length > 1).pop() || '').toLowerCase();
    if (surnameCand.length >= 3 && !_fuzzyStoplist.has(surnameCand)) {
      Object.keys(clientCache).forEach(key => {
        if (!key.startsWith('last:')) return;
        const keyWord = key.slice(5);
        if (Math.abs(keyWord.length - surnameCand.length) > 1) return;
        if (levenshtein(surnameCand, keyWord) === 1) {
          (clientCache[key] || []).forEach(c => scores.set(c, (scores.get(c)||0) + 3));
        }
      });
    }
  }

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

  // Detect ties: if any other client shares the top score the match is
  // ambiguous. Attach a flag so the card can warn the crew member.
  const tied = [];
  scores.forEach((s, c) => { if (s === top && c !== best) tied.push(c); });
  if (tied.length) {
    const names = [best, ...tied].map(c => c['Name(s)'] || '').join(', ');
    console.log('[findClient] ambiguous match for:', name, '| tied clients:', names);
    const _candidates = [best, ...tied];
    best = Object.assign({}, best, {
      _ambiguous:           true,
      _ambiguousNames:      _candidates.map(c => c['Name(s)'] || '').filter(Boolean),
      _ambiguousCandidates: _candidates,   // full client objects for the picker
    });
  }

  return best;
}


// =============================================================
// Client overrides: stored in localStorage keyed by "YYYY-MM-DD|cardId"
// so picks persist across tab closes and page refreshes for the rest of
// that calendar day, then auto-expire the next day (different date key).
// On load, stale keys from previous days are pruned automatically.
// =============================================================

// ── Storage helpers ───────────────────────────────────────────
const _OVERRIDE_LS_KEY = 'mg_client_overrides';   // localStorage key

function _loadOverrides() {
  try {
    const raw = localStorage.getItem(_OVERRIDE_LS_KEY);
    if (!raw) return {};
    const map = JSON.parse(raw);
    // Prune any entries from previous days to keep storage clean
    const today = todayDateKey();
    let pruned = false;
    Object.keys(map).forEach(k => {
      if (!k.startsWith(today + '|')) { delete map[k]; pruned = true; }
    });
    if (pruned) localStorage.setItem(_OVERRIDE_LS_KEY, JSON.stringify(map));
    return map;
  } catch(e) { return {}; }
}

function _saveOverrides(map) {
  try {
    localStorage.setItem(_OVERRIDE_LS_KEY, JSON.stringify(map));
  } catch(e) { /* storage full — skip */ }
}

// In-memory mirror — kept in sync with localStorage.
// Keys are "YYYY-MM-DD|cardId" so choices auto-expire at end of day.
const clientOverrides = _loadOverrides();

function _overrideKey(cardId) {
  return todayDateKey() + '|' + cardId;
}


// ── No-match client locator ───────────────────────────────────
// In-memory store so we don't encode the full client list into every button onclick.
const _locatorLists = {};   // cardId → sorted client array


function _renderLocatorList(cardId, query) {
  const list = _locatorLists[cardId] || [];
  const q    = query.trim().toLowerCase();
  const hits = q
    ? list.filter(c => (c['Name(s)'] || '').toLowerCase().includes(q)
                    || (c['Address']  || '').toLowerCase().includes(q))
    : list;

  const container = document.getElementById(`amb-list-${cardId}`);
  if (!container) return;

  if (!hits.length) {
    container.innerHTML = `<div class="amb-empty">No clients match "${esc(query)}"</div>`;
    return;
  }
  // Find the "Client, Unknown" DB row — the owner adds this once as a standing
  // placeholder for jobs where the client hasn't been added yet.
  const unknownClient = sheetClients.find(c =>
    (c['Name(s)'] || '').replace(/[\s,]/g, '').toLowerCase() === 'clientunknown');
  // Ensure unknownClient is in list even if it was filtered out by search
  let unknownIdx = -1;
  if (unknownClient) {
    unknownIdx = list.indexOf(unknownClient);
    if (unknownIdx === -1) {
      list.push(unknownClient);
      unknownIdx = list.length - 1;
    }
  }

  container.innerHTML = hits.map(c => {
    const addr = c['Address'] ? `<span class="amb-addr">${esc(c['Address'])}</span>` : '';
    const idx  = list.indexOf(c);
    return `<button class="amb-pick-btn"
      onclick="resolveNoMatchClient('${cardId}',${idx});event.stopPropagation()">
      <span class="amb-name">${esc(c['Name(s)'] || 'Unknown')}</span>${addr}
    </button>`;
  }).join('') + (unknownClient ? `
  <div class="amb-divider">── Not in database ──</div>
  <button class="amb-pick-btn amb-pick-btn-unknown"
    onclick="resolveNoMatchClient('${cardId}',${unknownIdx});event.stopPropagation()">
    <span class="amb-name">&#10067; Unknown Client</span>
    <span class="amb-addr">Use if client is not yet in the database</span>
  </button>` : '');
}

function _filterLocatorList(cardId, query) {
  _renderLocatorList(cardId, query);
}


function resolveNoMatchClient(cardId, candidateIdx, candidates) {
  try {
    const list = candidates
      ? JSON.parse(decodeURIComponent(candidates))
      : (_locatorLists[cardId] || []);
    if (list && list[candidateIdx]) {
      clientOverrides[_overrideKey(cardId)] = list[candidateIdx];
      _saveOverrides(clientOverrides);
    }
  } catch(e) {
    console.warn('[resolveNoMatchClient] parse error:', e);
    return;
  }
  if (cardId.startsWith('mgr_')) {
    renderManagerPanel();
  } else {
    render();
  }
}

function clearClientOverride(cardId) {
  delete clientOverrides[_overrideKey(cardId)];
  _saveOverrides(clientOverrides);
  if (cardId.startsWith('mgr_')) {
    renderManagerPanel();
  } else {
    render();
  }
}
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
    if      (team === 't1')       { teamNotes = mb.team1_notes   || []; teamLabel = 'Team 1'; }
    else if (team === 't2')       { teamNotes = mb.team2_notes   || []; teamLabel = 'Team 2'; }
    else if (team === 't3')       { teamNotes = mb.team3_notes   || []; teamLabel = 'Team 3'; }
    else if (team === 'install')  { teamNotes = mb.install_notes  || []; teamLabel = 'Install'; }
    else if (team === 'managers') { teamNotes = mb.manager_notes  || []; teamLabel = 'Managers'; }

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

    // ── Role-based notes (Leads only) ────────────────────────
    // Manager notes are shown only on the Managers tab (handled above
    // via the teamNotes branch). They are intentionally excluded from
    // the Team 1, Team 2, and Install briefs now that managers have
    // their own dedicated tab.
    const _userCategory = (sessionStorage.getItem('mg_user_category')
                        || localStorage.getItem('mg_user_category') || '').toLowerCase();
    const _userRole     = (sessionStorage.getItem('mg_user_role')
                        || localStorage.getItem('mg_user_role')     || '').toLowerCase();
    const _isLead       = _userRole === 'lead';

    if (_isLead) {
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
          const hoursStr = t.hours ? ` (${esc(t.hours)})` : '';
          body += `<div class="note-item"><strong>${esc(t.name)}</strong> &mdash; ${esc(t.dates)}${hoursStr}</div>`;
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
  sessionStorage.setItem('mg_brief_open', JSON.stringify(briefOpen));
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
    // Store the resolved sheet client back on the job object so openWorkRecord
    // and collectFormData can use Drive Folder ID / Hist Data ID directly
    // without re-running the lookup — and without depending on currentDay being
    // correct at the moment the Work Record button is tapped.
    if (sc && !sc._ambiguous) j._sc = sc;
    const isExp  = expanded[j.id];
    const card   = document.createElement('div');
    card.className = `job-card ${isLoad ? 'load-in' : teamClass}${isExp ? ' expanded' : ''}`;

    const clientBlock = (isExp && !isLoad) ? buildClientBlock(j.id, sc, j.description, j.title, j.client) : '';

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
            ${(clientOverrides[_overrideKey(j.id)] || (sc && !sc._ambiguous)) ? '<span class="tag tag-live">&#9679; live</span>' : ''}
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
                    onclick="openHistoryForClient('${encodeURIComponent(j.client||'')}','${j.id}');event.stopPropagation()">
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

    // If this card has a pending client picker list (ambiguous or no-match),
    // render it now — the container div is in the DOM so getElementById works.
    if (_locatorLists[j.id]) {
      _renderLocatorList(j.id, '');
    }
  });
}


// =============================================================
// SECTION 11 — MANAGER PANEL RENDERING
// renderManagerPanel() builds the Managers tab content for the
// selected day. Shows three stacked accordions (Ashley, Brooke,
// Manager General) — stacked layout works well on phones, avoids
// cramped three-column layout on small screens.
//
// Client events → attempt findClient() lookup, render full card.
// Generic events → compact card showing time + title only.
// =============================================================

function renderManagerPanel() {
  const el = document.getElementById('managers-jobs');
  if (!el) return;

  // Morning brief for managers
  renderBrief('brief-managers', 'managers');

  // Update the header meta line with live names from the Crew Info sheet.
  // The sheet lists: Brooke Wolf, Ashley Manning, David Hvidsten, Mike Hvidsten
  // under a "Managers" section header — all four are returned in crewTeams.managers.
  const metaEl = document.getElementById('managers-meta');
  if (metaEl) {
    const names = crewTeams.managers || [];
    metaEl.textContent = names.length ? names.join(' · ') : 'Managers';
  }

  const dayData = currentDay && MANAGER_SCHEDULE
    ? (MANAGER_SCHEDULE.days || {})[currentDay] || { ashley: [], brooke: [], mgr: [] }
    : { ashley: [], brooke: [], mgr: [] };

  if (!MANAGER_SCHEDULE) {
    el.innerHTML = '<div class="empty">Manager schedule loading…</div>';
    return;
  }

  const streams = [
    { key: 'ashley', label: 'Ashley',       icon: '&#128100;', events: dayData.ashley || [], workerName: (crewTeams.managers || []).find(n => n.toLowerCase().includes('ashley')) || 'Ashley' },
    { key: 'brooke', label: 'Brooke',       icon: '&#128100;', events: dayData.brooke || [], workerName: (crewTeams.managers || []).find(n => n.toLowerCase().includes('brooke')) || 'Brooke' },
    { key: 'mgr',    label: 'All Managers', icon: '&#128203;', events: dayData.mgr    || [], workerName: '' },
  ];

  let html = '';

  streams.forEach(stream => {
    const storeKey  = 'mgr_acc_' + stream.key;
    const isOpen    = sessionStorage.getItem(storeKey) !== 'closed';
    const totalHrs  = calcHrs(stream.events);
    const evtCount  = stream.events.length;

    html += `
    <div class="mgr-stream">
      <div class="mgr-stream-header" onclick="toggleMgrStream('${stream.key}')">
        <span class="mgr-stream-icon">${stream.icon}</span>
        <span class="mgr-stream-name">${stream.label}</span>
        <span class="mgr-stream-meta">${evtCount ? evtCount + ' event' + (evtCount !== 1 ? 's' : '') + ' &middot; ' + totalHrs : 'No events'}</span>
        <span class="mgr-stream-arrow${isOpen ? ' open' : ''}">&#8250;</span>
      </div>
      <div class="mgr-stream-body${isOpen ? '' : ' hidden'}">`;

    if (!stream.events.length) {
      html += '<div class="empty" style="padding:12px 16px">No events scheduled</div>';
    } else {
      stream.events.forEach(ev => {
        const isClientEv = ev.type === 'client';
        const sc         = isClientEv ? findClient(ev.clientCandidate || ev.title) : null;
        const isExp      = expanded['mgr_' + ev.id];

        // Render each event — client events use the full Team 1/2 card format;
        // generic events get a compact card.
        const cardCls = isClientEv ? 'mgr-client-card' : 'mgr-generic-card';

        const clientBlock = (isExp && isClientEv) ? buildClientBlock('mgr_' + ev.id, sc, ev.description, ev.title, ev.client) : '';

        // Action buttons — identical to Team 1/2 cards.
        // WR button passes the worker name so the form pre-fills it.
        const workerNameEsc = esc(stream.workerName || '');
        const actionRow = isClientEv ? `
          <div class="action-row">
            <button class="abtn ${statuses['mgr_'+ev.id]==='done'?'abtn-done':'abtn-prog abtn-status'}"
                    onclick="toggleMgrJobStatus('${ev.id}');event.stopPropagation()">
              ${statuses['mgr_'+ev.id]==='done' ? '&#10003; Done' : statuses['mgr_'+ev.id]==='inprogress' ? '&#9654; In progress' : '&#9654; In progress'}
            </button>
            <button class="abtn abtn-history"
                    onclick="openHistoryForClient('${encodeURIComponent(ev.clientCandidate||ev.title||'')}','mgr_${ev.id}');event.stopPropagation()">
              &#128196; Historical Data
            </button>
            ${stream.workerName ? `<button class="abtn" id="wr-btn-mgr_${ev.id}"
                    style="background:var(--b3);color:var(--b);border-color:var(--b4)"
                    onclick="openMgrWorkRecord('${ev.id}','${workerNameEsc}');event.stopPropagation()">
              &#128203; Create Work Record
            </button>` : ''}
            <button class="abtn abtn-hide" onclick="toggleMgrCard('${ev.id}');event.stopPropagation()">&#8722; Minimize</button>
          </div>` : `
          <div class="action-row">
            <button class="abtn abtn-hide" onclick="toggleMgrCard('${ev.id}');event.stopPropagation()">&#8722; Minimize</button>
          </div>`;

        html += `
        <div class="job-card ${cardCls}${isExp ? ' expanded' : ''}" data-card-id="mgr_${ev.id}">
          <div class="job-top" onclick="toggleMgrCard('${ev.id}')">
            <div class="jtc">
              <div class="jtime">${ev.allDay ? 'All day' : esc(ev.time)}</div>
              <div class="jdur">${esc(ev.dur)}</div>
            </div>
            <div class="vline"></div>
            <div class="jinfo">
              <div class="jclient">${esc(ev.title)}${statuses['mgr_'+ev.id]==='done' ? ' ✅' : statuses['mgr_'+ev.id]==='inprogress' ? ' ὐ4' : ''}</div>
              <div class="jtags">
                ${isClientEv ? '<span class="tag tag-mo">Client</span>' : '<span class="tag" style="background:var(--bg2);color:var(--ink2)">General</span>'}
                ${(clientOverrides[_overrideKey('mgr_'+ev.id)] || (sc && !sc._ambiguous)) ? '<span class="tag tag-live">&#9679; live</span>' : ''}
                ${ev.warn ? '<span class="tag tag-warn">&#9888;</span>' : ''}
              </div>
            </div>
          </div>
          <div class="job-body">
            ${ev.warn ? `<div class="drow"><span class="dlabel">Alert</span><span class="dval warn">${esc(ev.warn)}</span></div>` : ''}
            ${!ev.allDay && isExp ? `<div class="drow"><span class="dlabel">Time</span><span class="dval">${esc(ev.time)} &ndash; ${esc(ev.end)} (${esc(ev.dur)})</span></div>` : ''}
            ${clientBlock}
            ${isExp ? actionRow : ''}
          </div>
        </div>`;
      });
    }

    html += `</div></div>`; // close mgr-stream-body and mgr-stream
  });

  el.innerHTML = html;

  // Render any pending client picker lists — manager cards use innerHTML so
  // the container divs only exist in the DOM after the assignment above.
  Object.keys(_locatorLists).forEach(cardId => {
    if (cardId.startsWith('mgr_')) _renderLocatorList(cardId, '');
  });
}

function toggleMgrStream(key) {
  const storeKey = 'mgr_acc_' + key;
  const isOpen   = sessionStorage.getItem(storeKey) !== 'closed';
  sessionStorage.setItem(storeKey, isOpen ? 'closed' : 'open');
  renderManagerPanel();
}

function toggleMgrCard(evId) {
  expanded['mgr_' + evId] = !expanded['mgr_' + evId];
  renderManagerPanel();
}

function toggleMgrJobStatus(evId) {
  const key     = 'mgr_' + evId;
  const current = statuses[key] || 'pending';
  statuses[key] = current === 'inprogress' ? 'pending' : 'inprogress';
  renderManagerPanel();
}
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
    const day   = SCHEDULE[d] || { t1:[], t2:[], t3:[], tInstall:[] };
    const total = (day.t1||[]).length + (day.t2||[]).length + (day.t3||[]).length + (day.tInstall||[]).length;
    const tab   = document.createElement('div');
    tab.className = `day-tab${d === currentDay ? ' active' : ''}`;
    tab.innerHTML = DAY_LABELS[i]
      + (isToday(d) ? '<span class="today-badge">TODAY</span>' : '')
      + `<span class="dcnt">${total}</span>`;
    tab.onclick = () => { currentDay = d; render(); };
    el.appendChild(tab);
  });
}

function toggle(id) {
  expanded[id] = !expanded[id];
  render();
}
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

  const d   = currentDay ? (SCHEDULE[currentDay] || { t1:[], t2:[], t3:[], tInstall:[] }) : { t1:[], t2:[], t3:[], tInstall:[] };
  renderJobs('t1-jobs', d.t1, 't1-card');
  renderJobs('t2-jobs', d.t2, 't2-card');
  renderJobs('t3-jobs', d.t3, 't3-card');
  renderJobs('install-jobs', d.tInstall, 'install-card');
  renderBrief('brief-t1', 't1');
  renderBrief('brief-t2', 't2');
  renderBrief('brief-t3', 't3');
  renderBrief('brief-install', 'install');

  // Manager panel — only rendered if the panel exists in the DOM
  if (document.getElementById('managers-jobs')) {
    renderManagerPanel();
  }

  document.getElementById('t1-hrs').textContent = calcHrs(d.t1);
  document.getElementById('t2-hrs').textContent = calcHrs(d.t2);
  document.getElementById('t3-hrs').textContent = calcHrs(d.t3);
  document.getElementById('install-hrs').textContent = calcHrs(d.tInstall);

  const all   = [...(d.t1||[]),...(d.t2||[]),...(d.t3||[]),...(d.tInstall||[])].filter(j => j.type !== 'load-in');
  const prog      = all.filter(j => statuses[j.id] === 'inprogress').length;
  const submitted = all.filter(j => savedRecords[j.id] && savedRecords[j.id].submitted).length;
  let fh = 0;
  [...(d.t1||[]),...(d.t2||[]),...(d.t3||[]),...(d.tInstall||[])].forEach(j => {
    const m = j.dur.match(/([\d.]+)/); if (m) fh += parseFloat(m[1]);
  });

  // Restore active team tab (re-render resets DOM)
  switchTeam(activeTeam);

  document.getElementById('summary-bar').innerHTML = `
    <div class="sitem"><span class="snum k">${all.length}</span>&nbsp;jobs today</div>
    <div class="sitem"><span class="snum a">${prog}</span>&nbsp;in progress</div>
    <div class="sitem"><span class="snum b">${submitted}</span>&nbsp;submitted</div>
    <div class="sitem" style="margin-left:auto"><span class="snum k">${fh}</span>&nbsp;field hrs</div>`;

  // Scroll the active day tab into view within the tab strip.
  // We set scrollLeft on the #day-tabs container directly rather than
  // calling scrollIntoView() on the tab, because scrollIntoView uses
  // the browser's full scroll algorithm which moves the page vertically
  // as a side effect — jumping the user back to the top when they've
  // scrolled down to a job card.
  setTimeout(() => {
    const strip = document.getElementById('day-tabs');
    const active = strip && strip.querySelector('.day-tab.active');
    if (!strip || !active) return;
    const tabLeft   = active.offsetLeft;
    const tabRight  = tabLeft + active.offsetWidth;
    const stripLeft = strip.scrollLeft;
    const stripRight = stripLeft + strip.clientWidth;
    // Only scroll if the tab isn't already fully visible
    if (tabLeft < stripLeft) {
      strip.scrollTo({ left: tabLeft - 16, behavior: 'smooth' });
    } else if (tabRight > stripRight) {
      strip.scrollTo({ left: tabRight - strip.clientWidth + 16, behavior: 'smooth' });
    }
  }, 50);
}

// ── buildClientBlock ──────────────────────────────────────────
// Shared by renderJobs and renderManagerPanel. Builds the expanded
// client detail HTML for a single card, handling three states:
//   1. Override chosen — show full live data + "× change" link
//   2. Ambiguous       — show picker buttons, one per candidate
//   3. Normal match    — show full live data
//   4. No match        — show "no match" fallback
// cardId   = stable key used in clientOverrides (job id or mgr event id)
// sc       = result from findClient() — may have _ambiguous flag
// description  = calendar event description (for Cal notes row)
// rawTitle     = the untouched calendar event title, before "CI - " /
//                trailing-suffix / address stripping (for name lookup)
// matchedName  = the cleaned name used for the lookup (job.client) —
//                shown for comparison so it's clear what's cut off
function buildClientBlock(cardId, sc, description, rawTitle, matchedName) {
  // Use an override if the user already picked one
  const resolved = clientOverrides[_overrideKey(cardId)] || (sc && !sc._ambiguous ? sc : null);

  let html = '';

  if (resolved) {
    // ── Confirmed client ───────────────────────────────────
    const changeLink = clientOverrides[_overrideKey(cardId)]
      ? ` <a href="#" style="font-size:10px;color:var(--ink3);text-decoration:underline;margin-left:8px"
             onclick="clearClientOverride('${cardId}');event.preventDefault()">&#215; change</a>`
      : '';
    html += `
      <div class="client-detail">
        <div class="cd-hdr"><div class="live-dot"></div>Live from Google Sheets${changeLink}</div>
        ${resolved['Name(s)']               ? `<div class="drow"><span class="dlabel">Client</span><span class="dval">${esc(resolved['Name(s)'])}</span></div>` : ''}
        ${resolved['Address']               ? `<div class="drow"><span class="dlabel">Address</span><span class="dval">${esc(resolved['Address'])}</span></div>` : ''}
        ${(resolved['Phone']||resolved['Phone number(s)']) ? `<div class="drow"><span class="dlabel">Phone</span><span class="dval"><a class="phone-a" href="tel:${esc(resolved['Phone']||resolved['Phone number(s)'])}">${esc(resolved['Phone']||resolved['Phone number(s)'])}</a></span></div>` : ''}
        ${(resolved['Visit Interval']||resolved['Visit interval']) ? `<div class="drow"><span class="dlabel">Interval</span><span class="dval">${esc(resolved['Visit Interval']||resolved['Visit interval'])}</span></div>` : ''}
        ${resolved['Labor Hours']           ? `<div class="drow"><span class="dlabel">Est. hours</span><span class="dval">${esc(resolved['Labor Hours'])}</span></div>` : ''}
        ${(resolved['Scheduling Notes']||resolved['Scheduling notes']) ? `<div class="drow"><span class="dlabel">Scheduling</span><span class="dval">${esc(resolved['Scheduling Notes']||resolved['Scheduling notes'])}</span></div>` : ''}
        ${resolved['General Service Notes'] ? `<div class="drow"><span class="dlabel">Notes</span><span class="dval note">${esc(resolved['General Service Notes'])}</span></div>` : ''}
        ${(resolved['Gate / Access']||resolved['Gate/Access']) ? `<div class="drow"><span class="dlabel">Gate</span><span class="dval">${esc(resolved['Gate / Access']||resolved['Gate/Access'])}</span></div>` : ''}
        ${resolved['Dogs / Animals']        ? `<div class="drow"><span class="dlabel">Dogs</span><span class="dval">${esc(resolved['Dogs / Animals'])}</span></div>` : ''}
      </div>`;

  } else if (sc && !sc._ambiguous) {
    // ── Single unambiguous match ───────────────────────────
    // (Shouldn't reach here via buildClientBlock but kept as safety)
    html += `<div class="drow"><span class="dlabel">Sheet</span><span class="dval" style="color:var(--ink3);font-size:11px">Matched</span></div>`;

  } else {
    // ── Ambiguous or no match — same search picker ────────
    const hdr = sheetClients.length ? '&#10067; Client not matched' : 'Load sheets to see client detail';
    html += `<div class="client-detail client-detail-ambiguous">
      <div class="cd-hdr cd-hdr-warn">${hdr}</div>
      ${sheetClients.length ? `
      <input class="amb-search" type="text"
             placeholder="Type client name to search…"
             oninput="_filterLocatorList('${cardId}', this.value)"
             onclick="event.stopPropagation()"/>
      <div class="amb-list" id="amb-list-${cardId}"></div>` : ''}
    </div>`;
    if (sheetClients.length) {
      _locatorLists[cardId] = [...sheetClients]
        .sort((a, b) => (a['Name(s)'] || '').localeCompare(b['Name(s)'] || ''));
    }
  }

  if (rawTitle && rawTitle.trim() && rawTitle.trim().toLowerCase() !== (matchedName||'').trim().toLowerCase()) {
    html += `<div class="drow"><span class="dlabel">Cal title</span><span class="dval note">${esc(rawTitle)}</span></div>`;
  }

  if (description && description.trim()) {
    html += `<div class="drow"><span class="dlabel">Cal notes</span><span class="dval note">${esc(description)}</span></div>`;
  }

  return html;
}


