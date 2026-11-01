import csv
import json
import os
import re
import sys
import time
from datetime import datetime, timezone
import requests

# Base endpoint for the official JobTech Dev / Arbetsförmedlingen search engine
API_URL = "https://jobsearch.api.jobtechdev.se/search"

# The 20 technologies the dashboard tracks. Chosen from the data, not by hand: they are
# the 20 concrete tools mentioned most often in Data/IT job ads, both in the live ads
# and in every IT ad published in 2025 (see backend/discover_skills.py, which can be
# re-run to check whether the list still holds). Broad themes such as "AI", "agile" or
# "cybersecurity" rank high too but aren't tools, so they're left out on purpose.
TECH_STACKS = {
    "Languages": ["Python", "Java", "C#", "C++", "C", "JavaScript", "TypeScript"],
    "Cloud & Infra": ["Azure", "AWS", "GCP", "Kubernetes", "Docker", "Terraform", "Linux", "Git"],
    "Platforms & Data": ["SQL", ".NET", "React", "Microsoft 365", "Active Directory"]
}

# What to send the JobSearch API's free-text query (q) for each skill, when the display
# name alone would match the wrong ads or miss common spellings. Each entry is searched
# on its own and the matching ads are combined by id, because q's handling of several
# words or phrases in one query isn't a reliable "any of these".
API_QUERIES = {
    "C": ['"C-programmering"', '"programmering i C"', '"C/C++"', '"embedded C"', '"ANSI C"'],
    "GCP": ["GCP", '"Google Cloud"'],
    "Microsoft 365": ['"Microsoft 365"', '"Office 365"', "M365", "O365"],
    "Active Directory": ['"Active Directory"', '"Entra ID"', '"Azure AD"'],
}

# JobSearch returns at most offset 2000 + limit 100 hits for one query.
MAX_PAGED_HITS = 2100

# How many sample postings to keep per skill/location for the "click a skill to see openings" panel
POSTINGS_PER_SKILL = 6

# How many nationwide postings per skill to scan for co-occurring skills. Larger than
# POSTINGS_PER_SKILL because this only feeds aggregate counts, not a list a user reads.
CO_OCCURRENCE_SAMPLE_SIZE = 20

# How many co-occurring skills to keep per skill, and the minimum sample count to
# bother reporting (avoids noise like "1 posting out of 20 mentioned X").
CO_OCCURRENCE_TOP_N = 5
CO_OCCURRENCE_MIN_COUNT = 2

ALL_SKILLS = [skill for skills in TECH_STACKS.values() for skill in skills]


def get_with_retries(params, attempts=3):
    """GET the search API, retrying transient failures (network errors, 429, 5xx)
    with a short backoff so one blip doesn't fail a whole scheduled run."""
    for attempt in range(1, attempts + 1):
        try:
            response = requests.get(API_URL, params=params, headers={"accept": "application/json"}, timeout=10)
            if response.status_code != 429 and response.status_code < 500:
                return response
            if attempt == attempts:
                return response
        except requests.RequestException:
            if attempt == attempts:
                raise
        time.sleep(2 * attempt)


# How each skill is recognised in ad text. Shared by this script (co-occurrence) and
# backfill_historical.py (the 20-year history), so both count a skill the same way.
# Skills not listed use a case-insensitive whole-word match on their name.
SKILL_PATTERNS = {
    "Java": (r"\bjava\b(?!\s*script)", re.IGNORECASE),
    "JavaScript": (r"\bjavascript\b|(?<![.\w])JS\b", re.IGNORECASE),
    "C#": (r"(?<![\w])C#|\bC sharp\b", re.IGNORECASE),
    "C++": (r"(?<![\w])C\+\+", re.IGNORECASE),
    # A capital "C" next to a comma, slash, bracket or "och/and/or/eller", as in
    # "C, C++ och Python" or "C/C++". Driving-licence lists ("B, C, CE") look the same,
    # so the ad must also talk about programming (see CONTEXT_REQUIRED below).
    "C": (r"(?<![\w#+./-])C(?![\w#+-])(?=\s*[,/&)]|\s+(?:och|and|or|eller)\b)|(?<=[,/(]\s)C(?![\w#+-])|(?<=[,/(])C(?![\w#+-])", 0),
    "GCP": (r"\bGCP\b|\bgoogle cloud\b", re.IGNORECASE),
    "AWS": (r"\baws\b|\bamazon web services\b", re.IGNORECASE),
    "Kubernetes": (r"\bkubernetes\b|\bk8s\b", re.IGNORECASE),
    "Git": (r"\bgit(?:hub|lab)?\b", re.IGNORECASE),
    ".NET": (r"(?<![\w])\.NET\b|\bdotnet\b", re.IGNORECASE),
    # Case-sensitive: "react" is also an everyday English verb.
    "React": (r"\bReact(?:\.js|JS)?\b", 0),
    "Microsoft 365": (r"\b(?:microsoft|office)\s?365\b|\b[MO]365\b", re.IGNORECASE),
    "Active Directory": (r"\bactive directory\b|\bentra id\b|\bmicrosoft entra\b|\bazure ad\b", re.IGNORECASE),
}

PROGRAMMING_CONTEXT = re.compile(
    r"programmer|programming|utvecklare|developer|mjukvara|software|embedded|inbyggda|firmware|C\+\+",
    re.IGNORECASE,
)
CONTEXT_REQUIRED = {"C": PROGRAMMING_CONTEXT}


class SkillMatcher:
    def __init__(self, pattern, flags, context=None):
        self.pattern = re.compile(pattern, flags)
        self.context = context

    def search(self, text):
        match = self.pattern.search(text)
        if match and self.context is not None and not self.context.search(text):
            return None
        return match


class ApiError(Exception):
    pass


def search(params):
    response = get_with_retries(params)
    if response.status_code != 200:
        raise ApiError(f"HTTP {response.status_code}")
    return response.json()


def search_skill(skill, municipality_id, sample_size):
    """Return (number of matching ads, up to sample_size of them, newest first)."""
    base = {"municipality": municipality_id} if municipality_id else {}
    queries = API_QUERIES.get(skill)
    if not queries:
        data = search({"q": skill, "limit": sample_size, **base})
        return data.get("total", {}).get("value", 0), data.get("hits", [])

    ads = {}
    for query in queries:
        offset, total = 0, None
        while total is None or (offset < total and offset < MAX_PAGED_HITS):
            data = search({"q": query, "limit": 100, "offset": offset, **base})
            total = data.get("total", {}).get("value", 0)
            if total > MAX_PAGED_HITS and offset == 0:
                print(f"⚠️ {skill}: {query} has {total} ads, only the first {MAX_PAGED_HITS} are combined")
            hits = data.get("hits", [])
            for hit in hits:
                ads[hit.get("id")] = hit
            if not hits:
                break
            offset += 100
            time.sleep(0.2)
        print(f"   {skill}: q={query} -> {total}")
    newest = sorted(ads.values(), key=lambda hit: hit.get("publication_date") or "", reverse=True)
    return len(ads), newest[:sample_size]


def build_skill_matcher(skill_name):
    if skill_name in SKILL_PATTERNS:
        pattern, flags = SKILL_PATTERNS[skill_name]
    else:
        pattern, flags = r"\b" + re.escape(skill_name) + r"\b", re.IGNORECASE
    return SkillMatcher(pattern, flags, CONTEXT_REQUIRED.get(skill_name))


SKILL_MATCHERS = {skill: build_skill_matcher(skill) for skill in ALL_SKILLS}

# The structured "work-place-model" field on postings is effectively always "on-site"
# regardless of actual policy (checked across hundreds of postings in unrelated job
# categories) — employers don't seem to fill it in accurately. Fall back to scanning
# the description text for remote/hybrid language instead. This is a heuristic, not a
# precise measure (e.g. "no remote work available" would still match), so it's reported
# to the frontend as "mentions remote/hybrid", not "is remote".
REMOTE_HYBRID_PATTERN = re.compile(
    r"\b(remote|distans(?:arbete)?|hemifr[åa]n|hybrid(?:arbete)?|work[\s-]from[\s-]home)\b",
    re.IGNORECASE
)

# Don't report a remote-work percentage from a handful of postings
MIN_SAMPLE_FOR_REMOTE_BADGE = 3

# How many dated snapshots to keep in history.json before dropping the oldest.
# history.json is only the recent window the dashboard reads; the full long-term
# record is history.csv, which is never trimmed.
MAX_HISTORY_SNAPSHOTS = 52

HISTORY_CSV_FIELDS = ["date", "category", "skill", "location", "postings"]

# Locations to break demand down by, mapped to JobTech taxonomy municipality concept IDs.
# "Sweden" (None) means no municipality filter, i.e. the nationwide total.
LOCATIONS = {
    "Sweden": None,
    "Stockholm": "AvNB_uwa_6n6",
    "Göteborg": "PVZL_BQT_XtL",
    "Malmö": "oYPt_yRA_Smm",
}

def fetch_skill_demand():
    results = {
        "last_updated": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC"),
        "data": {}
    }
    postings_by_skill = {}
    co_occurrence_counts = {skill: {} for skill in ALL_SKILLS}
    co_occurrence_samples = {skill: 0 for skill in ALL_SKILLS}
    remote_mention_counts = {skill: {"remote_or_hybrid": 0, "sampled": 0} for skill in ALL_SKILLS}

    failures = []

    print("🚀 Fetching live technology metrics from Arbetsförmedlingen API...")

    # Iterate through categories and request metrics
    for category, skills in TECH_STACKS.items():
        results["data"][category] = []

        for skill in skills:
            by_location = {}
            postings_by_location = {}

            for location, municipality_id in LOCATIONS.items():
                # The free-text query (q) matches titles and descriptions; see search_skill.
                # limit>0 still returns the full match count in `total`, plus that many sample ads.
                # The nationwide ("Sweden") query pulls a bigger sample since it also feeds the
                # skill co-occurrence scan below; city queries only need enough for the postings list.
                sample_size = CO_OCCURRENCE_SAMPLE_SIZE if location == "Sweden" else POSTINGS_PER_SKILL
                try:
                    total_ads, hits = search_skill(skill, municipality_id, sample_size)
                    by_location[location] = total_ads
                    postings_by_location[location] = [
                        {
                            "headline": hit.get("headline"),
                            "employer": (hit.get("employer") or {}).get("name"),
                            "location": (hit.get("workplace_address") or {}).get("municipality")
                                or (hit.get("workplace_address") or {}).get("region")
                                or "Sweden",
                            "url": hit.get("webpage_url"),
                            "published": (hit.get("publication_date") or "")[:10]
                        }
                        for hit in hits[:POSTINGS_PER_SKILL]
                    ]

                    if location == "Sweden":
                        analyze_nationwide_sample(
                            skill, hits, co_occurrence_counts, co_occurrence_samples, remote_mention_counts
                        )

                    print(f"✅ {skill} ({location}): found {total_ads} job posts.")

                except ApiError as e:
                    print(f"⚠️ Failed fetching data for {skill} ({location}). {e}")
                    failures.append(f"{skill} ({location})")
                except Exception as e:
                    print(f"❌ Error communicating with API for {skill} ({location}): {e}")
                    failures.append(f"{skill} ({location})")

                # Simple rate limiting window compliance
                time.sleep(0.2)

            results["data"][category].append({
                "name": skill,
                "value": by_location.get("Sweden", 0),
                "by_location": by_location
            })
            postings_by_skill[skill] = postings_by_location

    # A failed request would otherwise be recorded as 0 postings, and that 0 would land in
    # history.json and skew the trend badges. Keep the previous data files instead and exit
    # non-zero so a scheduled run shows up as failed rather than committing bad numbers.
    if failures:
        print(f"\n❌ {len(failures)} request(s) failed, not writing data files: {', '.join(failures)}")
        sys.exit(1)

    co_occurrence = summarize_co_occurrence(co_occurrence_counts, co_occurrence_samples)
    remote_work = summarize_remote_work(remote_mention_counts)

    # Persist the dynamic calculations to the data layer directory
    script_dir = os.path.dirname(os.path.abspath(__file__))
    data_dir = os.path.join(script_dir, "data")
    trends_path = os.path.join(data_dir, "tech_trends.json")
    postings_path = os.path.join(data_dir, "job_postings.json")
    history_path = os.path.join(data_dir, "history.json")
    history_csv_path = os.path.join(data_dir, "history.csv")
    co_occurrence_path = os.path.join(data_dir, "co_occurrence.json")

    try:
        with open(trends_path, "w", encoding="utf-8") as f:
            json.dump(results, f, indent=4, ensure_ascii=False)
        with open(postings_path, "w", encoding="utf-8") as f:
            json.dump(
                {"last_updated": results["last_updated"], "postings": postings_by_skill},
                f, indent=4, ensure_ascii=False
            )
        with open(co_occurrence_path, "w", encoding="utf-8") as f:
            json.dump(
                {
                    "last_updated": results["last_updated"],
                    "co_occurrence": co_occurrence,
                    "remote_work": remote_work
                },
                f, indent=4, ensure_ascii=False
            )
        # Seed the CSV archive from history.json the first time, before history.json
        # gets today's snapshot (and before it can drop old ones past its cap).
        if not os.path.exists(history_csv_path):
            seed_history_csv(history_csv_path, history_path)
        update_history(history_path, results["data"])
        append_history_csv(history_csv_path, today_utc(), results["data"])
        print(f"\n🎉 Successfully compiled metrics files saved to: {data_dir}")
    except FileNotFoundError:
        print("❌ Error: Directory 'backend/data/' does not exist. Run setup structure command first.")


def analyze_nationwide_sample(skill, hits, co_occurrence_counts, co_occurrence_samples, remote_mention_counts):
    """Scan a skill's nationwide sample postings once for both co-occurring skills
    and remote/hybrid language, since both read the same description text."""
    for hit in hits:
        text = (hit.get("description") or {}).get("text") or hit.get("headline") or ""

        mentioned = {name for name, matcher in SKILL_MATCHERS.items() if matcher.search(text)}
        if skill in mentioned:
            co_occurrence_samples[skill] += 1
            for other in mentioned - {skill}:
                co_occurrence_counts[skill][other] = co_occurrence_counts[skill].get(other, 0) + 1

        remote_mention_counts[skill]["sampled"] += 1
        if REMOTE_HYBRID_PATTERN.search(text):
            remote_mention_counts[skill]["remote_or_hybrid"] += 1


def summarize_co_occurrence(co_occurrence_counts, co_occurrence_samples):
    """Turn raw co-mention counts into a top-N list per skill, with a % of that
    skill's own sample so the frontend can show e.g. 'AWS · 40%'."""
    summary = {}
    for skill, counts in co_occurrence_counts.items():
        sample_size = co_occurrence_samples[skill]
        if not sample_size:
            continue

        ranked = sorted(counts.items(), key=lambda pair: pair[1], reverse=True)
        top = [
            {"name": name, "count": count, "percent": round(count / sample_size * 100)}
            for name, count in ranked
            if count >= CO_OCCURRENCE_MIN_COUNT
        ][:CO_OCCURRENCE_TOP_N]

        if top:
            summary[skill] = top

    return summary


def summarize_remote_work(remote_mention_counts):
    """Turn remote/hybrid keyword-mention tallies into a % per skill."""
    summary = {}
    for skill, counts in remote_mention_counts.items():
        sample_size = counts["sampled"]
        if sample_size < MIN_SAMPLE_FOR_REMOTE_BADGE:
            continue

        summary[skill] = {
            "percent": round(counts["remote_or_hybrid"] / sample_size * 100),
            "sample_size": sample_size
        }

    return summary


def update_history(history_path, current_data):
    """Append today's snapshot to history.json, replacing any snapshot already
    recorded for today so re-running the script the same day doesn't duplicate it."""
    try:
        with open(history_path, "r", encoding="utf-8") as f:
            history = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        history = {"snapshots": []}

    today = today_utc()
    snapshots = [s for s in history.get("snapshots", []) if s.get("date") != today]
    snapshots.append({"date": today, "data": current_data})
    snapshots.sort(key=lambda s: s["date"])

    history["snapshots"] = snapshots[-MAX_HISTORY_SNAPSHOTS:]

    with open(history_path, "w", encoding="utf-8") as f:
        json.dump(history, f, indent=4, ensure_ascii=False)

def today_utc():
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


def snapshot_to_rows(date, data):
    """Flatten one snapshot ({category: [{name, by_location}]}) into long-format CSV rows."""
    rows = []
    for category, skills in data.items():
        for skill in skills:
            for location, postings in (skill.get("by_location") or {}).items():
                rows.append({
                    "date": date,
                    "category": category,
                    "skill": skill["name"],
                    "location": location,
                    "postings": postings,
                })
    return rows


def append_history_csv(csv_path, date, data):
    """Add one dated snapshot to history.csv, the permanent long-term record.

    Rows for the same date are replaced, so re-running the script on the same day
    doesn't duplicate them. Unlike history.json, nothing is ever trimmed. Rows stay
    sorted by date, with each date's rows in a stable order, so git diffs only show
    the newly added week."""
    write_history_csv(csv_path, read_history_csv(csv_path), {date: snapshot_to_rows(date, data)})


def seed_history_csv(csv_path, history_path):
    """Create history.csv from every snapshot already in history.json."""
    try:
        with open(history_path, "r", encoding="utf-8") as f:
            snapshots = json.load(f).get("snapshots", [])
    except (FileNotFoundError, json.JSONDecodeError):
        snapshots = []
    new_rows = {s["date"]: snapshot_to_rows(s["date"], s["data"]) for s in snapshots}
    write_history_csv(csv_path, read_history_csv(csv_path), new_rows)


def read_history_csv(csv_path):
    try:
        with open(csv_path, "r", encoding="utf-8", newline="") as f:
            return list(csv.DictReader(f))
    except FileNotFoundError:
        return []


def write_history_csv(csv_path, existing_rows, new_rows_by_date):
    rows = [r for r in existing_rows if r["date"] not in new_rows_by_date]
    for date_rows in new_rows_by_date.values():
        rows.extend(date_rows)
    rows.sort(key=lambda r: r["date"])  # stable sort keeps each date's row order

    with open(csv_path, "w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=HISTORY_CSV_FIELDS, lineterminator="\n")
        writer.writeheader()
        writer.writerows(rows)


if __name__ == "__main__":
    fetch_skill_demand()
