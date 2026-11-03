// Service worker: keeps the pages and scripts available with no signal.
// Same-origin GET requests go to the network first, so an online visit always gets the latest
// deploy; if the network fails (or takes more than a few seconds and a saved copy exists), the saved
// copy is used. Requests to the Apps Script web app and to Google are not touched, so no data
// ever lands in this cache, only the site's own files.
const CACHE = "troop58-shell-v1";
const SLOW_MS = 4000;
const SHELL = [
  "./", "index.html", "slip.html", "add-trip.html", "float-plan.html",
  "hub.js", "slip.js", "add-trip.js", "float-plan.js", "auth.js", "offline.js", "config.js", "lib.js",
  "hub.css", "forms.css", "images/Troop58Logo.jpg"
];

// A page is saved once per path: slip.html?trip=1 and slip.html?trip=2 are the same file.
const keyFor = (url) => { const u = new URL(url); return u.origin + u.pathname; };

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE)
      // One missing file must not stop the rest from being saved.
      .then((cache) => Promise.all(SHELL.map((f) => cache.add(new Request(f, { cache: "reload" })).catch(() => {}))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

async function networkFirst(request) {
  const cache = await caches.open(CACHE);
  const saved = await cache.match(keyFor(request.url));
  const fetched = fetch(request).then((res) => {
    if (res.ok && res.type === "basic") cache.put(keyFor(request.url), res.clone());
    return res;
  });
  if (!saved) return fetched;
  fetched.catch(() => {}); // when the saved copy wins, a late failure is not an error
  return Promise.race([fetched, new Promise((resolve) => setTimeout(() => resolve(saved), SLOW_MS))]).catch(() => saved);
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  if (new URL(req.url).origin !== self.location.origin) return;
  event.respondWith(networkFirst(req));
});
