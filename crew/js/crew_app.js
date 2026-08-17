/* =============================================================
   crew_app.js
   Mantis Gardens — App Startup, Signout & Session Management

   Contains:
     - doSignOut()
     - Session timeout initialisation
     - Initial loadAll() call
   
   Load order: must be last script tag on the page so all other
   modules are defined before startup code runs.
   ============================================================= */

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

// ── Full reload (wired to the "↺ Reload Database" button) ─────
// Calls loadAll(true), which uses the crew_load_all_fresh action —
// this forces a live refresh of everything server-side (bypassing the
// cache-only default every other request uses) and returns the fresh
// data in this one round trip. Replaces the old two-step "clear the
// server cache, then reload" flow, which doesn't make sense anymore:
// clearing a client-side cache and then calling the normal
// crew_load_all wouldn't force a fresh fetch on its own -- calling
// the _fresh variant directly (below) is what actually forces the
// backend to skip its own cache and refetch live.
// Disables the button, spins its icon, and swaps its label to
// "Refreshing..." immediately on click — the round trip takes a few
// seconds, and without a clear in-progress state it looks like the
// click did nothing.
async function reloadAll() {
  const btn   = document.getElementById('reload-btn');
  const label = document.getElementById('reload-btn-label');
  if (btn) {
    if (btn.disabled) return;   // a reload is already in flight — ignore
    btn.disabled = true;
    btn.classList.add('is-loading');
  }
  if (label) label.textContent = 'Refreshing…';

  await loadAll(true);

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
// Force a fresh server fetch on the first load after login
// (?fresh=1 is appended by mantis_landing.js on redirect), so crew
// always see current schedule and notes immediately after signing in.
// On subsequent page loads (e.g. after a browser refresh mid-day
// while the app has been open for hours), use normal caching so the
// crew don't get bounced back to login just because their 1-hour
// token has expired -- they may have been working all day with the
// app open and just need a local cache refresh, not a re-auth.
const _isFreshLogin = new URLSearchParams(window.location.search).has('fresh');
currentDay = todayDateKey();
loadAll(_isFreshLogin);

// ── Re-connect after background/sleep ─────────────────────────
// Mobile devices often lose network briefly when the screen wakes.
// If the crew member returns to the app after 15+ minutes away and
// data failed to load (showing the "No network" banner), this
// automatically retries after a short delay to let the network
// re-establish -- saving them from having to log out and back in.
let _lastVisibleAt = Date.now();
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') {
    _lastVisibleAt = Date.now();
    return;
  }
  const awayMs = Date.now() - _lastVisibleAt;
  // Only act if away more than 60 seconds -- short switches
  // (checking a text, etc.) don't need a re-fetch.
  if (awayMs < 60 * 1000) return;

  // Small delay so the network has time to re-establish after the
  // device wakes -- without this, the retry hits the same transient
  // failure that caused the banner in the first place.
  setTimeout(() => {
    const offlineBanner = document.getElementById('offline-banner');
    const isShowingOffline = offlineBanner && offlineBanner.style.display !== 'none';
    // Always retry if showing the offline banner (clearly failed).
    // Also silently refresh if away 15+ minutes so crew returning
    // from a long break see current schedule automatically.
    if (isShowingOffline || awayMs > 15 * 60 * 1000) {
      loadAll();
    }
  }, 2000);
});

