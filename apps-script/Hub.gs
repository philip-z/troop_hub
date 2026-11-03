// ---------------------------------------------------------------------------
// TROOP HUB (index.html): trips list, receipts, and leader payment/reimbursement
// records. The permission slip and add-trip pages have their own files
// (Slip.gs, Leaders.gs). All routes are POST actions starting with "hub"
// and require a verified sign-in token. Payment and reimbursement records also require
// the matching permission on the "Leaders" sheet (see Leaders.gs). Nothing here trusts
// the browser for identity: the email always comes from the verified token.
// ---------------------------------------------------------------------------

var RECEIPT_PHOTO_MAX_BYTES = 3 * 1024 * 1024; // the page shrinks photos to well under this

// Folder for receipt photos: Script Property RECEIPTS_FOLDER_ID if set, otherwise a
// "Troop 58 Receipts" folder in the script owner's Drive, created on first use. Files
// stay private to the owner (and whoever the folder is shared with).
function hubReceiptsFolder_() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty('RECEIPTS_FOLDER_ID');
  if (id) return DriveApp.getFolderById(id);
  var found = DriveApp.getFoldersByName('Troop 58 Receipts');
  var folder = found.hasNext() ? found.next() : DriveApp.createFolder('Troop 58 Receipts');
  props.setProperty('RECEIPTS_FOLDER_ID', folder.getId());
  return folder;
}

// Saves a base64 JPEG (the page converts every photo to JPEG) and returns { url } or { error }.
// The file name is generated here, never taken from the browser.
function hubSaveReceiptPhoto_(tripId, base64) {
  var bytes;
  try { bytes = Utilities.base64Decode(String(base64)); }
  catch (e) { return { error: errorReply_('invalid', 'The photo could not be read.') }; }
  if (bytes.length > RECEIPT_PHOTO_MAX_BYTES) return { error: errorReply_('invalid', 'That photo is too large.') };
  if (bytes.length < 3 || bytes[0] !== -1 || bytes[1] !== -40) { // FF D8 = JPEG
    return { error: errorReply_('invalid', 'The photo must be a JPEG image.') };
  }
  var stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyyMMdd-HHmmss');
  var name = 'receipt-' + tripId + '-' + stamp + '-' + Math.floor(Math.random() * 1e6) + '.jpg';
  var file = hubReceiptsFolder_().createFile(Utilities.newBlob(bytes, 'image/jpeg', name));
  return { url: file.getUrl() };
}

// kind -> { tab, permission (Leaders sheet column, or '' for any signed-in user),
// byColumn (header for the verified email), tripFlag (Trips column that must be TRUE,
// optional), closedMessage, photoColumn (header for the uploaded photo's link, optional) }.
// The record's own columns are NOT listed here: they are the `name`s of the form inputs
// in index.html (see appendRecord_ in Sheets.gs). The server also fills Timestamp,
// Trip ID and Trip (SERVER_COLUMNS), plus byColumn and photoColumn, and the browser
// cannot send those names.
var HUB_RECORDS = {
  receipt:       { tab: 'Receipts', permission: '', byColumn: 'Submitted By',
                   tripFlag: 'acceptingReceipts', closedMessage: 'This trip is not accepting receipts.',
                   photoColumn: 'Receipt URL' },
  payment:       { tab: 'Payments', permission: 'manageTrips', byColumn: 'Recorded By' },
  reimbursement: { tab: 'Reimbursements', permission: 'recordReimbursements', byColumn: 'Recorded By' }
};

// { manageTrips: bool, ... } from the Leaders sheet; all false for someone who isn't listed.
function hubPermissions_(email) {
  var perms = getLeaderPermissions_(email);
  var out = {};
  LEADER_PERMISSIONS.forEach(function(p) { out[p] = !!(perms && perms[p]); });
  return out;
}

// What a page needs to start with, in one response: the person's permissions and the trip list
// (each trip with its slip config), plus the add-trip templates for people who manage trips.
// Sign-in responses carry this too (see Auth.gs), so signing in and opening the hub is one call.
function hubSessionFor_(email, permissions) {
  var session = { status: 'success', email: email, permissions: permissions, trips: hubListTrips_() };
  if (permissions.manageTrips) session.templates = tripTemplates_();
  return session;
}

// Same, for a verified email, or null if anything goes wrong: a sign-in must never fail because
// the sheets were slow or unavailable (the page then asks for the session itself).
function hubSessionOrNull_(email) {
  try {
    return hubSessionFor_(email, hubPermissions_(email));
  } catch (e) {
    console.error('Session bundle failed: ' + e);
    return null;
  }
}

// Returns { info } for a signed-in user (info.permissions = their Leaders-sheet
// permissions, all false for non-leaders), or { error } to return to the client.
function hubAuth_(data, permission) {
  var info = verifyGoogleTokenInfo_(data.idToken);
  if (!info || !info.emailVerified) {
    return { error: errorReply_('signin', 'Your sign-in has expired or is invalid. Please sign in again.') };
  }
  info.permissions = hubPermissions_(info.email);
  if (permission && !info.permissions[permission]) {
    return { error: errorReply_('not_allowed', 'Your account (' + info.email + ') is not allowed to do that. Ask a leader to tick ' + permission + ' for you on the Leaders sheet.') };
  }
  return { info: info };
}

// An optional list (equipment, recipes) riding along with another answer: if its spreadsheet can't
// be opened it becomes an error entry of its own and must not break the main answer.
function hubOptionalList_(read) {
  try {
    return read();
  } catch (e) {
    console.error('List failed: ' + e);
    return errorReply_('error', 'That list could not be read right now.');
  }
}

function handleHub_(data) {
  var auth;
  switch (data.action) {
    case 'hubSession':
      auth = hubAuth_(data, '');
      if (auth.error) return auth.error;
      return hubSessionFor_(auth.info.email, auth.info.permissions);

    case 'hubListTrips':
      auth = hubAuth_(data, '');
      if (auth.error) return auth.error;
      return { status: 'success', trips: hubListTrips_() };

    case 'hubListEquipment':
      auth = hubAuth_(data, '');
      if (auth.error) return auth.error;
      return listEquipment_();

    case 'hubListRecipes':
      auth = hubAuth_(data, '');
      if (auth.error) return auth.error;
      return listRecipes_();

    case 'hubLists':
      // Equipment and recipes together, so the hub can fetch both in one background call.
      auth = hubAuth_(data, '');
      if (auth.error) return auth.error;
      return { status: 'success', equipment: hubOptionalList_(listEquipment_), recipes: hubOptionalList_(listRecipes_) };

    case 'hubFloatPlan':
      // Everyone's emergency phone and medical notes: leaders who manage trips only.
      // The gear checklist's equipment list comes along, so the page needs one call, not two.
      auth = hubAuth_(data, 'manageTrips');
      if (auth.error) return auth.error;
      return { status: 'success', responses: tripResponses_(data.tripId), equipment: hubOptionalList_(listEquipment_) };

    case 'hubSubmit':
      var spec = HUB_RECORDS[data.kind];
      if (!spec) return errorReply_('invalid', 'Unknown record type.');
      auth = hubAuth_(data, spec.permission);
      if (auth.error) return auth.error;
      return hubAppendRecord_(spec, data, auth.info.email);
  }
  return errorReply_('invalid', 'Unknown action.');
}

// One entry per trip for the hub's list: every Trips column under its own header name
// (see tripSummary_). Trips that accept permission slips also carry
// `slip`: the trip's slip config (see permissionTripConfig_), so the slip page can open without another call.
function hubListTrips_() {
  var sheet;
  try {
    sheet = getOrCreateSheet_(getSpreadsheet_('trips'), 'Trips', false);
  } catch (e) {
    return [];
  }
  if (!sheet || sheet.getLastRow() < 2) return [];
  var raw = sheet.getDataRange().getValues();
  var values = sheet.getDataRange().getDisplayValues();
  var headers = values[0].map(function(h) { return h.toString().trim(); });
  var col = createColumnGetter_(headers);
  var trips = [];
  for (var i = 1; i < values.length; i++) {
    var r = values[i];
    if (String(col(r, 'tripId')).trim() === '') continue;
    var trip = tripSummary_(tripRowObject_(headers, r));
    if (trip.acceptingResponses) trip.slip = tripRowConfig_(headers, raw[i]);
    trips.push(trip);
  }
  return trips;
}

// Every column name the browser may not send for this kind of record.
function hubReservedNames_(spec) {
  var names = Object.keys(SERVER_COLUMNS).map(function(k) { return SERVER_COLUMNS[k]; });
  names.push(spec.byColumn);
  if (spec.photoColumn) names.push(spec.photoColumn);
  return names;
}

var CLIENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{7,63}$/;
var ENTERED_AT_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;
var LATE_AFTER_MS = 2 * 60 * 1000;

// Pure. What the device says about this entry: { clientId, enteredAt (Date or null), late }.
// An entry the person made offline can reach the server days later, so the page sends the time
// it was entered and a unique ID. The clientId is kept only if well-formed; enteredAt only if it
// is a real time within the last 90 days (a time slightly in the future is clamped to now).
// `late` means it arrived more than a couple of minutes after it was entered, which is how a
// queued entry is recognized (see hubAppendRecord_ for what that changes). A device can claim
// to be late, so this only relaxes the "trip is closed" check, never anything about who may do what.
function hubMeta_(data, now) {
  now = now || new Date();
  var clientId = String(data && data.clientId || '');
  if (!CLIENT_ID_PATTERN.test(clientId)) clientId = '';
  var entered = null;
  var parsed = new Date(String(data && data.enteredAt || ''));
  if (data && data.enteredAt && isFinite(parsed.getTime()) && now.getTime() - parsed.getTime() <= ENTERED_AT_MAX_AGE_MS) {
    entered = parsed.getTime() > now.getTime() ? now : parsed;
  }
  return { clientId: clientId, enteredAt: entered, late: !!entered && now.getTime() - entered.getTime() > LATE_AFTER_MS };
}

// The columns the server fills itself for this kind of record, as { before, after }
// objects of header -> value. `before` goes ahead of the form's fields, `after` behind.
// meta (from hubMeta_) is optional: its columns are added only when the device sent them.
function hubServerFields_(spec, trip, photoUrl, email, meta) {
  var text = function(v) { return v === undefined || v === null ? '' : String(v); };
  var before = {}, after = {};
  before[SERVER_COLUMNS.timestamp] = new Date();
  if (meta && meta.enteredAt) before[SERVER_COLUMNS.enteredAt] = meta.enteredAt;
  before[SERVER_COLUMNS.tripId] = text(trip.tripId);
  before[SERVER_COLUMNS.tripName] = text(trip.tripTitle); // from the sheet, not the browser
  if (spec.photoColumn) after[spec.photoColumn] = photoUrl || '';
  after[spec.byColumn] = email;
  if (meta && meta.clientId) after[SERVER_COLUMNS.clientId] = meta.clientId;
  return { before: before, after: after };
}

// True when this device entry was already written (a retry after a lost reply).
function hubAlreadySaved_(spec, meta) {
  if (!meta.clientId) return false;
  var sheet;
  try {
    sheet = getOrCreateSheet_(getSpreadsheet_('trips'), spec.tab, false);
  } catch (e) {
    return false;
  }
  return columnHasValue_(sheet, SERVER_COLUMNS.clientId, meta.clientId);
}

// data: { tripId, values (form field name -> value), photo: { data } (optional),
//         clientId, enteredAt (optional: see hubMeta_) }.
// The trip always comes from the sheet; the browser never supplies the photo link.
// An entry that arrives late (it was made offline) is still accepted when the trip has stopped
// taking that kind of record in the meantime, since the expense really happened.
function hubAppendRecord_(spec, data, email) {
  var meta = hubMeta_(data);
  var trip = getTripConfig_(getSpreadsheet_('trips'), data.tripId);
  if (!trip) return errorReply_('not_found', 'Trip not found.');
  if (spec.tripFlag && !isTruthy_(trip[spec.tripFlag])) {
    if (!meta.late) return errorReply_('closed', spec.closedMessage || 'This trip is not accepting that.');
    logEvent_('late record accepted', spec.tab + ': trip ' + trip.tripId + ' closed, entered ' + meta.enteredAt.toISOString());
  }
  if (hubAlreadySaved_(spec, meta)) return { status: 'success', duplicate: true };

  // Validate the fields before uploading anything.
  var clean = cleanRecordFields_(data.values, hubReservedNames_(spec));
  if (clean.error) return errorReply_('invalid', clean.error);

  var url = '';
  if (spec.photoColumn && data.photo && data.photo.data) {
    var saved = hubSaveReceiptPhoto_(String(trip.tripId), data.photo.data);
    if (saved.error) return saved.error;
    url = saved.url;
  }
  var server = hubServerFields_(spec, trip, url, email, meta);

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    if (hubAlreadySaved_(spec, meta)) return { status: 'success', duplicate: true };
    var sheet = getOrCreateSheet_(getSpreadsheet_('trips'), spec.tab, true);
    var result = appendRecord_(sheet, clean.fields, server.before, server.after);
    if (result.error) return errorReply_('invalid', result.error);
  } finally {
    lock.releaseLock();
  }
  return { status: 'success' };
}
