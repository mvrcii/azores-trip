import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import '@fontsource/patrick-hand/latin-400.css';
import './style.css';
import { fetchWeather, forecastFor, todayIn, locKey, sky, LIMITS } from './wxcore.js';
import { ico, wxOf } from './icons.js';

/* ---------- small helpers ---------- */
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : (JSON.parse(v) ?? d); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } },
};
const toMin = (t) => +t.slice(0, 2) * 60 + +t.slice(3, 5);
const hm = (m) => { const x = ((Math.round(m) % 1440) + 1440) % 1440; return `${String(Math.floor(x / 60)).padStart(2, '0')}:${String(x % 60).padStart(2, '0')}`; };
const dur = (m) => (m >= 60 ? `${Math.floor(m / 60)} h${m % 60 ? ' ' + (m % 60) : ''}` : `${m} min`);
const km = (m) => (m >= 10000 ? Math.round(m / 1000) : (m / 1000).toFixed(1)) + ' km';
const n1 = (v) => (v == null ? '–' : v.toFixed(1));
const r0 = (v) => (v == null ? '–' : Math.round(v));
function dist(a, b) {
  const R = 6371000, r = Math.PI / 180;
  const x = (b.lon - a.lon) * r * Math.cos(((a.lat + b.lat) / 2) * r), y = (b.lat - a.lat) * r;
  return Math.sqrt(x * x + y * y) * R;
}
const DAY_COLORS = ['#9c6a00', '#1a7d79', '#8a4fb0', '#7a5a3a', '#a84a86', '#5468c4', '#227d4d', '#6b6f1f', '#4a7a9c']; // ≥ 4.5:1 with white; no reds (warnings) and no route blue
const RM = matchMedia('(prefers-reduced-motion: reduce)').matches;
const WIDE = matchMedia('(min-width: 900px) and (min-height: 500px)');
const MODE = {
  drive: { color: '#2563eb', weight: 4.5 },
  walk: { color: '#22a559', weight: 3.5, dashArray: '5 8' },
  hike: { color: '#14632f', weight: 4 },
  boat: { color: '#0e9aa7', weight: 4, dashArray: '1 9' },
};
const TYPE = { view: 'Viewpoint', hike: 'Hike', hotspring: 'Hot spring', food: 'Food', boat: 'Boat trip', sight: 'Sight', logistics: 'Travel' };
const fmtDate = (d, opt) => new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', ...opt }).format(new Date(d + 'T12:00:00Z'));
const IOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

/* ---------- trips ---------- */
// Each trip keeps its own ticks, time shifts, routes, forecast and cached plan under trip:<id>:<key>.
const params = new URLSearchParams(location.search);
let tripId = null;
const tstore = {
  get: (k, d) => store.get(`trip:${tripId}:${k}`, d),
  set: (k, v) => store.set(`trip:${tripId}:${k}`, v),
};
const LEGACY_TRIP = 'sao-miguel-2026'; // the only trip before trips became files
// Keys saved before trips were namespaced belong to São Miguel. The live app (/) and the preview (/next/) share
// this origin's storage, and the live app still reads and writes the old keys, so they are copied, never deleted.
// Ticks and time shifts are copied again whenever the live app changed them since the last copy.
function migrateLegacy() {
  const raw = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
  const put = (k, v) => { try { localStorage.setItem(k, v); } catch { /* storage blocked or full */ } };
  for (const k of ['routes.v1', 'wx.v1', 'itin.v1']) { // caches: the first copy is enough
    const v = raw(k), nk = `trip:${LEGACY_TRIP}:${k}`;
    if (v != null && raw(nk) == null) put(nk, v);
  }
  for (const k of ['done.v1', 'shift.v1']) { // ticks from both apps are kept; the live app's shifts win
    const v = raw(k), nk = `trip:${LEGACY_TRIP}:${k}`, seen = `trip:${LEGACY_TRIP}:legacy.${k}`;
    if (v == null || v === raw(seen)) continue; // nothing there, or nothing new since the last copy
    try { put(nk, JSON.stringify({ ...JSON.parse(raw(nk) || '{}'), ...JSON.parse(v) })); put(seen, v); } catch { /* unreadable: leave both alone */ }
  }
}
function cachedTrips() { // offline and no saved index: the trips whose plan this phone already has
  const out = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const id = localStorage.key(i).match(/^trip:([a-z0-9-]+):itin\.v1$/)?.[1];
      const it = id && store.get(`trip:${id}:itin.v1`, null);
      if (it?.days?.length && it.timezone) out.push({ id, start: it.days[0].date, end: it.days[it.days.length - 1].date, timezone: it.timezone });
    }
  } catch { /* none */ }
  return out.sort((a, b) => (a.start < b.start ? -1 : 1));
}
const validTrips = (list) => (Array.isArray(list) ? list.filter((t) => /^[a-z0-9-]+$/.test(t?.id || '') && t.start && t.end && t.timezone) : []);
async function loadIndex() {
  try {
    const r = await fetch('data/trips/index.json', { signal: AbortSignal.timeout?.(8000), cache: 'no-cache' });
    const list = r.ok ? validTrips((await r.json())?.trips) : [];
    if (list.length) { store.set('trips.v1', list); return list; }
  } catch { /* offline */ }
  return null;
}
// ?trip=<id>, else the trip that contains today, else the next one, else the first.
function pickTrip(list) {
  const want = params.get('trip');
  if (want && list.some((t) => t.id === want)) return want;
  const today = (t) => params.get('now')?.slice(0, 10) || todayIn(t.timezone).date;
  const sorted = [...list].sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
  return (sorted.find((t) => t.start <= today(t) && today(t) <= t.end) || sorted.find((t) => t.start > today(t)) || sorted[0])?.id || null;
}
function setTrip(id) {
  tripId = id;
  state.routes = tstore.get('routes.v1', {}); state.done = tstore.get('done.v1', {}); state.shift = tstore.get('shift.v1', {});
}
let freshIndex = null; // the index request still running behind a choice made from the saved index
async function chooseTrip() { // true when a trip is chosen
  if (tripId) return true;
  const fresh = loadIndex();
  let list = validTrips(store.get('trips.v1', null));
  const want = params.get('trip');
  if (!list.length || (want && !list.some((t) => t.id === want))) list = (await fresh) || list; // nothing to go on: wait for the network
  else freshIndex = fresh; // the phone knows its trips: open one now, never wait on weak signal; followIndex() checks the fresh list
  if (!list.length) list = cachedTrips();
  const id = list.length ? pickTrip(list) : null;
  if (!id) return false;
  setTrip(id);
  return true;
}
// A fresh index can change the choice: a new trip under way, or the open trip removed. Switch then, unless the user
// has moved around in the open trip, which still exists.
async function followIndex() {
  const fresh = freshIndex; freshIndex = null;
  const list = fresh && (await fresh);
  if (!list || !tripId) return;
  const id = pickTrip(list), gone = !list.some((t) => t.id === tripId);
  if (id && id !== tripId && (gone || !state.touched)) await switchTrip(id, gone);
}
// The trip on screen stays fully in charge (its ticks, shifts and storage) until the new trip's plan is in hand;
// then id, state and plan change together, with no await in between.
let switching = null;
async function switchTrip(id, force) {
  switching = id;
  const fresh = await fetchItin(id);
  if (switching !== id) return; // another switch started meanwhile
  switching = null;
  if (!force && state.touched) return; // the user started looking around while the plan loaded: leave them be
  const itin = fresh || store.get(`trip:${id}:itin.v1`, null);
  if (!itin?.days?.length) return; // the new trip cannot be shown: stay on the one on screen
  const prev = { tripId, itin: state.itin, days: state.days, tz: state.tz, wx: state.wx, routes: state.routes, done: state.done, shift: state.shift };
  setTrip(id); state.wx = null; adoptWx(tstore.get('wx.v1', null));
  try { applyItin(itin); } catch (err) { // unusable plan: back to the trip on screen, untouched
    console.error(err);
    tripId = prev.tripId; Object.assign(state, { itin: prev.itin, days: prev.days, tz: prev.tz, wx: prev.wx, routes: prev.routes, done: prev.done, shift: prev.shift });
    return;
  }
  if (fresh) tstore.set('itin.v1', fresh);
  state.touched = false;
  start(); refreshWeather(true); ensureRoutes();
}

/* ---------- state ---------- */
const state = {
  itin: null, days: [], tz: 'UTC', view: 'trip', sel: null, snap: 'half', wx: null, routes: {},
  done: {}, shift: {}, lastWxTry: 0, me: null, optsOpen: false, touched: false, listTop: 0,
};
function now() {
  const o = params.get('now'); // ?now=2026-11-13T10:30 for testing, in the trip's local time
  return o ? { date: o.slice(0, 10), min: toMin(o.slice(11, 16)) } : todayIn(state.tz);
}

/* ---------- itinerary → per-day model ---------- */
const routeKey = (a, b) => `${a.lon.toFixed(5)},${a.lat.toFixed(5)};${b.lon.toFixed(5)},${b.lat.toFixed(5)}`;
function buildDay(day, idx) {
  const bases = state.itin.bases || {};
  const stops = day.items.filter((i) => !i.mode);
  const segs = [], driveTo = {};
  let car = day.start ? bases[day.start] : null;
  let me = car;
  for (const s of stops) {
    if (s.parking) {
      if (car && dist(car, s.parking) > 40) {
        const seg = { mode: 'drive', from: car, to: s.parking, key: routeKey(car, s.parking), stop: s.id };
        segs.push(seg); driveTo[s.id] = seg;
      }
      car = s.parking;
      if (s.walk.polyline || dist(s.parking, s) > 25) segs.push({ mode: 'walk', stop: s.id, pts: s.walk.polyline || [[s.parking.lat, s.parking.lon], [s.lat, s.lon]] });
    } else if (me && dist(me, s) > 25) {
      segs.push({ mode: 'walk', stop: s.id, pts: s.walk.polyline || [[me.lat, me.lon], [s.lat, s.lon]] });
    }
    me = s;
    if (s.route) {
      segs.push({ mode: s.route.mode, stop: s.id, pts: s.route.polyline });
      const end = s.route.polyline[s.route.polyline.length - 1];
      me = { lat: end[0], lon: end[1] };
    }
  }
  const byId = Object.fromEntries(stops.map((s) => [s.id, s]));
  for (const leg of day.items.filter((i) => i.mode)) {
    const a = byId[leg.from], b = byId[leg.to];
    if (!a || !b) continue;
    if (leg.mode === 'drive') segs.push({ mode: 'drive', from: a.parking || a, to: b.parking || b, key: routeKey(a.parking || a, b.parking || b) });
    else segs.push({ mode: leg.mode, pts: [[a.lat, a.lon], [b.lat, b.lon]] });
  }
  return { ...day, idx, color: DAY_COLORS[idx % DAY_COLORS.length], stops, segs, driveTo };
}

// Running-late shift: moves every stop of the day except fixed ones (bookings, flights).
const isFixed = (s) => s.bookingNeeded || s.fixed === true || s.status === 'booked';
const shiftOf = (day) => state.shift[day.date] || 0;
const eff = (day, s) => toMin(s.time) + (isFixed(s) ? 0 : shiftOf(day));

function driveInfo(seg) {
  if (!seg) return null;
  const r = state.routes[seg.key];
  if (r) return { min: Math.max(1, Math.round(r.s / 60)), m: r.m, est: false };
  const m = dist(seg.from, seg.to) * 1.45; // rough until the router answers
  return { min: Math.max(1, Math.round(m / 1000 / 38 * 60)), m, est: true };
}
function travelTo(day, i) { // minutes needed between stop i-1 and stop i
  const s = day.stops[i], p = day.stops[i - 1];
  if (!s.parking) return { min: s.walk.minutes, est: false };
  const d = driveInfo(day.driveTo[s.id]);
  if (!d) return { min: s.walk.minutes + (p?.parking ? p.walk.minutes : 0), est: false }; // same car park: walk back, walk on
  const back = p ? (p.returnMin ?? p.walk.minutes) : 0; // walk (or taxi) back to where the car is
  return { min: d.min + s.walk.minutes + back, est: d.est };
}
function leaveBy(day, i) { // when to leave stop i (or the base, for i = -1) to reach stop i+1 on time
  const n = day.stops[i + 1];
  if (!n) return null;
  const tr = travelTo(day, i + 1);
  const by = eff(day, n) - tr.min - (n.arriveEarlyMin || 0);
  if (i < 0) return tr.min >= 3 ? { by, tr, next: n, short: 0, clash: false } : null;
  const s = day.stops[i];
  return { by, tr, next: n, short: eff(day, s) + s.durationMin - by, clash: by < eff(day, s) && isFixed(n) && !isFixed(s) };
}
function dayTotals(day) {
  let min = 0, m = 0, est = false, walk = 0;
  for (const seg of day.segs.filter((s) => s.mode === 'drive')) { const d = driveInfo(seg); min += d.min; m += d.m; est = est || d.est; }
  for (const s of day.stops) walk += (s.parking ? 2 : 1) * s.walk.km + (s.type === 'hike' ? parseFloat(((s.note || '').match(/([\d.]+)\s*km/) || [])[1] || 0) : 0);
  return { min, m, est, walk };
}

/* ---------- weather ---------- */
const wxAgeMin = () => (state.wx?.fetchedAt ? (Date.now() - state.wx.fetchedAt) / 60000 : Infinity);
function adoptWx(wx) {
  if (!wx?.fetchedAt || !Object.keys(wx.loc || {}).length) return false;
  if (!Object.values(wx.loc).every((W) => ['t', 'pp', 'pr', 'tc', 'at', 'ws', 'wg', 'cc', 'wc'].every((k) => Array.isArray(W?.[k])) && ['d', 'rise', 'set'].every((k) => Array.isArray(W.sun?.[k])))) return false; // incomplete or foreign data
  for (const [k, S] of Object.entries(wx.sea || {})) if (!['t', 'wh', 'wp', 'sh'].every((f) => Array.isArray(S?.[f]))) delete wx.sea[k];
  if (state.wx && state.wx.fetchedAt >= wx.fetchedAt) return false;
  const old = state.wx;
  if (old) { // a partial fetch on weak signal must not wipe sea, tide or model-range data we already have
    if (!Object.keys(wx.sea || {}).length && Object.keys(old.sea || {}).length) wx.sea = old.sea;
    for (const [k, W] of Object.entries(wx.loc)) if (!W.gLo && old.loc?.[k]?.gLo && old.loc[k].t.length === W.t.length && old.loc[k].t[0] === W.t[0]) { W.gLo = old.loc[k].gLo; W.gHi = old.loc[k].gHi; }
  }
  state.wx = wx; tstore.set('wx.v1', wx); return true;
}
let wxBusy = false;
async function refreshWeather(force) {
  if (!state.itin || wxBusy) return;
  if (!force && Date.now() - state.lastWxTry < 60000) return;
  state.lastWxTry = Date.now(); wxBusy = true; paintAge();
  const id = tripId;
  try {
    const wx = await fetchWeather(state.itin, todayIn(state.tz).date, fetch, state.wx);
    if (tripId === id && adoptWx(wx)) render();
  } catch {
    try { // hourly snapshot published with the site
      const r = await fetch(`weather/${id}.json?t=${Math.floor(Date.now() / 600000)}`, { signal: AbortSignal.timeout?.(8000) });
      if (r.ok && tripId === id && adoptWx(await r.json())) render();
    } catch { /* offline: keep what we have */ }
  }
  wxBusy = false; state.wxTried = true;
  if (tripId !== id) return refreshWeather(true); // another trip was opened meanwhile: fetch its forecast
  if (!state.wx) renderList();
  paintAge();
}
function ageText() {
  const a = wxAgeMin(), off = navigator.onLine === false;
  if (!isFinite(a)) return off ? 'offline' : 'loading';
  return (off ? 'offline, ' : '') + (a < 1 ? 'just now' : a < 90 ? `${Math.round(a)} min ago` : `${Math.round(a / 60)} h ago`);
}
function paintAge() {
  const a = wxAgeMin();
  document.body.classList.toggle('stale', a > 60);
  const b = $('#wxStatus');
  if (!b) return;
  const t = b.querySelector('#wxAge');
  if (t.textContent !== ageText()) t.textContent = ageText();
  b.classList.toggle('old', a > 60 || navigator.onLine === false);
  b.classList.toggle('busy', wxBusy);
}
const statusBtn = () => `<button id="wxStatus" class="wx-status" type="button" data-refresh><span><span class="sr">Weather updated </span><span id="wxAge">${ageText()}</span><span class="sr">. Tap to refresh.</span></span><span class="dot" aria-hidden="true"></span></button>`;

const fc = (day, s) => forecastFor(state.wx, s, day.date, hm(eff(day, s)), s.durationMin);
function sunOf(day) {
  const S = state.wx?.loc[locKey(day.stops[0])]?.sun;
  const i = S ? S.d.indexOf(day.date) : -1;
  return i >= 0 ? { rise: S.rise[i].slice(11), set: S.set[i].slice(11) } : null;
}
function dayHours(day) { // 07–21, each hour read at the stop you are at by then
  if (!state.wx) return [];
  const out = [];
  for (let h = 7; h <= 21; h++) {
    const s = [...day.stops].reverse().find((x) => eff(day, x) <= h * 60 + 59) || day.stops[0];
    const W = state.wx.loc[locKey(s)];
    const i = W ? W.t.indexOf(`${day.date}T${String(h).padStart(2, '0')}:00`) : -1;
    if (i >= 0) out.push({ h, pp: W.pp[i] ?? 0, pr: W.pr[i] ?? 0, wg: W.wg[i] ?? 0, tc: W.tc[i], wc: sky(W, i) });
  }
  return out;
}
function verdict(hours) { // the day at a glance, as icon + value pairs
  if (!hours.length) return '';
  const at = (h) => `${String(h).padStart(2, '0')}:00`;
  const wet = hours.reduce((a, b) => (b.pp > a.pp ? b : a)), gust = hours.reduce((a, b) => (b.wg > a.wg ? b : a));
  const wetHours = hours.filter((h) => h.pp >= LIMITS.rain).length;
  const rain = wet.pp < 25 ? `${ico('sun')}dry` : wet.pp < LIMITS.rain ? `${ico('drizzle')}showers ${at(wet.h)}` : wetHours >= 8 ? `${ico('rain')}rain all day` : `${ico('rain')}rain ${at(wet.h)}`;
  const g = Math.round(gust.wg);
  const wind = g >= LIMITS.gust ? `<span${g >= LIMITS.gustSevere ? ' class="hot"' : ''}>${ico('wind')}<span class="sr">gusts </span>${g} km/h</span>` : '';
  return `<span>${rain}</span>${wind}`;
}
const SEV_ORDER = ['wave', 'gust', 'rain'];
const topWarn = (f) => { for (const k of SEV_ORDER) { const w = f?.warn.find((x) => x.sev >= 2 && x.kind === k); if (w) return w; } return null; };
function worst(day) { // the one thing to know about a day, if anything is really wrong
  for (const s of day.stops) { const w = fc(day, s)?.warn.find((x) => x.sev >= 2 && x.kind === 'wave'); if (w) return `${w.text.replace(/ at \d\d:00/, '')} at ${s.name}`; }
  const hours = dayHours(day);
  if (hours.length) { const g = hours.reduce((a, b) => (b.wg > a.wg ? b : a)); if (g.wg >= LIMITS.gustSevere) return `Storm gusts ${Math.round(g.wg)} km/h around ${String(g.h).padStart(2, '0')}:00`; }
  for (const s of day.stops) { const w = fc(day, s)?.warn.find((x) => x.sev >= 2 && x.kind !== 'wave'); if (w) return `${w.text.replace(/ at \d\d:00/, '')} at ${s.name}`; }
  return '';
}
function clearerWindow(day, s, f) { // viewpoints: a nearby hour with much less cloud
  const W = state.wx?.loc[locKey(s)];
  if (!W || f.now.cc < 60) return null;
  const sun = sunOf(day), t0 = eff(day, s);
  let best = null;
  for (let m = Math.max(7 * 60, t0 - 120); m <= t0 + 180; m += 60) {
    if (sun && m > toMin(sun.set)) break;
    const i = W.t.indexOf(`${day.date}T${hm(m).slice(0, 2)}:00`);
    if (i >= 0 && (!best || W.cc[i] < best.cc)) best = { cc: W.cc[i], t: hm(m).slice(0, 2) + ':00' };
  }
  return best && best.cc <= f.now.cc - 25 ? best : null;
}

/* ---------- routing (OSRM, cached, never blocks) ---------- */
let routeBusy = false, routeAgain = false, redrawTimer = 0;
function routeRedraw() { // one redraw per burst of answers; never while a map popup is open
  clearTimeout(redrawTimer);
  redrawTimer = setTimeout(() => { if (!document.querySelector('.leaflet-popup')) drawMap(false); renderList(); }, 900);
}
async function ensureRoutes() {
  if (navigator.onLine === false) return;
  if (routeBusy) { routeAgain = true; return; }
  routeBusy = true;
  const order = [...state.days].sort((a, b) => (a.idx === state.view ? -1 : b.idx === state.view ? 1 : 0));
  for (const day of order) {
    for (const seg of day.segs.filter((s) => s.mode === 'drive' && !state.routes[s.key])) {
      try {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), 12000);
        const r = await fetch(`https://router.project-osrm.org/route/v1/driving/${seg.key}?overview=full&geometries=geojson`, { signal: ctl.signal });
        const rt = r.ok ? (await r.json()).routes?.[0] : null;
        clearTimeout(timer);
        if (rt) {
          const step = Math.max(1, Math.ceil(rt.geometry.coordinates.length / 400)); // keep localStorage small
          const g = rt.geometry.coordinates.filter((_, i, a) => i % step === 0 || i === a.length - 1).map(([x, y]) => [+y.toFixed(5), +x.toFixed(5)]);
          state.routes[seg.key] = { s: rt.duration, m: rt.distance, g };
          tstore.set('routes.v1', state.routes);
          if (state.view === 'trip' || state.view === day.idx) routeRedraw();
        }
      } catch { /* offline or rate-limited: straight line stays */ }
      await new Promise((res) => setTimeout(res, 350));
    }
  }
  routeBusy = false;
  if (routeAgain) { routeAgain = false; ensureRoutes(); }
}

/* ---------- bottom sheet ---------- */
const topPx = () => Math.round($('#tabs').getBoundingClientRect().bottom + 8);
function snapPx(name) {
  const H = innerHeight, list = $('#list');
  if (name === 'full') return H - topPx();
  if (name === 'half') return Math.round(H * 0.47);
  const first = list.firstElementChild;
  const safe = Math.max(0, parseFloat(getComputedStyle(list).paddingBottom) - 24);
  return Math.min(Math.round(H * 0.36), 26 + (first ? first.offsetHeight : 64) + 9 + safe);
}
function setSnap(name) {
  state.snap = name;
  const sh = $('#sheet');
  sh.dataset.snap = name;
  document.documentElement.style.setProperty('--h', snapPx(name) + 'px');
  $('#grab').setAttribute('aria-label', name === 'full' ? 'Panel is full height. Tap to shrink.' : name === 'half' ? 'Panel is half height. Tap to expand.' : 'Panel is collapsed. Tap to open.');
  if (name === 'peek') $('#list').scrollTop = 0;
}
function bindSheet() {
  const sh = $('#sheet');
  let drag = null, dragged = false;
  sh.addEventListener('pointerdown', (e) => {
    if (WIDE.matches) return;
    const handle = e.target.closest('.grab');
    // The pinned next-up block always drags the sheet; the scrolling headers only while the list is at its top. Buttons inside may start a drag too.
    const header = !handle && (e.target.closest('.nextup') || (e.target.closest('.head, .d-head') && $('#list').scrollTop <= 0));
    if (!handle && !header) return;
    drag = { y: e.clientY, last: e.clientY, h: sh.offsetHeight, moved: false, id: e.pointerId };
    dragged = false;
  });
  window.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    drag.last = e.clientY;
    const dy = e.clientY - drag.y;
    if (!drag.moved && Math.abs(dy) < 6) return;
    drag.moved = true; dragged = true; sh.classList.add('dragging');
    const h = Math.max(snapPx('peek'), Math.min(snapPx('full'), drag.h - dy));
    document.documentElement.style.setProperty('--h', h + 'px');
  }, { passive: true });
  const end = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const d = drag; drag = null; sh.classList.remove('dragging');
    if (!d.moved) return;
    const order = ['peek', 'half', 'full'], i = order.indexOf(state.snap);
    const dy = d.last - d.y, h = d.h - dy; // the last real move; a cancelled pointer reports no usable position
    let target = state.snap;
    if (dy < -50) target = order[Math.min(2, i + (h > snapPx('half') + 40 && i === 0 ? 2 : 1))];
    else if (dy > 50) target = order[Math.max(0, i - (h < snapPx('half') - 40 && i === 2 ? 2 : 1))];
    setSnap(target);
  };
  window.addEventListener('pointerup', end);
  window.addEventListener('pointercancel', end);
  // The click that ends a drag must not also press whatever was under the finger.
  sh.addEventListener('click', (e) => { if (dragged && e.detail > 0) { e.preventDefault(); e.stopPropagation(); } dragged = false; }, true);
  $('#grab').addEventListener('click', () => setSnap(state.snap === 'half' ? 'full' : 'half'));
  $('#list').addEventListener('focusin', () => { if (state.snap === 'peek' && !WIDE.matches) setSnap('half'); }); // keyboard users never get stuck in a collapsed list
}

/* ---------- map ---------- */
let map, routeLayer, pinLayer, meLayer, radarLayer, lastBounds, placed = [];
function initMap() {
  map = L.map('map', { zoomControl: false, attributionControl: true, zoomSnap: 0.25, zoomAnimation: !RM, fadeAnimation: !RM, markerZoomAnimation: !RM }).setView([37.78, -25.5], 10);
  map.attributionControl.setPrefix(false);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>', className: 'osm-tiles', crossOrigin: true }).addTo(map);
  routeLayer = L.layerGroup().addTo(map);
  pinLayer = L.layerGroup().addTo(map);
  meLayer = L.layerGroup().addTo(map);
  let popupWasOpen = false;
  map.on('zoomend', () => { if (!document.querySelector('.leaflet-popup')) drawMap(false); }); // pin spacing depends on zoom
  map.on('preclick', () => { popupWasOpen = !!document.querySelector('.leaflet-popup'); });
  map.on('click', () => { if (!popupWasOpen && !WIDE.matches && state.snap !== 'peek') setSnap('peek'); }); // a tap that only closes a popup leaves the sheet alone
  $('#btnLocate').innerHTML = ico('locate'); $('#btnFit').innerHTML = ico('fit'); $('#btnRadar').innerHTML = ico('rain');
  $('#btnZoomIn').innerHTML = ico('plus'); $('#btnZoomOut').innerHTML = ico('minus');
  $('#btnZoomIn').addEventListener('click', () => map.zoomIn(1)); $('#btnZoomOut').addEventListener('click', () => map.zoomOut(1));
}
const pin = (cls, html, size = 30) => L.divIcon({ className: '', html: `<div class="pin ${cls}">${html}</div>`, iconSize: [size, size], iconAnchor: [size / 2, size / 2] });
function line(pts, mode, color, dim, strong) {
  const st = { ...(MODE[mode] || MODE.drive) };
  if (strong) st.weight += 2;
  L.polyline(pts, { color: '#fffbf1', weight: st.weight + 3.5, opacity: dim ? 0.5 : 0.9, lineCap: 'round', interactive: false, className: 'casing' }).addTo(routeLayer);
  L.polyline(pts, { ...st, color: color || st.color, opacity: dim ? 0.35 : 1, lineCap: 'round', lineJoin: 'round', interactive: false }).addTo(routeLayer);
}
const mapsUrl = (p, walking) => `https://www.google.com/maps/dir/?api=1&destination=${p.lat},${p.lon}&travelmode=${walking ? 'walking' : 'driving'}`;
function arrow(pts) { // a small direction arrow at the middle of a drive leg
  const m = Math.floor(pts.length / 2), a = map.latLngToLayerPoint(pts[m - 1]), c = map.latLngToLayerPoint(pts[m + 1] || pts[m]);
  const deg = Math.atan2(c.y - a.y, c.x - a.x) * 180 / Math.PI;
  L.marker(pts[m], { interactive: false, keyboard: false, zIndexOffset: 50, icon: L.divIcon({ className: '', iconSize: [18, 18], iconAnchor: [9, 9], html: `<div class="arr" style="transform:rotate(${deg}deg)"><svg viewBox="0 0 18 18"><path d="M5 3.500L12 9l-7 5.500" fill="none" stroke="#fff" stroke-width="2.600" stroke-linecap="round" stroke-linejoin="round"/></svg></div>` }) }).addTo(pinLayer);
}
function drawDay(day, overview) {
  const b = [], modes = new Set();
  const ctx = overview ? null : dayCtx(day);
  for (const seg of day.segs) {
    if (overview && seg.mode === 'walk') continue;
    modes.add(seg.mode);
    let pts = seg.pts, faint = false;
    if (seg.mode === 'drive') {
      const r = state.routes[seg.key];
      pts = r ? r.g : [[seg.from.lat, seg.from.lon], [seg.to.lat, seg.to.lon]];
      faint = !r;
    }
    const si = seg.stop ? day.stops.findIndex((x) => x.id === seg.stop) : -1;
    const isNext = !overview && !state.sel && ctx && seg.stop && seg.stop === (ctx.nextId || ctx.curId);
    const dim = !overview && (state.sel ? seg.stop !== state.sel : !!(ctx && ctx.isToday && si >= 0 && si < (ctx.passedBefore ?? 0))); // a selected stop's legs, or what is still ahead today, stand out
    if (faint) L.polyline(pts, { color: MODE.drive.color, weight: 3, opacity: dim ? 0.25 : 0.5, dashArray: '2 7', interactive: false }).addTo(routeLayer);
    else line(pts, seg.mode, overview && seg.mode === 'drive' ? day.color : null, dim, isNext);
    if (!overview && seg.mode === 'drive' && !faint && pts.length > 3 && !dim) arrow(pts);
    b.push(...pts);
  }
  if (overview) {
    const cand = day.stops.filter((s) => s.type !== 'logistics'); // pin each day where it is least crowded by the others
    const f = (cand.length ? cand : day.stops).map((s) => ({ s, d: Math.min(1e9, ...placed.map((q) => dist(q.f, s))) })).sort((a, c) => c.d - a.d)[0].s;
    placed.push({ day, f });
  } else {
    const seen = new Set();
    day.stops.forEach((s) => {
      if (!s.parking || s.type === 'logistics') return;
      const k = `${s.parking.lat},${s.parking.lon}`;
      if (seen.has(k)) return; seen.add(k);
      const near = map.latLngToLayerPoint([s.parking.lat, s.parking.lon]).distanceTo(map.latLngToLayerPoint([s.lat, s.lon])) < 36; // P would sit under the stop pin at this zoom: draw it beside it
      const icon = L.divIcon({ className: '', html: '<div class="pin ppin">P</div>', iconSize: [26, 26], iconAnchor: near ? [44, 13] : [13, 13], popupAnchor: near ? [-31, -10] : [0, -10] });
      L.marker(near ? [s.lat, s.lon] : [s.parking.lat, s.parking.lon], { icon, zIndexOffset: 100, title: `Parking: ${s.parking.name}`, alt: 'Parking' }).addTo(pinLayer)
        .bindPopup(`<b>${esc(s.parking.name)}</b><br>${s.parking.free ? 'Free' : 'Paid'}${s.parking.note ? '. ' + esc(s.parking.note) : ''}<br><a href="${mapsUrl(s.parking)}" target="_blank" rel="noopener">Drive here with Google Maps</a>`,
          { maxWidth: Math.max(160, Math.min(300, innerWidth - 12 - 64 - 34)), autoPanPaddingTopLeft: [12, topPx() + 44], autoPanPaddingBottomRight: [64, Math.min($('#sheet').offsetHeight, innerHeight * 0.62) + 12] });
    });
    day.stops.forEach((s, i) => {
      const cls = 'stoppin' + (state.done[s.id] ? ' done' : '') + (state.sel === s.id ? ' sel' : '');
      const m = L.marker([s.lat, s.lon], { icon: pin(cls, i + 1, 30), zIndexOffset: state.sel === s.id ? 800 : 300 + i, title: `${i + 1}. ${s.name}`, alt: `Stop ${i + 1}` }).addTo(pinLayer);
      m.getElement()?.style.setProperty('--day', day.color);
      m.on('click', (e) => { L.DomEvent.stop(e); selectStop(s.id); });
      m.on('keypress', (e) => { if (e.originalEvent.key === 'Enter') selectStop(s.id); });
    });
  }
  day.stops.forEach((s) => { b.push([s.lat, s.lon]); if (s.parking) b.push([s.parking.lat, s.parking.lon]); });
  return { b, modes };
}
function drawMap(fit) {
  if (!map || !state.days.length) return;
  routeLayer.clearLayers(); pinLayer.clearLayers(); placed = [];
  const parts = state.view === 'trip' ? state.days.map((d) => drawDay(d, true)) : [drawDay(state.days[state.view], false)];
  const pts = parts.flatMap((p) => p.b), modes = new Set(parts.flatMap((p) => [...p.modes]));
  if (pts.length) lastBounds = L.latLngBounds(pts);
  if (state.view === 'trip') { // day pins that would overlap at this zoom are nudged apart so every day stays visible and tappable
    const pos = placed.map((q) => map.latLngToLayerPoint([q.f.lat, q.f.lon]));
    const off = pos.map(() => [0, 0]);
    for (let it = 0; it < 12; it++) for (let i = 0; i < pos.length; i++) for (let j = i + 1; j < pos.length; j++) {
      let dx = pos[j].x + off[j][0] - pos[i].x - off[i][0], dy = pos[j].y + off[j][1] - pos[i].y - off[i][1];
      const d = Math.hypot(dx, dy);
      if (d >= 34) continue;
      if (d < 0.5) { dx = Math.cos(i + j); dy = Math.sin(i + j); } else { dx /= d; dy /= d; }
      const push = (34 - d) / 2;
      off[i][0] -= dx * push; off[i][1] -= dy * push; off[j][0] += dx * push; off[j][1] += dy * push;
    }
    placed.forEach((q, i) => {
      const icon = L.divIcon({ className: '', html: `<div class="pin daypin">${q.day.idx + 1}</div>`, iconSize: [32, 32], iconAnchor: [16 - off[i][0], 16 - off[i][1]] });
      const m = L.marker([q.f.lat, q.f.lon], { icon, zIndexOffset: 500, title: `Day ${q.day.idx + 1}: ${q.day.title}`, alt: `Day ${q.day.idx + 1}` }).addTo(pinLayer);
      m.on('click', (e) => { L.DomEvent.stop(e); selectView(q.day.idx); }).on('keypress', (e) => { if (e.originalEvent.key === 'Enter') selectView(q.day.idx); }).getElement()?.style.setProperty('--day', q.day.color);
    });
  }
  $('#legend').innerHTML = ['drive', 'walk', 'hike', 'boat'].filter((m) => modes.has(m)).map((m) => `<li><i class="lg ${m}"></i>${m}</li>`).join('');
  $('#legend').hidden = modes.size < 2;
  if (fit) fitMap(false);
}
function fitPad() {
  const wide = WIDE.matches;
  return { paddingTopLeft: [wide ? 450 : 34, wide ? 56 : topPx() + 44], paddingBottomRight: [wide ? 70 : 60, wide ? 30 : Math.min($('#sheet').offsetHeight, innerHeight * 0.62) + 18] };
}
function fitMap(animate = true) {
  if (!map || !lastBounds) return;
  const day = state.view !== 'trip' && state.days[state.view];
  const s = state.sel && day ? day.stops.find((x) => x.id === state.sel) : null;
  if (s) {
    const pts = [[s.lat, s.lon]]; if (s.parking) pts.push([s.parking.lat, s.parking.lon]);
    if (s.route) pts.push(...s.route.polyline);
    map.fitBounds(L.latLngBounds(pts), { ...fitPad(), maxZoom: 16, animate });
  } else map.fitBounds(lastBounds, { ...fitPad(), maxZoom: 15, animate });
}

/* live location */
let watchId = null, meMarker = null, meRing = null, centreOnFix = false, lastLocTap = 0, geoWanted = false;
function centreOnMe() { map.setView(state.me, Math.max(map.getZoom(), 14)); }
function startWatch() {
  if (watchId != null || !('geolocation' in navigator)) return;
  watchId = navigator.geolocation.watchPosition((p) => {
    state.me = [p.coords.latitude, p.coords.longitude];
    store.set('geo', true);
    if (!meMarker) {
      meRing = L.circle(state.me, { radius: 1, color: '#2563eb', weight: 1, fillOpacity: 0.08, interactive: false }).addTo(meLayer);
      meMarker = L.marker(state.me, { icon: pin('mepin', '', 20), zIndexOffset: 900, interactive: false, alt: 'My location' }).addTo(meLayer);
    }
    meMarker.setLatLng(state.me); meRing.setLatLng(state.me).setRadius(Math.min(p.coords.accuracy, 800));
    $('#btnLocate').classList.add('on');
    if (centreOnFix) { centreOnFix = false; centreOnMe(); }
  }, (e) => {
    const tapped = Date.now() - lastLocTap < 35000;
    if (tapped) { lastLocTap = 0; toast(e.code === 1 ? 'Location is blocked. Allow it in Settings → Privacy → Location Services → Safari Websites.' : 'No location fix yet. Try again outdoors.'); }
    if (e.code === 1) { stopWatch(); geoWanted = false; store.set('geo', false); $('#btnLocate').classList.remove('on'); }
  }, { enableHighAccuracy: true, maximumAge: 15000, timeout: 30000 });
}
function stopWatch() { if (watchId != null) { navigator.geolocation.clearWatch(watchId); watchId = null; } }
function locate(userTap) {
  if (!('geolocation' in navigator)) return userTap && toast('Location is not available in this browser.');
  geoWanted = true;
  if (userTap) { lastLocTap = Date.now(); centreOnFix = true; if (state.me) { centreOnFix = false; centreOnMe(); } }
  startWatch();
}

/* rain radar (RainViewer) */
let radarBusy = false;
async function toggleRadar() {
  const btn = $('#btnRadar');
  if (radarBusy) return;
  if (radarLayer) { map.removeLayer(radarLayer); radarLayer = null; btn.setAttribute('aria-pressed', 'false'); return; }
  radarBusy = true;
  try {
    const j = await (await fetch('https://api.rainviewer.com/public/weather-maps.json')).json();
    const f = j.radar.past[j.radar.past.length - 1];
    radarLayer = L.tileLayer(`${j.host}${f.path}/256/{z}/{x}/{y}/2/1_1.png`, { opacity: 0.6, maxNativeZoom: 7, maxZoom: 19, attribution: 'Radar © RainViewer' }).addTo(map);
    btn.setAttribute('aria-pressed', 'true');
    toast(`Rain radar from ${hm(todayIn(state.tz, new Date(f.time * 1000)).min)}`);
  } catch { toast('Rain radar is not reachable right now.'); }
  radarBusy = false;
}

/* ---------- rendering ---------- */
function renderTabs() {
  const t = now();
  const focused = $('#tabs').contains(document.activeElement) ? document.activeElement.dataset.view : null;
  const cur = (on) => (on ? ' aria-current="page"' : '');
  $('#tabs').innerHTML = `<button class="tab trip${state.view === 'trip' ? ' on' : ''}" data-view="trip" type="button"${cur(state.view === 'trip')} aria-label="Trip, all days"><b>${ico('island')}</b><span aria-hidden="true">Trip</span></button>` +
    state.days.map((d) => {
      const w = worst(d), today = d.date === t.date;
      return `<button class="tab${state.view === d.idx ? ' on' : ''}${today ? ' today' : ''}" style="--day:${d.color}" data-view="${d.idx}" type="button"${cur(state.view === d.idx)}
        aria-label="${d.idx + 1} ${today ? 'Today' : fmtDate(d.date, { weekday: 'short' })}, ${fmtDate(d.date, { day: 'numeric', month: 'long' })}${w ? ', severe weather' : ''}">
      <b aria-hidden="true">${d.idx + 1}</b><span aria-hidden="true">${today ? 'Today' : fmtDate(d.date, { weekday: 'short' })}</span>${w ? '<i class="tabwarn" aria-hidden="true"></i>' : ''}</button>`;
    }).join('');
  if (focused != null) $(`#tabs [data-view="${focused}"]`)?.focus({ preventScroll: true });
  if (tabsNeedScroll) { tabsNeedScroll = false; $('#tabs .on')?.scrollIntoView({ block: 'nearest', inline: 'center' }); }
}
let tabsNeedScroll = true;

function hourStrip(day, hours) {
  if (!state.wx) return `<p class="nowx">${navigator.onLine === false ? 'No saved forecast yet. It loads the next time you are online.' : state.wxTried ? 'The forecast is not reachable right now. Tap the status dot to retry.' : 'Loading the forecast…'}</p>`;
  if (!hours.length) return '<p class="nowx">No forecast for this day yet.</p>';
  const t = now();
  const anyRain = hours.some((x) => x.pp >= 20), anyGust = hours.some((x) => x.wg >= LIMITS.gust);
  const cells = hours.map((x) => {
    const hh = String(x.h).padStart(2, '0');
    const [ic, label] = wxOf(x.wc);
    return `<div class="hr${day.date === t.date && Math.floor(t.min / 60) === x.h ? ' cur' : ''}" role="listitem" aria-label="${hh}:00, ${label}, ${Math.round(x.tc)} degrees, rain ${Math.round(x.pp)} percent, gusts ${Math.round(x.wg)} kilometres per hour">
      <span class="h">${hh}</span><span class="ic">${ico(ic)}</span><span class="t">${Math.round(x.tc)}°</span>
      ${anyRain ? `<span class="pp${x.pp < 20 ? ' dry' : ''}">${Math.round(x.pp)}%</span>` : ''}${anyGust ? `<span class="g${x.wg >= LIMITS.gustSevere ? ' sev' : ''}">${x.wg >= LIMITS.gust ? Math.round(x.wg) : ''}</span>` : ''}</div>`;
  });
  return `<div class="stripwrap wxd"><p class="cap"><span>Hour by hour</span>${anyRain ? `<span class="rainkey">${ico('drop')} rain</span>` : ''}${anyGust ? `<span>${ico('wind')} gusts km/h</span>` : ''}</p><div class="strip" id="strip" role="list" aria-label="Hourly forecast, 7 to 21 o'clock" tabindex="0">${cells.join('')}</div></div>`;
}

function navBtn(p, walking, id, text, label = '', cls = '') { // https Maps URL: opens the Google Maps app when installed, the web otherwise
  return `<a class="btn ${cls}" id="${id}" href="${mapsUrl(p, walking)}" target="_blank" rel="noopener"${label ? ` aria-label="${esc(label)}"` : ''}>${ico('arrow')}${text}</a>`;
}
// A warning as icon + value, e.g. wind 117, drop 92%, wave 2.3 m.
const WARN_ICON = { gust: 'wind', rain: 'drop', wave: 'wave', tide: 'wave', cloud: 'cloud' };
const warnShort = (w) => w.text.replace(/^(Gusts|Rain|Waves|Cloud) /, '').replace(' km/h', '').replace(/ at \d\d:00/, '').replace('Low tide is at ', 'low ');
const warnChip = (w) => `${ico(WARN_ICON[w.kind] || 'warn')}<span class="sr">${esc(w.text)}</span><span aria-hidden="true">${esc(warnShort(w))}</span>`;

function dayCtx(day) {
  const t = now();
  const ctx = { t, isToday: day.date === t.date, nowBefore: -1, nextId: null, curId: null };
  if (ctx.isToday) {
    // The itinerary order is the plan, even when a shifted stop now overlaps a booked one (that shows as a clash).
    // Anything before the last ticked stop counts as passed.
    const lastDone = day.stops.reduce((m, s, i) => (state.done[s.id] ? i : m), -1);
    const open = day.stops.filter((s, i) => i > lastDone);
    const ci = open.reduce((m, s, i) => (eff(day, s) <= t.min && t.min < eff(day, s) + Math.max(s.durationMin, 15) + 120 ? i : m), -1); // 2 h grace for an overrunning stop
    const cur = ci >= 0 ? open[ci] : null;
    const next = cur ? open[ci + 1] : open.find((s) => eff(day, s) > t.min);
    ctx.curId = cur?.id || null; ctx.nextId = next?.id || null;
    ctx.nowBefore = next ? day.stops.indexOf(next) : -1;
    ctx.over = !next && (!cur || t.min >= eff(day, cur) + cur.durationMin);
    ctx.passedBefore = cur ? day.stops.indexOf(cur) : next ? day.stops.indexOf(next) : lastDone + 1; // everything above this index is behind us
  }
  return ctx;
}

function nextUp(day, ctx) {
  if (!ctx.isToday) return '';
  const cur = day.stops.find((s) => s.id === ctx.curId), next = day.stops.find((s) => s.id === ctx.nextId);
  if ((!cur && !next) || ctx.over) return '';
  const target = next || cur;
  const f = fc(day, target), tw = topWarn(f);
  const cond = tw ? `<span class="hot">${ico('warnfill')}${warnChip(tw)}</span>`
    : f ? `<span>${ico(wxOf(f.now.wc)[0], '', wxOf(f.now.wc)[1])}${r0(f.now.tc)}°</span>${f.span.wg >= LIMITS.gust ? `<span>${ico('wind', '', 'gusts')}${r0(f.span.wg)}</span>` : `<span>${ico('drop', '', 'rain')}${r0(f.span.pp)}%</span>`}` : '';
  const then = day.stops[day.stops.indexOf(target) + 1];
  let line2;
  if (next) {
    const ni = day.stops.indexOf(next);
    const lv = leaveBy(day, ni - 1);
    if (lv && lv.tr.min >= 3) {
      const inMin = lv.by - ctx.t.min;
      line2 = inMin > 0 ? `<span>Leave in <b>${dur(inMin)}</b></span><span class="dim">by ${hm(lv.by)}</span>` : `<b class="hot">Leave now</b><span class="dim">${dur(-inMin)} late</span>`;
    } else line2 = `<span>Starts in <b>${dur(Math.max(0, eff(day, next) - ctx.t.min))}</b></span>`;
  } else line2 = `<span>Until about ${hm(eff(day, cur) + cur.durationMin)}</span>`;
  return `<section class="nextup" aria-label="${next ? 'Next up' : 'Now'}">
    <button class="nu-text" type="button" id="nu-open" data-sel="${target.id}"><span class="nu-eyebrow"><span>${next ? 'Next' : 'Now'}</span><span>${hm(eff(day, target))}</span><span class="nu-cond">${cond}</span></span><b>${esc(target.name)}</b><span class="nu-sub">${line2}</span>${then ? `<span class="nu-then">then ${hm(eff(day, then))} ${esc(then.name)}</span>` : ''}</button>
    ${navBtn(target.parking || target, !target.parking, 'nu-go', 'Go', `Go to ${target.parking ? target.parking.name : target.name} with Google Maps`)}
  </section>`;
}

function row(day, i, ctx) {
  const s = day.stops[i];
  const isDone = !!state.done[s.id];
  const d = driveInfo(day.driveTo[s.id]);
  const f = fc(day, s);
  const t = eff(day, s), moved = t !== toMin(s.time);
  const past = ctx.isToday && ctx.curId !== s.id && (t + s.durationMin < ctx.t.min || i < (ctx.passedBefore ?? 0));
  let html = '';
  if (ctx.nowBefore === i) html += `<li class="nowline"><span>Now ${hm(ctx.t.min)}</span></li>`;
  if (d) html += `<li class="leg${past ? ' past' : ''}"><span>${ico('logistics')}<span class="sr">Drive </span>${d.est ? '~' : ''}${d.min} min</span>${i === 0 ? `<span>leave by <b>${hm(t - d.min - s.walk.minutes)}</b></span>` : ''}</li>`;
  const sev = topWarn(f), note = sev || f?.warn.find((w) => w.kind !== 'cloud' || s.type === 'view');
  const mini = f ? `<span class="mini wxd${sev ? ' sev' : ''}"><span>${ico(wxOf(f.now.wc)[0], '', wxOf(f.now.wc)[1])} ${r0(f.now.tc)}°</span><small>${sev ? ico('warnfill') : ''}${note ? warnChip(note) : f.span.pp >= 20 ? `${ico('drop', '', 'rain')}${r0(f.span.pp)}%` : ''}</small></span>` : '';
  const tag = ctx.curId === s.id && !ctx.over ? '<span class="tag now">Now</span>' : ctx.nextId === s.id ? '<span class="tag nextb">Next</span>' : '';
  const lvRow = leaveBy(day, i), clash = lvRow?.clash ? `<span class="hot">clashes with ${hm(eff(day, lvRow.next))}</span>` : '';
  const kind = [TYPE[s.type] ?? s.type, s.durationMin ? dur(s.durationMin) : ''].filter(Boolean).map((x) => `<span>${x}</span>`).join('') + (s.status === 'to_book' ? '<span class="hot">to book</span>' : '');
  html += `<li><button class="row${isDone ? ' done' : ''}${past && !isDone ? ' past' : ''}${ctx.nextId === s.id ? ' next' : ''}${ctx.curId === s.id && !ctx.over ? ' current' : ''}" type="button" id="row-${s.id}" data-sel="${s.id}" style="--day:${day.color}">
      <time${moved ? ' class="moved"' : ''}>${hm(t)}</time>
      <span class="num" aria-hidden="true">${isDone ? ico('check') : i + 1}</span>
      <span class="row-main"><span class="name">${esc(s.name)}</span><span class="meta">${kind}${tag}${clash}${isDone ? '<span class="sr">, done</span>' : ''}</span></span>${mini}
    </button></li>`;
  return html;
}

function renderDay(day) {
  const ctx = dayCtx(day);
  const sun = sunOf(day), hours = dayHours(day), tot = dayTotals(day), sh = shiftOf(day);
  const doneN = day.stops.filter((s) => state.done[s.id]).length;
  const v = verdict(hours);
  const nPast = ctx.isToday ? (ctx.over ? 0 : ctx.passedBefore ?? 0) : 0, hidePast = nPast >= 2 && !state.showPast; // today: fold what is behind us
  return `${nextUp(day, ctx)}
    <div class="head"><div class="head-text"><h2>${esc(day.title)}</h2>
      <p class="sub"><span>${fmtDate(day.date, { weekday: 'short', day: 'numeric', month: 'short' })}</span>${v ? `<span class="wxd vd">${v}</span>` : ''}${sh ? `<span>plan ${sh > 0 ? '+' : '−'}${dur(Math.abs(sh))}</span>` : ''}</p></div>${statusBtn()}</div>
    <ol class="timeline" aria-label="Stops">${hidePast ? `<li><button class="earlier" type="button" id="show-past" data-past>${ico('check')}<span>${nPast} earlier stops</span>${ico('chev')}</button></li>` : ''}${day.stops.map((_, i) => (hidePast && i < nPast ? '' : row(day, i, ctx))).join('')}${ctx.isToday && ctx.nowBefore === -1 && !ctx.over ? `<li class="nowline"><span>Now ${hm(ctx.t.min)}</span></li>` : ''}</ol>
    ${hourStrip(day, hours)}
    <details class="opts" id="opts"${state.optsOpen ? ' open' : ''}><summary id="opts-sum">Day details${ico('chev')}</summary><div class="opts-body">
      <ul class="facts">
        ${day.planNote ? `<li>${ico('clock')}<span>Plan note: ${esc(day.planNote)}</span></li>` : ''}
        <li>${ico('home')}${day.base ? esc(state.itin.bases[day.base].label) : esc(day.baseNote || 'No base tonight')}</li>
        ${tot.min ? `<li>${ico('logistics')}${tot.est ? 'About ' : ''}${dur(tot.min)} driving, ${km(tot.m)}</li>` : ''}
        ${tot.walk >= 0.5 ? `<li>${ico('walk')}About ${tot.walk.toFixed(1)} km on foot</li>` : ''}
        ${sun ? `<li class="wxd">${ico('sunrise')}${sun.rise}<span class="gap"></span>${ico('sunset')}${sun.set}<span class="sr"> sunrise and sunset</span></li>` : ''}
        <li>${ico('check')}${doneN} of ${day.stops.length} stops done</li>
      </ul>
      <div class="tools" role="group" aria-label="Move the plan"><span class="lbl">${sh ? `Plan moved ${sh > 0 ? 'later' : 'earlier'} by ${dur(Math.abs(sh))}. Bookings and flights keep their time.` : 'Running late? Move all open stops.'}</span>
        <button type="button" id="shift-minus" data-shift="-15" aria-label="Move the plan 15 minutes earlier">−15 min</button><button type="button" id="shift-plus" data-shift="15" aria-label="Move the plan 15 minutes later">+15 min</button>${sh ? '<button type="button" id="shift-reset" data-shift="0">Reset</button>' : ''}</div>
      <p class="fine">Hike and boat lines are sketched, not surveyed. Weather: Open-Meteo. Drive times: OSRM. Parking: OpenStreetMap. If a sign says otherwise, trust the sign.</p>
    </div></details>`;
}

// One fact of a stop: icon, the value in large type, at most a few words beneath.
function fact(icon, value, sub = '', cls = '', label = '') {
  return `<div class="tile ${cls}"><span class="ti" aria-hidden="true">${icon}</span><span class="tv">${label ? `<span class="sr">${label}: </span>` : ''}<b>${value}</b>${sub ? `<small>${sub}</small>` : ''}</span></div>`;
}
const lastWide = (list) => (list.filter((x) => !x.includes('tile wide')).length % 2 ? [...list.slice(0, -1), list[list.length - 1].replace('class="tile ', 'class="tile wide ')] : list); // no lone half-width tile

function renderStop(day, s) {
  const i = day.stops.indexOf(s), ctx = dayCtx(day), f = fc(day, s);
  const t = eff(day, s), isDone = !!state.done[s.id];
  const sun = sunOf(day);
  const tiles = [], cond = [], move = [];
  if (f) {
    const wxRow = (h, main) => `<div class="wxr${main ? ' main' : ''}" role="row"><span class="wt" role="cell">${h.time}</span>
        <span role="cell">${ico(wxOf(h.wc)[0], '', wxOf(h.wc)[1])}<b>${r0(h.tc)}°</b></span>
        <span role="cell">${ico('drop', '', 'rain')}<b>${r0(h.pp)}%</b>${main && h.pr >= 0.1 ? `<small>${n1(h.pr)} mm</small>` : ''}</span>
        <span role="cell">${ico('wind', '', 'wind and gusts')}<b>${r0(h.ws)}</b><i>to</i><b${h.wg >= LIMITS.gustSevere ? ' class="hot"' : ''}>${r0(h.wg)}</b>${main ? '<small>km/h</small>' : ''}</span></div>`;
    const spread = f.span.gHi != null && f.span.gHi - f.span.gLo >= 20 && f.span.gHi >= LIMITS.gust ? `<p class="wxfoot">Models disagree on gusts: ${f.span.gLo} to ${f.span.gHi} km/h</p>` : '';
    tiles.push(`<div class="tile wide wxgrid wxd" role="table" aria-label="Weather on arrival and the hour after">${wxRow(f.now, true)}${f.next ? wxRow(f.next, false) : ''}${spread}</div>`);
    const h = f.now;
    if (s.type === 'view') {
      const c = clearerWindow(day, s, f);
      cond.push(fact(ico('cloud'), `${r0(h.cc)}%`, c ? `<span class="good">clearer ${c.t}</span>` : f.next ? `then ${r0(f.next.cc)}%` : '', 'wxd' + (h.cc >= 85 ? ' bad' : ''), 'Cloud cover'));
    }
    if (f.sea) cond.push(fact(ico('wave'), `${n1(f.sea.wh)} m`, `swell ${n1(f.sea.sh)} m, ${r0(f.sea.wp)} s`, 'wxd' + (f.sea.max >= LIMITS.wave ? ' bad' : ''), 'Waves'));
    if (f.tide) cond.push(f.tide.far
      ? fact(ico('tide'), `High ${f.tide.high || ''}`, `low ${toMin(f.tide.low) < t ? 'was' : 'is'} ${f.tide.low}`, 'wxd', 'Tide')
      : fact(ico('tide'), `Low ${f.tide.low}`, f.tide.trend, 'wxd', 'Tide'));
    if (sun && ['view', 'hike', 'sight', 'boat'].includes(s.type)) {
      const end = t + s.durationMin, set = toMin(sun.set);
      if (end > set + 15) cond.push(fact(ico('sunset'), sun.set, 'ends after dark', 'wxd bad', 'Sunset'));
      else if (set - t <= 75 && set >= t) cond.push(fact(ico('sunset'), sun.set, '', 'wxd', 'Sunset'));
    }
  } else if (!state.wx) tiles.push(`<p class="nowx">${navigator.onLine === false ? 'No saved forecast yet.' : 'Loading the forecast…'}</p>`);
  tiles.push(...lastWide(cond));
  if (s.parking && s.type !== 'logistics') tiles.push(`<div class="tile wide"><span class="ti" aria-hidden="true"><i class="pk">P</i></span><span class="tv"><span class="sr">Parking: </span><b>${esc(s.parking.name)}<em class="tagf${s.parking.free ? '' : ' paid'}">${s.parking.free ? 'free' : 'paid'}</em></b>${s.parking.note ? `<small>${esc(s.parking.note)}</small>` : ''}</span></div>`);
  if (s.walk.minutes > 0 && !(s.fixed && !s.parking)) move.push(fact(ico('walk'), `${s.walk.minutes} min`, `${s.walk.km} km${s.walk.surface ? `, ${esc(s.walk.surface)}` : ''}`, '', s.parking ? 'Walk from parking' : 'On foot'));
  const lv = leaveBy(day, i);
  if (lv && lv.tr.min >= 3) {
    if (lv.clash) { if (move.length) move[move.length - 1] = move[move.length - 1].replace('class="tile ', 'class="tile wide '); move.push(fact(ico('warnfill'), `Clashes with ${hm(eff(day, lv.next))}`, `${esc(lv.next.name)}. You'd need to leave at ${hm(lv.by)}, before you arrive.`, 'bad wide')); }
    else move.push(fact(ico('clock'), hm(lv.by), `leave, ${lv.tr.est ? '~' : ''}${lv.tr.min} min to stop ${i + 2}${lv.short > 5 ? `<span class="hot">cuts ${lv.short} min here</span>` : ''}`, ctx.isToday && !isDone && ctx.t.min > lv.by && ctx.t.min < eff(day, lv.next) + 30 ? 'bad' : '', 'Leave by'));
  }
  tiles.push(...lastWide(move));
  const sev = f ? f.warn.filter((w) => w.sev >= 2) : [];
  const p = s.parking || s, prev = day.stops[i - 1], nxt = day.stops[i + 1];
  return `<div class="d-head" style="--day:${day.color}">
      <div class="d-top"><button class="back" type="button" id="back" data-back aria-label="Back to the day">${ico('chev')}</button>
        <p class="kicker"><span class="dotnum" aria-hidden="true">${i + 1}</span><span class="sr">Stop ${i + 1}. </span><span>${TYPE[s.type] ?? esc(s.type)}</span>${s.status === 'booked' ? '<span class="tagf ok">booked</span>' : s.status === 'to_book' || (s.bookingNeeded && !s.status) ? '<span class="tagf todo">to book</span>' : ''}</p>
        <div class="step"><button type="button" id="pg-prev" ${prev ? `data-sel="${prev.id}" aria-label="Previous stop: ${esc(prev.name)}"` : 'disabled aria-label="No previous stop"'}>${ico('chev', 'up')}</button><button type="button" id="pg-next" ${nxt ? `data-sel="${nxt.id}" aria-label="Next stop: ${esc(nxt.name)}"` : 'disabled aria-label="No next stop"'}>${ico('chev')}</button></div></div>
      <h2 id="stop-title" tabindex="-1">${esc(s.name)}</h2>
      <p class="sub"><span>${hm(t)}${s.durationMin ? ` to ${hm(t + s.durationMin)}` : ''}</span>${s.durationMin ? `<span>${dur(s.durationMin)}</span>` : ''}${t !== toMin(s.time) ? '<span>moved</span>' : ''}</p></div>
    ${sev.length ? `<div class="alert wxd" role="status">${sev.map((w) => `<span>${ico('warnfill')} ${esc(w.text)}</span>`).join('')}</div>` : ''}
    ${s.note ? `<p class="note">${esc(s.note)}</p>` : ''}
    <div class="actions">${navBtn(p, !s.parking, 'nav-g', `${s.parking ? 'Drive to parking' : 'Walk there'} <span class="via">Google Maps</span>`, '', 'wide')}
      <a class="btn alt" id="nav-a" href="https://maps.apple.com/?daddr=${p.lat},${p.lon}&dirflg=${s.parking ? 'd' : 'w'}" target="_blank" rel="noopener">Apple Maps</a>
      <button class="btn alt done-btn" type="button" id="done-btn" data-done="${s.id}" aria-pressed="${isDone}">${ico('check')}${isDone ? 'Done' : 'Mark done'}</button></div>
    <div class="tiles">${tiles.join('')}</div>
    ${s.parking && s.walk.km >= 0.3 ? `<p class="note"><a class="lnk" id="nav-w" href="https://maps.apple.com/?daddr=${s.lat},${s.lon}&dirflg=w" target="_blank" rel="noopener">Walking route in Apple Maps</a></p>` : ''}`;
}

function renderTrip() {
  const t = now();
  const first = state.days[0].date, last = state.days[state.days.length - 1].date;
  const standalone = navigator.standalone || matchMedia('(display-mode: standalone)').matches;
  const tip = IOS && !standalone && !store.get('tipOff', false) ? `<aside class="tip"><span>To install: tap <b>Share</b>, then <b>Add to Home Screen</b>.</span><button type="button" id="tip-off" data-tipoff aria-label="Dismiss">${ico('close')}</button></aside>` : '';
  return `<div class="head"><div class="head-text"><h2>${esc(state.itin.trip)}</h2><p class="sub"><span>${first.slice(0, 7) === last.slice(0, 7) ? `${+first.slice(8)}–${fmtDate(last, { day: 'numeric', month: 'short', year: 'numeric' })}` : `${fmtDate(first, { day: 'numeric', month: 'short' })} – ${fmtDate(last, { day: 'numeric', month: 'short', year: 'numeric' })}`}</span></p></div>${statusBtn()}</div>
    <div class="daygrid">${state.days.map((d) => {
    const sev = worst(d), v = sev ? `<span>${ico('warnfill')}${esc(sev)}</span>` : verdict(dayHours(d));
    const done = d.stops.filter((s) => state.done[s.id]).length;
    return `<button class="daycard${d.date === t.date ? ' today' : ''}" type="button" id="daycard-${d.idx}" data-view="${d.idx}" style="--day:${d.color}">
        <span class="daynum" aria-hidden="true">${d.idx + 1}</span>
        <span class="dc-text"><small class="dc-date"><span>${d.date === t.date ? 'Today' : fmtDate(d.date, { weekday: 'short', day: 'numeric', month: 'short' })}</span><span>${d.stops.length} stops${done ? `, ${done} done` : ''}</span></small><b>${esc(d.title)}</b>
          ${v ? `<small class="wxd vd${sev ? ' hot' : ''}">${v}</small>` : ''}</span>${ico('chev', 'chev')}</button>`;
  }).join('')}</div>${tip}`;
}

let stripToNow = false;
function renderList() {
  const el = $('#list'), top = el.scrollTop;
  const a = document.activeElement;
  const focusSel = a && el.contains(a) && a.id ? `#${CSS.escape(a.id)}` : null;
  const stripX = el.querySelector('.strip')?.scrollLeft;
  const day = state.view === 'trip' ? null : state.days[state.view];
  const stop = day && state.sel ? day.stops.find((s) => s.id === state.sel) : null;
  if (state.sel && !stop) state.sel = null;
  try {
    el.innerHTML = !day ? renderTrip() : stop ? renderStop(day, stop) : renderDay(day);
  } catch (err) {
    console.error(err);
    el.innerHTML = '<p class="nowx">This view could not be shown. Close the app and open it again; your ticks are saved.</p>';
    return;
  }
  el.scrollTop = top;
  const strip = el.querySelector('.strip');
  if (strip) {
    if (stripToNow) { const c = strip.querySelector('.cur'); if (c) strip.scrollLeft = Math.max(0, c.offsetLeft - strip.firstElementChild.offsetLeft - c.offsetWidth); if (state.wx) stripToNow = false; } else if (stripX) strip.scrollLeft = stripX;
  }
  if (focusSel) (el.querySelector(focusSel) || (focusSel === '#shift-reset' ? el.querySelector('#shift-plus') : null))?.focus({ preventScroll: true });
  paintAge();
  if (state.snap === 'peek' && !WIDE.matches) document.documentElement.style.setProperty('--h', snapPx('peek') + 'px');
}
function render() { if (!state.itin) return; renderTabs(); renderList(); }

function selectView(v) {
  state.view = v; state.sel = null; state.showPast = false; tabsNeedScroll = true; stripToNow = true;
  $('#list').scrollTop = 0;
  render();
  if (state.snap === 'full') setSnap('half'); else setSnap(state.snap);
  const el = $('#list'), r = el.querySelector('.earlier') || el.querySelector('.row.current') || el.querySelector('.row.next'), nu = el.querySelector('.nextup');
  if (r && nu && state.snap !== 'peek') el.scrollTop = Math.max(0, r.getBoundingClientRect().top - el.getBoundingClientRect().top - nu.offsetHeight - 14); // today: start at the current stop
  drawMap(true);
  document.title = v === 'trip' ? `${state.itin.trip} Trip` : `Day ${v + 1}, ${state.itin.trip} Trip`;
}
function selectStop(id) {
  if (state.view === 'trip') return;
  if (!state.sel) state.listTop = $('#list').scrollTop;
  state.sel = id;
  renderList(); $('#list').scrollTop = 0;
  if (state.snap === 'peek') setSnap('half');
  drawMap(false); fitMap();
  $('#stop-title')?.focus({ preventScroll: true });
}
function backToDay() {
  const id = state.sel;
  state.sel = null;
  renderList(); $('#list').scrollTop = state.listTop;
  drawMap(false); fitMap();
  document.getElementById(`row-${id}`)?.focus({ preventScroll: true });
}

let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg; el.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.classList.remove('show'); el.textContent = ''; }, 5000);
}

/* ---------- events ---------- */
function bind() {
  $('#tabs').addEventListener('click', (e) => {
    const b = e.target.closest('[data-view]');
    if (b) { state.touched = true; selectView(b.dataset.view === 'trip' ? 'trip' : +b.dataset.view); }
  });
  $('#list').addEventListener('click', (e) => {
    state.touched = true;
    if (e.target.closest('a, summary')) return;
    if (e.target.closest('[data-refresh]')) { if (navigator.onLine === false) toast('You are offline. Showing the last saved forecast.'); return refreshWeather(true); }
    if (e.target.closest('[data-tipoff]')) { store.set('tipOff', true); return renderList(); }
    if (e.target.closest('[data-back]')) return backToDay();
    if (e.target.closest('[data-past]')) { state.showPast = true; return renderList(); }
    const v = e.target.closest('[data-view]');
    if (v) return selectView(+v.dataset.view);
    const day = state.days[state.view];
    if (!day) return;
    const dn = e.target.closest('[data-done]');
    if (dn) {
      const id = dn.dataset.done;
      if (state.done[id]) delete state.done[id]; else state.done[id] = Date.now();
      tstore.set('done.v1', state.done);
      renderTabs();
      return state.done[id] ? backToDay() : (renderList(), drawMap(false));
    }
    const sh = e.target.closest('[data-shift]');
    if (sh) {
      const d = +sh.dataset.shift;
      const val = d === 0 ? 0 : Math.max(-120, Math.min(240, shiftOf(day) + d));
      if (val) state.shift[day.date] = val; else delete state.shift[day.date];
      tstore.set('shift.v1', state.shift);
      return render();
    }
    const sel = e.target.closest('[data-sel]');
    if (sel) selectStop(sel.dataset.sel);
  });
  $('#list').addEventListener('toggle', (e) => { if (e.target.id === 'opts') state.optsOpen = e.target.open; }, true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && state.sel && !document.querySelector('.leaflet-popup')) backToDay(); });
  $('#btnFit').addEventListener('click', () => fitMap());
  $('#btnLocate').addEventListener('click', () => locate(true));
  $('#btnRadar').addEventListener('click', toggleRadar);
  bindSheet();

  let hiddenAt = 0;
  const wake = async () => {
    if (document.hidden) { hiddenAt = Date.now(); stopWatch(); return; }
    if (geoWanted) startWatch();
    const away = hiddenAt ? Date.now() - hiddenAt : 0; hiddenAt = 0;
    if (!state.itin) { if (!(await chooseTrip()) || !(await loadItin())) return; start(); refreshWeather(true); ensureRoutes(); followIndex(); return; }
    const today = now().date;
    if (today !== lastDate) { // new day since the app was last looked at
      lastDate = today;
      const ti = state.days.findIndex((d) => d.date === today);
      if (ti >= 0) selectView(ti);
    } else render();
    refreshWeather(wxAgeMin() > 10);
    if (away > 10 * 60 * 1000) await reloadItin();
    ensureRoutes();
  };
  document.addEventListener('visibilitychange', wake);
  window.addEventListener('pageshow', (e) => { if (e.persisted) wake(); });
  window.addEventListener('online', async () => { paintAge(); if (!state.itin) { if (!(await chooseTrip()) || !(await loadItin())) return; start(); followIndex(); } refreshWeather(true); ensureRoutes(); });
  window.addEventListener('offline', paintAge);
  setInterval(() => { if (!document.hidden) refreshWeather(true); }, 15 * 60 * 1000);
  setInterval(() => { if (!document.hidden && state.itin) render(); else paintAge(); }, 60 * 1000);
  const relayout = () => { map?.invalidateSize(); setSnap(state.snap); };
  window.addEventListener('resize', relayout);
  WIDE.addEventListener?.('change', () => { relayout(); fitMap(false); });
}

/* ---------- boot ---------- */
let lastDate = '';
function applyItin(itin) {
  state.itin = itin;
  state.tz = itin.timezone || 'UTC';
  state.days = itin.days.map(buildDay);
  for (const d of state.days) for (const st of d.stops) if (st.status === 'done' && !(st.id in state.done)) state.done[st.id] = 1; // done in the plan counts as ticked
  const keep = new Set(state.days.flatMap((d) => d.segs.filter((s) => s.key).map((s) => s.key)));
  for (const k of Object.keys(state.routes)) if (!keep.has(k)) delete state.routes[k]; // drop routes of an older plan
}
async function fetchItin(id) { // a trip's plan from the server if the app can use it, else null
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 8000);
    const r = await fetch(`data/trips/${id}.json`, { signal: ctl.signal, cache: 'no-cache' });
    const itin = r.ok ? await r.json() : null;
    clearTimeout(timer);
    return itin?.days?.length && itin.days.every((d) => d.items?.some((i) => !i.mode)) ? itin : null;
  } catch { return null; }
}
async function loadItin() { // true when a new or changed itinerary was applied
  const id = tripId;
  const itin = await fetchItin(id);
  if (!itin || tripId !== id) return false; // nothing usable, or another trip was opened meanwhile
  if (state.itin && JSON.stringify(itin) === JSON.stringify(tstore.get('itin.v1', null))) return false;
  applyItin(itin); tstore.set('itin.v1', itin); // store only what the app could digest
  return true;
}
function start() {
  lastDate = now().date;
  const ti = state.days.findIndex((d) => d.date === lastDate);
  const want = parseInt(params.get('day'), 10);
  selectView(Number.isFinite(want) ? Math.min(state.days.length - 1, Math.max(0, want - 1)) : ti >= 0 ? ti : 'trip');
}
async function reloadItin() { // pick up a changed plan without throwing the user off the day they are looking at
  const date = state.view === 'trip' ? null : state.days[state.view]?.date;
  if (!(await loadItin())) return;
  const i = date ? state.days.findIndex((d) => d.date === date) : -1;
  if (!state.touched && !date) start(); else selectView(i >= 0 ? i : 'trip');
  ensureRoutes();
}
async function retryWithFreshIndex() { // the saved index named a trip this phone has no plan for and the server does not give
  const fresh = freshIndex; freshIndex = null;
  if (!fresh || !(await fresh)) return false; // the fresh list is saved by now
  tripId = null;
  if (!(await chooseTrip())) return false;
  freshIndex = null; // just fetched
  state.wx = null; adoptWx(tstore.get('wx.v1', null));
  return loadItin();
}
async function boot() {
  initMap(); bind();
  if ('serviceWorker' in navigator && import.meta.env.PROD) navigator.serviceWorker.register('sw.js').catch(() => {});
  migrateLegacy();
  if (!(await chooseTrip())) { $('#list').innerHTML = '<p class="nowx">Could not load your trips. Check your connection; the app retries when you come back to it.</p>'; return; }
  const cached = tstore.get('itin.v1', null);
  adoptWx(tstore.get('wx.v1', null));
  let painted = false;
  if (cached?.days?.length) { // paint from the saved copy at once, refresh behind it
    try { applyItin(cached); start(); painted = true; } catch (err) {
      console.error(err);
      try { state.wx = null; applyItin(cached); start(); painted = true; } catch (err2) { console.error(err2); state.itin = null; } // bad saved weather? go on without it
    }
  }
  if (painted) {
    loadItin().then((changed) => { if (!changed) return; if (!state.touched) start(); else { const d = state.view === 'trip' ? -1 : Math.min(state.view, state.days.length - 1); selectView(d < 0 ? 'trip' : d); } ensureRoutes(); });
    followIndex();
  } else if (await loadItin() || await retryWithFreshIndex()) { try { start(); } catch (err) { console.error(err); state.wx = null; start(); } }
  else { tripId = null; freshIndex = null; $('#list').innerHTML = '<p class="nowx">Could not load the itinerary. Check your connection; the app retries when you come back to it.</p>'; return; }

  if (!state.wx) { const id = tripId; try { const r = await fetch(`weather/${id}.json`, { signal: AbortSignal.timeout?.(8000) }); if (r.ok && tripId === id && adoptWx(await r.json())) render(); } catch { /* none */ } } // a late answer for a trip no longer open is dropped
  refreshWeather(true);
  ensureRoutes();
  if (store.get('geo', false)) { // resume live location only if it is already allowed, so launch never prompts
    try { const st = await navigator.permissions.query({ name: 'geolocation' }); if (st.state === 'granted') locate(false); } catch { /* no Permissions API: wait for a tap */ }
  }
}
boot();
