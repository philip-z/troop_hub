// ---------------------------------------------------------------------------
// SPREADSHEETS: the script is standalone (not bound to a sheet) and opens each
// spreadsheet by ID from Script Properties (Project Settings > Script Properties):
//   TRIPS_SHEET_ID      Trips, Leaders, Responses, Profiles, Youth Profiles, Receipts,
//                       Payments, Reimbursements, Trip Log, Log(Enabled)
//   EQUIPMENT_SHEET_ID  tab "Equipment" (see Library.gs)
//   RECIPES_SHEET_ID    tab "Recipes"   (see Library.gs)
// The ID is the long string in the spreadsheet's URL: /spreadsheets/d/<ID>/edit.
// The account that owns the deployment must be able to edit all three.
// ---------------------------------------------------------------------------

var SHEET_ROLES = {
  trips: 'TRIPS_SHEET_ID',
  equipment: 'EQUIPMENT_SHEET_ID',
  recipes: 'RECIPES_SHEET_ID'
};

var spreadsheetCache_ = {};

// Returns the spreadsheet for a role, or null if it is not configured.
// A script bound to the Trips spreadsheet still works without TRIPS_SHEET_ID.
function findSpreadsheet_(role) {
  if (spreadsheetCache_[role]) return spreadsheetCache_[role];
  var id = PropertiesService.getScriptProperties().getProperty(SHEET_ROLES[role]);
  var ss = null;
  if (id) {
    ss = SpreadsheetApp.openById(id.trim());
  } else if (role === 'trips') {
    ss = SpreadsheetApp.getActiveSpreadsheet();
  }
  if (ss) spreadsheetCache_[role] = ss;
  return ss;
}

// Like findSpreadsheet_, but throws a clear error when it is not configured.
function getSpreadsheet_(role) {
  var ss = findSpreadsheet_(role);
  if (!ss) throw new Error('Script property ' + SHEET_ROLES[role] + ' is not set.');
  return ss;
}

// Centralized helper to get a sheet by name. Never uses sheet indexes.
// If autoCreate is true, creates the sheet if missing. If false, throws an error if missing.
function getOrCreateSheet_(ss, sheetName, autoCreate) {
  var name = String(sheetName || '').trim();
  if (!name) throw new Error('Sheet name cannot be empty.');
  var sheet = ss.getSheetByName(name);
  if (!sheet) {
    if (autoCreate) {
      sheet = ss.insertSheet(name);
    } else {
      throw new Error('Required sheet "' + name + '" was not found in the spreadsheet.');
    }
  }
  return sheet;
}

// Reads row 1 of a sheet as trimmed header strings. Returns [] if sheet is empty.
function getSheetHeaders_(sheet) {
  if (!sheet || sheet.getLastRow() < 1 || sheet.getLastColumn() < 1) return [];
  return sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(function(h) {
    return String(h === undefined || h === null ? '' : h).trim();
  });
}

// Returns a getter function col(row, headerName) that looks up a cell value in a row by header name.
function createColumnGetter_(headers) {
  var headerMap = {};
  headers.forEach(function(h, idx) {
    var key = String(h || '').trim().toLowerCase();
    if (key && headerMap[key] === undefined) headerMap[key] = idx;
  });
  return function(row, headerName) {
    if (!row) return '';
    var key = String(headerName || '').trim().toLowerCase();
    var idx = headerMap[key];
    return (idx === undefined || idx >= row.length) ? '' : row[idx];
  };
}

// Ensures all required header names exist in row 1 of a sheet, appending any missing headers.
function ensureSheetHeaders_(sheet, requiredHeaders) {
  var headers = getSheetHeaders_(sheet);
  if (headers.length === 0) {
    sheet.appendRow(requiredHeaders);
    sheet.getRange(1, 1, 1, requiredHeaders.length).setFontWeight('bold');
    return requiredHeaders;
  }
  var lowerHeaders = headers.map(function(h) { return h.toLowerCase(); });
  var newHeaders = headers.slice();
  requiredHeaders.forEach(function(req) {
    if (lowerHeaders.indexOf(String(req).trim().toLowerCase()) === -1) {
      sheet.getRange(1, newHeaders.length + 1).setValue(req).setFontWeight('bold');
      newHeaders.push(req);
      lowerHeaders.push(String(req).trim().toLowerCase());
    }
  });
  return newHeaders;
}

// ---------------------------------------------------------------------------
// RECORDS: append one row built from a form. The form's field names ARE the column
// headers, so adding or renaming a field in the HTML needs no change in the .gs code.
// The server fixes only what it must: columns it fills itself (SERVER_COLUMNS plus the
// `before` / `after` columns a caller passes in) can never be set by the browser, and
// every request is bounded, because a forged request can send anything.
// ---------------------------------------------------------------------------

// Columns the server fills itself on hub records (see Hub.gs hubServerFields_).
var SERVER_COLUMNS = { timestamp: 'Timestamp', tripId: 'Trip ID', tripName: 'Trip' };
var SHEET_CELL_MAX = 1000;
var MAX_RECORD_FIELDS = 40;
var MAX_SHEET_COLUMNS = 60;
var COLUMN_NAME_MAX = 80;
// Must start with a letter or digit, so a field name can never become a formula (=, +, -, @).
var COLUMN_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 _.()\/&#'?:,-]*$/;

// Caps length and blocks spreadsheet formula injection. Dates pass through unchanged.
// textCell: the cell will be formatted as plain text (formulas can't run there), so
// skip the leading apostrophe, which would show up literally.
function sheetCell_(v, maxLen, textCell) {
  if (Object.prototype.toString.call(v) === '[object Date]') return v;
  var s = (v === undefined || v === null) ? '' : String(v).substring(0, maxLen || SHEET_CELL_MAX);
  if (textCell) return s;
  return /^[=+\-@\t\r]/.test(s) ? "'" + s : s;
}

// Validates browser-supplied fields (an object of header -> value) and returns
// { fields } with cleaned values, or { error } (message safe to show the user).
// reservedNames: column names the server fills itself; the browser may not send them.
// opts.textCells: see sheetCell_ (use with appendRecord_'s opts.textCells).
function cleanRecordFields_(raw, reservedNames, opts) {
  var reserved = {};
  (reservedNames || []).forEach(function(n) { reserved[String(n).trim().toLowerCase()] = true; });
  var input = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
  var keys = Object.keys(input);
  if (keys.length === 0) return { error: 'No fields were submitted.' };
  if (keys.length > MAX_RECORD_FIELDS) return { error: 'Too many fields.' };
  var fields = {}, seen = {};
  for (var i = 0; i < keys.length; i++) {
    var key = keys[i];
    if (key.length > COLUMN_NAME_MAX || key !== key.trim() || !COLUMN_NAME_PATTERN.test(key)) {
      return { error: 'Invalid field name: "' + key.substring(0, 40) + '".' };
    }
    var lower = key.toLowerCase();
    if (reserved[lower]) return { error: 'Field name "' + key + '" is reserved.' };
    if (seen[lower]) return { error: 'Duplicate field name "' + key + '".' };
    seen[lower] = true;
    var v = input[key];
    if (Array.isArray(v)) v = v.join(', ');
    else if (v !== null && typeof v === 'object') v = JSON.stringify(v);
    fields[key] = sheetCell_(v, 0, opts && opts.textCells);
  }
  return { fields: fields };
}

// Pure planning step (no sheet access). Column order for a new sheet is
// before, then fields, then after. Returns { required, values, added } where
// `values` is keyed by lower-cased header, or { error } if the sheet would exceed
// MAX_SHEET_COLUMNS. Header names match case-insensitively, as in ensureSheetHeaders_.
function planRecord_(existingHeaders, fields, before, after, opts) {
  var values = {}, required = [];
  [before, fields, after].forEach(function(group) {
    Object.keys(group || {}).forEach(function(name) {
      var lower = String(name).trim().toLowerCase();
      if (Object.prototype.hasOwnProperty.call(values, lower)) throw new Error('Duplicate column "' + name + '".');
      values[lower] = sheetCell_(group[name], 0, opts && opts.textCells);
      required.push(name);
    });
  });
  var have = {};
  existingHeaders.forEach(function(h) { have[String(h).trim().toLowerCase()] = true; });
  var added = required.filter(function(n) { return !have[String(n).trim().toLowerCase()]; });
  if (existingHeaders.length + added.length > MAX_SHEET_COLUMNS) {
    return { error: 'That sheet already has too many columns.' };
  }
  return { required: required, values: values, added: added };
}

// Appends one row, adding any headers the sheet doesn't have yet (logged via logEvent_).
// `fields` must come from cleanRecordFields_. Returns { added } or { error }.
// opts.textCells: store every cell as plain text, so Sheets doesn't turn "Nov 14-16" or
// "$25" into a date or number (pass the same option to cleanRecordFields_).
// Callers should hold the script lock around this.
function appendRecord_(sheet, fields, before, after, opts) {
  var plan = planRecord_(getSheetHeaders_(sheet), fields, before, after, opts);
  if (plan.error) return plan;
  var headers = ensureSheetHeaders_(sheet, plan.required);
  var row = headers.map(function(h) {
    var key = String(h).trim().toLowerCase();
    return Object.prototype.hasOwnProperty.call(plan.values, key) ? plan.values[key] : '';
  });
  if (opts && opts.textCells) {
    sheet.getRange(sheet.getLastRow() + 1, 1, 1, row.length).setNumberFormat('@').setValues([row]);
  } else {
    sheet.appendRow(row);
  }
  if (plan.added.length) logEvent_('columns added', sheet.getName() + ': ' + plan.added.join(', '));
  return { added: plan.added };
}
