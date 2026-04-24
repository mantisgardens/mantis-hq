/* =============================================================
   crew/js/mantis_config.js
   Mantis Gardens — Crew App Configuration

   Reads the shared SCRIPT_URL and GOOGLE_CLIENT_ID from
   ../../config.js (the repo root config file).
   Only crew-specific settings are defined here.
   ============================================================= */

const MANTIS_CONFIG = {

  // ── Shared settings (from repo root config.js) ─────────────
  SCRIPT_URL:       (typeof MANTIS_SHARED !== 'undefined') ? MANTIS_SHARED.SCRIPT_URL       : 'PASTE_YOUR_EXEC_URL_HERE',
  GOOGLE_CLIENT_ID: (typeof MANTIS_SHARED !== 'undefined') ? MANTIS_SHARED.GOOGLE_CLIENT_ID : '',

  // ── Page URLs ──────────────────────────────────────────────
  CREW_URL:   'mantis_crew_panel.html',
  MANUAL_URL: 'mantis_service_manual.html',
  LOGIN_URL:  'index.html',

};
