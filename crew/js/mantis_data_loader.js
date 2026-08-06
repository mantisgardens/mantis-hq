/* =============================================================
   mantis_data_loader.js
   Mantis Gardens — Service Manual Data Loader

   Fetches service manual and plant database data from the
   Apps Script as structured JSON. No SheetJS or xlsx files
   needed — the Apps Script reads the Google Sheets directly
   and returns clean data arrays.

   Global arrays populated:
     PLANTS           — plant database
     FERT_PRODUCTS    — fertilizers & sprays
     VEHICLES         — vehicle fleet
     POWER_TOOLS      — power tools
     HAND_TOOLS       — hand tools & irrigation items
     EVERYDAY_ITEMS   — daily checklist items
     IRRIGATION_ITEMS — micro & drip irrigation items
   ============================================================= */

// ── Global data arrays ────────────────────────────────────────
var PLANTS           = [];
var PRUNING_GUIDE    = [];  // Sacramento pruning reference guide (43 plant groups)
var FERT_PRODUCTS    = [];
var VEHICLES         = [];
var POWER_TOOLS      = [];
var HAND_TOOLS       = [];
var EVERYDAY_ITEMS   = [];
var IRRIGATION_ITEMS = [];
var LABOR_RATES      = [];   // { qbName, rate, unit, label, notes }
var WORK_RECORD_PLANTS = []; // { name, qbName, unit, category, price, source }
var OTHER_MATERIALS  = [];   // { name, qbName, section, price, unit, desc, sku }

// ── Config ────────────────────────────────────────────────────
const SCRIPT_URL_SM = (typeof MANTIS_CONFIG !== 'undefined') ? MANTIS_CONFIG.SCRIPT_URL : '';

// ── Auth helper ───────────────────────────────────────────────
function getAuthParam() {
  const idToken = sessionStorage.getItem('mg_id_token') || '';
  if (idToken) return `&id_token=${encodeURIComponent(idToken)}`;
  return '';
}

// ── Cache helper ──────────────────────────────────────────────
function getCached(cacheKey) {
  try {
    const raw = sessionStorage.getItem(cacheKey);
    if (!raw) return null;
    const { ts, data } = JSON.parse(raw);
    // Cache for 30 minutes — service manual data changes rarely
    if (Date.now() - ts < 30 * 60 * 1000) return data;
  } catch(e) {}
  return null;
}

function setCached(cacheKey, data) {
  try {
    sessionStorage.setItem(cacheKey, JSON.stringify({ ts: Date.now(), data }));
  } catch(e) { /* storage full — skip cache */ }
}

// ── Progress helpers ──────────────────────────────────────────
function setLoadingProgress(pct) {
  const bar = document.getElementById('loading-progress-bar');
  if (bar) bar.style.width = pct + '%';
}

function showLoadingOverlay(msg) {
  const el = document.getElementById('loading-overlay');
  if (el) {
    el.style.display = 'flex';
    const txt = el.querySelector('.loading-text');
    if (txt) txt.textContent = msg || 'Loading…';
  }
}

function hideLoadingOverlay() {
  const el = document.getElementById('loading-overlay');
  if (el) el.style.display = 'none';
}

// Apps Script Web Apps intermittently fail the redirect they use to
// serve /exec responses (a 302 to script.googleusercontent.com/macros/
// echo, which occasionally 404s with an HTML page instead of the real
// JSON — a known Google-side serving glitch, not something this app's
// code controls). A single retry after a short delay clears it in
// practice. Same pattern as fetchJsonWithRetry() in crew_api.js —
// named differently here (not sharing that one) since this file is
// also loaded standalone on mantis_service_manual.html, without
// crew_api.js, and loads *before* crew_api.js on the crew panel page
// where both are present — relying on either file's copy silently
// winning there would be fragile.
function fetchServiceJsonWithRetry(url, retries) {
  retries = retries === undefined ? 1 : retries;
  return fetch(url)
    .then(r => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    })
    .catch(err => {
      if (retries > 0) {
        return new Promise(resolve => setTimeout(resolve, 700))
          .then(() => fetchServiceJsonWithRetry(url, retries - 1));
      }
      throw err;
    });
}

// ── Main loader ───────────────────────────────────────────────
// forceFresh=true (used by the "Reload now" link shown when the
// backend cache is cold) skips the client-side cache and calls the
// *Fresh actions, which force a live server-side refresh — same
// cache-only + forceLive pattern used everywhere else in this app
// (see the "Cache-only mode" note in Schedule.gs's getSchedule()).
// Resolves with { warming } so initServiceManual() can tell a
// legitimately-empty-right-now cold cache apart from a normal load.
function loadServiceData(forceFresh) {
  return new Promise((resolve, reject) => {

    // v10 = Labor Rates hint rows filtered out
    const smKey        = 'sm_data_v11_'   + SCRIPT_URL_SM.slice(-12);
    const plantKey     = 'plant_data_v7_' + SCRIPT_URL_SM.slice(-12);
    const smCached    = !forceFresh && getCached(smKey);
    const plantCached = !forceFresh && getCached(plantKey);

    if (smCached && plantCached) {
      applyServiceManualData(smCached);
      applyPlantData(plantCached);
      resolve({ warming: false });
      return;
    }

    if (!SCRIPT_URL_SM || SCRIPT_URL_SM === 'PASTE_YOUR_EXEC_URL_HERE') {
      reject(new Error('SCRIPT_URL not configured in mantis_config.js'));
      return;
    }

    const auth        = getAuthParam();
    const smAction     = forceFresh ? 'getServiceManualDataFresh' : 'getServiceManualData';
    const plantAction  = forceFresh ? 'getPlantDatabaseFresh'     : 'getPlantDatabase';

    setLoadingProgress(20);

    // Fetch both datasets in parallel
    Promise.all([
      smCached
        ? Promise.resolve(smCached)
        : fetchServiceJsonWithRetry(`${SCRIPT_URL_SM}?action=${smAction}${auth}`)
            .then(json => { if (json.error) throw new Error(json.error); return json; }),
      plantCached
        ? Promise.resolve(plantCached)
        : fetchServiceJsonWithRetry(`${SCRIPT_URL_SM}?action=${plantAction}${auth}`)
            .then(json => { if (json.error) throw new Error(json.error); return json; }),
    ])
    .then(([smData, plantData]) => {
      setLoadingProgress(80);
      applyServiceManualData(smData);
      applyPlantData(plantData);

      // Don't cache a "still warming up" placeholder client-side — see
      // the matching note in crew_api.js's apiFetch(). It's known-stale
      // data; caching it would just delay picking up the real data on
      // the next visit within this session's 30-minute client cache.
      const warming = !!(smData.warming || plantData.warming);
      if (!warming) {
        if (!smCached)    setCached(smKey,    smData);
        if (!plantCached) setCached(plantKey, plantData);
      }
      setLoadingProgress(100);
      resolve({ warming });
    })
    .catch(reject);
  });
}

// ── loadServiceDataReady ────────────────────────────────────────
// Wraps loadServiceData() for callers that just need
// FERT_PRODUCTS/PLANTS/etc. actually populated (e.g. crew_workrecord.js
// building the Work Record form's product dropdowns) and don't want to
// separately handle the { warming } cache-only placeholder as distinct
// from a real network failure. A cold cache is retried once with
// forceFresh (forcing a live fetch) before being treated as a failure
// — same "retry once" shape those callers already use for actual fetch
// errors, just extended to cover this case too so a crew member never
// silently sees empty dropdowns that quietly rendered from placeholder
// data instead of erroring or retrying.
function loadServiceDataReady() {
  return loadServiceData().then(({ warming }) => {
    if (!warming) return;
    return loadServiceData(true).then(({ warming: stillWarming }) => {
      if (stillWarming) throw new Error('Service data still warming after forced refresh');
    });
  });
}

// ── Apply service manual data ─────────────────────────────────
function applyServiceManualData(data) {
  FERT_PRODUCTS      = data.fertilizers      || [];
  VEHICLES           = data.vehicles         || [];
  EVERYDAY_ITEMS     = data.everydayItems    || [];
  IRRIGATION_ITEMS   = data.irrigation       || [];
  LABOR_RATES        = data.laborRates       || [];
  WORK_RECORD_PLANTS = data.workRecordPlants || [];
  OTHER_MATERIALS    = data.otherMaterials   || [];

  const allTools = data.tools || [];
  // Exclude section header rows (name is just the category title like "⚡  Power Tools")
  const realTools = allTools.filter(t => t.name && t.brand);
  POWER_TOOLS = realTools.filter(t => (t.category||'').toLowerCase() === 'power');
  HAND_TOOLS  = realTools.filter(t => (t.category||'').toLowerCase() !== 'power');
}

// ── Apply plant data ──────────────────────────────────────────
function applyPlantData(data) {
  PLANTS        = (data.plants        || []).filter(p => p.botanical || p.common);
  PRUNING_GUIDE =  data.pruningGuide  || [];
}

// ── Startup ───────────────────────────────────────────────────
// forceFresh=true is passed by the "Reload now" link the warming state
// below renders — forces a live refresh instead of waiting for the
// next scheduled prewarm.
function initServiceManual(forceFresh) {
  showLoadingOverlay(forceFresh ? 'Refreshing service data…' : 'Loading service data…');
  setLoadingProgress(10);
  const errEl = document.getElementById('load-error');
  if (errEl) errEl.style.display = 'none';

  loadServiceData(forceFresh)
    .then(({ warming }) => {
      if (warming) {
        // Cache was cold and this wasn't itself a forced fetch — the
        // data really is empty right now, not just slow. Unlike an
        // empty day on the crew schedule (a normal, legitimate state),
        // there's no legitimate "0 plants" state for this page, so
        // showing the empty result would just look broken. Keep the
        // loading overlay up with an explanation and a manual retry
        // instead — same "still warming up" idea as showWarmingBanner()
        // in crew_api.js, just surfaced in this page's own overlay
        // rather than a banner.
        const txt = document.querySelector('#loading-overlay .loading-text');
        if (txt) {
          txt.innerHTML = 'Still warming up — this refreshes automatically every few minutes.<br>' +
            '<a href="#" style="color:#7ec8a0;text-decoration:underline" ' +
            'onclick="initServiceManual(true);return false;">Reload now</a>';
        }
        return;
      }
      hideLoadingOverlay();
      if (typeof renderPlants === 'function') renderPlants();
      if (typeof renderFert   === 'function') renderFert();
      if (typeof renderEquip  === 'function') renderEquip();
      if (typeof updateCount  === 'function') updateCount(PLANTS.length, PLANTS.length);
    })
    .catch(err => {
      hideLoadingOverlay();
      console.error('Data load failed:', err);
      if (errEl) { errEl.textContent = 'Data load failed: ' + err.message; errEl.style.display = 'block'; }
    });
}
