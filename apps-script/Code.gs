// OAuth client ID that Google Sign-In tokens must be issued for. For production,
// set a Script Property named OAUTH_CLIENT_ID instead of editing this default.
var DEFAULT_OAUTH_CLIENT_ID = '1059045077738-ohkb0nupq7kh69kj3i5io9n1rbjmfn8m.apps.googleusercontent.com';


// Diagnostic log: appends a row to the log sheet. Logging is toggled by renaming
// the sheet: 'Log(Enabled)' logs, 'Log(Disabled)' (or no sheet) does not.
// Never throws and never logs tokens or personal data.
var LOG_SHEET_ENABLED = 'Log(Enabled)';
var tokenFailReason_ = '';
function logEvent_(stage, detail) {
  try {
    var ss = getSpreadsheet_('trips');
    var sheet = ss.getSheetByName(LOG_SHEET_ENABLED);
    if (!sheet) return;
    sheet.appendRow([new Date(), stage, String(detail === undefined ? '' : detail).substring(0, 2000)]);
  } catch (e) {
    console.error('Log failed: ' + e);
  }
}

// Run this once from the editor (select it in the function dropdown, click Run).
// It exercises UrlFetch, Cache, Lock and the Log sheet so Google shows
// the permission prompt if any scope is missing, and records each result in Log.
function runDiagnostics() {
  var ss = getSpreadsheet_('trips');
  if (!ss.getSheetByName(LOG_SHEET_ENABLED)) {
    var disabled = ss.getSheetByName('Log(Disabled)');
    if (disabled) {
      disabled.setName(LOG_SHEET_ENABLED);
    } else {
      var created = ss.insertSheet(LOG_SHEET_ENABLED);
      created.appendRow(['Timestamp', 'Stage', 'Detail']);
      created.getRange(1, 1, 1, 3).setFontWeight('bold');
    }
  }
  logEvent_('diag start', 'diagnostics started');
  var steps = {
    'UrlFetch': function() { return UrlFetchApp.fetch('https://oauth2.googleapis.com/tokeninfo?id_token=x', { muteHttpExceptions: true }).getResponseCode(); },
    'Cache': function() { CacheService.getScriptCache().put('diag', '1', 5); return 'ok'; },
    'Lock': function() { var l = LockService.getScriptLock(); l.waitLock(5000); l.releaseLock(); return 'ok'; },
    'Profiles sheet': function() { return ss.getSheetByName('Profiles') ? 'exists' : 'missing (created on first save)'; },
    'Trips sheet': function() { return ss.getSheetByName('Trips') ? 'exists' : 'MISSING'; },
    'Equipment spreadsheet': function() { var e = findSpreadsheet_('equipment'); return !e ? 'NOT CONFIGURED (set EQUIPMENT_SHEET_ID)' : e.getSheetByName('Equipment') ? 'ok' : 'tab "Equipment" MISSING'; },
    'Recipes spreadsheet': function() { var r = findSpreadsheet_('recipes'); return !r ? 'NOT CONFIGURED (set RECIPES_SHEET_ID)' : r.getSheetByName('Recipes') ? 'ok' : 'tab "Recipes" MISSING'; }
  };
  Object.keys(steps).forEach(function(name) {
    try { logEvent_('diag ' + name, steps[name]()); }
    catch (err) { logEvent_('diag ' + name + ' FAILED', err); }
  });
}

function jsonOut_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ---------------------------------------------------------------------------
// ENTRY POINTS: thin router. Each area lives in its own file:
//   Hub.gs (index.html), Leaders.gs (add-trip.html), Slip.gs (slip.html)
// ---------------------------------------------------------------------------

// Trip details are never served without a sign-in: the slip page loads its trip with a
// POST (action slipTrip) carrying the user's token. GET only reports that the service is up.
function doGet() {
  return jsonOut_({ status: 'error', code: 'signin', message: 'Sign in required.' });
}

function doPost(e) {
  try {
    var raw = e.postData.contents;
    var data = JSON.parse(raw);
    logEvent_('doPost', 'action=' + (data.action || 'submit') + ' hasToken=' + !!(data._idToken || data.idToken) + ' chars=' + raw.length);

    if (data.action === 'authRequestCode') return jsonOut_(authRequestCode_(data));
    if (data.action === 'authVerifyCode') return jsonOut_(authVerifyCode_(data));
    if (data.action === 'authExchange') return jsonOut_(authExchange_(data));
    if (data.action === 'addTrip') return jsonOut_(addTrip_(data));
    if (data.action === 'listTripTemplates') return jsonOut_(listTripTemplates_(data));
    if (typeof data.action === 'string' && data.action.indexOf('hub') === 0) return jsonOut_(handleHub_(data));
    return handlePermissionPost_(raw, data);
  } catch (err) {
    return jsonOut_({ status: 'error', message: err.toString() });
  }
}

// ---------------------------------------------------------------------------
// AUTH
// ---------------------------------------------------------------------------

// Client IDs whose tokens are accepted. The test client is only accepted when the
// Script Property ALLOW_TEST_CLIENT is 'true', so production stays locked to one client.
function getAllowedClientIds_() {
  var props = PropertiesService.getScriptProperties();
  var ids = [props.getProperty('OAUTH_CLIENT_ID') || DEFAULT_OAUTH_CLIENT_ID];
//  if (props.getProperty('ALLOW_TEST_CLIENT') === 'true') ids.push(TEST_OAUTH_CLIENT_ID);
  return ids;
}

// Returns the verified Google user ID (the token's 'sub'), or null if the token is invalid.
function verifyGoogleToken_(idToken) {
  tokenFailReason_ = '';
  if (!idToken || typeof idToken !== 'string') { tokenFailReason_ = 'missing token'; return null; }
  if (isSessionToken_(idToken)) {
    var session = verifySessionToken_(idToken);
    if (!session) tokenFailReason_ = 'invalid or expired session token';
    return session ? session.sub : null;
  }
  try {
    var cache = CacheService.getScriptCache();
    var key = 'tok_' + Utilities.base64EncodeWebSafe(
      Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, idToken));
    var hit = cache.get(key);
    if (hit) return hit;

    var res = UrlFetchApp.fetch(
      'https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(idToken),
      { muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) { tokenFailReason_ = 'tokeninfo HTTP ' + res.getResponseCode() + ' ' + res.getContentText().substring(0, 200); return null; }

    var info = JSON.parse(res.getContentText());
    if (getAllowedClientIds_().indexOf(info.aud) === -1) { tokenFailReason_ = 'aud mismatch: token aud=' + info.aud + ' expected one of=' + getAllowedClientIds_().join(','); return null; }     // must be minted for THIS client
    if (Number(info.exp) * 1000 < Date.now()) { tokenFailReason_ = 'token expired'; return null; }  // not expired
    if (!info.sub) return null;

    // Never cache past the token's own expiry.
    var ttl = Math.min(300, Math.floor(Number(info.exp) - Date.now() / 1000));
    if (ttl > 0) cache.put(key, String(info.sub), ttl);
    return String(info.sub);
  } catch (err) {
    console.error('Token verification failed: ' + err);
    tokenFailReason_ = 'exception: ' + err;
    return null;
  }
}

function escapeHtml_(s) {
  return String(s === undefined || s === null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

