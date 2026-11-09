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

The count step also writes partial/titles/<name>.csv: how many Data/IT ads each month
had a headline in each job-title family (backend/job_titles.py), nationwide. Merge
those with:

    python backend/backfill_historical.py merge-titles partial/titles/*.csv --out backend/data/historical_titles_monthly.csv

It also writes partial/topics/<name>.csv: how many Data/IT ads each month mention each
hot topic (backend/hot_topics.py: AI, LLMs, cybersecurity...), nationwide and per city.
Merge those with:

    python backend/backfill_historical.py merge-topics partial/topics/*.csv --out backend/data/historical_topics_monthly.csv
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
from datetime import datetime, timezone
from collections import Counter

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from main import TECH_STACKS, LOCATIONS, build_skill_matcher  # noqa: E402  (keep the skill list in one place)
from job_titles import classify_title, FAMILY_NAMES  # noqa: E402
import hot_topics  # noqa: E402

BASE_URL = "https://data.jobtechdev.se/annonser/historiska/"

# 2018 and 2019 have re-published files with corrected municipality data.
# These two are named "<name>.zip" on the server, not "<name>.jsonl.zip".
DEFAULT_FILE_FOR = {
    "2018": "2018_municipality_patched.zip",
    "2019": "2019_municipality_patched.zip",
}

MIN_YEAR = 2006

# ads / total_ads: across all job ads. it_ads / it_total_ads: only ads in the Data/IT
# occupation field, which is what the dashboard's history chart shows.
OUTPUT_FIELDS = ["month", "category", "skill", "location", "ads", "total_ads", "it_ads", "it_total_ads"]
# it_ads: Data/IT ads published that month whose headline is in the title family;
# it_total_ads: all Data/IT ads published that month. Nationwide only.
TITLE_FIELDS = ["month", "title", "it_ads", "it_total_ads"]
# it_ads: Data/IT ads published that month that mention the hot topic; it_total_ads: all
# Data/IT ads published that month in that location.
TOPIC_FIELDS = ["month", "topic", "location", "it_ads", "it_total_ads"]

DATA_IT_FIELD = "apaJ_2ja_LuF"

# Files before 2018 don't say which occupation field an ad belongs to, only the old
# occupation id (occupation.legacy_ams_taxonomy_id). This file lists the old ids that
# belong to Data/IT. It was built from the 2019-2023 files, where ads carry both the old
# id and the field, by giving each id the field most of its ads have.
LEGACY_IT_OCCUPATIONS_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "legacy_it_occupations.json")

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
    """Same matching rules as the weekly script (main.SKILL_PATTERNS)."""
    return {skill: build_skill_matcher(skill) for skill in CATEGORY_OF}


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


def valid_month(month):
    """Ads occasionally carry nonsense dates (e.g. year 2099); keep 2006 to this year."""
    return MIN_YEAR <= int(month[:4]) <= datetime.now(timezone.utc).year


def ad_month(ad):
    for key in ("publication_date", "publicationDate", "published"):
        value = ad.get(key)
        if isinstance(value, str) and re.match(r"\d{4}-\d{2}", value) and valid_month(value[:7]):
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


def first(value):
    return (value[0] if isinstance(value, list) and value else value) or {}


def load_legacy_it_occupations():
    with open(LEGACY_IT_OCCUPATIONS_PATH, encoding="utf-8") as f:
        return {str(i) for i in json.load(f)["legacy_ams_taxonomy_ids"]}


def ad_is_it(ad, legacy_it_ids):
    """True if the ad is in the Data/IT occupation field. Uses the field when the ad has
    one, and otherwise the old occupation id."""
    field = first(ad.get("occupation_field"))
    if isinstance(field, dict) and (field.get("concept_id") or field.get("label")):
        return field.get("concept_id") == DATA_IT_FIELD or field.get("label") == "Data/IT"
    occupation = first(ad.get("occupation"))
    legacy_id = occupation.get("legacy_ams_taxonomy_id") if isinstance(occupation, dict) else None
    return legacy_id is not None and str(legacy_id) in legacy_it_ids


# --- count ---------------------------------------------------------------------

def download(name, dest_dir, attempts=4):
    filename = name if name.endswith(".zip") else f"{name}.jsonl.zip"
    url = f"{BASE_URL}{filename}"
    path = os.path.join(dest_dir, filename)
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
            if attempt == attempts or getattr(e, "code", None) == 404:
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
                        # Some files (e.g. the 2018/2019 municipality-patched ones) are a
                        # JSON array with one ad per line: "[{...},", "{...},", "{...}]".
                        try:
                            yield json.loads(line.lstrip(b"[").rstrip(b",").rstrip(b"]").rstrip(b","))
                        except json.JSONDecodeError:
                            yield None


def count_file(zip_path):
    matchers = build_matchers()
    legacy_it_ids = load_legacy_it_occupations()
    mentions = Counter()   # (month, skill, location) -> ads
    totals = Counter()     # (month, location) -> ads
    it_mentions = Counter()
    it_totals = Counter()
    title_counts = Counter()  # (month, title family) -> Data/IT ads, nationwide
    topic_counts = Counter()  # (month, hot topic, location) -> Data/IT ads
    topic_terms = Counter()   # (hot topic, matched term) -> mentions, for the log
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

        is_it = ad_is_it(ad, legacy_it_ids)
        if is_it:
            stats["data_it"] += 1
            family = classify_title(ad.get("headline"))
            if family:
                title_counts[(month, family)] += 1
                stats["it_with_title_family"] += 1

        locations = ["Sweden"] + ([city] if city else [])
        for location in locations:
            totals[(month, location)] += 1
            if is_it:
                it_totals[(month, location)] += 1
        for skill, matcher in matchers.items():
            if text and matcher.search(text):
                for location in locations:
                    mentions[(month, skill, location)] += 1
                    if is_it:
                        it_mentions[(month, skill, location)] += 1

        if is_it and text:
            for topic in hot_topics.topics_in(text):
                for location in locations:
                    topic_counts[(month, topic, location)] += 1
            # Matched terms from every 10th Data/IT ad are enough to check the patterns.
            if stats["data_it"] % 10 == 0:
                hot_topics.matched_terms(text, topic_terms)

        if stats["lines"] % 200000 == 0:
            print(f"  {stats['lines']:,} lines...", flush=True)

    print("Stats:", dict(stats), flush=True)
    print("Terms matched per hot topic (every 10th Data/IT ad):", flush=True)
    hot_topics.print_matched_terms(topic_terms)
    # Unparseable lines count against the file: a format this script can't read must
    # fail the job, not quietly produce an almost-empty year.
    ads = max(stats["lines"] - stats["duplicates"], 1)
    if stats["counted"] / ads < MIN_PARSED_SHARE:
        sys.exit(f"Only {stats['counted']}/{ads} ads had a publication date; schema not recognised.")
    if (stats["counted"] - stats["no_text"]) / max(stats["counted"], 1) < MIN_PARSED_SHARE:
        sys.exit(f"{stats['no_text']}/{stats['counted']} ads had no headline/description text; schema not recognised.")
    # The oldest files (2006 and some later years) give no occupation for most ads, so
    # their Data/IT counts are empty and the chart leaves those years out. Say so in the
    # log rather than fail: the all-ads counts for those years are still valid.
    if stats["data_it"] < 0.01 * stats["counted"]:
        print(f"⚠️ Only {stats['data_it']} of {stats['counted']} ads could be placed in Data/IT; "
              "this file mostly has no occupation data.", flush=True)
    return mentions, totals, it_mentions, it_totals, title_counts, topic_counts


def rows_from_counts(mentions, totals, it_mentions, it_totals):
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
                "it_ads": it_mentions.get((month, skill, location), 0),
                "it_total_ads": it_totals.get((month, location), 0),
            })
    return rows


def title_rows_from_counts(title_counts, it_totals):
    return [
        {"month": month, "title": title, "it_ads": title_counts.get((month, title), 0), "it_total_ads": total}
        for (month, location), total in it_totals.items() if location == "Sweden"
        for title in FAMILY_NAMES
    ]


def write_title_rows(path, rows):
    order = {title: i for i, title in enumerate(FAMILY_NAMES)}
    rows.sort(key=lambda r: (r["month"], order[r["title"]]))
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=TITLE_FIELDS, lineterminator="\n")
        writer.writeheader()
        writer.writerows(rows)


def default_titles_out(out, kind="titles"):
    return os.path.join(os.path.dirname(os.path.abspath(out)), kind, os.path.basename(out))


def topic_rows_from_counts(topic_counts, it_totals):
    return [
        {"month": month, "topic": topic, "location": location,
         "it_ads": topic_counts.get((month, topic, location), 0), "it_total_ads": total}
        for (month, location), total in it_totals.items()
        for topic in hot_topics.TOPIC_NAMES
    ]


def write_topic_rows(path, rows):
    order = {topic: i for i, topic in enumerate(hot_topics.TOPIC_NAMES)}
    location_order = {location: i for i, location in enumerate(LOCATIONS)}
    rows.sort(key=lambda r: (r["month"], order[r["topic"]], location_order.get(r["location"], 99)))
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=TOPIC_FIELDS, lineterminator="\n")
        writer.writeheader()
        writer.writerows(rows)


def write_rows(path, rows):
    order = {skill: i for i, skill in enumerate(CATEGORY_OF)}
    location_order = {location: i for i, location in enumerate(LOCATIONS)}
    rows.sort(key=lambda r: (r["month"], order[r["skill"]], location_order.get(r["location"], 99)))
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=OUTPUT_FIELDS, lineterminator="\n", restval="")
        writer.writeheader()
        writer.writerows(rows)


def cmd_count(args):
    name = DEFAULT_FILE_FOR.get(args.name, args.name)
    if args.zip:
        counts = count_file(args.zip)
    else:
        with tempfile.TemporaryDirectory() as tmp:
            counts = count_file(download(name, tmp))
    mentions, totals, it_mentions, it_totals, title_counts, topic_counts = counts
    rows = rows_from_counts(mentions, totals, it_mentions, it_totals)
    write_rows(args.out, rows)
    print(f"Wrote {len(rows)} rows for {name} to {args.out}")
    titles_out = args.titles_out or default_titles_out(args.out)
    title_rows = title_rows_from_counts(title_counts, it_totals)
    write_title_rows(titles_out, title_rows)
    print(f"Wrote {len(title_rows)} job-title rows for {name} to {titles_out}")
    topics_out = args.topics_out or default_titles_out(args.out, "topics")
    topic_rows = topic_rows_from_counts(topic_counts, it_totals)
    write_topic_rows(topics_out, topic_rows)
    print(f"Wrote {len(topic_rows)} hot-topic rows for {name} to {topics_out}")


# --- merge ---------------------------------------------------------------------

def cmd_merge(args):
    """Combine per-file partial CSVs into the output file. A month can appear in two
    files (an ad published late in December may sit in the next year's file), so
    counts are summed. Months already in the output that no partial covers are kept."""
    sums = {field: Counter() for field in ("ads", "total_ads", "it_ads", "it_total_ads")}
    kept = []
    for path in args.partials:
        with open(path, encoding="utf-8", newline="") as f:
            for row in csv.DictReader(f):
                key = (row["month"], row["skill"], row["location"])
                for field, counter in sums.items():
                    counter[key] += int(row.get(field) or 0)
    totals = sums["total_ads"]
    rows = [
        {"month": month, "category": CATEGORY_OF[skill], "skill": skill, "location": location,
         **{field: counter[key] for field, counter in sums.items()}}
        for key in totals
        for (month, skill, location) in [key]
        if skill in CATEGORY_OF
    ]
    # Keep months from an earlier run that this run didn't cover, so re-running a
    # few files doesn't wipe the rest of the archive.
    new_months = {r["month"] for r in rows}
    if os.path.exists(args.out):
        with open(args.out, encoding="utf-8", newline="") as f:
            kept = [r for r in csv.DictReader(f) if r["month"] not in new_months and r["skill"] in CATEGORY_OF and valid_month(r["month"])]
    rows.extend(kept)
    write_rows(args.out, rows)
    months = sorted({r["month"] for r in rows})
    print(f"Wrote {len(rows)} rows covering {months[0] if months else '-'} to {months[-1] if months else '-'} to {args.out}")


def cmd_merge_titles(args):
    """Same as merge, for the job-title partials. Counts for a month found in two files
    are summed; months already in the output that no partial covers are kept."""
    ads = Counter()
    month_totals = Counter()
    seen_month_file = set()
    for path in args.partials:
        with open(path, encoding="utf-8", newline="") as f:
            for row in csv.DictReader(f):
                ads[(row["month"], row["title"])] += int(row.get("it_ads") or 0)
                # it_total_ads repeats on every title row; add it once per month per file
                if (path, row["month"]) not in seen_month_file:
                    seen_month_file.add((path, row["month"]))
                    month_totals[row["month"]] += int(row.get("it_total_ads") or 0)
    rows = [
        {"month": month, "title": title, "it_ads": ads.get((month, title), 0), "it_total_ads": month_totals[month]}
        for month in month_totals for title in FAMILY_NAMES
    ]
    if os.path.exists(args.out):
        with open(args.out, encoding="utf-8", newline="") as f:
            rows.extend(r for r in csv.DictReader(f)
                        if r["month"] not in month_totals and r["title"] in FAMILY_NAMES and valid_month(r["month"]))
    write_title_rows(args.out, rows)
    months = sorted({r["month"] for r in rows})
    print(f"Wrote {len(rows)} job-title rows covering {months[0] if months else '-'} to {months[-1] if months else '-'} to {args.out}")


def cmd_merge_topics(args):
    """Same as merge, for the hot-topic partials: counts for a month found in two files
    are summed; months already in the output that no partial covers are kept."""
    ads = Counter()
    month_totals = Counter()   # (month, location) -> Data/IT ads
    seen = set()
    for path in args.partials:
        with open(path, encoding="utf-8", newline="") as f:
            for row in csv.DictReader(f):
                ads[(row["month"], row["topic"], row["location"])] += int(row.get("it_ads") or 0)
                # it_total_ads repeats on every topic row; add it once per month, location and file
                key = (path, row["month"], row["location"])
                if key not in seen:
                    seen.add(key)
                    month_totals[(row["month"], row["location"])] += int(row.get("it_total_ads") or 0)
    rows = [
        {"month": month, "topic": topic, "location": location,
         "it_ads": ads.get((month, topic, location), 0), "it_total_ads": total}
        for (month, location), total in month_totals.items()
        for topic in hot_topics.TOPIC_NAMES
    ]
    new_months = {month for month, _ in month_totals}
    if os.path.exists(args.out):
        with open(args.out, encoding="utf-8", newline="") as f:
            rows.extend(r for r in csv.DictReader(f)
                        if r["month"] not in new_months and r["topic"] in hot_topics.TOPIC_NAMES
                        and r["location"] in LOCATIONS and valid_month(r["month"]))
    write_topic_rows(args.out, rows)
    months = sorted({r["month"] for r in rows})
    print(f"Wrote {len(rows)} hot-topic rows covering {months[0] if months else '-'} to {months[-1] if months else '-'} to {args.out}")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)

    count = sub.add_parser("count", help="Count one Historical Ads file")
    count.add_argument("name", help='File name without extension, e.g. "2015" or "2026-Q1"')
    count.add_argument("--out", required=True)
    count.add_argument("--zip", help="Use an already downloaded .jsonl.zip instead of downloading")
    count.add_argument("--titles-out", help="Where to write the job-title counts (default: titles/<out name> next to --out)")
    count.add_argument("--topics-out", help="Where to write the hot-topic counts (default: topics/<out name> next to --out)")
    count.set_defaults(func=cmd_count)

    merge = sub.add_parser("merge", help="Merge partial CSVs into one file")
    merge.add_argument("partials", nargs="+")
    merge.add_argument("--out", required=True)
    merge.set_defaults(func=cmd_merge)

    merge_titles = sub.add_parser("merge-titles", help="Merge job-title partial CSVs into one file")
    merge_titles.add_argument("partials", nargs="+")
    merge_titles.add_argument("--out", required=True)
    merge_titles.set_defaults(func=cmd_merge_titles)

    merge_topics = sub.add_parser("merge-topics", help="Merge hot-topic partial CSVs into one file")
    merge_topics.add_argument("partials", nargs="+")
    merge_topics.add_argument("--out", required=True)
    merge_topics.set_defaults(func=cmd_merge_topics)

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
