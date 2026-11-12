# Roadmap

Owned by the lead role. Keep it short; details live in issues.

## Status (lead, 12 Nov 2026)

- `next` equals `main`: nothing has shipped to the preview yet, so there is nothing to promote.
- In review: trips as data files (#1, pull request #6) and the plan module with unit tests (#4, pull
  request #7). Everything under "Now" below builds on #6.
- The owner is on the São Miguel trip until 18 Nov. Bugs a traveller hits today (#9, #10, #11, #16)
  rank above multi-trip work of the same priority.

## Now: from one trip to any trip

1. Trip data as files: `data/trips/<id>.json` with its own time zone, bases and days; São Miguel
   migrated without any visible change; validator covers all trips.
2. Trip picker and per-trip state (done ticks, time shifts, cached routes and forecast per trip): #2.
   The preview keeps its own storage so test trips never reach the live app: #8, before any sample trip.
3. Nothing assumes the Azores: time zone, map bounds, forecast window, tide and sea logic, copy.
4. Test trips that stress the model, smallest first: a two-day city break (no driving at all, #14),
   a month across Thailand (many bases, ferries, long distances, #3), a week in Japan (trains, city
   walking, no car). Each one files the gaps it finds instead of bending to the model.
5. Transport beyond car + walk: train, ferry, flight, scooter, on foot only.

## Next

- Editing a trip on the phone without touching JSON (still no backend: local edits, export/import).
- Sharing a trip as a link or file.
- Offline maps for a trip's area.

## Standing quality work

- Smoke tests for every flow a traveller depends on (offline start: #13); unit tests for plan and
  forecast logic (#4, #12); visual checks at phone sizes in light and dark.
- `src/main.js` split into modules in small steps (#4, then #15), never as one rewrite.
- Accessibility, performance on a slow phone, and resilience to weak signal.
