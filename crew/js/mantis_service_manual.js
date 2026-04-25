/* =============================================================
   mantis_service_manual.js
   Mantis Gardens — Service Manual Logic & Rendering
   Data lives in:
     mantis_plants_data.js     — plant & fertilizer records
     mantis_equipment_data.js  — vehicles, tools, daily items
   ============================================================= */

// SECTION 4 — SECTION NAVIGATION
// =============================================================
let currentSection = 'plants';

function showSection(id) {
  document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
  document.querySelectorAll('.section-tab').forEach(t => t.classList.remove('active'));
  document.getElementById('section-' + id).classList.add('active');
  document.getElementById('tab-' + id).classList.add('active');
  currentSection = id;
  // Clear search when switching sections
  document.getElementById('search-input').value = '';
  updateCount();
  // Render section content on first visit
  if (id === 'prune') renderPruning();
}

// =============================================================
// SECTION 5 — SEARCH
// =============================================================
function doSearch(q) {
  q = q.toLowerCase().trim();

  // Hide global search bar on pruning tab (it has no search)
  const globalSearch = document.querySelector('.search-bar');
  if (globalSearch) globalSearch.style.display = (currentSection === 'prune') ? 'none' : '';

  if (currentSection === 'plants') {
    // Plant panel has its own search input — delegate to it
    const inp = document.getElementById('plant-search-input');
    if (inp) { inp.value = q; plantDoSearch(q); }

  } else if (currentSection === 'fert') {
    let visible = 0;
    document.querySelectorAll('#fert-table tr[data-row]').forEach(row => {
      const text = row.textContent.toLowerCase();
      const match = !q || text.includes(q);
      row.classList.toggle('hidden', !match);
      if (match) visible++;
    });
    updateCount(visible, FERT_PRODUCTS.length);

  } else if (currentSection === 'equip') {
    let visible = 0;
    document.querySelectorAll('.tool-card').forEach(card => {
      const text = card.textContent.toLowerCase();
      const match = !q || text.includes(q);
      card.classList.toggle('hidden', !match);
      if (match) visible++;
    });
    updateCount(visible, HAND_TOOLS.length + POWER_TOOLS.length);
  } else if (currentSection === 'prune') {
    // Pruning tab has no search — nothing to filter
  }
}

function updateCount(shown, total) {
  const el = document.getElementById('search-count');
  if (shown === undefined) {
    el.textContent = '';
  } else if (shown === total) {
    el.textContent = total + ' entries';
  } else {
    el.textContent = shown + ' of ' + total;
  }
}

// =============================================================
// SECTION 6 — PLANT RENDERING (search + profile card)
// =============================================================

// ── State ─────────────────────────────────────────────────
let plantSearchResults = [];  // current filtered list
let plantSelected      = null; // currently shown plant

function renderPlants() {
  // Wire up search input (idempotent — safe to call multiple times)
  const inp = document.getElementById('plant-search-input');
  if (inp && !inp._wired) {
    inp._wired = true;
    inp.addEventListener('input', () => plantDoSearch(inp.value));
    inp.addEventListener('keydown', e => {
      if (e.key === 'Escape') { inp.value = ''; plantDoSearch(''); }
    });
  }
  plantDoSearch('');
}

function plantDoSearch(q) {
  const query  = (q || '').toLowerCase().trim();
  const list   = document.getElementById('plant-results-list');
  const card   = document.getElementById('plant-profile-card');
  const count  = document.getElementById('plant-result-count');
  if (!list) return;

  if (!query) {
    plantSearchResults = PLANTS;
  } else {
    plantSearchResults = PLANTS.filter(p =>
      (p.botanical + ' ' + p.common + ' ' + p.plant_type).toLowerCase().includes(query)
    );
  }

  // Update count
  if (count) count.textContent = plantSearchResults.length + ' plants';

  // Render result rows
  list.innerHTML = plantSearchResults.map((p, i) => {
    const active = plantSelected && plantSelected.botanical === p.botanical ? ' prl-active' : '';
    return `<div class="plant-result-row${active}" onclick="plantSelect(${i})">
      <span class="prr-common">${esc(p.common || p.botanical)}</span>
      <span class="prr-latin">${esc(p.botanical)}</span>
      <span class="prr-type">${esc(p.plant_type)}</span>
    </div>`;
  }).join('') || '<div class="prr-empty">No plants match your search</div>';

  // If there was a selected plant, keep it shown; otherwise clear
  if (plantSelected) {
    plantShowProfile(plantSelected);
  } else if (card) {
    card.innerHTML = plantEmptyCard();
  }
}

function plantSelect(idx) {
  const p = plantSearchResults[idx];
  if (!p) return;
  plantSelected = p;
  // Highlight active row
  document.querySelectorAll('.plant-result-row').forEach((el, i) => {
    el.classList.toggle('prl-active', i === idx);
  });
  plantShowProfile(p);
  // Scroll profile header into view — handles both stacked (mobile)
  // and side-by-side layouts smoothly
  const card = document.getElementById('plant-profile-card');
  if (card) {
    card.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

function plantShowProfile(p) {
  const card = document.getElementById('plant-profile-card');
  if (!card) return;

  // Fertilizer category colour
  const fcatColors = {
    'Citrus':      '#FFF3CD',
    'Roses':       '#FDECEA',
    'Acid Loving': '#E8F5E9',
    'Tropical':    '#E3F2FD',
    'Other':       '#F5F5F5',
  };
  const fcatBg = fcatColors[p.fert_cat] || '#F5F5F5';

  function row(label, val, style) {
    if (!val) return '';
    return `<div class="pp-row${style ? ' '+style : ''}">
      <span class="pp-label">${label}</span>
      <span class="pp-val">${esc(val)}</span>
    </div>`;
  }

  card.innerHTML = `
    <div class="pp-header">
      <div class="pp-common">${esc(p.common || p.botanical)}</div>
      <div class="pp-botanical">${esc(p.botanical)}</div>
      <div class="pp-type-badges">
        ${p.plant_type ? `<span class="pp-badge">${esc(p.plant_type)}</span>` : ''}
        ${p.ca_native  === 'Yes' || p.ca_native  === 'x' ? '<span class="pp-badge pp-native">CA Native</span>' : ''}
        ${p.drought    === 'Yes' || p.drought    === 'x' ? '<span class="pp-badge pp-drought">Drought Tolerant</span>' : ''}
      </div>
    </div>

    <div class="pp-sections">

      <div class="pp-section">
        <div class="pp-section-title">&#127774; Basic Care</div>
        ${row('Sun',   p.sun)}
        ${row('Water', p.water)}
        ${row('Height', p.height)}
        ${row('Width',  p.width)}
        ${row('Bloom',  p.bloom)}
      </div>

      <div class="pp-section pp-prune">
        <div class="pp-section-title">&#9988; Pruning</div>
        ${row('Season',  p.pruning_season)}
        ${row('Quarter', p.pruning_qtr)}
        ${row('Notes',   p.pruning_notes)}
      </div>

      <div class="pp-section pp-fert" style="background:${fcatBg}">
        <div class="pp-section-title">&#127807; Fertilizer — ${esc(p.fert_cat)}</div>
        ${row('Primary',   p.fert_primary)}
        ${row('Rate',      p.fert_rate1)}
        ${row('Secondary', p.fert_secondary)}
        ${row('Rate',      p.fert_rate2)}
        ${row('Frequency', p.fert_freq)}
        ${row('Notes',     p.fert_notes)}
      </div>

    </div>`;
}

function plantEmptyCard() {
  return `<div class="pp-empty">
    <div style="font-size:32px;margin-bottom:10px">&#127807;</div>
    <div>Search or select a plant<br>to see its care profile</div>
  </div>`;
}

// =============================================================
// SECTION 7 — FERTILIZER / SPRAY RENDERING
// =============================================================
function renderFert() {
  const wrap = document.getElementById('fert-table');

  const groups = [
    { key:'fertilizer', title:'Fertilizers — Liquid & Granular' },
    { key:'amendment',  title:'Soil Amendments' },
    { key:'spray',      title:'Sprays & Pest Control' },
  ];

  // Sulfur/Hort Oil tech callout
  let html = `
    <div class="callout">
      <div class="callout-title">&#128680; Sulfur &amp; Hort Oil — Tech Notes</div>
      <b>Mix:</b> Elemental sulfur 1 tbsp/gal + Horticultural oil 1.5 tbsp/gal<br>
      <b>Shake</b> vigorously — sulfur settles rapidly. Rinse sprayer weekly with Dawn/Castille soap.<br>
      <b>Use only in dormant season</b> — causes phytotoxicity on new growth/buds.<br>
      <b>Never use on:</b> currants, blackberries, or apricot.<br>
      <b>Apply:</b> immediately after dormant pruning · before March 1 bud swell · coat all fresh cuts and root crowns.<br>
      <b>Billable:</b> 1/4 gal minimum — must be recorded on work sheet.<br>
      Safety: mild eye/skin irritant — rinse with water if contact occurs.
    </div>`;

  groups.forEach(g => {
    const products = FERT_PRODUCTS.filter(p => p.category === g.key);
    if (!products.length) return;
    html += `<div class="fert-section-title">${g.title}</div>
    <table class="data-table">
      <thead><tr>
        <th>Product</th><th>Unit</th><th>Type</th><th>Use / Plants</th>
        <th>Rate</th><th>Timing</th><th>Notes</th>
      </tr></thead>
      <tbody>`;
    products.forEach(p => {
      const warn = p.warn ? ' style="background:#fff8f0"' : '';
      html += `<tr data-row="1"${warn}>
        <td><b>${esc(p.name)}</b>${p.abbrev && p.abbrev !== '—' ? `<br><span style="font-family:'DM Mono',monospace;font-size:9px;color:var(--ink3)">${esc(p.abbrev)}</span>` : ''}</td>
        <td style="font-family:'DM Mono',monospace;font-size:11px;white-space:nowrap">${esc(p.unit)}</td>
        <td>${esc(p.type)}</td>
        <td>${esc(p.use)}</td>
        <td style="font-size:11px">${esc(p.rate)}</td>
        <td style="font-size:11px">${esc(p.timing)}</td>
        <td style="font-size:11px">${esc(p.notes)}</td>
      </tr>`;
    });
    html += `</tbody></table>`;
  });

  wrap.innerHTML = html;
  updateCount(FERT_PRODUCTS.length, FERT_PRODUCTS.length);
}

// =============================================================
// SECTION 8 — EQUIPMENT RENDERING
// =============================================================
function renderEquip() {
  const el = document.getElementById('equip-content');

  // Vehicles
  let html = `<div class="equip-section">
    <div class="equip-section-title">Vehicles &amp; Trailers</div>`;
  VEHICLES.forEach(v => {
    const serviceRows = (v.service||[]).map(s =>
      `<div class="vehicle-detail">&#128295; ${esc(s)}</div>`).join('');
    const specRows = (v.specs||[]).map(s => {
      if (s && typeof s === 'object')
        return `<div class="vehicle-detail">&#9656; <b>${esc(s.label)}:</b> ${esc(s.value)}</div>`;
      return `<div class="vehicle-detail">&#9656; ${esc(s)}</div>`;
    }).join('');
    const attachRows = (v.attachments||[]).length
      ? `<div class="vehicle-detail" style="margin-top:5px;color:var(--b)">
           Attachments: ${v.attachments.map(esc).join(' &middot; ')}</div>` : '';
    const manualLink = v.manual
      ? `<div style="margin-top:6px">
           <a class="tool-link" href="${v.manual}" target="_blank" rel="noopener">Manual / support</a>
           ${v.manual_note ? `<div class="vehicle-detail" style="margin-top:4px;font-style:italic">${esc(v.manual_note)}</div>` : ''}
         </div>` : '';
    html += `<div class="vehicle-card">
      <div class="vehicle-name">${esc(v.name)}</div>
      <div class="vehicle-detail" style="color:var(--ink2);margin-bottom:3px">${esc(v.detail)}</div>
      <div class="vehicle-detail">Crew: ${esc(v.crew)}</div>
      ${v.vin && v.vin !== '—' ? `<div class="vehicle-vin">VIN: ${esc(v.vin)}</div>` : ''}
      ${attachRows}
      ${manualLink}
      ${specRows ? `<div style="margin-top:8px;padding-top:8px;border-top:1px solid var(--bg3)">${specRows}</div>` : ''}
      ${serviceRows ? `<div style="margin-top:8px;padding-top:8px;border-top:1px solid var(--bg3)">${serviceRows}</div>` : ''}
    </div>`;
  });
  html += `</div>`;

  // Power tools
  html += `<div class="equip-section">
    <div class="equip-section-title">Power Tools &amp; Equipment</div>
    <div class="tool-grid">`;
  POWER_TOOLS.forEach(t => {
    const links = [];
    if (t.manual)     links.push(`<a class="tool-link" href="${t.manual}" target="_blank" rel="noopener">Product page</a>`);
    if (t.manual_pdf) links.push(`<a class="tool-link pdf" href="${t.manual_pdf}" target="_blank" rel="noopener">PDF manual</a>`);
    html += `<div class="tool-card power-card">
      <div style="flex:1;min-width:0">
        <div class="tool-name">${esc(t.name)}</div>
        <div class="tool-brand">${esc(t.brand)}</div>
        ${t.serial && t.serial !== '—' ? `<div class="tool-detail">S/N: ${esc(t.serial)}</div>` : ''}
        ${links.length ? `<div class="tool-links">${links.join(' ')}</div>` : ''}
      </div>
      <div class="tool-count">×${t.count}</div>
    </div>`;
  });
  html += `</div></div>`;

  // Hand tools by category
  const handCats = [
    { key:'digging',    label:'Digging &amp; Excavation' },
    { key:'rake',       label:'Raking, Sweeping &amp; Grading' },
    { key:'pruning',    label:'Pruning &amp; Cutting' },
    { key:'irrigation', label:'Irrigation &amp; Plumbing' },
    { key:'hauling',    label:'Hauling &amp; Hardware' },
    { key:'measure',    label:'Measuring &amp; Fastening' },
    { key:'bits',       label:'Drill Bits &amp; Blade Sets' },
    { key:'garden',     label:'Garden &amp; Miscellaneous Hand Tools' },
  ];
  handCats.forEach(cat => {
    const tools = HAND_TOOLS.filter(t => t.category === cat.key);
    if (!tools.length) return;
    html += `<div class="equip-section">
      <div class="equip-section-title">${cat.label}</div>
      <div class="tool-grid">`;
    tools.forEach(t => {
      html += `<div class="tool-card">
        <div>
          <div class="tool-name">${esc(t.name)}</div>
          ${t.detail ? `<div class="tool-detail">${esc(t.detail)}</div>` : ''}
        </div>
        <div class="tool-count">×${t.count}</div>
      </div>`;
    });
    html += `</div></div>`;
  });

  // Everyday items
  html += `<div class="equip-section">
    <div class="equip-section-title">Everyday Items (per-job checklist)</div>
    <div class="tool-grid">`;
  EVERYDAY_ITEMS.forEach(item => {
    html += `<div class="tool-card"><div class="tool-name">${esc(item)}</div></div>`;
  });
  html += `</div></div>`;

  el.innerHTML = html;
}

// =============================================================
// SECTION 9 — UTILITY & STARTUP
// =============================================================
function esc(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// =============================================================
// SECTION: PRUNING CALENDAR
// Renders the seasonal pruning calendar from PRUNING_CALENDAR.
// =============================================================
function renderPruning() {
  const el = document.getElementById('prune-content');
  if (!el) return;

  const months = typeof PRUNING_CALENDAR !== 'undefined' ? PRUNING_CALENDAR : [];

  // Current month highlight
  const monthNames = ['January','February','March','April','May','June',
                      'July','August','September','October','November','December'];
  const currentMonth = monthNames[new Date().getMonth()];

  let html = `
    <div class="callout" style="margin-bottom:16px">
      <div class="callout-title">&#9986; Seasonal Pruning Calendar</div>
      When to prune affects whether plants bloom next season.
      Always prune spring-blooming plants <b>after</b> they flower.
      Prune summer/fall bloomers in late winter before new growth.
    </div>`;

  if (!months.length) {
    html += '<div class="prr-empty">Pruning calendar not loaded.</div>';
    el.innerHTML = html;
    return;
  }

  html += '<table class="data-table" style="width:100%"><tbody>';
  months.forEach(m => {
    const isCurrent = m.month === currentMonth;
    const rowStyle  = isCurrent
      ? ' style="background:var(--g-light,#e8f4f0);font-weight:bold"'
      : '';
    const badge = isCurrent
      ? ' <span style="font-size:10px;background:var(--g,#2E7D52);color:#fff;padding:2px 6px;border-radius:10px;margin-left:6px">Now</span>'
      : '';
    html += `<tr${rowStyle}>
      <td style="width:110px;font-weight:bold;white-space:nowrap;vertical-align:top;padding:8px 10px">
        ${esc(m.month)}${badge}
      </td>
      <td style="padding:8px 10px;font-size:13px;line-height:1.5">
        ${esc(m.plants) || '<span style="color:#aaa">No scheduled pruning</span>'}
      </td>
    </tr>`;
  });
  html += '</tbody></table>';

  el.innerHTML = html;
}

// Auth guard — redirect to login if not signed in.
// Session timeout — 4 hours inactivity.
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
  // Data is loaded asynchronously via Apps Script JSON API.
  // initServiceManual() triggers the load and calls
  // renderPlants / renderFert / renderEquip when ready.
  initServiceManual();
}
