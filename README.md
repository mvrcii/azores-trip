# azores-trip

Live at https://mvrcii.de/azores-trip/ (open in Safari, then Share → Add to Home Screen).

Personal trip app for a São Miguel (Azores) road trip, 12–18 Nov 2026. iPhone-first PWA:
day tabs, a real map with drive / walk / hike / boat legs and parking pins, a timeline of
stop cards, and live weather for every stop at its planned hour.

No backend, no API keys. Map tiles from OpenStreetMap, weather from Open-Meteo,
driving routes from the public OSRM server, optional rain radar from RainViewer.

## Trips

Every trip is one file: `data/trips/<trip-id>.json` (lower-case letters, digits and `-`). The app opens
the trip named by `?trip=<trip-id>`, else the trip under way today, else the next one, else the first.
Ticks, time shifts, routes and the saved forecast are kept per trip on the phone.

Edit a trip file and push to `next` through a pull request. The build validates every trip and fails with
a readable message naming the file and the problem (bad time, unknown time zone, a point thousands of
km from the rest of the trip, duplicate id, ...). It also regenerates `data/trips/index.json` (id, name,
subtitle, first and last date, time zone of every trip); do not edit that file by hand.

```
trip   → { trip: "<name>", subtitle?, timezone: "<IANA zone, e.g. Atlantic/Azores>", bases: { <name>: { label, lat, lon } }, days[] }
days[] → { date, title, tag?, start?, base, items[] }
stop   → { id, time, durationMin, name,
           type: view|hike|hotspring|food|boat|sight|logistics,
           lat, lon,
           parking: { name, lat, lon, note, free } | null,   // null = on foot from the previous stop
           walk: { minutes, km, surface, polyline? },        // parking → stop
           route?: { mode: hike|boat|walk, polyline: [[lat,lon],...] },  // the trail / boat track itself
           sea?: { lat, lon },                               // where to read waves for this stop
           note, bookingNeeded }
leg    → { mode: drive|walk|boat|hike, from: stopId, to: stopId }   // optional extra leg
```

- Times are local to the trip's `timezone`; "now", sunrise, sunset and the forecast use that zone.
- `start` / `base` name an entry in `bases` (where the car is in the morning / at night).
- Drive legs are routed automatically between consecutive parking spots.
- `npm run paths` (or `npm run paths -- <trip-id>`) replaces sketched walking and hiking lines with
  mapped paths.
- Keep it free of private data: no addresses, booking numbers, codes or phone numbers.
  Bases are town-level points only.

## Weather

- The app fetches Open-Meteo directly, every 15 minutes and whenever it returns to the foreground.
- An hourly GitHub Actions run also writes `weather/<trip-id>.json` into the deployed site as an
  offline and first-paint fallback. That schedule switches itself off after 19 Nov 2026.
- Warning badges: rain ≥ 60 %, gusts ≥ 45 km/h, waves ≥ 2 m (boat and ocean stops).
  Viewpoints also show cloud cover.

## Optional: weather alerts on the phone

Install the free [ntfy](https://ntfy.sh) app, subscribe to a topic name only you know, and save
that name as the repository secret `NTFY_TOPIC`. The hourly job then sends a digest of weather
warnings at about 07:00 (today) and 20:00 (tomorrow), in each trip's own time zone.

## Develop

```bash
npm install
npm run dev        # validates the trips, then starts Vite
npm run build      # validate → fetch weather/<trip-id>.json → build → dist/
npm test           # browser smoke tests (tests/fixtures/trips/ holds a test-only trip)
```

Test a moment in time with `?now=2026-11-13T10:30` (trip-local time), open a day with `?day=2`, or a
trip with `?trip=sao-miguel-2026`.

## Hosting

`.github/workflows/deploy.yml` builds on every push to `main` and deploys `dist/` to GitHub
Pages. One-time setup: repository Settings → Pages → Source: **GitHub Actions**.
