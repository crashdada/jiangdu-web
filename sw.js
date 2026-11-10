/* 鍙紦瀛樿嚜瀹堕潤鎬佽祫婧愶紱API 璇锋眰涓€寰嬩笉缂撳瓨 */
const CACHE = 'jiangdu-v11';
const ASSETS = [
  './',
  './index.html',
  './style.css',
  './engine.js',
  './prompts.js',
  './parse.js',
  './app.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // 璺ㄥ煙锛圖eepSeek API锛変笉纰帮紝浜ょ粰娴忚鍣ㄧ洿杩?  if (url.origin !== location.origin) return;
  e.respondWith(
    caches.match(e.request).then((hit) => hit || fetch(e.request).then((res) => {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
      return res;
    }))
  );
});

