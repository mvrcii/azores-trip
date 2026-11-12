// Smoke tests: the flows a traveller depends on. External services are blocked so runs are deterministic;
// the app must work from its own files (itinerary + bundled forecast snapshot) alone.
import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.route(/^https?:\/\/(?!localhost)/, (route) => route.abort());
  page.on('pageerror', (e) => { throw e; });
});

test('trip overview lists every day and opens one', async ({ page }) => {
  await page.goto('/?now=2026-11-01T10:00');
  await expect(page.locator('.daycard')).toHaveCount(7);
  await expect(page.locator('#tabs button')).toHaveCount(8);
  await page.locator('.daycard').nth(1).click();
  await expect(page.locator('#tabs [aria-current="page"]')).toHaveAttribute('data-view', '1');
  await expect(page.locator('.row')).toHaveCount(7);
});

test('today shows what is next and when to leave', async ({ page }) => {
  await page.goto('/?now=2026-11-13T10:40');
  const next = page.locator('.nextup');
  await expect(next).toContainText('Vista do Rei');
  await expect(next).toContainText(/Leave (in|now)/);
  await expect(page.locator('.row.current')).toContainText('Boca do Inferno');
  await expect(page.locator('.nowline')).toHaveCount(1);
});

test('no next-up block once the day is over', async ({ page }) => {
  await page.goto('/?now=2026-11-13T23:00');
  await expect(page.locator('.row, .earlier').first()).toBeVisible();
  await expect(page.locator('.nextup')).toHaveCount(0);
});

test('stop card navigates to the parking spot, and back returns to the list', async ({ page }) => {
  await page.goto('/?day=2&now=2026-11-01T10:00');
  await page.locator('#row-fri-ferraria').click();
  await expect(page.locator('#stop-title')).toHaveText(/Ferraria/);
  await expect(page.locator('#nav-g')).toHaveAttribute('href', /destination=37\.85817,-25\.84987&travelmode=driving/);
  await page.locator('#back').click();
  await expect(page.locator('#row-fri-ferraria')).toBeVisible();
});

test('marking a stop done persists across a reload', async ({ page }) => {
  await page.goto('/?day=2&now=2026-11-01T10:00');
  await page.locator('#row-fri-boca').click();
  await page.locator('#done-btn').click();
  await expect(page.locator('#row-fri-boca')).toHaveClass(/done/);
  await page.reload();
  await expect(page.locator('#row-fri-boca')).toHaveClass(/done/);
});

test('the sheet toggles height and never scrolls the page sideways', async ({ page }) => {
  await page.goto('/?day=4&now=2026-11-01T10:00');
  await expect(page.locator('#sheet')).toHaveAttribute('data-snap', 'half');
  await page.locator('#grab').click();
  await expect(page.locator('#sheet')).toHaveAttribute('data-snap', 'full');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
