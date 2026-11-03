// OAuth client ID that Google Sign-In tokens must be issued for. For production,
// set a Script Property named OAUTH_CLIENT_ID instead of editing this default.
var DEFAULT_OAUTH_CLIENT_ID = '1059045077738-ohkb0nupq7kh69kj3i5io9n1rbjmfn8m.apps.googleusercontent.com';


// Diagnostic log: appends a row to the log sheet. Logging is toggled by renaming
// the sheet: 'Log(Enabled)' logs, 'Log(Disabled)' (or no sheet) does not.
// Never throws and never logs tokens or personal data.
var LOG_SHEET_ENABLED = 'Log(Enabled)';
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
    'Profile sheets': function() { return Object.keys(SLIP_KINDS).map(function(k) { var t = SLIP_KINDS[k].profileTab; return t + ': ' + (ss.getSheetByName(t) ? 'exists' : 'missing (created on first save)'); }).join('; '); },
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

// The one shape of a failed reply, used by every file: { status: 'error', code, message }. The pages
// read status / code / message (code 'signin' means "sign in again"); code is left out when empty.
function errorReply_(code, message) {
  var reply = { status: 'error' };
  if (code) reply.code = code;
  reply.message = message;
  return reply;
}

// ---------------------------------------------------------------------------
// ENTRY POINTS: thin router. Each area lives in its own file:
//   Hub.gs (index.html), Leaders.gs (add-trip.html), Slip.gs (slip.html)
// ---------------------------------------------------------------------------

// Nothing is served without a sign-in: every page POSTs with the user's token (the slip page loads
// its trip with action slipLoad). GET never returns data.
function doGet() {
  return jsonOut_(errorReply_('signin', 'Sign in required.'));
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
    return jsonOut_(errorReply_('', err.toString()));
  }
}

// ---------------------------------------------------------------------------
// AUTH
// ---------------------------------------------------------------------------

// Client IDs whose tokens are accepted: just ours, so production stays locked to one client.
function getAllowedClientIds_() {
  var props = PropertiesService.getScriptProperties();
  return [props.getProperty('OAUTH_CLIENT_ID') || DEFAULT_OAUTH_CLIENT_ID];
}

// Returns the verified user ID (the token's 'sub'), or null if the token is invalid. The checking
// itself (Google or email-code token, audience, expiry, caching) is verifyGoogleTokenInfo_ in Leaders.gs.
function verifyGoogleToken_(idToken) {
  var info = verifyGoogleTokenInfo_(idToken);
  return info ? info.sub : null;
}

function escapeHtml_(s) {
  return String(s === undefined || s === null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

