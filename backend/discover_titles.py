"""Check how well the job-title families in job_titles.py cover real Data/IT ads.

Prints, for the live ads and for Historical Ads year files: how many ads fall in each
family, and the most common words in the headlines no family matched, so new or
growing job titles show up. Nothing is written to backend/data.

Usage:
    python backend/discover_titles.py live --out discovery/titles-live.json
    python backend/discover_titles.py hist 2025 --out discovery/titles-2025.json
    python backend/discover_titles.py report discovery/titles-*.json
"""
import argparse
import json
import os
import random
import re
import sys
import tempfile
import time
from collections import Counter

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from job_titles import classify_title, FAMILY_NAMES  # noqa: E402
from backfill_historical import download, iter_ads, ad_is_it, load_legacy_it_occupations, DEFAULT_FILE_FOR  # noqa: E402
from main import search, DATA_IT_FIELD, MAX_PAGED_HITS, FULL_SCAN_SORTS  # noqa: E402

WORD = re.compile(r"[a-zåäöéü][a-zåäöéü+#.-]{1,}", re.IGNORECASE)
STOP = set("""och i till med för på inom en ett av som vi söker the and for to in of at a an with
our you är du som från hos senior junior erfaren lead stockholm göteborg malmö""".split())


def summarize(source, headlines):
    families, other_words, other = Counter(), Counter(), []
    for headline in headlines:
        family = classify_title(headline)
        families[family or "(other)"] += 1
        if family is None:
            other.append(headline)
            other_words.update({w.lower() for w in WORD.findall(headline or "")} - STOP)
    random.seed(1)
    return {
        "source": source,
        "ads": len(headlines),
        "families": families.most_common(),
        "other_words": other_words.most_common(120),
        "other_samples": random.sample(other, min(80, len(other))),
    }


def cmd_live(args):
    ads = {}
    for sort in FULL_SCAN_SORTS:
        offset = 0
        while offset < MAX_PAGED_HITS:
            data = search({"occupation-field": DATA_IT_FIELD, "sort": sort, "limit": 100, "offset": offset})
            hits = data.get("hits", [])
            for hit in hits:
                ads[hit.get("id")] = hit.get("headline")
            if not hits or offset + 100 >= data.get("total", {}).get("value", 0):
                break
            offset += 100
            time.sleep(0.2)
    json.dump(summarize("live", list(ads.values())), open(args.out, "w"), ensure_ascii=False, indent=1)


def cmd_hist(args):
    name = DEFAULT_FILE_FOR.get(args.name, args.name)
    legacy = load_legacy_it_occupations()
    headlines, seen = [], set()
    with tempfile.TemporaryDirectory() as tmp:
        for ad in iter_ads(download(name, tmp)):
            if not isinstance(ad, dict):
                continue
            ad_id = ad.get("id")
            if ad_id is not None:  # the oldest files have no ids
                if ad_id in seen:
                    continue
                seen.add(ad_id)
            if ad_is_it(ad, legacy):
                headlines.append(ad.get("headline"))
    json.dump(summarize(f"hist-{name}", headlines), open(args.out, "w"), ensure_ascii=False, indent=1)


def cmd_report(args):
    for path in args.files:
        d = json.load(open(path))
        n = max(d["ads"], 1)
        print("=" * 70)
        print(f"{d['source']}: {d['ads']} Data/IT ads")
        print("--- families (% of Data/IT ads)")
        for family, count in d["families"]:
            print(f"  {count:6d} {100 * count / n:5.1f}%  {family}")
        missing = [f for f in FAMILY_NAMES if f not in dict(d["families"])]
        if missing:
            print("  (no ads):", ", ".join(missing))
        print("--- most common words in unmatched headlines")
        print("  " + ", ".join(f"{w} {c}" for w, c in d["other_words"]))
        print("--- sample unmatched headlines")
        for h in d["other_samples"]:
            print("  ", h)


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    a = sub.add_parser("live"); a.add_argument("--out", required=True); a.set_defaults(f=cmd_live)
    b = sub.add_parser("hist"); b.add_argument("name"); b.add_argument("--out", required=True); b.set_defaults(f=cmd_hist)
    c = sub.add_parser("report"); c.add_argument("files", nargs="+"); c.set_defaults(f=cmd_report)
    args = ap.parse_args()
    args.f(args)


if __name__ == "__main__":
    main()
