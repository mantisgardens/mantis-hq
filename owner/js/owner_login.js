/* =============================================================
   owner_login.js
   Mantis Gardens — Owner Portal Login
   ============================================================= */

const CLIENT_ID  = (typeof OWNER_CONFIG !== 'undefined') ? OWNER_CONFIG.GOOGLE_CLIENT_ID : '';
const SCRIPT_URL = (typeof OWNER_CONFIG !== 'undefined') ? OWNER_CONFIG.SCRIPT_URL       : '';

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
  google.accounts.id.prompt();
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
    fetch(`${SCRIPT_URL}?action=ownerPing&id_token=${idToken}`)
      .then(r => r.json())
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
