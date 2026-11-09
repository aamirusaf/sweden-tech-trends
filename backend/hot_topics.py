"""Hot topics: broad themes such as AI, LLMs and cybersecurity in Data/IT job ads.

The dashboard's 20 tracked skills are concrete tools, chosen because they are the
most-mentioned ones (see main.TECH_STACKS). Themes like "AI" aren't tools, so they
aren't among them, but they are what many readers look for first. This module tracks
them separately, measured the same way as the skills: the share of Data/IT ads whose
headline or description mentions the topic.

Each topic is a list of (regex, flags) alternatives, and an ad mentions the topic when
any of them matches. Some short terms must keep their capitals ("AI", "ML", "BI", "SRE")
so they don't match ordinary words, while longer phrases ignore case; that's why a
topic has several patterns instead of one. The same patterns are used by the weekly
job (live ads), by backfill_historical.py (every ad since 2006) and, as JavaScript
regexes, by the CV check in the browser.

Topics overlap on purpose: "AI" counts any mention of AI, including machine learning
and generative AI, while "GenAI & LLMs" and "Machine learning" count only those.

Kept free of network code so it can be tested on hand-made ads.
"""

import csv
import re
from collections import Counter

I = re.IGNORECASE

HOT_TOPICS = [
    {
        "name": "AI",
        "description": "Any mention of artificial intelligence, including machine learning and generative AI.",
        "patterns": [
            (r"\bAI\b|\bGenAI\b|\bLLMs?\b|\bML\b", 0),
            (r"\bartificiell\w* intelligens|\bartificial intelligence|\bmachine learning|\bmaskininlärning"
             r"|\bdeep learning|\bdjupinlärning|\bgenerativ\w* AI\b|\blarge language models?\b|\bspråkmodell", I),
        ],
    },
    {
        "name": "GenAI & LLMs",
        "description": "Generative AI, large language models, AI agents and copilots.",
        "patterns": [
            (r"\bLLMs?\b|\bGenAI\b|\bGPT(?:-?\d)?\b", 0),
            (r"\bgenerativ\w* AI\b|\bgen[- ]AI\b|\blarge language models?\b|\bspråkmodell|\bChatGPT\b|\bOpenAI\b"
             r"|\bLangChain\b|\bLlamaIndex\b|\bprompt engineering\b|\bretrieval[- ]augmented\b|\bAI[- ]agent"
             r"|\bagentic\b|\bcopilot\b|\bfoundation models?\b|\bHugging ?Face\b", I),
        ],
    },
    {
        "name": "Machine learning",
        "description": "Machine learning, deep learning, computer vision and MLOps.",
        "patterns": [
            (r"\bML\b", 0),
            (r"\bmachine learning|\bmaskininlärning|\bdeep learning|\bdjupinlärning|\bneural\w* (?:networks?|nätverk)"
             r"|\bcomputer vision\b|\bdatorseende\b|\bMLOps\b|\bPyTorch\b|\bTensorFlow\b|\bscikit[- ]?learn\b|\bKeras\b", I),
        ],
    },
    {
        "name": "Cybersecurity",
        "description": "Cyber and information security: security roles, pentesting, SOC, ISO 27001, NIS2.",
        "patterns": [
            (r"\bcyber[- ]?security|\bcyber[- ]?säkerhet|\bcybersäkerhet|\binformationssäkerhet|\binformation security"
             r"|\bIT[- ]?säkerhet|\bIT[- ]security|\binfosec\b|\bapplication security|\bapplikationssäkerhet"
             r"|\bcloud security|\bmolnsäkerhet|\bnetwork security|\bnätverkssäkerhet|\bpenetrationstest|\bpentest"
             r"|\bethical hack|\bzero trust\b|\bsäkerhetsarkitekt|\bsäkerhetsanalytiker|\bsäkerhetsspecialist"
             r"|\bsecurity (?:engineer|analyst|architect|specialist|operations|officer|consultant)"
             r"|\bSOC[- ]?(?:analyst|analytiker|team)|\bSIEM\b|\bthreat (?:intelligence|hunting)|\bvulnerabilit"
             r"|\bsårbarhet|\bISO ?27001\b|\bNIS ?2\b|\bCISSP\b|\bCISM\b|\bOSCP\b|\bDevSecOps\b", I),
        ],
    },
    {
        "name": "Data & analytics",
        "description": "Data engineering, data science, BI, data warehouses and data platforms.",
        "patterns": [
            (r"\bBI\b", 0),
            (r"\bdata ?engineer|\bdataingenjör|\bdata science|\bdata scientist|\bdataanalys|\bdata ?analyst"
             r"|\bdataanalytiker|\bbusiness intelligence|\bpower ?BI\b|\bTableau\b|\bQlik|\bdata ?warehous"
             r"|\bdatalager|\bdata ?lake|\blakehouse|\bDatabricks\b|\bSnowflake\b|\bbig data\b|\bETL\b"
             r"|\banalytics engineer|\bdata ?platform|\bdataplattform|\bdata ?pipeline|\bApache Spark\b|\bdbt\b", I),
        ],
    },
    {
        "name": "Cloud-native & DevOps",
        "description": "DevOps, CI/CD, microservices, infrastructure as code and platform engineering.",
        "patterns": [
            (r"\bSRE\b|\bIaC\b", 0),
            (r"\bdev ?ops\b|\bDevSecOps\b|\bCI ?/ ?CD\b|\bcontinuous (?:integration|delivery|deployment)"
             r"|\bcloud[- ]native|\bmicro ?services?\b|\bmikrotjänst|\binfrastructure as code|\bsite reliability"
             r"|\bplatform engineer|\bGitOps\b|\bserverless\b|\bcontaineri[sz]", I),
        ],
    },
]

TOPIC_NAMES = [topic["name"] for topic in HOT_TOPICS]

# How many example ads to keep per topic and location, and how many of the tracked
# skills and job titles to list per topic.
SAMPLES_PER_TOPIC = 6
TOP_SKILLS = 8
TOP_TITLES = 4

# Weekly archive of the live shares, like history.csv for the skills.
HISTORY_FIELDS = ["date", "topic", "location", "it_ads", "it_total"]


class TopicMatcher:
    def __init__(self, patterns):
        self.patterns = [re.compile(source, flags) for source, flags in patterns]

    def search(self, text):
        for pattern in self.patterns:
            match = pattern.search(text)
            if match:
                return match
        return None


TOPIC_MATCHERS = {topic["name"]: TopicMatcher(topic["patterns"]) for topic in HOT_TOPICS}


def topics_in(text):
    """The set of hot topics the text mentions."""
    if not text:
        return set()
    return {name for name, matcher in TOPIC_MATCHERS.items() if matcher.search(text)}


def matched_terms(text, counter):
    """Add every term in the text that made a topic match to counter[(topic, term)],
    so a run's log shows what each topic is actually picking up."""
    for name, matcher in TOPIC_MATCHERS.items():
        for pattern in matcher.patterns:
            for match in pattern.finditer(text or ""):
                counter[(name, match.group(0).lower())] += 1


def print_matched_terms(counter, per_topic=12):
    for name in TOPIC_NAMES:
        terms = sorted(((n, term) for (topic, term), n in counter.items() if topic == name), reverse=True)
        shown = ", ".join(f"{term} {n}" for n, term in terms[:per_topic])
        print(f"   {name}: {shown or '-'}")


def browser_patterns():
    """The topics' regexes as JavaScript ones, for the CV check."""
    return {
        topic["name"]: [{"source": source, "flags": "i" if flags & I else ""} for source, flags in topic["patterns"]]
        for topic in HOT_TOPICS
    }


def build_hot_topics(ads, all_skills, locations):
    """Live hot-topic stats from every scanned Data/IT ad.

    ads: one dict per ad with keys topics (set), skills (set of tracked skills),
    title (job-title family or None), city (a LOCATIONS city or None), published,
    headline, employer, place, url.
    locations: the dashboard's LOCATIONS ({name: concept id}, "Sweden" nationwide)."""
    location_names = list(locations)
    totals = Counter()
    for ad in ads:
        for location in ad_locations(ad):
            totals[location] += 1

    newest_first = sorted(ads, key=lambda ad: ad.get("published") or "", reverse=True)
    topics = []
    for topic in HOT_TOPICS:
        name = topic["name"]
        topic_ads = [ad for ad in newest_first if name in ad["topics"]]
        counts = Counter(location for ad in topic_ads for location in ad_locations(ad))
        skill_counts = Counter(skill for ad in topic_ads for skill in ad["skills"])
        title_counts = Counter(ad["title"] for ad in topic_ads if ad.get("title"))
        n = len(topic_ads)
        samples = {}
        for location in location_names:
            in_location = [ad for ad in topic_ads if location in ad_locations(ad)][:SAMPLES_PER_TOPIC]
            samples[location] = [
                {
                    "headline": ad.get("headline"),
                    "employer": ad.get("employer"),
                    "location": ad.get("place") or "Sweden",
                    "url": ad.get("url"),
                    "published": (ad.get("published") or "")[:10],
                }
                for ad in in_location
            ]
        topics.append({
            "name": name,
            "description": topic["description"],
            "ads_by_location": {location: counts.get(location, 0) for location in location_names},
            "percent_by_location": {
                location: round(100 * counts.get(location, 0) / totals[location], 1) if totals[location] else 0
                for location in location_names
            },
            # Share of this topic's ads that also mention each tracked skill / have each title.
            "skills": [
                {"name": skill, "percent": round(100 * count / n)}
                for skill, count in sorted(skill_counts.items(), key=lambda kv: (-kv[1], all_skills.index(kv[0])))[:TOP_SKILLS]
            ] if n else [],
            "titles": [
                {"name": title, "percent": round(100 * count / n)}
                for title, count in title_counts.most_common(TOP_TITLES)
            ] if n else [],
            "samples": samples,
        })
    return {
        "total_ads": totals.get("Sweden", 0),
        "totals_by_location": {location: totals.get(location, 0) for location in location_names},
        "topics": topics,
        "patterns": browser_patterns(),
    }


def ad_locations(ad):
    return ["Sweden"] + ([ad["city"]] if ad.get("city") else [])


def append_history(csv_path, date, hot_topics):
    """Add this week's shares to hot_topics_history.csv, replacing rows already there
    for the same date. Nothing is ever trimmed."""
    try:
        with open(csv_path, encoding="utf-8", newline="") as f:
            rows = [row for row in csv.DictReader(f) if row["date"] != date]
    except FileNotFoundError:
        rows = []
    for topic in hot_topics["topics"]:
        for location, ads in topic["ads_by_location"].items():
            rows.append({
                "date": date, "topic": topic["name"], "location": location,
                "it_ads": ads, "it_total": hot_topics["totals_by_location"].get(location, 0),
            })
    rows.sort(key=lambda row: row["date"])  # stable: keeps each date's row order
    with open(csv_path, "w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=HISTORY_FIELDS, lineterminator="\n")
        writer.writeheader()
        writer.writerows(rows)
