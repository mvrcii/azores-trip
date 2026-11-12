// Fetches the forecast for all stops of every trip into public/weather/<trip-id>.json (offline / first-paint fallback).
// Run after scripts/validate.mjs. Never fails the build: on error it keeps or writes an empty file.
// Optional phone alerts: set NTFY_TOPIC to get a morning (07h) and evening (20h) warning digest via ntfy.sh,
// in each trip's own time zone.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchWeather, forecastFor, todayIn, addDays } from '../src/wxcore.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = resolve(root, 'public/weather');
mkdirSync(outDir, { recursive: true });
const { trips } = JSON.parse(readFileSync(resolve(root, 'data/trips/index.json'), 'utf8'));

for (const trip of trips) {
  const out = resolve(outDir, `${trip.id}.json`);
  const itin = JSON.parse(readFileSync(resolve(root, `data/trips/${trip.id}.json`), 'utf8'));
  const now = todayIn(itin.timezone);

  let wx = null;
  for (let attempt = 1; attempt <= 3 && !wx; attempt++) {
    try { wx = await fetchWeather(itin, now.date); } catch (e) {
      console.warn(`${trip.id}: weather fetch attempt ${attempt} failed: ${e.message}`);
      await new Promise((r) => setTimeout(r, attempt * 3000));
    }
  }
  if (wx) {
    writeFileSync(out, JSON.stringify(wx));
    console.log(`weather/${trip.id}.json written: ${Object.keys(wx.loc).length} locations, ${Object.keys(wx.sea).length} sea points`);
  } else if (!existsSync(out)) {
    writeFileSync(out, JSON.stringify({ fetchedAt: 0, loc: {}, sea: {} }));
    console.warn(`weather/${trip.id}.json: wrote empty fallback`);
  }

  const topic = process.env.NTFY_TOPIC;
  const hour = Math.floor(now.min / 60);
  if (wx && topic && process.env.GITHUB_EVENT_NAME === 'schedule' && (hour === 7 || hour === 20)) {
    const date = hour === 7 ? now.date : addDays(now.date, 1);
    const day = itin.days.find((d) => d.date === date);
    const lines = (day?.items || []).filter((i) => !i.mode).flatMap((s) => {
      const f = forecastFor(wx, s, date, s.time, s.durationMin);
      return f?.warn.length ? [`${s.time} ${s.name}: ${f.warn.map((w) => w.text).join(', ')}`] : [];
    });
    if (day && lines.length) {
      try {
        const r = await fetch(`https://ntfy.sh/${encodeURIComponent(topic)}`, {
          method: 'POST',
          headers: { Title: `${hour === 7 ? 'Today' : 'Tomorrow'}: ${lines.length} weather warning(s)`, Tags: 'umbrella' },
          body: lines.join('\n'),
        });
        console.log(r.ok ? 'ntfy alert sent' : `ntfy answered ${r.status}`);
      } catch (e) { console.warn('ntfy failed: ' + e.message); }
    }
  }
}
