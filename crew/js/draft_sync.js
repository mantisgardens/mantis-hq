/* =============================================================
   draft_sync.js
   Mantis Gardens — keeps saved (unsubmitted) work records on the server
   so a draft started on a phone opens on any other device, e.g. the
   office computer at the end of the day. Backend: /work-record-drafts
   (mantis-backend/src/lib/workRecordDrafts.js).

   The work record code (crew_workrecord.js) still saves every draft in
   this browser first (savedRecords / localStorage 'mg_work_records').
   This file hooks in around it, without changing it:
     - safeLocalSave()  -> after each local save, the open job's record is
                           sent to the server (debounced). Saves that fail
                           (no signal) are retried when back online.
     - openWorkRecord() / openMgrWorkRecord() -> before the form opens,
                           the server copy is fetched; if it is newer than
                           this browser's copy it is used instead.
     - render()         -> the "saved" badges on job cards also show
                           drafts saved on another device.
   The newest save wins (by the record's savedAt time). Photos are never
   part of a draft. Loads after crew_workrecord.js and crew_render.js.
   ============================================================= */
(function () {
  if (typeof savedRecords === 'undefined' || typeof safeLocalSave !== 'function') return;

  const PUSH_DELAY_MS = 1500;
  const PULL_TIMEOUT_MS = 3500;
  const BADGE_RECHECK_MS = 60 * 1000;
  const PENDING_KEY = 'mg_draft_push_pending';

  const base = () => (typeof SCRIPT_URL !== 'undefined' ? SCRIPT_URL : '');
  function idToken() {
    let t = sessionStorage.getItem('mg_id_token') || '';
    if (!t) {
      const ls = localStorage.getItem('mg_id_token') || '';
      if (ls && Date.now() < parseInt(localStorage.getItem('mg_id_token_expiry') || '0')) { sessionStorage.setItem('mg_id_token', ls); t = ls; }
    }
    return t;
  }
  const ready = () => base() && base() !== 'PASTE_YOUR_CLOUD_RUN_URL_HERE' && idToken();

  // ── Local save without triggering another push ──────────────
  const localSaveOnly = safeLocalSave;

  // ── Pull: fetch server copies and keep whichever is newer ───
  async function pull(ids) {
    ids = ids.filter(Boolean);
    if (!ids.length || !ready() || navigator.onLine === false) return {};
    const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ctl ? setTimeout(() => ctl.abort(), PULL_TIMEOUT_MS) : null;
    try {
      const url = `${base()}/work-record-drafts?ids=${encodeURIComponent(ids.join(','))}&id_token=${encodeURIComponent(idToken())}`;
      const res = await fetch(url, ctl ? { signal: ctl.signal } : undefined);
      if (!res.ok) return {};
      const json = await res.json();
      const drafts = (json && json.drafts) || {};
      let changed = false;
      for (const [id, d] of Object.entries(drafts)) {
        const local = savedRecords[id];
        if (d && d.record && (!local || (d.savedAt || '') > (local.savedAt || ''))) {
          savedRecords[id] = d.record;
          changed = true;
        }
      }
      if (changed) localSaveOnly();
      return drafts;
    } catch (e) {
      return {};                                    // offline or slow: use this browser's copy
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  // ── Push: send this browser's copy of one job ───────────────
  const pending = new Set((() => { try { return JSON.parse(localStorage.getItem(PENDING_KEY) || '[]'); } catch (e) { return []; } })());
  const savePending = () => { try { localStorage.setItem(PENDING_KEY, JSON.stringify([...pending])); } catch (e) {} };
  const timers = {};

  function schedulePush(id) {
    if (!id) return;
    clearTimeout(timers[id]);
    timers[id] = setTimeout(() => push(id), PUSH_DELAY_MS);
  }

  async function push(id) {
    const rec = savedRecords[id];
    if (!rec || !rec.savedAt) { pending.delete(id); savePending(); return; }
    // A full record marked submitted is a submit still in flight (or one that failed
    // and will be retried): leave the server copy alone until the small
    // { submitted: true } marker replaces it on success.
    if (rec.submitted && rec.workers) return;
    if (!ready() || navigator.onLine === false) { pending.add(id); savePending(); return; }
    try {
      const res = await fetch(`${base()}/work-record-drafts/${encodeURIComponent(id)}?id_token=${encodeURIComponent(idToken())}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ record: Object.assign({}, rec, { photos: [] }) }),
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const json = await res.json();
      pending.delete(id); savePending();
      // Someone saved this job more recently on another device. Their copy is kept;
      // the next edit here saves over it (newest wins), so just say so.
      if (json.kept === 'newer' && json.draft && currentJobId === id && typeof showToast === 'function') {
        showToast(`A newer draft of this record was saved${json.draft.savedBy ? ' by ' + json.draft.savedBy : ''} on another device. Close and reopen it to see that version.`, 7000);
      }
    } catch (e) {
      pending.add(id); savePending();
    }
  }

  function pushPending() { [...pending].forEach(push); }
  window.addEventListener('online', pushPending);
  setTimeout(pushPending, 4000);

  // ── Hook: every local save of the open job also goes to the server ──
  safeLocalSave = function () {
    const out = localSaveOnly.apply(this, arguments);
    if (typeof currentJobId !== 'undefined' && currentJobId && savedRecords[currentJobId]) schedulePush(currentJobId);
    return out;
  };

  // ── Hook: opening a work record checks the server first ────
  let opening = false;
  function wrapOpen(name, keyOf) {
    const orig = window[name];
    if (typeof orig !== 'function') return;
    window[name] = async function () {
      if (opening) return;                          // ignore a second tap while fetching
      opening = true;
      const args = arguments;
      try { await pull([keyOf(args)]); } finally { opening = false; }
      return orig.apply(this, args);
    };
  }
  wrapOpen('openWorkRecord', (a) => a[0]);
  wrapOpen('openMgrWorkRecord', (a) => 'mgr_' + a[0]);

  // ── Hook: "saved" badges include drafts from other devices ──
  const checkedAt = {};
  let badgeTimer = null;
  function syncBadges() {
    const btns = [...document.querySelectorAll('[id^="wr-btn-"]')];
    const now = Date.now();
    const ids = btns.map(b => b.id.slice(7)).filter(id => !checkedAt[id] || now - checkedAt[id] > BADGE_RECHECK_MS);
    if (!ids.length) return;
    ids.forEach(id => { checkedAt[id] = now; });
    pull(ids).then(() => {
      btns.forEach(btn => {
        const rec = savedRecords[btn.id.slice(7)];
        const badge = btn.querySelector('.saved-badge');
        if (rec && !rec.submitted && !badge) btn.innerHTML += '<span class="saved-badge">saved</span>';
        if (rec && rec.submitted && badge) badge.remove();
      });
    });
  }
  if (typeof render === 'function') {
    const origRender = render;
    render = function () {
      const out = origRender.apply(this, arguments);
      clearTimeout(badgeTimer);
      badgeTimer = setTimeout(syncBadges, 300);
      return out;
    };
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') { Object.keys(checkedAt).forEach(k => delete checkedAt[k]); syncBadges(); }
  });

  window.DraftSync = { pull, push, syncBadges };
})();
