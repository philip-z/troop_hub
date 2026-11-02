// Per-request abuse limits. These only FLAG or trim; they never reject a submission,
// and there is deliberately NO global rate limit (a burst of real parents must not be dropped).
var MAX_FIELD_LENGTH = 1000;
var MAX_KEY_LENGTH = 80;
var MAX_FIELDS = 80;
var MAX_PAYLOAD_CHARS = 60000;
var HONEYPOT_FIELD = 'website_url';

// The slip form columns this script acts on (everything else in a submission or a saved
// profile is whatever the inputs in slip.html are named). The keys are the lower-cased
// values of the `Form Type` select and of the `kind` slip.js sends with a profile.
//   nameColumn        the input that names the person: checked on submit, and it
//                     identifies the profile row
//   signatureColumns  all must be filled, or the response is flagged
//   profileTab        where that kind's saved profiles live (one row per person)
var SLIP_FORM_TYPE_COLUMN = 'Form Type';
var SLIP_KINDS = {
  youth: { nameColumn: 'Youth Name', signatureColumns: ['Parent Signature', 'Youth Signature'], profileTab: 'Youth Profiles' },
  adult: { nameColumn: 'Adult Name', signatureColumns: ['Adult Signature'], profileTab: 'Adult Profiles' }
};
// Profile column listing who may read and update a row: comma-separated emails. The script
// adds the signed-in writer; a leader can put * in the sheet to share a row with everyone
// (the browser can never set it).
var PROFILE_AUTH_COLUMN = 'Authorized Emails';
var PROFILE_EMAIL_PATTERN = /^[^\s@,;<>"']+@[^\s@,;<>"']+\.[^\s@,;<>"']+$/;

// Version label of the legal wording on the form (slip.html). Bump it (e.g. a date) whenever
// the waiver, e-signature or other agreement text changes, and tag that commit in git, so every
// response row can be matched to the exact text it was signed under.
var FORM_VERSION = '2026-10-26';

// ---------------------------------------------------------------------------
// PERMISSION SLIP (slip.html): trip config, submissions, and saved
// youth/adult profiles, all for signed-in users. Routed from doPost in Code.gs.
// A saved profile is the set of inputs marked data-profile in slip.html: slip.js sends
// them in a saveProfile call, and each person's row is keyed by SLIP_KINDS[kind].nameColumn.
// ---------------------------------------------------------------------------

// Trip configuration for one trip (signed-in users only), or an error object when the
// trip is unknown or closed to responses. Includes _tripRevision (see Trips.gs).
function permissionTripConfig_(tripId) {
  var ss = getSpreadsheet_('trips');
  var trip = getTripConfig_(ss, tripId);
  if (!trip) return { status: 'error', code: 'not_found', message: 'Trip not found.' };
  if (!isTruthy_(trip.acceptingResponses)) return { status: 'error', code: 'closed', message: 'This trip is not accepting permission slips.' };
  return trip;
}

// Handles profile actions and slip submissions. Anything that isn't a
// getProfile/saveProfile action is treated as a slip submission.
function handlePermissionPost_(raw, data) {
  // PROFILE ROUTES: the identity is the verified email from the sign-in token, never
  // anything the client sends.
  if (data.action === 'getProfile') {
    var reader = profileUser_(data.idToken);
    if (!reader) return jsonOut_({ error: 'unauthorized' });
    return jsonOut_({ status: 'success', profiles: getUserProfiles_(reader.email) });
  }

  if (data.action === 'saveProfile') {
    var writer = profileUser_(data.idToken);
    if (!writer) { logEvent_('saveProfile unauthorized', 'no verified email'); return jsonOut_({ status: 'error', message: 'unauthorized' }); }
    var saved = saveProfile_(data.kind, writer.email, data.profileData);
    logEvent_('saveProfile ' + (saved.status === 'success' ? 'ok' : 'rejected'), data.kind + ' fields=' + Object.keys(data.profileData || {}).length + (saved.message ? ' ' + saved.message : ''));
    return jsonOut_(saved);
  }

  if (data.action === 'slipTrip') {
    if (!verifyGoogleToken_(data.idToken)) return jsonOut_({ status: 'error', code: 'signin', message: 'Please sign in to view this trip.' });
    return jsonOut_(permissionTripConfig_(data.tripId));
  }

  // SUBMISSION (sign-in required, same as viewing the trip).
  if (!verifyGoogleToken_(data._idToken)) {
    return jsonOut_({ status: 'error', code: 'signin', message: 'Your sign-in has expired. Please sign in again; your entries are still on the form.' });
  }
  // Soft anti-spam: trim and flag, never reject.
  var flags = [];
  var submittedTripRevision = data._tripRevision;
  if (raw.length > MAX_PAYLOAD_CHARS) flags.push('Oversized payload');
  var honeypotFilled = !!(data[HONEYPOT_FIELD] && String(data[HONEYPOT_FIELD]).trim() !== '');
  if (honeypotFilled) flags.push('Honeypot filled');

  var slipSnapshot = data._slipSnapshot; // read before sanitizeFields_ drops '_' keys
  var submittedTripId = data._tripId;
  data = sanitizeFields_(data, flags);

  var slipKind = SLIP_KINDS[String(data[SLIP_FORM_TYPE_COLUMN]).toLowerCase()] || SLIP_KINDS.youth;
  if (!data[slipKind.nameColumn]) flags.push('Missing name');
  if (!slipKind.signatureColumns.every(function(c) { return !!data[c]; })) flags.push('Missing signature');

  var ss = getSpreadsheet_('trips');
  var trip = getTripConfig_(ss, submittedTripId);
  if (!trip) return jsonOut_({ status: 'error', code: 'not_found', message: 'Trip not found.' });
  if (!isTruthy_(trip.acceptingResponses)) {
    return jsonOut_({ status: 'error', code: 'closed', message: 'This trip is no longer accepting permission slips.' });
  }
  if (!submittedTripRevision || submittedTripRevision !== trip._tripRevision) {
    return jsonOut_({
      status: 'error',
      code: 'trip_changed',
      message: 'Trip details have changed. Reload the page, review the updated trip details, and sign again.'
    });
  }

  // Always overwrite server-controlled columns so a client can't spoof them.
  data['tripId'] = displayValue_(trip.tripId); // always from the Trips sheet, never the browser
  data['formVersion'] = FORM_VERSION;
  data['wordingHash'] = wordingHash_(slipSnapshot);
  if (!data['wordingHash']) flags.push('No wording hash');
  data['Flags'] = flags.join('; ');

  var sheet = getOrCreateSheet_(ss, 'Responses', true);

  // Ensure "Timestamp" and all incoming field keys exist in row 1
  var incomingKeys = Object.keys(data);
  var headers = ensureSheetHeaders_(sheet, ['Timestamp'].concat(incomingKeys));

  var headerMap = {};
  headers.forEach(function(h, idx) { headerMap[h.toLowerCase()] = idx; });

  var rowData = headers.map(function(header) {
    if (header.toLowerCase() === 'timestamp') return new Date();
    var val = data[header];
    return (val !== undefined && val !== null) ? val : '';
  });

  sheet.appendRow(rowData);

  // Saved profiles are not derived from the submission: slip.js sends the inputs marked
  // data-profile in a separate saveProfile call, so a one-off question never lands in one.
  return jsonOut_({ status: "success" });
}

// Returns a cleaned copy: drops internal/server-controlled keys, caps key count and
// value length (flagging when it trims), and flattens arrays/objects to strings.
function sanitizeFields_(input, flags) {
  var blocked = { 'action': true, 'idToken': true, 'googleUserId': true,
                  'Flags': true, 'PDF Link': true, 'tripId': true, 'formVersion': true, 'wordingHash': true };
  blocked[HONEYPOT_FIELD] = true;

  var clean = {};
  var count = 0;
  Object.keys(input || {}).forEach(function(key) {
    if (key.charAt(0) === '_' || blocked[key] || key.length > MAX_KEY_LENGTH) return;
    if (count >= MAX_FIELDS) {
      if (flags.indexOf('Too many fields') === -1) flags.push('Too many fields');
      return;
    }
    var v = input[key];
    if (v === undefined || v === null) v = '';
    if (Array.isArray(v)) v = v.join(', ');
    else if (typeof v === 'object') v = JSON.stringify(v);
    else v = String(v);
    if (v.length > MAX_FIELD_LENGTH) {
      v = v.substring(0, MAX_FIELD_LENGTH);
      if (flags.indexOf('Field trimmed') === -1) flags.push('Field trimmed');
    }
    clean[key] = v;
    count++;
  });
  return clean;
}

function displayValue_(v) {
  if (v instanceof Date) {
    return Utilities.formatDate(v, Session.getScriptTimeZone(), 'MMM d, yyyy');
  }
  return v === undefined || v === null ? '' : String(v);
}

// Validates the client's snapshot of the page the signer saw, and returns a SHA-256 hash of
// its WORDING only (all fixed text, labels and trip details; not what was typed or which
// radio was ticked). Rows with the same hash were shown identical text. Returns '' if the
// snapshot is missing or malformed.
function wordingHash_(raw) {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 400) return '';
  var lines = [];
  for (var i = 0; i < raw.length; i++) {
    var line = raw[i];
    if (!line || !Array.isArray(line.segs) || line.segs.length > 60) return '';
    var text = '';
    for (var j = 0; j < line.segs.length; j++) {
      var sg = line.segs[j];
      if (!sg || typeof sg.s !== 'string') return '';
      if (sg.v) { text += '\u0001'; continue; } // typed value: marks the blank, not its content
      text += sg.s.substring(0, 2000).replace(/^\[[X ]\] $/, '[ ] '); // radios: ignore selection
    }
    lines.push((Number(line.h) || 0) + ':' + text);
  }
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, lines.join('\n'), Utilities.Charset.UTF_8)
    .map(function(b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join('');
}

// ---------------------------------------------------------------------------
// SAVED PROFILES: one row per person on the tab SLIP_KINDS[kind].profileTab. The columns
// are the `name`s of the slip.html inputs marked data-profile (the sheet gets a column the
// first time it sees one), plus PROFILE_AUTH_COLUMN. A row is readable and updatable only
// by the emails listed in it (or everyone, if a leader put * there). Saving under a name
// that someone else's row already uses creates a separate row, so typing another
// family's scout name can never expose or overwrite their profile.
// A column whose header starts with an underscore is never sent to the browser (see
// tableRows_), so leaders can keep their own notes on the sheet.
// ---------------------------------------------------------------------------

// The verified { email, ... } for a sign-in token, or null. Email sign-ins and Google
// sign-ins both end up as a verified email (see Auth.gs).
function profileUser_(idToken) {
  var info = verifyGoogleTokenInfo_(idToken);
  return info && info.emailVerified && info.email ? info : null;
}

function normalizeName_(s) {
  return String(s === undefined || s === null ? '' : s).replace(/\s+/g, ' ').trim().toLowerCase();
}

// True when `email` is in the comma-separated list, or the list contains *.
function isAuthorized_(authValue, email) {
  var want = String(email || '').trim().toLowerCase();
  if (!want) return false;
  return String(authValue || '').toLowerCase().split(',').some(function(e) {
    e = e.trim();
    return e === '*' || e === want;
  });
}

function lowerIndexOf_(list, name) {
  return list.map(function(h) { return String(h).trim().toLowerCase(); }).indexOf(String(name).trim().toLowerCase());
}

// Pure. Works out one profile save against the sheet's current contents.
//   grid     the tab's display values, header row first ([] for an empty tab)
//   spec     a SLIP_KINDS entry
//   fields   the cleaned fields from the browser (cleanRecordFields_)
// Returns { error } or { required (header names to ensure, in order), headers (the headers
// once ensured), row (the cells to write, matching headers), rowIndex (index in grid of the
// row to update, or -1 to append) }.
function planProfileSave_(grid, spec, writerEmail, fields) {
  var byLower = {};
  Object.keys(fields).forEach(function(k) { byLower[k.toLowerCase()] = fields[k]; });
  var name = String(byLower[spec.nameColumn.toLowerCase()] || '').replace(/\s+/g, ' ').trim();
  if (!name) return { error: 'Enter a name before saving a profile.' };

  var existing = grid && grid.length ? grid[0].map(function(h) { return String(h).trim(); }) : [];
  // The name and authorization columns first, then the form's fields (each header once).
  var required = [];
  [spec.nameColumn, PROFILE_AUTH_COLUMN].concat(Object.keys(fields)).forEach(function(r) {
    if (lowerIndexOf_(required, r) === -1) required.push(r);
  });
  var headers = existing.slice();
  required.forEach(function(r) {
    if (lowerIndexOf_(headers, r) === -1) headers.push(r);
  });
  if (headers.length > MAX_SHEET_COLUMNS) return { error: 'That profile sheet already has too many columns.' };

  var nameIdx = lowerIndexOf_(existing, spec.nameColumn);
  var authIdx = lowerIndexOf_(existing, PROFILE_AUTH_COLUMN);
  var rowIndex = -1;
  for (var i = 1; nameIdx !== -1 && authIdx !== -1 && grid && i < grid.length; i++) {
    if (normalizeName_(grid[i][nameIdx]) === name.toLowerCase() && isAuthorized_(grid[i][authIdx], writerEmail)) { rowIndex = i; break; }
  }
  var old = rowIndex === -1 ? [] : grid[rowIndex];

  var auth = authIdx !== -1 && rowIndex !== -1 ? String(old[authIdx] || '').split(',').map(function(e) { return e.trim(); }).filter(Boolean) : [];
  var extras = String(byLower[PROFILE_AUTH_COLUMN.toLowerCase()] || '').split(/[,;\s]+/).filter(function(e) {
    return e !== '*' && PROFILE_EMAIL_PATTERN.test(e);
  });
  [writerEmail].concat(extras).forEach(function(e) {
    if (e && lowerIndexOf_(auth, e) === -1) auth.push(e);
  });

  var row = headers.map(function(h, idx) {
    var key = h.toLowerCase();
    if (key === PROFILE_AUTH_COLUMN.toLowerCase()) return auth.join(', ');
    if (key === spec.nameColumn.toLowerCase()) return name;
    if (Object.prototype.hasOwnProperty.call(byLower, key)) return byLower[key];
    return old[idx] === undefined || old[idx] === null ? '' : sheetCell_(old[idx], 0, true);
  });
  return { required: required, headers: headers, row: row, rowIndex: rowIndex };
}

// Pure. The profile rows `email` may read, as objects keyed by header (see tableRows_).
function profileRowsFor_(grid, email) {
  if (!grid || grid.length < 2) return [];
  var authIdx = lowerIndexOf_(grid[0], PROFILE_AUTH_COLUMN);
  if (authIdx === -1) return [];
  var rows = [grid[0]].concat(grid.slice(1).filter(function(r) { return isAuthorized_(r[authIdx], email); }));
  return tableRows_(rows, MAX_SHEET_COLUMNS);
}

function sheetGrid_(sheet) {
  if (!sheet || sheet.getLastRow() < 1 || sheet.getLastColumn() < 1) return [];
  return sheet.getRange(1, 1, sheet.getLastRow(), sheet.getLastColumn()).getDisplayValues();
}

// { youth: [...], adult: [...] }: the saved profiles this email may use.
function getUserProfiles_(email) {
  var out = {};
  Object.keys(SLIP_KINDS).forEach(function(kind) {
    out[kind] = [];
    try {
      var sheet = getOrCreateSheet_(getSpreadsheet_('trips'), SLIP_KINDS[kind].profileTab, false);
      out[kind] = profileRowsFor_(sheetGrid_(sheet), email);
    } catch (e) {
      // no such tab yet: nothing saved
    }
  });
  return out;
}

// Saves (creates or updates) the writer's profile of this kind. Returns the response object.
function saveProfile_(kind, writerEmail, profileData) {
  var spec = Object.prototype.hasOwnProperty.call(SLIP_KINDS, String(kind)) ? SLIP_KINDS[String(kind)] : null;
  if (!spec) return { status: 'error', code: 'invalid', message: 'Unknown profile type.' };
  var clean = cleanRecordFields_(profileData, [], { textCells: true });
  if (clean.error) return { status: 'error', code: 'invalid', message: clean.error };

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var sheet = getOrCreateSheet_(getSpreadsheet_('trips'), spec.profileTab, true);
    var plan = planProfileSave_(sheetGrid_(sheet), spec, writerEmail, clean.fields);
    if (plan.error) return { status: 'error', code: 'invalid', message: plan.error };

    var before = getSheetHeaders_(sheet);
    ensureSheetHeaders_(sheet, plan.required);
    var added = plan.headers.filter(function(h) { return lowerIndexOf_(before, h) === -1; });
    if (added.length) logEvent_('columns added', sheet.getName() + ': ' + added.join(', '));

    var rowNumber = plan.rowIndex === -1 ? sheet.getLastRow() + 1 : plan.rowIndex + 1;
    sheet.getRange(rowNumber, 1, 1, plan.row.length).setNumberFormat('@').setValues([plan.row]);
  } finally {
    lock.releaseLock();
  }
  return { status: 'success' };
}

// ---------------------------------------------------------------------------
// FLOAT PLAN (float-plan.html): everyone who submitted a slip for one trip. Leaders with
// the manageTrips permission only, because rows include emergency phones and medical
// notes (hubFloatPlan in Hub.gs checks that). Columns are whatever the slip form submitted.
// ---------------------------------------------------------------------------

// Pure. The Responses rows for `tripId` as objects keyed by header (see tableRows_). Signature
// columns are left out (the float plan doesn't need them), and when someone submitted more
// than once for the trip, only their latest slip is kept, so headcounts aren't inflated.
function tripResponsesFrom_(grid, tripId) {
  if (!grid || grid.length < 2) return [];
  var headers = grid[0].map(function(h) { return String(h).trim(); });
  var idIdx = lowerIndexOf_(headers, 'tripId');
  if (idIdx === -1) return [];
  var keep = [];
  headers.forEach(function(h, i) { if (h.toLowerCase().indexOf('signature') === -1) keep.push(i); });
  var want = String(tripId === undefined || tripId === null ? '' : tripId).trim();
  var rows = [keep.map(function(i) { return headers[i]; })];
  grid.slice(1).forEach(function(r) {
    if (String(r[idIdx]).trim() === want) rows.push(keep.map(function(i) { return r[i]; }));
  });
  var items = tableRows_(rows, 200);

  var seen = {}, latest = [];
  for (var i = items.length - 1; i >= 0; i--) {
    var type = String(items[i][SLIP_FORM_TYPE_COLUMN] || '').toLowerCase();
    var spec = SLIP_KINDS[type] || SLIP_KINDS.youth;
    var name = normalizeName_(items[i][spec.nameColumn]);
    var key = name ? (SLIP_KINDS[type] ? type : 'youth') + '|' + name : '#' + i;
    if (seen[key]) continue;
    seen[key] = true;
    latest.push(items[i]);
  }
  return latest.reverse();
}

function tripResponses_(tripId) {
  var sheet;
  try {
    sheet = getOrCreateSheet_(getSpreadsheet_('trips'), 'Responses', false);
  } catch (e) {
    return [];
  }
  return tripResponsesFrom_(sheetGrid_(sheet), tripId);
}
