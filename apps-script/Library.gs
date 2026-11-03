// ---------------------------------------------------------------------------
// LIBRARY: read-only lists that live in their own spreadsheets (see Sheets.gs).
// Any signed-in user can read them; leaders edit them directly in the sheets.
//
//   Equipment spreadsheet, tab "Equipment" (the hub shows item, category, quantity,
//     status, notes; see the data-* attributes on #equipment in index.html)
//   Recipes spreadsheet, tab "Recipes" (name, serves, ingredients, notes; see the
//     data-recipe attributes in index.html; ingredients: one per line inside the cell)
//
// Every row is sent as an object keyed by its column header, exactly as typed in row 1,
// so the page decides which columns it uses and a new column needs no change here.
// Column order does not matter.
//
// PRIVATE COLUMNS: any signed-in user can read what is sent, so a column whose header
// starts with an underscore (e.g. "_owner phone") is never sent. Blank headers are skipped.
// ---------------------------------------------------------------------------

var LIBRARY_MAX_ROWS = 500;
var LIBRARY_MAX_COLUMNS = 40;
var LIBRARY_CELL_MAX = 2000;

// Pure: turns a sheet's display values (row 1 = headers) into one object per row, keyed
// by header (maxColumns defaults to LIBRARY_MAX_COLUMNS). Skips private and blank headers (and repeats of a header), caps columns and
// cell length, and drops rows with nothing in any sent column.
function tableRows_(values, maxColumns) {
  if (!values || values.length < 2) return [];
  maxColumns = maxColumns || LIBRARY_MAX_COLUMNS;
  var keep = [], seen = {};
  values[0].forEach(function(h, i) {
    var name = String(h === undefined || h === null ? '' : h).trim();
    if (name === '' || name.charAt(0) === '_' || seen[name] || keep.length >= maxColumns) return;
    seen[name] = true;
    keep.push({ name: name, index: i });
  });
  return values.slice(1).map(function(row) {
    var obj = {}, any = false;
    keep.forEach(function(c) {
      var v = row[c.index] === undefined || row[c.index] === null ? '' : String(row[c.index]);
      if (v.trim() !== '') any = true;
      obj[c.name] = v.substring(0, LIBRARY_CELL_MAX);
    });
    return any ? obj : null;
  }).filter(function(o) { return o !== null; });
}

// Rows of `tab` (see tableRows_); [] if the tab is missing or empty.
function readTable_(ss, tab) {
  var sheet;
  try {
    sheet = getOrCreateSheet_(ss, tab, false);
  } catch (e) {
    return [];
  }
  if (!sheet || sheet.getLastRow() < 2) return [];
  var rows = Math.min(sheet.getLastRow(), LIBRARY_MAX_ROWS + 1);
  return tableRows_(sheet.getRange(1, 1, rows, Math.max(sheet.getLastColumn(), 1)).getDisplayValues());
}

function listLibrary_(role, tab, label) {
  var ss = findSpreadsheet_(role);
  if (!ss) {
    return errorReply_('config', 'The ' + label + ' spreadsheet has not been set up yet. Ask an admin to set ' + SHEET_ROLES[role] + '.');
  }
  return { status: 'success', items: readTable_(ss, tab) };
}

function listEquipment_() {
  return listLibrary_('equipment', 'Equipment', 'equipment');
}

function listRecipes_() {
  return listLibrary_('recipes', 'Recipes', 'recipes');
}
