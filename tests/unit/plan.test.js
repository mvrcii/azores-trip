import test from 'node:test';
import assert from 'node:assert/strict';
import { toMin, hm, dur, dist, routeKey, createPlan } from '../../src/plan.js';

const base = { lat: 37.8, lon: -25.5 };
const far = { lat: 37.8, lon: -25.4 }; // about 8.8 km east
const stop = (id, time, o = {}) => ({ id, time, durationMin: 60, lat: 37.8, lon: -25.4, walk: { minutes: 5, km: 0.3 }, ...o });
const mk = (stops, st = {}) => {
  const state = { itin: { bases: { b: base } }, routes: {}, shift: {}, done: {}, ...st };
  const plan = createPlan(() => state);
  const day = plan.buildDay({ date: '2026-11-13', start: 'b', items: stops }, 0);
  return { state, plan, day };
};

test('time helpers', () => {
  assert.equal(toMin('09:05'), 545);
  assert.equal(hm(545), '09:05');
  assert.equal(hm(1440 + 30), '00:30'); // wraps past midnight
  assert.equal(hm(-10), '23:50');
  assert.equal(dur(45), '45 min');
  assert.equal(dur(125), '2 h 5');
  assert.equal(dur(120), '2 h');
  assert.ok(Math.abs(dist(base, far) - 8800) < 300);
  assert.equal(routeKey(base, far), '-25.50000,37.80000;-25.40000,37.80000');
});

test('first stop from the base: drive estimate, walk, no walk back', () => {
  const { plan, day } = mk([stop('a', '10:00', { parking: { ...far, name: 'P' } })]);
  const lv = plan.leaveBy(day, -1);
  const d = plan.driveInfo(day.driveTo.a);
  assert.equal(d.est, true);
  assert.equal(lv.tr.min, d.min + 5);
  assert.equal(lv.by, 600 - lv.tr.min);
  assert.equal(lv.short, 0);
});

test('a routed drive replaces the estimate', () => {
  const { plan, day, state } = mk([stop('a', '10:00', { parking: { ...far, name: 'P' } })]);
  state.routes[day.driveTo.a.key] = { s: 1200, m: 15000 };
  assert.deepEqual(plan.driveInfo(day.driveTo.a), { min: 20, m: 15000, est: false });
});

test('walk back uses returnMin, else the walk time, to reach the car', () => {
  const p1 = { ...far, name: 'P1' }, p2 = { lat: 37.81, lon: -25.3, name: 'P2' };
  const a = (o) => stop('a', '09:00', { parking: p1, ...o });
  const b = stop('b', '13:00', { parking: p2, lat: 37.81, lon: -25.3 });
  const withReturn = mk([a({ returnMin: 30 }), b]);
  const without = mk([a(), b]);
  const drive = without.plan.driveInfo(without.day.driveTo.b).min;
  assert.equal(without.plan.travelTo(without.day, 1).min, drive + 5 + 5);
  assert.equal(withReturn.plan.travelTo(withReturn.day, 1).min, drive + 5 + 30);
});

test('same car park: walk back, walk on', () => {
  const p = { ...far, name: 'P' };
  const { plan, day } = mk([stop('a', '09:00', { parking: p }), stop('b', '12:00', { parking: p, walk: { minutes: 7, km: 0.5 } })]);
  assert.equal(plan.travelTo(day, 1).min, 7 + 5);
});

test('arriveEarlyMin moves the leave-by earlier', () => {
  const plain = mk([stop('a', '09:00'), stop('b', '12:00')]);
  const early = mk([stop('a', '09:00'), stop('b', '12:00', { arriveEarlyMin: 15 })]);
  assert.equal(plain.plan.leaveBy(plain.day, 0).by - early.plan.leaveBy(early.day, 0).by, 15);
  assert.equal(plain.plan.leaveBy(plain.day, 0).by, 720 - 5);
});

test('leaveBy is null after the last stop; from the base only when the trip is 3+ min', () => {
  const { plan, day } = mk([stop('a', '09:00', { walk: { minutes: 2, km: 0.1 } })]);
  assert.equal(plan.leaveBy(day, 0), null);
  assert.equal(plan.leaveBy(day, -1), null);
});

test('short and clash: a late stop squeezes the next one', () => {
  const { plan, day } = mk([stop('a', '09:00'), stop('b', '10:10', { bookingNeeded: true })]);
  const lv = plan.leaveBy(day, 0);
  assert.equal(lv.by, 605); // 10:10 minus 5 min walk
  assert.equal(lv.short, 540 + 60 - 605); // stop a runs to 10:00
  assert.equal(lv.clash, false);
  // clash: the next fixed stop is so close that you would have to leave before the current one starts
  const tight = mk([stop('a', '09:00'), stop('b', '09:03', { bookingNeeded: true })]);
  assert.equal(tight.plan.leaveBy(tight.day, 0).clash, true);
  // a loose next stop never clashes
  const loose = mk([stop('a', '09:00'), stop('b', '09:03')]);
  assert.equal(loose.plan.leaveBy(loose.day, 0).clash, false);
});

test('a shift moves loose stops and leaves fixed ones', () => {
  const { plan, day, state } = mk([stop('a', '09:00'), stop('b', '12:00', { fixed: true }), stop('c', '14:00', { bookingNeeded: true })]);
  state.shift['2026-11-13'] = 45;
  assert.equal(plan.eff(day, day.stops[0]), 585);
  assert.equal(plan.eff(day, day.stops[1]), 720);
  assert.equal(plan.eff(day, day.stops[2]), 840);
  assert.equal(plan.shiftOf(day), 45);
  // shifting a into b's window shows up as a clash against the fixed stop
  state.shift['2026-11-13'] = 200; // a now starts at 12:20, after the 11:55 leave-by for b
  assert.equal(plan.leaveBy(day, 0).clash, true);
});

test('day totals add drives and walks', () => {
  const { plan, day, state } = mk([stop('a', '09:00', { parking: { ...far, name: 'P' }, walk: { minutes: 5, km: 1 } }), stop('h', '13:00', { type: 'hike', note: 'Loop of 6.5 km', walk: { minutes: 5, km: 0.5 } })]);
  state.routes[day.driveTo.a.key] = { s: 600, m: 5000 };
  const t = plan.dayTotals(day);
  assert.equal(t.min, 10);
  assert.equal(t.m, 5000);
  assert.equal(t.walk, 2 * 1 + 0.5 + 6.5); // car-park stop walks out and back
});

const today = (min) => ({ date: '2026-11-13', min });
const three = () => [stop('a', '09:00'), stop('b', '12:00'), stop('c', '15:00')];

test('now/next: before the day, between stops, during a stop', () => {
  const { plan, day } = mk(three());
  let c = plan.dayCtx(day, today(7 * 60));
  assert.equal(c.curId, null); assert.equal(c.nextId, 'a'); assert.equal(c.nowBefore, 0); assert.equal(c.over, false);
  c = plan.dayCtx(day, today(9 * 60 + 30));
  assert.equal(c.curId, 'a'); assert.equal(c.nextId, 'b'); assert.equal(c.passedBefore, 0);
  c = plan.dayCtx(day, today(12 * 60 + 10));
  assert.equal(c.curId, 'b'); assert.equal(c.nextId, 'c');
});

test('now/next: another date has no now or next', () => {
  const { plan, day } = mk(three());
  const c = plan.dayCtx(day, { date: '2026-11-14', min: 600 });
  assert.equal(c.isToday, false); assert.equal(c.nextId, null); assert.equal(c.nowBefore, -1);
});

test('now/next: ticked stops count as passed', () => {
  const { plan, day } = mk(three(), { done: { a: true, b: true } });
  const c = plan.dayCtx(day, today(9 * 60 + 30));
  assert.equal(c.curId, null); // a is done, so it is no longer current
  assert.equal(c.nextId, 'c');
  assert.equal(c.passedBefore, 2);
});

test('now/next: everything done, and day over', () => {
  const done = mk(three(), { done: { a: true, b: true, c: true } });
  let c = done.plan.dayCtx(done.day, today(10 * 60));
  assert.equal(c.nextId, null); assert.equal(c.curId, null); assert.equal(c.over, true);
  const late = mk(three());
  c = late.plan.dayCtx(late.day, today(23 * 60));
  assert.equal(c.over, true); assert.equal(c.nextId, null);
  // the last stop still counts as current inside its 2 h grace, but the day is over once it has ended
  c = late.plan.dayCtx(late.day, today(16 * 60 + 30));
  assert.equal(c.curId, 'c'); assert.equal(c.over, true);
  c = late.plan.dayCtx(late.day, today(15 * 60 + 30));
  assert.equal(c.curId, 'c'); assert.equal(c.over, false);
});

test('now/next: midnight edges', () => {
  const { plan, day } = mk([stop('a', '00:00'), stop('z', '23:30', { durationMin: 30 })]);
  let c = plan.dayCtx(day, today(0));
  assert.equal(c.curId, 'a'); assert.equal(c.nextId, 'z');
  c = plan.dayCtx(day, today(23 * 60 + 59));
  assert.equal(c.curId, 'z'); assert.equal(c.over, false); // z ends at 24:00
});

test('shifted day moves now/next with it', () => {
  const { plan, day, state } = mk(three());
  state.shift['2026-11-13'] = 60;
  const c = plan.dayCtx(day, today(9 * 60 + 30)); // a now starts at 10:00
  assert.equal(c.curId, null); assert.equal(c.nextId, 'a');
});
