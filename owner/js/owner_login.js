/* =============================================================
   owner_login.js
   Mantis Gardens — Owner Portal Login
   ============================================================= */

const CLIENT_ID  = (typeof OWNER_CONFIG !== 'undefined') ? OWNER_CONFIG.GOOGLE_CLIENT_ID : '';
const SCRIPT_URL = (typeof OWNER_CONFIG !== 'undefined') ? OWNER_CONFIG.SCRIPT_URL       : '';

// Plain fetch() has NO built-in timeout — if a request stalls mid-
// flight (a dropped or degraded connection), the promise just sits
// pending forever, with no recovery but a manual page reload. This was
// the one remaining login entry point without this protection — see
// the matching comment in mantis_landing.js (the crew login page) for
// the full history: a HAR capture of a real slow load showed the
// actual failure mode is the browser's follow-up fetch of the /exec
// redirect target (script.googleusercontent.com/macros/echo) hanging
// completely dead until something aborts it, with the existing
// retry-after-abort succeeding in under a second every time.
// AbortController forces that stall to actually fail after
// FETCH_TIMEOUT_MS so fetchJsonWithRetry() below can recover from it
// instead of leaving the sign-in button dimmed forever.
const FETCH_TIMEOUT_MS = 7000;
function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs === undefined ? FETCH_TIMEOUT_MS : timeoutMs);
  return fetch(url, { signal: controller.signal }).finally(() => clearTimeout(timer));
}

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

// Show timeout message if redirected here due to inactivity
if (sessionStorage.getItem('mg_timeout') === '1') {
  sessionStorage.removeItem('mg_timeout');
  window.addEventListener('DOMContentLoaded', () => {
    const err = document.getElementById('login-error');
    if (err) {
      err.textContent = 'You were signed out due to inactivity.';
      err.style.display = 'block';
    }
  });
}

// Token expiry — redirected from dashboard after 1hr token expiry.
// Just clear the flag; no user-visible message needed. (This used to
// also rely on a silent google.accounts.id.prompt() call below to
// auto-recover without the owner seeing a login screen at all — but
// owner_dashboard.js's _refreshOwnerToken() already attempts exactly
// that same silent refresh directly on the dashboard before ever
// redirecting here, so by the time someone lands on this page for
// this reason, that path has already been tried and failed. A second
// automatic prompt() attempt here was mostly redundant for that case,
// while being exactly the kind of automatic, non-user-initiated FedCM
// request that Chrome's abuse prevention watches for — firing it on
// every single page load (this page has no persisted-session skip the
// way the crew login page does, so it ran every time) was enough to
// trip the "FedCM was disabled...based on previous user action"
// cooldown, which then also blocked the next real interactive sign-in
// attempt. See gisInitialize()'s comment in mantis_landing.js for the
// full story — this is the same bug, just in the owner login page,
// which hadn't been touched when that one was fixed.
if (sessionStorage.getItem('owner_token_expired') === '1') {
  sessionStorage.removeItem('owner_token_expired');
}

function showError(msg) {
  const el = document.getElementById('login-error');
  el.textContent = msg || 'Access restricted to authorised owner accounts.';
  el.style.display = 'block';
}

function initGoogleSignIn() {
  if (!CLIENT_ID) return;
  google.accounts.id.initialize({
    client_id:   CLIENT_ID,
    callback:    handleCredential,
    auto_select: true,
  });
  google.accounts.id.renderButton(
    document.getElementById('google-signin-btn'),
    { theme:'filled_blue', size:'large', width:260, text:'signin_with', shape:'rectangular' }
  );
  // Deliberately no google.accounts.id.prompt() call here anymore —
  // see the comment above. The rendered button still gives a normal,
  // explicit, user-initiated sign-in with no FedCM cooldown risk.
}

function handleCredential(response) {
  try {
    const parts   = response.credential.split('.');
    const payload = JSON.parse(atob(parts[1].replace(/-/g,'+').replace(/_/g,'/')));
    const email   = payload.email || '';
    const name    = payload.name  || email;

    const btn = document.getElementById('google-signin-btn');
    if (btn) btn.style.opacity = '0.5';

    // Verify with server — owner check happens in Apps Script
    const idToken = encodeURIComponent(response.credential);
    fetchJsonWithRetry(`${SCRIPT_URL}?action=ownerPing&id_token=${idToken}`)
      .then(json => {
        if (btn) btn.style.opacity = '1';
        if (json.error) {
          sessionStorage.removeItem('owner_id_token');
          showError('Access restricted to authorised owner accounts.');
          google.accounts.id.disableAutoSelect();
          return;
        }
        sessionStorage.setItem('owner_auth',       '1');
        sessionStorage.setItem('owner_id_token',   response.credential);
        sessionStorage.setItem('owner_user_email', email);
        sessionStorage.setItem('owner_user_name',  name);
        window.location.href = OWNER_CONFIG.DASHBOARD_URL;
      })
      .catch(() => {
        if (btn) btn.style.opacity = '1';
        showError('Could not reach server. Check your connection.');
      });
  } catch(e) {
    showError('Sign-in error. Please try again.');
  }
}

// Auto-redirect if already logged in
if (sessionStorage.getItem('owner_auth') === '1') {
  window.location.href = (typeof OWNER_CONFIG !== 'undefined')
    ? OWNER_CONFIG.DASHBOARD_URL : 'owner_dashboard.html';
}

window.addEventListener('load', () => {
  if (typeof google !== 'undefined' && google.accounts) {
    initGoogleSignIn();
  } else {
    const s = document.querySelector('script[src*="accounts.google.com/gsi"]');
    if (s) s.addEventListener('load', initGoogleSignIn);
  }
});
