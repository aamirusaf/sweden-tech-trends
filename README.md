# Sweden Tech Stack Trends

Tracks how much Swedish employers are demanding specific technologies, based on
live job postings from [Arbetsförmedlingen](https://arbetsformedlingen.se/) (via
the public [JobTech Dev](https://jobtechdev.se/) search API), and visualizes the
results as a small dashboard.

## How it works

1. `backend/main.py` queries the JobTech Dev search API for a fixed set of
   technologies (grouped into Languages, Cloud & Infra, and Data & AI) and
   records how many active job postings mention each one.
2. Results are written to `backend/data/tech_trends.json`.
3. `frontend/index.html` reads that JSON file and renders a horizontal bar
   chart per category with [Chart.js](https://www.chartjs.org/).

## Setup

```bash
pip install -r backend/requirements.txt
```

## Usage

Refresh the data (hits the live API, takes a minute or two):

```bash
python backend/main.py
```

Serve the project **from the repository root** (the frontend fetches the data
file via a relative path, so frontend/ and backend/ need to be served as
siblings):

```bash
python -m http.server 8000
```

Then open `http://localhost:8000/frontend/`.

> Opening `frontend/index.html` directly by double-clicking it will not work —
> browsers block `fetch()` of local files, so a local server is required.

## Hosting and automatic updates

The site is static and is hosted on Cloudflare (Workers static assets), deployed
from this repository on every push to `main`:

- `wrangler.jsonc` publishes the repository root, so `frontend/` and
  `backend/data/` are served as siblings. `.assetsignore` keeps the source,
  README and git files out of the published site.
- `_redirects` sends the site root `/` to `/frontend/`.
- In the Cloudflare dashboard the deploy command should be the default
  `npx wrangler deploy` with no extra flags, so it uses `wrangler.jsonc`.

The data is refreshed by the **Update job market data** GitHub Action
(`.github/workflows/update-data.yml`). It runs every Monday at 05:00 UTC (and can
be run by hand from the Actions tab), runs `backend/main.py`, and commits the
updated JSON in `backend/data/` back to `main`. Cloudflare redeploys on that
push. `history.json` is committed too, so each run adds a new weekly
snapshot to the existing history.

## Long-term history

`backend/data/history.csv` is the permanent record and is never trimmed. Each
run adds one row per skill and location:

```
date,category,skill,location,postings
2026-10-31,Languages,Python,Stockholm,237
```

It grows by about 68 rows a week (roughly 150 KB a year), shows clean diffs in
git, and loads directly in Excel or pandas
(`pd.read_csv("backend/data/history.csv", parse_dates=["date"])`). It is also
published with the site at `/backend/data/history.csv`.

`history.json` holds only the most recent 52 snapshots, which is all the
dashboard needs for its trend badges.

## Historical backfill (2006 onwards)

`backend/data/historical_monthly.csv` covers the years before this project started
collecting. It is built from Arbetsförmedlingen's
[Historical Ads](https://jobtechdev.se/en/components/historical-ads) dataset by
`backend/backfill_historical.py`, run through the **Backfill historical data**
GitHub Action (Actions tab → Run workflow). It is not part of the weekly update.

```
month,category,skill,location,ads,total_ads
2015-03,Languages,Python,Stockholm,412,9873
```

- `ads` is the number of ads **published that month** that mention the skill in
  the headline or description. `total_ads` is all ads published that month in
  that location, so `ads / total_ads` gives a share you can compare across years.
- This is a different measure from `history.csv`, which counts ads that are
  *active* on the day of each weekly run, using the live search API. Don't plot
  the two as one line.
- Skill matching uses the same rules as `main.py`, with one exception. "Go" only
  counts as "Golang" or as a capitalised "Go" in a list of technologies, because
  the plain word is common English.

If any API request fails after retries, the script exits with an error and
leaves the previous data files untouched, so a bad run never records zeros in
the history.

## Status

- [x] Backend data collection from the JobTech Dev API
- [x] Frontend dashboard with per-category demand charts
- [ ] Course recommendations to close skill gaps for in-demand technologies
