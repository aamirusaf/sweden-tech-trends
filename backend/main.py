import csv
import json
import os
import re
import sys
import time
from datetime import datetime, timezone
import requests

from skill_network import build_skill_network
from job_titles import build_title_stats, classify_title, FAMILY_NAMES, TITLE_FAMILIES
from ad_skills import build_ad_skills, regex_source

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

# The Data/IT occupation field in Arbetsförmedlingen's taxonomy. The dashboard shows
# each skill as a share of the ads in this field, i.e. of tech jobs, not of all jobs.
DATA_IT_FIELD = "apaJ_2ja_LuF"

# JobSearch returns at most offset 2000 + limit 100 hits for one query.
MAX_PAGED_HITS = 2100

# How many sample postings to keep per skill/location for the "click a skill to see openings" panel
POSTINGS_PER_SKILL = 6

# How many co-occurring skills to list per skill in the job postings panel, and the
# minimum number of shared ads to bother listing one.
CO_OCCURRENCE_TOP_N = 5
CO_OCCURRENCE_MIN_COUNT = 2

# Sort orders used to page through every live Data/IT ad. One query can reach at most
# MAX_PAGED_HITS ads, so newest-first plus oldest-first covers up to twice that.
FULL_SCAN_SORTS = ["pubdate-desc", "pubdate-asc"]

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


def search_skill(skill, municipality_id, sample_size, it_only=False):
    """Return (number of matching ads, up to sample_size of them, newest first).
    it_only limits the search to ads in the Data/IT occupation field."""
    base = {"municipality": municipality_id} if municipality_id else {}
    if it_only:
        base["occupation-field"] = DATA_IT_FIELD
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

# postings: ads mentioning the skill, all job categories. it_postings / it_total: ads in
# the Data/IT field mentioning it, and all Data/IT ads (empty before 2026-11-02).
HISTORY_CSV_FIELDS = ["date", "category", "skill", "location", "postings", "it_postings", "it_total"]

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
    failures = []

    print("🚀 Fetching live technology metrics from Arbetsförmedlingen API...")

    # Total number of live Data/IT ads per location: the denominator for each skill's share.
    it_totals = {}
    for location, municipality_id in LOCATIONS.items():
        params = {"occupation-field": DATA_IT_FIELD, "limit": 0}
        if municipality_id:
            params["municipality"] = municipality_id
        try:
            it_totals[location] = search(params).get("total", {}).get("value", 0)
            print(f"📊 Data/IT ads ({location}): {it_totals[location]}")
        except (ApiError, requests.RequestException) as e:
            print(f"⚠️ Failed fetching the Data/IT total ({location}). {e}")
            failures.append(f"Data/IT total ({location})")
    results["it_totals"] = it_totals

    # Iterate through categories and request metrics
    for category, skills in TECH_STACKS.items():
        results["data"][category] = []

        for skill in skills:
            by_location = {}
            it_by_location = {}
            postings_by_location = {}

            for location, municipality_id in LOCATIONS.items():
                # The free-text query (q) matches titles and descriptions; see search_skill.
                # Two counts per skill: within Data/IT ads (what the dashboard shows, and
                # where the sample postings come from) and across all ads (kept in
                # history.csv so the long-term archive continues the earlier measure).
                try:
                    it_ads, hits = search_skill(skill, municipality_id, POSTINGS_PER_SKILL, it_only=True)
                    total_ads, _ = search_skill(skill, municipality_id, 0)
                    it_by_location[location] = it_ads
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

                    print(f"✅ {skill} ({location}): {it_ads} Data/IT ads, {total_ads} ads in all.")

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
                "by_location": by_location,
                "it_value": it_by_location.get("Sweden", 0),
                "it_by_location": it_by_location
            })
            postings_by_skill[skill] = postings_by_location

    # Which skills appear together, and how often remote work comes up, read from every
    # live Data/IT ad rather than a per-skill sample.
    try:
        all_it_ads = fetch_all_it_ads()
    except (ApiError, requests.RequestException) as e:
        print(f"⚠️ Failed fetching all Data/IT ads for the skill network. {e}")
        failures.append("all Data/IT ads")
        all_it_ads = []

    # A failed request would otherwise be recorded as 0 postings, and that 0 would land in
    # history.json and skew the trend badges. Keep the previous data files instead and exit
    # non-zero so a scheduled run shows up as failed rather than committing bad numbers.
    if failures:
        print(f"\n❌ {len(failures)} request(s) failed, not writing data files: {', '.join(failures)}")
        sys.exit(1)

    ad_skill_sets, remote_flags = scan_ads(all_it_ads)
    network, co_occurrence = build_skill_network(
        ad_skill_sets, ALL_SKILLS, CO_OCCURRENCE_TOP_N, CO_OCCURRENCE_MIN_COUNT
    )
    network["last_updated"] = results["last_updated"]
    network["categories"] = TECH_STACKS
    remote_work = summarize_remote_work(ad_skill_sets, remote_flags)
    # What employers call these jobs: each ad's headline grouped into a title family,
    # with the share of each family's ads that mention each tracked skill.
    job_titles = build_title_stats(
        [(ad.get("headline"), skills) for ad, skills in zip(all_it_ads, ad_skill_sets)], ALL_SKILLS
    )
    job_titles["last_updated"] = results["last_updated"]
    # Per-ad skill flags for the in-browser CV check (no ad text, see ad_skills.py).
    ad_skills = build_ad_skills(
        [
            {
                "skills": skills,
                "headline": ad.get("headline"),
                "municipality_id": (ad.get("workplace_address") or {}).get("municipality_concept_id"),
                "experience_required": ad.get("experience_required"),
                "id": ad.get("id"),
                "url": ad.get("webpage_url"),
                "employer": (ad.get("employer") or {}).get("name"),
                "place": (ad.get("workplace_address") or {}).get("municipality")
                    or (ad.get("workplace_address") or {}).get("region"),
                "published": ad.get("publication_date"),
            }
            for ad, skills in zip(all_it_ads, ad_skill_sets)
        ],
        ALL_SKILLS, FAMILY_NAMES, classify_title, LOCATIONS,
    )
    ad_skills["last_updated"] = results["last_updated"]
    ad_skills["skill_patterns"] = skill_patterns_for_browser()
    ad_skills["title_patterns"] = [
        {"title": name, **regex_source(pattern, re.IGNORECASE)} for name, pattern, _ in TITLE_FAMILIES
    ]

    # Persist the dynamic calculations to the data layer directory
    script_dir = os.path.dirname(os.path.abspath(__file__))
    data_dir = os.path.join(script_dir, "data")
    trends_path = os.path.join(data_dir, "tech_trends.json")
    postings_path = os.path.join(data_dir, "job_postings.json")
    history_path = os.path.join(data_dir, "history.json")
    history_csv_path = os.path.join(data_dir, "history.csv")
    co_occurrence_path = os.path.join(data_dir, "co_occurrence.json")
    network_path = os.path.join(data_dir, "skill_network.json")
    job_titles_path = os.path.join(data_dir, "job_titles.json")
    ad_skills_path = os.path.join(data_dir, "ad_skills.json")

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
        with open(network_path, "w", encoding="utf-8") as f:
            json.dump(network, f, indent=4, ensure_ascii=False)
        with open(job_titles_path, "w", encoding="utf-8") as f:
            json.dump(job_titles, f, indent=4, ensure_ascii=False)
        write_ad_skills(ad_skills_path, ad_skills)
        # Seed the CSV archive from history.json the first time, before history.json
        # gets today's snapshot (and before it can drop old ones past its cap).
        if not os.path.exists(history_csv_path):
            seed_history_csv(history_csv_path, history_path)
        update_history(history_path, results["data"], results["it_totals"])
        append_history_csv(history_csv_path, today_utc(), results["data"], results["it_totals"])
        print(f"\n🎉 Successfully compiled metrics files saved to: {data_dir}")
    except FileNotFoundError:
        print("❌ Error: Directory 'backend/data/' does not exist. Run setup structure command first.")


def skill_patterns_for_browser():
    """SKILL_PATTERNS (plus the whole-word default and the context rules) as
    JavaScript regexes, so the CV check finds skills the same way as this script."""
    patterns = {}
    for skill, matcher in SKILL_MATCHERS.items():
        entry = regex_source(matcher.pattern.pattern, matcher.pattern.flags)
        if matcher.context is not None:
            entry["context"] = regex_source(matcher.context.pattern, matcher.context.flags)
        patterns[skill] = entry
    return patterns


def write_ad_skills(path, ad_skills):
    """Like json.dump with indent, but one ad per line: 2,500 short rows would
    otherwise take 7 lines each."""
    row_keys = ["ads", "listings"]
    head = {key: value for key, value in ad_skills.items() if key not in row_keys}
    text = json.dumps(head, indent=4, ensure_ascii=False)[:-2]
    for key in row_keys:
        rows = ad_skills.get(key, [])
        body = ",\n".join(
            "        " + json.dumps(row, separators=(",", ":"), ensure_ascii=False) for row in rows
        )
        text += f',\n    "{key}": [\n' + body + ("\n" if rows else "") + "    ]"
    with open(path, "w", encoding="utf-8") as f:
        f.write(text + "\n}\n")


def fetch_all_it_ads():
    """Every live ad in the Data/IT field, deduplicated by id.

    JobSearch pages stop at MAX_PAGED_HITS per query, so read newest-first and then
    oldest-first; together they cover up to twice that many ads."""
    ads, total = {}, 0
    for sort in FULL_SCAN_SORTS:
        offset = 0
        while offset < MAX_PAGED_HITS:
            data = search({
                "occupation-field": DATA_IT_FIELD, "sort": sort, "limit": 100, "offset": offset
            })
            total = data.get("total", {}).get("value", 0)
            hits = data.get("hits", [])
            for hit in hits:
                ads[hit.get("id")] = hit
            if not hits or offset + 100 >= total:
                break
            offset += 100
            time.sleep(0.2)
        if len(ads) >= total:
            break
    print(f"🔗 Scanned {len(ads)} of {total} live Data/IT ads for skill connections")
    if len(ads) < total:
        print(f"⚠️ {total - len(ads)} Data/IT ads were out of reach of paging and are left out")
    return list(ads.values())


def scan_ads(ads):
    """Return, per ad, the set of tracked skills it mentions and whether it mentions
    remote/hybrid work."""
    skill_sets, remote_flags = [], []
    for ad in ads:
        text = " ".join(filter(None, [
            ad.get("headline"), (ad.get("description") or {}).get("text")
        ]))
        skill_sets.append({name for name, matcher in SKILL_MATCHERS.items() if matcher.search(text)})
        remote_flags.append(bool(REMOTE_HYBRID_PATTERN.search(text)))
    return skill_sets, remote_flags


def summarize_remote_work(ad_skill_sets, remote_flags):
    """% of each skill's Data/IT ads that mention remote/hybrid work."""
    summary = {}
    for skill in ALL_SKILLS:
        flags = [remote for skills, remote in zip(ad_skill_sets, remote_flags) if skill in skills]
        if len(flags) < MIN_SAMPLE_FOR_REMOTE_BADGE:
            continue
        summary[skill] = {
            "percent": round(100 * sum(flags) / len(flags)),
            "sample_size": len(flags)
        }
    return summary


def update_history(history_path, current_data, it_totals=None):
    """Append today's snapshot to history.json, replacing any snapshot already
    recorded for today so re-running the script the same day doesn't duplicate it."""
    try:
        with open(history_path, "r", encoding="utf-8") as f:
            history = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        history = {"snapshots": []}

    today = today_utc()
    snapshots = [s for s in history.get("snapshots", []) if s.get("date") != today]
    snapshots.append({"date": today, "data": current_data, "it_totals": it_totals or {}})
    snapshots.sort(key=lambda s: s["date"])

    history["snapshots"] = snapshots[-MAX_HISTORY_SNAPSHOTS:]

    with open(history_path, "w", encoding="utf-8") as f:
        json.dump(history, f, indent=4, ensure_ascii=False)

def today_utc():
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


def snapshot_to_rows(date, data, it_totals=None):
    """Flatten one snapshot ({category: [{name, by_location}]}) into long-format CSV rows."""
    it_totals = it_totals or {}
    rows = []
    for category, skills in data.items():
        for skill in skills:
            it_by_location = skill.get("it_by_location") or {}
            for location, postings in (skill.get("by_location") or {}).items():
                rows.append({
                    "date": date,
                    "category": category,
                    "skill": skill["name"],
                    "location": location,
                    "postings": postings,
                    "it_postings": it_by_location.get(location, ""),
                    "it_total": it_totals.get(location, "") if location in it_by_location else "",
                })
    return rows


def append_history_csv(csv_path, date, data, it_totals=None):
    """Add one dated snapshot to history.csv, the permanent long-term record.

    Rows for the same date are replaced, so re-running the script on the same day
    doesn't duplicate them. Unlike history.json, nothing is ever trimmed. Rows stay
    sorted by date, with each date's rows in a stable order, so git diffs only show
    the newly added week."""
    write_history_csv(csv_path, read_history_csv(csv_path), {date: snapshot_to_rows(date, data, it_totals)})


def seed_history_csv(csv_path, history_path):
    """Create history.csv from every snapshot already in history.json."""
    try:
        with open(history_path, "r", encoding="utf-8") as f:
            snapshots = json.load(f).get("snapshots", [])
    except (FileNotFoundError, json.JSONDecodeError):
        snapshots = []
    new_rows = {s["date"]: snapshot_to_rows(s["date"], s["data"], s.get("it_totals")) for s in snapshots}
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
        writer = csv.DictWriter(f, fieldnames=HISTORY_CSV_FIELDS, lineterminator="\n", restval="")
        writer.writeheader()
        writer.writerows(rows)


if __name__ == "__main__":
    fetch_skill_demand()
