"""Backfill long-term tech demand from Arbetsförmedlingen's Historical Ads dataset.

The dataset (https://jobtechdev.se/en/components/historical-ads) has every job ad
published on Platsbanken since 2006, as one zipped JSONL file per year:
https://data.jobtechdev.se/annonser/historiska/<name>.jsonl.zip

This script counts, per month, how many *newly published* ads mention each
technology in TECH_STACKS, nationwide and in each city in LOCATIONS, plus the
total number of ads published that month (so you can compare shares across years
when overall ad volume changes).

Note this is a different measure from history.csv: that file records how many ads
are *active* on the day of each weekly run, as counted by the live search API.
The two should not be mixed in one chart without saying so.

Usage (each year file is processed separately so the work can run in parallel):

    python backend/backfill_historical.py count 2015 --out partial/2015.csv
    python backend/backfill_historical.py merge partial/*.csv --out backend/data/historical_monthly.csv
"""
import argparse
import csv
import json
import os
import re
import sys
import tempfile
import time
import unicodedata
import urllib.request
import zipfile
from collections import Counter

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from main import TECH_STACKS, LOCATIONS  # noqa: E402  (keep the skill list in one place)

BASE_URL = "https://data.jobtechdev.se/annonser/historiska/"

# 2018 and 2019 have re-published files with corrected municipality data.
DEFAULT_FILE_FOR = {
    "2018": "2018_municipality_patched",
    "2019": "2019_municipality_patched",
}

OUTPUT_FIELDS = ["month", "category", "skill", "location", "ads", "total_ads"]

# Municipality codes (SCB kommunkod) for the cities in LOCATIONS, used alongside
# the taxonomy concept IDs and the plain names, because older years may only
# carry one of them.
MUNICIPALITY_CODES = {"Stockholm": "0180", "Göteborg": "1480", "Malmö": "1280"}

# If fewer than this share of ads have a readable date or text, the file's schema
# isn't what this script expects. Fail rather than write misleading zeros.
MIN_PARSED_SHARE = 0.9

CATEGORY_OF = {skill: category for category, skills in TECH_STACKS.items() for skill in skills}


# --- skill matching ---------------------------------------------------------

def build_matchers():
    """Same rules as main.build_skill_matcher, except "Go". As a plain word it matches
    ordinary English ("go-to", "Go ahead"), which is noise across millions of
    full-text ads. So match "Golang", or a capitalised "Go" that sits in a list of
    technologies: next to a comma, slash, "&", bracket, "och/and/or/eller", or at
    the end of a line."""
    matchers = {}
    for skill in CATEGORY_OF:
        if skill == "Go":
            matchers[skill] = re.compile(
                r"\b[Gg]olang\b"
                r"|(?<=[,/&(]\s)Go\b|(?<=[,/&(])Go\b"
                r"|\bGo(?=\s*[,/&)]|\s+(?:och|and|or|eller)\b|\s*$)",
                re.MULTILINE,
            )
        elif re.fullmatch(r"[A-Za-z0-9]+", skill):
            matchers[skill] = re.compile(r"\b" + re.escape(skill) + r"\b", re.IGNORECASE)
        else:
            matchers[skill] = re.compile(re.escape(skill), re.IGNORECASE)
    return matchers


# --- reading one ad defensively ----------------------------------------------
# The field names below follow the JobSearch API format the dataset is based on.
# Older years may differ, so every lookup has fallbacks, and the run prints how
# often each lookup worked so a schema mismatch is visible in the job log.

def ad_text(ad):
    parts = []
    headline = ad.get("headline")
    if isinstance(headline, str):
        parts.append(headline)
    description = ad.get("description")
    if isinstance(description, dict):
        text = description.get("text") or description.get("text_formatted")
        if isinstance(text, str):
            parts.append(text)
    elif isinstance(description, str):
        parts.append(description)
    return "\n".join(parts)


def ad_month(ad):
    for key in ("publication_date", "publicationDate", "published", "application_deadline"):
        value = ad.get(key)
        if isinstance(value, str) and re.match(r"\d{4}-\d{2}", value):
            return value[:7]
    return None


def normalize(name):
    return unicodedata.normalize("NFC", name or "").strip().casefold()


CITY_NAMES = {normalize(city): city for city in LOCATIONS if LOCATIONS[city]}
CITY_IDS = {concept_id: city for city, concept_id in LOCATIONS.items() if concept_id}
CITY_CODES = {code: city for city, code in MUNICIPALITY_CODES.items()}


def ad_city(ad):
    """Return the LOCATIONS city the ad is in, or None (elsewhere in Sweden or unknown)."""
    address = ad.get("workplace_address")
    if not isinstance(address, dict):
        return None
    concept_id = address.get("municipality_concept_id")
    if concept_id in CITY_IDS:
        return CITY_IDS[concept_id]
    code = address.get("municipality_code")
    if isinstance(code, (str, int)) and str(code).zfill(4) in CITY_CODES:
        return CITY_CODES[str(code).zfill(4)]
    name = address.get("municipality")
    if isinstance(name, str):
        return CITY_NAMES.get(normalize(name))
    return None


# --- count ---------------------------------------------------------------------

def download(name, dest_dir, attempts=4):
    url = f"{BASE_URL}{name}.jsonl.zip"
    path = os.path.join(dest_dir, f"{name}.jsonl.zip")
    for attempt in range(1, attempts + 1):
        print(f"Downloading {url} (attempt {attempt})", flush=True)
        try:
            with urllib.request.urlopen(url, timeout=120) as response, open(path, "wb") as f:
                while chunk := response.read(1 << 20):
                    f.write(chunk)
            zipfile.ZipFile(path).close()  # raises if the download was cut short
            break
        except (OSError, zipfile.BadZipFile) as e:
            print(f"Download failed: {e}", flush=True)
            if attempt == attempts:
                raise
            time.sleep(30 * attempt)
    print(f"Downloaded {os.path.getsize(path) / 1e6:.0f} MB", flush=True)
    return path


def iter_ads(zip_path):
    with zipfile.ZipFile(zip_path) as archive:
        for member in archive.namelist():
            if member.endswith("/"):
                continue
            with archive.open(member) as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        yield json.loads(line)
                    except json.JSONDecodeError:
                        yield None


def count_file(zip_path):
    matchers = build_matchers()
    mentions = Counter()   # (month, skill, location) -> ads
    totals = Counter()     # (month, location) -> ads
    seen_ids = set()
    stats = Counter()

    for ad in iter_ads(zip_path):
        stats["lines"] += 1
        if not isinstance(ad, dict):
            stats["unparseable"] += 1
            continue
        if stats["lines"] == 1:
            print("First record keys:", sorted(ad.keys()), flush=True)

        ad_id = ad.get("id")
        if ad_id is not None:
            if ad_id in seen_ids:
                stats["duplicates"] += 1
                continue
            seen_ids.add(ad_id)

        month = ad_month(ad)
        if not month:
            stats["no_date"] += 1
            continue
        text = ad_text(ad)
        if not text:
            stats["no_text"] += 1
        city = ad_city(ad)
        if city:
            stats["in_tracked_city"] += 1
        stats["counted"] += 1

        locations = ["Sweden"] + ([city] if city else [])
        for location in locations:
            totals[(month, location)] += 1
        for skill, matcher in matchers.items():
            if text and matcher.search(text):
                for location in locations:
                    mentions[(month, skill, location)] += 1

        if stats["lines"] % 200000 == 0:
            print(f"  {stats['lines']:,} lines...", flush=True)

    print("Stats:", dict(stats), flush=True)
    ads = max(stats["lines"] - stats["unparseable"] - stats["duplicates"], 1)
    if stats["counted"] / ads < MIN_PARSED_SHARE:
        sys.exit(f"Only {stats['counted']}/{ads} ads had a publication date; schema not recognised.")
    if (stats["counted"] - stats["no_text"]) / max(stats["counted"], 1) < MIN_PARSED_SHARE:
        sys.exit(f"{stats['no_text']}/{stats['counted']} ads had no headline/description text; schema not recognised.")
    return mentions, totals


def rows_from_counts(mentions, totals):
    rows = []
    for (month, location), total in totals.items():
        for skill, category in CATEGORY_OF.items():
            rows.append({
                "month": month,
                "category": category,
                "skill": skill,
                "location": location,
                "ads": mentions.get((month, skill, location), 0),
                "total_ads": total,
            })
    return rows


def write_rows(path, rows):
    order = {skill: i for i, skill in enumerate(CATEGORY_OF)}
    location_order = {location: i for i, location in enumerate(LOCATIONS)}
    rows.sort(key=lambda r: (r["month"], order[r["skill"]], location_order.get(r["location"], 99)))
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=OUTPUT_FIELDS, lineterminator="\n")
        writer.writeheader()
        writer.writerows(rows)


def cmd_count(args):
    name = DEFAULT_FILE_FOR.get(args.name, args.name)
    if args.zip:
        mentions, totals = count_file(args.zip)
    else:
        with tempfile.TemporaryDirectory() as tmp:
            mentions, totals = count_file(download(name, tmp))
    rows = rows_from_counts(mentions, totals)
    write_rows(args.out, rows)
    print(f"Wrote {len(rows)} rows for {name} to {args.out}")


# --- merge ---------------------------------------------------------------------

def cmd_merge(args):
    """Combine per-file partial CSVs into the output file. A month can appear in two
    files (an ad published late in December may sit in the next year's file), so
    counts are summed. Months already in the output that no partial covers are kept."""
    ads = Counter()
    totals = Counter()
    kept = []
    for path in args.partials:
        with open(path, encoding="utf-8", newline="") as f:
            for row in csv.DictReader(f):
                ads[(row["month"], row["skill"], row["location"])] += int(row["ads"])
                totals[(row["month"], row["skill"], row["location"])] += int(row["total_ads"])
    rows = [
        {"month": month, "category": CATEGORY_OF[skill], "skill": skill, "location": location,
         "ads": ads[key], "total_ads": totals[key]}
        for key in totals
        for (month, skill, location) in [key]
        if skill in CATEGORY_OF
    ]
    # Keep months from an earlier run that this run didn't cover, so re-running a
    # few files doesn't wipe the rest of the archive.
    new_months = {r["month"] for r in rows}
    if os.path.exists(args.out):
        with open(args.out, encoding="utf-8", newline="") as f:
            kept = [r for r in csv.DictReader(f) if r["month"] not in new_months and r["skill"] in CATEGORY_OF]
    rows.extend(kept)
    write_rows(args.out, rows)
    months = sorted({r["month"] for r in rows})
    print(f"Wrote {len(rows)} rows covering {months[0] if months else '-'} to {months[-1] if months else '-'} to {args.out}")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)

    count = sub.add_parser("count", help="Count one Historical Ads file")
    count.add_argument("name", help='File name without extension, e.g. "2015" or "2026-Q1"')
    count.add_argument("--out", required=True)
    count.add_argument("--zip", help="Use an already downloaded .jsonl.zip instead of downloading")
    count.set_defaults(func=cmd_count)

    merge = sub.add_parser("merge", help="Merge partial CSVs into one file")
    merge.add_argument("partials", nargs="+")
    merge.add_argument("--out", required=True)
    merge.set_defaults(func=cmd_merge)

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
