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
  catch (e) { return { error: hubError_('invalid', 'The photo could not be read.') }; }
  if (bytes.length > RECEIPT_PHOTO_MAX_BYTES) return { error: hubError_('invalid', 'That photo is too large.') };
  if (bytes.length < 3 || bytes[0] !== -1 || bytes[1] !== -40) { // FF D8 = JPEG
    return { error: hubError_('invalid', 'The photo must be a JPEG image.') };
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
  payment:       { tab: 'Payments', permission: 'recordPayments', byColumn: 'Recorded By' },
  reimbursement: { tab: 'Reimbursements', permission: 'recordReimbursements', byColumn: 'Recorded By' }
};

function hubError_(code, message) {
  return { status: 'error', code: code, message: message };
}

// Returns { info } for a signed-in user (info.permissions = their Leaders-sheet
// permissions, all false for non-leaders), or { error } to return to the client.
function hubAuth_(data, permission) {
  var info = verifyGoogleTokenInfo_(data.idToken);
  if (!info || !info.emailVerified) {
    return { error: hubError_('signin', 'Your sign-in has expired or is invalid. Please sign in again.') };
  }
  var perms = getLeaderPermissions_(info.email);
  info.permissions = {};
  LEADER_PERMISSIONS.forEach(function(p) { info.permissions[p] = !!(perms && perms[p]); });
  if (permission && !info.permissions[permission]) {
    return { error: hubError_('not_allowed', 'Your account (' + info.email + ') is not allowed to do that. Ask a leader to tick ' + permission + ' for you on the Leaders sheet.') };
  }
  return { info: info };
}

function handleHub_(data) {
  var auth;
  switch (data.action) {
    case 'hubSession':
      auth = hubAuth_(data, '');
      if (auth.error) return auth.error;
      var session = { status: 'success', email: auth.info.email, permissions: auth.info.permissions, trips: hubListTrips_() };
      // Leaders also get the add-trip page's "copy from" list, so that page needs no call of its own.
      if (auth.info.permissions.addTrips) session.templates = tripTemplates_();
      return session;

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

    case 'hubSubmit':
      var spec = HUB_RECORDS[data.kind];
      if (!spec) return hubError_('invalid', 'Unknown record type.');
      auth = hubAuth_(data, spec.permission);
      if (auth.error) return auth.error;
      return hubAppendRecord_(spec, data, auth.info.email);
  }
  return hubError_('invalid', 'Unknown action.');
}

// One entry per trip for the hub's list: every Trips column under its own header name
// (see tripSummary_). Trips that accept permission slips also carry
// `slip`: the same config slipTrip returns, so the slip page can open without another call.
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

// The columns the server fills itself for this kind of record, as { before, after }
// objects of header -> value. `before` goes ahead of the form's fields, `after` behind.
function hubServerFields_(spec, trip, photoUrl, email) {
  var text = function(v) { return v === undefined || v === null ? '' : String(v); };
  var before = {}, after = {};
  before[SERVER_COLUMNS.timestamp] = new Date();
  before[SERVER_COLUMNS.tripId] = text(trip.tripId);
  before[SERVER_COLUMNS.tripName] = text(trip.tripTitle); // from the sheet, not the browser
  if (spec.photoColumn) after[spec.photoColumn] = photoUrl || '';
  after[spec.byColumn] = email;
  return { before: before, after: after };
}

// data: { tripId, values (form field name -> value), photo: { data } (optional) }.
// The trip always comes from the sheet; the browser never supplies the photo link.
function hubAppendRecord_(spec, data, email) {
  var trip = getTripConfig_(getSpreadsheet_('trips'), data.tripId);
  if (!trip) return hubError_('not_found', 'Trip not found.');
  if (spec.tripFlag && !isTruthy_(trip[spec.tripFlag])) {
    return hubError_('closed', spec.closedMessage || 'This trip is not accepting that.');
  }

  // Validate the fields before uploading anything.
  var server = hubServerFields_(spec, trip, '', email);
  var clean = cleanRecordFields_(data.values, Object.keys(server.before).concat(Object.keys(server.after)));
  if (clean.error) return hubError_('invalid', clean.error);

  var url = '';
  if (spec.photoColumn && data.photo && data.photo.data) {
    var saved = hubSaveReceiptPhoto_(String(trip.tripId), data.photo.data);
    if (saved.error) return saved.error;
    url = saved.url;
  }
  server = hubServerFields_(spec, trip, url, email);

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var sheet = getOrCreateSheet_(getSpreadsheet_('trips'), spec.tab, true);
    var result = appendRecord_(sheet, clean.fields, server.before, server.after);
    if (result.error) return hubError_('invalid', result.error);
  } finally {
    lock.releaseLock();
  }
  return { status: 'success' };
}
