/* =============================================================
   crew_workrecord.js
   Mantis Gardens — Work Record Form

   Contains:
     12. Work record form    (openWorkRecord, closeModal, isFormEmpty)
     13. Workers             (addWorker, getWorkersForTeam)
     14. Materials           (addMaterial, addIrrigationRow, COMMON_MATERIALS)
     15. Photos              (handlePhotos, removePhoto)
     16. Form actions        (collectFormData, saveForm, submitForm,
                               clearForm, toggleChecklist)
     16b. Safe local save    (safeLocalSave, pruneOldRecords)
   ============================================================= */

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
// Uses IRRIGATION_ITEMS from mantis_data_loader.js
// (populated from the Irrigation and Drainage tab).
// Groups items by detecting section header rows (name contains '──').
function getIrrigationGroups() {
  const allItems = [
    ...(typeof IRRIGATION_ITEMS !== 'undefined' ? IRRIGATION_ITEMS : []),
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

// ── Unit lookup for irrigation and other materials ─────────────
// Returns the unit string for a given item name, searching
// IRRIGATION_ITEMS and OTHER_MATERIALS.
function getItemUnit(name) {
  if (!name) return '';
  const n = name.trim().toLowerCase();
  const sources = [
    ...(typeof IRRIGATION_ITEMS !== 'undefined' ? IRRIGATION_ITEMS : []),
    ...(typeof OTHER_MATERIALS  !== 'undefined' ? OTHER_MATERIALS  : []),
  ];
  const match = sources.find(item =>
    item.name && item.name.trim().toLowerCase() === n
  );
  return (match && match.unit && match.unit.toLowerCase() !== 'each' &&
          match.unit.toLowerCase() !== 'n/a') ? match.unit : '';
}

function openWorkRecord(jobId) {
  // Search currentDay first (fast path), then fall back to all days in SCHEDULE.
  // This handles the case where currentDay changes between the card rendering
  // and the Work Record button being tapped (e.g. a day tab tap in between).
  let job = null;
  let jobDay = currentDay;
  const dCurrent = SCHEDULE[currentDay] || {};
  job = [...(dCurrent.t1||[]),...(dCurrent.t2||[]),...(dCurrent.t3||[])].find(j => j.id === jobId);
  if (!job) {
    for (const day of Object.keys(SCHEDULE)) {
      const d = SCHEDULE[day] || {};
      const found = [...(d.t1||[]),...(d.t2||[]),...(d.t3||[])].find(j => j.id === jobId);
      if (found) { job = found; jobDay = day; break; }
    }
  }
  if (!job) return;

  // Snap currentDay to wherever this job actually lives
  currentDay = jobDay;

  currentJobId   = jobId;
  currentJobData = job;

  // Determine team — re-read from the resolved day
  const d   = SCHEDULE[currentDay] || {};
  const teamKey  = d.t1 && d.t1.find(j=>j.id===jobId) ? 't1'
                 : d.t2 && d.t2.find(j=>j.id===jobId) ? 't2' : 'install';
  const teamName = teamKey === 't1' ? 'Maintenance — Team 1'
                 : teamKey === 't2' ? 'Maintenance — Team 2'
                 : 'Install Team';

  document.getElementById('modal-title').textContent  = 'Work Record';
  document.getElementById('modal-client').textContent = job.client + (job.addr ? '  ·  ' + job.addr : '');
  document.getElementById('wr-team').value        = teamName;
  document.getElementById('wr-date-start').value  = currentDay;
  document.getElementById('wr-date-end').value    = '';

  // Write client identity into hidden fields — these are the authoritative source
  // for collectFormData, independent of JS state at submit time.
  const _scNow = job._sc || findSheetClient(job.client);
  document.getElementById('wr-client-name').value = job.client || '';
  document.getElementById('wr-hist-id').value      = (_scNow && _scNow['Hist Data ID'])    ? _scNow['Hist Data ID'].trim()    : '';
  document.getElementById('wr-folder-id').value    = (_scNow && _scNow['Drive Folder ID']) ? _scNow['Drive Folder ID'].trim() : '';

  // Reset form
  document.getElementById('workers-list').innerHTML         = '';
  document.getElementById('fert-list').innerHTML            = '';
  document.getElementById('irrigation-list').innerHTML      = '';
  document.getElementById('plants-list').innerHTML          = '';
  document.getElementById('other-materials-list').innerHTML = '';
  document.getElementById('wr-service-notes').value         = '';
  document.getElementById('wr-internal-notes').value        = '';
  document.getElementById('photo-previews').innerHTML       = '';
  photoFiles = [];
  // Reset submit button in case it was left in the offline state
  const _sb = document.getElementById('wr-submit-btn');
  if (_sb) { _sb.textContent = 'Submit'; _sb.style.background = ''; _sb.disabled = false; }

  // Ensure crew name datalist exists
  _ensureCrewDatalist();

  // Show modal immediately
  document.getElementById('work-modal').classList.add('open');

  // Restore saved draft if exists
  const saved = savedRecords[jobId];
  if (saved && !saved.submitted) {
    (saved.workers        || []).forEach(w => addWorker(w.name, w.hours, w.laborType));
    (saved.fertilizers     || []).forEach(f => addFert(f.item, f.qty, f.unit));
    (saved.irrigationItems || []).forEach(m => addIrrigationItem(m.item, m.qty, m.unit));
    (saved.plants          || []).forEach(p => addPlant(p.name, p.qty, p.size));
    (saved.otherMaterials  || []).forEach(m => addOtherMaterial(m.item, m.qty, m.unit));
    if (!saved.fertilizers && !saved.otherMaterials) {
      (saved.materials || []).forEach(m => addOtherMaterial(m.item, m.qty, m.unit));
    }
    document.getElementById('wr-service-notes').value  = saved.serviceNotes  || '';
    document.getElementById('wr-internal-notes').value = saved.internalNotes || '';
    return;
  }

  // Load service data (fert/materials lists) then auto-populate
  const fertList = document.getElementById('fert-list');
  const irrList  = document.getElementById('irrigation-list');
  const needsLoad = typeof FERT_PRODUCTS === 'undefined' || !FERT_PRODUCTS.length;

  const afterServiceDataLoaded = () => {
    refreshFertDatalist();
    refreshIrrDatalist();
    refreshPlantsDatalist();
    refreshOtherDatalist();

    // ── Auto-populate workers from today's team brief ──────
    const brief = _historyData && _historyData._teamBrief;  // not available here
    // Use the team's crew names from the morning brief all_crew list if available
    const teamWorkers = _getTeamWorkers(teamKey);
    if (teamWorkers.length) {
      teamWorkers.forEach(name => addWorker(name, ''));
    } else {
      addWorker();  // blank row if no names available
    }

    // ── Fertilizer / materials pre-fill disabled by owner preference ──
    // _prefillLastFertilizers() is retained for reference but not called.
    // Crew start with one blank row each and fill from scratch.
    addFert();
    addOtherMaterial();
  };

  if (needsLoad && typeof loadServiceData === 'function') {
    loadServiceData()
      .then(() => afterServiceDataLoaded())
      .catch(() => {
        // First attempt failed — wait 2 seconds and retry once before giving up.
        // This handles Apps Script cold-start timeouts which are common on first load.
        setTimeout(() => {
          loadServiceData()
            .then(() => afterServiceDataLoaded())
            .catch(() => {
              // Both attempts failed — show a reload prompt in the fert/materials area
              // so the crew member knows the lists didn't load rather than silently
              // rendering empty text inputs that look like the dropdowns are just missing.
              const msg = `<div style="padding:8px;color:var(--warn,#b45309);font-size:13px">
                ⚠ Product lists didn't load.
                <a href="javascript:void(0)" onclick="location.reload()"
                   style="color:inherit;font-weight:bold;text-decoration:underline">Reload page</a>
                to get the dropdowns, then re-open the work record.
              </div>`;
              if (fertList) fertList.innerHTML = msg;
              afterServiceDataLoaded();
            });
        }, 2000);
      });
  } else {
    afterServiceDataLoaded();
  }

  // Seed the folder ID cache from the already-resolved _sc if available —
  // no network round-trip needed. Fall back to prefetch only if _sc is missing.
  if (job._sc && job._sc['Drive Folder ID']) {
    _folderIdCache[job.client] = job._sc['Drive Folder ID'].trim();
  } else if (job.client && SCRIPT_URL && SCRIPT_URL !== 'PASTE_YOUR_EXEC_URL_HERE') {
    prefetchClientFolder(job.client);
  }
}

// Cache: client name → Drive folder ID
const _folderIdCache = {};

// ── Crew name datalist ────────────────────────────────────────
// Built from the all_crew list returned by getMorningBrief.
// Gives crew members name autocomplete when filling out workers.

function _ensureCrewDatalist() {
  const dl = document.getElementById('dl-crew-global');
  if (!dl) return;
  if (dl.children.length) return;  // already populated
  const allNames = [...(crewTeams.t1||[]), ...(crewTeams.t2||[]), ...(crewTeams.t3||[])];
  allNames.forEach(name => {
    const opt = document.createElement('option');
    opt.value = name;
    dl.appendChild(opt);
  });
}

// ── Get workers for a team from crewTeams ─────────────────────

function _getTeamWorkers(teamKey) {
  return crewTeams[teamKey] || [];
}

// ── openMgrWorkRecord ─────────────────────────────────────────
// Opens the Work Record modal for a manager calendar event.
// workerName is the calendar owner ('Ashley Manning' or 'Brooke Wolf')
// and is pre-filled as the sole worker row.
function openMgrWorkRecord(evId, workerName) {
  // Find the event in MANAGER_SCHEDULE across all three streams
  const dayData = MANAGER_SCHEDULE && currentDay
    ? (MANAGER_SCHEDULE.days || {})[currentDay] || {}
    : {};
  const allMgrEvents = [
    ...(dayData.ashley || []),
    ...(dayData.brooke || []),
    ...(dayData.mgr    || []),
  ];
  const ev = allMgrEvents.find(e => e.id === evId);
  if (!ev) return;

  currentJobId   = 'mgr_' + evId;
  currentJobData = ev;

  document.getElementById('modal-title').textContent  = 'Work Record';
  document.getElementById('modal-client').textContent = ev.title + (ev.description ? '  ·  ' + ev.description.split('\n')[0] : '');
  document.getElementById('wr-team').value        = 'Managers';
  document.getElementById('wr-date-start').value  = currentDay;
  document.getElementById('wr-date-end').value    = '';

  // Manager events use clientCandidate for folder lookup
  const _mgrSc = findSheetClient(ev.clientCandidate || ev.title || '');
  document.getElementById('wr-client-name').value = ev.clientCandidate || ev.title || '';
  document.getElementById('wr-hist-id').value      = (_mgrSc && _mgrSc['Hist Data ID'])    ? _mgrSc['Hist Data ID'].trim()    : '';
  document.getElementById('wr-folder-id').value    = (_mgrSc && _mgrSc['Drive Folder ID']) ? _mgrSc['Drive Folder ID'].trim() : '';

  // Reset form
  document.getElementById('workers-list').innerHTML         = '';
  document.getElementById('fert-list').innerHTML            = '';
  document.getElementById('irrigation-list').innerHTML      = '';
  document.getElementById('plants-list').innerHTML          = '';
  document.getElementById('other-materials-list').innerHTML = '';
  document.getElementById('wr-service-notes').value         = '';
  document.getElementById('wr-internal-notes').value        = '';
  document.getElementById('photo-previews').innerHTML       = '';
  photoFiles = [];
  const _sb = document.getElementById('wr-submit-btn');
  if (_sb) { _sb.textContent = 'Submit'; _sb.style.background = ''; _sb.disabled = false; }

  _ensureCrewDatalist();
  document.getElementById('work-modal').classList.add('open');

  // Restore draft if one exists
  const saved = savedRecords['mgr_' + evId];
  if (saved && !saved.submitted) {
    (saved.workers        || []).forEach(w => addWorker(w.name, w.hours, w.laborType));
    (saved.fertilizers     || []).forEach(f => addFert(f.item, f.qty, f.unit));
    (saved.irrigationItems || []).forEach(m => addIrrigationItem(m.item, m.qty, m.unit));
    (saved.plants          || []).forEach(p => addPlant(p.name, p.qty, p.size));
    (saved.otherMaterials  || []).forEach(m => addOtherMaterial(m.item, m.qty, m.unit));
    document.getElementById('wr-service-notes').value  = saved.serviceNotes  || '';
    document.getElementById('wr-internal-notes').value = saved.internalNotes || '';
    return;
  }

  const afterServiceDataLoaded = () => {
    refreshFertDatalist();
    refreshIrrDatalist();
    refreshPlantsDatalist();
    refreshOtherDatalist();
    // Pre-fill the named worker (Ashley or Brooke) from the calendar stream
    addWorker(workerName || '', '');
    addFert();
    addOtherMaterial();
  };

  const needsLoad = typeof FERT_PRODUCTS === 'undefined' || !FERT_PRODUCTS.length;
  if (needsLoad && typeof loadServiceData === 'function') {
    loadServiceData().then(afterServiceDataLoaded).catch(() => {
      setTimeout(() => {
        loadServiceData().then(afterServiceDataLoaded).catch(afterServiceDataLoaded);
      }, 2000);
    });
  } else {
    afterServiceDataLoaded();
  }

  if (ev.clientCandidate && SCRIPT_URL && SCRIPT_URL !== 'PASTE_YOUR_EXEC_URL_HERE') {
    prefetchClientFolder(ev.clientCandidate);
  }
}

// ── Auto-fill last fertilizers ────────────────────────────────
// Fetches the most recent Fertilizer entry from the Historical Data
// sheet and pre-populates the fert rows. Falls back to one empty row.

function _prefillLastFertilizers(clientName, fertList, irrList, jobId) {
  // Look up Hist Data ID from sheetClients.
  // Client DB stores names as "Last, First" but calendar events use
  // "First Last" — normClientName() handles both formats.
  const sc = findSheetClient(clientName);
  const histId   = sc && sc['Hist Data ID']    ? sc['Hist Data ID'].trim()    : '';
  const folderId = sc && sc['Drive Folder ID'] ? sc['Drive Folder ID'].trim() : '';

  if (!histId && !folderId) {
    // No IDs — just add blank rows
    if (!fertList.children.length) addFert();
    if (!irrList.children.length)  addOtherMaterial();
    return;
  }

  // Show loading message while fetching last visit data
  const loadingHtml = `<div class="sm-loading-row"><span class="sm-spinner"></span> Loading last visit…</div>`;
  fertList.innerHTML = loadingHtml;
  irrList.innerHTML  = loadingHtml;

  const idToken   = sessionStorage.getItem('mg_id_token') || '';
  const authParam = idToken ? `&id_token=${encodeURIComponent(idToken)}` : '';
  const url = `${SCRIPT_URL}?action=historical_data${authParam}`
            + `&client=${encodeURIComponent(clientName)}`
            + `&histId=${encodeURIComponent(histId)}`
            + `&folderId=${encodeURIComponent(folderId)}`
            + `&_=${Date.now()}`;

  fetch(url)
    .then(r => r.json())
    .then(data => {
      // Discard if user has already moved to a different job
      if (currentJobId !== jobId) return;
      fertList.innerHTML = '';
      irrList.innerHTML  = '';
      if (data.error || !data.fertilizers || !data.fertilizers.length) {
        if (!fertList.children.length) addFert();
        if (!irrList.children.length)  addOtherMaterial();
        return;
      }
      // Build a deduplicated union of products from the last 3 entries
      // (already sorted newest-first). Each product appears once,
      // with qty/unit from its most recent appearance.
      const LOOKBACK    = 3;
      const recentEntries = data.fertilizers.slice(0, LOOKBACK);
      const seen        = new Map();   // product name (lc) -> { item, qty, unit }

      // Walk oldest-to-newest so that the most recent entry wins on conflict
      recentEntries.slice().reverse().forEach(entry => {
        const products = (entry.product || '').split(' | ').filter(p => p.trim());
        products.forEach(p => {
          const dashIdx = p.indexOf(' — ');
          let item, qty, unit;
          if (dashIdx > 0) {
            item = p.slice(0, dashIdx).trim();
            const qtyPart = p.slice(dashIdx + 3).trim();
            const parts   = qtyPart.split(' ');
            qty  = parts[0] || '';
            unit = parts.slice(1).join(' ') || '';
          } else {
            item = p.trim(); qty = ''; unit = '';
          }
          if (item) seen.set(item.toLowerCase(), { item, qty, unit });
        });
      });

      if (seen.size) {
        seen.forEach(({ item, qty, unit }) => addFert(item, qty, unit));
      } else {
        addFert();
      }
      if (!irrList.children.length) addOtherMaterial();
    })
    .catch(() => {
      if (currentJobId !== jobId) return;
      fertList.innerHTML = '';
      irrList.innerHTML  = '';
      if (!fertList.children.length) addFert();
      if (!irrList.children.length)  addOtherMaterial();
    });
}

function prefetchClientFolder(clientName) {
  if (_folderIdCache[clientName]) return;  // already cached
  const idToken  = sessionStorage.getItem('mg_id_token') || '';
  const authParam = idToken ? `&id_token=${encodeURIComponent(idToken)}` : '';
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

// ── Is the form meaningfully empty? ──────────────────────────
// Returns true if the crew hasn't entered anything worth saving:
// no worker names, no notes, no materials, no photos.
function isFormEmpty() {
  const hasWorker = Array.from(
    document.querySelectorAll('#workers-list .dynamic-row input[type="text"]')
  ).some(i => i.value.trim() !== '');
  const hasNotes  = document.getElementById('wr-service-notes').value.trim() !== ''
                 || document.getElementById('wr-internal-notes').value.trim() !== '';
  const hasFert   = Array.from(
    document.querySelectorAll('#fert-list .dynamic-row')
  ).some(row => {
    const inp = row.querySelector('.fert-item-input');
    return inp && inp.value.trim() !== '';
  });
  const hasMatl   = Array.from(
    document.querySelectorAll('#other-materials-list .dynamic-row')
  ).some(row => {
    const sel    = row.querySelector('.irr-select');
    const custom = row.querySelector('.irr-custom');
    if (sel && sel.style.display !== 'none') return sel.value.trim() !== '';
    if (custom && custom.style.display !== 'none') return custom.value.trim() !== '';
    return false;
  });
  return !hasWorker && !hasNotes && !hasFert && !hasMatl && photoFiles.length === 0;
}

function closeModal() {
  // Auto-save draft if the form has content and hasn't been submitted
  const alreadySubmitted = currentJobId && savedRecords[currentJobId] && savedRecords[currentJobId].submitted;
  if (currentJobId && !alreadySubmitted && !isFormEmpty()) {
    const data = collectFormData();
    savedRecords[currentJobId] = Object.assign({}, data, { photos: [] });
    safeLocalSave();
    // Update the saved badge on the job card button
    const btn = document.getElementById('wr-btn-' + currentJobId);
    if (btn && !btn.querySelector('.saved-badge')) {
      btn.innerHTML += '<span class="saved-badge">saved</span>';
    }
    showToast('Draft auto-saved ✓');
  }

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
function addWorker(name, hours, laborType) {
  const list = document.getElementById('workers-list');
  const row  = document.createElement('div');
  row.className = 'dynamic-row';

  // Build labor type options from LABOR_RATES if loaded
  const rates = (typeof LABOR_RATES !== 'undefined' && LABOR_RATES.length)
    ? LABOR_RATES : [];
  let rateOpts = '<option value="">— labor type —</option>';
  rates.forEach(r => {
    const sel = (r.label === (laborType||'') || r.qbName === (laborType||'')) ? ' selected' : '';
    rateOpts += `<option value="${esc(r.qbName)}"${sel}>${esc(r.label)} ($${r.rate}/hr)</option>`;
  });

  row.innerHTML = `
    <input class="form-input" type="text" placeholder="Worker name"
           list="dl-crew-global" autocomplete="off"
           value="${esc(name||'')}" style="flex:2"/>
    <input class="form-input" type="number" placeholder="Hours" min="0" step="0.25"
           value="${hours||''}" style="flex:1;max-width:80px"/>
    <select class="form-input worker-labor-type" style="flex:2">${rateOpts}</select>
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
  const dl = document.getElementById('dl-fert-global');
  if (dl) dl.innerHTML = getFertNames().map(n => `<option value="${esc(n)}">`).join('');
}

// Populates the irrigation/materials datalist from the full items list.
function refreshIrrDatalist() {
  const dl = document.getElementById('dl-irr-global');
  if (dl) {
    const allNames = getIrrigationGroups().flatMap(g => g.items);
    dl.innerHTML = allNames.map(n => `<option value="${esc(n)}">`).join('');
  }
}

// Populates the plants datalist
function refreshPlantsDatalist() {
  const dl = document.getElementById('dl-plants-global');
  if (!dl) return;
  const plants = (typeof WORK_RECORD_PLANTS !== 'undefined') ? WORK_RECORD_PLANTS : [];
  dl.innerHTML = plants.map(p => `<option value="${esc(p.name)}">`).join('');
}

// Populates the other materials datalist
function refreshOtherDatalist() {
  const dl = document.getElementById('dl-other-global');
  if (!dl) return;
  const items = (typeof OTHER_MATERIALS !== 'undefined') ? OTHER_MATERIALS : [];
  dl.innerHTML = items.map(m => `<option value="${esc(m.name)}">`).join('');
}

// ── Plant row ─────────────────────────────────────────────────
function addPlant(name, qty, size) {
  const list = document.getElementById('plants-list');
  if (!list) return;
  const row = document.createElement('div');
  row.className = 'dynamic-row';
  row.innerHTML = `
    <input class="form-input plant-name-input" type="text" placeholder="Plant name"
           list="dl-plants-global" autocomplete="off"
           value="${esc(name||'')}" style="flex:3"/>
    <input class="form-input" type="text" placeholder="Qty"
           value="${esc(qty||'')}" style="flex:1;max-width:72px"/>
    <input class="form-input plant-size-input" type="text" placeholder="Size (5 gal…)"
           value="${esc(size||'')}" style="flex:1;max-width:90px"/>
    <button class="remove-btn" onclick="this.parentElement.remove()">&#10005;</button>`;

  const nameInput = row.querySelector('.plant-name-input');
  const sizeInput = row.querySelector('.plant-size-input');
  function tryFillPlantSize() {
    if (sizeInput && !sizeInput.value) {
      const n = nameInput.value.trim().toLowerCase();
      const plants = (typeof WORK_RECORD_PLANTS !== 'undefined') ? WORK_RECORD_PLANTS : [];
      const match = plants.find(p => p.name.trim().toLowerCase() === n);
      if (match && match.unit) sizeInput.value = match.unit;
    }
  }
  nameInput.addEventListener('change', tryFillPlantSize);
  nameInput.addEventListener('blur',   tryFillPlantSize);

  list.appendChild(row);
}

// ── Irrigation item row (was addOtherMaterial) ────────────────
function addIrrigationItem(item, qty, unit) {
  makeIrrRow(item, qty, unit);
}

// ── Other Materials row ────────────────────────────────────────
function makeOtherMatRow(item, qty, unit) {
  _makePickerRow('other-materials-list', 'other', item, qty, unit);
}

function addOtherMaterial(item, qty, unit) { makeOtherMatRow(item, qty, unit); }
function addMaterial(item, qty, unit) { addOtherMaterial(item, qty, unit); }

// ── Shared picker-based row builder ───────────────────────────
// Used by both irrigation and other materials rows.
// Shows a text input + "Browse…" button. Tap Browse to open
// the two-step section → item picker modal.
function _makePickerRow(listId, kind, item, qty, unit) {
  const list = document.getElementById(listId);
  if (!list) return;
  const row = document.createElement('div');
  row.className = 'dynamic-row';
  row.innerHTML = `
    <input class="form-input picker-item-input" type="text"
           placeholder="${kind === 'irr' ? 'Irrigation item' : 'Material'}"
           list="dl-${kind === 'irr' ? 'irr' : 'other'}-global"
           autocomplete="off" style="flex:3" value="${esc(item||'')}"/>
    <button class="btn-link picker-browse-btn" type="button"
            style="font-size:11px;padding:0 6px;white-space:nowrap;color:var(--g)">Browse</button>
    <input class="form-input" type="text" placeholder="Qty"
           value="${esc(qty||'')}" style="flex:1;max-width:72px"/>
    <input class="form-input" type="text" placeholder="Unit"
           value="${esc(unit||'')}" style="flex:1;max-width:72px"/>
    <button class="remove-btn" onclick="this.parentElement.remove()">&#10005;</button>`;

  const nameInput = row.querySelector('.picker-item-input');
  const unitInput = row.querySelector('input[placeholder="Unit"]');
  const browseBtn = row.querySelector('.picker-browse-btn');

  function tryFillUnit() {
    if (unitInput && !unitInput.value) {
      const u = getItemUnit(nameInput.value.trim());
      if (u) unitInput.value = u;
    }
  }
  nameInput.addEventListener('change', tryFillUnit);
  nameInput.addEventListener('blur',   tryFillUnit);

  browseBtn.addEventListener('click', () => {
    openItemPicker(kind, (selectedName) => {
      nameInput.value = selectedName;
      unitInput.value = '';
      tryFillUnit();
    });
  });

  list.appendChild(row);
}

function makeIrrRow(item, qty, unit) {
  _makePickerRow('irrigation-list', 'irr', item, qty, unit);
}

// ── Item Picker Modal engine ───────────────────────────────────
// _pickerCallback: function called with selected item name
// _pickerKind:     'irr' | 'other'
// _pickerSection:  null (step 1) | section name (step 2)
let _pickerCallback = null;
let _pickerKind     = null;
let _pickerSection  = null;

function openItemPicker(kind, callback) {
  _pickerCallback = callback;
  _pickerKind     = kind;
  _pickerSection  = null;

  document.getElementById('picker-search').value = '';
  document.getElementById('picker-title').textContent =
    kind === 'irr' ? 'Irrigation & Spray Heads' : 'Other Materials';

  _pickerShowSections();
  document.getElementById('item-picker-modal').classList.add('open');
  document.body.style.overflow = 'hidden';
  setTimeout(() => document.getElementById('picker-search').focus(), 150);
}

function closeItemPicker(e) {
  if (e && e.target !== document.getElementById('item-picker-modal')) return;
  document.getElementById('item-picker-modal').classList.remove('open');
  document.body.style.overflow = '';
  _pickerCallback = null;
}

function _pickerGetGroups() {
  if (_pickerKind === 'irr') {
    return getIrrigationGroups();   // [{label, items:[name,...]}]
  }
  // Other materials — build groups from OTHER_MATERIALS sections
  const mats = (typeof OTHER_MATERIALS !== 'undefined') ? OTHER_MATERIALS : [];
  const sectionNames = [...new Set(mats.map(m => m.section).filter(Boolean))];
  return sectionNames.map(sec => ({
    label: sec,
    items: mats.filter(m => m.section === sec).map(m => m.name),
  }));
}

function _pickerShowSections() {
  _pickerSection = null;
  const groups = _pickerGetGroups();
  const sectEl = document.getElementById('picker-sections');
  const itemEl = document.getElementById('picker-items');
  const backEl = document.getElementById('picker-back-bar');
  const crumb  = document.getElementById('picker-breadcrumb');

  itemEl.style.display   = 'none';
  backEl.style.display   = 'none';
  sectEl.style.display   = '';
  crumb.textContent      = '';

  sectEl.innerHTML = groups.map(g => `
    <button class="picker-section-btn" onclick="_pickerSelectSection('${esc(g.label)}')">
      ${esc(g.label)}
      <span class="picker-section-count">${g.items.length}</span>
    </button>`).join('');
}

function _pickerSelectSection(sectionLabel) {
  _pickerSection = sectionLabel;
  const groups   = _pickerGetGroups();
  const group    = groups.find(g => g.label === sectionLabel);
  if (!group) return;

  document.getElementById('picker-breadcrumb').textContent = sectionLabel;
  document.getElementById('picker-sections').style.display = 'none';
  document.getElementById('picker-back-bar').style.display = '';

  const itemEl = document.getElementById('picker-items');
  itemEl.style.display = '';
  itemEl.innerHTML = group.items.map(name => `
    <button class="picker-item-btn" onclick="_pickerSelectItem('${esc(name)}')">
      ${esc(name)}
    </button>`).join('');
}

function pickerBack() {
  document.getElementById('picker-search').value = '';
  _pickerShowSections();
}

function _pickerSelectItem(name) {
  document.getElementById('item-picker-modal').classList.remove('open');
  document.body.style.overflow = '';
  if (_pickerCallback) _pickerCallback(name);
  _pickerCallback = null;
}

function pickerSearch(query) {
  const q = query.trim().toLowerCase();
  const groups = _pickerGetGroups();
  const sectEl = document.getElementById('picker-sections');
  const itemEl = document.getElementById('picker-items');
  const backEl = document.getElementById('picker-back-bar');

  if (!q) {
    // Return to section list
    if (_pickerSection) {
      _pickerSelectSection(_pickerSection);
    } else {
      _pickerShowSections();
    }
    return;
  }

  // Search all items across all sections
  sectEl.style.display = 'none';
  backEl.style.display = 'none';
  itemEl.style.display = '';
  document.getElementById('picker-breadcrumb').textContent = 'Search results';

  let html = '';
  groups.forEach(g => {
    const matches = g.items.filter(name => name.toLowerCase().includes(q));
    if (!matches.length) return;
    html += `<div class="picker-search-section">${esc(g.label)}</div>`;
    html += matches.map(name => `
      <button class="picker-item-btn picker-highlight"
              onclick="_pickerSelectItem('${esc(name)}')">${esc(name)}</button>`
    ).join('');
  });

  if (!html) {
    html = `<div style="padding:16px;color:var(--ink3);text-align:center;font-size:13px">
      No items match "<strong>${esc(query)}</strong>"</div>`;
  }
  itemEl.innerHTML = html;
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
    const inputs    = row.querySelectorAll('input');
    const name      = inputs[0].value.trim();
    const hours     = inputs[1].value.trim();
    const laborSel  = row.querySelector('.worker-labor-type');
    const laborType = laborSel ? laborSel.value.trim() : '';
    if (name) workers.push({ name, hours, laborType });
  });

  function collectRows(listId) {
    const isFertList = listId === 'fert-list';
    const rows = [];
    document.querySelectorAll(`#${listId} .dynamic-row`).forEach(row => {
      const sel    = row.querySelector('.irr-select, .other-select');
      const custom = row.querySelector('.irr-custom, .other-custom, .picker-item-input');
      let item;
      if (sel && sel.style.display !== 'none') {
        item = sel.value.trim();
      } else if (custom && custom.style.display !== 'none') {
        item = custom.value.trim();
      } else {
        const firstInput = row.querySelector('input.fert-item-input') ||
                           row.querySelector('input.picker-item-input') ||
                           row.querySelectorAll('input')[0];
        item = firstInput ? firstInput.value.trim() : '';
      }
      // Strip abbreviation suffix added by getFertNames() — e.g. "MaxiCrop Kelp (MC)"
      if (isFertList && item) {
        item = item.replace(/\s*\([^)]+\)\s*$/, '').trim();
      }
      const qtyEl  = row.querySelector('input[placeholder="Qty"]');
      const unitEl = row.querySelector('input[placeholder="Unit"]');
      const qty    = qtyEl  ? qtyEl.value.trim()  : '';
      const unit   = unitEl ? unitEl.value.trim() : '';
      if (item) rows.push({ item, qty, unit });
    });
    return rows;
  }

  // Plants list (item=name, qty, size)
  const plants = [];
  document.querySelectorAll('#plants-list .dynamic-row').forEach(row => {
    const inputs = row.querySelectorAll('input');
    const name   = inputs[0] ? inputs[0].value.trim() : '';
    const qty    = inputs[1] ? inputs[1].value.trim() : '';
    const size   = inputs[2] ? inputs[2].value.trim() : '';
    if (name) plants.push({ name, qty, size });
  });

  const fertilizers     = collectRows('fert-list');
  const irrigationItems = collectRows('irrigation-list');
  const otherMaterials  = collectRows('other-materials-list');

  // Read client identity from hidden DOM fields — written by openWorkRecord when
  // the modal opened. These are the authoritative source: they survive day-tab
  // changes, re-renders, and any other JS state drift between open and submit.
  // Fall back to currentJobData only as a last resort.
  const _domClient   = document.getElementById('wr-client-name').value  || (currentJobData ? currentJobData.client : '');
  const _domHistId   = document.getElementById('wr-hist-id').value;
  const _domFolderId = document.getElementById('wr-folder-id').value;

  return {
    jobId:          currentJobId,
    client:         _domClient,
    addr:           currentJobData ? currentJobData.addr : '',
    team:           document.getElementById('wr-team').value,
    date:           document.getElementById('wr-date-start').value,
    dateEnd:        document.getElementById('wr-date-end').value || '',
    workers,
    fertilizers,
    irrigationItems,
    plants,
    otherMaterials,
    serviceNotes:   document.getElementById('wr-service-notes').value.trim(),
    internalNotes:  document.getElementById('wr-internal-notes').value.trim(),
    photoCount:     photoFiles.length,
    savedAt:        new Date().toISOString(),
    histId:         _domHistId,
    cachedFolderId: _domFolderId,
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

  // ── Offline guard ─────────────────────────────────────────────
  // navigator.onLine can be unreliable, so we treat any network-level
  // fetch failure the same way (handled in the .catch below).
  // This check catches the obvious case — no signal at all.
  if (!navigator.onLine) {
    showToast('No network — record saved. Submit when back in range.', 4000);
    // Save locally so nothing is lost
    const offlineData = Object.assign({}, data, { photos: [] });
    savedRecords[currentJobId] = offlineData;
    safeLocalSave();
    // Update the submit button so crew know the state
    const submitBtn = document.getElementById('wr-submit-btn');
    if (submitBtn) {
      submitBtn.textContent = '⚠ Offline — submit later';
      submitBtn.style.background = 'var(--a)';
    }
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
        const authParam = idToken ? `&id_token=${encodeURIComponent(idToken)}` : '';
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
        // Warn crew if the server saved the record but couldn't find the Drive folder
        if (json.warning) {
          hideSubmitProgress();
          if (currentJobId) setSt(currentJobId, 'done');
          showToast('⚠ ' + json.warning, 8000);
          savedRecords[currentJobId] = { submitted: true, savedAt: new Date().toISOString(), client: data.client || '', date: data.date || '' };
          safeLocalSave();
          setTimeout(() => closeModal(), 8000);
          if (submitBtn) { submitBtn.disabled = false; }
          return;
        }
        // Clear checklist state for this job
        if (currentJobId) delete _checklistStates[currentJobId];
        const panel = document.getElementById('checklist-panel');
        if (panel) {
          panel.style.display = 'none';
          panel.dataset.jobId = '';
          panel.querySelectorAll('input[type=checkbox]').forEach(cb => cb.checked = false);
        }
        savedRecords[currentJobId] = {
          submitted: true,
          savedAt:   new Date().toISOString(),
          client:    data.client || '',
          date:      data.date   || '',
        };
        safeLocalSave();

        showSubmitProgress('Done ✓', 100);
        if (currentJobId) setSt(currentJobId, 'done');
        setTimeout(() => {
          hideSubmitProgress();
          showToast('Submitted ✓');
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
  document.getElementById('irrigation-list').innerHTML      = '';
  document.getElementById('plants-list').innerHTML          = '';
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
