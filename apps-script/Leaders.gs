// ---------------------------------------------------------------------------
// LEADERS: add a new trip to the Trips sheet, and the per-leader permissions that
// also gate the hub's payment and reimbursement tools (see getLeaderPermissions_).
// Access = a valid sign-in whose verified email is listed on the sheet tab named
// "Leaders" with the needed permission. Everything is enforced here on the server;
// the add-trip.html page itself is public.
// ---------------------------------------------------------------------------

// The Trips columns are the `name`s of the inputs in add-trip.html (see appendRecord_ in
// Sheets.gs), so a new trip detail needs only a new input there (and a span with the same
// id in slip.html to show it). The slip page shows every Trips column to any signed-in
// user, so NEVER add private columns (like who added a trip) to that sheet.
// Which fields are required is the form's job (`required` attributes); leaders are the
// only ones who can submit it.
//
// The exceptions, because this script does something with them:
//   TRIP_SERVER_COLUMNS  filled here, so the browser may not send them: the generated
//                        tripId, customDepartureHtml (built from departureDetails and
//                        the departureOptions input) and the two accepting flags.
//   TRIP_FORM_ONLY       inputs that are read here but are not columns themselves.
//   departureDetails     feeds customDepartureHtml; tripTitle and tripDates go in Trip Log.
var TRIP_SERVER_COLUMNS = ['tripId', 'customDepartureHtml', 'acceptingResponses', 'acceptingReceipts'];
var TRIP_FORM_ONLY = ['tripMonth', 'departureOptions', 'acceptingResponses', 'acceptingReceipts'];
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
  var sheet;
  try {
    sheet = getOrCreateSheet_(getSpreadsheet_('trips'), 'Leaders', false);
  } catch (e) {
    return null;
  }
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
  return { status: 'success', trips: tripTemplates_() };
}

// One Trips row (object keyed by header) as a template for the add-trip form: every
// column, with the departure options as plain text in departureOptions (the form's
// textarea) instead of the generated customDepartureHtml. add-trip.html decides which
// inputs are copied (see data-no-copy there).
function tripTemplateFromRow_(row) {
  var t = {};
  Object.keys(row).forEach(function(k) { t[k] = row[k]; });
  t.departureOptions = parseDepartureOptions_(row.customDepartureHtml);
  delete t.customDepartureHtml;
  return t;
}

// No permission check here: callers must have verified addTrips already.
function tripTemplates_() {
  var sheet;
  try {
    sheet = getOrCreateSheet_(getSpreadsheet_('trips'), 'Trips', false);
  } catch (e) {
    return [];
  }
  if (!sheet || sheet.getLastRow() < 2) return [];
  var values = sheet.getDataRange().getDisplayValues();
  var headers = values[0].map(function(h) { return h.toString().trim(); });
  var col = createColumnGetter_(headers);
  return values.slice(1)
    .filter(function(r) { return String(col(r, 'tripId')).trim() !== ''; })
    .map(function(r) { return { id: String(col(r, 'tripId')), trip: tripTemplateFromRow_(tripRowObject_(headers, r)) }; })
    .sort(function(a, b) { return a.id < b.id ? 1 : a.id > b.id ? -1 : 0; })
    .map(function(p) { return p.trip; });
}

// Turns the add-trip form's values (input name -> value) into what gets written, or { error }.
// Returns { fields (the form's columns), month (YYYY-MM), after (the server-filled columns
// that go behind them) }. The caller adds the generated tripId. Pure: no sheet access.
function buildTripRecord_(input) {
  input = (input && typeof input === 'object' && !Array.isArray(input)) ? input : {};
  var month = String(input.tripMonth || '').trim();
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return { error: 'Choose the trip month.' };

  var options = String(input.departureOptions || '').split(/\r?\n/)
    .map(function(s) { return s.replace(/\s+/g, ' ').trim().substring(0, DEPARTURE_OPTION_MAX); })
    .filter(function(s) { return s !== ''; })
    .slice(0, MAX_DEPARTURE_OPTIONS);

  var raw = {};
  Object.keys(input).forEach(function(k) {
    if (TRIP_FORM_ONLY.indexOf(k) !== -1) return;
    raw[k] = typeof input[k] === 'string' ? cleanTripText_(input[k]) : input[k];
  });
  // Plain-text cells, so Sheets doesn't turn "Nov 14-16" or "$25" into dates/numbers.
  var clean = cleanRecordFields_(raw, TRIP_SERVER_COLUMNS, { textCells: true });
  if (clean.error) return { error: clean.error };

  // Raw HTML from the client is never accepted; it is always generated here.
  var after = {};
  after.customDepartureHtml = buildDepartureHtml_(clean.fields.departureDetails || '', options);
  after.acceptingResponses = isTruthy_(input.acceptingResponses) ? 'TRUE' : 'FALSE';
  after.acceptingReceipts = isTruthy_(input.acceptingReceipts) ? 'TRUE' : 'FALSE';
  return { fields: clean.fields, month: month, after: after };
}

function addTrip_(data) {
  var info = verifyGoogleTokenInfo_(data.idToken);
  if (!info) return { status: 'error', code: 'signin', message: 'Your sign-in has expired or is invalid. Please sign in again.' };
  if (!info.emailVerified || !hasLeaderPermission_(info.email, 'addTrips')) {
    return { status: 'error', code: 'not_allowed', message: 'Your account (' + info.email + ') is not allowed to add trips. Ask a leader to tick addTrips for you on the Leaders sheet.' };
  }

  // The form's values arrive as data.values (input name -> value).
  var rec = buildTripRecord_(data.values);
  if (rec.error) return { status: 'error', code: 'invalid', message: rec.error };

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var ss = getSpreadsheet_('trips');
    var sheet = getOrCreateSheet_(ss, 'Trips', false);

    // The ID is generated under the lock so two leaders can't get the same one.
    var idCol = getSheetHeaders_(sheet).map(function(h) { return h.toLowerCase(); }).indexOf('tripid');
    var existingIds = (idCol === -1 || sheet.getLastRow() < 2) ? [] :
      sheet.getRange(2, idCol + 1, sheet.getLastRow() - 1, 1).getValues().map(function(r) { return String(r[0]).trim(); });
    var tripId = nextTripId_(rec.month, existingIds);
    if (!tripId) return { status: 'error', code: 'invalid', message: 'That month already has 99 trips.' };

    var result = appendRecord_(sheet, rec.fields, { tripId: tripId }, rec.after, { textCells: true });
    if (result.error) return { status: 'error', code: 'invalid', message: result.error };

    // Who added it goes in a private log tab, never in Trips (the slip page shows Trips).
    var log = getOrCreateSheet_(ss, 'Trip Log', true);
    if (log.getLastRow() === 0) log.appendRow(['Timestamp', 'Added By', 'Trip Title', 'Trip Dates']);
    log.appendRow([new Date(), info.email, rec.fields.tripTitle || '', rec.fields.tripDates || '']);
  } finally {
    lock.releaseLock();
  }
  return { status: 'success', tripId: tripId };
}
