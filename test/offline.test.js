const test = require("node:test");
const assert = require("node:assert");
const { create } = require("../docs/offline.js");

function fakeStorage(initial) {
  const m = new Map(Object.entries(initial || {}));
  return {
    get length() { return m.size; },
    key: (i) => Array.from(m.keys())[i] ?? null,
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
    keys: () => Array.from(m.keys())
  };
}
function memoryStore() {
  const m = new Map();
  return {
    add: async (i) => { if (m.has(i.id)) throw new Error("exists"); m.set(i.id, structuredClone(i)); },
    put: async (i) => { m.set(i.id, structuredClone(i)); },
    remove: async (id) => { m.delete(id); },
    clear: async () => { m.clear(); },
    list: async () => Array.from(m.values()).map((i) => structuredClone(i))
  };
}
function make(initialLocal) {
  const local = fakeStorage(initialLocal), session = fakeStorage();
  const store = memoryStore();
  return { O: create({ localStorage: local, sessionStorage: session, outboxStore: store }), local, session, store };
}
const item = (id, email, at) => ({ id, email, kind: "hubSubmit", payload: { id }, createdAt: at || "2026-11-10T10:00:00.000Z" });

test("cache is kept per user (case-insensitive) and can be marked stale without losing the data", () => {
  const { O } = make();
  O.cacheSet("Mom@x.com", "session", { trips: [1] });
  assert.deepStrictEqual(O.cacheGet("mom@x.com", "session").data, { trips: [1] });
  assert.strictEqual(O.cacheGet("dad@x.com", "session"), null);
  assert.ok(O.cacheGet("mom@x.com", "session").at > 0);
  O.cacheStale("mom@x.com", "session");
  assert.strictEqual(O.cacheGet("mom@x.com", "session").at, 0);
  assert.deepStrictEqual(O.cacheGet("mom@x.com", "session").data, { trips: [1] });
  assert.strictEqual(O.cacheGet("mom@x.com", "missing"), null);
});

test("wipeAll removes cached trips, rosters, profiles, drafts and the outbox, but nothing unrelated", async () => {
  const { O, local, session } = make({
    troop58_trips: "[]", troop58_session: "{}", troop58_equipment: "[]", troop58_profiles_u1: "{}",
    troop58_form_draft_20261101: "{}", unrelated: "keep", troop_id_token: "keep-too"
  });
  session.setItem("troop58_session_token", "t");
  session.setItem("other", "keep");
  O.cacheSet("a@x.com", "session", {});
  O.cacheSet("a@x.com", "roster:20261101", [{}]);
  await O.outbox.add(item("one-0001", "a@x.com"));
  await O.wipeAll();
  assert.deepStrictEqual(local.keys().sort(), ["troop_id_token", "unrelated"]);
  assert.deepStrictEqual(session.keys(), ["other"]);
  assert.strictEqual(await O.outbox.countAll(), 0);
});

test("outbox lists one person's items oldest first and normalizes the email", async () => {
  const { O } = make();
  await O.outbox.add(item("b-0000002", "A@x.com", "2026-11-10T10:05:00.000Z"));
  await O.outbox.add(item("a-0000001", "a@x.com", "2026-11-10T10:00:00.000Z"));
  await O.outbox.add(item("z-0000003", "other@x.com", "2026-11-10T09:00:00.000Z"));
  assert.deepStrictEqual((await O.outbox.list("a@X.com")).map((i) => i.id), ["a-0000001", "b-0000002"]);
  assert.strictEqual(await O.outbox.countAll(), 3);
});

test("flush sends pending items in order, removes the sent ones, leaves other people's alone", async () => {
  const { O } = make();
  await O.outbox.add(item("i-0000002", "a@x.com", "2026-11-10T10:02:00.000Z"));
  await O.outbox.add(item("i-0000001", "a@x.com", "2026-11-10T10:01:00.000Z"));
  await O.outbox.add(item("o-0000001", "other@x.com"));
  const seen = [];
  const r = await O.flush("a@x.com", async (i) => { seen.push(i.id); return { ok: true }; });
  assert.deepStrictEqual(seen, ["i-0000001", "i-0000002"]);
  assert.deepStrictEqual(r, { sent: 2, failed: 0 });
  assert.deepStrictEqual((await O.outbox.list()).map((i) => i.id), ["o-0000001"]);
});

test("flush stops at the first retryable problem and keeps that item and the rest pending", async () => {
  const { O } = make();
  for (const n of [1, 2, 3]) await O.outbox.add(item("i-000000" + n, "a@x.com", "2026-11-10T10:0" + n + ":00.000Z"));
  const seen = [];
  const r = await O.flush("a@x.com", async (i) => {
    seen.push(i.id);
    return i.id === "i-0000002" ? { ok: false, retry: true } : { ok: true };
  });
  assert.deepStrictEqual(seen, ["i-0000001", "i-0000002"]); // the third wasn't attempted
  assert.deepStrictEqual(r, { sent: 1, failed: 0 });
  const left = await O.outbox.list("a@x.com");
  assert.deepStrictEqual(left.map((i) => [i.id, i.status, i.attempts]), [["i-0000002", "pending", 1], ["i-0000003", "pending", 0]]);
});

test("flush keeps a refused item as failed with the reason and carries on; retry makes it pending again", async () => {
  const { O } = make();
  await O.outbox.add(item("bad-00001", "a@x.com", "2026-11-10T10:01:00.000Z"));
  await O.outbox.add(item("good-0001", "a@x.com", "2026-11-10T10:02:00.000Z"));
  const r = await O.flush("a@x.com", async (i) => (i.id === "bad-00001" ? { ok: false, message: "Trip not found." } : { ok: true }));
  assert.deepStrictEqual(r, { sent: 1, failed: 1 });
  const [failed] = await O.outbox.list("a@x.com");
  assert.deepStrictEqual([failed.id, failed.status, failed.error], ["bad-00001", "failed", "Trip not found."]);
  // failed items are not sent again by a later flush...
  const again = await O.flush("a@x.com", async () => { throw new Error("should not be called"); });
  assert.deepStrictEqual(again, { sent: 0, failed: 0 });
  // ...until the person asks to retry
  await O.outbox.retry("bad-00001");
  const [back] = await O.outbox.list("a@x.com");
  assert.deepStrictEqual([back.status, back.error], ["pending", ""]);
});

test("only one flush runs at a time", async () => {
  const { O } = make();
  await O.outbox.add(item("i-0000001", "a@x.com"));
  let calls = 0, release;
  const gate = new Promise((r) => { release = r; });
  const first = O.flush("a@x.com", async () => { calls++; await gate; return { ok: true }; });
  await new Promise((r) => setTimeout(r, 5));
  const second = await O.flush("a@x.com", async () => { calls++; return { ok: true }; });
  assert.deepStrictEqual(second, { sent: 0, failed: 0 });
  release();
  assert.deepStrictEqual(await first, { sent: 1, failed: 0 });
  assert.strictEqual(calls, 1);
});

test("uuid gives IDs the server accepts as clientId", () => {
  const { O } = make();
  const pattern = /^[A-Za-z0-9][A-Za-z0-9_-]{7,63}$/; // CLIENT_ID_PATTERN in apps-script/Hub.gs
  const a = O.uuid(), b = O.uuid();
  assert.ok(pattern.test(a) && pattern.test(b));
  assert.notStrictEqual(a, b);
});
