/* Vani service worker: cache-first app shell. Models cache in IndexedDB, not here. */
const CACHE = 'vani-v4';
const SHELL = [
  './', 'index.html', 'css/style.css', 'js/app.js', 'js/store.js', 'js/dictionary.js',
  'js/engine-bundle.js', 'assets/icon.svg', 'assets/bench.wav',
  'vendor/asr/sherpa-onnx-wasm-main-asr.wasm', 'vendor/asr/sherpa-onnx-wasm-main-asr.data',
  'vendor/vad/sherpa-onnx-wasm-main-vad.wasm', 'vendor/vad/sherpa-onnx-wasm-main-vad.data',
  'vendor/se/sherpa-onnx-wasm-main-speech-enhancement.wasm', 'vendor/se/sherpa-onnx-wasm-main-speech-enhancement.data',
  'manifest.webmanifest',
  'assets/model/tiny/encoder_model.ort', 'assets/model/tiny/decoder_model_merged.ort.part1',
  'assets/model/tiny/decoder_model_merged.ort.part2', 'assets/model/tiny/tokens.txt',
];
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
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
