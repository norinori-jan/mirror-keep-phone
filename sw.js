'use strict';
// Mirror Keep Phone — アプリ本体(画面)をオフラインで開くための Service Worker。
// 取り込んだ保存版のデータは IndexedDB にあり、ここでは扱いません。
// ネットワーク優先: オンラインなら常に最新の画面、オフラインなら、前回のコピーで開きます。
const CACHE = 'mkp-cache-v2';
const ASSETS = ['./', './index.html', './manifest.webmanifest', './apple-touch-icon.png', './icon-192.png', './icon-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('mkp-cache-') && k !== CACHE).map((k) => caches.delete(k)))) // 他アプリのキャッシュは消さない
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  event.respondWith(
    fetch(req).then((res) => {
      if (res && res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req).then((hit) => hit || (req.mode === 'navigate' ? caches.match('./index.html') : Response.error())))
  );
});
