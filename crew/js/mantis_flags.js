/* =============================================================
   crew/js/mantis_flags.js
   Tester switch for features not yet released to the crew.

   Open the app with  ?test=1  once (e.g. .../crew/index.html?test=1)
   and this browser remembers it. Open with  ?test=0  to turn it off.
   Everyone else never sees test-only features.

   This is a convenience for hiding unfinished UI, NOT access control:
   the backend still verifies every request.
   ============================================================= */
(function () {
  try {
    var q = new URLSearchParams(window.location.search).get('test');
    if (q === '1') localStorage.setItem('mantis_test', '1');
    if (q === '0') localStorage.removeItem('mantis_test');
  } catch (e) { /* storage blocked: flag stays off */ }
  var on = false;
  try { on = localStorage.getItem('mantis_test') === '1'; } catch (e) { /* off */ }
  window.MANTIS_TEST = on;
})();
