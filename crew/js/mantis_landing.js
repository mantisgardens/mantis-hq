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

function initGoogleSignIn() {
  if (!CLIENT_ID) {
    console.error('GOOGLE_CLIENT_ID not set in mantis_config.js');
    return;
  }

  google.accounts.id.initialize({
    client_id:   CLIENT_ID,
    callback:    handleCredential,
    auto_select: true,
  });

  google.accounts.id.renderButton(
    document.getElementById('google-signin-btn'),
    { theme:'filled_blue', size:'large', width:260, text:'signin_with', shape:'rectangular' }
  );

  safePrompt();
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
    fetch(`${SCRIPT_URL}?action=ping&id_token=${idToken}`)
      .then(r => r.json())
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
        const expiry = Date.now() + (10 * 60 * 60 * 1000);
        localStorage.setItem('mg_auth',        '1');
        localStorage.setItem('mg_user_email',  email);
        localStorage.setItem('mg_user_name',   name);
        localStorage.setItem('mg_auth_expiry', expiry.toString());
        // Also seed sessionStorage so session_timeout.js works
        sessionStorage.setItem('mg_auth',       '1');
        sessionStorage.setItem('mg_user_email', email);
        sessionStorage.setItem('mg_user_name',  name);
        setupHome(name);
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
  const email = sessionStorage.getItem('mg_user_email') || localStorage.getItem('mg_user_email');
  if (email && typeof google !== 'undefined') {
    google.accounts.id.revoke(email, () => {});
  }
  // Clear both storage layers
  localStorage.removeItem('mg_auth');
  localStorage.removeItem('mg_user_email');
  localStorage.removeItem('mg_user_name');
  localStorage.removeItem('mg_auth_expiry');
  sessionStorage.clear();
  show('login');
  if (typeof google !== 'undefined') {
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
function setupHome(userName) {
  const now  = new Date();
  const hr   = now.getHours();
  const greeting = hr < 12 ? 'Good morning' : hr < 17 ? 'Good afternoon' : 'Good evening';
  const name = userName || sessionStorage.getItem('mg_user_name') || '';
  document.getElementById('greeting-text').textContent =
    greeting + (name ? ', ' + name.split(' ')[0] : '');
  document.getElementById('today-text').textContent =
    now.toLocaleDateString('en-US', { weekday:'long', month:'long', day:'numeric', year:'numeric' });
}


// =============================================================
// SECTION 5 — NAVIGATION
// =============================================================
function goTo(dest) {
  if (dest === 'crew')   window.location.href = CREW_URL;
  if (dest === 'manual') window.location.href = MANUAL_URL;
}


// =============================================================
// SECTION 6 — STARTUP
// =============================================================

// Guard against multiple simultaneous google.accounts.id.prompt() calls
// which throw "Only one navigator.credentials.get request may be outstanding"
let _gisPromptPending = false;
function safePrompt() {
  if (_gisPromptPending) return;
  _gisPromptPending = true;
  try {
    google.accounts.id.prompt(notification => {
      _gisPromptPending = false;
    });
  } catch(e) {
    _gisPromptPending = false;
    console.warn('GIS prompt suppressed:', e.message);
  }
}

window.addEventListener('load', () => {
  if (typeof google !== 'undefined' && google.accounts) {
    initGoogleSignIn();
  } else {
    const gisScript = document.querySelector('script[src*="accounts.google.com/gsi"]');
    if (gisScript) gisScript.addEventListener('load', initGoogleSignIn);
  }
});

// Show timeout message if redirected here due to inactivity
if (sessionStorage.getItem('mg_timeout') === '1') {
  sessionStorage.removeItem('mg_timeout');
  const err = document.getElementById('login-error');
  if (err) {
    err.textContent = 'You were signed out due to inactivity.';
    err.style.display = 'block';
  }
}

// Skip login if a valid localStorage session exists (persists across window close)
// On resume, session_timeout uses sessionStorage — seed it from localStorage.
(function checkPersistedSession() {
  const auth   = localStorage.getItem('mg_auth');
  const expiry = parseInt(localStorage.getItem('mg_auth_expiry') || '0');
  const name   = localStorage.getItem('mg_user_name')  || '';
  const email  = localStorage.getItem('mg_user_email') || '';

  if (auth === '1' && Date.now() < expiry) {
    // Seed sessionStorage so session_timeout.js and the crew panel work normally
    sessionStorage.setItem('mg_auth',       '1');
    sessionStorage.setItem('mg_user_email', email);
    sessionStorage.setItem('mg_user_name',  name);
    setupHome(name);
    show('home');
    // Silently ask Google for a fresh ID token in the background.
    // Uses safePrompt() to prevent collision with initGoogleSignIn's prompt().
    window.addEventListener('load', () => {
      if (typeof google !== 'undefined' && google.accounts) {
        google.accounts.id.initialize({
          client_id:   CLIENT_ID,
          callback:    function(resp) {
            if (resp && resp.credential) {
              sessionStorage.setItem('mg_id_token', resp.credential);
            }
          },
          auto_select: true,
        });
        safePrompt();
      }
    });
  } else {
    // Expired or no persisted session — clear stale localStorage and show login
    localStorage.removeItem('mg_auth');
    localStorage.removeItem('mg_user_email');
    localStorage.removeItem('mg_user_name');
    localStorage.removeItem('mg_auth_expiry');
    show('login');
  }
})();
