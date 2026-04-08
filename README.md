# Globle Bot

A lightweight web app that suggests the next best guess for Globle. Add each guess and place it in closest-to-farthest order; enter the distance if the guess is closest.

## Run
Start the backend and open the app in your browser:

```bash
node server.js
```

Then visit `http://localhost:5173`.

## Download Data (Recommended)
If you want full-country coverage without relying on runtime fetches:

```bash
node scripts/fetch-data.js
```

## Training
Run the trainer to compute the best starting guess and average guesses:

```bash
node train.js
```

The trainer uses `data/countries.json` if present, then falls back to the backend or remote sources.

For a slower, more accurate sweep using country borders:

```bash
node train.js --exhaustive --accurate --geo-step-km 10 --geo-sample 0 --no-early-stop
```

The training run writes its results to `data/training.json`, and the web UI will display it automatically.
If you enable distance export (default), it also writes `data/distances.json` which the UI uses for better suggestions.

## How it works
- **Order list**: keep the guess list ordered from closest to farthest. You can insert guesses in between or reorder with the arrows.
- **Distance filter**: candidates must match any provided distances (rounded to the nearest km). A distance of 0 means the countries touch or are the same.
- **Distance tolerance**: to avoid empty results due to map data differences, distances are matched within a small fixed tolerance.
- **Ordering rule**: if a guess is closer than another guess, candidates must be closer to the closer guess (Voronoi-style constraint).
- **Next best guess**: ranks guesses by expected remaining candidates given the ordered feedback model.

## Data
The backend fetches country polygons and serves them from `/api/geojson`. The frontend computes border-to-border distances from those polygons. If map data is unavailable, it falls back to a small centroid-only list.
Territories are excluded via the allowlist in `data/sovereign-countries.json`. Update that file if you want to add or remove entries, then re-run training.

## Notes
- Enter guesses in the same order you made them in Globle.
- The app suggests a starting guess as soon as the data loads.
- If the candidate list hits zero, double-check the closest flag or distance value.
- You can add common aliases like `USA` or `UK` directly.
