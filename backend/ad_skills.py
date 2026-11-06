"""Which tracked skills each live Data/IT ad mentions, in a compact form for the CV check.

The dashboard's "Check your CV" section scores a CV against every live Data/IT ad in
the visitor's browser: an ad is a match when the CV has every tracked skill it names,
or all but one. That needs each ad's set of skills, so the weekly job writes one row
per ad here. A row holds only flags and small numbers (no ad text, employer or link):

    [skill bitmask, title family index, location index, seniority, experience required]

- skill bitmask: bit i set when the ad mentions skills[i]
- title family index: position in titles, or -1 for "other titles"
- location index: position in locations (the three cities), or -1 for elsewhere
- seniority: 0 not stated, 1 junior/graduate/trainee, 2 senior/lead/principal,
  read from the headline
- experience required: 1 when the employer ticked "experience required", else 0

The file also carries the regexes the backend uses to spot skills and title families,
so the browser finds skills in a CV exactly the way this job finds them in ads.

Kept free of network code so it can be tested on hand-made ads.
"""

import re

SENIOR_PATTERN = re.compile(
    r"\bsenior|\bseni[öo]r|\blead\b|\bprincipal\b|\bstaff\s+(?:engineer|developer)|\bexpert\b|\berfaren\b",
    re.IGNORECASE,
)
JUNIOR_PATTERN = re.compile(
    r"\bjunior|\bgraduate\b|\btrainee\b|\bnyexaminerad|\bentry[\s-]*level\b|\bpraktik|\bintern(?:ship)?\b|\bexamensarbete",
    re.IGNORECASE,
)


def seniority(headline):
    """0 when the headline doesn't say, 1 junior, 2 senior. Junior wins a tie, since
    "Junior to Senior developer" is open to juniors."""
    if not isinstance(headline, str):
        return 0
    if JUNIOR_PATTERN.search(headline):
        return 1
    if SENIOR_PATTERN.search(headline):
        return 2
    return 0


def regex_source(pattern, flags):
    """A Python regex as a JavaScript one: {source, flags}."""
    return {"source": pattern, "flags": "i" if flags & re.IGNORECASE else ""}


def build_ad_skills(ads, all_skills, title_names, classify_title, locations):
    """ads: one dict per ad with keys skills (set), headline, municipality_id and
    experience_required. locations: {name: municipality concept id} for the cities
    shown on the dashboard (the nationwide entry, with id None, is skipped)."""
    city_names = [name for name, concept in locations.items() if concept]
    city_index = {locations[name]: i for i, name in enumerate(city_names)}
    title_index = {name: i for i, name in enumerate(title_names)}
    bit = {skill: 1 << i for i, skill in enumerate(all_skills)}

    rows = []
    for ad in ads:
        mask = 0
        for skill in ad.get("skills") or ():
            mask |= bit.get(skill, 0)
        family = classify_title(ad.get("headline"))
        rows.append([
            mask,
            title_index.get(family, -1),
            city_index.get(ad.get("municipality_id"), -1),
            seniority(ad.get("headline")),
            1 if ad.get("experience_required") else 0,
        ])

    return {
        "total_ads": len(rows),
        "skills": list(all_skills),
        "titles": list(title_names),
        "locations": city_names,
        "columns": ["skills", "title", "location", "seniority", "experience_required"],
        "ads": rows,
    }
