// Service worker for the installable control app (scope: admin.html).
// Network-first: always loads the latest version from GitHub Pages, and falls
// back to the cached copy only if the network is unavailable.
const CACHE = "bvc-control-v2";
const SHELL = [
  "admin.html",
  "css/style.css",
  "js/admin.js",
  "js/config.js",
  "js/languages.js",
  "js/translate.js",
  "js/audio.js",
  "js/speech.js",
  "js/transport.js",
  "icons/icon-192.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET" || new URL(req.url).origin !== location.origin) return;
  e.respondWith(
    // "no-cache" = always ask GitHub for the latest version (still uses a cheap 304 if unchanged)
    fetch(req, { cache: "no-cache" })
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req, { ignoreSearch: true }))
  );
});
