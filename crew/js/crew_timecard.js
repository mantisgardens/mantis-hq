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
    render();
  } catch (e) {
    console.warn('loadSummary failed:', e.message);
    document.getElementById('tc-history-list').innerHTML =
      `<div class="tc-empty-state">Could not load time card data. Pull down to try again.</div>`;
  }
}

function render() {
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
  mealBtn.disabled = _busy;
}

function renderSummaryRow() {
  document.getElementById('tc-today-hours').textContent = fmtHours(_state.todayMinutes);
  document.getElementById('tc-week-hours').textContent  = fmtHours(_state.weekMinutes);
}

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
async function sendPunch(type, extra) {
  if (_busy) return;
  _busy = true;
  render();
  try {
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
  const payload = { attestation: _attest };
  document.getElementById('tc-attest-modal').classList.remove('open');
  sendPunch('clock_out', payload);
  showToast('Clocked out \u2713');
  _attest = null;
}

function handleMealButton() {
  if (!_state || !_state.clockedIn) return;
  sendPunch(_state.onMealBreak ? 'meal_in' : 'meal_out');
}

// ── Startup ──────────────────────────────────────────────────
loadSummary();
