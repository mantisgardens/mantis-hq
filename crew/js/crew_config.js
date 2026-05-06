/* =============================================================
   crew_config.js
   Mantis Gardens — Crew Panel Configuration & Application State

   Contains:
     - SCRIPT_URL and cache constants
     - All mutable application state (SCHEDULE, DAYS, currentDay, etc.)
     - Brief visibility state (briefOpen)
     - User team detection (getUserTeamSlug)
   ============================================================= */

// =============================================================
// SECTION 1 — CONFIGURATION
// Edit SCRIPT_URL after each Apps Script redeployment.
// =============================================================
// Read from mantis_config.js — edit that file to update the URL
const SCRIPT_URL = (typeof MANTIS_CONFIG !== 'undefined') ? MANTIS_CONFIG.SCRIPT_URL : "PASTE_YOUR_EXEC_URL_HERE";


// =============================================================
// SECTION 2 — APPLICATION STATE
// All mutable state lives here. Mutate only via setSt(),
// toggle(), or the loadAll() handlers.
// =============================================================
// ── State ─────────────────────────────────────────────────────
let SCHEDULE     = {};          // populated from Google Calendar via Apps Script

// =============================================================
// SECTION 3 — SCHEDULE DATA
// DAYS, DAY_LABELS, and SCHEDULE are populated at runtime by
// the Apps Script ?action=schedule call. They start empty and
// are filled in loadAll() when the page first opens.
// =============================================================
let DAYS         = [];          // sorted date keys e.g. ["2026-04-16", ...]
let activeTeam   = 't1';       // currently visible team tab
let DAY_LABELS   = [];          // display labels e.g. ["Thu Apr 16", ...]
let currentDay   = null;

// getUserTeamSlug() reads mg_user_category from sessionStorage at call time
// (not at parse time) so it's always evaluated after login has completed.
// Managers get null (all panels unlocked). Unknown category also returns null
// (fail open — better than accidentally locking out a valid user).
function getUserTeamSlug() {
  const cat = (sessionStorage.getItem('mg_user_category')
            || localStorage.getItem('mg_user_category') || '').toLowerCase();
  if (!cat || cat.includes('manager')) return null;
  if (cat.includes('team 1'))  return 't1';
  if (cat.includes('team 2'))  return 't2';
  if (cat.includes('team 3'))  return 't3';
  if (cat.includes('install')) return 'install';
  return null;
}

let expanded     = {}, statuses = {};
// Restore per-team brief visibility from sessionStorage (default open).
// Cleared automatically on logout via sessionStorage.clear().
const _briefStored = JSON.parse(sessionStorage.getItem('mg_brief_open') || 'null');
let briefOpen = _briefStored || { t1:true, t2:true, install:true };
let clientCache  = {}, sheetClients = [], morningBrief = null;
let crewTeams    = { t1: [], t2: [], t3: [] };  // team rosters from Crew Info sheet

