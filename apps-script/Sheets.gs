// ---------------------------------------------------------------------------
// SPREADSHEETS: the script is standalone (not bound to a sheet) and opens each
// spreadsheet by ID from Script Properties (Project Settings > Script Properties):
//   TRIPS_SHEET_ID      Trips, Leaders, Responses, Profiles, Youth Profiles, Receipts,
//                       Payments, Reimbursements, Trip Log, Log(Enabled)
//   EQUIPMENT_SHEET_ID  tab "Equipment" (see Library.gs)
//   RECIPES_SHEET_ID    tab "Recipes"   (see Library.gs)
// The ID is the long string in the spreadsheet's URL: /spreadsheets/d/<ID>/edit.
// The account that owns the deployment must be able to edit all three.
// ---------------------------------------------------------------------------

var SHEET_ROLES = {
  trips: 'TRIPS_SHEET_ID',
  equipment: 'EQUIPMENT_SHEET_ID',
  recipes: 'RECIPES_SHEET_ID'
};

var spreadsheetCache_ = {};

// Returns the spreadsheet for a role, or null if it is not configured.
// A script bound to the Trips spreadsheet still works without TRIPS_SHEET_ID.
function findSpreadsheet_(role) {
  if (spreadsheetCache_[role]) return spreadsheetCache_[role];
  var id = PropertiesService.getScriptProperties().getProperty(SHEET_ROLES[role]);
  var ss = null;
  if (id) {
    ss = SpreadsheetApp.openById(id.trim());
  } else if (role === 'trips') {
    ss = SpreadsheetApp.getActiveSpreadsheet();
  }
  if (ss) spreadsheetCache_[role] = ss;
  return ss;
}

// Like findSpreadsheet_, but throws a clear error when it is not configured.
function getSpreadsheet_(role) {
  var ss = findSpreadsheet_(role);
  if (!ss) throw new Error('Script property ' + SHEET_ROLES[role] + ' is not set.');
  return ss;
}
