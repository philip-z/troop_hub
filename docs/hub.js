(function () {
  const C = window.TROOP_CONFIG, L = window.TroopLib;
  const $ = (id) => document.getElementById(id);
  const NO_PERMS = { addTrips: false, recordPayments: false, recordReimbursements: false };
  let idToken = null, email = "", perms = NO_PERMS, trips = [], meals = [];

  function msg(t, err) { const m = $("msg"); m.textContent = t || ""; m.style.color = err ? "#b00020" : "#1b5e20"; }

  // The Apps Script web app verifies the Google ID token and enforces who may do what.
  // Sent as text/plain so the browser skips the CORS preflight Apps Script can't answer.
  async function api(action, payload) {
    const res = await fetch(C.APPS_SCRIPT_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(Object.assign({}, payload, { action, idToken }))
    });
    if (!res.ok) throw new Error("Server error " + res.status);
    const d = await res.json();
    if (d.status === "error" || d.error) {
      if (d.code === "signin") TroopAuth.signOut();
      throw new Error(d.message || d.error);
    }
    return d;
  }
  const submitRecord = (kind, values) => api("hubSubmit", { kind, values });

  async function onSignIn(token, claims) {
    idToken = token;
    try {
      email = claims.email || "";
      perms = Object.assign({}, NO_PERMS, (await api("hubSession")).permissions);
      await showApp();
    } catch (e) { msg(e.message, true); }
  }
  function onSignOut() {
    idToken = null; email = ""; perms = NO_PERMS;
    loaded.equipment = loaded.meals = false; equipment = []; recipes = [];
    $("equipment").textContent = ""; $("equipment-status").textContent = "";
    $("app").hidden = true; $("signout").hidden = true; $("signin").hidden = false; $("user").textContent = "";
  }
  async function showApp() {
    $("signin").hidden = true; $("signout").hidden = false; $("app").hidden = false;
    $("user").textContent = email;
    $("add-trip").hidden = !perms.addTrips;
    $("equipment-link").href = C.EQUIPMENT_FORM_URL;
    selectTab(location.hash.slice(1), false);
    await loadTrips();
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
  function renderEquipment() {
    const q = $("equipment-filter").value.trim().toLowerCase();
    const shown = equipment.filter((i) => !q || [i.item, i.category, i.status, i.notes].join(" ").toLowerCase().includes(q));
    $("equipment-status").textContent = shown.length ? "" : (equipment.length ? "No equipment matches." : "No equipment listed yet.");
    const ul = $("equipment"); ul.textContent = "";
    shown.forEach((i) => {
      const li = document.createElement("li");
      const h = document.createElement("strong"); h.textContent = i.item + (i.quantity ? " (" + i.quantity + ")" : "");
      const d = document.createElement("div");
      d.textContent = [i.category, i.status, i.notes].filter(Boolean).join(" · ");
      li.append(h, d); ul.appendChild(li);
    });
  }
  $("equipment-filter").oninput = renderEquipment;

  async function loadRecipes() {
    loaded.meals = true;
    try {
      recipes = (await api("hubListRecipes")).items;
      const sel = $("recipe-pick"); sel.length = 1;
      recipes.forEach((r, i) => { const o = document.createElement("option"); o.value = String(i); o.textContent = r.name; sel.appendChild(o); });
      $("recipe-pick-row").hidden = !recipes.length;
    } catch (e) { loaded.meals = false; $("recipe-pick-row").hidden = true; }
  }
  $("recipe-pick").onchange = (ev) => {
    const r = recipes[Number(ev.target.value)];
    if (!r) return;
    const f = $("recipe-form").elements;
    f.name.value = r.name; f.ingredients.value = r.ingredients; if (Number(r.serves) > 0) f.from.value = r.serves;
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
      const h = document.createElement("strong"); h.textContent = t.name;
      const p = document.createElement("div");
      p.textContent = [t.date, t.location, t.cost ? "$" + t.cost : ""].filter(Boolean).join(" · ");
      const actions = document.createElement("div"); actions.className = "actions";
      li.append(h, p, actions);
      const button = (label, fn) => { const b = document.createElement("button"); b.textContent = label; b.onclick = fn; actions.append(b); };
      if (t.acceptingResponses) {
        const a = document.createElement("a"); a.textContent = "Permission slip"; a.href = "slip.html?trip=" + encodeURIComponent(t.id);
        actions.append(a);
      }
      if (t.acceptingReceipts) button("Submit receipt", () => openReceipt(t));
      if (perms.recordPayments) button("Record payment", () => openPayment(t));
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
      try { await onSubmit(Object.fromEntries(new FormData(f))); d.close(); msg("Submitted. Thank you!"); }
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
    dialogFlow("receipt-dialog", "receipt-form", "receipt-cancel", "Receipt: " + t.name, "receipt-title",
      async (v) => {
        const data = await photoToBase64(v.photo);
        await submitRecord("receipt", { tripId: t.id, description: v.description, amount: v.amount, photo: data ? { data } : null });
      });
  }

  function openPayment(t) {
    dialogFlow("payment-dialog", "payment-form", "payment-cancel", "Payment: " + t.name, "payment-title",
      (v) => submitRecord("payment", { tripId: t.id, scout: v.scout, amount: v.amount, method: v.method }));
  }
  function openReimbursement(t) {
    dialogFlow("reimb-dialog", "reimb-form", "reimb-cancel", "Reimbursement: " + t.name, "reimb-title",
      (v) => submitRecord("reimbursement", { tripId: t.id, payee: v.payee, amount: v.amount, notes: v.notes }));
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
  $("signout").onclick = TroopAuth.signOut;
})();
