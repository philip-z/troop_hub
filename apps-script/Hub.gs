// ---------------------------------------------------------------------------
// TROOP HUB (index.html): trips list, receipts, and leader payment/reimbursement
// records. The permission slip and add-trip pages have their own files
// (Slip.gs, Leaders.gs). All routes are POST actions starting with "hub"
// and require a verified sign-in token. Payment and reimbursement records also require
// the matching permission on the "Leaders" sheet (see Leaders.gs). Nothing here trusts
// the browser for identity: the email always comes from the verified token.
// ---------------------------------------------------------------------------

var HUB_FIELD_MAX = 1000;
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
// fields: client field names in column order }.
// Every row is prefixed with Timestamp and suffixed with the verified email.
var HUB_RECORDS = {
  receipt:       { tab: 'Receipts', permission: '', byLabel: 'Submitted By',
                   headers: ['Trip ID', 'Trip', 'Description', 'Amount', 'Receipt URL'],
                   fields:  ['tripId', 'tripName', 'description', 'amount', 'url'] },
  payment:       { tab: 'Payments', permission: 'recordPayments', byLabel: 'Recorded By',
                   headers: ['Trip ID', 'Scout', 'Amount', 'Method'],
                   fields:  ['tripId', 'scout', 'amount', 'method'] },
  reimbursement: { tab: 'Reimbursements', permission: 'recordReimbursements', byLabel: 'Recorded By',
                   headers: ['Trip ID', 'Paid To', 'Amount', 'Notes'],
                   fields:  ['tripId', 'payee', 'amount', 'notes'] }
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
      return { status: 'success', email: auth.info.email, permissions: auth.info.permissions };

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
      return hubAppendRecord_(spec, data.kind, data.values || {}, auth.info.email);
  }
  return hubError_('invalid', 'Unknown action.');
}

function hubListTrips_() {
  var sheet = getSpreadsheet_('trips').getSheetByName('Trips');
  if (!sheet || sheet.getLastRow() < 2) return [];
  var values = sheet.getDataRange().getDisplayValues();
  var headers = values[0].map(function(h) { return h.toString().trim(); });
  var col = function(row, name) { var i = headers.indexOf(name); return i === -1 ? '' : row[i]; };
  return values.slice(1)
    .filter(function(r) { return String(col(r, 'tripId')).trim() !== ''; })
    .map(function(r) {
      return {
        id: col(r, 'tripId'),
        name: col(r, 'tripTitle'),
        date: col(r, 'tripDates'),
        location: col(r, 'tripLocation'),
        cost: col(r, 'tripCost'),
        acceptingResponses: isTruthy_(col(r, 'acceptingResponses')),
        acceptingReceipts: isTruthy_(col(r, 'acceptingReceipts'))
      };
    });
}

// Blocks spreadsheet formula injection and caps length.
function hubCell_(v) {
  var s = (v === undefined || v === null) ? '' : String(v).substring(0, HUB_FIELD_MAX);
  return /^[=+\-@\t\r]/.test(s) ? "'" + s : s;
}

function hubAppendRecord_(spec, kind, values, email) {
  var trip = getTripConfig_(getSpreadsheet_('trips'), values.tripId);
  if (!trip) return hubError_('not_found', 'Trip not found.');
  if (kind === 'receipt' && !isTruthy_(trip.acceptingReceipts)) {
    return hubError_('closed', 'This trip is not accepting receipts.');
  }
  values.tripId = String(trip.tripId);
  values.tripName = String(trip.tripTitle); // from the sheet, not the browser
  // The browser never supplies the link: it is the Drive URL of an uploaded photo, or blank.
  values.url = '';
  if (kind === 'receipt' && values.photo && values.photo.data) {
    var saved = hubSaveReceiptPhoto_(values.tripId, values.photo.data);
    if (saved.error) return saved.error;
    values.url = saved.url;
  }

  var row = [new Date()].concat(spec.fields.map(function(f) { return hubCell_(values[f]); }), [email]);
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var ss = getSpreadsheet_('trips');
    var sheet = ss.getSheetByName(spec.tab) || ss.insertSheet(spec.tab);
    if (sheet.getLastRow() === 0) {
      sheet.appendRow(['Timestamp'].concat(spec.headers, [spec.byLabel]));
      sheet.getRange(1, 1, 1, spec.headers.length + 2).setFontWeight('bold');
    }
    sheet.appendRow(row);
  } finally {
    lock.releaseLock();
  }
  return { status: 'success' };
}
