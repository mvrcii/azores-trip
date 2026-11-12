// Replaces sketched walking and hiking lines in data/trips/<trip-id>.json with real paths from the
// OpenStreetMap walking router (routing.openstreetmap.de, foot profile). Run after changing stops:
//   npm run paths              every trip
//   npm run paths -- <trip-id> one trip
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = resolve(dirname(fileURLToPath(import.meta.url)), '../data/trips');
const only = process.argv[2];
const ids = readdirSync(dir).filter((f) => f.endsWith('.json') && f !== 'index.json').map((f) => f.slice(0, -5)).filter((id) => !only || id === only);
if (!ids.length) { console.error(only ? `no trip "${only}" in data/trips` : 'no trips in data/trips'); process.exit(1); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hav = (a, b) => { const R = 6371000, r = Math.PI / 180, x = (b[1] - a[1]) * r * Math.cos(((a[0] + b[0]) / 2) * r), y = (b[0] - a[0]) * r; return Math.sqrt(x * x + y * y) * R; };

async function foot(points) { // points: [[lat, lon], ...] → { line, km, min } or null
  const path = points.map(([lat, lon]) => `${lon},${lat}`).join(';');
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(`https://routing.openstreetmap.de/routed-foot/route/v1/foot/${path}?overview=full&geometries=geojson`);
      const j = await r.json();
      const rt = j.routes?.[0];
      if (!rt) return null;
      const c = rt.geometry.coordinates, step = Math.max(1, Math.ceil(c.length / 160));
      const line = c.filter((_, i) => i % step === 0 || i === c.length - 1).map(([x, y]) => [+y.toFixed(5), +x.toFixed(5)]);
      return { line, km: rt.distance / 1000, min: rt.duration / 60 };
    } catch { await sleep(1500); }
  }
  return null;
}

for (const id of ids) {
  const file = resolve(dir, `${id}.json`);
  const itin = JSON.parse(readFileSync(file, 'utf8'));
  let walks = 0, hikes = 0;
  for (const day of itin.days) for (const s of day.items) {
    if (s.mode) continue;
    if (s.parking) {
      const a = [s.parking.lat, s.parking.lon], b = [s.lat, s.lon], straight = hav(a, b);
      if (straight > 60) {
        const r = await foot([a, b]); await sleep(400);
        if (r && r.km * 1000 < straight * 3 + 250) { // sane: the router found a path, not a detour around a mountain
          s.walk.polyline = r.line; s.walk.km = +r.km.toFixed(r.km < 1 ? 2 : 1); s.walk.minutes = Math.max(1, Math.round(r.min));
          walks++;
        } else { delete s.walk.polyline; console.log(`walk kept straight: ${s.id}`); }
      }
    }
    if (s.route?.via) {
      const r = await foot(s.route.via); await sleep(400);
      if (r) { s.route.polyline = r.line; s.route.km = +r.km.toFixed(1); hikes++; console.log(`${s.id}: ${r.km.toFixed(1)} km on mapped paths`); } else console.log(`route kept as sketched: ${s.id}`);
    }
  }
  const out = JSON.stringify(itin, null, 2)
    .replace(/\[\s+(-?[\d.]+),\s+(-?[\d.]+)\s+\]/g, '[$1, $2]'); // coordinate pairs on one line
  writeFileSync(file, out + '\n');
  console.log(`${id}: baked ${walks} walking legs and ${hikes} trails`);
}
