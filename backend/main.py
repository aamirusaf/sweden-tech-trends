import json
import os
import re
import time
from datetime import datetime
import requests

# Base endpoint for the official JobTech Dev / Arbetsförmedlingen search engine
API_URL = "https://jobsearch.api.jobtechdev.se/search"

# Target technology segments to query against Swedish active postings
TECH_STACKS = {
    "Languages": ["JavaScript", "TypeScript", "Python", "Java", "C#", "Go", "Rust"],
    "Cloud & Infra": ["AWS", "Azure", "Docker", "Kubernetes", "Terraform"],
    "Data & AI": ["PostgreSQL", "SQL", "Apache Kafka", "PyTorch", "TensorFlow"]
}

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


def build_skill_matcher(skill_name):
    # Alphanumeric names ("Python", "SQL") get word-boundary matching so "SQL" doesn't
    # false-positive inside "PostgreSQL". Names with symbols ("C#") fall back to a plain
    # case-insensitive substring search since \b doesn't apply cleanly around "#".
    if re.fullmatch(r"[A-Za-z0-9]+", skill_name):
        pattern = r"\b" + re.escape(skill_name) + r"\b"
    else:
        pattern = re.escape(skill_name)
    return re.compile(pattern, re.IGNORECASE)


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

# How many dated snapshots to keep in history.json before dropping the oldest
MAX_HISTORY_SNAPSHOTS = 52

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
        "last_updated": datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S UTC"),
        "data": {}
    }
    postings_by_skill = {}
    co_occurrence_counts = {skill: {} for skill in ALL_SKILLS}
    co_occurrence_samples = {skill: 0 for skill in ALL_SKILLS}
    remote_mention_counts = {skill: {"remote_or_hybrid": 0, "sampled": 0} for skill in ALL_SKILLS}

    print("🚀 Fetching live technology metrics from Arbetsförmedlingen API...")

    # Iterate through categories and request metrics
    for category, skills in TECH_STACKS.items():
        results["data"][category] = []

        for skill in skills:
            by_location = {}
            postings_by_location = {}

            for location, municipality_id in LOCATIONS.items():
                # Query parameter 'q' handles free text matching over titles and descriptions.
                # limit>0 still returns the full match count in `total`, plus that many sample ads.
                # The nationwide ("Sweden") query pulls a bigger sample since it also feeds the
                # skill co-occurrence scan below; city queries only need enough for the postings list.
                sample_size = CO_OCCURRENCE_SAMPLE_SIZE if location == "Sweden" else POSTINGS_PER_SKILL
                params = {"q": skill, "limit": sample_size}
                if municipality_id:
                    params["municipality"] = municipality_id

                try:
                    response = requests.get(API_URL, params=params, headers={"accept": "application/json"}, timeout=10)

                    if response.status_code == 200:
                        data = response.json()
                        # Extract the total hits found on the live platform
                        total_ads = data.get("total", {}).get("value", 0)
                        hits = data.get("hits", [])

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
                    else:
                        print(f"⚠️ Failed fetching data for {skill} ({location}). HTTP Status: {response.status_code}")

                except Exception as e:
                    print(f"❌ Error communicating with API for {skill} ({location}): {e}")

                # Simple rate limiting window compliance
                time.sleep(0.2)

            results["data"][category].append({
                "name": skill,
                "value": by_location.get("Sweden", 0),
                "by_location": by_location
            })
            postings_by_skill[skill] = postings_by_location

    co_occurrence = summarize_co_occurrence(co_occurrence_counts, co_occurrence_samples)
    remote_work = summarize_remote_work(remote_mention_counts)

    # Persist the dynamic calculations to the data layer directory
    script_dir = os.path.dirname(os.path.abspath(__file__))
    data_dir = os.path.join(script_dir, "data")
    trends_path = os.path.join(data_dir, "tech_trends.json")
    postings_path = os.path.join(data_dir, "job_postings.json")
    history_path = os.path.join(data_dir, "history.json")
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
        update_history(history_path, results["data"])
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

    today = datetime.utcnow().strftime("%Y-%m-%d")
    snapshots = [s for s in history.get("snapshots", []) if s.get("date") != today]
    snapshots.append({"date": today, "data": current_data})
    snapshots.sort(key=lambda s: s["date"])

    history["snapshots"] = snapshots[-MAX_HISTORY_SNAPSHOTS:]

    with open(history_path, "w", encoding="utf-8") as f:
        json.dump(history, f, indent=4, ensure_ascii=False)

if __name__ == "__main__":
    fetch_skill_demand()
