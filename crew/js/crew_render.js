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
  const words  = lower.split(/[\s,&()+\-\/]+/).filter(w => w.length > 1);
  const scores = new Map();

  words.forEach(w => {
    // Regular word match — score 1
    (clientCache[w] || []).forEach(c => scores.set(c, (scores.get(c)||0) + 1));
    // Last-name match — score 3 (much stronger signal)
    (clientCache['last:' + w] || []).forEach(c => scores.set(c, (scores.get(c)||0) + 3));
  });

  // Fuzzy fallback: if no scores, try Levenshtein distance 1 on cache keys.
  // Handles single-character typos like "Belloti" → "Bellotti".
  // Only runs when exact matching fully fails, so no performance impact
  // on the normal path. Only checks 'last:' prefixed keys for safety —
  // matching on surname reduces false positives vs matching all words.
  if (!scores.size) {
    words.forEach(w => {
      if (w.length < 3) return;
      Object.keys(clientCache).forEach(key => {
        if (!key.startsWith('last:')) return;
        const keyWord = key.slice(5);
        if (Math.abs(keyWord.length - w.length) > 1) return;
        if (levenshtein(w, keyWord) === 1) {
          (clientCache[key] || []).forEach(c => scores.set(c, (scores.get(c)||0) + 3));
        }
      });
    });
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

