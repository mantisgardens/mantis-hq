/* =============================================================
   owner/js/owner_config.js
   Mantis Gardens — Owner Portal Configuration

   Reads the shared SCRIPT_URL and GOOGLE_CLIENT_ID from
   ../config.js (the repo root config file).
   Only owner-specific settings are defined here.
   ============================================================= */

const OWNER_CONFIG = {

  // ── Shared settings (from repo root config.js) ─────────────
  SCRIPT_URL:       (typeof MANTIS_SHARED !== 'undefined') ? MANTIS_SHARED.SCRIPT_URL       : 'PASTE_YOUR_EXEC_URL_HERE',
  GOOGLE_CLIENT_ID: (typeof MANTIS_SHARED !== 'undefined') ? MANTIS_SHARED.GOOGLE_CLIENT_ID : '',

  // ── Page URLs ──────────────────────────────────────────────
  DASHBOARD_URL: 'owner_dashboard.html',
  LOGIN_URL:     'index.html',

};
