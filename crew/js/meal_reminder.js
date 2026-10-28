/* =============================================================
   crew/js/meal_reminder.js
   Meal-break reminder bar, shown at the top of every crew page.

   California: the first meal break must START before the end of the
   5th hour of work. While someone is clocked in and has not started a
   meal break, this bar appears with 30 minutes of work left (amber) and
   turns red with 10 minutes left or once the deadline has passed.
   The X dismisses the current level; the red level shows again later
   if only the amber one was dismissed. Dismissals are remembered per
   clock-in.

   It asks the backend for the time card summary once a minute (and when
   the page comes back to the front) and counts down locally in between.
   Does nothing if the person is not signed in or not clocked in.
   A short two-tone ping (and a phone buzz where the phone allows it) plays
   when each level first appears. Browsers only allow sound after the person
   has touched the page once, so the ping is held until the first tap on the
   page. It never plays while the phone is locked or the app is closed.
   Needs mantis_config.js (MANTIS_CONFIG.SCRIPT_URL).
   ============================================================= */
(function () {
  var FIRST_MEAL_MIN = 300, AMBER_AT = 30, RED_AT = 10;
  var state = null, loadedAt = 0, bar = null;

  function token() {
    try {
      var t = sessionStorage.getItem('mg_id_token') || '';
      if (!t) {
        var ls = localStorage.getItem('mg_id_token') || '';
        var exp = parseInt(localStorage.getItem('mg_id_token_expiry') || '0', 10);
        if (ls && Date.now() < exp) t = ls;
      }
      return t;
    } catch (e) { return ''; }
  }
  function dismissKey() { return 'mg_meal_dismiss_' + (state && state.since || ''); }
  function getDismissed() { try { return parseInt(localStorage.getItem(dismissKey()) || '0', 10); } catch (e) { return 0; } }
  function setDismissed(n) { try { localStorage.setItem(dismissKey(), String(n)); } catch (e) { /* ignore */ } }

  // ── ping ──────────────────────────────────────────────────
  var audio = null, unlocked = false;
  function unlock() {
    if (unlocked) return;
    try {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      audio = audio || new AC();
      if (audio.state === 'suspended') audio.resume();
      unlocked = true;
      render(); // play a ping that was waiting for the first tap
    } catch (e) { /* no sound available */ }
  }
  ['pointerdown', 'touchstart', 'keydown'].forEach(function (ev) { document.addEventListener(ev, unlock, { passive: true }); });
  function pingKey() { return 'mg_meal_ping_' + (state && state.since || ''); }
  function pinged() { try { return parseInt(localStorage.getItem(pingKey()) || '0', 10); } catch (e) { return 0; } }
  function playPing(level) {
    if (!unlocked || !audio || pinged() >= level) return;
    try {
      var t = audio.currentTime, notes = level === 2 ? [880, 1175, 880] : [880, 1175];
      notes.forEach(function (f, i) {
        var o = audio.createOscillator(), g = audio.createGain();
        o.type = 'sine'; o.frequency.value = f;
        g.gain.setValueAtTime(0.0001, t + i * 0.22);
        g.gain.exponentialRampToValueAtTime(0.35, t + i * 0.22 + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.22 + 0.2);
        o.connect(g); g.connect(audio.destination);
        o.start(t + i * 0.22); o.stop(t + i * 0.22 + 0.22);
      });
      if (navigator.vibrate) navigator.vibrate(level === 2 ? [200, 100, 200] : 200);
      localStorage.setItem(pingKey(), String(level));
    } catch (e) { /* ignore */ }
  }

  function ensureBar() {
    if (bar) return bar;
    bar = document.createElement('div');
    bar.id = 'meal-reminder-bar';
    bar.setAttribute('role', 'alert');
    bar.style.cssText = 'display:none;position:sticky;top:0;z-index:9999;align-items:center;gap:10px;padding:9px 12px;' +
      'font:600 15px/1.35 system-ui,-apple-system,sans-serif;color:#fff;box-shadow:0 2px 6px rgba(0,0,0,.25)';
    bar.innerHTML = '<span id="meal-reminder-text" style="flex:1"></span>' +
      '<button type="button" id="meal-reminder-x" aria-label="Dismiss reminder" ' +
      'style="background:rgba(255,255,255,.22);color:#fff;border:0;border-radius:6px;padding:4px 11px;font:600 14px system-ui,sans-serif;cursor:pointer">Remove</button>';
    document.body.insertBefore(bar, document.body.firstChild);
    document.getElementById('meal-reminder-x').onclick = function () { setDismissed(bar.dataset.level || '1'); bar.style.display = 'none'; };
    return bar;
  }

  function render() {
    if (!state || !state.clockedIn || state.onMealBreak || state.mealTaken) { if (bar) bar.style.display = 'none'; return; }
    var worked = (state.todayMinutes || 0) + Math.floor((Date.now() - loadedAt) / 60000);
    var left = FIRST_MEAL_MIN - worked;
    if (left > AMBER_AT) { if (bar) bar.style.display = 'none'; return; }
    var level = left <= RED_AT ? 2 : 1;
    if (getDismissed() >= level) { if (bar) bar.style.display = 'none'; return; }
    var b = ensureBar();
    var due = new Date(Date.now() + Math.max(0, left) * 60000).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    var msg = left <= 0 ? 'Your meal break is due now — start it as soon as you can.'
      : level === 2 ? 'Start your meal break now — it must begin by ' + due + '.'
      : 'Meal break due by ' + due + ' (about ' + left + ' min of work left).';
    b.dataset.level = String(level);
    b.style.background = level === 2 ? '#b3261e' : '#b45309';
    document.getElementById('meal-reminder-text').textContent = '⏰ ' + msg;
    b.style.display = 'flex';
    playPing(level);
  }

  function load() {
    var t = token();
    var base = (typeof MANTIS_CONFIG !== 'undefined') ? MANTIS_CONFIG.SCRIPT_URL : '';
    if (!t || !base) return;
    fetch(base + '/timecard/summary?id_token=' + encodeURIComponent(t))
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) { if (d && !d.error) { state = d; loadedAt = Date.now(); render(); } })
      .catch(function () { /* silent: never get in the way of the page */ });
  }

  function start() {
    load();
    setInterval(load, 60000);
    setInterval(render, 20000);
    document.addEventListener('visibilitychange', function () { if (!document.hidden) load(); });
  }
  if (document.body) start(); else document.addEventListener('DOMContentLoaded', start);
})();
