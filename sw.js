'use strict';
// Mirror Keep Phone — Service Worker
// 1) アプリ本体(画面)をオフラインで開く（ネットワーク優先。オフラインなら前回のコピー）
// 2) 取り込んだ保存版を、端末内の IndexedDB から配信する（run/<アプリキー>/<版ID>/<パス>）
const CACHE = 'mkp-cache-v3';
const ASSETS = ['./', './index.html', './manifest.webmanifest', './apple-touch-icon.png', './icon-192.png', './icon-512.png'];
const DB_NAME = 'mirror-keep-phone';
const SCOPE_PATH = new URL(self.registration.scope).pathname; // 例: /mirror-keep-phone/
const RUN_PREFIX = SCOPE_PATH + 'run/';

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

/* ---------- 保存版の配信 ---------- */
const TYPES = {
  html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8', json: 'application/json; charset=utf-8', webmanifest: 'application/manifest+json; charset=utf-8',
  txt: 'text/plain; charset=utf-8', md: 'text/plain; charset=utf-8', xml: 'application/xml; charset=utf-8', svg: 'image/svg+xml',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', ico: 'image/x-icon', avif: 'image/avif',
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf', wasm: 'application/wasm',
  mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', aac: 'audio/aac', ogg: 'audio/ogg', mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime'
};
const typeOf = (path) => TYPES[(path.split('.').pop() || '').toLowerCase()] || 'application/octet-stream';

function openDB() { // ページ側と同じ構造。先にSWが開いても、保存先の構造が欠けないようにする
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      d.createObjectStore('versions', { keyPath: 'uid' });
      d.createObjectStore('files', { keyPath: ['uid', 'path'] });
      d.createObjectStore('meta', { keyPath: 'key' });
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
function getRow(db, uid, path) {
  return new Promise((resolve, reject) => {
    const q = db.transaction('files', 'readonly').objectStore('files').get([uid, path]);
    q.onsuccess = () => resolve(q.result || null);
    q.onerror = () => reject(q.error);
  });
}

// 版ごとに保存領域を分ける部品。HTMLの先頭に差し込む。
// 分離できなかった場合は、ページを止める（本物のデータに触れさせないため）。
function isolationShim(prefix) {
  return '<script>(function(){try{' +
    'var P=' + JSON.stringify(prefix) + ';' +
    'function ns(real){var api={' +
    'getItem:function(k){return real.getItem(P+String(k));},' +
    'setItem:function(k,v){real.setItem(P+String(k),String(v));},' +
    'removeItem:function(k){real.removeItem(P+String(k));},' +
    'clear:function(){var ks=keys();for(var i=0;i<ks.length;i++)real.removeItem(P+ks[i]);},' +
    'key:function(i){var ks=keys();return i<ks.length?ks[i]:null;}};' +
    'function keys(){var ks=[];for(var i=0;i<real.length;i++){var k=real.key(i);if(k&&k.indexOf(P)===0)ks.push(k.slice(P.length));}return ks;}' +
    'return new Proxy(api,{get:function(t,p){if(p==="length")return keys().length;if(p in t)return t[p];if(typeof p==="symbol")return undefined;var v=api.getItem(p);return v===null?undefined:v;},' +
    'set:function(t,p,v){api.setItem(p,v);return true;},deleteProperty:function(t,p){api.removeItem(p);return true;},' +
    'has:function(t,p){return p in t||(typeof p==="string"&&api.getItem(p)!==null);},ownKeys:function(){return keys();},' +
    'getOwnPropertyDescriptor:function(t,p){var v=typeof p==="string"?api.getItem(p):null;return v===null?undefined:{value:v,writable:true,enumerable:true,configurable:true};}});}' +
    'var L=ns(window.localStorage),S=ns(window.sessionStorage);' +
    'Object.defineProperty(window,"localStorage",{configurable:true,get:function(){return L;}});' +
    'Object.defineProperty(window,"sessionStorage",{configurable:true,get:function(){return S;}});' +
    'var idb=window.indexedDB;var wi={open:function(n,v){return v===undefined?idb.open(P+n):idb.open(P+n,v);},deleteDatabase:function(n){return idb.deleteDatabase(P+n);},' +
    'cmp:function(a,b){return idb.cmp(a,b);},databases:function(){return idb.databases?idb.databases().then(function(a){return a.filter(function(d){return d.name.indexOf(P)===0;}).map(function(d){return{name:d.name.slice(P.length),version:d.version};});}):Promise.resolve([]);}};' +
    'Object.defineProperty(window,"indexedDB",{configurable:true,get:function(){return wi;}});' +
    'if(window.caches){var c=window.caches;var wc={open:function(n){return c.open(P+n);},has:function(n){return c.has(P+n);},delete:function(n){return c.delete(P+n);},' +
    'keys:function(){return c.keys().then(function(a){return a.filter(function(k){return k.indexOf(P)===0;}).map(function(k){return k.slice(P.length);});});},' +
    'match:function(){return Promise.resolve(undefined);}};Object.defineProperty(window,"caches",{configurable:true,get:function(){return wc;}});}' +
    'if(navigator.serviceWorker){navigator.serviceWorker.register=function(){return Promise.reject(new DOMException("Mirror Keep Phone の中では Service Worker を登録しません","SecurityError"));};}' +
    'if(window.localStorage!==L||window.sessionStorage!==S||window.indexedDB!==wi)throw new Error("isolation failed");' +
    'window.__mkIsolated=true;' +
    '}catch(e){try{window.stop();}catch(_){}try{window.parent.postMessage({mkBlocked:true},"*");}catch(_){}try{window.__mkBlocked=true;document.documentElement.innerHTML="<body><p style=\\"font:16px sans-serif;padding:16px\\">この環境では、データを分離できないため、起動しませんでした。</p></body>";}catch(_){}throw e;}})();</script>';
}
function injectShim(html, prefix) {
  const shim = isolationShim(prefix);
  const head = /<head[^>]*>/i.exec(html);
  if (head) return html.slice(0, head.index + head[0].length) + shim + html.slice(head.index + head[0].length);
  const root = /<html[^>]*>/i.exec(html);
  if (root) return html.slice(0, root.index + root[0].length) + shim + html.slice(root.index + root[0].length);
  return shim + html;
}

function plain(status, text) {
  return new Response(text, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });
}

async function serveRun(req, url) {
  const rest = url.pathname.slice(RUN_PREFIX.length).split('/');
  if (rest.length < 3) return plain(404, 'not found');
  let key, ver, parts;
  try { key = decodeURIComponent(rest[0]); ver = decodeURIComponent(rest[1]); parts = rest.slice(2).map(decodeURIComponent); } catch (e) { return plain(400, 'bad request'); }
  if (!/^[A-Za-z0-9._-]{1,80}$/.test(key) || !/^\d{8}-\d{6}-\d{6}-[0-9a-f]{6}$/.test(ver)) return plain(404, 'not found');
  if (parts[parts.length - 1] === '') parts[parts.length - 1] = 'index.html'; // ディレクトリ指定は index.html
  if (parts.some((p) => p === '' || p === '.' || p === '..' || p.includes('/') || p.includes('\\') || p.includes('\0'))) return plain(400, 'bad path');
  const path = parts.join('/');
  const uid = key + '/' + ver;
  const db = await openDB();
  let row;
  try { row = await getRow(db, uid, path); } finally { db.close(); }
  if (!row) return plain(404, 'この版には、このファイルがありません: ' + path);
  const type = typeOf(path);
  const base = { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Accept-Ranges': 'bytes' };
  if (/^text\/html/.test(type)) {
    let html;
    try { html = new TextDecoder('utf-8', { fatal: true }).decode(row.data); } catch (e) { return plain(415, 'UTF-8 以外のHTMLは、動かせません: ' + path); }
    const body = injectShim(html, 'mkrun:' + uid + ':');
    return new Response(req.method === 'HEAD' ? null : body, { status: 200, headers: base });
  }
  const data = row.data;
  const range = req.headers.get('range');
  const m = range && /^bytes=(\d*)-(\d*)$/.exec(range);
  if (m && (m[1] !== '' || m[2] !== '')) {
    let start, end;
    if (m[1] === '') { start = Math.max(0, data.length - Number(m[2])); end = data.length - 1; }
    else { start = Number(m[1]); end = m[2] === '' ? data.length - 1 : Math.min(Number(m[2]), data.length - 1); }
    if (start > end || start >= data.length) return new Response(null, { status: 416, headers: { 'Content-Range': 'bytes */' + data.length } });
    return new Response(req.method === 'HEAD' ? null : data.slice(start, end + 1), { status: 206, headers: { ...base, 'Content-Range': 'bytes ' + start + '-' + end + '/' + data.length, 'Content-Length': String(end - start + 1) } });
  }
  return new Response(req.method === 'HEAD' ? null : data, { status: 200, headers: { ...base, 'Content-Length': String(data.length) } });
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname.startsWith(RUN_PREFIX)) {
    event.respondWith(serveRun(req, url).catch((e) => plain(500, '配信に失敗しました: ' + ((e && e.message) || e))));
    return;
  }
  if (req.method !== 'GET') return;
  event.respondWith(
    fetch(req).then((res) => {
      if (res && res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req).then((hit) => hit || (req.mode === 'navigate' ? caches.match('./index.html') : Response.error())))
  );
});
