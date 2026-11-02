"""How the tracked skills connect: which ones turn up in the same Data/IT job ads.

main.py fetches every live Data/IT ad and passes each ad's set of tracked skills here.
From those sets this module works out, for each skill:

- pairs: how many of its ads also mention each other skill, and
- a "bundle": the companion skills that, learned alongside it, cover the most of its
  ads. An ad counts as covered when you know every tracked skill it mentions, so
  "Python + Linux + Git covers 48%" means 48% of the ads mentioning Python ask for
  nothing else from the 20 tracked skills.

Kept free of network code so it can be tested on hand-made ads.
"""

# Stop adding companions once this share of the skill's ads is covered ("most jobs").
BUNDLE_TARGET_PERCENT = 50
# Never suggest more than this many companions, even if the target isn't reached.
BUNDLE_MAX_COMPANIONS = 6
# Skills with fewer ads than this get no bundle; the percentages would be noise.
BUNDLE_MIN_ADS = 10


def build_bundle(skill, ad_skill_sets):
    """Greedily pick companion skills for `skill` that cover the most of its ads.

    ad_skill_sets: one set of tracked skills per ad that mentions `skill`.
    Each round looks at what the still-uncovered ads ask for beyond the skills chosen
    so far, and adds the group of skills that covers the most ads per skill added
    (a classic greedy set cover). Adding a whole group at once keeps skills that are
    asked for together, such as C# and .NET, together.
    Returns (baseline percent covered by the skill alone, list of steps, one per
    companion, each with the percent covered once it is added)."""
    total = len(ad_skill_sets)
    chosen = {skill}

    def covered():
        return sum(1 for s in ad_skill_sets if s <= chosen)

    baseline = round(100 * covered() / total)
    steps = []
    while len(steps) < BUNDLE_MAX_COMPANIONS:
        uncovered = [s for s in ad_skill_sets if not s <= chosen]
        budget = BUNDLE_MAX_COMPANIONS - len(steps)
        options = {frozenset(s - chosen) for s in uncovered}
        options = [o for o in options if len(o) <= budget]
        if not options:
            break

        def score(option):
            with_option = chosen | option
            gain = sum(1 for s in uncovered if s <= with_option)
            return (gain / len(option), gain, -len(option), sorted(option))

        best = max(options, key=score)
        # Within the group, add first whatever covers the most on its own (then the
        # most mentioned), so the coverage climbs as early as it can.
        mentions = {name: sum(1 for s in uncovered if name in s) for name in best}
        remaining = set(best)
        while remaining:
            name = max(remaining, key=lambda n: (
                sum(1 for s in uncovered if s <= chosen | {n}), mentions[n], n
            ))
            remaining.remove(name)
            chosen.add(name)
            steps.append({"skill": name, "coverage": round(100 * covered() / total)})
        if steps[-1]["coverage"] >= BUNDLE_TARGET_PERCENT:
            break

    return baseline, steps


def build_skill_network(ad_skill_sets, all_skills, top_n=5, min_count=2):
    """Summarise skill connections across ads.

    ad_skill_sets: one set of tracked skills per ad (ads with none can be included;
    they only count towards total_ads).
    Returns (network, co_occurrence), where co_occurrence keeps the older
    {skill: [{name, count, percent}]} top-N format the job postings panel reads."""
    ads_by_skill = {skill: [] for skill in all_skills}
    for skills in ad_skill_sets:
        for skill in skills:
            if skill in ads_by_skill:
                ads_by_skill[skill].append(skills)

    pairs = {}
    bundles = {}
    co_occurrence = {}
    for skill in all_skills:
        ads = ads_by_skill[skill]
        counts = {}
        for skills in ads:
            for other in skills - {skill}:
                counts[other] = counts.get(other, 0) + 1
        ranked = sorted(counts.items(), key=lambda pair: (-pair[1], pair[0]))
        pairs[skill] = dict(ranked)

        if ads:
            top = [
                {"name": name, "count": count, "percent": round(100 * count / len(ads))}
                for name, count in ranked
                if count >= min_count
            ][:top_n]
            if top:
                co_occurrence[skill] = top

        if len(ads) >= BUNDLE_MIN_ADS:
            baseline, steps = build_bundle(skill, ads)
            bundles[skill] = {"alone": baseline, "steps": steps}

    network = {
        "total_ads": len(ad_skill_sets),
        "target_percent": BUNDLE_TARGET_PERCENT,
        "ads": {skill: len(ads_by_skill[skill]) for skill in all_skills},
        "pairs": pairs,
        "bundles": bundles,
    }
    return network, co_occurrence
