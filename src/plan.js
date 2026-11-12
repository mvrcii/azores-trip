// Pure plan logic: times, legs, leave-by, day totals, now/next. No DOM, no Leaflet.
// createPlan(getState) binds it to a state object { itin, routes, shift, done } so tests can pass a fake one.

export const toMin = (t) => +t.slice(0, 2) * 60 + +t.slice(3, 5);
export const hm = (m) => { const x = ((Math.round(m) % 1440) + 1440) % 1440; return `${String(Math.floor(x / 60)).padStart(2, '0')}:${String(x % 60).padStart(2, '0')}`; };
export const dur = (m) => (m >= 60 ? `${Math.floor(m / 60)} h${m % 60 ? ' ' + (m % 60) : ''}` : `${m} min`);
export const km = (m) => (m >= 10000 ? Math.round(m / 1000) : (m / 1000).toFixed(1)) + ' km';
export function dist(a, b) {
  const R = 6371000, r = Math.PI / 180;
  const x = (b.lon - a.lon) * r * Math.cos(((a.lat + b.lat) / 2) * r), y = (b.lat - a.lat) * r;
  return Math.sqrt(x * x + y * y) * R;
}
export const DAY_COLORS = ['#9c6a00', '#1a7d79', '#8a4fb0', '#7a5a3a', '#a84a86', '#5468c4', '#227d4d', '#6b6f1f', '#4a7a9c']; // ≥ 4.5:1 with white; no reds (warnings) and no route blue

export const nextDate = (d) => new Date(Date.parse(d + 'T12:00:00Z') + 864e5).toISOString().slice(0, 10);
export const routeKey = (a, b) => `${a.lon.toFixed(5)},${a.lat.toFixed(5)};${b.lon.toFixed(5)},${b.lat.toFixed(5)}`;

export function createPlan(getState) {
  const state = { get itin() { return getState().itin; }, get routes() { return getState().routes; }, get shift() { return getState().shift; }, get done() { return getState().done; } };
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

  function dayCtx(day, t) {
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
  // Once today is over: tomorrow's first stop and when to leave the base for it. Null on the last day, when the
  // next day in the plan is not the next calendar date, or when it has no stops.
  function tomorrowStart(days, idx) {
    const day = days[idx], tom = days[idx + 1];
    if (!day || !tom?.stops.length || tom.date !== nextDate(day.date)) return null;
    const stop = tom.stops[0], lv = leaveBy(tom, -1);
    return { day: tom, stop, by: lv ? lv.by : eff(tom, stop), tr: lv?.tr || null }; // a first stop at the base: leave at its own time
  }
  return { buildDay, isFixed, shiftOf, eff, driveInfo, travelTo, leaveBy, dayTotals, dayCtx, tomorrowStart };
}
