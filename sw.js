// オフライン用：初回に画面一式を保存し、以後は保存した物を先に表示する。
// ネットにつながっているときは裏で最新版を取り直すので、ファイルを更新すると次に開いたときに反映される。
'use strict';
var CACHE = 'helium-fill-checklist';
var FILES = [
    './',
    './index.html',
    './manifest.webmanifest',
    './css/fill-checklist.css',
    './js/calc/balloon-gas.js',
    './js/fill/fill-checklist-core.js',
    './js/fill/fill-checklist-ui.js',
    './icons/icon-180.png',
    './icons/icon-192.png',
    './icons/icon-512.png'
];

self.addEventListener('install', function (event) {
    event.waitUntil(caches.open(CACHE).then(function (cache) { return cache.addAll(FILES); }).then(function () { return self.skipWaiting(); }));
});
self.addEventListener('activate', function (event) {
    event.waitUntil(self.clients.claim());
});
self.addEventListener('fetch', function (event) {
    var request = event.request;
    if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;
    event.respondWith(caches.open(CACHE).then(function (cache) {
        return cache.match(request, { ignoreSearch: true }).then(function (cached) {
            var network = fetch(request).then(function (response) {
                if (response && response.ok) cache.put(request, response.clone());
                return response;
            });
            if (cached) { event.waitUntil(network.catch(function () {})); return cached; }
            return network.catch(function () {
                return request.mode === 'navigate' ? cache.match('./index.html') : Response.error();
            });
        });
    }));
});
