// ---------------------------------------------------------------------------
// TRIPS: shared helpers for the Trips sheet. Each row is one trip, keyed by a
// server-generated tripId. Besides the columns in Leaders.gs, two flags control
// which forms a trip accepts: acceptingResponses (permission slip) and
// acceptingReceipts. Edit them in the sheet to open or close a trip.
// ---------------------------------------------------------------------------

function isTruthy_(v) {
  return ['true', 'yes', 'y', '1', 'x'].indexOf(String(v === undefined || v === null ? '' : v).trim().toLowerCase()) !== -1;
}

// Trip IDs are YYYYMMNN: 4-digit year, 2-digit month, 2-digit sequence within that month
// (e.g. 20261101 is the first trip of Nov 2026). Returns '' if the month is full.
function nextTripId_(month, existingIds) {
  var prefix = month.replace('-', '');
  var max = 0;
  existingIds.forEach(function(id) {
    if (id.length === 8 && id.indexOf(prefix) === 0) max = Math.max(max, Number(id.substring(6)) || 0);
  });
  return max >= 99 ? '' : prefix + ('0' + (max + 1)).slice(-2);
}

// Returns the Trips row with this tripId as an object keyed by header, or null.
// The trip always comes from the server, never from the browser. _tripRevision is a
// fingerprint of the row; the slip page sends it back on submit so edits made while a
// parent had the form open are detected. It is computed here, not a sheet column.
function getTripConfig_(ss, tripId) {
  var id = String(tripId === undefined || tripId === null ? '' : tripId).trim();
  var sheet;
  try {
    sheet = getOrCreateSheet_(ss, 'Trips', false);
  } catch (e) {
    return null;
  }
  if (!id || !sheet || sheet.getLastRow() < 2 || sheet.getLastColumn() < 1) return null;

  var values = sheet.getDataRange().getValues();
  var headers = values[0].map(function(h) { return h.toString().trim(); });
  var idCol = headers.indexOf('tripId');
  if (idCol === -1) return null;

  for (var i = 1; i < values.length; i++) {
    if (String(values[i][idCol]).trim() !== id) continue;
    return tripRowConfig_(headers, values[i]);
  }
  return null;
}

// One Trips row as an object keyed by header (blank headers skipped).
function tripRowObject_(headers, row) {
  var obj = {};
  headers.forEach(function(h, j) { if (h !== '') obj[h] = row[j]; });
  return obj;
}

// The hub's list entry for a Trips row (an object keyed by header, display values): every
// column, with the two flags the hub acts on turned into booleans.
function tripSummary_(row) {
  var t = {};
  Object.keys(row).forEach(function(k) { t[k] = row[k]; });
  t.acceptingResponses = isTruthy_(row.acceptingResponses);
  t.acceptingReceipts = isTruthy_(row.acceptingReceipts);
  return t;
}

// Builds the config object (keyed by header, plus _tripRevision) for one Trips row.
function tripRowConfig_(headers, row) {
  var config = tripRowObject_(headers, row);
  config._tripRevision = Utilities.base64EncodeWebSafe(
    Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, JSON.stringify([headers, row]), Utilities.Charset.UTF_8)
  ).replace(/=+$/, '');
  return config;
}
