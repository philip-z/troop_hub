(function () {
  const C = window.TROOP_CONFIG, L = window.TroopLib;
  const $ = (id) => document.getElementById(id);
  const SHEETS = "https://sheets.googleapis.com/v4/spreadsheets/" + C.SPREADSHEET_ID;
  const SCOPES = "https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/userinfo.email";
  let token = null, email = "", trips = [], meals = [];

  function msg(t, err) { const m = $("msg"); m.textContent = t || ""; m.style.color = err ? "#b00020" : "#1b5e20"; }

  async function api(path, opts) {
    const res = await fetch(SHEETS + path, Object.assign({ headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" } }, opts));
    if (!res.ok) throw new Error("Google Sheets error " + res.status);
    return res.json();
  }
  async function readTab(tab) {
    const d = await api("/values/" + encodeURIComponent(tab));
    return L.rowsToObjects(d.values);
  }
  function appendRow(tab, row) {
    return api("/values/" + encodeURIComponent(tab) + ":append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS",
      { method: "POST", body: JSON.stringify({ values: [row.map(L.safeCell)] }) });
  }
  const now = () => new Date().toISOString();

  function signIn() {
    const client = google.accounts.oauth2.initTokenClient({
      client_id: C.GOOGLE_CLIENT_ID, scope: SCOPES,
      callback: async (r) => {
        if (r.error) return msg("Sign-in failed: " + r.error, true);
        token = r.access_token;
        try {
          const u = await (await fetch("https://www.googleapis.com/oauth2/v3/userinfo", { headers: { Authorization: "Bearer " + token } })).json();
          email = u.email || "";
          showApp();
        } catch (e) { msg(e.message, true); }
      }
    });
    client.requestAccessToken();
  }
  function signOut() {
    if (token) google.accounts.oauth2.revoke(token, () => {});
    token = null; email = ""; $("app").hidden = true; $("signout").hidden = true; $("signin").hidden = false; $("user").textContent = "";
  }

  async function showApp() {
    $("signin").hidden = true; $("signout").hidden = false; $("app").hidden = false;
    $("user").textContent = email;
    $("leader").hidden = !L.isLeader(email, C.LEADER_EMAILS);
    $("equipment-link").href = C.EQUIPMENT_FORM_URL;
    await loadTrips();
  }

  async function loadTrips() {
    try { trips = await readTab(C.TABS.trips); renderTrips(); msg(""); }
    catch (e) { msg("Could not load trips: " + e.message, true); }
  }

  function renderTrips() {
    const ul = $("trips"); ul.textContent = "";
    if (!trips.length) ul.textContent = "No trips yet.";
    trips.forEach((t) => {
      const li = document.createElement("li");
      const h = document.createElement("strong"); h.textContent = t.name;
      const p = document.createElement("div");
      p.textContent = [t.date, t.location, t.cost ? "$" + t.cost : "", t.description].filter(Boolean).join(" · ");
      const b1 = document.createElement("button"); b1.textContent = "Permission slip"; b1.onclick = () => openSlip(t);
      const b2 = document.createElement("button"); b2.textContent = "Submit receipt"; b2.onclick = () => openReceipt(t);
      li.append(h, p, b1, b2); ul.appendChild(li);
    });
    document.querySelectorAll(".trip-select").forEach((s) => {
      s.textContent = "";
      trips.forEach((t) => { const o = document.createElement("option"); o.value = t.id || t.name; o.textContent = t.name; s.appendChild(o); });
    });
  }

  function dialogFlow(dialogId, formId, cancelId, title, titleId, onSubmit) {
    const d = $(dialogId), f = $(formId);
    f.reset(); $(titleId).textContent = title; d.showModal();
    $(cancelId).onclick = () => d.close();
    f.onsubmit = async (ev) => {
      ev.preventDefault();
      try { await onSubmit(Object.fromEntries(new FormData(f))); d.close(); msg("Submitted. Thank you!"); }
      catch (e) { msg(e.message, true); }
    };
  }
  function openSlip(t) {
    dialogFlow("slip-dialog", "slip-form", "slip-cancel", "Permission slip: " + t.name, "slip-title",
      (v) => appendRow(C.TABS.slips, [now(), t.id || t.name, t.name, email, v.scout, v.parent, v.phone, v.medical, v.signature]));
  }
  function openReceipt(t) {
    dialogFlow("receipt-dialog", "receipt-form", "receipt-cancel", "Receipt: " + t.name, "receipt-title",
      (v) => appendRow(C.TABS.receipts, [now(), t.id || t.name, t.name, email, v.description, v.amount, v.url]));
  }

  function leaderForm(id, handler) {
    $(id).onsubmit = async (ev) => {
      ev.preventDefault();
      if (!L.isLeader(email, C.LEADER_EMAILS)) return msg("Leaders only.", true);
      const f = ev.target;
      try { await handler(Object.fromEntries(new FormData(f))); f.reset(); msg("Saved."); }
      catch (e) { msg(e.message, true); }
    };
  }
  leaderForm("trip-form", async (v) => {
    await appendRow(C.TABS.trips, [L.newTripId(v.name, v.date), v.name, v.date, v.location, v.cost, v.description]);
    await loadTrips();
  });
  leaderForm("payment-form", (v) => appendRow(C.TABS.payments, [now(), v.trip, v.scout, v.amount, v.method, email]));
  leaderForm("reimb-form", (v) => appendRow(C.TABS.reimbursements, [now(), v.trip, v.payee, v.amount, v.notes, email]));

  // Meal planning (client-side only)
  function renderMeals() {
    const ul = $("meals"); ul.textContent = "";
    meals.forEach((m) => { const li = document.createElement("li"); li.textContent = m.name + " (serves " + m.to + ")"; ul.appendChild(li); });
    const sl = $("shopping"); sl.textContent = "";
    L.shoppingList(meals.flatMap((m) => m.items)).forEach((i) => { const li = document.createElement("li"); li.textContent = L.formatIngredient(i); sl.appendChild(li); });
  }
  $("recipe-form").onsubmit = (ev) => {
    ev.preventDefault();
    const v = Object.fromEntries(new FormData(ev.target));
    try {
      meals.push({ name: v.name, to: v.to, items: L.scaleRecipe(v.ingredients.split("\n"), v.from, v.to) });
      renderMeals(); ev.target.reset();
    } catch (e) { msg(e.message, true); }
  };
  $("clear-meals").onclick = () => { meals = []; renderMeals(); };

  $("signin").onclick = signIn;
  $("signout").onclick = signOut;
})();
