// ---------------------------------------------------------------------------
// LIBRARY: read-only lists that live in their own spreadsheets (see Sheets.gs).
// Any signed-in user can read them; leaders edit them directly in the sheets.
//
//   Equipment spreadsheet, tab "Equipment": row 1 headers
//     item | category | quantity | status | notes
//   Recipes spreadsheet, tab "Recipes": row 1 headers
//     name | serves | ingredients | notes
//   (ingredients: one per line inside the cell, e.g. "1 1/2 cups flour")
//
// Column order does not matter; extra columns are ignored.
// ---------------------------------------------------------------------------

var EQUIPMENT_COLUMNS = ['item', 'category', 'quantity', 'status', 'notes'];
var RECIPE_COLUMNS = ['name', 'serves', 'ingredients', 'notes'];
var LIBRARY_MAX_ROWS = 500;
var LIBRARY_CELL_MAX = 2000;

// Rows of `tab` as objects with just the wanted columns; rows with an empty first column are skipped.
function readTable_(ss, tab, columns) {
  var sheet = ss.getSheetByName(tab);
  if (!sheet || sheet.getLastRow() < 2) return [];
  var rows = Math.min(sheet.getLastRow(), LIBRARY_MAX_ROWS + 1);
  var values = sheet.getRange(1, 1, rows, Math.max(sheet.getLastColumn(), 1)).getDisplayValues();
  var headers = values[0].map(function(h) { return String(h).trim().toLowerCase(); });
  return values.slice(1).map(function(row) {
    var obj = {};
    columns.forEach(function(c) {
      var i = headers.indexOf(c);
      obj[c] = i === -1 ? '' : String(row[i]).substring(0, LIBRARY_CELL_MAX);
    });
    return obj;
  }).filter(function(o) { return o[columns[0]].trim() !== ''; });
}

function listLibrary_(role, tab, columns, label) {
  var ss = findSpreadsheet_(role);
  if (!ss) {
    return hubError_('config', 'The ' + label + ' spreadsheet has not been set up yet. Ask an admin to set ' + SHEET_ROLES[role] + '.');
  }
  return { status: 'success', items: readTable_(ss, tab, columns) };
}

function listEquipment_() {
  return listLibrary_('equipment', 'Equipment', EQUIPMENT_COLUMNS, 'equipment');
}

function listRecipes_() {
  return listLibrary_('recipes', 'Recipes', RECIPE_COLUMNS, 'recipes');
}
