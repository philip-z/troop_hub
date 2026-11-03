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
function make(initialLocal, fetchImpl) {
  const local = fakeStorage(initialLocal), session = fakeStorage();
  const store = memoryStore();
  return { O: create({ localStorage: local, sessionStorage: session, outboxStore: store, fetch: fetchImpl }), local, session, store };
}
// A fetch that records what was sent and answers with `reply` (a status/body, or a function, or an Error to throw).
function fakeFetch(reply) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, opts, body: JSON.parse(opts.body) });
    const r = typeof reply === "function" ? reply(calls.length) : reply;
    if (r instanceof Error) throw r;
    return { ok: r.ok !== false, status: r.status || 200, json: async () => { if (r.unreadable) throw new Error("bad json"); return r.body; } };
  };
  fn.calls = calls;
  return fn;
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

test("send returns the parsed reply and flags why there was none", async () => {
  const ok = fakeFetch({ body: { status: "error", code: "not_allowed" } });
  const { O } = make({}, ok);
  assert.deepStrictEqual(await O.send("https://x/exec", { a: 1 }), { status: "error", code: "not_allowed" }); // a server "error" is a reply, not a failure
  assert.deepStrictEqual([ok.calls[0].url, ok.calls[0].body, ok.calls[0].opts.headers["Content-Type"]], ["https://x/exec", { a: 1 }, "text/plain;charset=utf-8"]);

  const flagsOf = async (impl) => { try { await make({}, impl).O.send("u", {}); return "no error"; } catch (e) { return [!!e.network, !!e.retry]; } };
  assert.deepStrictEqual(await flagsOf(fakeFetch(new TypeError("Failed to fetch"))), [true, false]);
  assert.deepStrictEqual(await flagsOf(fakeFetch({ ok: false, status: 502 })), [false, true]);
  assert.deepStrictEqual(await flagsOf(fakeFetch({ unreadable: true })), [false, true]);
});

test("send gives up after the timeout and reports no connection", async () => {
  const slow = (url, opts) => new Promise((resolve, reject) => { opts.signal.addEventListener("abort", () => reject(new Error("aborted"))); });
  const { O } = make({}, slow);
  await assert.rejects(() => O.send("u", {}, 20), (e) => e.network === true);
});

test("makeSender sends each kind with the current token and classifies the outcome", async () => {
  let token = "tok-1", signedOut = 0;
  const fetchImpl = fakeFetch((n) => ({ body: { status: "success" } }));
  const { O } = make({}, fetchImpl);
  const sender = O.makeSender({ url: "https://x/exec", getToken: () => token, onSignin: () => { signedOut++; } });

  assert.deepStrictEqual(await sender({ kind: "hubSubmit", payload: { kind: "receipt", tripId: "1", clientId: "c-0000001" } }), { ok: true });
  assert.deepStrictEqual(fetchImpl.calls[0].body, { kind: "receipt", tripId: "1", clientId: "c-0000001", action: "hubSubmit", idToken: "tok-1" });

  token = "tok-2"; // a token that was renewed since the item was queued is the one that is used
  assert.deepStrictEqual(await sender({ kind: "slipSubmit", payload: { "Youth Name": "Sam", _clientId: "c-0000002" } }), { ok: true });
  assert.deepStrictEqual(fetchImpl.calls[1].body, { "Youth Name": "Sam", _clientId: "c-0000002", _idToken: "tok-2" });
  assert.ok(!("action" in fetchImpl.calls[1].body)); // a slip is posted without an action, like the form always was

  const withReply = (reply) => make({}, fakeFetch(reply)).O.makeSender({ url: "u", getToken: () => "t", onSignin: () => { signedOut++; } })({ kind: "hubSubmit", payload: {} });
  assert.deepStrictEqual(await withReply(new TypeError("offline")), { ok: false, retry: true, message: "There is no connection to the server." });
  assert.deepStrictEqual(await withReply({ ok: false, status: 500 }), { ok: false, retry: true, message: "Server error 500" });
  assert.deepStrictEqual(await withReply({ body: { status: "error", code: "not_found", message: "Trip not found." } }), { ok: false, message: "Trip not found." });
  assert.strictEqual(signedOut, 0);
  const expired = await withReply({ body: { status: "error", code: "signin", message: "Please sign in." } });
  assert.deepStrictEqual(expired, { ok: false, retry: true, signin: true, message: "Please sign in." });
  assert.strictEqual(signedOut, 1);
});

test("flush with makeSender keeps a slip queued when offline and sends it once online", async () => {
  let online = false;
  const fetchImpl = fakeFetch(() => (online ? { body: { status: "success" } } : new TypeError("offline")));
  const { O } = make({}, fetchImpl);
  const sender = O.makeSender({ url: "u", getToken: () => "t" });
  await O.outbox.add({ id: "slip-0001", email: "mom@x.com", kind: "slipSubmit", payload: { _clientId: "slip-0001" }, createdAt: "2026-11-10T10:00:00.000Z" });
  await O.outbox.add({ id: "rcpt-0001", email: "mom@x.com", kind: "hubSubmit", payload: { clientId: "rcpt-0001" }, createdAt: "2026-11-10T10:01:00.000Z" });
  assert.deepStrictEqual(await O.flush("mom@x.com", sender), { sent: 0, failed: 0 });
  assert.strictEqual((await O.outbox.list("mom@x.com")).length, 2); // nothing lost while offline
  online = true;
  assert.deepStrictEqual(await O.flush("mom@x.com", sender), { sent: 2, failed: 0 });
  assert.strictEqual(await O.outbox.countAll(), 0);
  assert.deepStrictEqual(fetchImpl.calls.slice(-2).map((c) => Object.keys(c.body).filter((k) => /clientId|_clientId/i.test(k))[0]), ["_clientId", "clientId"]);
});

test("submitNow: sent, queued, refused, and no offline storage", async () => {
  const item = (id) => ({ id, email: "mom@x.com", kind: "slipSubmit", payload: { _clientId: id }, createdAt: "2026-11-10T10:00:00.000Z" });
  const { O } = make();
  const ok = async () => ({ ok: true });

  assert.deepStrictEqual(await O.submitNow(item("sent-00001"), ok), { sent: true });
  assert.strictEqual(await O.outbox.countAll(), 0); // sent: not left behind

  const offline = async () => ({ ok: false, retry: true });
  assert.deepStrictEqual(await O.submitNow(item("queue-0001"), offline), { queued: true, signin: false });
  assert.deepStrictEqual((await O.outbox.list()).map((i) => [i.id, i.status]), [["queue-0001", "pending"]]);

  const expired = async () => ({ ok: false, retry: true, signin: true });
  assert.deepStrictEqual(await O.submitNow(item("queue-0002"), expired), { queued: true, signin: true });

  const refused = async () => ({ ok: false, message: "Trip not found." });
  assert.deepStrictEqual(await O.submitNow(item("refuse-001"), refused), { refused: true, message: "Trip not found." });
  assert.deepStrictEqual((await O.outbox.list()).map((i) => i.id).sort(), ["queue-0001", "queue-0002"]); // a refused item isn't kept

  // the sender is handed the saved item (with its status fields), and that is what a later flush resends
  let seen;
  await O.submitNow(item("seen-00001"), async (i) => { seen = i; return { ok: true }; });
  assert.deepStrictEqual([seen.id, seen.status, seen.attempts], ["seen-00001", "pending", 0]);
});

test("submitNow without offline storage still sends, and reports a failure instead of queueing", async () => {
  const noStore = { add: async () => { throw new Error("none"); }, put: async () => {}, remove: async () => {}, clear: async () => {}, list: async () => [] };
  const O = create({ localStorage: fakeStorage(), sessionStorage: fakeStorage(), outboxStore: noStore });
  const it = { id: "none-00001", email: "a@x.com", kind: "hubSubmit", payload: {}, createdAt: "2026-11-10T10:00:00.000Z" };
  assert.deepStrictEqual(await O.submitNow(it, async () => ({ ok: true })), { sent: true });
  assert.deepStrictEqual(await O.submitNow(it, async () => ({ ok: false, retry: true, message: "offline" })), { failed: true, signin: false, message: "offline" });
  assert.deepStrictEqual(await O.submitNow(it, async () => ({ ok: false, message: "No." })), { refused: true, message: "No." });
});

test("uuid gives IDs the server accepts as clientId", () => {
  const { O } = make();
  const pattern = /^[A-Za-z0-9][A-Za-z0-9_-]{7,63}$/; // CLIENT_ID_PATTERN in apps-script/Hub.gs
  const a = O.uuid(), b = O.uuid();
  assert.ok(pattern.test(a) && pattern.test(b));
  assert.notStrictEqual(a, b);
});
