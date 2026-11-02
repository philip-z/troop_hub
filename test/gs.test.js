const test = require("node:test");
const assert = require("node:assert");
const { loadGs } = require("../dev/gs-loader.js");

// Objects created inside the vm have a different prototype; normalize before deepStrictEqual.
const plain = (x) => JSON.parse(JSON.stringify(x));
const isDate = (x) => Object.prototype.toString.call(x) === "[object Date]";

// Just enough of the Sheet API for what Sheets.gs uses.
function fakeSheet(rows, name) {
  rows = rows || [];
  const formats = [];
  const range = (row, col, nRows, nCols) => ({
    getValues() {
      const out = [];
      for (let r = 0; r < (nRows || 1); r++) {
        const line = [];
        for (let c = 0; c < (nCols || 1); c++) {
          const v = (rows[row - 1 + r] || [])[col - 1 + c];
          line.push(v === undefined ? "" : v);
        }
        out.push(line);
      }
      return out;
    },
    getDisplayValues() { return this.getValues().map((line) => line.map(String)); },
    setValue(v) {
      while (rows.length < row) rows.push([]);
      rows[row - 1][col - 1] = v;
      return this;
    },
    setFontWeight() { return this; },
    setNumberFormat(f) { formats.push(f); return this; },
    setValues(vals) {
      vals.forEach((line, i) => {
        while (rows.length < row + i) rows.push([]);
        rows[row - 1 + i] = line.slice();
      });
      return this;
    }
  });
  return {
    rows,
    formats,
    getName: () => name || "Sheet",
    getLastRow: () => rows.length,
    getLastColumn: () => rows.reduce((m, r) => Math.max(m, r.length), 0),
    appendRow: (r) => { rows.push(r.slice()); },
    getRange: range
  };
}

function fakeSpreadsheet(sheets) {
  const map = Object.assign({}, sheets);
  return {
    sheets: map,
    getSheetByName: (n) => map[n] || null,
    insertSheet: (n) => (map[n] = fakeSheet([], n))
  };
}

function loadSheets() {
  const logged = [];
  const ctx = loadGs(["Sheets.gs"], { logEvent_: (stage, detail) => logged.push([stage, detail]) });
  return { ctx, logged };
}

test("cleanRecordFields_ accepts form-style names and cleans values", () => {
  const { ctx } = loadSheets();
  const r = ctx.cleanRecordFields_({ "Paid To": "Bob", "Check #": ["1", "2"], Amount: "=1+1", Notes: "x".repeat(2000) }, ["Timestamp"]);
  assert.strictEqual(r.error, undefined);
  assert.strictEqual(r.fields["Paid To"], "Bob");
  assert.strictEqual(r.fields["Check #"], "1, 2");
  assert.strictEqual(r.fields.Amount, "'=1+1");
  assert.strictEqual(r.fields.Notes.length, 1000);
});

test("cleanRecordFields_ rejects bad input", () => {
  const { ctx } = loadSheets();
  const bad = (raw, reserved) => assert.ok(ctx.cleanRecordFields_(raw, reserved || []).error, String(JSON.stringify(raw)).slice(0, 60));
  bad({ "=IMPORTXML(1)": "x" });
  bad({ " Leading": "x" });
  bad({ "Trailing ": "x" });
  bad({ timestamp: "x" }, ["Timestamp"]);
  bad({ Amount: "1", amount: "2" });
  bad(Object.fromEntries(Array.from({ length: 41 }, (_, i) => ["Field " + i, "x"])));
  bad({});
  bad(undefined);
  bad(["a"]);
  bad({ ["A".repeat(81)]: "x" });
});

test("appendRecord_ on an empty sheet writes before, fields, after in order", () => {
  const { ctx } = loadSheets();
  const sheet = fakeSheet();
  const res = ctx.appendRecord_(sheet, { Description: "Pizza", Amount: "12.50" }, { Timestamp: new Date(), "Trip ID": "1" }, { "Submitted By": "a@x.com" });
  assert.strictEqual(res.error, undefined);
  assert.deepStrictEqual(plain(sheet.rows[0]), ["Timestamp", "Trip ID", "Description", "Amount", "Submitted By"]);
  assert.ok(isDate(sheet.rows[1][0]));
  assert.deepStrictEqual(plain(sheet.rows[1].slice(1)), ["1", "Pizza", "12.50", "a@x.com"]);
});

test("appendRecord_ maps by header and appends new fields as new last columns", () => {
  const { ctx, logged } = loadSheets();
  const headers = ["Timestamp", "Trip ID", "Trip", "Description", "Amount", "Receipt URL", "Submitted By"];
  const old = ["t0", "1", "Camp", "Old", "5", "", "z@x.com"];
  const sheet = fakeSheet([headers.slice(), old.slice()]);
  ctx.appendRecord_(sheet, { description: "New", AMOUNT: "7", "Check Number": "99" },
    { Timestamp: new Date(), "Trip ID": "2", Trip: "Hike" }, { "Receipt URL": "u", "Submitted By": "a@x.com" });
  assert.deepStrictEqual(plain(sheet.rows[0]), headers.concat(["Check Number"]));
  assert.deepStrictEqual(plain(sheet.rows[1]), old); // untouched
  const row = sheet.rows[2];
  assert.deepStrictEqual(plain(row.slice(1)), ["2", "Hike", "New", "7", "u", "a@x.com", "99"]);
  assert.ok(logged.some((l) => l[0] === "columns added" && l[1].includes("Check Number")));
});

test("appendRecord_ refuses to grow a sheet past the column cap", () => {
  const { ctx } = loadSheets();
  const headers = Array.from({ length: 59 }, (_, i) => "H" + i);
  const sheet = fakeSheet([headers.slice()]);
  const res = ctx.appendRecord_(sheet, { NewA: "1", NewB: "2" }, {}, {});
  assert.ok(res.error);
  assert.deepStrictEqual(plain(sheet.rows), [headers]);
});

function makeHub() {
  const logged = [];
  const photoCalls = [];
  const ctx = loadGs(["Sheets.gs", "Trips.gs", "Leaders.gs", "Hub.gs", "Library.gs", "Slip.gs", "Code.gs"], {
    logEvent_: (stage, detail) => logged.push([stage, detail]),
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) }
  });
  const ss = fakeSpreadsheet();
  const trips = {
    "20261101": { tripId: "20261101", tripTitle: "Fall Campout", acceptingReceipts: "TRUE" },
    "20261102": { tripId: "20261102", tripTitle: "Hike", acceptingReceipts: "FALSE" }
  };
  ctx.getSpreadsheet_ = () => ss;
  ctx.getTripConfig_ = (_ss, id) => trips[id] || null;
  ctx.hubSaveReceiptPhoto_ = () => { photoCalls.push(1); return { url: "https://drive.example/photo" }; };
  return { ctx, ss, photoCalls, logged };
}

test("hub receipt: form fields become columns, server fills the rest", () => {
  const { ctx, ss } = makeHub();
  const res = ctx.hubAppendRecord_(ctx.HUB_RECORDS.receipt,
    { tripId: "20261101", values: { Description: "Pizza", Amount: "12.50" }, photo: { data: "abc" } }, "a@x.com");
  assert.deepStrictEqual(plain(res), { status: "success" });
  const rows = ss.sheets.Receipts.rows;
  assert.deepStrictEqual(plain(rows[0]), ["Timestamp", "Trip ID", "Trip", "Description", "Amount", "Receipt URL", "Submitted By"]);
  assert.ok(isDate(rows[1][0]));
  assert.deepStrictEqual(plain(rows[1].slice(1)), ["20261101", "Fall Campout", "Pizza", "12.50", "https://drive.example/photo", "a@x.com"]);
});

test("hub payment: a brand-new form field creates its own column", () => {
  const { ctx, ss } = makeHub();
  const res = ctx.hubAppendRecord_(ctx.HUB_RECORDS.payment,
    { tripId: "20261101", values: { Scout: "Sam", Amount: "40", Method: "Check", "Check Number": "1001" } }, "t@x.com");
  assert.strictEqual(res.status, "success");
  const rows = ss.sheets.Payments.rows;
  assert.deepStrictEqual(plain(rows[0]), ["Timestamp", "Trip ID", "Trip", "Scout", "Amount", "Method", "Check Number", "Recorded By"]);
  assert.deepStrictEqual(plain(rows[1].slice(1)), ["20261101", "Fall Campout", "Sam", "40", "Check", "1001", "t@x.com"]);
});

test("hub rejects server-owned column names from the browser and writes nothing", () => {
  const { ctx, ss, photoCalls } = makeHub();
  ["Recorded By", "trip id", "Timestamp", "Trip"].forEach((name) => {
    const res = ctx.hubAppendRecord_(ctx.HUB_RECORDS.payment, { tripId: "20261101", values: { Scout: "Sam", [name]: "spoof" } }, "t@x.com");
    assert.strictEqual(res.code, "invalid", name);
  });
  const res = ctx.hubAppendRecord_(ctx.HUB_RECORDS.receipt, { tripId: "20261101", values: { "Receipt URL": "evil" }, photo: { data: "abc" } }, "a@x.com");
  assert.strictEqual(res.code, "invalid");
  assert.strictEqual(photoCalls.length, 0);
  assert.strictEqual(ss.sheets.Payments, undefined);
  assert.strictEqual(ss.sheets.Receipts, undefined);
});

test("hub closed and unknown trips", () => {
  const { ctx } = makeHub();
  const closed = ctx.hubAppendRecord_(ctx.HUB_RECORDS.receipt, { tripId: "20261102", values: { Description: "x" } }, "a@x.com");
  assert.strictEqual(closed.code, "closed");
  const missing = ctx.hubAppendRecord_(ctx.HUB_RECORDS.receipt, { tripId: "nope", values: { Description: "x" } }, "a@x.com");
  assert.strictEqual(missing.code, "not_found");
});

test("hub invalid field name does not upload the photo", () => {
  const { ctx, photoCalls } = makeHub();
  const res = ctx.hubAppendRecord_(ctx.HUB_RECORDS.receipt,
    { tripId: "20261101", values: { "=HYPERLINK(1)": "x" }, photo: { data: "abc" } }, "a@x.com");
  assert.strictEqual(res.code, "invalid");
  assert.strictEqual(photoCalls.length, 0);
});

const formValues = (extra) => Object.assign({
  tripTitle: "  Winter   Camp ", tripLocation: "Camp X", tripMonth: "2026-12", tripDates: "Dec 5-7, 2026",
  departureDetails: "Church <lot>", departureOptions: "Fri 5pm\n\nSat 8am", tripCost: "-5 deposit",
  acceptingResponses: "TRUE"
}, extra);

test("buildTripRecord_: form names are the columns, the script fills only its own", () => {
  const { ctx } = makeHub();
  const rec = plain(ctx.buildTripRecord_(formValues({ tripGear: "Tents" })));
  assert.strictEqual(rec.error, undefined);
  assert.strictEqual(rec.month, "2026-12");
  assert.deepStrictEqual(rec.fields, {
    tripTitle: "Winter Camp", tripLocation: "Camp X", tripDates: "Dec 5-7, 2026",
    departureDetails: "Church <lot>", tripCost: "-5 deposit", tripGear: "Tents"
  });
  assert.deepStrictEqual(Object.keys(rec.after), ["customDepartureHtml", "acceptingResponses", "acceptingReceipts"]);
  assert.strictEqual(rec.after.acceptingResponses, "TRUE");
  assert.strictEqual(rec.after.acceptingReceipts, "FALSE");
  assert.ok(rec.after.customDepartureHtml.includes("Church &lt;lot&gt;"));
  assert.ok(rec.after.customDepartureHtml.includes('<option value="Sat 8am">'));
});

test("buildTripRecord_ rejects a bad month, server-owned columns and bad names", () => {
  const { ctx } = makeHub();
  assert.ok(ctx.buildTripRecord_(formValues({ tripMonth: "" })).error);
  assert.ok(ctx.buildTripRecord_(formValues({ tripId: "20260101" })).error);
  assert.ok(ctx.buildTripRecord_(formValues({ customDepartureHtml: "<script>" })).error);
  assert.ok(ctx.buildTripRecord_(formValues({ "=BAD()": "x" })).error);
  assert.ok(ctx.buildTripRecord_(undefined).error);
});

function makeTripSheet(rows) {
  const h = makeHub();
  const trips = fakeSheet(rows, "Trips");
  h.ss.sheets.Trips = trips;
  h.ctx.verifyGoogleTokenInfo_ = () => ({ email: "l@x.com", emailVerified: true });
  h.ctx.hasLeaderPermission_ = () => true;
  return Object.assign(h, { trips });
}

test("addTrip_ on an existing sheet: next ID, new form field becomes a column, text cells, log row", () => {
  const headers = ["tripId", "tripTitle", "tripLocation", "tripDates", "departureDetails", "returnDetails", "tripCost",
    "tripCoordinator", "tripUniform", "customDepartureHtml", "acceptingResponses", "acceptingReceipts"];
  const old = ["20261201", "Old", "", "", "", "", "", "", "", "", "TRUE", "FALSE"];
  const { ctx, ss, trips } = makeTripSheet([headers.slice(), old.slice()]);
  const res = plain(ctx.addTrip_({ idToken: "t", values: formValues({ tripGear: "Tents" }) }));
  assert.deepStrictEqual(res, { status: "success", tripId: "20261202" });
  assert.deepStrictEqual(plain(trips.rows[0]), headers.concat(["tripGear"]));
  assert.deepStrictEqual(plain(trips.rows[1]), old);
  const row = plain(trips.rows[2]);
  assert.strictEqual(row[0], "20261202");
  assert.strictEqual(row[1], "Winter Camp");
  assert.strictEqual(row[6], "-5 deposit"); // no stray apostrophe in a text cell
  assert.strictEqual(row[10], "TRUE");
  assert.strictEqual(row[11], "FALSE");
  assert.strictEqual(row[12], "Tents");
  assert.deepStrictEqual(trips.formats, ["@"]);
  const log = ss.sheets["Trip Log"].rows;
  assert.deepStrictEqual(plain(log[1].slice(1)), ["l@x.com", "Winter Camp", "Dec 5-7, 2026"]);
});

test("addTrip_ on an empty Trips sheet creates headers from the form", () => {
  const { ctx, trips } = makeTripSheet([]);
  const res = plain(ctx.addTrip_({ idToken: "t", values: { tripTitle: "A", tripMonth: "2026-01" } }));
  assert.deepStrictEqual(res, { status: "success", tripId: "20260101" });
  assert.deepStrictEqual(plain(trips.rows[0]),
    ["tripId", "tripTitle", "customDepartureHtml", "acceptingResponses", "acceptingReceipts"]);
});

test("addTrip_ reports a form error without touching the sheet", () => {
  const { ctx, trips } = makeTripSheet([["tripId"]]);
  const res = plain(ctx.addTrip_({ idToken: "t", values: { tripTitle: "A" } }));
  assert.strictEqual(res.code, "invalid");
  assert.deepStrictEqual(plain(trips.rows), [["tripId"]]);
});

test("tripSummary_ keeps every column and turns the flags into booleans", () => {
  const { ctx } = makeHub();
  const s = plain(ctx.tripSummary_({ tripId: "1", tripTitle: "T", tripGear: "x", acceptingResponses: "TRUE", acceptingReceipts: "" }));
  assert.deepStrictEqual(s, { tripId: "1", tripTitle: "T", tripGear: "x", acceptingResponses: true, acceptingReceipts: false });
});

test("tripTemplateFromRow_ keeps every column and swaps the generated HTML for plain options", () => {
  const { ctx } = makeHub();
  const rec = ctx.buildTripRecord_(formValues());
  const t = plain(ctx.tripTemplateFromRow_(Object.assign({ tripId: "1" }, plain(rec.fields), plain(rec.after))));
  assert.strictEqual(t.departureOptions, "Fri 5pm\nSat 8am");
  assert.strictEqual(t.customDepartureHtml, undefined);
  assert.strictEqual(t.tripLocation, "Camp X");
});

test("tableRows_ sends every column by header, minus private and blank ones", () => {
  const { ctx } = makeHub();
  const out = plain(ctx.tableRows_([
    [" Item ", "Qty", "_supplier", "", "Item", "New Column"],
    ["Tent", 3, "secret", "x", "dup", "hi"],
    ["", "", "only private", "", "", ""],
    ["Stove", "", "", "", ""]
  ]));
  assert.deepStrictEqual(out, [
    { Item: "Tent", Qty: "3", "New Column": "hi" },
    { Item: "Stove", Qty: "", "New Column": "" }
  ]);
  assert.deepStrictEqual(plain(ctx.tableRows_([["a"]])), []);
  assert.deepStrictEqual(plain(ctx.tableRows_(undefined)), []);
});

test("tableRows_ caps columns and cell length", () => {
  const { ctx } = makeHub();
  const headers = Array.from({ length: 60 }, (_, i) => "H" + i);
  const out = plain(ctx.tableRows_([headers, headers.map(() => "x".repeat(3000))]));
  assert.strictEqual(Object.keys(out[0]).length, 40);
  assert.strictEqual(out[0].H0.length, 2000);
});

test("listEquipment_ and listRecipes_ return whole sheets, or a config error", () => {
  const { ctx, ss } = makeHub();
  ss.sheets.Equipment = fakeSheet([["item", "color"], ["Tent", "green"]]);
  ctx.findSpreadsheet_ = (role) => (role === "equipment" ? ss : null);
  assert.deepStrictEqual(plain(ctx.listEquipment_()), { status: "success", items: [{ item: "Tent", color: "green" }] });
  assert.strictEqual(ctx.listRecipes_().code, "config");
  ctx.findSpreadsheet_ = () => ss; // spreadsheet without the tab
  assert.deepStrictEqual(plain(ctx.listRecipes_()), { status: "success", items: [] });
});

const youthFields = (extra) => Object.assign({ "Youth Name": "Sam Scout", Patrol: "Eagles", "Medical Notes": "None" }, extra);
const save = (ctx, kind, email, fields) => plain(ctx.saveProfile_(kind, email, fields));

test("saveProfile_ creates a row whose columns are the sent fields, with the writer authorized", () => {
  const { ctx, ss } = makeHub();
  assert.deepStrictEqual(save(ctx, "youth", "mom@x.com", youthFields({ "Birth Year": "2012" })), { status: "success" });
  const rows = plain(ss.sheets["Youth Profiles"].rows);
  assert.deepStrictEqual(rows[0], ["Youth Name", "Authorized Emails", "Patrol", "Medical Notes", "Birth Year"]);
  assert.deepStrictEqual(rows[1], ["Sam Scout", "mom@x.com", "Eagles", "None", "2012"]);
});

test("saveProfile_ updates the writer's own row, keeps other values, and adds only valid extra emails", () => {
  const { ctx, ss } = makeHub();
  save(ctx, "youth", "mom@x.com", youthFields({ Rank: "Scout" }));
  save(ctx, "youth", "Mom@x.com", { "Youth Name": "  sam   scout ", Rank: "Tenderfoot", "Authorized Emails": "dad@x.com, *, junk, ;mom@x.com" });
  const rows = plain(ss.sheets["Youth Profiles"].rows);
  assert.strictEqual(rows.length, 2);
  const row = Object.fromEntries(rows[0].map((h, i) => [h, rows[1][i]]));
  assert.strictEqual(row["Youth Name"], "sam scout");
  assert.strictEqual(row.Rank, "Tenderfoot");
  assert.strictEqual(row.Patrol, "Eagles"); // kept
  assert.strictEqual(row["Authorized Emails"], "mom@x.com, dad@x.com");
});

test("saveProfile_ never lets someone else's row be read or changed by reusing a name", () => {
  const { ctx, ss } = makeHub();
  save(ctx, "youth", "mom@x.com", youthFields({ "Medical Notes": "Peanut allergy" }));
  save(ctx, "youth", "stranger@x.com", { "Youth Name": "Sam Scout", "Medical Notes": "mine" });
  const rows = plain(ss.sheets["Youth Profiles"].rows);
  assert.strictEqual(rows.length, 3); // a separate row
  const get = (r) => Object.fromEntries(rows[0].map((h, i) => [h, rows[r][i]]));
  assert.strictEqual(get(1)["Medical Notes"], "Peanut allergy");
  assert.strictEqual(get(1)["Authorized Emails"], "mom@x.com");
  assert.strictEqual(get(2)["Authorized Emails"], "stranger@x.com");
  const mine = plain(ctx.getUserProfiles_("stranger@x.com"));
  assert.deepStrictEqual(mine.youth.map((p) => p["Medical Notes"]), ["mine"]);
  assert.deepStrictEqual(plain(ctx.getUserProfiles_("mom@x.com")).youth.map((p) => p["Medical Notes"]), ["Peanut allergy"]);
});

test("profiles: * is shared with everyone (leader-set only), private columns stay home", () => {
  const { ctx, ss } = makeHub();
  ss.sheets["Youth Profiles"] = fakeSheet([
    ["Youth Name", "Authorized Emails", "_Leader Notes"],
    ["Shared Kid", "*", "private"],
    ["Other Kid", "mom@x.com", "private"]
  ]);
  const out = plain(ctx.getUserProfiles_("Anyone@x.com"));
  assert.deepStrictEqual(out.youth, [{ "Youth Name": "Shared Kid", "Authorized Emails": "*" }]);
  assert.deepStrictEqual(out.adult, []);
  assert.deepStrictEqual(plain(ctx.getUserProfiles_("")).youth, []);
});

test("adult profiles live on their own tab and keep text cells as typed", () => {
  const { ctx, ss } = makeHub();
  save(ctx, "adult", "al@x.com", { "Adult Name": "Al Adult", "Ypt Date": "2026-01-05", "Veh Plate #": "=1+1" });
  const sheet = ss.sheets["Adult Profiles"];
  assert.deepStrictEqual(plain(sheet.rows[0]), ["Adult Name", "Authorized Emails", "Ypt Date", "Veh Plate #"]);
  assert.deepStrictEqual(plain(sheet.rows[1]), ["Al Adult", "al@x.com", "2026-01-05", "=1+1"]);
  assert.ok(sheet.formats.includes("@"));
  assert.strictEqual(ss.sheets["Youth Profiles"], undefined);
  assert.deepStrictEqual(plain(ctx.getUserProfiles_("al@x.com")).adult.map((p) => p["Adult Name"]), ["Al Adult"]);
});

test("saveProfile_ rejects what it should and writes nothing", () => {
  const { ctx, ss } = makeHub();
  assert.strictEqual(save(ctx, "youth", "a@x.com", { Patrol: "x" }).code, "invalid"); // no name
  assert.strictEqual(save(ctx, "nope", "a@x.com", youthFields()).code, "invalid");
  assert.strictEqual(save(ctx, "constructor", "a@x.com", youthFields()).code, "invalid");
  assert.strictEqual(save(ctx, "youth", "a@x.com", youthFields({ "=BAD()": "x" })).code, "invalid");
  assert.strictEqual((ss.sheets["Youth Profiles"] || { rows: [] }).rows.length, 0);

  // a sheet that is nearly at the column cap can't take three more columns
  const headers = ["Youth Name", "Authorized Emails"].concat(Array.from({ length: 57 }, (_, i) => "Old " + i));
  ss.sheets["Youth Profiles"] = fakeSheet([headers]);
  assert.strictEqual(save(ctx, "youth", "a@x.com", { "Youth Name": "A", "New 1": "x", "New 2": "x" }).code, "invalid");
  assert.deepStrictEqual(plain(ss.sheets["Youth Profiles"].rows), [headers]);
  assert.strictEqual(save(ctx, "youth", "a@x.com", { "Youth Name": "A", "New 1": "x" }).status, "success");
});

test("profileUser_ needs a verified email", () => {
  const { ctx } = makeHub();
  ctx.verifyGoogleTokenInfo_ = () => ({ email: "a@x.com", emailVerified: true });
  assert.strictEqual(plain(ctx.profileUser_("t")).email, "a@x.com");
  ctx.verifyGoogleTokenInfo_ = () => ({ email: "a@x.com", emailVerified: false });
  assert.strictEqual(ctx.profileUser_("t"), null);
  ctx.verifyGoogleTokenInfo_ = () => null;
  assert.strictEqual(ctx.profileUser_("t"), null);
});

test("slip submission: flags come from SLIP_KINDS and no profile is saved from it", () => {
  const { ctx, ss } = makeHub();
  ctx.jsonOut_ = (x) => x;
  ctx.verifyGoogleToken_ = () => "sub";
  ctx.getTripConfig_ = () => ({ tripId: "20261101", acceptingResponses: "TRUE", _tripRevision: "r" });
  const submit = (extra) => plain(ctx.handlePermissionPost_("{}", Object.assign({ _idToken: "t", _tripId: "20261101", _tripRevision: "r" }, extra)));
  const flagsOf = () => { const rows = ss.sheets.Responses.rows; const i = plain(rows[0]).indexOf("Flags"); return rows[rows.length - 1][i]; };

  assert.strictEqual(submit({ "Form Type": "Adult", "Adult Name": "Al" }).status, "success");
  assert.ok(flagsOf().includes("Missing signature") && !flagsOf().includes("Missing name"));
  submit({ "Form Type": "Adult", "Adult Name": "Al", "Adult Signature": "Al" });
  assert.ok(!flagsOf().includes("Missing"));
  submit({ "Form Type": "Youth", "Youth Name": "Sam", "Parent Signature": "Mom" });
  assert.ok(flagsOf().includes("Missing signature"));
  submit({ "Form Type": "Youth", "Parent Signature": "Mom", "Youth Signature": "Sam" });
  assert.ok(flagsOf().includes("Missing name"));
  assert.strictEqual(ss.sheets["Youth Profiles"], undefined);
  assert.strictEqual(ss.sheets["Adult Profiles"], undefined);
});

test("tripResponsesFrom_: one trip, latest slip per person, no signature columns", () => {
  const { ctx } = makeHub();
  const grid = [
    ["Timestamp", "Form Type", "Youth Name", "Adult Name", "Parent Signature", "Adult Signature", "Medical Notes", "tripId", "_note"],
    ["t1", "Youth", "Sam Scout", "", "Mom", "", "old", "20261101", "x"],
    ["t2", "Adult", "", "Al Adult", "", "Al", "", "20261101", "x"],
    ["t3", "Youth", "Other Trip Kid", "", "Mom", "", "", "20261102", "x"],
    ["t4", "Youth", "  sam  scout", "", "Mom", "", "new", "20261101", "x"]
  ];
  const out = plain(ctx.tripResponsesFrom_(grid, "20261101"));
  assert.deepStrictEqual(out.map((r) => r.Timestamp), ["t2", "t4"]);
  assert.strictEqual(out[1]["Medical Notes"], "new");
  out.forEach((r) => {
    assert.ok(!("Parent Signature" in r) && !("Adult Signature" in r) && !("_note" in r));
  });
  assert.deepStrictEqual(plain(ctx.tripResponsesFrom_(grid, "nope")), []);
  assert.deepStrictEqual(plain(ctx.tripResponsesFrom_([["a"]], "1")), []);
});

test("hubFloatPlan needs the manageTrips permission", () => {
  const { ctx, ss } = makeHub();
  ss.sheets.Responses = fakeSheet([["Form Type", "Youth Name", "tripId"], ["Youth", "Sam", "20261101"]], "Responses");
  ctx.verifyGoogleTokenInfo_ = () => ({ email: "l@x.com", emailVerified: true });
  const ask = () => plain(ctx.handleHub_({ action: "hubFloatPlan", idToken: "t", tripId: "20261101" }));
  ctx.getLeaderPermissions_ = () => ({ manageTrips: false });
  assert.strictEqual(ask().code, "not_allowed");
  ctx.getLeaderPermissions_ = () => null;
  assert.strictEqual(ask().code, "not_allowed");
  ctx.getLeaderPermissions_ = () => ({ manageTrips: true });
  const ok = ask();
  assert.strictEqual(ok.status, "success");
  assert.deepStrictEqual(ok.responses.map((r) => r["Youth Name"]), ["Sam"]);
});

test("hubMeta_ keeps only a well-formed clientId and a sane enteredAt", () => {
  const { ctx } = makeHub();
  const now = new Date("2026-11-10T12:00:00Z");
  const meta = (d) => { const m = ctx.hubMeta_(d, now); return { clientId: m.clientId, enteredAt: m.enteredAt && m.enteredAt.toISOString(), late: m.late }; };
  assert.deepStrictEqual(meta({ clientId: "abc12345-uuid", enteredAt: "2026-11-10T11:50:00Z" }), { clientId: "abc12345-uuid", enteredAt: "2026-11-10T11:50:00.000Z", late: true });
  assert.strictEqual(meta({ enteredAt: "2026-11-10T11:59:00Z" }).late, false); // within a couple of minutes: not queued
  assert.strictEqual(meta({ enteredAt: "2026-11-10T13:00:00Z" }).enteredAt, "2026-11-10T12:00:00.000Z"); // future: clamped to now
  assert.strictEqual(meta({ enteredAt: "2025-01-01T00:00:00Z" }).enteredAt, null); // older than 90 days
  assert.deepStrictEqual(meta({ enteredAt: "not a date" }), { clientId: "", enteredAt: null, late: false });
  ["short", "=1+1+1+1+1", "-abcdefghij", "has space 12345", "x".repeat(65)].forEach((id) => assert.strictEqual(meta({ clientId: id }).clientId, "", id));
  assert.deepStrictEqual(meta(undefined), { clientId: "", enteredAt: null, late: false });
});

test("columnHasValue_ looks under the named header only", () => {
  const { ctx } = makeHub();
  const sheet = fakeSheet([["A", "Client ID"], ["id-1", "x"], ["y", "id-2"]]);
  assert.strictEqual(ctx.columnHasValue_(sheet, "client id", "id-2"), true);
  assert.strictEqual(ctx.columnHasValue_(sheet, "Client ID", "id-1"), false);
  assert.strictEqual(ctx.columnHasValue_(sheet, "Nope", "id-2"), false);
  assert.strictEqual(ctx.columnHasValue_(fakeSheet([]), "Client ID", "id-2"), false);
});

test("hub records from a device: Entered At and Client ID columns, and a retry is not written twice", () => {
  const { ctx, ss, photoCalls } = makeHub();
  const entered = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const send = () => plain(ctx.hubAppendRecord_(ctx.HUB_RECORDS.receipt,
    { tripId: "20261101", values: { Description: "Pizza", Amount: "12.50" }, photo: { data: "abc" }, clientId: "device-0001", enteredAt: entered }, "a@x.com"));
  assert.deepStrictEqual(send(), { status: "success" });
  assert.deepStrictEqual(send(), { status: "success", duplicate: true });
  const rows = ss.sheets.Receipts.rows;
  assert.strictEqual(rows.length, 2); // header + one row
  assert.deepStrictEqual(plain(rows[0]), ["Timestamp", "Entered At", "Trip ID", "Trip", "Description", "Amount", "Receipt URL", "Submitted By", "Client ID"]);
  assert.strictEqual(plain(rows[1])[8], "device-0001");
  assert.strictEqual(new Date(rows[1][1]).toISOString(), entered);
  assert.strictEqual(photoCalls.length, 1); // the retry didn't upload the photo again
});

test("hub records: a late entry for a closed trip is accepted, an on-time one is not", () => {
  const { ctx, ss, logged } = makeHub();
  const base = { tripId: "20261102", values: { Description: "Gas", Amount: "30" } }; // acceptingReceipts FALSE
  const onTime = ctx.hubAppendRecord_(ctx.HUB_RECORDS.receipt, Object.assign({ clientId: "device-0002", enteredAt: new Date().toISOString() }, base), "a@x.com");
  assert.strictEqual(plain(onTime).code, "closed");
  assert.strictEqual(plain(ctx.hubAppendRecord_(ctx.HUB_RECORDS.receipt, base, "a@x.com")).code, "closed"); // no metadata
  const late = plain(ctx.hubAppendRecord_(ctx.HUB_RECORDS.receipt,
    Object.assign({ clientId: "device-0003", enteredAt: new Date(Date.now() - 3600 * 1000).toISOString() }, base), "a@x.com"));
  assert.strictEqual(late.status, "success");
  assert.strictEqual(ss.sheets.Receipts.rows.length, 2);
  assert.ok(logged.some((l) => l[0] === "late record accepted"));
});

test("hub records: a bad clientId is ignored, and the new column names are reserved", () => {
  const { ctx, ss } = makeHub();
  const res = plain(ctx.hubAppendRecord_(ctx.HUB_RECORDS.payment, { tripId: "20261101", values: { Scout: "Sam" }, clientId: "=bad" }, "t@x.com"));
  assert.strictEqual(res.status, "success");
  assert.ok(!plain(ss.sheets.Payments.rows[0]).includes("Client ID"));
  ["Client ID", "entered at"].forEach((name) => {
    assert.strictEqual(plain(ctx.hubAppendRecord_(ctx.HUB_RECORDS.payment, { tripId: "20261101", values: { Scout: "Sam", [name]: "x" } }, "t@x.com")).code, "invalid", name);
  });
});

test("slip submission: a changed or missing trip revision is accepted and flagged", () => {
  const { ctx, ss } = makeHub();
  ctx.jsonOut_ = (x) => x;
  ctx.verifyGoogleToken_ = () => "sub";
  ctx.getTripConfig_ = () => ({ tripId: "20261101", acceptingResponses: "TRUE", _tripRevision: "new" });
  const base = { _idToken: "t", _tripId: "20261101", "Form Type": "Adult", "Adult Name": "Al", "Adult Signature": "Al" };
  const flagsOf = () => { const rows = ss.sheets.Responses.rows; return rows[rows.length - 1][plain(rows[0]).indexOf("Flags")]; };
  assert.strictEqual(plain(ctx.handlePermissionPost_("{}", Object.assign({ _tripRevision: "old" }, base))).status, "success");
  assert.ok(flagsOf().includes("Trip changed after the form loaded"));
  assert.strictEqual(plain(ctx.handlePermissionPost_("{}", base)).status, "success");
  assert.ok(flagsOf().includes("No trip revision"));
  assert.strictEqual(plain(ctx.handlePermissionPost_("{}", Object.assign({ _tripRevision: "new" }, base))).status, "success");
  assert.ok(!flagsOf().includes("Trip"));
  assert.strictEqual(ss.sheets.Responses.rows.length, 4);
});

test("HUB_RECORDS entries are well-formed", () => {
  const { ctx } = makeHub();
  const perms = plain(ctx.LEADER_PERMISSIONS);
  Object.entries(plain(ctx.HUB_RECORDS)).forEach(([kind, spec]) => {
    assert.ok(spec.tab, kind + " tab");
    assert.ok(spec.byColumn, kind + " byColumn");
    assert.ok(spec.permission === "" || perms.includes(spec.permission), kind + " permission");
  });
});
