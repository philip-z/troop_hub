<<<<<<< Updated upstream
# troop_hub
A hub for digital management of a scout troop
=======
# Troop Hub

Static web app (no build step): Google login, trips from a Google Sheet, permission slips,
expense receipts, equipment form link, leader tools (create trips, record payments and
reimbursements), and meal-planning tools (recipe scaling + combined shopping list).

## Layout
The website lives in `docs/` (the only folder GitHub Pages publishes: Settings > Pages > Deploy from a branch > `main` / `/docs`). Paths below are relative to `docs/` unless noted.
- `index.html` / `hub.js` / `hub.css`: hub with the troop logo and responsive tabs (Trips, Equipment, Meal planning; keyboard accessible, deep-linkable via `#trips`, `#equipment`, `#meals`), receipts, permission-gated leader payment + reimbursement records
- `slip.html` / `slip.js`: permission slip, opened as `slip.html?trip=<tripId>`
- `add-trip.html` / `add-trip.js`: leaders with the `addTrips` permission add a trip (optionally copying details from a previous trip via the `listTripTemplates` action) and choose which forms it accepts
- `forms.css`, `images/`: shared by the slip and leaders pages
- `config.js`: client ID + web app URL shared by every page
- `auth.js`: shared sign-in (Google, or an emailed 6-digit code for people who'd rather not use Google); the token is kept in `sessionStorage`, so one sign-in carries across all pages in the same browser tab (Google tokens about 1 hour, email sessions 2 hours). The "Remember me on this device" checkbox (unticked by default) keeps a 30-day token in `localStorage` instead; for Google sign-in the script swaps the Google token for its own 30-day token (`authExchange`). Sign out clears both. Leader actions follow the same rules as everything else.
- `apps-script/` (repo root): backend. `Code.gs` (routing, Google token check, logging), `Sheets.gs` (opens the three spreadsheets by ID), `Auth.gs` (email-code sign-in + session tokens), `Trips.gs` (trip lookup + flags), `Slip.gs` (slip + profiles), `Leaders.gs` (add trip, leader permissions), `Hub.gs` (hub actions), `Library.gs` (equipment and recipe lists)
- `dev/` (repo root): local-only mock sign-in and mock backend (`npm run dev`); not deployed

## Architecture
The static pages talk only to the Google Apps Script web app in `apps-script/` (no direct Sheets API access).
Users sign in with Google, or with an emailed one-time code (`Auth.gs`: 6-digit code via `MailApp`, 10-minute expiry, 5 tries, 3 requests per address per 10 minutes, then a signed 2-hour session token). Pages send the token with each request and the script verifies it,
reads/writes the spreadsheets, and enforces leader-only actions using the `Leaders` sheet tab (column A emails). Nothing is served without a sign-in: trip details (including coordinator names) and slip submissions both require a valid token, and the web app's GET endpoint returns nothing.
Email sign-in needs the Mail permission, and receipt photos need Drive access: after the first `npm run push`, run any function from the editor and approve the new scopes, then redeploy a new version. Receipt photos are shrunk in the browser, saved as JPEGs in a "Troop 58 Receipts" Drive folder (created on first use; set Script Property `RECEIPTS_FOLDER_ID` to use a different folder) and linked from the Receipts sheet. They are private to the script owner, so share that folder with whoever reconciles receipts. Gmail accounts can send about 100 emails/day (Workspace about 1,500); the script also caps itself at 60 codes/hour.

## Setup
1. Create a Google Cloud OAuth client ID (Web); add your site origin as an authorized JavaScript origin.
2. Three spreadsheets (the script is standalone and opens each by ID; see `apps-script/Sheets.gs`). Create them, then put each ID (the long string in the sheet's URL) in Script Properties in step 3: `TRIPS_SHEET_ID`, `EQUIPMENT_SHEET_ID`, `RECIPES_SHEET_ID`. The account that deploys the web app needs edit access to all three.
   - **Trips spreadsheet** (`TRIPS_SHEET_ID`): tabs `Trips`, `Leaders`; `Responses`, `Profiles`, `Youth Profiles`, `Receipts`, `Payments`, `Reimbursements` are created or extended automatically. Add trips from `add-trip.html`; columns are listed in `apps-script/Leaders.gs`. Each trip has a `tripId` (`YYYYMMNN`: year, month, 2-digit sequence within the month, e.g. `20261101`; generated from the "Trip month" chosen on the add-trip page) plus `acceptingResponses` (permission slip) and `acceptingReceipts` flags (`TRUE`/`FALSE`); edit them in the sheet to open or close a trip. The hub only shows a trip's buttons for the forms it accepts, and the server enforces the same flags.
   - **Equipment spreadsheet** (`EQUIPMENT_SHEET_ID`): a tab named `Equipment` with headers `item`, `category`, `quantity`, `status`, `notes`. Shown (searchable, read-only) on the hub's Equipment tab to any signed-in user. Edit it in the sheet.
   - **Recipes spreadsheet** (`RECIPES_SHEET_ID`): a tab named `Recipes` with headers `name`, `serves`, `ingredients` (one per line inside the cell, e.g. `1 1/2 cups flour`), `notes`. Offered as "Start from a troop recipe" on the Meal planning tab. Edit it in the sheet.
   - Column order doesn't matter and extra columns are ignored. If the equipment or recipes ID isn't set, those tabs just say so; nothing else is affected. Run `runDiagnostics` from the editor to check all three.

   The `Leaders` sheet: row 1 headers `email`, `addTrips`, `recordPayments`, `recordReimbursements`, then one row per leader with checkboxes (or `TRUE`/`yes`/`1`) in the permission columns. A blank cell or missing column means no. Each permission gates both the button on the hub and the server action (`not_allowed` otherwise). A legacy sheet with only emails in column A (no permission columns) gives every listed leader all three permissions until you add the columns.
3. Push the backend from the command line (manual, not CI):
   - `npm install`, then `npx clasp login` (enable the Apps Script API at https://script.google.com/home/usersettings)
   - New project: `npx clasp create --type standalone --title "Troop Hub" --rootDir apps-script` (this writes `.clasp.json`; or create a standalone project at script.google.com and copy its script ID from Project Settings into `.clasp.json`)
   - `npm run push`
   - In Project Settings > Script Properties set `TRIPS_SHEET_ID`, `EQUIPMENT_SHEET_ID`, `RECIPES_SHEET_ID` (step 2), and `OAUTH_CLIENT_ID` to your client ID (or edit `DEFAULT_OAUTH_CLIENT_ID` in `Code.gs`)
   - First time: in the editor, Deploy > New deployment > Web app, and copy the `/exec` URL. Later: Deploy > Manage deployments > edit the existing web app deployment > new version (keeps the same URL).
4. Edit `docs/config.js` (client ID, web app URL, equipment form URL).
5. Preview locally without deploying anything: `npm run dev` (http://localhost:5173; open it in VS Code's Simple Browser if you like). It serves the pages with a fake Google sign-in (pick any email; `leader@test.com` has all leader permissions, `treasurer@test.com` only payments and reimbursements; override with `LEADERS="a@x.com,b@x.com:recordPayments+recordReimbursements" npm run dev`, no colon meaning all permissions), a fake email sign-in (any address; the code is always `123456` and is printed in the server console) and an in-memory mock of the Apps Script backend with two seeded trips (one open, one closed), a few equipment items and two recipes. `/dev/state` dumps the mock sheet data; it resets on restart. This only exercises the front end and the routes' contract, not the real `.gs` code or Google token verification, so still test once against a real deployment.
6. Deploy the static files: push to GitHub and enable Pages from `main` / `/docs` (or upload `docs/` to any static host). Add the Pages origin (e.g. `https://<user>.github.io`) to the OAuth client's authorized JavaScript origins.

## Tests
`npm test`
>>>>>>> Stashed changes
