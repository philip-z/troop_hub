(function () {
  const C = window.TROOP_CONFIG, L = window.TroopLib;
  const $ = (id) => document.getElementById(id);
  const NO_PERMS = { manageTrips: false, recordReimbursements: false };
  let idToken = null, email = "", perms = NO_PERMS, trips = [], meals = [];

  function msg(t, err) { const m = $("msg"); m.textContent = t || ""; m.style.color = err ? "#b00020" : "#1b5e20"; }

  // The Apps Script web app verifies the Google ID token and enforces who may do what.
  // Sent as text/plain so the browser skips the CORS preflight Apps Script can't answer.
  // Errors carry what the caller needs to decide whether to try again later:
  //   err.network  no connection (or it timed out)    err.retry  the server hiccuped (bad status/reply)
  //   err.code     the server's code, e.g. "signin" or "not_allowed"
  async function api(action, payload, timeoutMs) {
    const ctl = timeoutMs ? new AbortController() : null;
    const timer = ctl && setTimeout(() => ctl.abort(), timeoutMs);
    let res;
    try {
      res = await fetch(C.APPS_SCRIPT_URL, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify(Object.assign({}, payload, { action, idToken })),
        signal: ctl ? ctl.signal : undefined
      });
    } catch (e) {
      throw Object.assign(new Error("There is no connection to the server."), { network: true });
    } finally { if (timer) clearTimeout(timer); }
    if (!res.ok) throw Object.assign(new Error("Server error " + res.status), { retry: true });
    let d;
    try { d = await res.json(); }
    catch (e) { throw Object.assign(new Error("The server sent a reply that could not be read."), { retry: true }); }
    if (d.status === "error" || d.error) {
      if (d.code === "signin") TroopAuth.signOut();
      throw Object.assign(new Error(d.message || d.error), { code: d.code });
    }
    return d;
  }

  // ---- Offline: saved session + outbox (see offline.js) ----
  const O = window.TroopOffline;
  const SESSION_FRESH_MS = 10 * 60 * 1000; // a saved session newer than this is used without asking the server
  const KIND_LABEL = { receipt: "Receipt", payment: "Payment", reimbursement: "Reimbursement" };

  function applySession(res) {
    perms = Object.assign({}, NO_PERMS, res.permissions);
    if (res.trips) trips = res.trips;
  }
  function showStale(on) { $("stale-note").hidden = !on; }

  async function onSignIn(token, claims) {
    idToken = token;
    email = String(claims.email || "").toLowerCase();
    try {
      const saved = O.cacheGet(email, "session");
      if (saved) {
        // Show what this device last saw straight away; refresh in the background if it is getting old.
        applySession(saved.data);
        await showApp();
        if (Date.now() - saved.at > SESSION_FRESH_MS) refreshSession();
      } else {
        const res = await api("hubSession");
        O.cacheSet(email, "session", res);
        applySession(res);
        await showApp();
      }
    } catch (e) {
      msg(e.network ? "You're offline and nothing is saved on this device yet. Connect once to load your trips." : e.message, true);
    }
    flushOutbox();
  }
  async function refreshSession() {
    const who = email;
    try {
      const res = await api("hubSession");
      if (who !== email) return;
      O.cacheSet(email, "session", res);
      applySession(res);
      showStale(false);
      await showApp();
    } catch (e) {
      if (e.network || e.retry) showStale(true);
      else if (e.code !== "signin") msg(e.message, true);
    }
  }
  // Only the screen is reset here. This also runs when a session merely expires, and then the saved
  // data and the outbox must stay; deleting them is the sign-out button's job (TroopAuth.userSignOut).
  function onSignOut() {
    idToken = null; email = ""; perms = NO_PERMS; trips = [];
    loaded.equipment = loaded.meals = false; equipment = []; recipes = [];
    $("equipment").textContent = ""; $("equipment-status").textContent = "";
    showStale(false); $("outbox").hidden = true;
    $("app").hidden = true; $("signout").hidden = true; $("signin").hidden = false; $("user").textContent = "";
  }

  // Every receipt, payment and reimbursement is written to the outbox first and then sent, so it
  // survives losing signal or closing the page. The clientId makes a repeat harmless: the server
  // ignores an ID it already has. Resolves { queued: true } when it could not be sent yet.
  async function submitRecord(kind, tripId, values, photo) {
    const payload = { kind, tripId, values, photo, clientId: O.uuid(), enteredAt: new Date().toISOString() };
    let item;
    try {
      item = await O.outbox.add({ id: payload.clientId, email, kind: "hubSubmit", payload, createdAt: payload.enteredAt });
    } catch (e) {
      await api("hubSubmit", payload); // no offline storage in this browser: send straight away
      return {};
    }
    renderOutbox();
    const r = await sendItem(item);
    if (r.ok) { await O.outbox.remove(item.id); renderOutbox(); return {}; }
    if (r.retry) { renderOutbox(); return { queued: true, signin: r.signin }; }
    await O.outbox.remove(item.id); // refused: the person fixes the form and tries again
    renderOutbox();
    throw new Error(r.message);
  }
  async function sendItem(item) {
    try { await api("hubSubmit", item.payload, 45000); return { ok: true }; }
    catch (e) {
      if (e.network || e.retry || e.code === "signin") return { ok: false, retry: true, signin: e.code === "signin", message: e.message };
      return { ok: false, message: e.message };
    }
  }
  async function flushOutbox() {
    if (!email || !idToken || navigator.onLine === false) { renderOutbox(); return; }
    let r;
    try { r = await O.flush(email, sendItem, renderOutbox); } catch (e) { return; }
    if (r.sent) msg("Sent " + r.sent + " saved item" + (r.sent === 1 ? "" : "s") + ".");
  }
  function describeItem(item) {
    const p = item.payload || {};
    const trip = trips.find((t) => t.tripId === p.tripId);
    const vals = Object.values(p.values || {}).map(String).filter(Boolean).slice(0, 2).join(", ");
    return (KIND_LABEL[p.kind] || p.kind) + (trip ? " for " + trip.tripTitle : "") + (vals ? " (" + vals + ")" : "");
  }
  async function renderOutbox() {
    let items = [];
    try { items = email ? await O.outbox.list(email) : []; } catch (e) { /* no offline storage */ }
    $("outbox").hidden = !items.length;
    if (!items.length) return;
    const pending = items.filter((i) => i.status === "pending").length;
    $("outbox-summary").textContent = pending
      ? pending + " saved item" + (pending === 1 ? " is" : "s are") + " waiting to be sent" + (navigator.onLine === false ? " (you're offline)." : ".")
      : "";
    $("outbox-send").hidden = !pending;
    const ul = $("outbox-list"); ul.textContent = "";
    items.forEach((item) => {
      const li = document.createElement("li");
      li.textContent = (item.status === "failed" ? "Not accepted: " : "Waiting: ") + describeItem(item) + (item.status === "failed" ? " \u2014 " + item.error : "");
      const button = (label, fn) => { const b = document.createElement("button"); b.type = "button"; b.textContent = label; b.onclick = fn; li.append(" ", b); };
      if (item.status === "failed") button("Try again", async () => { await O.outbox.retry(item.id); flushOutbox(); });
      button("Remove", async () => {
        if (item.status === "pending" && !confirm("Delete this saved item without sending it?")) return;
        await O.outbox.remove(item.id); renderOutbox();
      });
      ul.appendChild(li);
    });
  }
  $("outbox-send").onclick = flushOutbox;
  window.addEventListener("online", flushOutbox);
  window.addEventListener("offline", renderOutbox);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") flushOutbox(); });

  async function showApp() {
    $("signin").hidden = true; $("signout").hidden = false; $("app").hidden = false;
    $("user").textContent = email;
    $("add-trip").hidden = !perms.manageTrips;
    if (perms.manageTrips) {
      const addTripP = $("add-trip");
      if (!addTripP.querySelector("button")) {
        addTripP.textContent = "";
        const addTripBtn = document.createElement("button");
        addTripBtn.textContent = "Add a new trip";
        addTripBtn.onclick = () => { location.href = "add-trip.html"; };
        addTripP.append(addTripBtn);
      }
    }
    const eqLink = $("equipment-link");
    if (eqLink && !eqLink.querySelector("button") && eqLink.tagName !== "BUTTON") {
      const p = eqLink.parentElement;
      p.textContent = "";
      const eqBtn = document.createElement("button");
      eqBtn.textContent = "Submit equipment borrowed, assigned for cleaning, or returned";
      eqBtn.onclick = () => { window.open(C.EQUIPMENT_FORM_URL, "_blank"); };
      p.append(eqBtn);
    }
    selectTab(location.hash.slice(1), false);
    if (!trips.length) {
      await loadTrips();
    } else {
      renderTrips();
      msg("");
    }
  }

  // Tabs (ARIA tabs pattern): click, Left/Right/Home/End, and #trips / #equipment / #meals deep links.
  const TABS = ["trips", "equipment", "meals"];
  function selectTab(name, focus) {
    if (!TABS.includes(name)) name = TABS[0];
    TABS.forEach((n) => {
      const on = n === name, tab = $("tab-" + n);
      tab.setAttribute("aria-selected", on); tab.tabIndex = on ? 0 : -1;
      $("panel-" + n).hidden = !on;
      if (on) { tab.scrollIntoView({ block: "nearest", inline: "nearest" }); ensureLoaded(n); if (focus) tab.focus(); }
    });
    if (focus && location.hash !== "#" + name) history.replaceState(null, "", "#" + name);
  }
  TABS.forEach((n, i) => {
    $("tab-" + n).onclick = () => selectTab(n, true);
    $("tab-" + n).onkeydown = (ev) => {
      const k = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: TABS.length - 1 }[ev.key];
      if (k === undefined) return;
      ev.preventDefault(); selectTab(TABS[(k + TABS.length) % TABS.length], true);
    };
  });
  window.addEventListener("hashchange", () => { if (!$("app").hidden) selectTab(location.hash.slice(1), false); });

  // Equipment and recipes live in their own spreadsheets; each is fetched the first time its tab opens.
  const loaded = { equipment: false, meals: false };
  let equipment = [], recipes = [];
  function ensureLoaded(name) {
    if (name === "equipment" && !loaded.equipment) loadEquipment();
    if (name === "meals" && !loaded.meals) loadRecipes();
  }
  async function loadEquipment() {
    loaded.equipment = true;
    $("equipment-status").textContent = "Loading...";
    try { equipment = (await api("hubListEquipment")).items; renderEquipment(); }
    catch (e) { loaded.equipment = false; $("equipment-status").textContent = "Could not load equipment: " + e.message; }
  }
  // Which sheet columns make up an item comes from data-* on #equipment in index.html.
  function renderEquipment() {
    const cols = $("equipment").dataset;
    const details = (cols.details || "").split(",").map((c) => c.trim()).filter(Boolean);
    const shownCols = [cols.title, cols.count, ...details].filter(Boolean);
    const q = $("equipment-filter").value.trim().toLowerCase();
    const shown = equipment.filter((i) => !q || shownCols.map((c) => i[c] || "").join(" ").toLowerCase().includes(q));
    $("equipment-status").textContent = shown.length ? "" : (equipment.length ? "No equipment matches." : "No equipment listed yet.");
    const ul = $("equipment"); ul.textContent = "";
    shown.forEach((i) => {
      const li = document.createElement("li");
      const h = document.createElement("strong"); h.textContent = (i[cols.title] || "") + (cols.count && i[cols.count] ? " (" + i[cols.count] + ")" : "");
      const d = document.createElement("div");
      d.textContent = details.map((c) => i[c]).filter(Boolean).join(" · ");
      li.append(h, d); ul.appendChild(li);
    });
  }
  $("equipment-filter").oninput = renderEquipment;

  async function loadRecipes() {
    loaded.meals = true;
    try {
      recipes = (await api("hubListRecipes")).items;
      const sel = $("recipe-pick"); sel.length = 1;
      recipes.forEach((r, i) => { const o = document.createElement("option"); o.value = String(i); o.textContent = r[sel.dataset.label] || ""; sel.appendChild(o); });
      $("recipe-pick-row").hidden = !recipes.length;
    } catch (e) { loaded.meals = false; $("recipe-pick-row").hidden = true; }
  }
  $("recipe-pick").onchange = (ev) => {
    const r = recipes[Number(ev.target.value)];
    if (!r) return;
    // Each input's data-recipe names the Recipes column that fills it (index.html).
    Array.from($("recipe-form").elements).forEach((el) => {
      const v = el.dataset.recipe && r[el.dataset.recipe];
      if (v === undefined || v === "" || v === false) return;
      if (el.type === "number" && !(Number(v) > 0)) return;
      el.value = v;
    });
  };

  async function loadTrips() {
    try { trips = (await api("hubListTrips")).trips; renderTrips(); msg(""); }
    catch (e) { msg("Could not load trips: " + e.message, true); }
  }

  function renderTrips() {
    const ul = $("trips"); ul.textContent = "";
    if (!trips.length) ul.textContent = "No trips yet.";
    trips.forEach((t) => {
      const li = document.createElement("li");
      const h = document.createElement("strong"); h.textContent = t.tripTitle;
      const p = document.createElement("div");
      p.textContent = [t.tripDates, t.tripLocation, t.tripCost ? "$" + t.tripCost : ""].filter(Boolean).join(" · ");
      const actions = document.createElement("div"); actions.className = "actions";
      li.append(h, p, actions);
      const button = (label, fn) => { const b = document.createElement("button"); b.textContent = label; b.onclick = fn; actions.append(b); };
      const navButton = (label, url) => {
        const b = document.createElement("button");
        b.textContent = label;
        b.type = "button";
        b.onclick = () => { location.href = url; };
        actions.append(b);
      };
      if (t.acceptingResponses) {
        navButton("Permission slip", "slip.html?trip=" + encodeURIComponent(t.tripId));
      }
      if (perms.manageTrips) navButton("Float plan", "float-plan.html?trip=" + encodeURIComponent(t.tripId));
      if (t.acceptingReceipts) button("Submit receipt", () => openReceipt(t));
      if (perms.manageTrips) button("Record payment", () => openPayment(t));
      if (perms.recordReimbursements) button("Record reimbursement", () => openReimbursement(t));
      ul.appendChild(li);
    });
  }

  // Shrinks a photo to a JPEG (longest side 1600px) so phone photos upload quickly and fit
  // Apps Script's limits. Returns base64 without the data: prefix.
  async function photoToBase64(file) {
    if (!file || !file.size) return "";
    if (!file.type.startsWith("image/")) throw new Error("Please choose an image file.");
    let bmp;
    try { bmp = await createImageBitmap(file); }
    catch (e) { throw new Error("That image format isn't supported by this browser. Try a JPEG or PNG."); }
    const scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bmp.width * scale); canvas.height = Math.round(bmp.height * scale);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, canvas.width, canvas.height); // PNG transparency -> white
    ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((ok) => canvas.toBlob(ok, "image/jpeg", 0.8));
    return new Promise((ok, fail) => {
      const r = new FileReader();
      r.onload = () => ok(String(r.result).split(",")[1]);
      r.onerror = () => fail(new Error("Could not read the photo."));
      r.readAsDataURL(blob);
    });
  }

  function dialogFlow(dialogId, formId, cancelId, title, titleId, onSubmit) {
    const d = $(dialogId), f = $(formId);
    f.reset(); $(titleId).textContent = title; d.showModal();
    $(cancelId).onclick = () => d.close();
    f.onsubmit = async (ev) => {
      ev.preventDefault();
      const submit = f.querySelector("button[value=ok]");
      submit.disabled = true;
      try {
        const r = await onSubmit(Object.fromEntries(new FormData(f)));
        d.close();
        msg(r && r.queued
          ? (r.signin ? "Saved on this device. Sign in again and it will be sent." : "Saved on this device. It will be sent when you have a connection.")
          : "Submitted. Thank you!");
      }
      catch (e) { msg(e.message, true); }
      finally { submit.disabled = false; }
    };
  }
  function openReceipt(t) {
    const preview = $("receipt-preview");
    preview.hidden = true;
    $("receipt-photo").onchange = (ev) => {
      const file = ev.target.files[0];
      if (preview.src.startsWith("blob:")) URL.revokeObjectURL(preview.src);
      preview.hidden = !file;
      if (file) preview.src = URL.createObjectURL(file);
    };
    dialogFlow("receipt-dialog", "receipt-form", "receipt-cancel", "Receipt: " + t.tripTitle, "receipt-title",
      async (v) => {
        const { photo, ...values } = v;
        const data = await photoToBase64(photo);
        return submitRecord("receipt", t.tripId, values, data ? { data } : null);
      });
  }

  function openPayment(t) {
    dialogFlow("payment-dialog", "payment-form", "payment-cancel", "Payment: " + t.tripTitle, "payment-title",
      (v) => submitRecord("payment", t.tripId, v));
  }
  function openReimbursement(t) {
    dialogFlow("reimb-dialog", "reimb-form", "reimb-cancel", "Reimbursement: " + t.tripTitle, "reimb-title",
      (v) => submitRecord("reimbursement", t.tripId, v));
  }

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

  TroopAuth.start({ buttonId: "signin", onSignIn, onSignOut });
  $("signout").onclick = TroopAuth.userSignOut;
})();
