# Mantis Gardens Field Manager

Internal web app for Mantis Gardens landscaping — Sacramento, CA.

## Apps

| App | URL | Purpose |
|---|---|---|
| Crew App | `/crew/` | Job schedule, work records, service manual |
| Owner Portal | `/owner/` | Client database, work records review, crew hours |

Both apps are hosted on GitHub Pages at:
- `https://mantisgardens.github.io/mantis-field-manager/crew/`
- `https://mantisgardens.github.io/mantis-field-manager/owner/`

## After Redeploying the Apps Script

**Only one file needs updating:** `config.js` at the repo root.

```javascript
const MANTIS_SHARED = {
  SCRIPT_URL: "PASTE_YOUR_NEW_EXEC_URL_HERE",
  ...
};
```

Both apps read from this file automatically.

## Structure

```
config.js              ← shared config (update after Apps Script redeploy)
crew/                  ← crew app
  index.html           ← landing / login page
  mantis_crew_panel.html
  mantis_service_manual.html
  css/
  js/
  img/
  resources/           ← equipment PDF manuals
owner/                 ← owner portal
  index.html           ← login page
  owner_dashboard.html
  css/
  js/
  img/
```

## Apps Script

The backend is a Google Apps Script project deployed as a web app.
Source files are maintained separately in the `MantisAppsScript` archive.

## Internal use only

Not for public distribution. Access requires a Google account
approved in the Apps Script Script Properties.
