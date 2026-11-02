// Local dev server: static files + an in-memory mock of the Apps Script web app.
//   npm run dev                           (http://localhost:5173)
//   LEADERS=a@x.com,b@x.com:recordReimbursements npm run dev   to change the leaders and their permissions
// Mirrors the routes and response shapes in apps-script/*.gs, but is NOT the real
// backend: tokens are not verified with Google, and data resets on restart.
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { loadGs } = require("./gs-loader.js");

const ROOT = path.join(__dirname, "..");
const SITE = path.join(ROOT, "docs");
const PORT = Number(process.env.PORT) || 5173;
// LEADERS=email[:perm+perm],... ; no ":" means all permissions. Permissions: manageTrips, recordReimbursements.
const PERMS = ["manageTrips", "recordReimbursements"];
const LEADERS = new Map((process.env.LEADERS || "leader@test.com,treasurer@test.com:recordReimbursements").split(",").map((s) => {
  const [email, p] = s.trim().split(":");
  return [email.toLowerCase(), p === undefined ? PERMS : p.split("+").filter((x) => PERMS.includes(x))];
}));
const GSI_TAG = /<script[^>]*accounts\.google\.com\/gsi\/client[^>]*><\/script>/;
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".jpg": "image/jpeg", ".png": "image/png", ".json": "application/json" };

const MAX_PHOTO_BYTES = 3 * 1024 * 1024;
const photos = [];  // uploaded receipt photos, kept out of db so /dev/state stays small

// ---- in-memory "spreadsheet" ----
const db = {
  trips: [
    { tripId: "20261101", tripTitle: "Fall Campout", tripLocation: "Camp Wanaque", tripDates: "Nov 6-8, 2026", departureDetails: "Church lot, Fri 6:00 PM",
      returnDetails: "Sun 11:00 AM", tripCost: "40", tripCoordinator: "Mr. Smith", tripUniform: "Field uniform", customDepartureHtml: "",
      acceptingResponses: "TRUE", acceptingReceipts: "TRUE" },
    { tripId: "20261102", tripTitle: "Hike", tripLocation: "Bear Mountain", tripDates: "Nov 21, 2026", departureDetails: "", returnDetails: "",
      tripCost: "30", tripCoordinator: "", tripUniform: "", customDepartureHtml: "", acceptingResponses: "FALSE", acceptingReceipts: "FALSE" }
  ],
  tables: { Responses: [], Receipts: [], Payments: [], Reimbursements: [], "Trip Log": [] },
  // Stand-ins for the separate Equipment and Recipes spreadsheets.
  equipment: [
    { item: "Dutch oven (12 in)", category: "Cooking", quantity: "4", status: "In trailer", notes: "Clean before returning" },
    { item: "6-person tent", category: "Camping", quantity: "6", status: "2 out with Troop 58 Patrol Blue", notes: "" },
    { item: "Propane stove", category: "Cooking", quantity: "3", status: "In trailer", notes: "Check hoses each season" },
    // A column starting with "_" is private: the real script never sends it.
    { item: "First aid kit", category: "Safety", quantity: "2", status: "Needs restocking", notes: "", _supplier: "private, should never reach the browser" }
  ],
  recipes: [
    { name: "Campfire chili", serves: "8", ingredients: "2 lb ground beef\n2 cans kidney beans\n1 1/2 cups diced onion\n2 tbsp chili powder", notes: "Dutch oven" },
    { name: "Pancakes", serves: "6", ingredients: "3 cups flour\n2 cups milk\n2 eggs", notes: "" }
  ],
  profiles: {}    // profile tab name -> grid (header row first), like the sheet
};

// The real helpers and validation from apps-script/, so the mock can't drift from them.
const gs = loadGs(["Sheets.gs", "Trips.gs", "Leaders.gs", "Hub.gs", "Library.gs", "Slip.gs", "Code.gs"], { logEvent_() {} });

const truthy = (v) => ["true", "yes", "y", "1", "x"].includes(String(v ?? "").trim().toLowerCase());
const revision = (t) => crypto.createHash("sha256").update(JSON.stringify(t)).digest("base64url");
const tripConfig = (id) => { const t = db.trips.find((x) => x.tripId === String(id || "").trim()); return t ? Object.assign({}, t, { _tripRevision: revision(t) }) : null; };
const tripSummary = (t) => {
  const s = gs.tripSummary_(t);
  if (s.acceptingResponses) s.slip = tripConfig(t.tripId);
  return s;
};

// Array of row objects -> the header-row-plus-rows grid a sheet would hand the real script.
const grid = (objs) => { const cols = [...new Set(objs.flatMap(Object.keys))]; return [cols, ...objs.map((o) => cols.map((c) => o[c] ?? ""))]; };
const err = (code, message) => ({ status: "error", code, message });

// ---- fake token verification (accepts the unsigned tokens from dev/mock-gsi.js) ----
function verify(idToken) {
  try {
    const parts = String(idToken).split(".");
    const c = JSON.parse(Buffer.from(parts[1], "base64url").toString());
    if (parts[0] === "ts1") { // email-code session token (see apps-script/Auth.gs)
      if (!c.email || Number(c.exp) * 1000 < Date.now()) return null;
      const email = String(c.email).toLowerCase();
      return { sub: c.sub ? String(c.sub) : "email:" + email, email, emailVerified: true };
    }
    if (!c.sub || Number(c.exp) * 1000 < Date.now()) return null;
    return { sub: String(c.sub), email: String(c.email || "").toLowerCase(), emailVerified: c.email_verified === true };
  } catch (e) { return null; }
}

// ---- email one-time codes: the code is always MOCK_CODE and is also printed here ----
const MOCK_CODE = "123456";
function authRequestCode(data) {
  const email = String(data.email || "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return err("invalid", "Enter a valid email address.");
  console.log("[mock email] sign-in code for " + email + ": " + MOCK_CODE);
  return { status: "success", message: "If that address can receive mail, a sign-in code is on its way. It expires in 10 minutes. (Dev: the code is " + MOCK_CODE + ")" };
}
function authVerifyCode(data) {
  const email = String(data.email || "").trim().toLowerCase();
  if (String(data.code || "").replace(/\s+/g, "") !== MOCK_CODE || !email) return err("bad_code", "That code is wrong or has expired. Request a new one.");
  const ttl = data.remember === true ? 30 * 86400 : 7200;
  const payload = Buffer.from(JSON.stringify({ email, exp: Math.floor(Date.now() / 1000) + ttl })).toString("base64url");
  return { status: "success", token: "ts1." + payload + ".mock" };
}
function authExchange(data) {
  if (String(data.idToken).startsWith("ts1.")) return err("signin", "Please sign in with Google.");
  const info = verify(data.idToken);
  if (!info || !info.emailVerified) return SIGNIN_ERR;
  const c = JSON.parse(Buffer.from(String(data.idToken).split(".")[1], "base64url").toString());
  const payload = Buffer.from(JSON.stringify({ email: info.email, sub: info.sub, name: c.name, exp: Math.floor(Date.now() / 1000) + 30 * 86400 })).toString("base64url");
  return { status: "success", token: "ts1." + payload + ".mock" };
}
const permissionsFor = (email) => Object.fromEntries(PERMS.map((p) => [p, (LEADERS.get(email) || []).includes(p)]));
const SIGNIN_ERR = err("signin", "Your sign-in has expired or is invalid. Please sign in again.");

function auth(data, permission) {
  const info = verify(data.idToken);
  if (!info || !info.emailVerified) return { error: SIGNIN_ERR };
  info.permissions = permissionsFor(info.email);
  if (permission && !info.permissions[permission]) return { error: err("not_allowed", "Your account (" + info.email + ") is not allowed to do that. Ask a leader to tick " + permission + " for you on the Leaders sheet.") };
  return { info };
}

// ---- routes ----
const HUB_RECORDS = gs.HUB_RECORDS;

function hub(data) {
  let a;
  switch (data.action) {
    case "hubSession":
      a = auth(data, ""); if (a.error) return a.error;
      return {
        status: "success",
        email: a.info.email,
        permissions: a.info.permissions,
        trips: db.trips.map((t) => tripSummary(t)),
        ...(a.info.permissions.manageTrips ? { templates: tripTemplates() } : {})
      };
    case "hubListTrips":
      a = auth(data, ""); if (a.error) return a.error;
      return { status: "success", trips: db.trips.map((t) => tripSummary(t)) };
    case "hubListEquipment":
      a = auth(data, ""); if (a.error) return a.error;
      return { status: "success", items: gs.tableRows_(grid(db.equipment)) };
    case "hubListRecipes":
      a = auth(data, ""); if (a.error) return a.error;
      return { status: "success", items: gs.tableRows_(grid(db.recipes)) };
    case "hubFloatPlan":
      a = auth(data, "manageTrips"); if (a.error) return a.error;
      return { status: "success", responses: gs.tripResponsesFrom_(grid(db.tables.Responses), data.tripId) };
    case "hubSubmit": {
      const spec = HUB_RECORDS[data.kind];
      if (!spec) return err("invalid", "Unknown record type.");
      a = auth(data, spec.permission); if (a.error) return a.error;
      const trip = tripConfig(data.tripId);
      if (!trip) return err("not_found", "Trip not found.");
      const meta = gs.hubMeta_(data);
      // An entry made offline (it arrives late) is still accepted when the trip has closed since.
      if (spec.tripFlag && !truthy(trip[spec.tripFlag]) && !meta.late) return err("closed", spec.closedMessage);
      if (meta.clientId && db.tables[spec.tab].some((r) => r["Client ID"] === meta.clientId)) return { status: "success", duplicate: true };
      const clean = gs.cleanRecordFields_(data.values, gs.hubReservedNames_(spec));
      if (clean.error) return err("invalid", clean.error);
      let url = "";
      if (spec.photoColumn && data.photo && data.photo.data) {
        const buf = Buffer.from(String(data.photo.data), "base64");
        if (buf.length > MAX_PHOTO_BYTES) return err("invalid", "That photo is too large.");
        if (buf[0] !== 0xff || buf[1] !== 0xd8) return err("invalid", "The photo must be a JPEG image.");
        photos.push(buf);
        url = "http://localhost:" + PORT + "/dev/receipt/" + (photos.length - 1) + ".jpg";
      }
      const server = gs.hubServerFields_(spec, trip, url, a.info.email, meta);
      db.tables[spec.tab].push(Object.assign({}, server.before, clean.fields, server.after));
      return { status: "success" };
    }
  }
  return err("invalid", "Unknown action.");
}


function listTripTemplates(data) {
  const a = auth(data, "manageTrips"); if (a.error) return a.error;
  return { status: "success", trips: tripTemplates() };
}

function tripTemplates() {
  return [...db.trips].sort((x, y) => (x.tripId < y.tripId ? 1 : x.tripId > y.tripId ? -1 : 0)).map((t) => gs.tripTemplateFromRow_(t));
}

function addTrip(data) {
  const info = verify(data.idToken);
  if (!info) return SIGNIN_ERR;
  if (!info.emailVerified || !permissionsFor(info.email).manageTrips) return err("not_allowed", "Your account (" + info.email + ") is not allowed to manage trips. Ask a leader to tick manageTrips for you on the Leaders sheet.");
  const rec = gs.buildTripRecord_(data.values);
  if (rec.error) return err("invalid", rec.error);
  const tripId = gs.nextTripId_(rec.month, db.trips.map((t) => t.tripId));
  if (!tripId) return err("invalid", "That month already has 99 trips.");
  db.trips.push(Object.assign({ tripId }, rec.fields, rec.after));
  db.tables["Trip Log"].push([new Date().toISOString(), info.email, rec.fields.tripTitle || "", rec.fields.tripDates || ""]);
  return { status: "success", tripId };
}

// Saved profiles: the real planning (who may update which row, what the columns are) from
// apps-script/Slip.gs, applied to an in-memory grid per tab like a sheet.
function saveProfile(kind, email, profileData) {
  const spec = Object.prototype.hasOwnProperty.call(gs.SLIP_KINDS, String(kind)) ? gs.SLIP_KINDS[kind] : null;
  if (!spec) return err("invalid", "Unknown profile type.");
  const clean = gs.cleanRecordFields_(profileData, [], { textCells: true });
  if (clean.error) return err("invalid", clean.error);
  const grid = (db.profiles[spec.profileTab] = db.profiles[spec.profileTab] || []);
  const plan = gs.planProfileSave_(grid, spec, email, clean.fields);
  if (plan.error) return err("invalid", plan.error);
  grid[0] = [...plan.headers];
  if (plan.rowIndex >= 0) grid[plan.rowIndex] = [...plan.row]; else grid.push([...plan.row]);
  return { status: "success" };
}

function profilesFor(email) {
  return Object.fromEntries(Object.entries(gs.SLIP_KINDS).map(([kind, spec]) => [kind, gs.profileRowsFor_(db.profiles[spec.profileTab] || [], email)]));
}

function slipPost(data) {
  if (data.action === "getProfile") {
    const info = verify(data.idToken);
    if (!info || !info.emailVerified || !info.email) return { error: "unauthorized" };
    return { status: "success", profiles: profilesFor(info.email) };
  }
  if (data.action === "saveProfile") {
    const info = verify(data.idToken);
    if (!info || !info.emailVerified || !info.email) return { status: "error", message: "unauthorized" };
    return saveProfile(data.kind, info.email, data.profileData);
  }
  if (data.action === "slipTrip") {
    if (!verify(data.idToken)) return err("signin", "Please sign in to view this trip.");
    const t = tripConfig(data.tripId);
    if (!t) return err("not_found", "Trip not found.");
    return truthy(t.acceptingResponses) ? t : err("closed", "This trip is not accepting permission slips.");
  }
  if (!verify(data._idToken)) return err("signin", "Your sign-in has expired. Please sign in again; your entries are still on the form.");
  const trip = tripConfig(data._tripId);
  if (!trip) return err("not_found", "Trip not found.");
  if (!truthy(trip.acceptingResponses)) return err("closed", "This trip is no longer accepting permission slips.");
  // A changed trip revision is accepted (the real script adds a note to the Flags column).
  const server = new Set(["action", "idToken", "googleUserId", "Flags", "PDF Link", "tripId", "formVersion", "wordingHash", "website_url"]);
  const row = { Timestamp: new Date().toISOString() };
  Object.entries(data).forEach(([k, v]) => { if (!k.startsWith("_") && !server.has(k)) row[k] = Array.isArray(v) ? v.join(", ") : typeof v === "object" ? JSON.stringify(v) : String(v).slice(0, 1000); });
  row.tripId = trip.tripId;
  db.tables.Responses.push(row);
  return { status: "success" };
}

function api(method, query, body) {
  if (method === "GET") return err("signin", "Sign in required.");
  const data = JSON.parse(body);
  if (data.action === "authRequestCode") return authRequestCode(data);
  if (data.action === "authVerifyCode") return authVerifyCode(data);
  if (data.action === "authExchange") return authExchange(data);
  if (data.action === "addTrip") return addTrip(data);
  if (data.action === "listTripTemplates") return listTripTemplates(data);
  if (typeof data.action === "string" && data.action.startsWith("hub")) return hub(data);
  return slipPost(data);
}

// ---- http ----
function serveStatic(urlPath, res) {
  const rel = urlPath === "/" ? "index.html" : decodeURIComponent(urlPath).replace(/^\/+/, "");
  const file = rel === "config.js" ? path.join(__dirname, "config.local.js") : rel === "dev/mock-gsi.js" ? path.join(__dirname, "mock-gsi.js") : path.join(SITE, rel);
  const allowed = rel === "dev/mock-gsi.js" || !rel.startsWith(".");
  if (!allowed || !path.resolve(file).startsWith(ROOT) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); return res.end("Not found"); }
  let body = fs.readFileSync(file);
  const type = MIME[path.extname(file)] || "application/octet-stream";
  if (type === "text/html") body = Buffer.from(body.toString().replace(GSI_TAG, '<script src="/dev/mock-gsi.js"></script>'));
  res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(body);
}

http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname === "/api") {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", async () => {
      await new Promise((r) => setTimeout(r, 2000));
      let out;
      try { out = api(req.method, url.searchParams, body); } catch (e) { out = err("error", String(e)); }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(out));
    });
  } else if (url.pathname === "/dev/state") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(db, null, 2));
  } else if (/^\/dev\/receipt\/\d+\.jpg$/.test(url.pathname)) {
    const img = photos[Number(url.pathname.match(/(\d+)\.jpg$/)[1])];
    if (!img) { res.writeHead(404); return res.end("Not found"); }
    res.writeHead(200, { "Content-Type": "image/jpeg" });
    res.end(img);
  } else serveStatic(url.pathname, res);
}).listen(PORT, () => console.log("Troop Hub dev server: http://localhost:" + PORT + "  (leaders: " + [...LEADERS].map(([e, p]) => e + " [" + p.join("+") + "]").join(", ") + ")\nState dump: /dev/state"));
