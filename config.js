/* =============================================================
   config.js New Version
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
  // Note:  This also has to be entered as the Disconnect URL in the Quickbooks
  //   developer page (https://developer.intuit.com/)  Enter this in both
  //    the dDvelopment and Production versions.
  
  SCRIPT_URL: "https://script.google.com/macros/s/AKfycbxoEp1aDiJ3V-WTi6wUgwjFSDAAk3ty8H4NMTwQRPq6yxeQNE_Pd7iA2e-EG0bjkWmeCg/exec",
  
  // ── Google OAuth Client ID ─────────────────────────────────
  // Found in: console.cloud.google.com → APIs & Services → Credentials
  // This value is public by design — it is not a secret.
  GOOGLE_CLIENT_ID: "537209780651-u2qmjutkjnmbkuvu26613c4o2fbsiuvk.apps.googleusercontent.com",

};
