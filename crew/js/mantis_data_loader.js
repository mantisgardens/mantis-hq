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
     SPRAY_HEADS      — spray heads & valves
   ============================================================= */

// ── Global data arrays ────────────────────────────────────────
var PLANTS           = [];
var PRUNING_CALENDAR = [];  // seasonal pruning calendar
var FERT_PRODUCTS    = [];
var VEHICLES         = [];
var POWER_TOOLS      = [];
var HAND_TOOLS       = [];
var EVERYDAY_ITEMS   = [];
var IRRIGATION_ITEMS = [];
var SPRAY_HEADS      = [];

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

// ── Main loader ───────────────────────────────────────────────
function loadServiceData() {
  return new Promise((resolve, reject) => {

    // v3 = added irrigation/sprayHeads to sm data; pruning to plant data
    const smKey        = 'sm_data_v3_'    + SCRIPT_URL_SM.slice(-12);
    const plantKey     = 'plant_data_v3_' + SCRIPT_URL_SM.slice(-12);
    const smCached    = getCached(smKey);
    const plantCached = getCached(plantKey);

    if (smCached && plantCached) {
      applyServiceManualData(smCached);
      applyPlantData(plantCached);
      resolve();
      return;
    }

    if (!SCRIPT_URL_SM || SCRIPT_URL_SM === 'PASTE_YOUR_EXEC_URL_HERE') {
      reject(new Error('SCRIPT_URL not configured in mantis_config.js'));
      return;
    }

    const auth = getAuthParam();

    // Warm up the Apps Script instance
    fetch(`${SCRIPT_URL_SM}?action=ping${auth}`).catch(() => {});

    setLoadingProgress(20);

    // Fetch both datasets in parallel
    Promise.all([
      smCached
        ? Promise.resolve(smCached)
        : fetch(`${SCRIPT_URL_SM}?action=getServiceManualData${auth}`)
            .then(r => r.json())
            .then(json => { if (json.error) throw new Error(json.error); return json; }),
      plantCached
        ? Promise.resolve(plantCached)
        : fetch(`${SCRIPT_URL_SM}?action=getPlantDatabase${auth}`)
            .then(r => r.json())
            .then(json => { if (json.error) throw new Error(json.error); return json; }),
    ])
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

// ── Apply service manual data ─────────────────────────────────
function applyServiceManualData(data) {
  FERT_PRODUCTS    = data.fertilizers || [];
  VEHICLES         = data.vehicles    || [];
  IRRIGATION_ITEMS = data.irrigation  || [];
  SPRAY_HEADS      = data.sprayHeads  || [];

  const allTools = data.tools || [];
  POWER_TOOLS    = allTools.filter(t =>
    t.name.startsWith('\u26a1') || (t.category||'').toLowerCase() === 'power');
  EVERYDAY_ITEMS = allTools.filter(t => t.name.startsWith('\U0001f4e6'));
  HAND_TOOLS     = allTools.filter(t =>
    !t.name.startsWith('\u26a1') && !t.name.startsWith('\U0001f4e6') &&
    (t.category||'').toLowerCase() !== 'power');
}

// ── Apply plant data ──────────────────────────────────────────
function applyPlantData(data) {
  PLANTS           = (data.plants   || []).filter(p => p.botanical || p.common);
  PRUNING_CALENDAR =  data.pruning  || [];
}

// ── Startup ───────────────────────────────────────────────────
function initServiceManual() {
  showLoadingOverlay('Loading service data…');
  setLoadingProgress(10);

  loadServiceData()
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
      const el = document.getElementById('load-error');
      if (el) { el.textContent = 'Data load failed: ' + err.message; el.style.display = 'block'; }
    });
}
