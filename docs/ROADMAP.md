# Roadmap

Owned by the lead role. Keep it short; details live in issues.

## Now: from one trip to any trip

1. Trip data as files: `data/trips/<id>.json` with its own time zone, bases and days; São Miguel
   migrated without any visible change; validator covers all trips.
2. Trip picker and per-trip state (done ticks, time shifts, cached routes and forecast per trip).
3. Nothing assumes the Azores: time zone, map bounds, forecast window, tide and sea logic, copy.
4. Test trips that stress the model: a month across Thailand (many bases, ferries, long distances),
   a week in Japan (trains, city walking, no car), a two-day city break (no driving at all).
5. Transport beyond car + walk: train, ferry, flight, scooter, on foot only.

## Next

- Editing a trip on the phone without touching JSON (still no backend: local edits, export/import).
- Sharing a trip as a link or file.
- Offline maps for a trip's area.

## Standing quality work

- Smoke tests for every flow a traveller depends on; visual checks at phone sizes in light and dark.
- Accessibility, performance on a slow phone, and resilience to weak signal.
