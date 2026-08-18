/* =============================================================
   mantis_landing.js
   Mantis Gardens — Landing Page & Home Screen

   Sections:
     1.  Configuration
     2.  Screen Management
     3.  Google Sign-In  (initGoogleSignIn, handleCredential, doSignOut)
     4.  Home Setup  (setupHome — greeting, date)
     5.  Navigation  (goTo)
     6.  Startup
   ============================================================= */

// =============================================================
// SECTION 1 — CONFIGURATION
// =============================================================
const CREW_URL   = (typeof MANTIS_CONFIG !== 'undefined') ? MANTIS_CONFIG.CREW_URL            : 'mantis_crew_panel.html';
const MANUAL_URL = (typeof MANTIS_CONFIG !== 'undefined') ? MANTIS_CONFIG.MANUAL_URL          : 'mantis_service_manual.html';
const CLIENT_ID  = (typeof MANTIS_CONFIG !== 'undefined') ? MANTIS_CONFIG.GOOGLE_CLIENT_ID    : '';
const SCRIPT_URL = (typeof MANTIS_CONFIG !== 'undefined') ? MANTIS_CONFIG.SCRIPT_URL          : '';


// =============================================================
// SECTION 2 — SCREEN MANAGEMENT
// =============================================================
function show(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById('screen-' + id).classList.add('active');
}

function showLoginError(msg) {
  const el = document.getElementById('login-error');
  el.textContent = msg || 'Account not authorised. Contact your manager.';
  el.style.display = 'block';
}

function hideLoginError() {
  document.getElementById('login-error').style.display = 'none';
}


// =============================================================
// SECTION 3 — GOOGLE SIGN-IN
// =============================================================

// ── gisInitialize ────────────────────────────────────────────
// Calling google.accounts.id.initialize() more than once per page life
// is what was producing the console warning "initialize() is called
// multiple times" — and it's not just cosmetic: re-initializing while
// a FedCM credential request from the first initialize() may still be
// in flight aborts that request ("FedCM get() rejects with AbortError"),
// and repeated aborted FedCM requests are exactly what trips Chrome's
// "FedCM was disabled...based on previous user action" cooldown for the
// site. Once that cooldown kicks in, the next sign-in has to fall all
// the way back to GIS's slower iframe-relay flow (COOP postMessage
// warnings come from that fallback) instead of the fast FedCM path —
// which is the ~20 second delay before login is allowed.
// This guard makes initialize() genuinely idempotent: only the first
// call in a page's life actually calls the GIS API; later callers
// (e.g. doSignOut() re-rendering the button) just skip straight to
// whatever they needed init for.
let _gisInitDone = false;
function gisInitialize(config) {
  if (_gisInitDone) return;
  google.accounts.id.initialize(config);
  _gisInitDone = true;
}

function initGoogleSignIn() {
  if (!CLIENT_ID) {
    console.error('GOOGLE_CLIENT_ID not set in mantis_config.js');
    return;
  }

  gisInitialize({
    client_id:   CLIENT_ID,
    callback:    handleCredential,
    auto_select: false,
  });

  google.accounts.id.renderButton(
    document.getElementById('google-signin-btn'),
    { theme:'filled_blue', size:'large', width:260, text:'signin_with', shape:'rectangular' }
  );
  // No prompt() here — user must tap the button explicitly.
  // prompt() triggers One Tap which can fire handleCredential automatically,
  // racing with cleared storage state after sign-out.
}

// Plain fetch() has NO built-in timeout — if a request stalls mid-
// flight (a dropped or degraded connection), the promise just sits
// pending forever, with no recovery but a manual page reload. A real
// report on the crew panel's data loading showed exactly this pattern
// (stuck indefinitely, resolved instantly by reloading — proving the
// backend wasn't the problem). AbortController forces a stalled
// request to actually fail after FETCH_TIMEOUT_MS, so
// fetchJsonWithRetry() below treats it like any other failure instead
// of leaving the login button hanging forever.
// 7s — see the matching comment in crew_api.js. A HAR capture of a
// real slow load showed the actual failure mode: the initial /exec
// request always gets its redirect back in 1-2s, but the follow-up
// fetch of the redirect target (script.googleusercontent.com/macros/
// echo) can hang completely dead until aborted — at which point the
// existing retry below succeeds in under a second. No legitimate
// slow-but-progressing case was found for a long timeout to protect;
// 30s was just making every dead connection sit that much longer
// before the retry (which reliably works) got a chance.
const FETCH_TIMEOUT_MS = 7000;
function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs === undefined ? FETCH_TIMEOUT_MS : timeoutMs);
  return fetch(url, { signal: controller.signal }).finally(() => clearTimeout(timer));
}

// ── fetchJsonWithRetry ──────────────────────────────────────────
// Apps Script Web Apps intermittently fail the redirect they use to
// serve /exec responses (a 302 to script.googleusercontent.com/macros/
// echo, which occasionally 404s with an HTML page instead of the real
// JSON, or just hangs at zero bytes until FETCH_TIMEOUT_MS aborts it)
// — a known Google-side serving glitch, not something this app's code
// controls.
//
// 2 retries (not 1) — see the matching comment in crew_api.js's
// fetchJsonWithRetry(): a HAR capture showed this exact stall hitting
// twice in a row before a third attempt succeeded, so a single retry
// isn't always enough to keep a transient blip from surfacing as a
// failed login.
function fetchJsonWithRetry(url, retries) {
  retries = retries === undefined ? 2 : retries;
  return fetchWithTimeout(url)
    .then(r => r.json())
    .catch(err => {
      if (retries > 0) {
        return new Promise(resolve => setTimeout(resolve, 700))
          .then(() => fetchJsonWithRetry(url, retries - 1));
      }
      throw err;
    });
}

// Called by Google after successful sign-in with a JWT credential
function handleCredential(response) {
  try {
    // Decode name/email from JWT payload for display only — not for security
    const parts   = response.credential.split('.');
    const payload = JSON.parse(atob(parts[1].replace(/-/g,'+').replace(/_/g,'/')));
    const email   = payload.email || '';
    const name    = payload.name  || email;

    // Show a verifying state
    hideLoginError();
    const btn = document.getElementById('google-signin-btn');
    if (btn) btn.style.opacity = '0.5';

    // Store token for the verification call
    sessionStorage.setItem('mg_id_token', response.credential);

    // Verify with Apps Script — this is the REAL security check.
    // The server checks the token signature with Google and confirms
    // the email is in the APPROVED_USERS Script Property.
    // The client never sees the approved list.
    const idToken = encodeURIComponent(response.credential);
    fetchJsonWithRetry(`${SCRIPT_URL}/ping/authed?id_token=${idToken}`)
      .then(json => {
        if (btn) btn.style.opacity = '1';
        if (json.error) {
          // Server rejected — clear token and show error
          sessionStorage.removeItem('mg_id_token');
          showLoginError('Account not authorised. Contact your manager.');
          google.accounts.id.disableAutoSelect();
          return;
        }
        // Approved — store identity in localStorage with 10-hour expiry
        const expiry   = Date.now() + (10 * 60 * 60 * 1000);
        const category = json.crewCategory || '';
        const role     = json.crewRole     || '';
        localStorage.setItem('mg_auth',          '1');
        localStorage.setItem('mg_user_email',    email);
        localStorage.setItem('mg_user_name',     name);
        localStorage.setItem('mg_user_category', category);
        localStorage.setItem('mg_user_role',     role);
        localStorage.setItem('mg_auth_expiry',   expiry.toString());
        localStorage.setItem('mg_session_start', Date.now().toString());
        // Exchange the Google JWT for a Mantis session token with a
        // 10-hour lifetime so crew don't need to re-authenticate every
        // hour. The Google token is stored as the initial fallback; the
        // session token overwrites it if the exchange succeeds.
        // If SESSION_SECRET isn't configured on the server yet, the
        // exchange returns 503 and we silently fall back to the 1-hour
        // Google token -- nothing breaks, sessions just expire sooner.
        const tokenExpiry = Date.now() + (60 * 60 * 1000); // 1-hour fallback
        localStorage.setItem('mg_id_token',        response.credential);
        localStorage.setItem('mg_id_token_expiry', tokenExpiry.toString());
        // Attempt session token exchange (async, non-blocking).
        // On success, overwrites the short-lived Google token with the
        // 10-hour session token so all subsequent requests and tab
        // restores use the long-lived one automatically.
        fetch(SCRIPT_URL + '/auth/session', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id_token: response.credential }),
        }).then(r => r.ok ? r.json() : null).then(data => {
          if (data && data.session_token) {
            localStorage.setItem('mg_id_token',        data.session_token);
            localStorage.setItem('mg_id_token_expiry', data.expires_at.toString());
            sessionStorage.setItem('mg_id_token',      data.session_token);
          }
        }).catch(() => { /* silently use Google token fallback */ });
        // Also seed sessionStorage so session_timeout.js works
        sessionStorage.setItem('mg_auth',          '1');
        sessionStorage.setItem('mg_user_email',    email);
        sessionStorage.setItem('mg_user_name',     name);
        sessionStorage.setItem('mg_user_category', category);
        sessionStorage.setItem('mg_user_role',     role);
        // If we were sent here for a token refresh (?return=panel),
        // go straight back to the crew panel instead of showing the
        // home screen -- the crew member just wants to get back to work.
        if (new URLSearchParams(window.location.search).has('return')) {
          window.location.href = CREW_URL;  // no ?fresh=1 -- data is still cached
          return;
        }
        setupHome(name, category);
        show('home');
      })
      .catch(err => {
        if (btn) btn.style.opacity = '1';
        sessionStorage.removeItem('mg_id_token');
        showLoginError('Could not reach server. Check your connection.');
        console.error('Login verification failed:', err);
      });

  } catch(e) {
    console.error('handleCredential error:', e);
    showLoginError('Sign-in error. Please try again.');
  }
}

function doSignOut() {
  // Note: we intentionally do NOT call google.accounts.id.revoke() here.
  // Revoking causes GIS to suppress the next credential callback, which
  // results in a broken login state until the page is refreshed.
  // disableAutoSelect() below is sufficient to prevent auto sign-in.

  // Clear both storage layers
  localStorage.removeItem('mg_auth');
  localStorage.removeItem('mg_user_email');
  localStorage.removeItem('mg_user_name');
  localStorage.removeItem('mg_user_category');
  localStorage.removeItem('mg_user_role');
  localStorage.removeItem('mg_auth_expiry');
  localStorage.removeItem('mg_session_start');
  localStorage.removeItem('mg_id_token');
  localStorage.removeItem('mg_id_token_expiry');
  localStorage.removeItem('mg_session_token');
  localStorage.removeItem('mg_session_token_expiry');
  localStorage.removeItem('mg_last_fresh_load');
  sessionStorage.clear();
  show('login');
  hideLoginError();
  if (typeof google !== 'undefined' && google.accounts) {
    // gisInitialize() is idempotent (see Section 3) — a no-op if
    // initGoogleSignIn() already ran on this page load, or the one call
    // that actually initializes GIS if we got here straight from a
    // persisted session (which no longer initializes GIS itself on
    // load — see the comment in the startup section). Either way this
    // is safe: it's still at most one real initialize() call per page
    // life. disableAutoSelect() prevents auto sign-in with a cached
    // credential before the user taps the button.
    gisInitialize({
      client_id:   CLIENT_ID,
      callback:    handleCredential,
      auto_select: false,
    });
    google.accounts.id.disableAutoSelect();
    google.accounts.id.renderButton(
      document.getElementById('google-signin-btn'),
      { theme:'filled_blue', size:'large', width:260, text:'signin_with', shape:'rectangular' }
    );
  }
}


// =============================================================
// SECTION 4 — HOME SETUP
// =============================================================
function setupHome(userName, crewCategory) {
  const now  = new Date();
  const hr   = now.getHours();
  const greeting = hr < 12 ? 'Good morning' : hr < 17 ? 'Good afternoon' : 'Good evening';
  const name = userName || sessionStorage.getItem('mg_user_name') || '';
  const cat  = crewCategory !== undefined
    ? crewCategory
    : (sessionStorage.getItem('mg_user_category') || localStorage.getItem('mg_user_category') || '');
  document.getElementById('greeting-text').textContent =
    greeting + (name ? ', ' + name.split(' ')[0] : '');
  const catEl = document.getElementById('greeting-category');
  const isLead = (sessionStorage.getItem('mg_user_role') || '').toLowerCase() === 'lead';
  if (catEl) catEl.textContent = cat ? 'Team: ' + cat + (isLead ? ' (Lead)' : '') : '';

  document.getElementById('today-text').textContent =
    now.toLocaleDateString('en-US', { weekday:'long', month:'long', day:'numeric', year:'numeric' });
}


// =============================================================
// SECTION 5 — NAVIGATION
// =============================================================
function goTo(dest) {
  if (dest === 'crew')   window.location.href = CREW_URL + '?fresh=1';
  if (dest === 'manual') window.location.href = MANUAL_URL;
}

// ── Team picker modal ───────────────────────────────────────
// "Crew Assignments" opens this instead of navigating straight
// to the crew panel. Team 1/2/3/Install pass ?team=<id> so the
// crew panel locks to just that team (no team-tab switcher —
// just that team's morning brief + client cards). Managers gets
// ?team=managers, which the crew panel treats as the full,
// unlocked, all-teams tabbed view.
// Same category-based check used on the crew panel side (crew_config.js
// isManagerUser()) — mg_user_category is already seeded here at login,
// before the crew panel is ever opened.
function isManagerUser() {
  const cat = (sessionStorage.getItem('mg_user_category')
            || localStorage.getItem('mg_user_category') || '').toLowerCase();
  return cat.includes('manager');
}

function openTeamPicker(e) {
  if (e) e.stopPropagation();
  const mgrBtn = document.getElementById('team-picker-managers');
  if (mgrBtn) mgrBtn.style.display = isManagerUser() ? '' : 'none';
  const el = document.getElementById('team-picker-overlay');
  if (el) el.classList.add('active');
}
function closeTeamPicker() {
  const el = document.getElementById('team-picker-overlay');
  if (el) el.classList.remove('active');
}
function closeTeamPickerOutside(e) {
  if (e.target.id === 'team-picker-overlay') closeTeamPicker();
}
function selectTeam(team) {
  window.location.href = CREW_URL + '?fresh=1&team=' + encodeURIComponent(team);
}


// =============================================================
// SECTION 6 — STARTUP
// =============================================================

// Show timeout message if redirected here due to inactivity
if (sessionStorage.getItem('mg_timeout') === '1') {
  sessionStorage.removeItem('mg_timeout');
  const err = document.getElementById('login-error');
  if (err) {
    err.textContent = 'You were signed out due to inactivity.';
    err.style.display = 'block';
  }
}

// Token-expired redirect (?return=panel): the crew panel detected an
// expired Google ID token and sent the crew member here to re-auth.
// Show a clear message and skip the persisted-session fast-path below
// so they actually sign in and get a fresh token rather than being
// silently shunted back to the home screen with the same stale token.
const _returnToCrew = new URLSearchParams(window.location.search).has('return');
if (_returnToCrew) {
  sessionStorage.removeItem('mg_id_token');
  const err = document.getElementById('login-error');
  if (err) {
    err.textContent = 'Your session token expired. Please sign in again.';
    err.style.display = 'block';
  }
}

// Check for a valid persisted localStorage session (survives window close)
const _persistedAuth   = localStorage.getItem('mg_auth');
const _persistedExpiry = parseInt(localStorage.getItem('mg_auth_expiry') || '0');
const _persistedName   = localStorage.getItem('mg_user_name')  || '';
const _persistedEmail  = localStorage.getItem('mg_user_email') || '';
const _hasPersistedSession = _persistedAuth === '1' && Date.now() < _persistedExpiry;

if (_hasPersistedSession && !_returnToCrew) {
  // Seed sessionStorage so session_timeout.js and the crew panel work normally
  const _persistedCategory = localStorage.getItem('mg_user_category') || '';
  const _persistedRole     = localStorage.getItem('mg_user_role')     || '';
  sessionStorage.setItem('mg_auth',          '1');
  sessionStorage.setItem('mg_user_email',    _persistedEmail);
  sessionStorage.setItem('mg_user_name',     _persistedName);
  sessionStorage.setItem('mg_user_category', _persistedCategory);
  sessionStorage.setItem('mg_user_role',     _persistedRole);
  // Restore the token from localStorage if it hasn't expired yet
  const _persistedToken       = localStorage.getItem('mg_id_token') || '';
  const _persistedTokenExpiry = parseInt(localStorage.getItem('mg_id_token_expiry') || '0');
  if (_persistedToken && Date.now() < _persistedTokenExpiry) {
    sessionStorage.setItem('mg_id_token', _persistedToken);
  }
  setupHome(_persistedName, _persistedCategory);
  show('home');

  // Deliberately NOT calling google.accounts.id.prompt() here anymore.
  // This used to silently refresh mg_id_token on every single page
  // load/reopen that had a persisted session — but that's exactly the
  // kind of automatic, non-user-initiated FedCM request Chrome's abuse
  // prevention watches for, and firing it on every reopen (crew opening
  // the tab repeatedly through the day, or just reloading while testing)
  // was enough to trip the "FedCM was disabled...based on previous user
  // action" cooldown — which then also blocked the *next* real
  // interactive sign-in attempt, not just this silent one.
  // It isn't actually load-bearing: 'ping' (the only crew action that
  // checks id_token server-side) always uses the token from the live
  // interactive credential response in handleCredential(), never this
  // background refresh — so a stale/missing mg_id_token here has no
  // visible effect on a returning crew member.

} else {
  // No valid persisted session — clear stale localStorage and show login
  localStorage.removeItem('mg_auth');
  localStorage.removeItem('mg_user_email');
  localStorage.removeItem('mg_user_name');
  localStorage.removeItem('mg_user_category');
  localStorage.removeItem('mg_user_role');
  localStorage.removeItem('mg_auth_expiry');
  localStorage.removeItem('mg_id_token');
  localStorage.removeItem('mg_id_token_expiry');
  show('login');

  // Initialize GIS for the login screen
  window.addEventListener('load', () => {
    if (typeof google !== 'undefined' && google.accounts) {
      initGoogleSignIn();
    } else {
      const gisScript = document.querySelector('script[src*="accounts.google.com/gsi"]');
      if (gisScript) gisScript.addEventListener('load', initGoogleSignIn);
    }
  });
}
