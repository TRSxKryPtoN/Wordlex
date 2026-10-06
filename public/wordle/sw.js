/* Service worker: caches the whole game so the website works offline.
   Bump VERSION whenever any file below changes. */
const VERSION = "wordlex-v2.13.2";
const FILES = [
  "./index.html",
  "./manifest.webmanifest",
  "./css/styles.css",
  "./fonts/inter-latin.woff2",
  "./data/words.js",
  "./js/rules.js",
  "./js/store.js",
  "./js/stats.js",
  "./js/ui.js",
  "./js/keyboard.js",
  "./js/game.js",
  "./js/localnet.js",
  "./js/lan.js",
  "./js/fx.js",
  "./js/lanui.js",
  "./js/main.js",
  "./vendor/peerjs.min.js",
  "./icons/icon.svg",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/apple-touch-icon.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(VERSION)
      .then((cache) => cache.addAll(FILES))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // never touch multiplayer traffic

  // Cache first, then refresh the cache in the background.
  event.respondWith(
    caches.open(VERSION).then(async (cache) => {
      const cached = await cache.match(req, { ignoreSearch: true });
      const network = fetch(req)
        .then((res) => {
          if (res && res.ok) cache.put(req, res.clone());
          return res;
        })
        .catch(() => cached);
      return cached || network;
    }),
  );
});
