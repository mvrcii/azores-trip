// Validates data/itinerary.json and copies it to public/data/ for the build.
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = resolve(root, 'data/itinerary.json');
const errors = [];
const err = (where, msg) => errors.push(`${where}: ${msg}`);

let itin;
try { itin = JSON.parse(readFileSync(src, 'utf8')); } catch (e) {
  console.error(`data/itinerary.json is not valid JSON: ${e.message}`);
  process.exit(1);
}

const TYPES = ['view', 'hike', 'hotspring', 'food', 'boat', 'sight', 'logistics'];
const MODES = ['drive', 'walk', 'boat', 'hike'];
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const inBox = (lat, lon) => lat > 36.5 && lat < 40.5 && lon > -32 && lon < -24; // Azores
const coord = (w, o) => {
  if (!o || !isNum(o.lat) || !isNum(o.lon)) return err(w, 'needs numeric lat and lon');
  if (!inBox(o.lat, o.lon)) err(w, `lat/lon ${o.lat},${o.lon} is not in the Azores (swapped?)`);
};
const poly = (w, p) => {
  if (!Array.isArray(p) || p.length < 2 || !p.every((x) => Array.isArray(x) && x.length === 2 && x.every(isNum))) err(w, 'polyline must be [[lat,lon],...] with 2+ points');
};

if (!Array.isArray(itin.days) || !itin.days.length) err('root', 'days[] is required');
for (const [name, b] of Object.entries(itin.bases || {})) coord(`bases.${name}`, b);

const ids = new Set();
let prevDate = '';
for (const [di, d] of (itin.days || []).entries()) {
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
    if (it.route) { if (!MODES.includes(it.route.mode)) err(`${w}.route`, 'mode invalid'); poly(`${w}.route.polyline`, it.route.polyline); }
    if (it.sea) coord(`${w}.sea`, it.sea);
    if (typeof it.bookingNeeded !== 'boolean') err(w, 'bookingNeeded must be true or false');
  }
  for (const it of d.items.filter((i) => i.mode)) for (const k of ['from', 'to']) if (!dayIds.has(it[k])) err(dw, `leg ${k} "${it[k]}" is not a stop id of this day`);
}

if (errors.length) {
  console.error(`itinerary.json has ${errors.length} problem(s):\n` + errors.map((e) => '  - ' + e).join('\n'));
  process.exit(1);
}
mkdirSync(resolve(root, 'public/data'), { recursive: true });
writeFileSync(resolve(root, 'public/data/itinerary.json'), JSON.stringify(itin));
console.log(`itinerary.json OK: ${itin.days.length} days, ${ids.size} stops`);
