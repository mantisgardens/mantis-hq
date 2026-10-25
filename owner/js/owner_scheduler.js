// ============================================================
// owner_scheduler.js -- the owner portal's Scheduler tab.
// Weekly grid: one row per lane (Team 1/2/3, Install, Managers), one column
// per day (Mon-Fri; Sat/Sun appear only when something is scheduled).
// Repeating jobs are stored in the backend (Firestore) and appear on the
// calendar automatically. Drag a card to another day/lane to move it;
// click a card to edit, a "+" cell to add. Moving one visit never shifts
// the others (fixed schedule).
// Depends on globals from owner_dashboard.js: ownerFetch, ownerPost,
// allClients, esc, showToast.
// ============================================================
OWNER_ACTION_PATHS.schedRange   = '/owner/sched';
OWNER_ACTION_PATHS.schedCreate  = '/owner/sched/create';
OWNER_ACTION_PATHS.schedEdit    = '/owner/sched/edit';
OWNER_ACTION_PATHS.schedMove    = '/owner/sched/move';
OWNER_ACTION_PATHS.schedCancel  = '/owner/sched/cancel';
OWNER_ACTION_PATHS.schedManagers = '/owner/sched/managers';
OWNER_ACTION_PATHS.schedReminders    = '/owner/sched/reminders';
OWNER_ACTION_PATHS.schedRemindSend   = '/owner/sched/reminders/send';
OWNER_ACTION_PATHS.schedRemindSkip   = '/owner/sched/reminders/skip';
OWNER_ACTION_PATHS.schedDone    = '/owner/sched/done';
OWNER_ACTION_PATHS.schedChangeRepeat = '/owner/sched/change-repeat';

const SCHED_LANES = [
  { id: 't1', label: 'Team 1' }, { id: 't2', label: 'Team 2' }, { id: 't3', label: 'Team 3' },
  { id: 'tInstall', label: 'Install' }, { id: 'managers', label: 'Managers' },
];
const SCHED_REPEATS = [
  { v: 'none',  label: 'Does not repeat' },
  { v: 'w1',    label: 'Every week',            r: { every: 1, unit: 'week' } },
  { v: 'w2',    label: 'Every 2 weeks',         r: { every: 2, unit: 'week' } },
  { v: 'w4',    label: 'Every 4 weeks',         r: { every: 4, unit: 'week' } },
  { v: 'm1',    label: 'Monthly (same date)',   r: { every: 1, unit: 'month', monthMode: 'date' } },
  { v: 'm1n',   label: 'Monthly (same weekday, e.g. 2nd Tuesday)', r: { every: 1, unit: 'month', monthMode: 'nth' } },
  { v: 'm3',    label: 'Quarterly',             r: { every: 3, unit: 'month', monthMode: 'date' } },
  { v: 'm6',    label: 'Every 6 months',        r: { every: 6, unit: 'month', monthMode: 'date' } },
  { v: 'y1',    label: 'Yearly',                r: { every: 1, unit: 'year',  monthMode: 'date' } },
];
let SCHED_PEOPLE = ['All Managers']; // replaced by the crew-sheet managers on load

let schedMonday = null;      // 'YYYY-MM-DD' of the Monday being shown
let schedVisits = [];
let schedCrewNames = null;
let schedEditing = null;     // visit being edited, or null for new
let schedLoaded = false;

// ── date helpers (local, no time zone surprises) ─────────────
function sdParse(s) { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); }
function sdFmt(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
function sdAdd(s, n) { const d = sdParse(s); d.setDate(d.getDate() + n); return sdFmt(d); }
function sdMondayOf(s) { const d = sdParse(s); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return sdFmt(d); }
function sdLabel(s) { return sdParse(s).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }); }
function sdTime(t) { if (!t) return ''; const [h, m] = t.split(':').map(Number); return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')}${h < 12 ? 'a' : 'p'}`; }

// Start/End pickers are dropdowns in 15-minute steps (the browser's own
// clock popup ignores step and offers every minute).
function schedTimeOptions(selected) {
  let o = '<option value="">—</option>', found = !selected;
  for (let m = 5 * 60; m <= 21 * 60 + 45; m += 15) {
    const v = `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
    if (v === selected) found = true;
    o += `<option value="${v}"${v === selected ? ' selected' : ''}>${sdTime(v).replace(/([ap])$/, ' $1m').toUpperCase()}</option>`;
  }
  if (!found) o += `<option value="${selected}" selected>${selected}</option>`; // an older off-grid time stays visible
  return o;
}

async function schedInit() {
  if (!schedMonday) schedMonday = sdMondayOf(sdFmt(new Date()));
  schedLoaded = true;
  try { SCHED_PEOPLE = (await ownerFetch('schedManagers')).people || SCHED_PEOPLE; } catch (e) { /* keep default */ }
  await schedLoad();
  remLoad();
}

function schedWeek(n) { schedMonday = n === 0 ? sdMondayOf(sdFmt(new Date())) : sdAdd(schedMonday, 7 * n); schedLoad(); }

async function schedLoad() {
  const grid = document.getElementById('sch-grid');
  document.getElementById('sch-week-label').textContent = `${sdLabel(schedMonday)} – ${sdLabel(sdAdd(schedMonday, 6))}`;
  grid.innerHTML = '<div class="empty-state">Loading…</div>';
  try {
    const data = await ownerFetch('schedRange', `&from=${schedMonday}&to=${sdAdd(schedMonday, 6)}`);
    schedVisits = data.visits || [];
    schedRender();
  } catch (e) {
    grid.innerHTML = `<div class="empty-state">Could not load the scheduler: ${esc(e.message)}</div>`;
  }
}

function schedClientLabel(v) {
  return v.clientName || (v.clientId && (allClients.find(c => c['Client ID'] === v.clientId) || {})['Name(s)']) || v.title || '(no client)';
}

function schedRender() {
  const weekend = schedVisits.some(v => v.date > sdAdd(schedMonday, 4));
  const days = Array.from({ length: weekend ? 7 : 5 }, (_, i) => sdAdd(schedMonday, i));
  const today = sdFmt(new Date());
  let h = `<div class="sch-table" style="grid-template-columns: 92px repeat(${days.length}, minmax(150px, 1fr))">`;
  h += '<div class="sch-corner"></div>';
  days.forEach(d => { h += `<div class="sch-dayhead${d === today ? ' sch-today' : ''}">${esc(sdLabel(d))}</div>`; });
  SCHED_LANES.forEach(lane => {
    h += `<div class="sch-lane">${lane.label}</div>`;
    days.forEach(d => {
      const items = schedVisits.filter(v => v.lane === lane.id && v.date === d);
      h += `<div class="sch-cell${d === today ? ' sch-today' : ''}" data-date="${d}" data-lane="${lane.id}"
              ondragover="event.preventDefault();this.classList.add('sch-over')" ondragleave="this.classList.remove('sch-over')"
              ondrop="schedDrop(event,'${d}','${lane.id}')" onclick="schedCellClick(event,'${d}','${lane.id}')">`;
      items.forEach(v => { h += schedCard(v); });
      h += '<span class="sch-add" title="Add here">+</span></div>';
    });
  });
  h += '</div>';
  document.getElementById('sch-grid').innerHTML = h;
}

// Short label for the card: Weekly, Every 2 wks, Monthly, Quarterly, Yearly...
function schedFreqLabel(r) {
  if (!r) return '';
  if (r.unit === 'week') return r.every === 1 ? 'Weekly' : `Every ${r.every} wks`;
  if (r.unit === 'month') return r.every === 1 ? 'Monthly' : r.every === 3 ? 'Quarterly' : `Every ${r.every} mo`;
  if (r.unit === 'year') return r.every === 1 ? 'Yearly' : `Every ${r.every} yrs`;
  return '';
}

function schedCard(v) {
  const time = v.start ? sdTime(v.start) + (v.end ? '–' + sdTime(v.end) : '') : '';
  const who = v.lane === 'managers' ? (v.person || '') : (v.crew || []).join(', ');
  const name = v.lane === 'managers' ? (v.title || v.person) : schedClientLabel(v);
  return `<div class="sch-card${v.status === 'done' ? ' sch-done' : ''}${v.jobId ? ' sch-repeats' : ''}" draggable="true"
      ondragstart="event.dataTransfer.setData('text/plain','${esc(v.id)}')" onclick="event.stopPropagation();schedOpen('${esc(v.id)}')">
      ${time ? `<div class="sch-time">${esc(time)}</div>` : ''}
      <div class="sch-name">${esc(name)}</div>
      ${schedFreqLabel(v.repeat) ? `<span class="sch-freq" title="${esc(v.repeatText || '')}">&#8635; ${esc(schedFreqLabel(v.repeat))}</span>` : ''}
      ${v.lane !== 'managers' && v.title && v.title !== name ? `<div class="sch-sub">${esc(v.title)}</div>` : ''}
      ${v.lane !== 'managers' && !v.clientId && v.address ? `<div class="sch-sub">${esc(v.address)}</div>` : ''}
      ${who ? `<div class="sch-sub">${esc(who)}</div>` : ''}
      ${v.notes ? '<div class="sch-sub sch-note">&#128221; notes</div>' : ''}
    </div>`;
}

async function schedDrop(ev, date, lane) {
  ev.preventDefault();
  document.querySelectorAll('.sch-over').forEach(e => e.classList.remove('sch-over'));
  const id = ev.dataTransfer.getData('text/plain');
  const v = schedVisits.find(x => x.id === id);
  if (!v || (v.date === date && v.lane === lane)) return;
  try {
    if (v.lane !== lane) await ownerPost('schedEdit', { id, scope: 'this', fields: { lane } });
    if (v.date !== date) await ownerPost('schedMove', { id, date });
    await schedLoad();
  } catch (e) { showToast('Could not move: ' + e.message); schedLoad(); }
}

function schedCellClick(ev, date, lane) { schedOpen(null, date, lane); }

// ── modal ────────────────────────────────────────────────────
function schedOpen(id, date, lane) {
  schedEditing = id ? schedVisits.find(v => v.id === id) : null;
  const v = schedEditing || { date: date || schedMonday, lane: lane || 't1', crew: [], status: 'scheduled' };
  const $ = (x) => document.getElementById(x);
  $('sch-title').textContent = schedEditing ? 'Edit visit' : 'New job';
  $('sch-lane').innerHTML = SCHED_LANES.map(l => `<option value="${l.id}"${l.id === v.lane ? ' selected' : ''}>${l.label}</option>`).join('');
  $('sch-clients').innerHTML = allClients.filter(c => c['Client ID'])
    .map(c => `<option value="${esc((c['Name(s)'] || '') + ' — ' + c['Client ID'])}"></option>`).join('');
  const cl = v.clientId && allClients.find(c => c['Client ID'] === v.clientId);
  $('sch-client').value = cl ? `${cl['Name(s)'] || ''} — ${cl['Client ID']}` : (v.clientName || '');
  $('sch-client').dataset.id = v.clientId || '';
  $('sch-job-title').value = v.title || '';
  $('sch-address').value = v.address || '';
  $('sch-person').innerHTML = '<option value="">—</option>' + (v.person && !SCHED_PEOPLE.includes(v.person) ? [...SCHED_PEOPLE, v.person] : SCHED_PEOPLE).map(p => `<option${p === v.person ? ' selected' : ''}>${p}</option>`).join('');
  $('sch-date').value = v.date;
  $('sch-start').innerHTML = schedTimeOptions(v.start || '');
  $('sch-end').innerHTML = schedTimeOptions(v.end || '');
  $('sch-notes').value = v.notes || '';
  // Repeat: for a new job pick a pattern; for an existing visit it shows the
  // current pattern and changing it restarts the series from this visit.
  const cur = schedEditing && schedEditing.repeat ? schedEditing.repeat : null;
  const curMatch = cur ? SCHED_REPEATS.find(r => r.r && r.r.every === cur.every && r.r.unit === cur.unit && (r.r.monthMode || null) === (cur.monthMode || null)) : null;
  let opts = SCHED_REPEATS.map(r => `<option value="${r.v}">${esc(r.label)}</option>`).join('');
  if (cur && !curMatch) opts += `<option value="custom">${esc(schedEditing.repeatText || 'Current pattern')} (current)</option>`;
  $('sch-repeat').innerHTML = opts;
  $('sch-repeat').value = !cur ? 'none' : (curMatch ? curMatch.v : 'custom');
  $('sch-until').value = (cur && cur.until) || '';
  $('sch-repeat').dataset.orig = $('sch-repeat').value;
  $('sch-until').dataset.orig = $('sch-until').value;
  $('sch-repeat-hint').style.display = schedEditing ? '' : 'none';
  const rep = !!(schedEditing && schedEditing.jobId);
  $('sch-repeat-row').style.display = '';
  $('sch-scope-row').style.display = rep ? '' : 'none';
  document.querySelector('input[name="sch-scope"][value="this"]').checked = true;
  $('sch-btn-cancel-visit').style.display = schedEditing ? '' : 'none';
  $('sch-btn-done').style.display = schedEditing ? '' : 'none';
  $('sch-btn-done').textContent = v.status === 'done' ? 'Mark not done' : 'Mark done';
  $('sch-error').textContent = '';
  schedLaneChanged();
  $('sch-modal').classList.add('open');
}
function schedClose(ev) { if (ev && ev.target && ev.target.id !== 'sch-modal') return; document.getElementById('sch-modal').classList.remove('open'); }
function schedLaneChanged() {
  const mg = document.getElementById('sch-lane').value === 'managers';
  document.getElementById('sch-client-row').style.display = mg ? 'none' : '';
  document.getElementById('sch-address-row').style.display = mg ? 'none' : '';
  document.getElementById('sch-person-row').style.display = mg ? '' : 'none';
}
function schedScope() { const r = document.querySelector('input[name="sch-scope"]:checked'); return r ? r.value : 'this'; }

function schedReadForm() {
  const $ = (x) => document.getElementById(x);
  const typed = $('sch-client').value.trim();
  const m = typed.match(/ — (.+)$/);
  const byId = m && allClients.find(c => c['Client ID'] === m[1]);
  return {
    lane: $('sch-lane').value,
    clientId: byId ? byId['Client ID'] : '',
    clientName: byId ? (byId['Name(s)'] || '') : typed,
    title: $('sch-job-title').value.trim(),
    address: $('sch-address').value.trim(),
    person: $('sch-lane').value === 'managers' ? $('sch-person').value : '',
    start: $('sch-start').value, end: $('sch-end').value,
    notes: $('sch-notes').value,
  };
}

async function schedSave() {
  const $ = (x) => document.getElementById(x);
  const f = schedReadForm();
  const date = $('sch-date').value;
  $('sch-error').textContent = '';
  try {
    if (!schedEditing) {
      const sel = SCHED_REPEATS.find(r => r.v === $('sch-repeat').value);
      const body = { ...f, date };
      if (sel && sel.r) body.repeat = { ...sel.r, until: $('sch-until').value || null };
      await ownerPost('schedCreate', body);
    } else {
      const scope = schedScope();
      await ownerPost('schedEdit', { id: schedEditing.id, scope, fields: f });
      if (date && date !== schedEditing.date) await ownerPost('schedMove', { id: schedEditing.id, date });
      const rv = $('sch-repeat').value, un = $('sch-until').value;
      if (rv !== $('sch-repeat').dataset.orig || (rv !== 'none' && un !== $('sch-until').dataset.orig)) {
        const sel = SCHED_REPEATS.find(r => r.v === rv);
        const base = rv === 'custom' ? schedEditing.repeat : (sel && sel.r);
        await ownerPost('schedChangeRepeat', { id: schedEditing.id, repeat: base ? { ...base, until: un || null } : null });
      }
    }
    schedClose(); showToast('Saved'); await schedLoad();
  } catch (e) { $('sch-error').textContent = e.message; }
}
async function schedCancelVisit() {
  if (!schedEditing) return;
  const scope = schedScope();
  const msg = scope === 'future' && schedEditing.jobId ? 'Cancel this visit and ALL later visits of this repeating job?' : 'Cancel this visit?';
  if (!confirm(msg)) return;
  try { await ownerPost('schedCancel', { id: schedEditing.id, scope }); schedClose(); showToast('Cancelled'); await schedLoad(); }
  catch (e) { document.getElementById('sch-error').textContent = e.message; }
}
async function schedToggleDone() {
  if (!schedEditing) return;
  try { await ownerPost('schedDone', { id: schedEditing.id, done: schedEditing.status !== 'done' }); schedClose(); await schedLoad(); }
  catch (e) { document.getElementById('sch-error').textContent = e.message; }
}


// ── Client reminder emails ───────────────────────────────────
// Each time the Scheduler is opened the backend lists visits happening in the
// next three days that haven't been reminded or skipped. Nothing is sent
// until the owner checks it and presses Send.
let remData = null;

async function remLoad() {
  const b = document.getElementById('sch-remind-banner');
  try {
    remData = await ownerFetch('schedReminders');
  } catch (e) {
    b.style.display = 'none';
    return;
  }
  const n = remData.items.length, m = remData.noEmail.length;
  if (!n && !m) { b.style.display = 'none'; return; }
  b.style.display = '';
  b.innerHTML = `<span>&#9993; <b>${n}</b> client reminder${n === 1 ? '' : 's'} ready to review` +
    (m ? ` &middot; ${m} with no email on file` : '') + (remData.testMode ? ' &middot; TEST MODE' : '') + '</span>' +
    `<button class="fbtn fbtn-save" onclick="remOpen()">Review</button>`;
}

function remWhen(it) {
  const d = sdLabel(it.date) + (it.start ? ' ' + sdTime(it.start) : '');
  return `${d} (${it.daysAway === 1 ? 'tomorrow' : 'in ' + it.daysAway + ' days'})`;
}

function remOpen() {
  if (!remData) return;
  document.getElementById('rem-test').style.display = remData.testMode ? '' : 'none';
  remRender();
  document.getElementById('rem-modal').classList.add('open');
}
function remClose(ev) { if (ev && ev.target && ev.target.id !== 'rem-modal') return; document.getElementById('rem-modal').classList.remove('open'); }

function remRender() {
  const items = remData.items;
  document.getElementById('rem-list').innerHTML = items.length ? items.map((it, i) => `
    <div class="rem-card" id="rem-card-${i}">
      <label class="rem-head"><input type="checkbox" id="rem-chk-${i}"${it.defaultChecked ? ' checked' : ''} onchange="remCount()"/>
        <span><b>${esc(it.clientName)}</b> &mdash; ${esc(remWhen(it))}${it.repeatText ? ` <span class="sch-freq">&#8635; ${esc(it.repeatText)}</span>` : ''}</span></label>
      ${it.noTime ? '<div class="rem-warn">No start time is set on this visit, so the email gives the date only.</div>' : ''}
      <label class="form-label">To</label><input class="form-input" id="rem-to-${i}" value="${esc(it.to)}"/>
      <label class="form-label">Subject</label><input class="form-input" id="rem-sub-${i}" value="${esc(it.subject)}"/>
      <label class="form-label">Message (your signature is added automatically; **text** = bold)</label>
      <textarea class="form-input" id="rem-body-${i}" rows="8">${esc(it.body)}</textarea>
      <div class="rem-err" id="rem-err-${i}"></div>
      <button class="fbtn fbtn-cancel" onclick="remSkip(${i})">Skip &mdash; no reminder for this visit</button>
    </div>`).join('') : '<div class="empty-state">No reminders to review.</div>';
  const ne = remData.noEmail;
  document.getElementById('rem-noemail').innerHTML = ne.length
    ? `<div class="rem-noemail"><b>No email on file</b> (add one in the client record):<br>` +
      ne.map(n => `${esc(n.clientName)} &mdash; ${esc(sdLabel(n.date))}`).join('<br>') + '</div>' : '';
  remCount();
}

function remCount() {
  const n = remData.items.filter((_, i) => { const c = document.getElementById('rem-chk-' + i); return c && c.checked; }).length;
  const b = document.getElementById('rem-send-btn');
  b.textContent = `Send checked (${n})`;
  b.disabled = n === 0;
}

async function remSendChecked() {
  const picked = [];
  remData.items.forEach((it, i) => {
    if (document.getElementById('rem-chk-' + i).checked) picked.push({ i, visitId: it.visitId,
      to: document.getElementById('rem-to-' + i).value, subject: document.getElementById('rem-sub-' + i).value,
      body: document.getElementById('rem-body-' + i).value });
  });
  if (!picked.length) return;
  const btn = document.getElementById('rem-send-btn'); btn.disabled = true; btn.textContent = 'Sending…';
  try {
    const out = await ownerPost('schedRemindSend', { items: picked.map(({ i, ...rest }) => rest) }, 60000);
    const okIds = new Set(out.results.filter(r => r.ok).map(r => r.visitId));
    out.results.filter(r => !r.ok).forEach(r => {
      const p = picked.find(x => x.visitId === r.visitId);
      if (p) document.getElementById('rem-err-' + p.i).textContent = r.error;
    });
    const test = out.results.some(r => r.ok && r.test);
    showToast(okIds.size ? (test ? `Sent ${okIds.size} TEST email(s) to the test address` : `Sent ${okIds.size} reminder(s)`) : 'Nothing was sent');
    if (!test) { remData.items = remData.items.filter(it => !okIds.has(it.visitId)); remRender(); }
    else {
      // Test mode: nothing is recorded, so the cards stay. Mark them so it is clear the test email went out.
      picked.filter(p => okIds.has(p.visitId)).forEach(p => {
        document.getElementById('rem-chk-' + p.i).checked = false;
        const e = document.getElementById('rem-err-' + p.i); e.style.color = 'var(--g)'; e.textContent = '\u2713 Test email sent to the test address (not recorded; remove test mode to go live).';
      });
      remCount();
    }
    remLoad();
  } catch (e) { showToast('Send failed: ' + e.message); remCount(); }
}

async function remSkip(i) {
  const it = remData.items[i];
  try {
    await ownerPost('schedRemindSkip', { visitIds: [it.visitId] });
    remData.items.splice(i, 1); remRender(); remLoad();
  } catch (e) { showToast('Could not skip: ' + e.message); }
}
