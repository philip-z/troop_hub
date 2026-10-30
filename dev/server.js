// Local dev server: static files + an in-memory mock of the Apps Script web app.
//   npm run dev                           (http://localhost:5173)
//   LEADERS=a@x.com,b@x.com:recordPayments+recordReimbursements npm run dev   to change the leaders and their permissions
// Mirrors the routes and response shapes in apps-script/*.gs, but is NOT the real
// backend: tokens are not verified with Google, and data resets on restart.
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const ROOT = path.join(__dirname, "..");
const SITE = path.join(ROOT, "docs");
const PORT = Number(process.env.PORT) || 5173;
// LEADERS=email[:perm+perm],... ; no ":" means all permissions. Permissions: addTrips, recordPayments, recordReimbursements.
const PERMS = ["addTrips", "recordPayments", "recordReimbursements"];
const LEADERS = new Map((process.env.LEADERS || "leader@test.com,treasurer@test.com:recordPayments+recordReimbursements").split(",").map((s) => {
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
    { item: "First aid kit", category: "Safety", quantity: "2", status: "Needs restocking", notes: "" }
  ],
  recipes: [
    { name: "Campfire chili", serves: "8", ingredients: "2 lb ground beef\n2 cans kidney beans\n1 1/2 cups diced onion\n2 tbsp chili powder", notes: "Dutch oven" },
    { name: "Pancakes", serves: "6", ingredients: "3 cups flour\n2 cups milk\n2 eggs", notes: "" }
  ],
  profiles: {},   // sub -> parent fields
  youth: {}       // sub -> [youth fields]
};

const truthy = (v) => ["true", "yes", "y", "1", "x"].includes(String(v ?? "").trim().toLowerCase());
const revision = (t) => crypto.createHash("sha256").update(JSON.stringify(t)).digest("base64url");
const tripConfig = (id) => { const t = db.trips.find((x) => x.tripId === String(id || "").trim()); return t ? Object.assign({}, t, { _tripRevision: revision(t) }) : null; };
const cell = (v) => { const s = v == null ? "" : String(v).slice(0, 1000); return /^[=+\-@\t\r]/.test(s) ? "'" + s : s; };
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
const HUB_RECORDS = {
  receipt: { tab: "Receipts", permission: "", fields: ["tripId", "tripName", "description", "amount", "url"] },
  payment: { tab: "Payments", permission: "recordPayments", fields: ["tripId", "scout", "amount", "method"] },
  reimbursement: { tab: "Reimbursements", permission: "recordReimbursements", fields: ["tripId", "payee", "amount", "notes"] }
};

function hub(data) {
  let a;
  switch (data.action) {
    case "hubSession":
      a = auth(data, ""); if (a.error) return a.error;
      return { status: "success", email: a.info.email, permissions: a.info.permissions };
    case "hubListTrips":
      a = auth(data, ""); if (a.error) return a.error;
      return { status: "success", trips: db.trips.map((t) => ({ id: t.tripId, name: t.tripTitle, date: t.tripDates, location: t.tripLocation,
        cost: t.tripCost, acceptingResponses: truthy(t.acceptingResponses), acceptingReceipts: truthy(t.acceptingReceipts) })) };
    case "hubListEquipment":
      a = auth(data, ""); if (a.error) return a.error;
      return { status: "success", items: db.equipment };
    case "hubListRecipes":
      a = auth(data, ""); if (a.error) return a.error;
      return { status: "success", items: db.recipes };
    case "hubSubmit": {
      const spec = HUB_RECORDS[data.kind];
      if (!spec) return err("invalid", "Unknown record type.");
      a = auth(data, spec.permission); if (a.error) return a.error;
      const values = data.values || {};
      const trip = tripConfig(values.tripId);
      if (!trip) return err("not_found", "Trip not found.");
      if (data.kind === "receipt" && !truthy(trip.acceptingReceipts)) return err("closed", "This trip is not accepting receipts.");
      values.tripId = trip.tripId; values.tripName = trip.tripTitle;
      values.url = "";
      if (data.kind === "receipt" && values.photo && values.photo.data) {
        const buf = Buffer.from(String(values.photo.data), "base64");
        if (buf.length > MAX_PHOTO_BYTES) return err("invalid", "That photo is too large.");
        if (buf[0] !== 0xff || buf[1] !== 0xd8) return err("invalid", "The photo must be a JPEG image.");
        photos.push(buf);
        values.url = "http://localhost:" + PORT + "/dev/receipt/" + (photos.length - 1) + ".jpg";
      }
      db.tables[spec.tab].push([new Date().toISOString(), ...spec.fields.map((f) => cell(values[f])), a.info.email]);
      return { status: "success" };
    }
  }
  return err("invalid", "Unknown action.");
}

function nextTripId(month) {
  const prefix = month.replace("-", "");
  const max = Math.max(0, ...db.trips.map((t) => t.tripId).filter((id) => id.length === 8 && id.startsWith(prefix)).map((id) => Number(id.slice(6)) || 0));
  return max >= 99 ? "" : prefix + String(max + 1).padStart(2, "0");
}

function listTripTemplates(data) {
  const a = auth(data, "addTrips"); if (a.error) return a.error;
  const unesc = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
  const trips = db.trips.map((t) => ({
    id: t.tripId, tripTitle: t.tripTitle, tripDates: t.tripDates, tripLocation: t.tripLocation, departureDetails: t.departureDetails,
    departureOptions: [...String(t.customDepartureHtml || "").matchAll(/<option value="([^"]+)">/g)].map((m) => unesc(m[1])).join("\n"),
    returnDetails: t.returnDetails, tripCost: t.tripCost, tripCoordinator: t.tripCoordinator, tripUniform: t.tripUniform
  })).sort((x, y) => (x.id < y.id ? 1 : x.id > y.id ? -1 : 0));
  return { status: "success", trips };
}

function addTrip(data) {
  const info = verify(data.idToken);
  if (!info) return SIGNIN_ERR;
  if (!info.emailVerified || !permissionsFor(info.email).addTrips) return err("not_allowed", "Your account (" + info.email + ") is not allowed to add trips. Ask a leader to tick addTrips for you on the Leaders sheet.");
  const clean = (v) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, 500);
  const cols = ["tripTitle", "tripLocation", "tripDates", "departureDetails", "returnDetails", "tripCost", "tripCoordinator", "tripUniform"];
  const trip = {}; cols.forEach((c) => { trip[c] = clean(data[c]); });
  const missing = ["tripTitle", "tripLocation", "tripDates"].filter((c) => !trip[c]);
  if (missing.length) return err("invalid", "Missing required field(s): " + missing.join(", "));
  const month = String(data.tripMonth || "").trim();
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return err("invalid", "Choose the trip month.");
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  const opts = String(data.departureOptions || "").split(/\r?\n/).map((s) => clean(s).slice(0, 100)).filter(Boolean).slice(0, 20);
  trip.customDepartureHtml = opts.length
    ? esc(trip.departureDetails) + '<br><label for="departureOption"><strong>Departure option:</strong></label> <select id="departureOption" name="Departure Option" required><option value="">-- Choose one --</option>' +
      opts.map((o) => '<option value="' + esc(o) + '">' + esc(o) + "</option>").join("") + "</select><br>"
    : "";
  trip.tripId = nextTripId(month);
  if (!trip.tripId) return err("invalid", "That month already has 99 trips.");
  trip.acceptingResponses = truthy(data.acceptingResponses) ? "TRUE" : "FALSE";
  trip.acceptingReceipts = truthy(data.acceptingReceipts) ? "TRUE" : "FALSE";
  db.trips.push(trip);
  db.tables["Trip Log"].push([new Date().toISOString(), info.email, trip.tripTitle, trip.tripDates]);
  return { status: "success", tripId: trip.tripId };
}

function saveProfile(sub, fields) {
  const youth = {}, parent = {};
  Object.entries(fields).forEach(([k, v]) => { if (k.startsWith("_")) return; (k.startsWith("Youth ") ? youth : parent)[k] = Array.isArray(v) ? v.join(", ") : v; });
  db.profiles[sub] = Object.assign(db.profiles[sub] || {}, parent);
  const name = String(youth["Youth Name"] || "").trim().toLowerCase();
  if (!name) return;
  const list = (db.youth[sub] = db.youth[sub] || []);
  const i = list.findIndex((y) => String(y["Youth Name"]).trim().toLowerCase() === name);
  if (i >= 0) Object.assign(list[i], youth); else list.push(youth);
}

function slipPost(data) {
  if (data.action === "getProfile") {
    const info = verify(data.idToken);
    if (!info) return { error: "unauthorized" };
    return Object.assign({}, db.profiles[info.sub], db.youth[info.sub] ? { youthProfiles: db.youth[info.sub] } : {});
  }
  if (data.action === "saveProfile") {
    const info = verify(data.idToken);
    if (!info) return { status: "error", message: "unauthorized" };
    saveProfile(info.sub, data.profileData || {});
    return { status: "success" };
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
  if (!data._tripRevision || data._tripRevision !== trip._tripRevision) {
    return err("trip_changed", "Trip details have changed. Reload the page, review the updated trip details, and sign again.");
  }
  const server = new Set(["action", "idToken", "googleUserId", "Flags", "PDF Link", "tripId", "formVersion", "wordingHash", "website_url"]);
  const row = { Timestamp: new Date().toISOString() };
  Object.entries(data).forEach(([k, v]) => { if (!k.startsWith("_") && !server.has(k)) row[k] = Array.isArray(v) ? v.join(", ") : typeof v === "object" ? JSON.stringify(v) : String(v).slice(0, 1000); });
  row.tripId = trip.tripId;
  db.tables.Responses.push(row);
  const info = data._idToken && !data.website_url ? verify(data._idToken) : null;
  if (info) {
    const p = Object.assign({}, row);
    ["Timestamp", "Form Type", "tripId"].forEach((k) => delete p[k]);
    Object.keys(p).forEach((k) => { if (k.toLowerCase().includes("signature")) delete p[k]; });
    saveProfile(info.sub, p);
  }
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
    req.on("end", () => {
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
