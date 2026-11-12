# Working agreement for agents

This repository is worked on by several AI agents (Claude sessions in different roles, and Codex as a
reviewer) with one human owner. Read this file fully before doing anything. It is the source of truth
for how we work; the backlog lives in GitHub issues.

## The product

A phone-first trip companion: for each day of a trip it shows where to go next, when to leave, where
to park, what to walk, and whether the weather is a problem, on a real map.

- Today it is hard-wired to one trip (São Miguel, Azores, 12–18 Nov 2026) and the owner is **using it
  on that trip right now**.
- The goal: a multi-trip app. Any trip is a data file; the app offers a trip picker; maps, time zones,
  weather and routing work anywhere (a beach-hopping month in Thailand, a week in Japan, a city
  weekend). São Miguel stays as one trip among others.
- Static site, no backend, no API keys, no accounts. Free public services only (OpenStreetMap tiles,
  Open-Meteo, OSRM, routing.openstreetmap.de). Anything that would need a server is out of scope
  until the owner says otherwise; write it up as an issue labelled `needs-owner` instead of building it.

## Hard rules

1. **Never push to `main`, never merge into `main`.** `main` is the live site the owner depends on.
   Only the owner promotes. All work targets `next`.
2. **No private data in the repo or the site**: no real addresses of accommodation, booking numbers,
   door codes, phone numbers, names of travel companions. Bases are town-level points only.
3. **Do not weaken tests to get green.** No skipping, deleting or loosening an assertion to pass CI.
   If a test is wrong, fix the test and say why in the pull request.
4. **No new runtime dependencies, services or frameworks** without an issue that argues for it and an
   approval from the lead role. The app is deliberately small (vanilla JS, Leaflet, Vite).
5. **Stay inside this repository.** Do not touch other repositories, organisations or accounts.
6. Ask the owner only when truly blocked: open an issue labelled `needs-owner` with the decision
   needed and your recommendation, then carry on with something else.

## Branches and shipping

- `main`: live at https://mvrcii.de/azores-trip/. Owner only.
- `next`: preview at https://mvrcii.de/azores-trip/next/. Agents ship here through pull requests.
- Work branches: `agent/<issue-number>-<short-slug>`, branched from `next`, one issue per branch.
- A pull request into `next` may be merged by the integrator role when **all** of these hold:
  CI is green; a reviewer that is not its author approved it (see Review); it changes what its issue
  asks and nothing else; screenshots are attached for anything visible.
- Promotion: one standing pull request `next → main` titled "Promote next to live" is kept up to date
  by the lead with a plain-language summary of what changed. Nobody but the owner merges it.

## Roles

Each run of an agent is a fresh session with no memory. State lives in GitHub: issues, pull requests,
and this file. Start every run by reading this file, `docs/ROADMAP.md`, the open issues and open pull
requests. End every run by leaving the next agent able to continue: push your branch, update the
issue or pull request with what you did, what is left, and anything surprising.

- **Lead** (planning): owns `docs/ROADMAP.md` and the backlog. Turns the goal into small, testable
  issues with clear acceptance criteria; orders them with the labels below; closes stale ones;
  keeps the "Promote next to live" pull request and its summary current; answers `needs-lead`.
  Does not write product code.
- **Builder**: takes the highest-priority open issue labelled `ready` that nobody has claimed
  (claim it by commenting "Taking this" and adding `in-progress`), implements it with tests,
  opens a pull request into `next`. One issue per run; finish or hand off cleanly.
- **Integrator** (review and merge): reviews open pull requests against their issue and this file,
  runs the app, requests Codex's review, resolves or routes review findings, merges what meets the
  bar, and checks the preview after each merge. Never merges its own code.
- **Tester**: uses the preview like a traveller on a phone (see Testing), on every trip in
  `data/`, files precise bug issues with screenshots and steps, and re-tests fixed ones.

## Labels

`ready` (specified, can be built) · `in-progress` · `bug` · `feature` · `design` · `data` (trip
content) · `tech` (refactor, tooling, tests) · `p0` (broken for a traveller) · `p1` · `p2` ·
`needs-owner` · `needs-lead`.

## Review

- Every pull request gets two reviews before merge: the integrator (a Claude session that did not
  write it) and Codex.
- To request Codex, comment exactly `@codex review` on the pull request. Codex answers on the pull
  request. Treat its findings as claims to verify: fix what is real, reply briefly where it is not.
  If Codex has not answered within one integrator cycle, note that in the pull request and proceed on
  the integrator's review alone; never block for more than a day on a missing review.
- Reviews check, in this order: does it do what the issue asks; can it break the live trip flows
  (next up, leave-by, navigation links, done ticks, offline start); data safety (rule 2); tests;
  accessibility and the design rules below; code clarity.

## Testing

- `npm test` runs the browser smoke tests (Playwright, iPhone viewport, external services blocked).
  Every bug fix adds a test that fails without the fix. Every feature adds at least one test of its
  main flow.
- `npm run build` validates `data/` and must pass. `?now=2026-11-13T10:40` simulates the clock,
  `?day=N` opens a day.
- Exploratory testing (tester role): drive the built app in a headless browser at 390x664 and
  320x568, light and dark, plus 1024x768. Look at screenshots, not only the DOM. Check the map as
  much as the list: route lines, pins, fit, legends. Test offline start (service worker) and corrupt
  local storage occasionally.
- In cloud sessions a Chromium binary is at `/opt/pw-browsers/chromium`; the config uses it.
  Outbound hosts may be restricted; mock external services rather than depend on them.

## Design rules (the owner's taste, in their words and ours)

- The map is the hero: full screen, everything else floats on it or sits in the bottom sheet.
- Calm and glanceable. One line per stop in lists; detail on the stop card. If a screen shows the
  same fact twice, remove one.
- **No dot-separated strings of facts** ("Next · 13:45 · 20° · rain 5%"). Use an icon with a value,
  spacing, or separate lines. No emoji; icons come from `src/icons.js` (one hand-drawn line set;
  extend it in the same style).
- Red means real trouble only (see `LIMITS` in `src/wxcore.js`). Milder notes are grey.
- Poster look: cream paper, navy ink, hand-lettered face for day titles and numerals only, system
  font for everything else. Day colours identify days; never red, never the route blue.
- Copy is short and plain. No hedging, no chatty filler, nothing that reads machine-written.
- Tap targets at least 44 px. Works one-handed. Dark mode is designed, not inverted.
- When in doubt, look at how Apple Maps, Google Maps, Wanderlog and Flighty solve it, then do the
  simplest version that fits this app.

## Code map

- `data/itinerary.json`: the current single trip (schema in `README.md`, checked by
  `scripts/validate.mjs`). `scripts/bake-paths.mjs` routes walking and hiking lines.
- `src/main.js`: state, map, sheet, rendering. `src/wxcore.js`: forecast fetching and warnings (also
  used by `scripts/fetch-weather.mjs` at build time). `src/icons.js`, `src/style.css`.
- `public/sw.js`: offline shell and data cache. `.github/workflows/`: `deploy.yml` (live + preview),
  `ci.yml` (pull requests).

## Ending a run

Leave no uncommitted work. If you could not finish, push the branch, open or update a draft pull
request, and write a short handoff in the issue: done, not done, next step. Then stop. Another run
will pick it up.
