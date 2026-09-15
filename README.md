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

## Status

- [x] Backend data collection from the JobTech Dev API
- [x] Frontend dashboard with per-category demand charts
- [ ] Course recommendations to close skill gaps for in-demand technologies
