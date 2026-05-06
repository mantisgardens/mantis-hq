/* =============================================================
   config.js
   Mantis Gardens — Shared Configuration

   ⚠️  THIS IS THE ONLY FILE YOU NEED TO UPDATE AFTER
       REDEPLOYING THE APPS SCRIPT.

   Both the crew app (crew/) and owner portal (owner/) read
   from this single file. Update SCRIPT_URL here and both
   apps pick it up automatically.
   ============================================================= */

const MANTIS_SHARED = {

  // ── Apps Script URL ────────────────────────────────────────
  // Update this after every Apps Script redeployment.
  // Found in: Apps Script → Deploy → Manage deployments → Copy /exec URL
  SCRIPT_URL: "https://script.google.com/macros/s/AKfycby1unhQdAqRtt_cfoAWIFnCwSmqfpMYEf5B-1QUZKX1onnXLR9FSZIw72erimrjjnxJBw/exec",
  
  // ── Google OAuth Client ID ─────────────────────────────────
  // Found in: console.cloud.google.com → APIs & Services → Credentials
  // This value is public by design — it is not a secret.
  GOOGLE_CLIENT_ID: "537209780651-u2qmjutkjnmbkuvu26613c4o2fbsiuvk.apps.googleusercontent.com",

};
