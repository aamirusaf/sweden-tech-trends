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

The site is static, so it is hosted on [Cloudflare Pages](https://pages.cloudflare.com/)
straight from this repository, with no build step:

- **Build command:** none
- **Build output directory:** `/` (the repository root, so `frontend/` and
  `backend/data/` are served as siblings)
- `_redirects` sends the site root `/` to `/frontend/`.

The data is refreshed by the **Update job market data** GitHub Action
(`.github/workflows/update-data.yml`). It runs every Monday at 05:00 UTC (and can
be run by hand from the Actions tab), runs `backend/main.py`, and commits the
updated JSON in `backend/data/` back to `main`. Cloudflare Pages redeploys on
that push. `history.json` is committed too, so each run adds a new weekly
snapshot to the existing history.

If any API request fails after retries, the script exits with an error and
leaves the previous data files untouched, so a bad run never records zeros in
the history.

## Status

- [x] Backend data collection from the JobTech Dev API
- [x] Frontend dashboard with per-category demand charts
- [ ] Course recommendations to close skill gaps for in-demand technologies
