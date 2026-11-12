// Weather fetching shared by the browser app and the hourly GitHub Actions job.
// Output shape (also the shape of weather.json):
// { fetchedAt, loc: { "<lat,lon>": { t:[iso], pp, pr, tc, at, ws, wg, cc, wc, sun:{d,rise,set} } },
//   sea: { "<lat,lon>": { t, wh, wp, sh } } }

const HOURLY = 'precipitation_probability,precipitation,temperature_2m,apparent_temperature,wind_speed_10m,wind_gusts_10m,cloud_cover,weather_code';
const MARINE = 'wave_height,wave_period,swell_wave_height,sea_level_height_msl';
export const LIMITS = { rain: 60, gust: 45, wave: 2, gustSevere: 70 }; // gustSevere and sev 2 mark real trouble; the rest is a heads-up

export const locKey = (p) => `${p.lat.toFixed(2)},${p.lon.toFixed(2)}`;
export const seaPoint = (s) => s.sea || { lat: s.lat, lon: s.lon };
export const needsSea = (s) => s.type === 'boat' || !!s.sea || !!s.tide;

export function allStops(itin) {
  return itin.days.flatMap((d) => d.items.filter((i) => !i.mode).map((i) => ({ ...i, date: d.date })));
}

export function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function todayIn(tz, now = new Date()) { // date and minute of the day in the trip's time zone
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(now).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, min: +p.hour * 60 + +p.minute };
}

function window(itin, today) {
  const first = itin.days[0].date, last = itin.days[itin.days.length - 1].date;
  const start = first > today ? first : today;
  const horizon = addDays(today, 15);
  const end = last < horizon ? last : horizon;
  return start <= end ? { start, end } : null;
}

async function getJson(url, fetchFn) {
  const opt = () => (typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? { signal: AbortSignal.timeout(15000) } : {});
  let r;
  try { r = await fetchFn(url, opt()); } catch { // one retry for flaky mobile connections
    await new Promise((res) => setTimeout(res, 1200));
    r = await fetchFn(url, opt());
  }
  if (!r.ok) throw new Error(`HTTP ${r.status} from ${new URL(url).host}`);
  const j = await r.json();
  return Array.isArray(j) ? j : [j];
}

export async function fetchWeather(itin, today, fetchFn = fetch, prev = null) {
  const w = window(itin, today);
  const out = { fetchedAt: Date.now(), loc: {}, sea: {} };
  if (!w) return out;
  const stops = allStops(itin);
  const land = new Map(), sea = new Map();
  for (const s of stops) {
    land.set(locKey(s), s);
    if (needsSea(s)) sea.set(locKey(seaPoint(s)), seaPoint(s));
  }
  const q = (m) => `latitude=${[...m.values()].map((p) => p.lat).join(',')}&longitude=${[...m.values()].map((p) => p.lon).join(',')}`;
  const common = `timezone=${encodeURIComponent(itin.timezone)}&start_date=${w.start}&end_date=${w.end}`;

  const lj = await getJson(`https://api.open-meteo.com/v1/forecast?${q(land)}&hourly=${HOURLY}&daily=sunrise,sunset&wind_speed_unit=kmh&${common}`, fetchFn);
  [...land.keys()].forEach((k, i) => {
    const h = lj[i].hourly, d = lj[i].daily;
    out.loc[k] = {
      t: h.time, pp: h.precipitation_probability, pr: h.precipitation, tc: h.temperature_2m, at: h.apparent_temperature,
      ws: h.wind_speed_10m, wg: h.wind_gusts_10m, cc: h.cloud_cover, wc: h.weather_code,
      sun: { d: d.time, rise: d.sunrise, set: d.sunset },
    };
  });

  // Second opinion on gusts: two other models, so the app can show when forecasts disagree.
  // Refreshed at most every 2 hours; in between the previous ranges are reused to keep API use low.
  const reuse = prev?.gAt && Date.now() - prev.gAt < 2 * 3600 * 1000 && [...land.keys()].every((k) => prev.loc?.[k]?.gLo && prev.loc[k].t[0] === out.loc[k].t[0] && prev.loc[k].t.length === out.loc[k].t.length);
  if (reuse) {
    out.gAt = prev.gAt;
    for (const k of land.keys()) { out.loc[k].gLo = prev.loc[k].gLo; out.loc[k].gHi = prev.loc[k].gHi; }
  } else {
    try {
      const gj = await getJson(`https://api.open-meteo.com/v1/forecast?${q(land)}&hourly=wind_gusts_10m&models=ecmwf_ifs025,gfs_seamless&wind_speed_unit=kmh&${common}`, fetchFn);
      [...land.keys()].forEach((k, i) => {
        const h = gj[i].hourly, L = out.loc[k];
        const all = (j) => [L.wg[j], h.wind_gusts_10m_ecmwf_ifs025?.[j], h.wind_gusts_10m_gfs_seamless?.[j]].filter((v) => v != null);
        L.gLo = L.t.map((_, j) => (all(j).length ? Math.round(Math.min(...all(j))) : null));
        L.gHi = L.t.map((_, j) => (all(j).length ? Math.round(Math.max(...all(j))) : null));
      });
      out.gAt = Date.now();
    } catch { /* optional */ }
  }

  if (sea.size) {
    try {
      const mj = await getJson(`https://marine-api.open-meteo.com/v1/marine?${q(sea)}&hourly=${MARINE}&${common}`, fetchFn);
      [...sea.keys()].forEach((k, i) => {
        const h = mj[i].hourly;
        out.sea[k] = { t: h.time, wh: h.wave_height, wp: h.wave_period, sh: h.swell_wave_height, sl: h.sea_level_height_msl };
      });
    } catch (e) { out.seaError = String(e.message || e); }
  }
  return out;
}

// Forecast for one stop: the arrival hour and the hour after, plus warnings over the whole stay.
export function forecastFor(wx, stop, date, time, durationMin = 0) {
  const L = wx?.loc?.[locKey(stop)];
  if (!L) return null;
  const i = L.t.indexOf(`${date}T${time.slice(0, 2)}:00`);
  if (i < 0) return null;
  const hour = (j) => (j < L.t.length ? {
    time: L.t[j].slice(11), pp: L.pp[j], pr: L.pr[j], tc: L.tc[j], at: L.at[j], ws: L.ws[j], wg: L.wg[j], cc: L.cc[j], wc: sky(L, j),
  } : null);
  const res = { now: hour(i), next: hour(i + 1), sea: null, tide: null, warn: [], span: {} };
  const n = Math.min(12, Math.max(2, Math.ceil((+time.slice(3, 5) + durationMin) / 60))); // hours touched by the stay
  const peak = (arr, from, len) => { let b = from; for (let j = from; j < from + n && j < len; j++) if ((arr[j] ?? -1) > (arr[b] ?? -1)) b = j; return b; };
  const when = (t, j, first) => (j === first ? '' : ` at ${t[j].slice(11, 13)}:00`);
  const jr = peak(L.pp, i, L.t.length), jg = peak(L.wg, i, L.t.length);
  let mm = 0, peakMm = 0; for (let j = i; j < i + n && j < L.t.length; j++) { mm += L.pr[j] ?? 0; peakMm = Math.max(peakMm, L.pr[j] ?? 0); }
  res.span = { pp: L.pp[jr] ?? 0, wg: L.wg[jg] ?? 0, mm, hours: n, gLo: L.gLo?.[jg] ?? null, gHi: L.gHi?.[jg] ?? null };
  if (res.span.pp >= LIMITS.rain) res.warn.push({ kind: 'rain', sev: res.span.pp >= 80 && (peakMm >= 4 || mm >= 10) ? 2 : 1, text: `Rain ${Math.round(res.span.pp)}%${when(L.t, jr, i)}` });
  if (res.span.wg >= LIMITS.gust) res.warn.push({ kind: 'gust', sev: res.span.wg >= LIMITS.gustSevere ? 2 : 1, text: `Gusts ${Math.round(res.span.wg)} km/h${when(L.t, jg, i)}` });
  if (needsSea(stop)) {
    const S = wx.sea?.[locKey(seaPoint(stop))];
    const k = S ? S.t.indexOf(L.t[i]) : -1;
    if (k >= 0 && S.wh[k] != null) {
      const jw = peak(S.wh, k, S.t.length);
      res.sea = { wh: S.wh[k], wp: S.wp[k], sh: S.sh[k], max: S.wh[jw] };
      if (S.wh[jw] >= LIMITS.wave) res.warn.push({ kind: 'wave', sev: S.wh[jw] >= (stop.type === 'boat' ? 2.5 : 2) ? 2 : 1, text: `Waves ${S.wh[jw].toFixed(1)} m${when(S.t, jw, k)}` });
    }
    if (stop.tide && k >= 0 && S.sl && S.sl[k] != null) res.tide = tideAt(S, k, date, n);
  }
  if (res.tide?.far) res.warn.push({ kind: 'tide', sev: 1, text: `Low tide is at ${res.tide.low}` });
  const cc = Math.max(res.now.cc ?? 0, res.next?.cc ?? 0);
  if (stop.type === 'view' && cc >= 85) res.warn.push({ kind: 'cloud', sev: 1, text: `Cloud ${Math.round(cc)}%` });
  return res;
}

// Nearest low and high tide (hourly resolution) around index k, within the same day.
function tideAt(S, k, date, n = 1) {
  const idx = S.t.map((t, i) => (t.startsWith(date) ? i : -1)).filter((i) => i >= 0 && S.sl[i] != null);
  const turn = (sign) => idx.filter((i) => S.sl[i - 1] != null && S.sl[i + 1] != null && sign * (S.sl[i] - S.sl[i - 1]) <= 0 && sign * (S.sl[i] - S.sl[i + 1]) < 0);
  const near = (list) => list.reduce((a, b) => (a == null || Math.abs(b - k) < Math.abs(a - k) ? b : a), null);
  const low = near(turn(1)), high = near(turn(-1));
  if (low == null) return null;
  return {
    low: S.t[low].slice(11), high: high != null ? S.t[high].slice(11) : null,
    trend: S.sl[k + 1] == null ? 'steady' : S.sl[k + 1] > S.sl[k] ? 'rising' : 'falling',
    far: low < k - 2 || low > k + n - 1 + 2, // no low tide within 2 h of the stay
  };
}

// Sky condition for an hour. Some models report weather_code 0 while it rains, so rain and cloud data win over the code.
export function sky(L, j) {
  if (L.tc[j] == null && L.cc[j] == null) return null; // no data for this hour
  const c = L.wc[j], pr = L.pr[j] ?? 0, pp = L.pp[j] ?? 0, cc = L.cc[j] ?? 0;
  if (c >= 95 || (c >= 71 && c <= 77) || c === 85 || c === 86 || c === 45 || c === 48) return c; // thunder, snow, fog: trust the code
  if (pr >= 2.5) return 65;
  if (pr >= 0.3 || pp >= 70) return 61;
  if (pr > 0 || pp >= 45) return 51;
  return cc >= 85 ? 3 : cc >= 50 ? 2 : cc >= 20 ? 1 : 0;
}
