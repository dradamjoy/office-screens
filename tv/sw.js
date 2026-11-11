/* Keeps the TV page itself available offline, so the bookmark still opens after a
   restart with no internet. Videos and photos are saved by tv.js, not here. */
var SHELL = 'os-shell-v1';
var FILES = ['./', './tv.js', '../config.js', '../icon.svg'];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(SHELL).then(function (c) { return c.addAll(FILES); }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k.indexOf('os-shell-') === 0 && k !== SHELL; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  if (new URL(req.url).origin !== self.location.origin) return;
  e.respondWith(networkFirst(req));
});

// Use the newest page when online; fall back to the saved copy when offline or slow.
function networkFirst(req) {
  return caches.open(SHELL).then(function (cache) {
    function saved() {
      return cache.match(req, { ignoreSearch: true }).then(function (r) {
        return r || (req.mode === 'navigate' ? cache.match('./') : null);
      });
    }
    return new Promise(function (resolve) {
      var settled = false;
      function finish(r) { if (!settled) { settled = true; clearTimeout(timer); resolve(r); } }
      var timer = setTimeout(function () { saved().then(function (r) { if (r) finish(r); }); }, 4000);
      fetch(req).then(function (resp) {
        if (resp && resp.ok && resp.type === 'basic') { cache.put(req, resp.clone()).catch(function () {}); }
        finish(resp);
      }).catch(function () {
        saved().then(function (r) { finish(r || new Response('Offline', { status: 503, headers: { 'Content-Type': 'text/plain' } })); });
      });
    });
  });
}
