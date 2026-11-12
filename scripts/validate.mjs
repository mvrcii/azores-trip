// Validates every trip in data/trips/, writes data/trips/index.json from them, and copies the trips to
// public/data/trips/ for the build.
//   node scripts/validate.mjs                 validate data/trips and write the outputs
//   node scripts/validate.mjs <dir> --check   validate another folder of trips, write nothing
import { readFileSync, mkdirSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const check = args.includes('--check');
const dir = resolve(root, args.find((a) => !a.startsWith('--')) || 'data/trips');
const rel = (f) => relative(root, resolve(dir, f)).replaceAll('\\', '/');

const TYPES = ['view', 'hike', 'hotspring', 'food', 'boat', 'sight', 'logistics'];
const MODES = ['drive', 'walk', 'boat', 'hike'];
const MAX_KM = 2500; // a point further than this from the middle of its trip is almost certainly a typo or swapped lat/lon
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const km = (a, b) => { // great-circle distance
  const r = Math.PI / 180, dLat = (b.lat - a.lat) * r, dLon = (b.lon - a.lon) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
};
const median = (xs) => { const s = [...xs].sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

function validateTrip(itin) {
  const errors = [];
  const err = (where, msg) => errors.push(`${where}: ${msg}`);
  const points = []; // [where, {lat, lon}] for the distance check
  const coord = (w, o) => {
    if (!o || !isNum(o.lat) || !isNum(o.lon)) return err(w, 'needs numeric lat and lon');
    if (Math.abs(o.lat) > 90 || Math.abs(o.lon) > 180) return err(w, `lat/lon ${o.lat},${o.lon} is not on Earth (swapped?)`);
    points.push([w, o]);
  };
  const poly = (w, p) => {
    if (!Array.isArray(p) || p.length < 2 || !p.every((x) => Array.isArray(x) && x.length === 2 && x.every(isNum))) err(w, 'polyline must be [[lat,lon],...] with 2+ points');
  };

  if (!itin || typeof itin !== 'object' || Array.isArray(itin)) return ['root: must be an object'];
  if (!itin.trip || typeof itin.trip !== 'string') err('root', 'trip (the trip name) is required');
  if (!itin.timezone || typeof itin.timezone !== 'string') err('root', 'timezone is required, an IANA name such as "Europe/Lisbon"');
  else { try { new Intl.DateTimeFormat('en', { timeZone: itin.timezone }); } catch { err('root', `timezone "${itin.timezone}" is not a known IANA time zone`); } }
  if (!Array.isArray(itin.days) || !itin.days.length) err('root', 'days[] is required');
  for (const [name, b] of Object.entries(itin.bases || {})) coord(`bases.${name}`, b);

  const ids = new Set();
  let prevDate = '';
  for (const [di, d] of (Array.isArray(itin.days) ? itin.days : []).entries()) {
    const dw = `days[${di}]`;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d.date || '')) err(dw, 'date must be YYYY-MM-DD');
    if (d.date <= prevDate) err(dw, 'days must be in ascending date order');
    prevDate = d.date;
    if (!d.title) err(dw, 'title is required');
    for (const k of ['start', 'base']) if (d[k] && !itin.bases?.[d[k]]) err(dw, `${k} "${d[k]}" is not defined in bases`);
    if (!Array.isArray(d.items)) { err(dw, 'items[] is required'); continue; }
    if (!d.items.some((i) => !i.mode)) err(dw, 'needs at least one stop');
    const dayIds = new Set();
    let prevTime = '';
    for (const [ii, it] of d.items.entries()) {
      const w = `${dw}.items[${ii}]${it.id ? ` (${it.id})` : ''}`;
      if (it.mode) { // explicit leg
        if (!MODES.includes(it.mode)) err(w, `leg mode must be one of ${MODES.join(', ')}`);
        if (!it.from || !it.to) err(w, 'leg needs from and to (stop ids)');
        continue;
      }
      if (!it.id) err(w, 'id is required'); else if (!/^[A-Za-z0-9_-]+$/.test(it.id)) err(w, 'id may only contain letters, digits, - and _'); else if (ids.has(it.id)) err(w, 'duplicate id'); else { ids.add(it.id); dayIds.add(it.id); }
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(it.time || '')) err(w, 'time must be HH:MM');
      else { if (it.time < prevTime) err(w, 'stops must be in time order'); prevTime = it.time; }
      if (!Number.isInteger(it.durationMin) || it.durationMin < 0) err(w, 'durationMin must be a whole number >= 0');
      if (it.arriveEarlyMin != null && (!Number.isInteger(it.arriveEarlyMin) || it.arriveEarlyMin < 0)) err(w, 'arriveEarlyMin must be a whole number >= 0');
      if (it.returnMin != null && (!Number.isInteger(it.returnMin) || it.returnMin < 0)) err(w, 'returnMin must be a whole number >= 0');
      if (!it.name) err(w, 'name is required');
      if (!TYPES.includes(it.type)) err(w, `type must be one of ${TYPES.join(', ')}`);
      coord(w, it);
      if (it.parking != null) {
        coord(`${w}.parking`, it.parking);
        if (!it.parking.name) err(`${w}.parking`, 'name is required');
        if (typeof it.parking.free !== 'boolean') err(`${w}.parking`, 'free must be true or false');
      }
      if (!it.walk || !Number.isInteger(it.walk.minutes) || it.walk.minutes < 0 || !isNum(it.walk.km)) err(w, 'walk needs whole minutes and km');
      else if (it.walk.polyline) poly(`${w}.walk.polyline`, it.walk.polyline);
      if (it.route) { if (!MODES.includes(it.route.mode)) err(`${w}.route`, 'mode invalid'); poly(`${w}.route.polyline`, it.route.polyline); if (it.route.via) poly(`${w}.route.via`, it.route.via); }
      if (it.sea) coord(`${w}.sea`, it.sea);
      if (typeof it.bookingNeeded !== 'boolean') err(w, 'bookingNeeded must be true or false');
    }
    for (const it of d.items.filter((i) => i.mode)) for (const k of ['from', 'to']) if (!dayIds.has(it[k])) err(dw, `leg ${k} "${it[k]}" is not a stop id of this day`);
  }

  // Sanity check that works anywhere on Earth: every point lies within a plausible distance of the trip's middle.
  if (points.length) {
    const mid = { lat: median(points.map(([, p]) => p.lat)), lon: median(points.map(([, p]) => p.lon)) };
    for (const [w, p] of points) {
      const d = km(mid, p);
      if (d > MAX_KM) err(w, `lat/lon ${p.lat},${p.lon} is ${Math.round(d)} km from the rest of the trip (swapped or mistyped?)`);
    }
  }
  return errors;
}

let files;
try { files = readdirSync(dir).filter((f) => f.endsWith('.json') && f !== 'index.json').sort(); } catch (e) {
  console.error(`${rel('')} cannot be read: ${e.message}`);
  process.exit(1);
}
const problems = [], trips = [];
if (!files.length) problems.push(`${rel('')}: no trip files (expected <trip-id>.json)`);
for (const f of files) {
  const id = f.slice(0, -5);
  const errs = [];
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) errs.push('file name (the trip id) may only contain lower-case letters, digits and -');
  let itin = null;
  try { itin = JSON.parse(readFileSync(resolve(dir, f), 'utf8')); } catch (e) { errs.push(`not valid JSON: ${e.message}`); }
  if (itin) errs.push(...validateTrip(itin));
  if (errs.length) problems.push(`${rel(f)} has ${errs.length} problem(s):\n` + errs.map((e) => '  - ' + e).join('\n'));
  else trips.push({ id, itin });
}

if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}

const index = {
  trips: trips.map(({ id, itin }) => ({
    id, name: itin.trip, subtitle: itin.subtitle || '', start: itin.days[0].date, end: itin.days[itin.days.length - 1].date, timezone: itin.timezone,
  })).sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : a.id < b.id ? -1 : 1)),
};
for (const { id, itin } of trips) console.log(`${rel(id + '.json')} OK: ${itin.days.length} days, ${itin.days.reduce((n, d) => n + d.items.filter((i) => !i.mode).length, 0)} stops, ${itin.timezone}`);
if (check) process.exit(0);

// data/trips/index.json is generated: it always matches the trip files.
writeFileSync(resolve(dir, 'index.json'), JSON.stringify(index, null, 2) + '\n');
const pub = resolve(root, 'public/data');
rmSync(pub, { recursive: true, force: true }); // trips that were removed must not linger in the build
mkdirSync(resolve(pub, 'trips'), { recursive: true });
writeFileSync(resolve(pub, 'trips/index.json'), JSON.stringify(index));
for (const { id, itin } of trips) writeFileSync(resolve(pub, `trips/${id}.json`), JSON.stringify(itin));
console.log(`index.json written: ${index.trips.length} trip(s)`);
