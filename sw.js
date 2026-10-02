/* Vani service worker: cache-first app shell. Models cache in IndexedDB, not here. */
const CACHE = 'vani-v15';
// Only the app shell precaches. The big binaries (vendor wasm/data, tiny
// model) used to precache too, which made every first visit download them
// TWICE: once by this install, once by the page's own engine fetches racing
// it. Now they flow through the fetch handler's runtime cache on the page's
// single pull. Same offline state after first use, half the first-visit cost.
const SHELL = [
  './', 'index.html', 'css/style.css', 'js/app.js', 'js/store.js', 'js/dictionary.js',
  'js/diag.js', 'js/assets.js',
  'js/engine-bundle.js', 'js/capture-worklet.js', 'assets/icon.svg', 'assets/bench.wav',
  'manifest.webmanifest',
];
self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())
      .catch((err) => {
        // without this, offline support dies silently and activate never runs
        console.error('[vani] offline install failed — a SHELL entry is missing or the network dropped:', err);
        throw err;
      })
  );
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return; // model downloads go straight to network
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then((hit) => hit || fetch(e.request).then((resp) => {
    if (resp.ok && e.request.method === 'GET') {
      const copy = resp.clone();
      caches.open(CACHE).then((c) => c.put(e.request, copy));
    }
    return resp;
  })));
});
