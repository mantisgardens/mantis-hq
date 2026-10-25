// ============================================================
// owner_scheduler_import.js -- "Import from Google Calendar" review screen.
// The backend reads the Google Calendars and suggests a Client for each
// event (by name or street address). Nothing is imported until the owner
// checks items and presses Import; anything already imported is skipped,
// so it is safe to run again later. Depends on owner_scheduler.js helpers.
// ============================================================
OWNER_ACTION_PATHS.schedImportPreview = '/owner/sched/import/preview';
OWNER_ACTION_PATHS.schedImportApply   = '/owner/sched/import/apply';

let impData = null;

function impClose(ev) { if (ev && ev.target && ev.target.id !== 'imp-modal') return; document.getElementById('imp-modal').classList.remove('open'); }

async function impOpen() {
  document.getElementById('imp-modal').classList.add('open');
  document.getElementById('imp-go').disabled = true;
  document.getElementById('imp-body').innerHTML = '<div class="empty-state">Reading the calendars&hellip; this can take a few seconds.</div>';
  try {
    impData = await ownerFetch('schedImportPreview');
    document.getElementById('sch-clients').innerHTML = allClients.filter(c => c['Client ID'])
      .map(c => `<option value="${esc((c['Name(s)'] || '') + ' — ' + c['Client ID'])}"></option>`).join('');
    impRender();
  } catch (e) {
    document.getElementById('imp-body').innerHTML = `<div class="empty-state">Could not read the calendars: ${esc(e.message)}</div>`;
  }
}

function impClientLabel(id) {
  const c = allClients.find(x => x['Client ID'] === id);
  return c ? `${c['Name(s)'] || ''} — ${id}` : '';
}

function impRow(it, i) {
  const when = sdLabel(it.date) + (it.start ? ' ' + sdTime(it.start) + (it.end ? '–' + sdTime(it.end) : '') : (it.allDay ? ' (all day)' : ''));
  const lane = it.lane === 'managers' ? `Managers: ${esc(it.person)}` : esc(it.calendar);
  let client;
  if (it.lane === 'managers') client = '<span class="imp-muted">—</span>';
  else {
    const hint = it.match.candidates.length ? `<div class="imp-hint">Maybe: ${it.match.candidates.map(c => esc(c.name)).join(' · ')}</div>` : '';
    const conf = it.match.confidence ? `<span class="imp-conf">matched by ${it.match.confidence === 'address' ? 'address' : it.match.confidence === 'interval' ? 'name + interval' : 'name'}</span>` : '';
    client = `<input class="form-input imp-client" id="imp-client-${i}" list="sch-clients" value="${esc(it.match.clientId ? impClientLabel(it.match.clientId) : '')}" placeholder="Pick a client, or leave blank to import as typed"/>${conf}${hint}`;
  }
  const flags = [it.timesRounded ? 'time rounded to a quarter hour' : '', it.multiDay ? 'spans several days: only the first day is imported' : '',
    it.exceptions.length || it.exdates.length ? `${it.exceptions.length + it.exdates.length} skipped or edited date(s) carried over` : ''].filter(Boolean);
  return `<tr class="${it.defaultSelected ? '' : 'imp-needs'}">
    <td><input type="checkbox" id="imp-chk-${i}"${it.defaultSelected ? ' checked' : ''} onchange="impCount()"/></td>
    <td>${esc(when)}${it.repeat ? `<div><span class="sch-freq">&#8635; ${esc(it.repeatText)}</span></div>` : ''}</td>
    <td>${lane}</td>
    <td><b>${esc(it.title)}</b>${it.location ? `<div class="imp-muted">${esc(it.location)}</div>` : ''}${flags.length ? `<div class="imp-hint">${esc(flags.join('; '))}</div>` : ''}</td>
    <td>${client}</td></tr>`;
}

function impRender() {
  const d = impData;
  const ready = d.items.filter(i => i.defaultSelected), needs = d.items.filter(i => !i.defaultSelected);
  let h = `<div class="sch-hint" style="margin-top:0">${d.items.length} item(s) can be imported` +
    (d.alreadyImported ? `, ${d.alreadyImported} already imported earlier (skipped)` : '') +
    (d.unsupported.length ? `, ${d.unsupported.length} could not be converted (listed at the bottom)` : '') +
    '. Check the client suggested for each one, fix any that are wrong, then press Import. Only events from today forward are brought over.</div>';
  const table = (list, title, note) => list.length ? `<div class="imp-sec">${title}</div>${note ? `<div class="imp-muted" style="margin-bottom:6px">${note}</div>` : ''}
    <div class="imp-wrap"><table class="imp-table"><thead><tr><th></th><th>When</th><th>Calendar</th><th>Event</th><th>Client</th></tr></thead><tbody>${list.map(it => impRow(it, d.items.indexOf(it))).join('')}</tbody></table></div>` : '';
  h += table(ready, `Matched (${ready.length})`, '');
  h += table(needs, `No client found (${needs.length})`, 'Pick the client for each, or tick the box with the field left blank to import it under the name as written in the calendar.');
  if (d.unsupported.length) h += `<div class="imp-sec">Could not be converted (${d.unsupported.length})</div><div class="imp-muted" style="margin-bottom:6px">Set these up by hand with + New job.</div>` +
    '<ul class="imp-list">' + d.unsupported.map(u => `<li><b>${esc(u.title)}</b> (${esc(u.calendar)}${u.date ? ', ' + esc(sdLabel(u.date)) : ''}): ${esc(u.reason)}</li>`).join('') + '</ul>';
  if (!d.items.length && !d.unsupported.length) h = '<div class="empty-state">Nothing new to import.</div>';
  document.getElementById('imp-body').innerHTML = h;
  impCount();
}

function impToggleAll(on) { impData.items.forEach((_, i) => { const c = document.getElementById('imp-chk-' + i); if (c) c.checked = on; }); impCount(); }
function impCount() {
  const n = impData ? impData.items.filter((_, i) => { const c = document.getElementById('imp-chk-' + i); return c && c.checked; }).length : 0;
  const b = document.getElementById('imp-go'); b.textContent = `Import checked (${n})`; b.disabled = n === 0;
}

async function impApply() {
  const sel = [];
  impData.items.forEach((it, i) => {
    if (!document.getElementById('imp-chk-' + i).checked) return;
    const s = { key: it.key };
    const input = document.getElementById('imp-client-' + i);
    if (input) { const m = input.value.match(/ — (.+)$/); s.clientId = m ? m[1] : ''; }
    sel.push(s);
  });
  const b = document.getElementById('imp-go'); b.disabled = true; b.textContent = 'Importing…';
  try {
    const out = await ownerPost('schedImportApply', { selections: sel }, 180000);
    showToast(`Imported ${out.imported}` + (out.failed ? `, ${out.failed} failed` : ''));
    if (out.failed) alert('Some items could not be imported:\n' + out.results.filter(r => !r.ok).map(r => `${r.key}: ${r.error}`).join('\n'));
    await schedLoad();
    impOpen(); // rescan: imported items drop out of the list
  } catch (e) { showToast('Import failed: ' + e.message); impCount(); }
}
