# Troop Hub

Static web app (no build step): Google login, trips from a Google Sheet, permission slips,
expense receipts, equipment form link, leader tools (create trips, record payments and
reimbursements), and meal-planning tools (recipe scaling + combined shopping list).

## Layout
The website lives in `docs/` (the only folder GitHub Pages publishes: Settings > Pages > Deploy from a branch > `main` / `/docs`). Paths below are relative to `docs/` unless noted.
- `index.html` / `hub.js` / `hub.css`: hub with the troop logo and responsive tabs (Trips, Equipment, Meal planning; keyboard accessible, deep-linkable via `#trips`, `#equipment`, `#meals`), receipts, permission-gated leader payment + reimbursement records
- `slip.html` / `slip.js`: permission slip, opened as `slip.html?trip=<tripId>`
- `add-trip.html` / `add-trip.js`: leaders with the `manageTrips` permission add a trip (optionally copying details from a previous trip via the `listTripTemplates` action) and choose which forms it accepts
- `forms.css`, `images/`: shared by the slip and leaders pages
- `config.js`: client ID + web app URL shared by every page
- `auth.js`: shared sign-in (Google, or an emailed 6-digit code for people who'd rather not use Google); the token is kept in `sessionStorage`, so one sign-in carries across all pages in the same browser tab (Google tokens about 1 hour, email sessions 2 hours). The "Remember me on this device" checkbox (unticked by default) keeps a 30-day token in `localStorage` instead; for Google sign-in the script swaps the Google token for its own 30-day token (`authExchange`). Sign out clears both. Leader actions follow the same rules as everything else.
- `offline.js` / `sw.js`: offline support (see "Working offline" below): `offline.js` keeps the saved session and the outbox of unsent entries, `sw.js` is the service worker that keeps the pages available with no signal
- `apps-script/` (repo root): backend. `Code.gs` (routing, Google token check, logging), `Sheets.gs` (opens the three spreadsheets by ID), `Auth.gs` (email-code sign-in + session tokens), `Trips.gs` (trip lookup + flags), `Slip.gs` (slip + profiles), `Leaders.gs` (add trip, leader permissions), `Hub.gs` (hub actions), `Library.gs` (equipment and recipe lists)
- `dev/` (repo root): local-only mock sign-in and mock backend (`npm run dev`); not deployed

## Architecture
The static pages talk only to the Google Apps Script web app in `apps-script/` (no direct Sheets API access).
Hub records (receipts, payments, reimbursements) take their columns from the `name` attributes of the inputs in `index.html`; to add a field, add an input whose `name` is the header you want. The server fixes only each kind's tab, permission and server-filled columns (`HUB_RECORDS` in `apps-script/Hub.gs`, `SERVER_COLUMNS` in `apps-script/Sheets.gs`), and the browser can't send those names. New fields appear as new sheet columns automatically (logged as `columns added` in the Log tab, at most 60 columns per tab); field names must start with a letter or digit so they can't become formulas. Saved profiles work the same way: on `slip.html`, an input marked `data-profile` is remembered, and unmarked inputs (a one-off question like "Do you have a helmet?") are not. Each person-type section is a `fieldset[data-profile-kind]` (`youth`, `adult`) and its name input has `data-profile-key`; the input names become the columns of the `Youth Profiles` / `Adult Profiles` tabs. The script only knows the name column, `Authorized Emails` and the slip checks in `SLIP_KINDS` / `PROFILE_AUTH_COLUMN` (`apps-script/Slip.gs`). A profile row is readable and updatable only by the emails in its `Authorized Emails` cell (the signed-in writer is added automatically; a leader can type `*` in the sheet to share a row with everyone). Saving under a name another family's row already uses creates a separate row rather than touching theirs. A column whose header starts with `_` is never sent to the browser. The Trips sheet works the same way through `add-trip.html`, and the trip list, copy-from-a-previous-trip dropdown and slip all carry whole Trips rows keyed by column name (`tripTitle`, `tripDates`, ...).
Users sign in with Google, or with an emailed one-time code (`Auth.gs`: 6-digit code via `MailApp`, 10-minute expiry, 5 tries, 3 requests per address per 10 minutes, then a signed 2-hour session token). Pages send the token with each request and the script verifies it,
reads/writes the spreadsheets, and enforces leader-only actions using the `Leaders` sheet tab (column A emails). Nothing is served without a sign-in: trip details (including coordinator names) and slip submissions both require a valid token, and the web app's GET endpoint returns nothing.
Email sign-in needs the Mail permission, and receipt photos need Drive access: after the first `npm run push`, run any function from the editor and approve the new scopes, then redeploy a new version. Receipt photos are shrunk in the browser, saved as JPEGs in a "Troop 58 Receipts" Drive folder (created on first use; set Script Property `RECEIPTS_FOLDER_ID` to use a different folder) and linked from the Receipts sheet. They are private to the script owner, so share that folder with whoever reconciles receipts. Gmail accounts can send about 100 emails/day (Workspace about 1,500); the script also caps itself at 60 codes/hour.

## Adding or changing a field

The design keeps column names out of the backend code: they come from input `name` attributes in the HTML forms. Here's how to add a field in each part of the app. The server only fills a few columns itself; everything else creates new sheet columns automatically when first submitted.

### Hub records (receipts, payments, reimbursements)
1. Open `docs/index.html` and find the dialog form for the kind you want (`receipt-dialog`, `payment-dialog` or `reimb-dialog`).
2. Add an `<input name="Header you want">` inside it. The name becomes the sheet column header exactly as typed. `hub.js` sends all the form's values through unchanged (the receipt's file input `photo` is handled separately), so there is no `.gs` or `.js` change.
3. The first submission creates the column (appended at the end of an existing tab) and logs `columns added` in the `Log(Enabled)` tab.
4. Constraints: name must start with a letter or digit, be at most 80 characters, use only letters, digits, spaces, and `_ . ( ) / & # ' ? : , -`. At most 40 fields per submission and 60 columns per tab.
5. Forbidden names (filled by the server): `Timestamp`, `Trip ID`, `Trip`, the email "recorded by" / "submitted by" column, and `Receipt URL` for receipts. Any form field with one of these names is rejected.
6. A brand-new kind of record (not just a field) needs an entry in `HUB_RECORDS` in `apps-script/Hub.gs` (its tab and the Leaders permission it needs), plus a dialog in `index.html` and an open function in `hub.js`.

### Trips
1. Open `docs/add-trip.html` and add an `<input name="myNewColumn">` in the form.
2. To show the new field on the permission slip, add a `<span id="myNewColumn"></span>` in `docs/slip.html` (slip.js fills spans whose id matches a column name).
3. "Copy details from a previous trip" fills every named input that the earlier trip has a value for; add the attribute `data-no-copy` to an input to opt it out (the dates and month already have it).
4. Which fields are required is decided only by the `required` attribute on the input; the server doesn't check.
5. The script itself fills `tripId` and `customDepartureHtml` (built from `departureDetails` and the `departureOptions` box), so the browser can't send those. It also turns the two checkboxes `acceptingResponses` / `acceptingReceipts` into the `TRUE`/`FALSE` flags. `tripMonth`, `departureOptions` and those checkboxes are read by the script but are not columns themselves.
6. Never add a private column to the Trips sheet: every Trips column is shown to any signed-in user.

### Profiles (saved youth and adult info)
1. Open `docs/slip.html` and find the fieldset for your person type (`data-profile-kind="youth"` or `data-profile-kind="adult"`).
2. To remember a new answer, add `data-profile` to its input. No `.gs` change is needed; the input's `name` becomes a column in the `Youth Profiles` or `Adult Profiles` tab the first time it is saved. The person's name input is the one with `data-profile-key`.
3. For a one-off question (e.g., "Do you have a helmet?"), add the input without `data-profile`. It is asked on the slip and becomes a column in the `Responses` sheet, but it is not saved to the profile.
4. A profile row can only be read or updated by the emails in its `Authorized Emails` cell (a leader can type `*` there in the sheet to share a row with everyone).
5. A column header starting with `_` is never sent to the browser (useful for leader-only notes inside the sheet).
6. If the legal wording on `slip.html` changes, bump `FORM_VERSION` in `apps-script/Slip.gs` and tag that commit in git, so every response row can be matched to the exact text it was signed under.

### Equipment and recipes lists
1. Edit the Equipment or Recipes tab directly in the sheet (no form to change). Every column is shown to any signed-in user, case-sensitive, exactly as typed.
2. To keep a column private, start its header with an underscore (e.g., `_supplier`).
3. In `docs/index.html`, use `data-title`, `data-count`, `data-details` on the `#equipment` list to choose what to display; use `data-label` on the recipe dropdown and `data-recipe="<column>"` on recipe form inputs.

## Keeping calls to the script few
Every call to the Apps Script web app can wait for the script to wake up, so a page should make one call that waits, and nothing it needs should be a second one. Keep to this when adding features:
| Page / action | Calls that wait |
|---|---|
| Sign in with an emailed code, or Google with "Remember me" | 1 (`authVerifyCode` / `authExchange` return the hub session along with the token) |
| Sign in with plain Google | 1 (`hubSession`, on opening the hub) |
| Hub, later visits | 0 (the saved session is shown at once and refreshed in the background if it is over 10 minutes old) |
| Equipment and Meal planning tabs | 0 (`hubLists` fetches equipment and recipes together in the background and saves them) |
| Slip from the hub | 0 for the form (the trip is saved from the hub); the saved profiles load in the background |
| Slip from a direct link | 1 (`slipLoad`: trip and profiles) |
| Submit a slip | 1 (the profile marked `data-profile` travels in the same request) |
| Add a trip | 1 (the refreshed trip list and templates come back with it) |
| Float plan | 1 (`hubFloatPlan` returns the roster and the equipment list) |
| Receipt, payment or reimbursement | 1 (and it is saved on the device first, see below) |
A bundled extra (like the session on sign-in, or the lists on add-trip) must never make the main action fail: the server catches its errors and the page falls back to asking for it separately.

## Working offline
The aim is that a leader can open the hub and record receipts, payments and reimbursements with no signal, and that what was entered reaches the sheet once there is signal again.
- **Pages:** `sw.js` (a service worker) saves the site's own files. It asks the network first, so an online visit always gets the latest deploy, and uses the saved copy when offline or when the network is slow. It never touches requests to the Apps Script web app or to Google.
- **Saved session:** the hub keeps the last `hubSession` answer (permissions, trips, the add-trip templates) on the device, per signed-in email. The hub, slip and add-trip pages open from it with no call; the hub refreshes it in the background when it is more than 10 minutes old, and says so if it can't. Float plans keep the last roster they loaded and show it, marked as possibly out of date, when offline.
- **Outbox:** a receipt, payment, reimbursement or permission slip is written to the device first, then sent. If there is no signal it stays in a "waiting to be sent" list on the hub (with "Send now"; the slip page shows a note too), and goes out when the connection returns, the next time the hub or the slip page is opened, or when the tab is shown again. A slip that is queued clears the form (the signed slip is safe in the outbox), and its sign-in token is added only when it is sent. If the server refuses one (say the trip no longer exists) it stays in the list as "Not accepted" with the reason, and can be retried or removed.
- **No double entries:** each entry carries a unique ID, stored in a server-filled `Client ID` column (on the Receipts, Payments, Reimbursements and Responses tabs), and the server ignores an ID it already has, so a retry after a lost reply can't add a second row. A server-filled `Entered At` column holds when it was entered or signed on the device; `Timestamp` is when it reached the sheet. A form field can't use either name.
- **Late entries are accepted:** a receipt or slip that reaches the server more than a couple of minutes after it was entered is recorded even if its trip has stopped accepting that in the meantime (noted in the `Log(Enabled)` tab; a slip's `Flags` column says `Trip closed before the slip was sent`). Permission slips whose trip details changed while the form was open are always accepted, and the `Flags` column says `Trip changed after the form loaded` (what the signer saw is in `wordingHash`). The device supplies the "entered" time, so a forged request could use it to skip the closed-trip check; it can't skip anything about who may do what.
- **Signing out:** the "Sign out" button deletes the saved session, rosters, profiles, drafts and the outbox from the device (and warns first if entries haven't been sent). A session that merely expires does not, so waiting entries survive until the person signs in again.
- **Limits to know about:** sign-in needs a connection, so tick "Remember me on this device" (a 30-day sign-in; a plain Google sign-in lasts about an hour, and entries wait for the next sign-in). The outbox is sent while the hub is open; iPhones can't send in the background. On an iPhone add the site to the Home Screen, because Safari can clear a normal tab's saved data after about a week unused. New trips are not queued offline (an ID is generated on the server).

## Setup
1. Create a Google Cloud OAuth client ID (Web); add your site origin as an authorized JavaScript origin.
2. Three spreadsheets (the script is standalone and opens each by ID; see `apps-script/Sheets.gs`). Create them, then put each ID (the long string in the sheet's URL) in Script Properties in step 3: `TRIPS_SHEET_ID`, `EQUIPMENT_SHEET_ID`, `RECIPES_SHEET_ID`. The account that deploys the web app needs edit access to all three.
   - **Trips spreadsheet** (`TRIPS_SHEET_ID`): tabs `Trips`, `Leaders`; `Responses`, `Youth Profiles`, `Adult Profiles`, `Receipts`, `Payments`, `Reimbursements` are created or extended automatically. Add trips from `add-trip.html`; the columns are the `name`s of the inputs in `add-trip.html` (a new input becomes a new column; the script only fills `tripId`, `customDepartureHtml` and the two `accepting...` flags, see `apps-script/Leaders.gs`). To show a new column on the permission slip, add a `<span id="<column>">` to `slip.html`. Each trip has a `tripId` (`YYYYMMNN`: year, month, 2-digit sequence within the month, e.g. `20261101`; generated from the "Trip month" chosen on the add-trip page) plus `acceptingResponses` (permission slip) and `acceptingReceipts` flags (`TRUE`/`FALSE`); edit them in the sheet to open or close a trip. The hub only shows a trip's buttons for the forms it accepts, and the server enforces the same flags.
   - **Equipment spreadsheet** (`EQUIPMENT_SHEET_ID`): a tab named `Equipment` with headers `item`, `category`, `quantity`, `status`, `notes`. Shown (searchable, read-only) on the hub's Equipment tab to any signed-in user. Edit it in the sheet.
   - **Recipes spreadsheet** (`RECIPES_SHEET_ID`): a tab named `Recipes` with headers `name`, `serves`, `ingredients` (one per line inside the cell, e.g. `1 1/2 cups flour`), `notes`. Offered as "Start from a troop recipe" on the Meal planning tab. Edit it in the sheet.
   - Column order doesn't matter. **Every column is sent to any signed-in user** under its header exactly as typed (case-sensitive; the page picks the ones it uses via `data-*` attributes in `index.html`), so start a header with an underscore (e.g. `_supplier`) to keep a column private. If the equipment or recipes ID isn't set, those tabs just say so; nothing else is affected. Run `runDiagnostics` from the editor to check all three.

   The `Leaders` sheet: row 1 headers `email`, `manageTrips` (add trips, view float plans, which list everyone's emergency phone and medical notes, and record payments), `recordReimbursements`, then one row per leader with checkboxes (or `TRUE`/`yes`/`1`) in the permission columns. A blank cell or missing column means no. Each permission gates both the button on the hub and the server action (`not_allowed` otherwise). A legacy sheet with only emails in column A (no permission columns) gives every listed leader all the permissions until you add the columns.
3. Push the backend from the command line (manual, not CI):
   - `npm install`, then `npx clasp login` (enable the Apps Script API at https://script.google.com/home/usersettings)
   - New project: `npx clasp create --type standalone --title "Troop Hub" --rootDir apps-script` (this writes `.clasp.json`; or create a standalone project at script.google.com and copy its script ID from Project Settings into `.clasp.json`)
   - `npm run push`
   - In Project Settings > Script Properties set `TRIPS_SHEET_ID`, `EQUIPMENT_SHEET_ID`, `RECIPES_SHEET_ID` (step 2), and `OAUTH_CLIENT_ID` to your client ID (or edit `DEFAULT_OAUTH_CLIENT_ID` in `Code.gs`)
   - First time: in the editor, Deploy > New deployment > Web app, and copy the `/exec` URL. Later: Deploy > Manage deployments > edit the existing web app deployment > new version (keeps the same URL).
4. Edit `docs/config.js` (client ID, web app URL, equipment form URL).
5. Preview locally without deploying anything: `npm run dev` (http://localhost:5173; open it in VS Code's Simple Browser if you like). It serves the pages with a fake Google sign-in (pick any email; `leader@test.com` has all leader permissions, `treasurer@test.com` only reimbursements (so no add-trip, float plan or payment buttons); override with `LEADERS="a@x.com,b@x.com:recordReimbursements" npm run dev`, no colon meaning all permissions), a fake email sign-in (any address; the code is always `123456` and is printed in the server console) and an in-memory mock of the Apps Script backend with two seeded trips (one open, one closed), a few equipment items and two recipes. `/dev/state` dumps the mock sheet data; it resets on restart. This only exercises the front end and the routes' contract, not the real `.gs` code or Google token verification, so still test once against a real deployment.
6. Deploy the static files: push to GitHub and enable Pages from `main` / `/docs` (or upload `docs/` to any static host). Add the Pages origin (e.g. `https://<user>.github.io`) to the OAuth client's authorized JavaScript origins.

## Tests
`npm test`. It also loads the real `.gs` files in Node (`test/gs.test.js`, via `dev/gs-loader.js`); the dev mock uses the same loader for hub records. `test/offline.test.js` covers the outbox, saved-session cache and sign-out wipe in `docs/offline.js` with fake storage; the service worker and the pages themselves are only checked by hand, so try them on a phone with airplane mode on.
