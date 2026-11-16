/* Office Screens — on/off schedule, shared by the phone panel and the TV player.

   A schedule lives on each screen row as:
     { on: true, days: [1,2,3,4,5], start: "08:00", end: "18:00", tz: "America/Detroit" }
   days: 0 = Sunday … 6 = Saturday. Times are 24-hour, in the office time zone.
   If end is earlier than start, the hours run past midnight (e.g. 20:00–02:00).
   Outside these hours the screen goes black. The power switch still wins: off is off.

   The TV works this out from its own clock, so the schedule keeps working offline. */
(function (root) {
'use strict';

var TZ = 'America/Detroit';
var DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
var WD = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function toMin(t) {
  var m = /^(\d{1,2}):(\d{2})$/.exec(String(t || ''));
  if (!m) return null;
  var h = +m[1], mi = +m[2];
  if (h > 23 || mi > 59) return null;
  return h * 60 + mi;
}

/* Normalise whatever is stored into a schedule we can trust, or null. */
function clean(s) {
  if (!s || typeof s !== 'object') return null;
  var start = toMin(s.start), end = toMin(s.end);
  if (start == null || end == null || start === end) return null;
  var days = [];
  (Array.isArray(s.days) ? s.days : []).forEach(function (d) {
    d = +d; if (d >= 0 && d <= 6 && days.indexOf(d) < 0) days.push(d);
  });
  days.sort();
  if (!days.length) return null;
  return { on: !!s.on, days: days, start: start, end: end, tz: typeof s.tz === 'string' && s.tz ? s.tz : TZ };
}

/* Day of week and minutes past midnight, in the schedule's time zone. */
function localNow(now, tz) {
  var d = now instanceof Date ? now : new Date(now == null ? Date.now() : now);
  try {
    var parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(d);
    var o = {};
    parts.forEach(function (p) { o[p.type] = p.value; });
    var h = +o.hour % 24, m = +o.minute;
    if (o.weekday in WD && isFinite(h) && isFinite(m)) return { day: WD[o.weekday], min: h * 60 + m };
  } catch (e) {}
  return { day: d.getDay(), min: d.getHours() * 60 + d.getMinutes() };
}

/* Is the schedule calling for the screen to be on right now? No schedule = always on. */
function isOnNow(schedule, now) {
  var s = clean(schedule);
  if (!s || !s.on) return true;
  var t = localNow(now, s.tz);
  if (s.start < s.end) return s.days.indexOf(t.day) >= 0 && t.min >= s.start && t.min < s.end;
  // Past midnight: the evening part belongs to today, the early-morning part to yesterday.
  if (t.min >= s.start) return s.days.indexOf(t.day) >= 0;
  if (t.min < s.end) return s.days.indexOf((t.day + 6) % 7) >= 0;
  return false;
}

function fmtTime(min) {
  var h = Math.floor(min / 60), m = min % 60, ap = h < 12 ? 'AM' : 'PM', h12 = h % 12 || 12;
  return h12 + (m ? ':' + (m < 10 ? '0' : '') + m : '') + ' ' + ap;
}

function fmtDays(days) {
  var k = days.join(',');
  if (k === '0,1,2,3,4,5,6') return 'every day';
  if (k === '1,2,3,4,5') return 'weekdays';
  if (k === '0,6') return 'weekends';
  if (k === '1,2,3,4,5,6') return 'Mon–Sat';
  return days.map(function (d) { return DAY[d]; }).join(', ');
}

/* "8 AM–6 PM weekdays", or '' when there's no active schedule. */
function describe(schedule) {
  var s = clean(schedule);
  if (!s || !s.on) return '';
  return fmtTime(s.start) + '–' + fmtTime(s.end) + ' ' + fmtDays(s.days);
}

/* When the screen next comes on, as "Mon 8 AM" (or "8 AM" if it's later today). */
function nextOn(schedule, now) {
  var s = clean(schedule);
  if (!s || !s.on) return '';
  var t = localNow(now, s.tz);
  for (var i = 0; i <= 7; i++) {
    var d = (t.day + i) % 7;
    if (s.days.indexOf(d) < 0) continue;
    if (i === 0 && t.min >= s.start) continue;
    return (i === 0 ? '' : i === 1 ? 'tomorrow ' : DAY[d] + ' ') + fmtTime(s.start);
  }
  return '';
}

var api = { TZ: TZ, DAY: DAY, clean: clean, isOnNow: isOnNow, describe: describe, nextOn: nextOn, toMin: toMin, fmtTime: fmtTime };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
else root.OSSchedule = api;
})(typeof self !== 'undefined' ? self : this);
