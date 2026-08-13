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
  // Note:  This also has to be entered as the Disconnect URL in the Quickbooks
  //   developer page (https://developer.intuit.com/)  Enter this in both
  //    the dDvelopment and Production versions.
  
  SCRIPT_URL: "https://script.google.com/macros/s/AKfycbxoEp1aDiJ3V-WTi6wUgwjFSDAAk3ty8H4NMTwQRPq6yxeQNE_Pd7iA2e-EG0bjkWmeCg/exec",

  // ── Cloud Run backend URL ────────────────────────
  // Used only by the crew-cloud/ and owner-cloud/ pathways -- the
  // original crew/ and owner/ folders never read this, and keep
  // working exactly as before regardless of what's here. That's the
  // whole point of the parallel-folder approach: a mistake in the new
  // pathway can't touch the working one, since they share no code
  // that reads this value.
  CLOUD_RUN_URL: "https://mantis-backend-237928427501.us-west1.run.app",
  
  // ── Google OAuth Client ID ─────────────────────────────────
  // Found in: console.cloud.google.com → APIs & Services → Credentials
  // This value is public by design — it is not a secret.
  GOOGLE_CLIENT_ID: "537209780651-u2qmjutkjnmbkuvu26613c4o2fbsiuvk.apps.googleusercontent.com",

};
