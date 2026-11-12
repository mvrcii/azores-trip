// Trips as data files: choosing a trip, per-trip time zone, per-trip storage, and the validator.
// A fixture trip in Tokyo (tests/fixtures/trips/) is served next to the real ones; it never ships.
import { test, expect } from '@playwright/test';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const FIXTURE = 'tests/fixtures/trips/test-tokyo.json';
const tokyo = JSON.parse(readFileSync(FIXTURE, 'utf8'));
const SM = 'sao-miguel-2026';

test.use({ serviceWorkers: 'block' }); // the worker would answer data requests itself and bypass the fixture routes

test.beforeEach(async ({ page }) => {
  await page.route(/^https?:\/\/(?!localhost)/, (route) => route.abort());
  page.on('pageerror', (e) => { throw e; });
  await page.route('**/data/trips/index.json', async (route) => {
    const res = await route.fetch();
    const index = await res.json();
    index.trips.push({ id: 'test-tokyo', name: tokyo.trip, subtitle: tokyo.subtitle, start: tokyo.days[0].date, end: tokyo.days[tokyo.days.length - 1].date, timezone: tokyo.timezone });
    await route.fulfill({ response: res, json: index });
  });
  await page.route('**/data/trips/test-tokyo.json', (route) => route.fulfill({ path: FIXTURE, contentType: 'application/json' }));
});

const storage = (page) => page.evaluate(() => Object.fromEntries(Object.keys(localStorage).map((k) => [k, localStorage.getItem(k)])));

test('the trip that contains today opens by itself, in its own time zone', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-12-01T02:30:00Z')); // 11:30 in Tokyo, 02:30 in the Azores
  await page.goto('/');
  await expect(page.locator('.head h2')).toHaveText('Old Tokyo on foot');
  await expect(page.locator('.nowline')).toHaveText('Now 11:30');
  await expect(page.locator('.row.current')).toContainText('Ueno Park');
});

test('the next upcoming trip opens when none is under way', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-11-25T12:00:00Z'));
  await page.goto('/');
  await expect(page.locator('.head h2')).toHaveText('Tokyo test');
  await expect(page.locator('.daycard')).toHaveCount(2);
});

test('?trip opens a trip even while another one is under way', async ({ page }) => {
  await page.goto('/?trip=test-tokyo&now=2026-11-13T10:40');
  await expect(page.locator('.head h2')).toHaveText('Tokyo test');
  await expect(page.locator('#tabs button')).toHaveCount(3);
  await page.goto('/?now=2026-11-13T10:40');
  await expect(page.locator('.nextup')).toContainText('Vista do Rei');
});

test('trips do not share ticks or cached data', async ({ page }) => {
  await page.goto('/?trip=test-tokyo&day=1&now=2026-11-01T10:00');
  await page.locator('#row-tk1-ueno').click();
  await page.locator('#done-btn').click();
  await expect(page.locator('#row-tk1-ueno')).toHaveClass(/done/);
  await page.goto(`/?trip=${SM}&day=2&now=2026-11-01T10:00`);
  await expect(page.locator('#row-fri-boca')).not.toHaveClass(/done/);
  const ls = await storage(page);
  expect(JSON.parse(ls['trip:test-tokyo:done.v1'])).toHaveProperty('tk1-ueno');
  expect(ls[`trip:${SM}:done.v1`] ?? '{}').not.toContain('tk1-ueno');
  expect(JSON.parse(ls['trip:test-tokyo:itin.v1']).trip).toBe('Tokyo test');
  expect(JSON.parse(ls[`trip:${SM}:itin.v1`]).trip).toBe('São Miguel');
  expect(ls['done.v1']).toBeUndefined();
  await page.goto('/?trip=test-tokyo&day=1&now=2026-11-01T10:00');
  await expect(page.locator('#row-tk1-ueno')).toHaveClass(/done/);
});

test('ticks saved before trips were files carry over to São Miguel, and the live app keeps its own', async ({ page }) => {
  await page.goto('/?now=2026-11-01T10:00');
  await page.evaluate(() => { // a phone that used the live app, which shares this origin's storage and still uses these keys
    localStorage.clear();
    localStorage.setItem('done.v1', JSON.stringify({ 'fri-boca': 1 }));
    localStorage.setItem('shift.v1', JSON.stringify({ '2026-11-13': 30 }));
  });
  await page.goto('/?day=2&now=2026-11-01T10:00');
  await expect(page.locator('#row-fri-boca')).toHaveClass(/done/);
  await expect(page.locator('.head .sub')).toContainText('plan +30 min');
  let ls = await storage(page);
  expect(JSON.parse(ls['done.v1'])).toEqual({ 'fri-boca': 1 }); // untouched for the live app
  expect(JSON.parse(ls['shift.v1'])).toEqual({ '2026-11-13': 30 });
  expect(JSON.parse(ls[`trip:${SM}:done.v1`])).toHaveProperty('fri-boca');

  // A tick here, then one in the live app: after the next start both are there.
  await page.locator('#row-fri-ferraria').click();
  await page.locator('#done-btn').click();
  await page.evaluate(() => localStorage.setItem('done.v1', JSON.stringify({ 'fri-boca': 1, 'fri-hike': 2 })));
  await page.goto('/?day=2&now=2026-11-01T10:00');
  for (const id of ['fri-boca', 'fri-ferraria', 'fri-hike']) await expect(page.locator(`#row-${id}`)).toHaveClass(/done/);
  ls = await storage(page);
  expect(Object.keys(JSON.parse(ls['done.v1']))).toEqual(['fri-boca', 'fri-hike']); // the preview never writes the live app's keys
});

test('a fresh index wins over a saved one', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-12-01T02:30:00Z')); // during the Tokyo trip
  await page.goto('/?trip=sao-miguel-2026');
  await expect(page.locator('.head h2')).toHaveText('São Miguel'); // the app has saved its index by now
  await page.evaluate((sm) => localStorage.setItem('trips.v1', JSON.stringify([{ id: sm, name: 'São Miguel', start: '2026-11-12', end: '2026-11-18', timezone: 'Atlantic/Azores' }])), SM);
  await page.goto('/'); // the saved index knows only São Miguel; the server's lists Tokyo too
  await expect(page.locator('.head h2')).toHaveText('Old Tokyo on foot');
});

test('a returning visit paints at once on weak signal and switches when the fresh index changes the choice', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-12-01T02:30:00Z')); // during the Tokyo trip
  await page.goto('/?trip=sao-miguel-2026'); // saves the São Miguel plan
  await expect(page.locator('.head h2')).toHaveText('São Miguel');
  await page.evaluate((sm) => localStorage.setItem('trips.v1', JSON.stringify([{ id: sm, name: 'São Miguel', start: '2026-11-12', end: '2026-11-18', timezone: 'Atlantic/Azores' }])), SM);
  let release;
  const gate = new Promise((r) => { release = r; });
  await page.route('**/data/trips/**', async (route) => { await gate; await route.fallback(); }); // weak signal: data answers only when released
  const t0 = Date.now();
  await page.goto('/');
  await expect(page.locator('.head h2')).toHaveText('São Miguel', { timeout: 1000 }); // the saved plan, without waiting on the index
  expect(Date.now() - t0).toBeLessThan(1500);
  release();
  await expect(page.locator('.head h2')).toHaveText('Old Tokyo on foot'); // the fresh index knows a trip under way
});

test('a fresh index does not move someone who is looking around the open trip', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-12-01T02:30:00Z'));
  await page.goto('/?trip=sao-miguel-2026');
  await expect(page.locator('.head h2')).toHaveText('São Miguel');
  await page.evaluate((sm) => localStorage.setItem('trips.v1', JSON.stringify([{ id: sm, name: 'São Miguel', start: '2026-11-12', end: '2026-11-18', timezone: 'Atlantic/Azores' }])), SM);
  let release;
  const gate = new Promise((r) => { release = r; });
  await page.route('**/data/trips/index.json', async (route) => { await gate; await route.fallback(); });
  await page.goto('/');
  await page.locator('#tabs button').nth(2).click(); // the user picks a day
  release();
  await page.waitForResponse('**/data/trips/index.json');
  await page.waitForTimeout(300);
  await expect(page.locator('.head h2')).not.toHaveText('Old Tokyo on foot');
  await expect(page.locator('#tabs button').nth(2)).toHaveAttribute('aria-current', 'page');
});

test('the validator names the file and the problem', () => {
  const dir = mkdtempSync(join(tmpdir(), 'trips-'));
  try {
    const bad = structuredClone(tokyo);
    bad.timezone = 'Asia/Atlantis';
    const s = bad.days[0].items[1];
    [s.lat, s.lon] = [s.lon, s.lat];
    Object.assign(bad.days[0].items[2], { lat: 37.74, lon: -25.67 }); // on Earth, but half a world away from the rest
    writeFileSync(join(dir, 'broken.json'), JSON.stringify(bad));
    writeFileSync(join(dir, 'fine.json'), JSON.stringify(tokyo));
    const r = spawnSync(process.execPath, ['scripts/validate.mjs', dir, '--check'], { encoding: 'utf8' });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('broken.json has 3 problem(s)');
    expect(r.stderr).toContain('timezone "Asia/Atlantis" is not a known IANA time zone');
    expect(r.stderr).toMatch(/tk1-ueno.*not on Earth \(swapped\?\)/);
    expect(r.stderr).toMatch(/tk1-lunch.*km from the rest of the trip \(swapped or mistyped\?\)/);
    expect(r.stderr).not.toContain('fine.json');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
