/* =============================================================
   crew_app.js
   Mantis Gardens — App Startup & Session Management

   Contains:
     - doSignOut()
     - Session timeout initialisation
     - Initial loadAll() call
   
   Load order: must be last script tag on the page so all other
   modules are defined before startup code runs.
   ============================================================= */

// =============================================================
// SECTION 11 — STARTUP
// Sets currentDay to today then fires loadAll().
// loadAll() is also wired to the "↺ Reload Database" button.
// =============================================================
// ── Sign out ─────────────────────────────────────────────────
function doSignOut() {
  const email = sessionStorage.getItem('mg_user_email') || localStorage.getItem('mg_user_email');
  // Revoke Google session if GIS library is available
  if (email && typeof google !== 'undefined' && google.accounts) {
    google.accounts.id.revoke(email, () => {});
  }
  // Clear both storage layers
  localStorage.removeItem('mg_auth');
  localStorage.removeItem('mg_user_email');
  localStorage.removeItem('mg_user_name');
  localStorage.removeItem('mg_auth_expiry');
  localStorage.removeItem('mg_session_start');
  sessionStorage.clear();
  window.location.href = 'index.html';
}

// ── Cache clear (called by the reload button) ─────────────────
// Async and awaited by the button handler so loadAll() doesn't fire
// its schedule/manager_schedule fetches until the server-side cache
// has actually been cleared — otherwise those requests can race ahead
// of the clear and still return stale cached data.
async function clearCrewCache() {
  // Clear client-side sessionStorage cache
  Object.keys(sessionStorage)
    .filter(k => k.startsWith('mg_cache_'))
    .forEach(k => sessionStorage.removeItem(k));
  // Also bust server-side CacheService so force-reload gets truly fresh data
  try { await apiFetch('clear_server_cache'); } catch(e) {}
}

// ── Full reload (wired to the "↺ Reload Database" button) ─────
// Waits for the server-side cache to be cleared before reloading,
// so the fetches inside loadAll() are guaranteed to see fresh data.
// Disables the button, spins its icon, and swaps its label to
// "Refreshing..." immediately on click — the cache-clear + fetch
// round-trip takes a few seconds, and without a clear in-progress
// state it looks like the click did nothing.
async function reloadAll() {
  const btn   = document.getElementById('reload-btn');
  const label = document.getElementById('reload-btn-label');
  if (btn) {
    if (btn.disabled) return;   // a reload is already in flight — ignore
    btn.disabled = true;
    btn.classList.add('is-loading');
  }
  if (label) label.textContent = 'Refreshing…';

  document.querySelectorAll('.status-pill').forEach(p => p.style.display = '');
  setStatus('clients',  'loading', 'Clients: loading...');
  setStatus('brief',    'loading', 'Morning brief: loading...');
  setStatus('calendar', 'loading', 'Calendar: loading...');

  await clearCrewCache();
  await loadAll();

  if (btn) btn.classList.remove('is-loading');
  if (label) label.textContent = 'Reload Database';
}

// ── Session timeout — 10 hours inactivity for crew ───────────
// sessionStorage is seeded from localStorage by mantis_landing.js on resume,
// so this check covers both fresh logins and restored sessions.
if (sessionStorage.getItem('mg_auth') === '1') {
  initSessionTimeout({
    timeoutMs:  10 * 60 * 60 * 1000,  // 10 hours
    warningMs:  5  * 60 * 1000,        // warn 5 min before
    sessionKey: 'mg_auth',
    loginUrl:   'index.html',
    onSignOut:  doSignOut,
  });
}

// ── Team lock — single-team view from the landing page picker ──
// ?team=t1|t2|t3|install locks the panel to that team: hides the
// team-tab switcher (via the .team-locked body class, in CSS) and
// scopes the day counts / summary stats to just that team.
// ?team=managers or no param at all gives the full tabbed view —
// and if the logged-in user is a manager, that view opens on the
// Managers tab by default instead of Team 1.
(function initTeamLock() {
  const teamParam = new URLSearchParams(window.location.search).get('team');
  if (teamParam && TEAM_DAY_KEY.hasOwnProperty(teamParam)) {
    lockedTeam = teamParam;
    activeTeam = teamParam;
    document.body.classList.add('team-locked');
  } else if (isManagerUser()) {
    activeTeam = 'managers';
  }
})();

// ── Start: load all data ──────────────────────────────────────
// keepWarm trigger handles cold starts during business hours.
currentDay = todayDateKey();
loadAll();

