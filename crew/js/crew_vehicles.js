/* =============================================================
   crew_vehicles.js
   Mantis Gardens — Vehicles page (mantis_vehicles.html)

   Loads every vehicle with its oil-change status and recent log
   (GET /vehicles) and saves the form (POST /vehicles/log). The backend
   (mantis-backend/src/lib/vehicles.js) validates everything and writes
   to the "Vehicle Service Log" tab of the Service Manual sheet.
   ============================================================= */

// ── Auth guard (same as the other crew pages) ─────────────────
if (sessionStorage.getItem('mg_auth') !== '1') {
  window.location.href = 'index.html';
} else {
  initSessionTimeout({
    timeoutMs: 4 * 60 * 60 * 1000, warningMs: 5 * 60 * 1000, sessionKey: 'mg_auth', loginUrl: 'index.html',
    onSignOut: () => { sessionStorage.clear(); },
  });
}

const SCRIPT_URL = (typeof MANTIS_CONFIG !== 'undefined') ? MANTIS_CONFIG.SCRIPT_URL : '';
const ITEMS = [['oilChange', 'Oil change'], ['oilFilter', 'Oil filter'], ['fuelFilter', 'Fuel filter'],
  ['cabinAirFilter', 'Cabin air filter'], ['engineAirFilter', 'Engine air filter'], ['tireRotation', 'Tire rotation'], ['battery', 'Battery']];
let _data = null;
let _busy = false;

// Same sessionStorage-then-localStorage fallback as crew_timecard.js.
function getIdToken() {
  let token = sessionStorage.getItem('mg_id_token') || '';
  if (!token) {
    const lsToken = localStorage.getItem('mg_id_token') || '';
    const lsExpiry = parseInt(localStorage.getItem('mg_id_token_expiry') || '0');
    if (lsToken && Date.now() < lsExpiry) { sessionStorage.setItem('mg_id_token', lsToken); token = lsToken; }
  }
  return token;
}
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const $ = (id) => document.getElementById(id);
const fmtMiles = (n) => (n == null ? '' : Math.round(n).toLocaleString('en-US') + ' mi');
function fmtDate(iso) {
  if (!iso) return '';
  return new Date(iso + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}
function todayPacific() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
function showToast(msg, ms) {
  const t = $('vh-toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => t.classList.remove('show'), ms || 3500);
}

// ── Load ─────────────────────────────────────────────────────
async function loadVehicles(force) {
  try {
    const res = await fetch(`${SCRIPT_URL}/vehicles?${force ? 'force=1&' : ''}id_token=${encodeURIComponent(getIdToken())}`);
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json.error) throw new Error(json.error || ('HTTP ' + res.status));
    _data = json;
    renderSelect();
    renderTrucks();
  } catch (e) {
    $('vh-list').innerHTML = `<div class="vh-empty">Could not load vehicles: ${esc(e.message)}</div>`;
    $('vh-vehicle').innerHTML = '<option value="">Could not load vehicles</option>';
  }
}

function vehicleLabel(v) {
  const ymm = [v.year, v.make, v.model].filter(Boolean).join(' ');
  return ymm ? `${v.name} — ${ymm}` : v.name;
}
function renderSelect() {
  const sel = $('vh-vehicle');
  const keep = sel.value;
  sel.innerHTML = '<option value="">Choose a vehicle…</option>' +
    _data.vehicles.map(v => `<option value="${esc(v.name)}">${esc(vehicleLabel(v))}</option>`).join('');
  if (keep && _data.vehicles.some(v => v.name === keep)) sel.value = keep;
  onVehicleChange();
}
const selectedVehicle = () => (_data ? _data.vehicles.find(v => v.name === $('vh-vehicle').value) : null);

function onVehicleChange() {
  const v = selectedVehicle();
  const due = v && v.due;
  $('vh-last-miles').textContent = due && due.currentMileage != null
    ? `Last recorded: ${fmtMiles(due.currentMileage)}${due.mileageDate ? ' on ' + fmtDate(due.mileageDate) : ''}` : '';
  if (v && !$('vh-oilType').dataset.touched) $('vh-oilType').value = v.oilType || '';
}
function onChecksChange() {
  const any = ITEMS.some(([f]) => $('vh-' + f).checked) || $('vh-repair').checked;
  $('vh-oil-wrap').style.display = $('vh-oilChange').checked ? '' : 'none';
  $('vh-repair-wrap').style.display = $('vh-repair').checked ? '' : 'none';
  $('vh-submit').textContent = any ? 'Save Service Entry' : 'Save Mileage Update';
}

// ── Truck cards ──────────────────────────────────────────────
const PILL = { overdue: ['overdue', 'Oil overdue'], soon: ['soon', 'Oil due soon'], ok: ['ok', 'Oil OK'],
  no_record: ['none', 'No oil change logged'], no_interval: ['none', 'No interval set'] };
function entryWhat(e) {
  const done = ITEMS.filter(([f]) => e[f]).map(([, label]) => label);
  if (e.airFilter) done.push('Air filter');            // old single column (before Nov 2026)
  if (e.oilChange && e.oilType) done[0] = `Oil change (${e.oilType})`;
  if (e.otherRepair) done.push('Repair: ' + e.otherRepair);
  return done.length ? done.join(', ') : 'Mileage update';
}
// "Last done": the newest date (and mileage) for each item, oil change first.
function lastDoneHtml(ld) {
  const items = Object.values(ld || {});
  if (!items.length) return '';
  return `<div class="vh-last"><div class="vh-last-title">Last done</div><dl class="vh-facts">${items.map(i =>
    `<dt>${esc(i.label)}</dt><dd>${esc(fmtDate(i.date))}${i.mileage != null ? ' \u00b7 ' + esc(fmtMiles(i.mileage)) : ''}</dd>`).join('')}</dl></div>`;
}
function renderTrucks() {
  const list = $('vh-list');
  if (!_data.vehicles.length) { list.innerHTML = '<div class="vh-empty">No vehicles in the Vehicles tab yet.</div>'; return; }
  list.innerHTML = _data.vehicles.map(v => {
    const due = v.due || {};
    const [pillCls, pillText] = PILL[due.status] || PILL.no_record;
    const facts = [['Plate', v.plate], ['VIN', v.vin], ['GVWR', v.gvwr], ['Payload', v.payload], ['Crew', v.crew],
      ['Oil', [v.oilType, v.interval && v.interval.miles ? `every ${fmtMiles(v.interval.miles)}` : '', v.interval && v.interval.months ? `or ${v.interval.months} months` : ''].filter(Boolean).join(' ')]]
      .filter(([, val]) => val).map(([k, val]) => `<dt>${esc(k)}</dt><dd>${esc(val)}</dd>`).join('');
    const last = due.lastOilChange
      ? `Last oil change ${fmtDate(due.lastOilChange.date)}${due.lastOilChange.mileage != null ? ' at ' + fmtMiles(due.lastOilChange.mileage) : ''}.` : '';
    const stale = due.mileageStale ? ` Mileage last updated ${fmtDate(due.mileageDate)} — log a mileage update to keep this accurate.` : '';
    const recent = (v.recent || []).map(e => `<div class="vh-entry">
        <div class="vh-entry-top"><span>${esc(fmtDate(e.date) || '(no date)')}</span><span>${esc(fmtMiles(e.mileage))}</span></div>
        <div class="vh-entry-what">${esc(entryWhat(e))}</div>
        ${e.notes || e.doneBy || e.enteredBy ? `<div class="vh-entry-note">${esc([e.notes, e.doneBy && 'Done by ' + e.doneBy, e.enteredBy && 'Logged by ' + e.enteredBy].filter(Boolean).join(' · '))}</div>` : ''}
      </div>`).join('');
    return `<div class="vh-truck">
      <div class="vh-truck-head">
        <div><div class="vh-truck-name">${esc(v.name)}</div>
          <div class="vh-truck-sub">${esc([v.year, v.make, v.model].filter(Boolean).join(' ') || v.detail || v.role)}</div></div>
        <span class="vh-pill ${pillCls}">${esc(pillText)}</span>
      </div>
      ${facts ? `<dl class="vh-facts">${facts}</dl>` : ''}
      <div class="vh-due ${esc(due.status || '')}">${esc(due.message || '')}<div class="vh-due-note">${esc(last + stale)}</div></div>
      ${lastDoneHtml(v.lastDone)}
      <details class="vh-hist"><summary>Recent history (${(v.recent || []).length})</summary>
        ${recent || '<div class="vh-empty">Nothing logged yet.</div>'}</details>
    </div>`;
  }).join('');
}

// ── Submit ───────────────────────────────────────────────────
async function submitEntry(ev) {
  ev.preventDefault();
  if (_busy) return;
  const v = selectedVehicle();
  if (!v) { showToast('Choose a vehicle.'); return; }
  const mileage = $('vh-mileage').value.replace(/[,\s]/g, '').replace(/mi$/i, '');
  if (!/^\d+$/.test(mileage)) { showToast('Enter the odometer mileage as a whole number.'); return; }
  if (!$('vh-date').value) { showToast('Enter the date.'); return; }
  if ($('vh-repair').checked && !$('vh-otherRepair').value.trim()) { showToast('Describe the repair.'); return; }
  const last = v.due && v.due.currentMileage;
  if (last != null && Number(mileage) < last &&
      !confirm(`${Number(mileage).toLocaleString('en-US')} mi is lower than the last recorded ${fmtMiles(last)} for ${v.name}. Save it anyway?`)) return;

  const body = { vehicle: v.name, date: $('vh-date').value, mileage,
    oilType: $('vh-oilType').value, otherRepair: $('vh-repair').checked ? $('vh-otherRepair').value : '',
    cost: $('vh-cost').value, doneBy: $('vh-doneBy').value, notes: $('vh-notes').value };
  ITEMS.forEach(([f]) => { body[f] = $('vh-' + f).checked; });

  _busy = true;
  const btn = $('vh-submit');
  btn.disabled = true;
  try {
    const res = await fetch(`${SCRIPT_URL}/vehicles/log?id_token=${encodeURIComponent(getIdToken())}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json.error) throw new Error(json.error || ('HTTP ' + res.status));
    showToast(json.warning || 'Saved ✓', json.warning ? 7000 : 3000);
    resetForm(v.name);
    await loadVehicles(true);
  } catch (e) {
    showToast('Not saved: ' + e.message, 6000);
  } finally {
    _busy = false;
    btn.disabled = false;
  }
}
function resetForm(keepVehicle) {
  $('vh-form').reset();
  delete $('vh-oilType').dataset.touched;
  $('vh-vehicle').value = keepVehicle || '';
  $('vh-date').value = todayPacific();
  onChecksChange();
  onVehicleChange();
}

// ── Start ────────────────────────────────────────────────────
$('vh-date').value = todayPacific();
$('vh-date').max = todayPacific();
$('vh-oilType').addEventListener('input', () => { $('vh-oilType').dataset.touched = '1'; });
loadVehicles(false);
