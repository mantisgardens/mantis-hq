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
// SECTION 3 — APPLICATION STATE
// All mutable state lives here. Mutate only via setSt(),
// toggle(), or the loadAll() handlers.
// =============================================================
// ── State ─────────────────────────────────────────────────────
let SCHEDULE     = {};          // populated from Google Calendar via Apps Script

// =============================================================
// SECTION 2 — SCHEDULE DATA
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
// ── normClientName ────────────────────────────────────────────
// Normalises a client name for comparison across two formats:
//   DB format:       "Last, First"   →  "first last"
//   Calendar format: "First Last"    →  "first last"
// Lowercases, trims, collapses whitespace, and inverts
// "Last, First" so both sides compare consistently.
// Used wherever a calendar-derived name is matched against sheetClients.
function normClientName(s) {
  s = (s || '').toLowerCase().trim();
  if (s.includes(',')) {
    const parts = s.split(',').map(p => p.trim());
    s = parts.slice(1).join(' ').trim() + ' ' + parts[0].trim();
  }
  return s.replace(/\s+/g, ' ');
}

// ── levenshtein ───────────────────────────────────────────────
// Returns the edit distance between two strings.
// Used by findSheetClient for typo-tolerant matching.
function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => [i]);
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i-1] === b[j-1]
        ? dp[i-1][j-1]
        : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
    }
  }
  return dp[m][n];
}

// ── findSheetClient ───────────────────────────────────────────
// Looks up a client in sheetClients by calendar name.
// Three-tier matching:
//   1. Exact match after normalisation (handles Last,First ↔ First Last)
//   2. Substring containment (handles partial names)
//   3. Fuzzy Levenshtein match on the surname only, distance ≤ 1
//      (handles single typos like "Belloti" → "Bellotti")
//      Matches against the text before the comma in the DB name
//      (e.g. "Bellotti, Tim" → "bellotti") to avoid false positives
//      from first-name collisions (jan/jon/joan etc).
// Returns the matching sheetClients row, or null.
function findSheetClient(calendarName) {
  if (!calendarName || !sheetClients.length) return null;
  const q = normClientName(calendarName);
  if (!q) return null;

  // Tier 1 & 2: exact or substring
  const close = sheetClients.find(c => {
    const n = normClientName(c['Name(s)'] || '');
    return n === q || n.includes(q) || q.includes(n);
  });
  if (close) return close;

  // Tier 3: fuzzy match on surname only.
  // Calendar name "Sheila Belloti" → last word "belloti"
  // DB name "Bellotti, Tim"  → text before comma "bellotti"
  const qWords    = q.split(' ');
  const qSurname  = qWords[qWords.length - 1];
  if (qSurname.length < 3) return null;  // too short to fuzzy-match safely

  let bestMatch = null, bestDist = Infinity;
  sheetClients.forEach(c => {
    const raw = (c['Name(s)'] || '').toLowerCase().trim();
    const dbSurname = raw.includes(',')
      ? raw.split(',')[0].trim()          // "bellotti, tim" → "bellotti"
      : raw.split(' ').pop();             // "tim bellotti"  → "bellotti"
    if (!dbSurname || Math.abs(dbSurname.length - qSurname.length) > 1) return;
    const dist = levenshtein(qSurname, dbSurname);
    if (dist < bestDist) { bestDist = dist; bestMatch = c; }
  });

  return bestDist <= 1 ? bestMatch : null;
}

let crewTeams    = { t1: [], t2: [], t3: [] };  // team rosters from Crew Info sheet

