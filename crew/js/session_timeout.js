/* =============================================================
   session_timeout.js
   Mantis Gardens — Session Timeout

   Shared module used by both the crew app and owner portal.
   Tracks user activity and signs out after a period of
   inactivity, protecting client data on unattended devices.

   CONFIGURATION
   -------------
   Call initSessionTimeout(options) once per page:

     initSessionTimeout({
       timeoutMs:  4 * 60 * 60 * 1000,  // 4 hours (crew default)
       warningMs:  5 * 60 * 1000,        // warn 5 min before timeout
       sessionKey: 'mg_auth',             // sessionStorage auth key
       loginUrl:   'index.html', // redirect on timeout
       onSignOut:  doSignOut,             // optional cleanup function
     });

   Activity is tracked via touch, click, keydown, and scroll
   events. The timer resets on any interaction.

   STORAGE
   -------
   Uses sessionStorage so the timeout is per-tab and resets
   when the browser is closed. The last activity timestamp
   is stored under 'mg_last_activity'.
   ============================================================= */

(function() {

  let _timer        = null;
  let _warningTimer = null;
  let _warningEl    = null;
  let _options      = null;

  // ── initSessionTimeout ──────────────────────────────────────
  // Call once per page after confirming the user is logged in.

  window.initSessionTimeout = function(opts) {
    _options = Object.assign({
      timeoutMs:  4 * 60 * 60 * 1000,   // 4 hours default
      warningMs:  5 * 60 * 1000,         // warn 5 min before
      sessionKey: 'mg_auth',
      loginUrl:   'index.html',
      onSignOut:  null,
    }, opts);

    // Record activity now
    touch();

    // Listen for user interactions
    ['click', 'touchstart', 'keydown', 'scroll'].forEach(evt => {
      document.addEventListener(evt, touch, { passive: true });
    });

    // Check every minute whether the session has expired
    // (handles the case where the device was locked/slept)
    setInterval(checkTimeout, 60 * 1000);

    // Start the initial timers
    resetTimers();
  };

  // ── touch ────────────────────────────────────────────────────
  // Called on any user interaction — updates last activity time
  // and resets the countdown timers.

  function touch() {
    sessionStorage.setItem('mg_last_activity', Date.now().toString());
    resetTimers();
    hideWarning();
  }

  // ── resetTimers ──────────────────────────────────────────────

  function resetTimers() {
    if (!_options) return;

    clearTimeout(_timer);
    clearTimeout(_warningTimer);

    // Warning fires (timeoutMs - warningMs) after last activity
    const warnDelay = _options.timeoutMs - _options.warningMs;
    if (warnDelay > 0) {
      _warningTimer = setTimeout(showWarning, warnDelay);
    }

    // Timeout fires timeoutMs after last activity
    _timer = setTimeout(signOut, _options.timeoutMs);
  }

  // ── checkTimeout ─────────────────────────────────────────────
  // Periodic check — catches cases where JS timers were paused
  // (e.g. device sleep, tab backgrounded for a long time).

  function checkTimeout() {
    if (!_options) return;
    const last    = parseInt(sessionStorage.getItem('mg_last_activity') || '0');
    const elapsed = Date.now() - last;
    if (elapsed >= _options.timeoutMs) {
      signOut();
    } else if (elapsed >= _options.timeoutMs - _options.warningMs) {
      showWarning();
    }
  }

  // ── showWarning ──────────────────────────────────────────────
  // Shows a dismissible banner warning the user they'll be
  // signed out soon.

  function showWarning() {
    if (_warningEl) return;  // already showing

    _warningEl = document.createElement('div');
    _warningEl.id = 'session-warning';
    _warningEl.style.cssText = [
      'position:fixed', 'bottom:70px', 'left:50%',
      'transform:translateX(-50%)',
      'background:#8B6914', 'color:#fff',
      'padding:12px 20px', 'border-radius:8px',
      'font-family:Arial,sans-serif', 'font-size:13px',
      'z-index:9999', 'display:flex', 'align-items:center',
      'gap:12px', 'box-shadow:0 4px 16px rgba(0,0,0,0.3)',
      'max-width:320px', 'text-align:center',
    ].join(';');

    const mins = Math.round(_options.warningMs / 60000);
    _warningEl.innerHTML = `
      <span>&#9201; You'll be signed out in ${mins} minute${mins !== 1 ? 's' : ''} due to inactivity.</span>
      <button onclick="document.getElementById('session-warning').remove();
                       window._sessionWarningEl=null;"
              style="background:rgba(255,255,255,0.2);border:1px solid rgba(255,255,255,0.4);
                     color:#fff;padding:4px 10px;border-radius:4px;cursor:pointer;
                     font-family:Arial,sans-serif;font-size:12px;white-space:nowrap">
        Stay signed in
      </button>`;

    // Tapping "Stay signed in" resets the timer via touch()
    _warningEl.querySelector('button').addEventListener('click', touch);
    document.body.appendChild(_warningEl);
  }

  function hideWarning() {
    if (_warningEl) {
      _warningEl.remove();
      _warningEl = null;
    }
  }

  // ── signOut ──────────────────────────────────────────────────
  // Clears the session and redirects to login.

  function signOut() {
    clearTimeout(_timer);
    clearTimeout(_warningTimer);

    // Remove activity listeners
    ['click', 'touchstart', 'keydown', 'scroll'].forEach(evt => {
      document.removeEventListener(evt, touch);
    });

    // Call the app's own sign-out function if provided
    // (revokes Google token, clears caches etc.)
    if (_options && typeof _options.onSignOut === 'function') {
      try { _options.onSignOut(); } catch(e) {}
    }

    // Clear session storage
    const loginUrl = (_options && _options.loginUrl) || 'index.html';
    sessionStorage.clear();

    // Pass a flag so the login page can show a "timed out" message
    sessionStorage.setItem('mg_timeout', '1');

    window.location.href = loginUrl;
  }

})();
