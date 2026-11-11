/* Office Screens — TV player.
   No sign-in. Reads this TV's settings, saves every file on the TV, and plays from
   the saved copies so it keeps going when the internet drops. */
(function () {
'use strict';

var CFG = window.OS_CONFIG;
var REST = CFG.url + '/rest/v1';
var HDR = { apikey: CFG.key, Authorization: 'Bearer ' + CFG.key };
var MEDIA_CACHE = 'os-media-v1';
var POLL_MS = 10000, CHECKIN_MS = 60000, STALL_MS = 60000;
var qs = new URLSearchParams(location.search);
var PREVIEW = qs.get('preview') === '1';
var STARTED = Date.now();

/* ---------- helpers ---------- */
function $(s) { return document.querySelector(s); }
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
function rid(n) { var a = ''; while (a.length < n) a += Math.random().toString(36).slice(2); return a.slice(0, n); }
function findIdx(a, fn) { for (var i = 0; i < a.length; i++) { if (fn(a[i])) return i; } return -1; }
function plural(n, w) { return n + ' ' + w + (n === 1 ? '' : 's'); }
var store = {
  get: function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
  set: function (k, v) { try { localStorage.setItem(k, v); } catch (e) {} },
  del: function (k) { try { localStorage.removeItem(k); } catch (e) {} }
};
function pub(path) { return CFG.url + '/storage/v1/object/public/' + CFG.bucket + '/' + String(path).split('/').map(encodeURIComponent).join('/'); }
var HAS_CACHE = typeof caches !== 'undefined' && !PREVIEW;

var DEVICE = store.get('os.device');
if (!DEVICE) { DEVICE = 'tv-' + rid(12); store.set('os.device', DEVICE); }

if ('serviceWorker' in navigator && !PREVIEW) { navigator.serviceWorker.register('sw.js').catch(function () {}); }
if (!PREVIEW && navigator.storage && navigator.storage.persist) { navigator.storage.persist().catch(function () {}); }

async function api(path, opts) {
  var ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  var t = setTimeout(function () { if (ctl) ctl.abort(); }, 12000);
  try {
    var o = { headers: HDR, cache: 'no-store' };
    if (ctl) o.signal = ctl.signal;
    if (opts) { for (var k in opts) o[k] = opts[k]; }
    var r = await fetch(REST + path, o);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    var txt = await r.text();
    return txt ? JSON.parse(txt) : null;
  } finally { clearTimeout(t); }
}

/* ---------- picker ---------- */
var view = null, pickT = null;
async function showPicker(note) {
  stopPlayer();
  view = 'picker';
  $('#player').hidden = true; $('#picker').hidden = false;
  var list = null;
  try {
    list = await api('/screens?select=id,name,mode,items,video,power&order=sort.asc');
    store.set('os.list', JSON.stringify(list));
    setOnline(true);
  } catch (e) {
    try { list = JSON.parse(store.get('os.list') || 'null'); } catch (_) { list = null; }
    setOnline(false);
  }
  if (view !== 'picker') return;
  renderPicks(list, note);
  clearTimeout(pickT);
  pickT = setTimeout(function () { if (view === 'picker' && !$('#picks').contains(document.activeElement)) showPicker(note); }, 15000);
}
function renderPicks(list, note) {
  var m = $('#pickMsg');
  if (!list) {
    $('#picks').innerHTML = '';
    m.textContent = 'Can’t reach Office Screens. Check this TV’s internet connection. This page tries again on its own.';
    m.hidden = false; return;
  }
  m.textContent = note || (list.length ? '' : 'No TVs are set up yet. Add one from Office Screens on your phone. This page updates on its own.');
  m.hidden = !m.textContent;
  var had = document.activeElement && document.activeElement.getAttribute && document.activeElement.getAttribute('data-id');
  $('#picks').innerHTML = list.map(function (s) {
    var what = s.mode === 'video' ? (s.video ? 'One video, nonstop' : 'One video · none chosen') : plural((s.items || []).length, 'item') + ' in the slideshow';
    return '<button type="button" class="pick" data-id="' + esc(s.id) + '"><b>' + esc(s.name) + '</b><span>' + esc(what) + (s.power ? '' : ' · switched off') + '</span></button>';
  }).join('');
  var f = (had && document.querySelector('.pick[data-id="' + had + '"]')) || document.querySelector('.pick');
  if (f) { try { f.focus({ preventScroll: true }); } catch (e) { f.focus(); } }
}
function pickerKeys(e) {
  var picks = Array.prototype.slice.call(document.querySelectorAll('.pick'));
  if (!picks.length) return;
  var i = picks.indexOf(document.activeElement);
  if (i < 0) { picks[0].focus(); e.preventDefault(); return; }
  var top0 = picks[0].offsetTop, cols = 0;
  for (var k = 0; k < picks.length; k++) { if (picks[k].offsetTop === top0) cols++; }
  cols = Math.max(1, cols);
  var j = i;
  if (e.key === 'ArrowRight') j = i + 1; else if (e.key === 'ArrowLeft') j = i - 1;
  else if (e.key === 'ArrowDown') j = i + cols; else if (e.key === 'ArrowUp') j = i - cols; else return;
  if (j >= 0 && j < picks.length) { picks[j].focus(); picks[j].scrollIntoView({ block: 'nearest' }); }
  e.preventDefault();
}
function choose(id) {
  if (!PREVIEW) store.set('os.screen', id);
  startPlayer(id);
}

/* ---------- player state ---------- */
var P = {
  active: false, id: null, cfg: null, raw: '', removed: false, off: false,
  token: 0, timer: null, idx: -1, front: 0, layers: null, cur: null, curMode: null, sig: '', list: [],
  urls: {}, cached: {}, direct: {}, failed: {}, retried: {}, dl: null, syncing: false, needSync: false,
  online: true, lastCheck: 0, checkT: null, unlocked: false, wake: null, hideT: null, pollT: null, err: null
};

async function initCache() {
  if (!HAS_CACHE) return;
  try {
    var c = await caches.open(MEDIA_CACHE);
    var reqs = await c.keys();
    reqs.forEach(function (r) { P.cached[r.url] = true; });
  } catch (e) {}
}
function itemsOf(cfg) {
  if (!cfg) return [];
  var out = [];
  (cfg.items || []).forEach(function (it) { if (it && it.path) out.push({ id: it.id, url: pub(it.path), kind: it.kind, d: it.d, dur: it.dur }); });
  return out;
}
function videoOf(cfg) {
  var v = cfg && cfg.video;
  return v && v.path ? { id: 'video:' + (v.m || v.path), url: pub(v.path), kind: 'video', dur: v.dur } : null;
}
function activeList(cfg) {
  if (!cfg) return [];
  if (cfg.mode === 'video') { var v = videoOf(cfg); return v ? [v] : []; }
  return itemsOf(cfg);
}
function wanted(cfg) {
  var act = activeList(cfg), seen = {}, out = [];
  var all = act.concat(cfg && cfg.mode === 'video' ? itemsOf(cfg) : (videoOf(cfg) ? [videoOf(cfg)] : []));
  all.forEach(function (it) { if (!seen[it.url]) { seen[it.url] = true; out.push(it.url); } });
  return out;
}
function isReady(url) { return PREVIEW || !HAS_CACHE || !!P.cached[url] || !!P.direct[url]; }

/* ---------- start / stop ---------- */
function startPlayer(id) {
  clearTimeout(pickT);
  view = 'player';
  $('#picker').hidden = true; $('#player').hidden = false;
  if (!P.layers) { var ls = document.querySelectorAll('#stage .layer'); P.layers = [ls[0], ls[1]]; }
  P.active = true; P.id = id; P.cfg = null; P.raw = ''; P.removed = false; P.off = false; P.sig = ''; P.cur = null; P.curMode = null;
  P.idx = -1; P.err = null; P.lastCheck = 0; P.retried = {};
  $('#blackout').classList.remove('on');
  $('#ovName').textContent = '';
  var saved = PREVIEW ? null : store.get('os.cfg.' + id);
  if (saved) { try { P.raw = saved; apply(JSON.parse(saved)); } catch (e) { P.raw = ''; } }
  if (!P.cfg) showMsg('Loading…', '');
  poll();
  clearInterval(P.pollT); P.pollT = setInterval(poll, POLL_MS);
  showOverlay(10000, true);
  requestWake();
}
function stopPlayer() {
  if (!P.active) return;
  P.active = false;
  clearInterval(P.pollT); clearTimeout(P.checkT); clearTimeout(P.hideT);
  stopPlayback();
  Object.keys(P.urls).forEach(function (u) { if (P.urls[u].indexOf('blob:') === 0) URL.revokeObjectURL(P.urls[u]); });
  P.urls = {};
  if (P.wake) { try { P.wake.release(); } catch (e) {} P.wake = null; }
}

/* ---------- reading settings ---------- */
async function poll() {
  if (!P.active) return;
  var id = P.id;
  try {
    var rows = await api('/screens?id=eq.' + encodeURIComponent(id) + '&select=*');
    if (!P.active || P.id !== id) return;
    setOnline(true);
    if (!rows || !rows.length) {
      store.del('os.cfg.' + id);
      if (!PREVIEW && store.get('os.screen') === id) store.del('os.screen');
      showPicker(P.cfg ? 'The TV this was showing was removed. Choose another.' : 'That TV isn’t set up any more. Choose one.');
      return;
    }
    var raw = JSON.stringify(rows[0]);
    if (raw !== P.raw) {
      P.raw = raw;
      if (!PREVIEW) store.set('os.cfg.' + id, raw);
      apply(rows[0]);
    } else if (!P.syncing && wanted(P.cfg).some(function (u) { return !isReady(u); })) {
      sync();
    }
  } catch (e) {
    if (!P.active) return;
    setOnline(false);
    if (!P.cfg) showMsg('Waiting for the internet', 'This TV hasn’t loaded its settings yet. It starts as soon as it’s online.');
  }
  checkin(false);
}
function apply(cfg) {
  P.cfg = cfg;
  if (P.err === 'play') { P.err = null; P.retried = {}; }
  $('#ovName').textContent = cfg.name || '';
  $('#stage').setAttribute('data-fit', cfg.fit === 'cover' ? 'cover' : 'contain');
  $('#bNext').hidden = cfg.mode === 'video';
  refresh();
  sync();
  checkin(true);
}

/* ---------- saving files on the TV ---------- */
async function sync() {
  if (!HAS_CACHE || !P.cfg) return;
  if (P.syncing) { P.needSync = true; return; }
  P.syncing = true; P.needSync = false;
  try {
    var want = wanted(P.cfg);
    var missing = want.filter(function (u) { return !isReady(u) && !(P.failed[u] && Date.now() - P.failed[u] < 60000); });
    for (var i = 0; i < missing.length; i++) {
      if (!P.active) break;
      var u = missing[i];
      if (wanted(P.cfg).indexOf(u) < 0) continue;
      P.dl = { url: u, n: i + 1, of: missing.length, pct: 0 };
      updateMsg(); netLabel();
      try {
        await download(u, function (pct) { if (P.dl) { P.dl.pct = pct; updateMsg(); netLabel(); } });
        P.cached[u] = true; delete P.failed[u];
      } catch (e) {
        if (e && (e.name === 'QuotaExceededError' || /quota/i.test(e.message || ''))) { P.direct[u] = true; P.err = 'storage'; }
        else { P.failed[u] = Date.now(); if (!navigator.onLine) setOnline(false); }
      }
      P.dl = null;
      refresh();
      checkin(true);
    }
    var all = wanted(P.cfg);
    if (P.online && all.every(isReady)) await prune(all);
  } finally {
    P.syncing = false; P.dl = null; updateMsg(); netLabel();
    if (P.needSync) setTimeout(sync, 0);
  }
}
async function download(url, onPct) {
  var cache = await caches.open(MEDIA_CACHE);
  var ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  var resp = await fetch(url, ctl ? { cache: 'no-store', mode: 'cors', signal: ctl.signal } : { cache: 'no-store', mode: 'cors' });
  if (!resp.ok) throw new Error('HTTP ' + resp.status);
  var total = parseInt(resp.headers.get('content-length') || '0', 10) || 0;
  var type = resp.headers.get('content-type') || 'application/octet-stream';
  if (!(resp.body && resp.body.tee)) { await cache.put(url, resp); onPct(100); return; }
  var parts = resp.body.tee();
  var putErr = null;
  var putP = cache.put(url, new Response(parts[0], { headers: { 'Content-Type': type } })).catch(function (e) { putErr = e; });
  var reader = parts[1].getReader(), got = 0, lastTick = 0, lastByte = Date.now();
  var watch = setInterval(function () { if (Date.now() - lastByte > STALL_MS && ctl) ctl.abort(); }, 5000);
  try {
    for (;;) {
      var r = await reader.read();
      if (r.done) break;
      got += r.value.byteLength; lastByte = Date.now();
      if (total && Date.now() - lastTick > 500) { lastTick = Date.now(); onPct(Math.min(99, Math.floor(got / total * 100))); }
    }
  } finally { clearInterval(watch); }
  await putP;
  if (putErr) throw putErr;
  if (total && got < total) { try { await cache.delete(url); } catch (e) {} throw new Error('Download cut off'); }
  onPct(100);
}
async function prune(keep) {
  try {
    var cache = await caches.open(MEDIA_CACHE), reqs = await cache.keys(), set = {};
    keep.forEach(function (u) { set[u] = true; });
    for (var i = 0; i < reqs.length; i++) {
      var u = reqs[i].url;
      if (set[u]) continue;
      if (P.cur && P.cur.url === u) continue;
      await cache.delete(reqs[i]);
      delete P.cached[u];
      if (P.urls[u]) { if (P.urls[u].indexOf('blob:') === 0) URL.revokeObjectURL(P.urls[u]); delete P.urls[u]; }
    }
  } catch (e) {}
}
async function objUrl(url) {
  if (P.urls[url]) return P.urls[url];
  if (PREVIEW || !HAS_CACHE || P.direct[url]) { P.urls[url] = url; return url; }
  var cache = await caches.open(MEDIA_CACHE);
  var r = await cache.match(url);
  if (!r) { delete P.cached[url]; return null; }
  var b = await r.blob();
  var u = URL.createObjectURL(b);
  P.urls[url] = u;
  return u;
}
async function dropSaved(url) {
  if (P.urls[url]) { if (P.urls[url].indexOf('blob:') === 0) URL.revokeObjectURL(P.urls[url]); delete P.urls[url]; }
  delete P.cached[url];
  if (HAS_CACHE) { try { var c = await caches.open(MEDIA_CACHE); await c.delete(url); } catch (e) {} }
}

/* ---------- playback ---------- */
function refresh() {
  if (!P.active || !P.cfg) return;
  var cfg = P.cfg;
  if (!cfg.power) {
    if (!P.off) { P.off = true; stopPlayback(); P.sig = ''; hideMsg(); $('#blackout').classList.add('on'); }
    return;
  }
  var wasOff = P.off; P.off = false; $('#blackout').classList.remove('on');
  var list = activeList(cfg);
  if (!list.length) {
    stopPlayback(); P.sig = '';
    showMsg(cfg.mode === 'video' ? 'No video chosen yet' : 'Nothing to show yet', 'Choose what this TV plays in Office Screens on your phone.');
    return;
  }
  var ready = list.filter(function (it) { return isReady(it.url); });
  if (!ready.length) { stopPlayback(); P.sig = ''; updateMsg(); return; }
  if (!P.err || P.err === 'storage') hideMsg();
  applySound();
  var single = cfg.mode === 'video' || (ready.length === 1 && ready[0].kind === 'video');
  var sig = (single ? 'single' : 'loop') + '|' + JSON.stringify(ready.map(function (x) { return [x.id, x.url, x.d]; })) + '|' + (cfg.sec || 8);
  if (sig === P.sig && P.cur && !wasOff) return;
  var prev = P.sig; P.sig = sig; P.list = ready;
  if (single) { playSingle(ready[0]); return; }
  var at = P.cur ? findIdx(ready, function (x) { return x.id === P.cur.id; }) : -1;
  if (at >= 0 && prev && !wasOff && P.curMode === 'loop') {
    P.idx = at;
    if (P.cur.kind !== 'video') armImage(P.cur, P.token);
    return;
  }
  P.idx = -1; next();
}
// A photo stays up for its time, then moves on (a lone photo just stays).
function armImage(it, tk) {
  clearTimeout(P.timer);
  if ((P.list || []).length > 1) P.timer = setTimeout(function () { if (tk === P.token) next(); }, Math.max(2, it.d || (P.cfg && P.cfg.sec) || 8) * 1000);
}
function makeVideo(src, loop) {
  var v = document.createElement('video');
  v.muted = !(P.cfg && P.cfg.sound && P.unlocked);
  v.playsInline = true; v.setAttribute('playsinline', ''); v.autoplay = true; v.preload = 'auto'; v.loop = !!loop;
  v.src = src;
  return v;
}
function playV(v) {
  var pr = v.play();
  if (pr && pr.catch) pr.catch(function () { v.muted = true; var p2 = v.play(); if (p2 && p2.catch) p2.catch(function () {}); });
}
function videoFailed(it, tk) {
  if (tk !== P.token) return;
  if (!P.retried[it.url] && !PREVIEW && HAS_CACHE) {
    P.retried[it.url] = true; P.sig = ''; P.cur = null;
    dropSaved(it.url).then(function () { refresh(); sync(); });
    return;
  }
  P.err = 'play';
  showMsg('This video can’t play on this TV', 'Export it as MP4 (H.264) and upload it again from your phone.');
  checkin(true);
}
function playSingle(it) {
  if (P.curMode === 'single' && P.cur && P.cur.url === it.url) { applySound(); return; }
  clearTimeout(P.timer);
  var tk = ++P.token; P.curMode = 'single'; P.cur = it; P.idx = 0; P.err = null;
  var back = P.layers[1 - P.front]; clearLayer(back); back.setAttribute('data-gen', String(tk));
  objUrl(it.url).then(function (src) {
    if (tk !== P.token) return;
    if (!src) { P.cur = null; P.sig = ''; refresh(); sync(); return; }
    var v = makeVideo(src, true), shown = false;
    v.addEventListener('playing', function () { if (tk !== P.token || shown) return; shown = true; swap(tk); hideMsg(); checkin(true); });
    v.addEventListener('error', function () { videoFailed(it, tk); });
    back.appendChild(v); playV(v);
  }, function () { if (tk === P.token) { P.cur = null; P.sig = ''; P.timer = setTimeout(refresh, 2000); } });
}
function next() {
  if (!P.active || !P.cfg || !P.cfg.power) return;
  var list = P.list || []; if (!list.length) return;
  clearTimeout(P.timer);
  var tk = ++P.token; P.curMode = 'loop';
  P.idx = (P.idx + 1) % list.length;
  var it = list[P.idx]; P.cur = it;
  var back = P.layers[1 - P.front]; clearLayer(back); back.setAttribute('data-gen', String(tk));
  objUrl(it.url).then(function (src) {
    if (tk !== P.token) return;
    if (!src) { P.timer = setTimeout(next, 500); return; }
    if (it.kind === 'video') {
      var v = makeVideo(src, false), shown = false;
      v.addEventListener('playing', function () { if (tk !== P.token || shown) return; shown = true; swap(tk); });
      v.addEventListener('ended', function () { if (tk === P.token) next(); });
      v.addEventListener('error', function () { if (tk === P.token) { clearTimeout(P.timer); P.timer = setTimeout(next, 1500); } });
      back.appendChild(v); playV(v);
      P.timer = setTimeout(function () { if (tk === P.token) next(); }, ((it.dur || 90) + 20) * 1000);
    } else {
      var img = new Image(); img.alt = '';
      img.onload = function () {
        if (tk !== P.token) return;
        back.appendChild(img); swap(tk);
        armImage(it, tk);
      };
      img.onerror = function () { if (tk === P.token) { clearTimeout(P.timer); P.timer = setTimeout(next, 1000); } };
      img.src = src;
    }
  }, function () { if (tk === P.token) P.timer = setTimeout(next, 1000); });
}
function swap(tk) {
  if (tk !== P.token) return;
  var old = P.layers[P.front]; P.front = 1 - P.front;
  var neu = P.layers[P.front];
  neu.classList.add('on'); old.classList.remove('on');
  var gen = old.getAttribute('data-gen');
  setTimeout(function () { if (old.getAttribute('data-gen') === gen && P.layers[P.front] !== old) clearLayer(old); }, 1200);
}
function clearLayer(l) {
  var vs = l.getElementsByTagName('video');
  for (var i = 0; i < vs.length; i++) { try { vs[i].pause(); vs[i].removeAttribute('src'); vs[i].load(); } catch (e) {} }
  l.innerHTML = '';
}
function stopPlayback() {
  P.token++; clearTimeout(P.timer); P.cur = null; P.idx = -1; P.curMode = null;
  if (P.layers) P.layers.forEach(function (l) { l.classList.remove('on'); clearLayer(l); });
}
function applySound() {
  if (!P.layers) return;
  var v = P.layers[P.front].getElementsByTagName('video')[0];
  if (v) v.muted = !(P.cfg && P.cfg.sound && P.unlocked);
}

/* ---------- on-screen messages ---------- */
function showMsg(title, text, pct) {
  $('#msgTitle').textContent = title || ''; $('#msgText').textContent = text || '';
  $('#msgBar').hidden = pct == null; if (pct != null) $('#msgFill').style.width = Math.max(2, pct) + '%';
  $('#msg').hidden = false;
}
function hideMsg() { $('#msg').hidden = true; }
function updateMsg() {
  if (!P.active || !P.cfg || P.removed || !P.cfg.power) return;
  var list = activeList(P.cfg); if (!list.length) return;
  if (list.some(function (it) { return isReady(it.url); })) return;
  if (P.dl) {
    var what = P.dl.of > 1 ? 'file ' + P.dl.n + ' of ' + P.dl.of : (P.cfg.mode === 'video' ? 'the video' : 'the first file');
    showMsg('Getting this TV ready', 'Saving ' + what + ' on the TV so it keeps playing without the internet. ' + P.dl.pct + '%', P.dl.pct);
  } else if (!P.online) {
    showMsg('Waiting for the internet', 'This TV hasn’t saved this content yet. It starts on its own once the TV is back online.');
  } else {
    showMsg('Getting this TV ready', 'Starting download…', 0);
  }
}
function setOnline(on) { if (P.online !== on) { P.online = on; netLabel(); updateMsg(); } }
function netLabel() {
  var el = $('#ovNet'), t = $('#ovNetText');
  if (!P.online) { el.className = 'net off'; t.textContent = 'Offline · playing what’s saved on this TV'; return; }
  el.className = 'net';
  if (P.dl) { t.textContent = 'Online · saving ' + (P.dl.of > 1 ? 'file ' + P.dl.n + ' of ' + P.dl.of : 'a file') + ' (' + P.dl.pct + '%)'; return; }
  if (P.err === 'storage') { t.textContent = 'Online · TV storage is full, playing from the internet'; return; }
  t.textContent = PREVIEW ? 'Preview · not saved on this device' : 'Online · everything saved on this TV';
}

/* ---------- check-ins ---------- */
function stateInfo() {
  var cfg = P.cfg || {}, want = wanted(cfg), have = want.filter(function (u) { return !!P.cached[u]; }).length;
  var st = !cfg.power ? 'off' : !activeList(cfg).length ? 'empty' : P.err === 'play' ? 'error' : P.cur ? 'playing' : (P.dl || P.syncing) ? 'downloading' : 'waiting';
  var dpr = window.devicePixelRatio || 1;
  return {
    state: st, pct: P.dl ? P.dl.pct : null, have: have, need: want.length, mode: cfg.mode || null,
    res: Math.round(screen.width * dpr) + 'x' + Math.round(screen.height * dpr), ver: CFG.version
  };
}
function checkin(force) {
  if (PREVIEW || !P.active || !P.cfg) return;
  var since = Date.now() - P.lastCheck;
  if (!force && since < CHECKIN_MS) return;
  if (force && since < 10000) { clearTimeout(P.checkT); P.checkT = setTimeout(function () { checkin(true); }, 10000 - since); return; }
  P.lastCheck = Date.now();
  var body = JSON.stringify({ p_screen: P.id, p_device: DEVICE, p_info: stateInfo() });
  var h = { 'Content-Type': 'application/json' }; for (var k in HDR) h[k] = HDR[k];
  fetch(REST + '/rpc/tv_checkin', { method: 'POST', headers: h, body: body, cache: 'no-store' })
    .then(function (r) { setOnline(r.ok || r.status < 500); }, function () { setOnline(false); });
}

/* ---------- remote control ---------- */
function showOverlay(ms, focus) {
  var ov = $('#ov');
  netLabel();
  ov.classList.add('show'); $('#player').classList.remove('idle');
  if (focus) { try { $('#bFull').focus({ preventScroll: true }); } catch (e) { $('#bFull').focus(); } }
  clearTimeout(P.hideT);
  P.hideT = setTimeout(function () {
    ov.classList.remove('show'); $('#player').classList.add('idle');
    if (ov.contains(document.activeElement)) document.activeElement.blur();
  }, ms);
}
function onFull() {
  P.unlocked = true; applySound();
  var d = document, el = d.documentElement;
  try {
    if (d.fullscreenElement || d.webkitFullscreenElement) { var x = (d.exitFullscreen || d.webkitExitFullscreen).call(d); if (x && x.catch) x.catch(function () {}); }
    else {
      var fn = el.requestFullscreen || el.webkitRequestFullscreen;
      if (fn) { var r = fn.call(el); if (r && r.catch) r.catch(function () {}); }
    }
  } catch (e) {}
  showOverlay(2500, false);
}
function fsLabel() { $('#bFull').textContent = (document.fullscreenElement || document.webkitFullscreenElement) ? 'Exit full screen' : 'Full screen'; }
function onChange() {
  if (!PREVIEW) store.del('os.screen');
  showPicker();
}
async function requestWake() {
  try {
    if ('wakeLock' in navigator && !P.wake && document.visibilityState === 'visible') {
      P.wake = await navigator.wakeLock.request('screen');
      P.wake.addEventListener('release', function () { P.wake = null; });
    }
  } catch (e) { P.wake = null; }
}
function onKey(e) {
  if (view === 'picker') { pickerKeys(e); return; }
  if (view !== 'player') return;
  var ov = $('#ov');
  if (!ov.classList.contains('show')) {
    showOverlay(8000, true);
    if (e.key === 'Enter' || e.keyCode === 13 || e.key === ' ') e.preventDefault();
    return;
  }
  if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
    var bs = Array.prototype.slice.call(document.querySelectorAll('.btns button')).filter(function (b) { return !b.hidden; });
    var i = bs.indexOf(document.activeElement);
    i = i < 0 ? 0 : (i + (e.key === 'ArrowRight' ? 1 : -1) + bs.length) % bs.length;
    bs[i].focus(); e.preventDefault();
  }
  showOverlay(8000, false);
}

/* ---------- start ---------- */
document.addEventListener('keydown', onKey);
document.addEventListener('click', function (e) {
  var b = e.target.closest ? e.target.closest('.pick') : null;
  if (b) choose(b.getAttribute('data-id'));
});
['pointermove', 'pointerdown'].forEach(function (t) { document.addEventListener(t, function () { if (view === 'player') showOverlay(5000, false); }, { passive: true }); });
document.addEventListener('fullscreenchange', fsLabel);
document.addEventListener('webkitfullscreenchange', fsLabel);
document.addEventListener('visibilitychange', function () { if (view === 'player' && document.visibilityState === 'visible') { requestWake(); poll(); } });
window.addEventListener('online', function () { if (view === 'player') poll(); else if (view === 'picker') showPicker(); });
window.addEventListener('offline', function () { setOnline(false); });
$('#bFull').addEventListener('click', onFull);
$('#bNext').addEventListener('click', function () { if (P.curMode === 'loop') next(); showOverlay(5000, false); });
$('#bChange').addEventListener('click', onChange);
// Reload once a day in the small hours so the TV picks up app updates and starts fresh.
setInterval(function () {
  var h = new Date().getHours();
  if (!PREVIEW && h === 3 && Date.now() - STARTED > 6 * 3600 * 1000 && P.online) location.reload();
}, 5 * 60 * 1000);

var first = qs.get('screen') || (PREVIEW ? null : store.get('os.screen'));
if (qs.get('screen') && !PREVIEW) store.set('os.screen', qs.get('screen'));
initCache().then(function () { if (first) startPlayer(first); else showPicker(); });
})();
