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

  google.accounts.id.prompt();
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
        // Approved — store identity and proceed
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
  const email = sessionStorage.getItem('mg_user_email');
  if (email && typeof google !== 'undefined') {
    google.accounts.id.revoke(email, () => {});
  }
  sessionStorage.clear();
  show('login');
  // Re-render sign-in button
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
window.addEventListener('load', () => {
  if (typeof google !== 'undefined' && google.accounts) {
    initGoogleSignIn();
  } else {
    const gisScript = document.querySelector('script[src*="accounts.google.com/gsi"]');
    if (gisScript) gisScript.addEventListener('load', initGoogleSignIn);
  }
});

// Skip login if session still active
// Show timeout message if redirected here due to inactivity
if (sessionStorage.getItem('mg_timeout') === '1') {
  sessionStorage.removeItem('mg_timeout');
  const err = document.getElementById('login-error');
  if (err) {
    err.textContent = 'You were signed out due to inactivity.';
    err.style.display = 'block';
  }
}

// Skip login if session still active
if (sessionStorage.getItem('mg_auth') === '1') {
  setupHome();
  show('home');
} else {
  show('login');
}
