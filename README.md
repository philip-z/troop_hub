# Troop Hub

Static web app (no build step): Google login, trips from a Google Sheet, permission slips,
expense receipts, equipment form link, leader tools (create trips, record payments and
reimbursements), and meal-planning tools (recipe scaling + combined shopping list).

## Setup
1. Create a Google Cloud OAuth client ID (Web) and enable the Google Sheets API; add your site origin as an authorized JavaScript origin.
2. Create a spreadsheet with tabs `Trips` (header row: `ID, Name, Date, Location, Cost, Description`), `PermissionSlips`, `Receipts`, `Payments`, `Reimbursements`.
   Share it with everyone who will sign in (scouts/parents need edit access to submit; consider a Google Apps Script proxy for stricter control).
3. Edit `config.js` (client ID, spreadsheet ID, equipment form URL, leader emails).
4. Serve the folder with any static host, e.g. `python3 -m http.server`.

Note: leader checks in the UI are convenience only; enforce real permissions via sheet sharing.

## Tests
`npm test`
