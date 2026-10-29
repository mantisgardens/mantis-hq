/* =============================================================
   crew/js/meal_reminder.js
   Meal-break and clock-out reminder bar, shown at the top of every crew page.

   Clock-out: someone still clocked in after 9 hours of work gets an amber bar
   ("remember to clock out"), and a red one after 12 hours. Same Remove button
   and ping as the meal reminder. The meal reminder takes priority when both apply.

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
  var LONG_SHIFT_MIN = 540, VERY_LONG_MIN = 720;   // 9 and 12 hours of work
  var kind = 'meal';                                // which reminder is showing: meal | out
  var state = null, loadedAt = 0, bar = null, openDay = null;

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
  function stamp() { return kind === 'prev' ? (openDay && openDay.date || '') : (state && state.since || ''); }
  function dismissKey() { return 'mg_' + kind + '_dismiss_' + stamp(); }
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
  function pingKey() { return 'mg_' + kind + '_ping_' + stamp(); }
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
    document.getElementById('meal-reminder-text').onclick = function () { if (bar.dataset.kind === 'prev' && bar.dataset.date) window.location.href = 'mantis_timecard.html?fix=' + encodeURIComponent(bar.dataset.date); };
    document.getElementById('meal-reminder-x').onclick = function () { kind = bar.dataset.kind || 'meal'; setDismissed(bar.dataset.level || '1'); bar.style.display = 'none'; };
    return bar;
  }

  function render() {
    var level = 0, msg = '';
    kind = 'meal';
    var on = !!(state && state.clockedIn);
    var worked = on ? (state.todayMinutes || 0) + Math.floor((Date.now() - loadedAt) / 60000) : 0;
    var left = FIRST_MEAL_MIN - worked;
    if (on && !state.onMealBreak && !state.mealTaken && left <= AMBER_AT) {
      level = left <= RED_AT ? 2 : 1;
      var due = new Date(Date.now() + Math.max(0, left) * 60000).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
      msg = left <= 0 ? 'Your meal break is due now \u2014 start it as soon as you can.'
        : level === 2 ? 'Start your meal break now \u2014 it must begin by ' + due + '.'
        : 'Meal break due by ' + due + ' (about ' + left + ' min of work left).';
    } else if (on && !state.onMealBreak && worked >= LONG_SHIFT_MIN) {
      kind = 'out';
      level = worked >= VERY_LONG_MIN ? 2 : 1;
      var hrs = Math.floor(worked / 60);
      msg = level === 2 ? 'You have worked ' + hrs + ' hours and are still clocked in. Clock out now unless you are still working.'
        : 'Still clocked in after ' + hrs + ' hours of work. Remember to clock out when you are done.';
    }
    if (!level && openDay) {
      kind = 'prev';
      level = 1;
      var d = new Date(openDay.date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
      msg = 'You did not clock out on ' + d + ' (last punch ' + openDay.lastTime + '). Tap here to fix it.';
    }
    if (!level || getDismissed() >= level) { if (bar) bar.style.display = 'none'; return; }
    var b = ensureBar();
    b.dataset.level = String(level);
    b.dataset.kind = kind;
    b.dataset.date = kind === 'prev' && openDay ? openDay.date : '';
    document.getElementById('meal-reminder-text').style.cursor = kind === 'prev' ? 'pointer' : '';
    b.style.background = level === 2 ? '#b3261e' : '#b45309';
    document.getElementById('meal-reminder-text').textContent = (kind === 'out' ? '\u23F1 ' : '\u23F0 ') + msg;
    b.style.display = 'flex';
    playPing(level);
  }

  // Earlier day with no clock-out (asked once per page load, remembered for 30 minutes).
  var openDayAsked = false;
  function loadOpenDay() {
    var t = token();
    var base = (typeof MANTIS_CONFIG !== 'undefined') ? MANTIS_CONFIG.SCRIPT_URL : '';
    if (!t || !base) return;          // not signed in yet; load() tries again each minute
    openDayAsked = true;
    try {
      var c = JSON.parse(sessionStorage.getItem('mg_open_day') || 'null');
      if (c && Date.now() - c.at < 30 * 60000) { openDay = c.day; render(); return; }
    } catch (e) { /* ask the server */ }
    fetch(base + '/timecard/open-days?id_token=' + encodeURIComponent(t))
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        if (!d || d.error) return;
        openDay = (d.days && d.days[0]) || null;
        try { sessionStorage.setItem('mg_open_day', JSON.stringify({ at: Date.now(), day: openDay })); } catch (e) { /* ignore */ }
        render();
      })
      .catch(function () { /* silent */ });
  }

  // Called by the Time Card page after a day is fixed, so the reminder clears at once.
  window.mgRefreshOpenDay = function () { try { sessionStorage.removeItem('mg_open_day'); } catch (e) { /* ignore */ } openDay = null; render(); loadOpenDay(); };

  function load() {
    if (!openDayAsked) loadOpenDay();   // the sign-in on the home page happens after this script starts
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
    loadOpenDay();
    setInterval(load, 60000);
    setInterval(render, 20000);
    document.addEventListener('visibilitychange', function () { if (!document.hidden) load(); });
  }
  if (document.body) start(); else document.addEventListener('DOMContentLoaded', start);
})();
