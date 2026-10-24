/* =============================================================
   crew_timecard.js
   Mantis Gardens — Time Card Logic

   API CONTRACT (backend not built yet — see chat/build notes):
     GET  /timecard/summary   -> { clockedIn, since, onMealBreak,
                                    mealSince, todayMinutes, weekMinutes,
                                    history: [{date, minutes, flagged}] }
     POST /timecard/punch     body: { type: 'clock_in'|'clock_out'
                                             |'meal_out'|'meal_in' }
                               -> { ok: true } or { error }

   Both routes are crew write/read paths for the CURRENT signed-in
   person only (identified server-side via their auth token, same as
   every other crew route) — no employee ID is ever sent from the
   client.

   GPS: every punch also sends { gps } -- the phone's position at the
   moment of the tap, or { status } if location was refused/unavailable
   (see getGpsFix()). It never blocks a punch.

   SCOPE NOTE: clock-out here is a plain confirm() dialog. The
   California meal/rest-break attestation flow (mandatory Yes/No
   prompts, reason codes, premium-pay flagging) is NOT implemented —
   see confirmClockOut() below for the marked insertion point once
   the compliance approach is decided.
   ============================================================= */

// ── Auth guard — redirect to login if not signed in ─────────────
if (sessionStorage.getItem('mg_auth') !== '1') {
  window.location.href = 'index.html';
} else {
  initSessionTimeout({
    timeoutMs:  4 * 60 * 60 * 1000,
    warningMs:  5 * 60 * 1000,
    sessionKey: 'mg_auth',
    loginUrl:   'index.html',
    onSignOut:  () => { sessionStorage.clear(); },
  });
}

const SCRIPT_URL = (typeof MANTIS_CONFIG !== 'undefined') ? MANTIS_CONFIG.SCRIPT_URL : '';

// Same sessionStorage-then-localStorage fallback pattern as
// crew_api.js's apiFetch() — mobile browsers clear sessionStorage on
// a backgrounded-tab restore even though the token itself is still
// valid for up to an hour.
function getIdToken() {
  let token = sessionStorage.getItem('mg_id_token') || '';
  if (!token) {
    const lsToken  = localStorage.getItem('mg_id_token') || '';
    const lsExpiry = parseInt(localStorage.getItem('mg_id_token_expiry') || '0');
    if (lsToken && Date.now() < lsExpiry) {
      sessionStorage.setItem('mg_id_token', lsToken);
      token = lsToken;
    }
  }
  return token;
}

let _state = null; // last-loaded summary response
let _loadedAt = 0;  // device time when _state arrived; live counters add the minutes since
let _busy  = false; // true while a punch POST is in flight -- blocks double-taps

function esc(s) {
  return String(s || '')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function showToast(msg) {
  const t = document.getElementById('tc-toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2600);
}

function fmtHours(minutes) {
  if (minutes == null) return '\u2014';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${h}h ${m}m`;
}

function fmtTime(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

function fmtDate(iso) {
  if (!iso) return '';
  return new Date(iso + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

// ── Load + render ────────────────────────────────────────────
async function loadSummary() {
  const token = getIdToken();
  if (!token || !SCRIPT_URL) return;
  try {
    const res = await fetch(`${SCRIPT_URL}/timecard/summary?id_token=${encodeURIComponent(token)}`);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    _state = await res.json();
    _loadedAt = Date.now();
    render();
  } catch (e) {
    console.warn('loadSummary failed:', e.message);
    document.getElementById('tc-history-list').innerHTML =
      `<div class="tc-empty-state">Could not load time card data. Pull down to try again.</div>`;
  }
}

function render() {
  if (typeof renderEditDates === 'function' && !document.getElementById('tc-fix-date').options.length) renderEditDates();
  if (!_state) return;
  renderStatusCard();
  renderSummaryRow();
  renderHistory();
}

function renderStatusCard() {
  const btn      = document.getElementById('tc-clock-btn');
  const label    = document.getElementById('tc-status-label');
  const since    = document.getElementById('tc-status-since');
  const mealRow  = document.getElementById('tc-meal-row');
  const mealBtn  = document.getElementById('tc-meal-btn');

  if (_state.clockedIn) {
    btn.textContent = 'Clock Out';
    btn.className = 'tc-clock-btn out';
    label.textContent = _state.onMealBreak ? 'On Meal Break' : 'Clocked In';
    since.textContent = _state.since ? `Since ${fmtTime(_state.since)}` : '';
    mealRow.style.display = '';
    if (_state.onMealBreak) {
      mealBtn.textContent = 'End Meal Break';
      mealBtn.classList.add('active');
    } else if (_state.mealTaken) {
      // Meal break finished: one per shift. Stays greyed out until the
      // final clock-out; the next clock-in starts a fresh shift.
      mealBtn.textContent = 'Meal Break Over';
      mealBtn.classList.remove('active');
    } else {
      mealBtn.textContent = 'Start Meal Break';
      mealBtn.classList.remove('active');
    }
  } else {
    btn.textContent = 'Clock In';
    btn.className = 'tc-clock-btn in';
    label.textContent = 'Not Clocked In';
    since.textContent = '';
    mealRow.style.display = 'none';
  }
  btn.disabled = _busy;
  mealBtn.disabled = _busy || (_state.clockedIn && !_state.onMealBreak && !!_state.mealTaken);
}

function renderSummaryRow() {
  // Counters tick live: the server totals were correct when loaded, and
  // while working (not on a meal break) every whole minute since then adds
  // to both. On a meal break the work totals stand still and the meal
  // box counts instead.
  const live = (_state.clockedIn && !_state.onMealBreak) ? Math.max(0, Math.floor((Date.now() - _loadedAt) / 60000)) : 0;
  document.getElementById('tc-today-hours').textContent = fmtHours(_state.todayMinutes == null ? null : _state.todayMinutes + live);
  document.getElementById('tc-week-hours').textContent  = fmtHours(_state.weekMinutes == null ? null : _state.weekMinutes + live);
  const mealBox = document.getElementById('tc-meal-card');
  if (_state.clockedIn && _state.onMealBreak && _state.mealSince) {
    const mins = Math.max(0, Math.floor((Date.now() - new Date(_state.mealSince).getTime()) / 60000));
    document.getElementById('tc-meal-elapsed').textContent = fmtHours(mins);
    mealBox.style.display = '';
  } else {
    mealBox.style.display = 'none';
  }
}

// Refresh the on-screen counters every 15 s (they change once a minute),
// and re-sync with the server whenever the page comes back to the front
// (a phone that slept would otherwise show stale numbers).
setInterval(() => { if (_state && !document.hidden) renderSummaryRow(); }, 15000);
document.addEventListener('visibilitychange', () => { if (!document.hidden && _state) loadSummary(); });

function renderHistory() {
  const el = document.getElementById('tc-history-list');
  const days = _state.history || [];
  if (!days.length) {
    el.innerHTML = `<div class="tc-empty-state">No time card history yet.</div>`;
    return;
  }
  el.innerHTML = days.map(d => `
    <div class="tc-history-row">
      <div class="tc-history-date">${esc(fmtDate(d.date))}</div>
      <div>
        <span class="tc-history-hours">${esc(fmtHours(d.minutes))}</span>
        ${d.flagged ? '<span class="tc-history-flag">Review</span>' : ''}
      </div>
    </div>
  `).join('');
}

// ── Actions ──────────────────────────────────────────────────
// ── GPS ──────────────────────────────────────────────────────
// Asks the phone for its position at the moment a punch button is
// tapped (never in the background). ALWAYS resolves -- a refused,
// failed or slow location request must not stop anyone from clocking
// in or out, so the punch is sent with a status saying why there is no
// fix instead. Fresh fix only (maximumAge 0); 8 s cap.
function getGpsFix() {
  return new Promise(resolve => {
    if (!navigator.geolocation) { resolve({ status: 'unavailable' }); return; }
    let done = false;
    const finish = v => { if (!done) { done = true; resolve(v); } };
    // Safety net in case the browser never calls back at all.
    setTimeout(() => finish({ status: 'timeout' }), 9000);
    try {
      navigator.geolocation.getCurrentPosition(
        pos => finish({ lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy }),
        err => finish({ status: err && err.code === 1 ? 'denied' : (err && err.code === 3 ? 'timeout' : 'unavailable') }),
        { enableHighAccuracy: true, timeout: 8000, maximumAge: 0 }
      );
    } catch (e) { finish({ status: 'unavailable' }); }
  });
}

async function sendPunch(type, extra) {
  if (_busy) return;
  _busy = true;
  render();
  try {
    const gps = await getGpsFix();
    extra = Object.assign({}, extra || {}, { gps });
    const token = getIdToken();
    const res = await fetch(`${SCRIPT_URL}/timecard/punch?id_token=${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({ type }, extra || {})),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json.error) throw new Error(json.error || ('HTTP ' + res.status));
    await loadSummary();
  } catch (e) {
    showToast('Could not save: ' + e.message);
  } finally {
    _busy = false;
    render();
  }
}

// ── Break attestation flow ──────────────────────────────────
// See the compliance research this was drafted from (shared
// separately) for the reasoning behind each choice here: mandatory
// unselected Yes/No (never pre-checked), a reason code required on
// "No", and a certification step before the clock-out actually
// completes. This is real and wired to real data (see timeCard.js on
// the backend) so what gets evaluated is the genuine flow -- but see
// this page's top-of-file comment for what's still missing before it
// could be relied on for actual payroll.
let _attest = null; // { meal: {answer, reason, notes}, rest: {answer, reason, notes} }

function handleClockButton() {
  if (!_state) return;
  if (_state.clockedIn) {
    confirmClockOut();
  } else {
    sendPunch('clock_in');
    showToast('Clocked in \u2713');
  }
}

function confirmClockOut() {
  if (_state.onMealBreak) {
    showToast('End your meal break before clocking out.');
    return;
  }
  startAttestation(null);
}

// Opens the break-attestation modal. `context` is null for a normal
// clock-out, or a sentence such as "Certifying for Tuesday, October 20"
// when the questions are being answered for an edited past day.
function startAttestation(context) {
  const ctxEl = document.getElementById('tc-attest-context');
  ctxEl.textContent = context || '';
  ctxEl.style.display = context ? '' : 'none';
  _attest = { meal: { answer: null, reason: null, notes: '' }, rest: { answer: null, reason: null, notes: '' } };
  document.getElementById('tc-meal-notes').value = '';
  document.getElementById('tc-rest-notes').value = '';
  document.getElementById('tc-meal-reason-continue').disabled = true;
  document.getElementById('tc-rest-reason-continue').disabled = true;
  document.querySelectorAll('.tc-attest-choice.selected').forEach(el => el.classList.remove('selected'));
  goToStep('meal');
  document.getElementById('tc-attest-modal').classList.add('open');
}

function cancelClockOut() {
  document.getElementById('tc-attest-modal').classList.remove('open');
  _attest = null;
  _pendingEdit = null;   // abandon a pending day edit too
}

function goToStep(step) {
  ['meal', 'meal-reason', 'rest', 'rest-reason', 'certify'].forEach(s => {
    document.getElementById('tc-step-' + s).style.display = (s === step) ? '' : 'none';
  });
  if (step === 'certify') renderAttestSummary();
}

// "Yes" advances straight to the next question; "No" opens that
// section's reason-code step instead of advancing, matching the
// source document's requirement that a missed break always gets a
// reason attached, not just a bare "No".
function attestAnswer(section, yes) {
  _attest[section].answer = yes;
  if (yes) {
    goToStep(section === 'meal' ? 'rest' : 'certify');
  } else {
    goToStep(section + '-reason');
  }
}

function attestReason(section, code, btnEl) {
  _attest[section].reason = code;
  const stepEl = document.getElementById('tc-step-' + section + '-reason');
  stepEl.querySelectorAll('.tc-attest-choice').forEach(el => el.classList.remove('selected'));
  btnEl.classList.add('selected');
  document.getElementById('tc-' + section + '-reason-continue').disabled = false;
}

const REASON_LABELS = {
  employer_operational_demand: 'The job site/work required it',
  employee_voluntary: 'Voluntarily skipped',
  employer_interrupted: 'Cut short / interrupted',
};
// Reasons attributable to the employer trigger a premium-pay flag,
// per the source document's "Trigger Flag for Premium Pay" logic --
// capped at one meal premium + one rest premium per day.
const EMPLOYER_FAULT_REASONS = ['employer_operational_demand', 'employer_interrupted'];

function renderAttestSummary() {
  document.getElementById('tc-meal-notes').oninput = (e) => { _attest.meal.notes = e.target.value; };
  document.getElementById('tc-rest-notes').oninput = (e) => { _attest.rest.notes = e.target.value; };

  const lines = [];
  lines.push(`Meal break: ${_attest.meal.answer ? 'Provided' : 'Missed'}` +
    (!_attest.meal.answer ? ` (${REASON_LABELS[_attest.meal.reason] || 'no reason given'})` : ''));
  lines.push(`Rest break: ${_attest.rest.answer ? 'Provided' : 'Missed'}` +
    (!_attest.rest.answer ? ` (${REASON_LABELS[_attest.rest.reason] || 'no reason given'})` : ''));

  const premiumCount =
    (!_attest.meal.answer && EMPLOYER_FAULT_REASONS.includes(_attest.meal.reason) ? 1 : 0) +
    (!_attest.rest.answer && EMPLOYER_FAULT_REASONS.includes(_attest.rest.reason) ? 1 : 0);
  if (premiumCount) {
    lines.push(`<span class="flag">\u26a0 ${premiumCount} hour${premiumCount > 1 ? 's' : ''} of premium pay will be flagged for review.</span>`);
  }
  // Built entirely from static labels/booleans above -- no raw user
  // text (e.g. the notes fields) is interpolated here, so no HTML
  // escaping is needed for this particular innerHTML assignment.
  document.getElementById('tc-attest-summary').innerHTML = lines.join('<br>');
}

function submitClockOut() {
  document.getElementById('tc-attest-modal').classList.remove('open');
  if (_pendingEdit) {            // finishing a day edit, not a live clock-out
    const edit = _pendingEdit;
    _pendingEdit = null;
    sendEditDay(edit, _attest);
    _attest = null;
    return;
  }
  const payload = { attestation: _attest };
  sendPunch('clock_out', payload);
  showToast('Clocked out \u2713');
  _attest = null;
}

function handleMealButton() {
  if (!_state || !_state.clockedIn) return;
  sendPunch(_state.onMealBreak ? 'meal_in' : 'meal_out');
}

// ── Fix a day (edit my own punches) ─────────────────────────
// The person edits the COMPLETE list of punches for one day. The server
// keeps the originals, records the reason, and tells the owner. If the
// edited day ends with a clock out, the break questions are asked again.
let _pendingEdit = null;   // { date, punches, reason } awaiting the attestation
let _editDate = null;
const EDIT_TYPES = [
  ['clock_in', 'Clock in'], ['meal_out', 'Meal start'], ['meal_in', 'Meal end'], ['clock_out', 'Clock out'],
];

function fmtLongDate(iso) {
  return new Date(iso + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
}

function renderEditDates() {
  const sel = document.getElementById('tc-fix-date');
  const dates = (_state && _state.editableDates) || [];
  sel.innerHTML = dates.map((d, i) => `<option value="${esc(d)}">${i === 0 ? 'Today \u2014 ' : ''}${esc(fmtLongDate(d))}</option>`).join('');
}

function editRowHtml(type, time) {
  const opts = EDIT_TYPES.map(([v, l]) => `<option value="${v}"${v === type ? ' selected' : ''}>${l}</option>`).join('');
  return `<div class="tc-edit-row">
    <select class="tc-edit-type">${opts}</select>
    <input class="tc-edit-time" type="time" value="${esc(time || '')}" step="60"/>
    <button class="tc-edit-remove" onclick="this.parentNode.remove()" aria-label="Remove this punch">&#10005;</button>
  </div>`;
}

function addEditRow(type, time) {
  document.getElementById('tc-edit-rows').insertAdjacentHTML('beforeend', editRowHtml(type || 'clock_in', time || ''));
}

async function openEditDay() {
  const date = document.getElementById('tc-fix-date').value;
  if (!date) return;
  try {
    const res = await fetch(`${SCRIPT_URL}/timecard/day?date=${encodeURIComponent(date)}&id_token=${encodeURIComponent(getIdToken())}`);
    const info = await res.json().catch(() => ({}));
    if (!res.ok || info.error) throw new Error(info.error || ('HTTP ' + res.status));
    if (!info.editable) { showToast(info.reason || 'This day cannot be edited.'); return; }
    _editDate = date;
    document.getElementById('tc-edit-title').textContent = fmtLongDate(date);
    document.getElementById('tc-edit-note').textContent = info.punches.length
      ? 'Change a time, remove a punch, or add one. Times are Pacific time.'
      : 'No punches are recorded for this day. Add what you worked. Times are Pacific time.';
    document.getElementById('tc-edit-rows').innerHTML = '';
    if (info.punches.length) info.punches.forEach(p => addEditRow(p.type, p.time));
    else { addEditRow('clock_in', ''); addEditRow('clock_out', ''); }
    document.getElementById('tc-edit-reason').value = '';
    document.getElementById('tc-edit-error').textContent = '';
    document.getElementById('tc-edit-modal').classList.add('open');
  } catch (e) {
    showToast('Could not open that day: ' + e.message);
  }
}

function closeEditDay() {
  document.getElementById('tc-edit-modal').classList.remove('open');
  _editDate = null;
}

function saveEditDay() {
  const errEl = document.getElementById('tc-edit-error');
  errEl.textContent = '';
  const punches = [...document.querySelectorAll('#tc-edit-rows .tc-edit-row')].map(r => ({
    type: r.querySelector('.tc-edit-type').value,
    time: r.querySelector('.tc-edit-time').value,
  }));
  const reason = document.getElementById('tc-edit-reason').value.trim();
  if (!punches.length) { errEl.textContent = 'Add at least a clock in and a clock out.'; return; }
  if (punches.some(p => !p.time)) { errEl.textContent = 'Every punch needs a time.'; return; }
  if (reason.length < 3) { errEl.textContent = 'Please say why you are changing this day.'; return; }

  const edit = { date: _editDate, punches, reason };
  // The server decides what is legal; the screen only needs to know
  // whether the day ends with a clock out, because that is when the
  // break questions must be answered again.
  const last = punches.slice().sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0)).pop();
  document.getElementById('tc-edit-modal').classList.remove('open');
  if (last.type === 'clock_out') {
    _pendingEdit = edit;
    startAttestation('Certifying for ' + fmtLongDate(edit.date) + '. Answer the questions below for that day.');
  } else {
    sendEditDay(edit, null);
  }
}

async function sendEditDay(edit, attestation) {
  if (_busy) return;
  _busy = true;
  render();
  try {
    const res = await fetch(`${SCRIPT_URL}/timecard/edit-day?id_token=${encodeURIComponent(getIdToken())}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date: edit.date, punches: edit.punches, reason: edit.reason, attestation }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json.error) throw new Error(json.error || ('HTTP ' + res.status));
    showToast('Day updated \u2713 \u2014 the owner will see the change');
    closeEditDay();
    await loadSummary();
  } catch (e) {
    // Reopen the form with what was typed so nothing is lost.
    document.getElementById('tc-edit-modal').classList.add('open');
    document.getElementById('tc-edit-error').textContent = e.message;
    _editDate = edit.date;
  } finally {
    _busy = false;
    render();
  }
}

// ── Startup ──────────────────────────────────────────────────
loadSummary();
