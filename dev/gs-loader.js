// Loads Apps Script files into one shared vm context so Node (the dev mock and the tests)
// can call the real .gs functions. Only files with no Apps Script calls at load time work.
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");

function loadGs(files, globals) {
  const ctx = vm.createContext(Object.assign({ console }, globals));
  files.forEach((f) => vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "apps-script", f), "utf8"), ctx, { filename: f }));
  // Re-apply so a stub (e.g. logEvent_) wins over a function of the same name defined in a loaded file.
  Object.assign(ctx, globals);
  return ctx;
}
module.exports = { loadGs };
