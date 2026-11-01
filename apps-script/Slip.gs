// Per-request abuse limits. These only FLAG or trim; they never reject a submission,
// and there is deliberately NO global rate limit (a burst of real parents must not be dropped).
var MAX_FIELD_LENGTH = 1000;
var MAX_KEY_LENGTH = 80;
var MAX_FIELDS = 80;
var MAX_PAYLOAD_CHARS = 60000;
var HONEYPOT_FIELD = 'website_url';

// Version label of the legal wording on the form (slip.html). Bump it (e.g. a date) whenever
// the waiver, e-signature or other agreement text changes, and tag that commit in git, so every
// response row can be matched to the exact text it was signed under.
var FORM_VERSION = '2026-10-26';

// ---------------------------------------------------------------------------
// PERMISSION SLIP (slip.html): trip config, submissions, and saved
// parent/youth profiles, all for signed-in users. Routed from doPost in Code.gs.
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
  // PROFILE ROUTES: the user ID comes ONLY from a verified Google ID token.
  // Any googleUserId sent by the client is ignored.
  if (data.action === 'getProfile') {
    var readerId = verifyGoogleToken_(data.idToken);
    if (!readerId) return jsonOut_({ error: 'unauthorized' });
    return jsonOut_(getUserProfile(readerId) || {});
  }

  if (data.action === 'saveProfile') {
    var writerId = verifyGoogleToken_(data.idToken);
    if (!writerId) { logEvent_('saveProfile unauthorized', tokenFailReason_); return jsonOut_({ status: 'error', message: 'unauthorized' }); }
    saveProfileAndYouth_(writerId, sanitizeFields_(data.profileData || {}, []));
    logEvent_('saveProfile ok', 'fields=' + Object.keys(data.profileData || {}).length);
    return jsonOut_({ status: 'success' });
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
  var submittedIdToken = data._idToken;
  if (raw.length > MAX_PAYLOAD_CHARS) flags.push('Oversized payload');
  var honeypotFilled = !!(data[HONEYPOT_FIELD] && String(data[HONEYPOT_FIELD]).trim() !== '');
  if (honeypotFilled) flags.push('Honeypot filled');

  var slipSnapshot = data._slipSnapshot; // read before sanitizeFields_ drops '_' keys
  var submittedTripId = data._tripId;
  data = sanitizeFields_(data, flags);

  var isAdult = String(data['Form Type']).toLowerCase() === 'adult';
  if (!(isAdult ? data['Adult Name'] : data['Youth Name'])) flags.push('Missing name');
  if (isAdult ? !data['Adult Signature'] : (!data['Parent Signature'] || !data['Youth Signature'])) flags.push('Missing signature');

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

  var sheet = ss.getSheetByName('Responses') || ss.getSheets()[1];

  var lastCol = sheet.getLastColumn();
  var headers = [];

  // 1. Read existing exact headers from Row 1
  if (sheet.getLastRow() > 0 && lastCol > 0) {
    headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(function(h) {
      return h.toString().trim();
    });
  }

  // 2. Ensure "Timestamp" is in Column 1
  if (headers.length === 0 || headers[0] === "") {
    headers = ["Timestamp"];
    sheet.getRange(1, 1, 1, 1).setValues([headers]).setFontWeight("bold");
  }

  // 3. Map exact header strings to column array indexes
  var headerMap = {};
  headers.forEach(function(h, idx) {
    if (h !== "") {
      headerMap[h] = idx;
    }
  });

  // 4. Add a column for any new incoming key
  Object.keys(data).forEach(function(key) {
    if (!(key in headerMap)) {
      var newColIdx = headers.length;
      sheet.getRange(1, newColIdx + 1).setValue(key).setFontWeight("bold");
      headers.push(key);
      headerMap[key] = newColIdx;
    }
  });

  // 5. Build row array matching header order exactly
  var rowData = headers.map(function(header) {
    if (header.toLowerCase() === "timestamp") return new Date();

    return (data[header] !== undefined && data[header] !== null)
      ? data[header]
      : "";
  });

  // 6. Append entry row
  sheet.appendRow(rowData);

  // 7. Save the signed-in parent's profile (never blocks the submission).
  if (!submittedIdToken) logEvent_('profile skipped', 'no _idToken in submission (not signed in, or old page cached)');
  if (submittedIdToken && !honeypotFilled) {
    try {
      var profileId = verifyGoogleToken_(submittedIdToken);
      if (!profileId) logEvent_('profile skipped: token rejected', tokenFailReason_);
      if (profileId) {
        var profileData = {};
        Object.keys(data).forEach(function(k) {
          if (k === 'Form Type' || k === 'tripId' || k === 'formVersion' || k === 'wordingHash' || k.toLowerCase().indexOf('signature') !== -1) return;
          profileData[k] = data[k];
        });
        saveProfileAndYouth_(profileId, profileData);
        logEvent_('profile saved', 'fields=' + Object.keys(profileData).length);
      }
    } catch (profErr) {
      console.error('Profile save failed: ' + profErr);
      logEvent_('profile save FAILED', profErr + ' | ' + (profErr && profErr.stack || ''));
    }
  }

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

// Fetch saved profiles by verified user email (checking Authorized Emails)
function getUserProfile(userEmail) {
  try {
    var ss = getSpreadsheet_('trips');
    var sheet = ss.getSheetByName('Profiles');
    if (!sheet || sheet.getLastRow() < 2) return null;
    var values = sheet.getDataRange().getDisplayValues();
    var headers = values[0].map(function(h) { return h.toString().trim(); });
    var col = function(row, name) { var i = headers.indexOf(name); return i === -1 ? '' : row[i]; };
    var emailLower = String(userEmail || '').trim().toLowerCase();
    var youth = [];
    for (var i = 1; i < values.length; i++) {
      var r = values[i];
      var authEmails = String(col(r, 'Authorized Emails') || '').toLowerCase().split(',').map(function(e) { return e.trim(); });
      if (authEmails.indexOf(emailLower) !== -1 || authEmails.indexOf('*') !== -1) {
        youth.push({
          'Youth Name': col(r, 'Scout Name'),
          'Birth Month': col(r, 'Birth Month'),
          'Home Patrol': col(r, 'Home Patrol'),
          'Authorized Emails': col(r, 'Authorized Emails'),
          'Youth Emergency Phone': col(r, 'Emergency Phone'),
          'Youth Home Phone': col(r, 'Emergency Phone 2'),
          'Medical Notes': col(r, 'Medical Notes')
        });
      }
    }
    return youth.length ? { youthProfiles: youth } : null;
  } catch (err) {
    console.error("Error fetching profile: " + err);
    return null;
  }
}

function saveProfileAndYouth_(writerEmail, profileData) {
  var ss = getSpreadsheet_('trips');
  var sheet = ss.getSheetByName('Profiles') || ss.insertSheet('Profiles');
  var scoutName = String(profileData['Youth Name'] || profileData['Scout Name'] || '').trim();
  if (!scoutName) return;

  var headers = ['Scout Name', 'Birth Month', 'Home Patrol', 'Authorized Emails', 'Emergency Phone', 'Emergency Phone 2', 'Medical Notes'];
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(headers);
    sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold');
  }

  var values = sheet.getDataRange().getDisplayValues();
  var sheetHeaders = values[0].map(function(h) { return h.toString().trim(); });
  var nameCol = sheetHeaders.indexOf('Scout Name');
  var authCol = sheetHeaders.indexOf('Authorized Emails');
  var targetRow = -1;

  for (var i = 1; i < values.length; i++) {
    if (String(values[i][nameCol]).trim().toLowerCase() === scoutName.toLowerCase()) {
      targetRow = i + 1;
      break;
    }
  }

  var existingAuth = targetRow !== -1 ? String(values[targetRow - 1][authCol] || '') : writerEmail;
  var authEmailsList = existingAuth.split(',').map(function(e) { return e.trim(); }).filter(Boolean);
  if (writerEmail && authEmailsList.map(function(e) { return e.toLowerCase(); }).indexOf(writerEmail.toLowerCase()) === -1) {
    authEmailsList.push(writerEmail);
  }
  var extraAuth = String(profileData['Authorized Emails'] || '').split(',').map(function(e) { return e.trim(); }).filter(Boolean);
  extraAuth.forEach(function(e) {
    if (authEmailsList.map(function(item) { return item.toLowerCase(); }).indexOf(e.toLowerCase()) === -1) {
      authEmailsList.push(e);
    }
  });

  var row = [
    scoutName,
    String(profileData['Birth Month'] || (targetRow !== -1 ? values[targetRow - 1][sheetHeaders.indexOf('Birth Month')] : '')).trim(),
    String(profileData['Home Patrol'] || (targetRow !== -1 ? values[targetRow - 1][sheetHeaders.indexOf('Home Patrol')] : '')).trim(),
    authEmailsList.join(', '),
    String(profileData['Youth Emergency Phone'] || profileData['Emergency Phone'] || '').trim(),
    String(profileData['Youth Home Phone'] || profileData['Emergency Phone 2'] || '').trim(),
    String(profileData['Medical Notes'] || '').trim()
  ];

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    if (targetRow !== -1) {
      sheet.getRange(targetRow, 1, 1, row.length).setValues([row]);
    } else {
      sheet.appendRow(row);
    }
  } finally {
    lock.releaseLock();
  }
}
