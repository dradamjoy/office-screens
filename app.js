/* Office Screens — phone control panel */
(function () {
'use strict';

var CFG = window.OS_CONFIG;
var MB = 1048576;
var STEPS = [3, 5, 8, 10, 12, 15, 20, 30, 45, 60];
var PDF_BASE = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/';
var LIVE_MS = 3 * 60 * 1000;           // a TV checks in every minute
var POLL_MS = 15000;

/* ---------- helpers ---------- */
function $(s) { return document.querySelector(s); }
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
function rid(n) { var a = ''; while (a.length < (n || 10)) a += Math.random().toString(36).slice(2); return a.slice(0, n || 10); }
function pad2(n) { return (n < 10 ? '0' : '') + n; }
function fmtDur(s) { s = Math.round(s || 0); return Math.floor(s / 60) + ':' + pad2(s % 60); }
function fmtBytes(b) { b = b || 0; if (b >= 1e9) return (b / 1e9).toFixed(1) + ' GB'; if (b >= 1e6) return (b / 1e6).toFixed(1) + ' MB'; return Math.max(1, Math.round(b / 1e3)) + ' KB'; }
function plural(n, w) { return n + ' ' + w + (n === 1 ? '' : 's'); }
function ago(t) {
  var s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return 'just now'; if (s < 3600) return Math.round(s / 60) + ' min ago'; if (s < 86400) return Math.round(s / 3600) + ' h ago';
  try { return 'on ' + new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }); } catch (e) { return 'days ago'; }
}
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
function clone(o) { return JSON.parse(JSON.stringify(o == null ? null : o)); }
function find(a, fn) { for (var i = 0; i < a.length; i++) { if (fn(a[i])) return a[i]; } return null; }
function findIdx(a, fn) { for (var i = 0; i < a.length; i++) { if (fn(a[i])) return i; } return -1; }
function stripExt(n) { return String(n || '').replace(/\.[a-z0-9]{2,5}$/i, '') || 'Untitled'; }
function setSwitch(el, on) { el.setAttribute('aria-checked', on ? 'true' : 'false'); }
function pub(path) { return CFG.url + '/storage/v1/object/public/' + CFG.bucket + '/' + String(path).split('/').map(encodeURIComponent).join('/'); }
function baseUrl() { return location.href.replace(/[#?].*$/, '').replace(/[^/]*$/, ''); }
function tvAddress() { return baseUrl() + 'tv/'; }
function shortAddr(u) { return u.replace(/^https?:\/\//, '').replace(/\/$/, ''); }

if (!window.supabase || !CFG) {
  $('#loadingMsg').textContent = 'Couldn’t load Office Screens. Check the internet connection and reload.';
  return;
}
var sb = window.supabase.createClient(CFG.url, CFG.key, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } });

/* ---------- state ---------- */
var S = {
  session: null, admin: false, ready: false, signup: false,
  screens: {}, order: [], media: [], checkins: {},
  view: null, editId: null, dirty: {}, inflight: {}, timers: {},
  sel: [], libPick: 'loop', upChain: null, pollT: null, started: false
};
var Q = {};
function enqueue(key, fn) { var p = (Q[key] || Promise.resolve()).catch(function () {}).then(fn); Q[key] = p; return p; }

var toastT;
function toast(msg, kind) {
  var t = $('#toast'); t.textContent = msg; t.className = 'toast' + (kind === 'error' ? ' is-error' : ''); t.hidden = false;
  clearTimeout(toastT); toastT = setTimeout(function () { t.hidden = true; }, kind === 'error' ? 6000 : 3000);
}
function dbMsg(err) {
  var m = (err && (err.message || err.error_description)) || '';
  if (/JWT|token|auth/i.test(m)) return 'Your sign-in expired. Sign in again.';
  if (/row-level security|permission|42501/i.test(m) || (err && err.code === '42501')) return 'This login isn’t allowed to change the TVs.';
  if (/Failed to fetch|NetworkError|network/i.test(m)) return 'No connection. Check the internet and try again.';
  return 'Couldn’t save that change. Try again.';
}
async function db(promise) {
  var r = await promise;
  if (r.error) throw r.error;
  return r.data;
}

/* ---------- screen edits: change locally, then one write at a time ---------- */
function changeScreen(id, patch, delay) {
  var s = S.screens[id]; if (!s) return;
  var d = S.dirty[id] || (S.dirty[id] = {});
  Object.keys(patch).forEach(function (k) { s[k] = patch[k]; d[k] = true; });
  render();
  clearTimeout(S.timers[id]);
  S.timers[id] = setTimeout(function () { flush(id); }, delay || 0);
}
function flush(id) {
  return enqueue('screens/' + id, async function () {
    var d = S.dirty[id]; if (!d) return;
    var keys = Object.keys(d); if (!keys.length) return;
    S.dirty[id] = {};
    var s = S.screens[id]; if (!s) return;
    var body = {};
    keys.forEach(function (k) { body[k] = s[k]; });
    S.inflight[id] = keys;
    try {
      var r = await sb.from('screens').update(body).eq('id', id).select('id');
      if (r.error) throw r.error;
      if (!r.data || !r.data.length) throw { code: '42501', message: 'permission' };
    } catch (e) {
      toast(dbMsg(e), 'error');
      loadScreens();
    } finally { S.inflight[id] = null; }
  });
}

/* ---------- loading ---------- */
async function loadScreens() {
  try {
    var rows = await db(sb.from('screens').select('*').order('sort', { ascending: true }));
    var next = {};
    rows.forEach(function (row) {
      var cur = S.screens[row.id];
      if (cur) { Object.keys(S.dirty[row.id] || {}).concat(S.inflight[row.id] || []).forEach(function (k) { row[k] = cur[k]; }); }
      next[row.id] = row;
    });
    S.screens = next;
    S.order = rows.map(function (r) { return r.id; });
    S.ready = true;
    render();
  } catch (e) {
    if (!S.ready) $('#loadingMsg').textContent = 'Couldn’t load your screens. Check the connection and reload.';
  }
}
async function loadCheckins() {
  try {
    var rows = await db(sb.from('checkins').select('screen_id,device_id,seen,info'));
    var by = {};
    rows.forEach(function (r) { r.t = Date.parse(r.seen); (by[r.screen_id] = by[r.screen_id] || []).push(r); });
    Object.keys(by).forEach(function (k) { by[k].sort(function (a, b) { return b.t - a.t; }); });
    S.checkins = by;
    if (S.view === 'screens') renderScreens(); else if (S.view === 'edit') renderEditStatus();
  } catch (e) {}
}
async function loadMedia() {
  try {
    S.media = await db(sb.from('media').select('*').order('created_at', { ascending: false }).limit(1000));
    if (S.view === 'edit') renderEdit();
    if (!$('#libSheet').hidden) renderLibrary();
  } catch (e) {}
}
function startPolling() {
  if (S.pollT) return;
  S.pollT = setInterval(function () {
    if (document.visibilityState !== 'visible' || !S.admin) return;
    loadScreens(); loadCheckins();
  }, POLL_MS);
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible' && S.admin) { loadScreens(); loadCheckins(); }
  });
}

/* ---------- auth ---------- */
async function onSession(session) {
  S.session = session;
  if (!session) {
    S.admin = false; S.ready = false; S.screens = {}; S.order = []; S.media = [];
    route(); return;
  }
  var who = null;
  try { who = await db(sb.rpc('whoami')); } catch (e) {}
  S.admin = !!(who && who.admin);
  if (S.admin) {
    await Promise.all([loadScreens(), loadCheckins()]);
    loadMedia();
    startPolling();
  }
  route();
}
function setAuthMode(signup) {
  S.signup = signup;
  $('#authTitle').textContent = signup ? 'Create your login' : 'Sign in';
  $('#authSub').textContent = signup ? 'Use the setup code from Claude. Only a login made with it can change the TVs.' : 'Sign in to change what plays on the office TVs.';
  $('#codeField').hidden = !signup;
  $('#passHint').hidden = !signup;
  $('#authPass').setAttribute('autocomplete', signup ? 'new-password' : 'current-password');
  $('#authSubmit').textContent = signup ? 'Create login' : 'Sign in';
  $('#authSwitchText').textContent = signup ? 'Already have a login?' : 'First time here?';
  $('#authToggle').textContent = signup ? 'Sign in' : 'Create your login';
  authMsg('');
}
function authMsg(text, ok) {
  var m = $('#authMsg'); m.textContent = text || ''; m.hidden = !text; m.className = 'form-msg' + (ok ? ' ok' : '');
}
async function onAuthSubmit(e) {
  e.preventDefault();
  var email = $('#authEmail').value.trim(), pass = $('#authPass').value, code = $('#authCode').value.trim().toUpperCase();
  if (!email || !/@/.test(email)) { authMsg('Enter your email address.'); $('#authEmail').focus(); return; }
  if (!pass) { authMsg('Enter your password.'); $('#authPass').focus(); return; }
  if (S.signup && pass.length < 8) { authMsg('Use at least 8 characters for the password.'); $('#authPass').focus(); return; }
  if (S.signup && !code) { authMsg('Enter the setup code from Claude.'); $('#authCode').focus(); return; }
  var btn = $('#authSubmit'); btn.disabled = true; authMsg('');
  try {
    if (S.signup) {
      btn.textContent = 'Creating…';
      var up = await sb.auth.signUp({ email: email, password: pass, options: { data: { setup_code: code } } });
      if (up.error && !/already registered/i.test(up.error.message || '')) throw up.error;
    } else {
      btn.textContent = 'Signing in…';
    }
    var r = await sb.auth.signInWithPassword({ email: email, password: pass });
    if (r.error) {
      var m = r.error.message || '';
      if (/not confirmed/i.test(m)) throw new Error(S.signup ? 'That setup code didn’t work. Check it and try again, or ask Claude for a new one.' : 'This login hasn’t been set up to control the TVs.');
      if (/invalid login/i.test(m)) throw new Error(S.signup ? 'That email already has a login with a different password. Sign in instead.' : 'Email or password is wrong.');
      throw r.error;
    }
    $('#authPass').value = ''; $('#authCode').value = '';
  } catch (err) {
    var msg = err && err.message ? err.message : 'Something went wrong. Try again.';
    if (/Failed to fetch|NetworkError/i.test(msg)) msg = 'No connection. Check the internet and try again.';
    if (/rate limit/i.test(msg)) msg = 'Too many attempts. Wait a few minutes, then try again.';
    if (/sending confirmation email/i.test(msg)) msg = 'Supabase couldn’t send its welcome email to that address. Use the email on your Supabase account, or ask Claude to finish setting up your login.';
    authMsg(msg);
  } finally {
    btn.disabled = false; btn.textContent = S.signup ? 'Create login' : 'Sign in';
  }
}

/* ---------- routing ---------- */
function route() {
  var h = (location.hash || '').replace(/^#/, ''), m;
  if (!S.session) return show('auth');
  if (!S.admin) return show('denied');
  if (!S.ready) return show('loading');
  if ((m = /^edit-([A-Za-z0-9_-]+)$/.exec(h))) return show('edit', m[1]);
  return show('screens');
}
function show(view, arg) {
  var changed = S.view !== view || (view === 'edit' && S.editId !== arg);
  S.view = view;
  ['Loading', 'Auth', 'Denied', 'Screens', 'Edit'].forEach(function (n) { $('#view' + n).hidden = (view !== n.toLowerCase()); });
  $('#addbar').hidden = (view !== 'edit');
  if (view === 'edit') S.editId = arg;
  if (changed) window.scrollTo(0, 0);
  if (view !== 'edit' && !$('#libSheet').hidden) closeLibrary();
  render();
}
function render() {
  if (S.view === 'screens') renderScreens();
  else if (S.view === 'edit') renderEdit();
  else if (S.view === 'denied') {
    var em = S.session && S.session.user && S.session.user.email;
    $('#deniedText').textContent = 'You’re signed in' + (em ? ' as ' + em : '') + ', but this login hasn’t been given access to Office Screens. Ask Claude for a setup code, or sign in with the login you created first.';
  }
  if (!$('#libSheet').hidden) renderLibrary();
  updateTop();
}
function updateTop() {
  var b = $('#allBtn'), showAll = S.admin && S.ready && S.order.length > 0 && S.view !== 'auth';
  b.hidden = !showAll;
  if (showAll) { var anyOn = S.order.some(function (id) { return S.screens[id].power; }); b.textContent = anyOn ? 'All off' : 'All on'; }
}

/* ---------- status ---------- */
function itemSec(s, it) { return it.kind === 'video' ? (it.dur || 0) : (it.d || s.sec || 8); }
function loopSec(s) { var t = 0; (s.items || []).forEach(function (it) { t += itemSec(s, it); }); return t; }
function lastCheckin(id) { var l = S.checkins[id]; return l && l.length ? l[0] : null; }
function statusOf(id) {
  var s = S.screens[id] || {}, c = lastCheckin(id);
  var fresh = c && (Date.now() - c.t) <= LIVE_MS;
  if (!s.power) return { cls: 'off', label: fresh ? 'Off · TV connected' : 'Off' };
  if (!c) return { cls: 'wait', label: 'Waiting for a TV' };
  if (!fresh) return { cls: 'stale', label: 'Last seen ' + ago(c.t) };
  var info = c.info || {};
  if (info.state === 'downloading') return { cls: 'busy', label: 'Downloading' + (info.pct != null ? ' ' + info.pct + '%' : '') };
  if (info.state === 'empty') return { cls: 'wait', label: 'Connected · nothing to play' };
  if (info.state === 'error') return { cls: 'stale', label: 'Can’t play this file' };
  return { cls: 'live', label: 'Playing' };
}
function pillHTML(st) { return '<span class="pill ' + st.cls + '"><i></i>' + esc(st.label) + '</span>'; }
function previewItem(s) {
  if (s.mode === 'video') return s.video || null;
  return (s.items || [])[0] || null;
}
function glassHTML(s, emptyText, big) {
  var it = previewItem(s), tag = s.mode === 'video' ? '<span class="glass-tag">Video</span>' : '';
  if (it && it.thumb) return '<img src="' + esc(pub(it.thumb)) + '" alt="">' + (big ? tag : '');
  if (it && it.kind === 'video') return '<span class="glyph-play"></span>' + (big ? tag : '');
  return '<span class="glass-empty">' + esc(emptyText || '') + '</span>';
}
function summary(s) {
  if (s.mode === 'video') return s.video ? 'One video · ' + fmtDur(s.video.dur) + ' on repeat' : 'One video · none chosen';
  var n = (s.items || []).length;
  return 'Slideshow · ' + plural(n, 'item') + (n ? ' · ' + fmtDur(loopSec(s)) : '');
}

/* ---------- screens list ---------- */
function renderScreens() {
  var ids = S.order;
  $('#emptyScreens').hidden = ids.length > 0;
  var live = 0, off = 0;
  ids.forEach(function (id) { var c = statusOf(id).cls; if (c === 'live') live++; if (c === 'off') off++; });
  $('#screensSub').textContent = ids.length ? plural(ids.length, 'TV') + ' · ' + live + ' playing' + (off ? ' · ' + off + ' off' : '') : '';
  $('#screenList').innerHTML = ids.map(function (id) {
    var s = S.screens[id], st = statusOf(id);
    return '<article class="scard">' +
      '<button type="button" class="scard-main" data-act="open" data-id="' + esc(id) + '" aria-label="Edit ' + esc(s.name) + '">' +
        '<span class="monitor' + (s.power ? '' : ' is-off') + '"><span class="glass">' + glassHTML(s, 'Empty') + '</span><span class="led ' + st.cls + '"></span></span>' +
        '<span class="scard-info"><h3>' + esc(s.name) + '</h3><span class="meta">' + esc(summary(s)) + '</span>' + pillHTML(st) + '</span>' +
      '</button>' +
      '<button type="button" class="switch" role="switch" aria-checked="' + (s.power ? 'true' : 'false') + '" data-act="power" data-id="' + esc(id) + '" aria-label="' + esc(s.name) + ' screen"><span></span></button>' +
    '</article>';
  }).join('');
  $('#tvAddrList').textContent = shortAddr(tvAddress());
  var em = S.session && S.session.user && S.session.user.email;
  $('#whoLine').textContent = em ? 'Signed in as ' + em : '';
}
async function onAddScreen(e) {
  e.preventDefault();
  var name = $('#newName').value.trim(); if (!name) return;
  var base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 20).replace(/-+$/, '');
  var id = (base || 'tv') + '-' + rid(3);
  var maxSort = 0; S.order.forEach(function (k) { maxSort = Math.max(maxSort, S.screens[k].sort || 0); });
  try {
    var row = await db(sb.from('screens').insert({ id: id, name: name, sort: maxSort + 1 }).select('*').single());
    S.screens[row.id] = row; S.order.push(row.id);
    $('#newName').value = '';
    location.hash = 'edit-' + row.id;
  } catch (err) { toast(dbMsg(err), 'error'); }
}
function onAll() {
  var anyOn = S.order.some(function (id) { return S.screens[id].power; });
  S.order.forEach(function (id) { if (!!S.screens[id].power === anyOn) changeScreen(id, { power: !anyOn }); });
  toast(anyOn ? 'All screens switched off.' : 'All screens switched on.');
}

/* ---------- editor ---------- */
function captureFocus() {
  var a = document.activeElement; if (!a || !a.closest) return null;
  var li = a.closest('[data-iid]'); if (!li) return null;
  return { iid: li.getAttribute('data-iid'), act: a.getAttribute('data-act') };
}
function restoreFocus(f) {
  if (!f || !f.act) return;
  var el = document.querySelector('[data-iid="' + f.iid + '"] [data-act="' + f.act + '"]');
  if (el && !el.disabled) { try { el.focus({ preventScroll: true }); } catch (e) { el.focus(); } }
}
function thumbHTML(it) {
  if (it.thumb) return '<img src="' + esc(pub(it.thumb)) + '" alt="" loading="lazy">';
  return it.kind === 'video' ? '<span class="glyph-play"></span>' : '';
}
function itemHTML(s, it, i, n) {
  var isV = it.kind === 'video';
  var kind = isV ? 'Video · ' + fmtDur(it.dur) + (s.sound ? '' : ' · muted') : (it.src === 'pdf' ? 'Slide' : 'Photo');
  var ctrl = isV ? '<span class="dur-static">Plays to the end</span>' :
    '<span class="stepper"><button type="button" data-act="dur-" aria-label="Show for less time">−</button><output>' + (it.d || s.sec || 8) + ' s</output><button type="button" data-act="dur+" aria-label="Show for longer">+</button></span>';
  return '<li class="item" data-iid="' + esc(it.id) + '">' +
    '<span class="idx">' + pad2(i + 1) + '</span>' +
    '<span class="thumb">' + thumbHTML(it) + '</span>' +
    '<span class="item-info"><p class="item-name">' + esc(it.name || 'Untitled') + '</p><p class="item-kind">' + esc(kind) + '</p></span>' +
    '<button type="button" class="icon-btn item-x" data-act="remove" aria-label="Remove from slideshow">×</button>' +
    '<span class="item-ctrl">' + ctrl + '<span class="move">' +
      '<button type="button" class="icon-btn" data-act="up" aria-label="Move earlier"' + (i === 0 ? ' disabled' : '') + '>↑</button>' +
      '<button type="button" class="icon-btn" data-act="down" aria-label="Move later"' + (i === n - 1 ? ' disabled' : '') + '>↓</button>' +
    '</span></span>' +
  '</li>';
}
function vcardHTML(s) {
  var v = s.video;
  var acts = '<div class="vcard-actions"><button type="button" class="btn btn-sm" data-act="pick-video"' + (videosInLibrary() ? '' : ' disabled') + '>' + (v ? 'Choose another' : 'Choose from library') + '</button><button type="button" class="btn btn-sm btn-primary" data-act="upload-video">Upload a video</button></div>';
  if (!v) return '<div class="empty small"><p>No video chosen yet. Upload one, or pick one you’ve already uploaded. It plays on repeat with no gaps.</p>' + acts + '</div>';
  return '<div class="vcard"><span class="thumb">' + thumbHTML(v) + '</span><div class="vcard-info"><p class="item-name">' + esc(v.name || 'Untitled') + '</p>' +
    '<p class="meta">' + fmtDur(v.dur) + (v.w ? ' · ' + v.w + '×' + v.h : '') + (v.bytes ? ' · ' + fmtBytes(v.bytes) : '') + '</p>' +
    '<p class="item-kind">Plays nonstop' + (s.sound ? ' with sound' : ', muted') + '</p></div></div>' + acts;
}
function videosInLibrary() { return S.media.some(function (m) { return m.kind === 'video'; }); }
function renderEdit() {
  var id = S.editId, s = S.screens[id];
  $('#edMissing').hidden = !!s; $('#edBody').hidden = !s;
  $('#addbar').hidden = !s || s.mode === 'video';
  if (!s) return;
  var nm = $('#edName'); if (document.activeElement !== nm) nm.value = s.name || '';
  setSwitch($('#edPower'), !!s.power);
  $('#edPower').setAttribute('aria-label', s.power ? 'Screen on' : 'Screen off');
  var isVideo = s.mode === 'video', items = s.items || [];
  $('#edGlass').innerHTML = glassHTML(s, isVideo ? 'No video chosen' : 'Empty slideshow', true);
  $('#edMonitor').classList.toggle('is-off', !s.power);
  $('#edStats').textContent = summary(s);
  $('#modeVideo').setAttribute('aria-pressed', isVideo ? 'true' : 'false');
  $('#modeLoop').setAttribute('aria-pressed', isVideo ? 'false' : 'true');
  $('#videoSection').hidden = !isVideo;
  $('#loopSection').hidden = isVideo;
  $('#secRow').hidden = isVideo;
  if (isVideo) $('#vcard').innerHTML = vcardHTML(s);
  $('#fitContain').setAttribute('aria-pressed', s.fit !== 'cover' ? 'true' : 'false');
  $('#fitCover').setAttribute('aria-pressed', s.fit === 'cover' ? 'true' : 'false');
  $('#edSec').value = String(s.sec || 8);
  setSwitch($('#edSound'), !!s.sound);
  $('#edCount').textContent = items.length ? plural(items.length, 'item') : '';
  $('#itemsEmpty').hidden = items.length > 0;
  if (!isVideo) {
    var f = captureFocus();
    $('#items').innerHTML = items.map(function (it, i) { return itemHTML(s, it, i, items.length); }).join('');
    restoreFocus(f);
  }
  $('#edNameInline').textContent = s.name;
  $('#tvAddr').textContent = shortAddr(tvAddress());
  $('#previewBtn').setAttribute('href', 'tv/?screen=' + encodeURIComponent(id) + '&preview=1');
  $('#uploadBtn').textContent = isVideo ? 'Upload a video' : 'Add photos, videos, PDF';
  $('#libBtn').disabled = !S.media.length;
  renderEditStatus();
}
function renderEditStatus() {
  var id = S.editId, s = S.screens[id]; if (!s) return;
  var st = statusOf(id), c = lastCheckin(id), n = (S.checkins[id] || []).filter(function (r) { return Date.now() - r.t <= LIVE_MS; }).length;
  $('#edState').innerHTML = pillHTML(st) + (n > 1 ? '<span class="meta">' + n + ' TVs showing this</span>' : '');
  $('#edLed').className = 'led ' + st.cls;
  var rep = 'No TV has opened this one yet.';
  if (c) {
    var info = c.info || {};
    rep = 'A TV last checked in ' + ago(c.t);
    if (info.res) rep += ' · screen ' + String(info.res).replace('x', ' × ');
    if (info.need) rep += ' · ' + (info.have || 0) + ' of ' + info.need + ' files saved on the TV';
  }
  $('#tvReport').textContent = rep;
}
function stepVal(v, dir) {
  var i;
  if (dir > 0) { for (i = 0; i < STEPS.length; i++) { if (STEPS[i] > v) return STEPS[i]; } return STEPS[STEPS.length - 1]; }
  for (i = STEPS.length - 1; i >= 0; i--) { if (STEPS[i] < v) return STEPS[i]; } return STEPS[0];
}
function itemAction(act, iid) {
  var id = S.editId, s = S.screens[id]; if (!s) return;
  var items = clone(s.items || []), i = findIdx(items, function (x) { return x.id === iid; });
  if (i < 0) return;
  if (act === 'remove') { items.splice(i, 1); changeScreen(id, { items: items }); toast('Removed from the slideshow. It stays in your library.'); return; }
  if (act === 'up' && i > 0) { var a = items[i - 1]; items[i - 1] = items[i]; items[i] = a; }
  else if (act === 'down' && i < items.length - 1) { var b = items[i + 1]; items[i + 1] = items[i]; items[i] = b; }
  else if (act === 'dur-' || act === 'dur+') { items[i].d = stepVal(items[i].d || s.sec || 8, act === 'dur+' ? 1 : -1); }
  else return;
  changeScreen(id, { items: items }, act.indexOf('dur') === 0 ? 800 : 300);
}
function onSec() {
  var id = S.editId, s = S.screens[id]; if (!s) return;
  var old = s.sec || 8, nv = parseInt(this.value, 10) || 8;
  var items = clone(s.items || []), changed = false;
  items.forEach(function (it) { if (it.kind !== 'video' && (it.d || old) === old) { it.d = nv; changed = true; } });
  var patch = { sec: nv }; if (changed) patch.items = items;
  changeScreen(id, patch);
}
function setMode(mode) {
  var id = S.editId, s = S.screens[id]; if (!s || s.mode === mode) return;
  changeScreen(id, { mode: mode });
}
function onRemove() {
  var id = S.editId, s = S.screens[id]; if (!s) return;
  confirmBox({ title: 'Remove ' + s.name + '?', body: 'A TV showing it will stop. The files stay in your library.', ok: 'Remove' }).then(async function (yes) {
    if (!yes) return;
    clearTimeout(S.timers[id]); S.dirty[id] = {};
    try {
      await db(sb.from('screens').delete().eq('id', id));
      delete S.screens[id]; S.order = S.order.filter(function (x) { return x !== id; });
      location.hash = 'screens';
      toast('Removed ' + s.name + '.');
    } catch (e) { toast(dbMsg(e), 'error'); }
  });
}
function onCopy() {
  var t = tvAddress();
  try { navigator.clipboard.writeText(t).then(function () { toast('TV address copied.'); }, function () { toast(shortAddr(t)); }); }
  catch (e) { toast(shortAddr(t)); }
}

/* ---------- confirm ---------- */
function confirmBox(o) {
  return new Promise(function (res) {
    var el = $('#confirmSheet');
    $('#cfTitle').textContent = o.title; $('#cfBody').textContent = o.body; $('#cfYes').textContent = o.ok || 'Delete';
    el.hidden = false; $('#cfNo').focus();
    function done(v) { el.hidden = true; $('#cfYes').onclick = null; $('#cfNo').onclick = null; res(v); }
    $('#cfYes').onclick = function () { done(true); };
    $('#cfNo').onclick = function () { done(false); };
  });
}

/* ---------- library ---------- */
function openLibrary(pick) {
  S.libPick = pick || 'loop'; S.sel = [];
  $('#libTitle').textContent = S.libPick === 'video' ? 'Choose a video' : 'Library';
  $('#libSheet').hidden = false; renderLibrary(); loadMedia(); $('#libClose').focus();
}
function closeLibrary() { $('#libSheet').hidden = true; }
function libItems() { return S.libPick === 'video' ? S.media.filter(function (m) { return m.kind === 'video'; }) : S.media; }
function renderLibrary() {
  var list = libItems();
  S.sel = S.sel.filter(function (id) { return !!find(list, function (m) { return m.id === id; }); });
  var bytes = 0; S.media.forEach(function (m) { bytes += m.bytes || 0; });
  $('#libUsage').textContent = plural(S.media.length, 'file') + ' · ' + fmtBytes(bytes) + ' stored';
  $('#libEmpty').hidden = list.length > 0;
  $('#libEmpty').textContent = S.libPick === 'video' ? 'No videos uploaded yet.' : 'Nothing uploaded yet.';
  $('#libGrid').innerHTML = list.map(function (m) {
    var n = S.sel.indexOf(m.id);
    return '<button type="button" class="tile" data-act="tile" data-mid="' + esc(m.id) + '" aria-pressed="' + (n >= 0) + '" aria-label="' + esc(m.name || 'File') + '">' +
      (m.thumb ? '<img src="' + esc(pub(m.thumb)) + '" alt="" loading="lazy">' : (m.kind === 'video' ? '<span class="glyph-play"></span>' : '')) +
      (m.kind === 'video' ? '<span class="tile-badge">' + fmtDur(m.dur) + '</span>' : '') +
      (n >= 0 ? '<span class="tile-check">' + (S.libPick === 'video' ? '✓' : (n + 1)) + '</span>' : '') +
    '</button>';
  }).join('');
  var k = S.sel.length, add = $('#libAdd');
  add.disabled = !k;
  add.textContent = S.libPick === 'video' ? 'Play this video' : (k ? 'Add ' + k + ' to slideshow' : 'Add to slideshow');
  $('#libDelete').disabled = !k; $('#libDelete').textContent = k ? 'Delete ' + k : 'Delete';
}
function toggleTile(mid) {
  if (S.libPick === 'video') { S.sel = S.sel[0] === mid ? [] : [mid]; renderLibrary(); return; }
  var i = S.sel.indexOf(mid); if (i >= 0) S.sel.splice(i, 1); else S.sel.push(mid); renderLibrary();
}
function itemFromMedia(m, s) {
  return { id: rid(10), m: m.id, path: m.path, thumb: m.thumb || null, kind: m.kind, name: m.name || 'Untitled',
    d: m.kind === 'video' ? null : (s.sec || 8), dur: m.dur || null, w: m.w || null, h: m.h || null, bytes: m.bytes || null, src: m.source || null };
}
function onLibAdd() {
  var id = S.editId, s = S.screens[id]; if (!s) return;
  if (S.libPick === 'video') {
    var m = find(S.media, function (x) { return x.id === S.sel[0]; });
    if (m) { changeScreen(id, { video: itemFromMedia(m, s), mode: 'video' }); toast('This TV now plays ' + (m.name || 'the video') + ' nonstop.'); }
    closeLibrary(); return;
  }
  var items = clone(s.items || []), n = 0;
  S.sel.forEach(function (mid) { var mm = find(S.media, function (x) { return x.id === mid; }); if (mm) { items.push(itemFromMedia(mm, s)); n++; } });
  changeScreen(id, { items: items }); closeLibrary(); toast('Added ' + plural(n, 'item') + ' to the slideshow.');
}
function onLibDelete() {
  var ids = S.sel.slice(); if (!ids.length) return;
  confirmBox({ title: 'Delete ' + plural(ids.length, 'file') + '?', body: 'They’re removed from the library and from every TV that uses them. This can’t be undone.', ok: 'Delete' }).then(async function (yes) {
    if (!yes) return;
    var waits = [];
    S.order.forEach(function (sid) {
      var sc = S.screens[sid], its = sc.items || [], patch = {};
      var kept = its.filter(function (it) { return ids.indexOf(it.m) < 0; });
      if (kept.length !== its.length) patch.items = clone(kept);
      if (sc.video && ids.indexOf(sc.video.m) >= 0) patch.video = null;
      if (Object.keys(patch).length) { changeScreen(sid, patch); waits.push(flush(sid)); }
    });
    await Promise.all(waits).catch(function () {});
    var paths = [];
    ids.forEach(function (mid) { var m = find(S.media, function (x) { return x.id === mid; }); if (m) { paths.push(m.path); if (m.thumb) paths.push(m.thumb); } });
    try {
      await db(sb.from('media').delete().in('id', ids));
      if (paths.length) await sb.storage.from(CFG.bucket).remove(paths);
      S.media = S.media.filter(function (m) { return ids.indexOf(m.id) < 0; });
      S.sel = []; renderLibrary(); render(); toast('Deleted ' + plural(ids.length, 'file') + '.');
    } catch (e) { toast(dbMsg(e), 'error'); loadMedia(); }
  });
}

/* ---------- uploads ---------- */
function kindOf(f) {
  var n = (f.name || '').toLowerCase(), t = f.type || '';
  if (t === 'application/pdf' || /\.pdf$/.test(n)) return 'pdf';
  if (t.indexOf('video/') === 0 || /\.(mp4|m4v|mov|webm)$/.test(n)) return 'video';
  if (t.indexOf('image/') === 0 || /\.(jpe?g|png|webp|gif|heic|heif|avif)$/.test(n)) return 'image';
  return null;
}
function uploadRow(name, box) {
  var row = document.createElement('div'); row.className = 'up';
  var nm = document.createElement('span'); nm.className = 'up-name'; nm.textContent = name;
  var st = document.createElement('span'); st.className = 'up-state'; st.textContent = 'Waiting…';
  var bar = document.createElement('span'); bar.className = 'up-bar';
  row.appendChild(nm); row.appendChild(st); row.appendChild(bar); (box || $('#uploads')).appendChild(row);
  return {
    set: function (t, p) { st.textContent = t; if (p != null) bar.style.width = Math.round(p * 100) + '%'; },
    done: function (t) { row.classList.add('is-done'); bar.style.width = '100%'; st.textContent = t || 'Added'; setTimeout(function () { if (row.parentNode) row.parentNode.removeChild(row); }, 4000); },
    fail: function (t) {
      row.classList.add('is-fail'); st.textContent = t;
      var x = document.createElement('button'); x.type = 'button'; x.className = 'icon-btn'; x.setAttribute('aria-label', 'Dismiss'); x.textContent = '×';
      x.onclick = function () { if (row.parentNode) row.parentNode.removeChild(row); }; row.appendChild(x);
    }
  };
}
function handleFiles(files, screenId, target) {
  var box = target === 'video' ? $('#uploadsV') : $('#uploads');
  files.forEach(function (f) {
    var row = uploadRow(f.name || 'File', box);
    S.upChain = (S.upChain || Promise.resolve()).then(function () {
      return processFile(f, screenId, row, target).then(function (t) { row.done(t); }, function (e) { row.fail((e && e.message) || 'Upload failed. Try again.'); });
    });
  });
}
function processFile(f, id, row, target) {
  var k = kindOf(f);
  if (target === 'video' && k !== 'video') return Promise.reject(new Error('Choose a video file (MP4 works best).'));
  if (k === 'pdf') return processPdf(f, id, row);
  if (k === 'video') return processVideo(f, id, row, target);
  if (k === 'image') return processImage(f, id, row);
  return Promise.reject(new Error('Only photos, videos and PDFs can be shown.'));
}
function newPath(dir, ext) { var d = new Date(); return dir + '/' + d.getFullYear() + pad2(d.getMonth() + 1) + '/' + Date.now().toString(36) + '-' + rid(6) + '.' + ext; }
async function putFile(path, blob, type, onProgress) {
  var r = await sb.auth.getSession();
  var session = r && r.data && r.data.session;
  if (!session) throw new Error('Your sign-in expired. Sign in again.');
  return new Promise(function (res, rej) {
    var xhr = new XMLHttpRequest();
    xhr.open('POST', CFG.url + '/storage/v1/object/' + CFG.bucket + '/' + path.split('/').map(encodeURIComponent).join('/'));
    xhr.setRequestHeader('Authorization', 'Bearer ' + session.access_token);
    xhr.setRequestHeader('apikey', CFG.key);
    xhr.setRequestHeader('Content-Type', type);
    xhr.setRequestHeader('cache-control', 'max-age=31536000');
    xhr.setRequestHeader('x-upsert', 'false');
    if (onProgress) xhr.upload.onprogress = function (e) { if (e.lengthComputable) onProgress(e.loaded / e.total); };
    xhr.onload = function () {
      if (xhr.status >= 200 && xhr.status < 300) return res();
      var body = ''; try { body = xhr.responseText || ''; } catch (e) {}
      if (xhr.status === 413 || /too large|exceeded the maximum/i.test(body)) return rej(new Error('Too big for your storage plan (' + CFG.maxFileMB + ' MB per file).'));
      if (/mime type|not supported/i.test(body)) return rej(new Error('This file type can’t be stored. Use MP4, JPEG, PNG or PDF.'));
      if (xhr.status === 401 || xhr.status === 403) return rej(new Error('Your sign-in expired or this login can’t upload. Sign in again.'));
      rej(new Error('Upload failed (' + xhr.status + '). Try again.'));
    };
    xhr.onerror = function () { rej(new Error('Upload failed. Check the connection and try again.')); };
    xhr.send(blob);
  });
}
async function addMedia(screenId, media, target) {
  var row = await db(sb.from('media').insert(media).select('*').single());
  S.media.unshift(row);
  var s = S.screens[screenId]; if (!s) return row;
  if (target === 'video' || (s.mode === 'video' && row.kind === 'video' && !s.video)) changeScreen(screenId, { video: itemFromMedia(row, s), mode: 'video' });
  else if (s.mode !== 'video') changeScreen(screenId, { items: (s.items || []).concat([itemFromMedia(row, s)]) });
  else render();
  return row;
}
function drawTo(src, w, h, max, bg) {
  var k = Math.min(1, max / Math.max(w, h)), c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w * k)); c.height = Math.max(1, Math.round(h * k));
  var x = c.getContext('2d'); x.fillStyle = bg || '#000'; x.fillRect(0, 0, c.width, c.height); x.drawImage(src, 0, 0, c.width, c.height);
  return c;
}
function toBlob(c, q) {
  return new Promise(function (res, rej) { c.toBlob(function (b) { if (b) res(b); else rej(new Error('Couldn’t prepare this image.')); }, 'image/jpeg', q || 0.9); });
}
async function decodeImage(file) {
  try {
    var bmp = await createImageBitmap(file);
    return { src: bmp, w: bmp.width, h: bmp.height, close: function () { try { bmp.close(); } catch (e) {} } };
  } catch (e) {
    var url = URL.createObjectURL(file);
    return await new Promise(function (res, rej) {
      var img = new Image();
      img.onload = function () { res({ src: img, w: img.naturalWidth, h: img.naturalHeight, close: function () { URL.revokeObjectURL(url); } }); };
      img.onerror = function () { URL.revokeObjectURL(url); rej(new Error('This photo format can’t be read here. Export it as JPEG and try again.')); };
      img.src = url;
    });
  }
}
async function processImage(file, id, row) {
  row.set('Preparing…');
  var im = await decodeImage(file);
  var long = Math.max(im.w, im.h);
  var okType = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'].indexOf(file.type) >= 0;
  var blob = file, type = file.type, w = im.w, h = im.h;
  if (!okType || long > 3840 || (file.size > 12 * MB && file.type !== 'image/gif')) {
    var c = drawTo(im.src, im.w, im.h, 3840, '#000'); blob = await toBlob(c, 0.92); type = 'image/jpeg'; w = c.width; h = c.height; c.width = c.height = 0;
  }
  var th = await toBlob(drawTo(im.src, im.w, im.h, 480, '#000'), 0.8);
  im.close();
  var ext = type === 'image/png' ? 'png' : type === 'image/webp' ? 'webp' : type === 'image/gif' ? 'gif' : 'jpg';
  var path = newPath('img', ext), tpath = newPath('thumb', 'jpg');
  await putFile(path, blob, type, function (p) { row.set('Uploading ' + Math.round(p * 100) + '%', p * 0.95); });
  await putFile(tpath, th, 'image/jpeg');
  await addMedia(id, { kind: 'image', path: path, thumb: tpath, name: stripExt(file.name), w: w, h: h, bytes: blob.size, source: 'photo' });
  return 'Added';
}
function videoMeta(file) {
  return new Promise(function (resolve) {
    var url = URL.createObjectURL(file), v = document.createElement('video'), done = false;
    v.muted = true; v.playsInline = true; v.setAttribute('playsinline', ''); v.preload = 'auto';
    function finish(thumb) {
      if (done) return; done = true; clearTimeout(to);
      var out = { dur: isFinite(v.duration) ? Math.round(v.duration * 10) / 10 : null, w: v.videoWidth || null, h: v.videoHeight || null, thumb: thumb };
      try { v.removeAttribute('src'); v.load(); } catch (e) {}
      URL.revokeObjectURL(url); resolve(out);
    }
    var to = setTimeout(function () { finish(null); }, 15000);
    v.addEventListener('loadedmetadata', function () {
      var t = Math.min(1, (isFinite(v.duration) ? v.duration : 2) * 0.1);
      try { v.currentTime = t; } catch (e) { finish(null); }
    });
    v.addEventListener('seeked', function () {
      try { toBlob(drawTo(v, v.videoWidth || 480, v.videoHeight || 270, 480, '#000'), 0.8).then(finish, function () { finish(null); }); }
      catch (e) { finish(null); }
    });
    v.addEventListener('error', function () { finish(null); });
    v.src = url;
  });
}
async function processVideo(file, id, row, target) {
  if (file.size > CFG.maxFileMB * MB) throw new Error(fmtBytes(file.size) + ' is over your plan’s ' + CFG.maxFileMB + ' MB limit. Export it smaller, or upgrade storage.');
  row.set('Reading video…');
  var meta = await videoMeta(file);
  var n = (file.name || '').toLowerCase();
  var type = file.type && file.type.indexOf('video/') === 0 ? file.type : (/\.webm$/.test(n) ? 'video/webm' : /\.mov$/.test(n) ? 'video/quicktime' : 'video/mp4');
  if (type === 'video/x-m4v') type = 'video/mp4';
  var ext = type === 'video/webm' ? 'webm' : type === 'video/quicktime' ? 'mov' : 'mp4';
  var path = newPath('video', ext), tpath = meta.thumb ? newPath('thumb', 'jpg') : null;
  await putFile(path, file, type, function (p) { row.set('Uploading ' + Math.round(p * 100) + '% of ' + fmtBytes(file.size), p * 0.97); });
  if (tpath) { try { await putFile(tpath, meta.thumb, 'image/jpeg'); } catch (e) { tpath = null; } }
  await addMedia(id, { kind: 'video', path: path, thumb: tpath, name: stripExt(file.name), w: meta.w, h: meta.h, dur: meta.dur, bytes: file.size, source: 'video' }, target);
  return target === 'video' ? 'Now playing on this TV' : 'Added';
}
function loadScript(src) {
  return new Promise(function (res, rej) {
    var s = document.createElement('script'); s.src = src; s.onload = res;
    s.onerror = function () { rej(new Error('Couldn’t load the PDF reader. Check the connection and try again.')); };
    document.head.appendChild(s);
  });
}
var pdfP = null;
function loadPdf() {
  if (!pdfP) {
    pdfP = loadScript(PDF_BASE + 'pdf.min.js').then(function () {
      var lib = window.pdfjsLib || window['pdfjs-dist/build/pdf'];
      if (!lib) throw new Error('The PDF reader didn’t start. Reload and try again.');
      lib.GlobalWorkerOptions.workerSrc = PDF_BASE + 'pdf.worker.min.js';
      return lib;
    });
    pdfP.catch(function () { pdfP = null; });
  }
  return pdfP;
}
async function processPdf(file, id, row) {
  row.set('Opening PDF…');
  var lib = await loadPdf();
  var pdf = await lib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  var n = pdf.numPages, deck = stripExt(file.name);
  if (n > 150) { pdf.destroy(); throw new Error('That PDF has ' + n + ' pages. Split it into decks of 150 slides or fewer.'); }
  for (var i = 1; i <= n; i++) {
    row.set('Slide ' + i + ' of ' + n, (i - 1) / n);
    var page = await pdf.getPage(i);
    var v1 = page.getViewport({ scale: 1 });
    var vp = page.getViewport({ scale: 3840 / Math.max(v1.width, v1.height) });
    var c = document.createElement('canvas'); c.width = Math.round(vp.width); c.height = Math.round(vp.height);
    var ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    var full = await toBlob(c, 0.88), th = await toBlob(drawTo(c, c.width, c.height, 480, '#fff'), 0.8);
    var path = newPath('img', 'jpg'), tpath = newPath('thumb', 'jpg');
    await putFile(path, full, 'image/jpeg');
    await putFile(tpath, th, 'image/jpeg');
    await addMedia(id, { kind: 'image', path: path, thumb: tpath, name: deck + ' · slide ' + i, w: c.width, h: c.height, bytes: full.size, source: 'pdf' });
    try { page.cleanup(); } catch (e) {}
    c.width = c.height = 0;
  }
  try { pdf.destroy(); } catch (e) {}
  return 'Added ' + plural(n, 'slide');
}
function pickFiles(target) {
  var inp = $('#fileIn');
  inp.dataset.target = target;
  inp.multiple = target !== 'video';
  inp.accept = target === 'video' ? 'video/mp4,video/quicktime,video/webm,.mp4,.mov,.m4v,.webm' : 'image/*,video/mp4,video/quicktime,video/webm,.mov,.m4v,application/pdf,.pdf';
  inp.click();
}

/* ---------- events ---------- */
function onClick(e) {
  var b = e.target.closest ? e.target.closest('[data-act]') : null; if (!b) return;
  var act = b.getAttribute('data-act'), id = b.getAttribute('data-id');
  if (act === 'power') { var s = S.screens[id]; if (s) changeScreen(id, { power: !s.power }); }
  else if (act === 'open') { location.hash = 'edit-' + id; }
  else if (act === 'tile') { toggleTile(b.getAttribute('data-mid')); }
  else if (act === 'copy-addr') { onCopy(); }
  else if (act === 'pick-video') { openLibrary('video'); }
  else if (act === 'upload-video') { pickFiles('video'); }
  else { var li = b.closest('[data-iid]'); if (li) itemAction(act, li.getAttribute('data-iid')); }
}
function bind() {
  window.addEventListener('hashchange', route);
  document.addEventListener('click', onClick);
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    if (!$('#confirmSheet').hidden) $('#cfNo').click();
    else if (!$('#libSheet').hidden) closeLibrary();
  });
  $('#authForm').addEventListener('submit', onAuthSubmit);
  $('#authToggle').addEventListener('click', function () { setAuthMode(!S.signup); });
  $('#signOut').addEventListener('click', function () { sb.auth.signOut(); });
  $('#deniedOut').addEventListener('click', function () { sb.auth.signOut(); });
  $('#addForm').addEventListener('submit', onAddScreen);
  $('#allBtn').addEventListener('click', onAll);
  $('#edName').addEventListener('input', function () { var id = S.editId; if (S.screens[id]) changeScreen(id, { name: this.value.trim() || 'Untitled TV' }, 900); });
  $('#edName').addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); this.blur(); } });
  $('#edName').addEventListener('blur', function () { var id = S.editId; if (id && S.screens[id]) { clearTimeout(S.timers[id]); flush(id); renderEdit(); } });
  $('#edPower').addEventListener('click', function () { var s = S.screens[S.editId]; if (s) changeScreen(S.editId, { power: !s.power }); });
  $('#edSound').addEventListener('click', function () { var s = S.screens[S.editId]; if (s) changeScreen(S.editId, { sound: !s.sound }); });
  $('#fitContain').addEventListener('click', function () { if (S.screens[S.editId]) changeScreen(S.editId, { fit: 'contain' }); });
  $('#fitCover').addEventListener('click', function () { if (S.screens[S.editId]) changeScreen(S.editId, { fit: 'cover' }); });
  $('#modeVideo').addEventListener('click', function () { setMode('video'); });
  $('#modeLoop').addEventListener('click', function () { setMode('loop'); });
  $('#edSec').addEventListener('change', onSec);
  $('#uploadBtn').addEventListener('click', function () { var s = S.screens[S.editId]; pickFiles(s && s.mode === 'video' ? 'video' : 'loop'); });
  $('#fileIn').addEventListener('change', function () {
    var fs = Array.prototype.slice.call(this.files || []), target = this.dataset.target || 'loop'; this.value = '';
    if (fs.length) handleFiles(fs, S.editId, target);
  });
  $('#libBtn').addEventListener('click', function () { openLibrary('loop'); });
  $('#libClose').addEventListener('click', closeLibrary);
  $('#libSheet').addEventListener('click', function (e) { if (e.target === this) closeLibrary(); });
  $('#libAdd').addEventListener('click', onLibAdd);
  $('#libDelete').addEventListener('click', onLibDelete);
  $('#removeTv').addEventListener('click', onRemove);
  setInterval(function () { if (S.view === 'screens') renderScreens(); else if (S.view === 'edit') renderEditStatus(); }, 30000);
}

/* ---------- start ---------- */
bind();
setAuthMode(false);
var seen = false;
sb.auth.onAuthStateChange(function (event, session) {
  if (event === 'TOKEN_REFRESHED') { S.session = session; return; }
  var same = seen && S.session && session && S.session.user && session.user && S.session.user.id === session.user.id;
  seen = true;
  if (same) { S.session = session; return; }
  setTimeout(function () { onSession(session); }, 0);
});
})();
