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

// Plain fetch() has NO built-in timeout — if a request stalls mid-
// flight (a dropped or degraded connection), the promise just sits
// pending forever, with no recovery but a manual page reload. 
// AbortController forces a stalled
// request to actually fail after SM_FETCH_TIMEOUT_MS, so
// fetchServiceJsonWithRetry() below treats it like any other failure.
// Named distinctly (SM_ prefix, not shared with crew_api.js's/
// mantis_landing.js's own FETCH_TIMEOUT_MS) because this file loads
// alongside crew_api.js on mantis_crew_panel.html — two top-level
// `const FETCH_TIMEOUT_MS` declarations in that shared page would be a
// SyntaxError and break the entire page, not just silently override
// like a duplicate `function` would.
const SM_FETCH_TIMEOUT_MS = 7000;
function fetchServiceWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs === undefined ? SM_FETCH_TIMEOUT_MS : timeoutMs);
  return fetch(url, { signal: controller.signal }).finally(() => clearTimeout(timer));
}

// Apps Script Web Apps intermittently fail the redirect they use to
// serve /exec responses (a 302 to script.googleusercontent.com/macros/
// echo, which occasionally 404s with an HTML page instead of the real
// JSON, or just hangs at zero bytes until FETCH_TIMEOUT_MS aborts it)
// — a known Google-side serving glitch, not something this app's code
// controls. Same pattern as fetchJsonWithRetry() in crew_api.js —
// named differently here (not sharing that one) since this file is
// also loaded standalone on mantis_service_manual.html, without
// crew_api.js, and loads *before* crew_api.js on the crew panel page
// where both are present — relying on either file's copy silently
// winning there would be fragile.
//
// 2 retries (not 1) — see the matching comment in crew_api.js's
// fetchJsonWithRetry(): a HAR capture showed this exact stall hitting
// twice in a row before a third attempt succeeded, so a single retry
// isn't always enough.
function fetchServiceJsonWithRetry(url, retries) {
  retries = retries === undefined ? 2 : retries;
  return fetchServiceWithTimeout(url)
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

// ── fetchStaticServiceJson_ ────────────────────────────────────
// Same idea as crew_api.js's fetchCrewLoadAllWithFallback() — see
// that comment for the full reasoning. Apps Script event-driven-
// publishes Service Manual/Plant Database snapshots as static JSON
// files into this same repo (see requestServiceManualPublish_() in
// Utilities.gs), served by GitHub Pages from the same origin as this
// page, bypassing the script.google.com redirect entirely. A short
// timeout — a same-origin static file should resolve in well under a
// second when it's working at all, no legitimate slow case to wait
// out here.
const STATIC_SM_TIMEOUT_MS = 4000;
function fetchStaticServiceJson_(path) {
  return fetchServiceWithTimeout(`${path}?_=${Date.now()}`, STATIC_SM_TIMEOUT_MS)
    .then(r => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    });
}

// -- Main loader -------------------------------------------------
// forceFresh=true (used by the "Reload now" link, retained for manual
// refresh even though the automatic warming-retry path that used to
// also trigger it is gone) skips the client-side cache and requests
// a live server-side refresh via ?force=1.
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
      resolve();
      return;
    }

    if (!SCRIPT_URL_SM || SCRIPT_URL_SM === 'PASTE_YOUR_CLOUD_RUN_URL_HERE') {
      reject(new Error('SCRIPT_URL not configured in mantis_config.js'));
      return;
    }

    const auth = getAuthParam();

    // crew-cloud/ simplification: REST paths with a ?force=1 query
    // param instead of separate *Fresh action names (matching the
    // Cloud Run backend's own convention -- see build doc section on
    // ServiceManual.gs). The static-file-first check is also dropped
    // entirely here, same reasoning as crew_api.js's
    // fetchCrewLoadAllWithFallback() -- Cloud Run has no GitHub-publish
    // pipeline producing a snapshot to check for, so it would only
    // ever fail before falling through to this same live call anyway.
    function fetchLive(path, force) {
      const forceParam = force ? '&force=1' : '';
      return fetchServiceJsonWithRetry(`${SCRIPT_URL_SM}${path}?${auth.replace(/^&/, '')}${forceParam}`)
        .then(json => { if (json.error) throw new Error(json.error); return json; });
    }
    function loadSm() {
      if (smCached) return Promise.resolve(smCached);
      return fetchLive('/service-manual', forceFresh);
    }
    function loadPlant() {
      if (plantCached) return Promise.resolve(plantCached);
      return fetchLive('/plant-database', forceFresh);
    }

    setLoadingProgress(20);

    // Fetch both datasets in parallel
    Promise.all([loadSm(), loadPlant()])
    .then(([smData, plantData]) => {
      setLoadingProgress(80);
      applyServiceManualData(smData);
      applyPlantData(plantData);
      if (!smCached)    setCached(smKey,    smData);
      if (!plantCached) setCached(plantKey, plantData);
      setLoadingProgress(100);
      resolve();
    })
    .catch(reject);
  });
}

// -- loadServiceDataReady -------------------------------------------
// Thin wrapper kept for callers (e.g. crew_workrecord.js building the
// Work Record form's product dropdowns) that just need
// FERT_PRODUCTS/PLANTS/etc. actually populated. Used to also retry
// once with forceFresh if the cache came back in a "still warming up"
// state -- that state can't happen against this backend (see
// loadServiceData() above), so this is now a plain passthrough. Kept
// as its own named function so callers don't need to change.
function loadServiceDataReady() {
  return loadServiceData();
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
// forceFresh=true forces a live server-side refresh, bypassing the
// backend's own cache.
function initServiceManual(forceFresh) {
  showLoadingOverlay(forceFresh ? 'Refreshing service data…' : 'Loading service data…');
  setLoadingProgress(10);
  const errEl = document.getElementById('load-error');
  if (errEl) errEl.style.display = 'none';

  loadServiceData(forceFresh)
    .then(() => {
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
