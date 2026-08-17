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
// CONFIGURATION
// Edit SCRIPT_URL after each Apps Script redeployment.
// =============================================================
// Read from mantis_config.js — edit that file to update the URL
const SCRIPT_URL = (typeof MANTIS_CONFIG !== 'undefined') ? MANTIS_CONFIG.SCRIPT_URL : "PASTE_YOUR_EXEC_URL_HERE";


// =============================================================
// APPLICATION STATE
// All mutable state lives here. Mutate only via setSt(),
// toggle(), or the loadAll() handlers.
// =============================================================

// ****************************
// ****  SCHEDULE DATA   ******
// ****************************
// DAYS, DAY_LABELS, and SCHEDULE are populated at runtime by
// the Apps Script ?action=schedule call. They start empty and
// are filled in loadAll() when the page first opens.
let SCHEDULE     = {};          // populated from Google Calendar via Apps Script
let DAYS         = [];          // sorted date keys e.g. ["2026-04-16", ...]
let DAY_LABELS   = [];          // display labels e.g. ["Thu Apr 16", ...]
let currentDay   = null;

// ****************************
// *******  TEAM DATA   ******* 
// ****************************
let activeTeam   = 't1';       // currently visible team tab
let crewTeams    = { t1: [], t2: [], t3: [], tInstall: [], managers: [] };  // team rosters from Crew Info sheet

// ── Team lock (single-team view from the landing page picker) ──
// null            → full experience: team-tab switcher, all teams
// 't1'/'t2'/'t3'/'install' → locked to just that team: no tab
//                            switcher, just its brief + job cards
// Set once at startup in crew_app.js from the ?team= URL param.
let lockedTeam = null;

// Maps a team-tab id to its key in a SCHEDULE day object
// ({ t1, t2, t3, tInstall }) — 'install' is the only one that
// doesn't match its tab id directly.
const TEAM_DAY_KEY = { t1:'t1', t2:'t2', t3:'t3', install:'tInstall' };

// ****************************
// *****  MANAGER DATA   ****** 
// ****************************
// ── isManagerUser ─────────────────────────────────────────────
// Returns true if the logged-in crew member's category indicates
// they are a manager. Checked at call time (not parse time) so it
// always reads the value set after login completes.
function isManagerUser() {
  const cat = (sessionStorage.getItem('mg_user_category')
            || localStorage.getItem('mg_user_category') || '').toLowerCase();
  return cat.includes('manager');
}

// Manager schedule — fetched only for managers, stays null for others.
let MANAGER_SCHEDULE = null;   // { days: { "YYYY-MM-DD": { ashley:[], brooke:[], mgr:[] } } }
let mgrBriefOpen     = true;   // morning brief accordion state on manager panel


// ****************************
// *****  CACHE/STORAGE  ****** 
// ****************************
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
let briefOpen = _briefStored || { t1:true, t2:true, t3:true, install:true, managers:true };
let clientCache  = {}, sheetClients = [], morningBrief = null;


