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
// loadAll() is also wired to the "↺ Load all sheets" button.
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

// ── Cache clear (called by the reload button) ────────────────
function clearCrewCache() {
  // Clear client-side sessionStorage cache
  Object.keys(sessionStorage)
    .filter(k => k.startsWith('mg_cache_'))
    .forEach(k => sessionStorage.removeItem(k));
  // Also bust server-side CacheService so force-reload gets truly fresh data
  apiFetch('clear_server_cache').catch(() => {});
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

// ── Start: load all data ──────────────────────────────────────
// keepWarm trigger handles cold starts during business hours.
currentDay = todayDateKey();
loadAll();

