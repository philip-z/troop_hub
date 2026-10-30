// ---------------------------------------------------------------------------
// LEADERS: add a new trip to the Trips sheet, and the per-leader permissions that
// also gate the hub's payment and reimbursement tools (see getLeaderPermissions_).
// Access = a valid sign-in whose verified email is listed on the sheet tab named
// "Leaders" with the needed permission. Everything is enforced here on the server;
// the add-trip.html page itself is public.
// ---------------------------------------------------------------------------

// Must match the Trips sheet headers. The slip page shows every Trips column to any
// signed-in user, so NEVER add private columns (like who added a trip) to that sheet.
var TRIP_COLUMNS = ['tripId', 'tripTitle', 'tripLocation', 'tripDates', 'departureDetails',
                    'returnDetails', 'tripCost', 'tripCoordinator', 'tripUniform',
                    'customDepartureHtml', 'acceptingResponses', 'acceptingReceipts'];
var TRIP_REQUIRED = ['tripTitle', 'tripLocation', 'tripDates'];
var TRIP_FIELD_MAX = 500;
var MAX_DEPARTURE_OPTIONS = 20;
var DEPARTURE_OPTION_MAX = 100;

// Returns { sub, email, emailVerified } for a valid token minted for our client, else null.
function verifyGoogleTokenInfo_(idToken) {
  if (!idToken || typeof idToken !== 'string') return null;
  if (isSessionToken_(idToken)) return verifySessionToken_(idToken);
  try {
    var cache = CacheService.getScriptCache();
    var key = 'tokinfo_' + Utilities.base64EncodeWebSafe(
      Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, idToken));
    var hit = cache.get(key);
    if (hit) return JSON.parse(hit);

    var res = UrlFetchApp.fetch(
      'https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(idToken),
      { muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) return null;

    var info = JSON.parse(res.getContentText());
    if (getAllowedClientIds_().indexOf(info.aud) === -1) return null;
    if (Number(info.exp) * 1000 < Date.now()) return null;
    if (!info.sub) return null;

    var out = {
      sub: String(info.sub),
      email: String(info.email || '').trim().toLowerCase(),
      emailVerified: String(info.email_verified) === 'true',
      name: String(info.name || '')
    };
    cache.put(key, JSON.stringify(out), 300);
    return out;
  } catch (err) {
    console.error('Token info verification failed: ' + err);
    return null;
  }
}

// Leaders sheet: row 1 headers `email`, `addTrips`, `recordPayments`, `recordReimbursements`;
// one leader per row, a permission is on when its cell is TRUE (checkbox) / yes / 1.
// Legacy sheet with no permission columns (just emails in column A): every listed
// leader keeps all permissions. Once any permission column exists, a missing column
// or blank cell means "no".
var LEADER_PERMISSIONS = ['addTrips', 'recordPayments', 'recordReimbursements'];

// Returns { addTrips, recordPayments, recordReimbursements } (booleans) for a listed
// email, or null when the email is not on the Leaders sheet.
function getLeaderPermissions_(email) {
  if (!email) return null;
  var sheet = getSpreadsheet_('trips').getSheetByName('Leaders');
  if (!sheet || sheet.getLastRow() < 1 || sheet.getLastColumn() < 1) return null;
  var values = sheet.getRange(1, 1, sheet.getLastRow(), sheet.getLastColumn()).getValues();
  var hasHeader = String(values[0][0]).trim().toLowerCase() === 'email';
  var cols = {};
  if (hasHeader) {
    values[0].forEach(function(h, j) {
      var name = String(h).trim();
      if (LEADER_PERMISSIONS.indexOf(name) !== -1) cols[name] = j;
    });
  }
  var legacy = Object.keys(cols).length === 0;
  for (var i = hasHeader ? 1 : 0; i < values.length; i++) {
    if (String(values[i][0]).trim().toLowerCase() !== email) continue;
    var perms = {};
    LEADER_PERMISSIONS.forEach(function(p) {
      perms[p] = legacy || (cols[p] !== undefined && isTruthy_(values[i][cols[p]]));
    });
    return perms;
  }
  return null;
}

// True when the email is listed and holds the named permission.
function hasLeaderPermission_(email, permission) {
  var perms = getLeaderPermissions_(email);
  return !!(perms && perms[permission]);
}

function cleanTripText_(v) {
  return String(v === undefined || v === null ? '' : v).replace(/\s+/g, ' ').trim().substring(0, TRIP_FIELD_MAX);
}

// Builds the customDepartureHtml cell from plain text. Every value is escaped, so
// leaders never paste raw HTML. The slip page replaces the departure span's
// contents with this, so it also carries the departure details text.
function buildDepartureHtml_(departureDetails, options) {
  if (!options.length) return '';
  var opts = options.map(function(o) {
    return '<option value="' + escapeHtml_(o) + '">' + escapeHtml_(o) + '</option>';
  }).join('');
  return escapeHtml_(departureDetails) +
    '<br><label for="departureOption"><strong>Departure option:</strong></label> ' +
    '<select id="departureOption" name="Departure Option" required>' +
    '<option value="">-- Choose one --</option>' + opts + '</select><br>';
}

function unescapeHtml_(s) {
  return String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
}

// Reverses buildDepartureHtml_: the departure options, one per line.
function parseDepartureOptions_(html) {
  var out = [], re = /<option value="([^"]+)">/g, m;
  while ((m = re.exec(String(html || ''))) !== null) out.push(unescapeHtml_(m[1]));
  return out.join('\n');
}

// Past trips a leader can copy into the add-trip form (newest first). Dates, month and
// the accepting flags are deliberately not copied.
function listTripTemplates_(data) {
  var info = verifyGoogleTokenInfo_(data.idToken);
  if (!info) return { status: 'error', code: 'signin', message: 'Your sign-in has expired or is invalid. Please sign in again.' };
  if (!info.emailVerified || !hasLeaderPermission_(info.email, 'addTrips')) {
    return { status: 'error', code: 'not_allowed', message: 'Your account (' + info.email + ') is not allowed to add trips.' };
  }
  var sheet = getSpreadsheet_('trips').getSheetByName('Trips');
  if (!sheet || sheet.getLastRow() < 2) return { status: 'success', trips: [] };
  var values = sheet.getDataRange().getDisplayValues();
  var headers = values[0].map(function(h) { return h.toString().trim(); });
  var col = function(row, name) { var i = headers.indexOf(name); return i === -1 ? '' : row[i]; };
  var trips = values.slice(1)
    .filter(function(r) { return String(col(r, 'tripId')).trim() !== ''; })
    .map(function(r) {
      return {
        id: col(r, 'tripId'), tripTitle: col(r, 'tripTitle'), tripDates: col(r, 'tripDates'),
        tripLocation: col(r, 'tripLocation'), departureDetails: col(r, 'departureDetails'),
        departureOptions: parseDepartureOptions_(col(r, 'customDepartureHtml')),
        returnDetails: col(r, 'returnDetails'), tripCost: col(r, 'tripCost'),
        tripCoordinator: col(r, 'tripCoordinator'), tripUniform: col(r, 'tripUniform')
      };
    })
    .sort(function(a, b) { return a.id < b.id ? 1 : a.id > b.id ? -1 : 0; });
  return { status: 'success', trips: trips };
}

function addTrip_(data) {
  var info = verifyGoogleTokenInfo_(data.idToken);
  if (!info) return { status: 'error', code: 'signin', message: 'Your sign-in has expired or is invalid. Please sign in again.' };
  if (!info.emailVerified || !hasLeaderPermission_(info.email, 'addTrips')) {
    return { status: 'error', code: 'not_allowed', message: 'Your account (' + info.email + ') is not allowed to add trips. Ask a leader to tick addTrips for you on the Leaders sheet.' };
  }

  var trip = {};
  TRIP_COLUMNS.forEach(function(c) { trip[c] = cleanTripText_(data[c]); });
  var missing = TRIP_REQUIRED.filter(function(c) { return !trip[c]; });
  if (missing.length) return { status: 'error', code: 'invalid', message: 'Missing required field(s): ' + missing.join(', ') };

  var options = String(data.departureOptions || '').split(/\r?\n/)
    .map(function(s) { return s.replace(/\s+/g, ' ').trim().substring(0, DEPARTURE_OPTION_MAX); })
    .filter(function(s) { return s !== ''; })
    .slice(0, MAX_DEPARTURE_OPTIONS);
  // Raw HTML from the client is ignored; it is always generated here.
  trip.customDepartureHtml = buildDepartureHtml_(trip.departureDetails, options);
  // Server-controlled: the ID is generated under the lock below and the flags come from checkboxes.
  var month = String(data.tripMonth || '').trim();
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return { status: 'error', code: 'invalid', message: 'Choose the trip month.' };
  trip.acceptingResponses = isTruthy_(data.acceptingResponses) ? 'TRUE' : 'FALSE';
  trip.acceptingReceipts = isTruthy_(data.acceptingReceipts) ? 'TRUE' : 'FALSE';

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var ss = getSpreadsheet_('trips');
    var sheet = ss.getSheetByName('Trips');
    if (!sheet) return { status: 'error', code: 'config', message: 'Trips sheet is missing.' };

    var lastCol = Math.max(sheet.getLastColumn(), 1);
    var headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(function(h) { return h.toString().trim(); });
    TRIP_COLUMNS.forEach(function(c) {
      if (headers.indexOf(c) === -1) {
        sheet.getRange(1, headers.length + 1).setValue(c).setFontWeight('bold');
        headers.push(c);
      }
    });

    var idCol = headers.indexOf('tripId');
    var existingIds = sheet.getLastRow() < 2 ? [] :
      sheet.getRange(2, idCol + 1, sheet.getLastRow() - 1, 1).getValues().map(function(r) { return String(r[0]).trim(); });
    trip.tripId = nextTripId_(month, existingIds);
    if (!trip.tripId) return { status: 'error', code: 'invalid', message: 'That month already has 99 trips.' };

    var row = headers.map(function(h) { return trip[h] !== undefined ? trip[h] : ''; });
    var targetRow = sheet.getLastRow() + 1;
    // Plain text, so Sheets doesn't turn "Nov 14-16" or "$25" into dates/numbers.
    sheet.getRange(targetRow, 1, 1, row.length).setNumberFormat('@').setValues([row]);

    // Who added it goes in a private log tab, never in Trips (doGet publishes Trips).
    var log = ss.getSheetByName('Trip Log') || ss.insertSheet('Trip Log');
    if (log.getLastRow() === 0) log.appendRow(['Timestamp', 'Added By', 'Trip Title', 'Trip Dates']);
    log.appendRow([new Date(), info.email, trip.tripTitle, trip.tripDates]);
  } finally {
    lock.releaseLock();
  }
  return { status: 'success', tripId: trip.tripId };
}
