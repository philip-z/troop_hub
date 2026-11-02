// Offline support shared by every page (loaded after auth.js):
//   - a small per-user cache in localStorage (the hub session: permissions, trips, add-trip
//     templates; a trip's float-plan roster), so pages open and show the last known data with no signal
//   - an outbox in IndexedDB: entries made while offline (receipts, payments, reimbursements) are
//     saved on the device with a unique ID and sent when the connection returns; the server ignores a
//     repeat of an ID it already has, so a retry can never create a second row
//   - wipeAll(): everything above is deleted when someone signs out on purpose
// The service worker (sw.js) is registered here too; it keeps the pages themselves available offline.
(function (root) {
  const CACHE_PREFIX = "troop58_c_";
  // Everything that holds trip, roster, profile or draft data. (The sign-in token is not in this
  // list: auth.js removes it when signing out.)
  const WIPE_PREFIXES = [CACHE_PREFIX, "troop58_session", "troop58_trips", "troop58_equipment",
    "troop58_profiles_", "troop58_scouts_", "troop58_form_draft_"];

  // env: { localStorage, sessionStorage, outboxStore, crypto? } so the logic can run in tests.
  // outboxStore: { add(item), put(item), remove(id), clear(), list() }, all returning promises.
  function create(env) {
    const local = env.localStorage, session = env.sessionStorage, store = env.outboxStore;
    const norm = (email) => String(email || "").trim().toLowerCase();
    const cacheKey = (email, name) => CACHE_PREFIX + norm(email) + "|" + name;

    // ---- per-user cache: { at (ms), data } ----
    function cacheGet(email, name) {
      try {
        const v = JSON.parse(local.getItem(cacheKey(email, name)));
        return v && typeof v === "object" && "data" in v ? v : null;
      } catch (e) { return null; }
    }
    function cacheSet(email, name, data) {
      try { local.setItem(cacheKey(email, name), JSON.stringify({ at: Date.now(), data })); }
      catch (e) { /* storage full or blocked: the page just works online-only */ }
    }
    // Keeps the data (for offline use) but makes the next page load refresh it.
    function cacheStale(email, name) {
      const v = cacheGet(email, name);
      if (v) { v.at = 0; try { local.setItem(cacheKey(email, name), JSON.stringify(v)); } catch (e) { /* ignore */ } }
    }

    function wipeStorage(s) {
      const keys = [];
      for (let i = 0; i < s.length; i++) keys.push(s.key(i));
      keys.filter((k) => WIPE_PREFIXES.some((p) => k.indexOf(p) === 0)).forEach((k) => s.removeItem(k));
    }
    async function wipeAll() {
      wipeStorage(local);
      wipeStorage(session);
      await store.clear();
    }

    // ---- outbox ----
    // item: { id, email, kind, payload, createdAt (ISO), status: "pending" | "failed", error, attempts }
    const outbox = {
      async add(item) {
        const saved = Object.assign({ status: "pending", error: "", attempts: 0 }, item, { email: norm(item.email) });
        await store.add(saved);
        return saved;
      },
      async list(email) {
        const all = await store.list();
        return all
          .filter((i) => !email || i.email === norm(email))
          .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1));
      },
      update: (item) => store.put(item),
      remove: (id) => store.remove(id),
      async retry(id) {
        const item = (await store.list()).find((i) => i.id === id);
        if (item) { item.status = "pending"; item.error = ""; await store.put(item); }
      },
      async countAll() { return (await store.list()).length; }
    };

    // Sends this person's pending items oldest first. sender(item) resolves to
    //   { ok: true }                       sent: the item is removed
    //   { ok: false, retry: true }         no connection / signed out / server hiccup: stop, keep everything pending
    //   { ok: false, message }             the server refused it: keep it, marked failed, and go on to the next
    // Only one flush runs at a time (a second call returns at once). Returns { sent, failed }.
    let flushing = false;
    async function flush(email, sender, onChange) {
      const result = { sent: 0, failed: 0 };
      if (flushing) return result;
      flushing = true;
      try {
        const items = (await outbox.list(email)).filter((i) => i.status === "pending");
        for (const item of items) {
          item.attempts = (item.attempts || 0) + 1;
          const r = await sender(item);
          if (r.ok) { await outbox.remove(item.id); result.sent++; }
          else if (r.retry) { await outbox.update(item); break; }
          else { item.status = "failed"; item.error = r.message || "The server did not accept this."; await outbox.update(item); result.failed++; }
          if (onChange) onChange();
        }
      } finally {
        flushing = false;
        if (onChange) onChange();
      }
      return result;
    }

    function uuid() {
      const c = env.crypto || root.crypto;
      if (c && c.randomUUID) return c.randomUUID();
      const bytes = new Uint8Array(16);
      c.getRandomValues(bytes);
      return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    }

    return { cacheGet, cacheSet, cacheStale, wipeAll, outbox, flush, uuid };
  }

  // ---- IndexedDB store for the outbox (browser only) ----
  function idbStore(indexedDB) {
    const STORE = "outbox";
    const open = () => new Promise((resolve, reject) => {
      const req = indexedDB.open("troop58", 1);
      req.onupgradeneeded = () => { req.result.createObjectStore(STORE, { keyPath: "id" }); };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const run = (mode, fn) => open().then((db) => new Promise((resolve, reject) => {
      const t = db.transaction(STORE, mode);
      const req = fn(t.objectStore(STORE));
      t.oncomplete = () => { db.close(); resolve(req && req.result); };
      t.onerror = t.onabort = () => { db.close(); reject(t.error || new Error("Storage error")); };
    }));
    return {
      add: (item) => run("readwrite", (s) => s.add(item)),
      put: (item) => run("readwrite", (s) => s.put(item)),
      remove: (id) => run("readwrite", (s) => s.delete(id)),
      clear: () => run("readwrite", (s) => s.clear()),
      list: () => run("readonly", (s) => s.getAll())
    };
  }
  function unavailableStore() {
    const no = () => Promise.reject(new Error("Offline storage is not available in this browser."));
    return { add: no, put: no, remove: no, clear: () => Promise.resolve(), list: () => Promise.resolve([]) };
  }

  if (typeof window !== "undefined") {
    let store;
    try { store = window.indexedDB ? idbStore(window.indexedDB) : unavailableStore(); } catch (e) { store = unavailableStore(); }
    window.TroopOffline = create({ localStorage: window.localStorage, sessionStorage: window.sessionStorage, outboxStore: store });

    // Ask the browser not to evict this site's data when space is short (best effort).
    try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (e) { /* ignore */ }
    if ("serviceWorker" in navigator) {
      window.addEventListener("load", () => { navigator.serviceWorker.register("sw.js").catch(() => {}); });
    }
  }
  if (typeof module !== "undefined" && module.exports) module.exports = { create };
})(typeof window !== "undefined" ? window : globalThis);
