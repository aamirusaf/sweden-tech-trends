import json
import os
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

# How many sample postings to keep per skill for the "click a skill to see openings" panel
POSTINGS_PER_SKILL = 6

# How many dated snapshots to keep in history.json before dropping the oldest
MAX_HISTORY_SNAPSHOTS = 52

def fetch_skill_demand():
    results = {
        "last_updated": datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S UTC"),
        "data": {}
    }
    postings_by_skill = {}

    print("🚀 Fetching live technology metrics from Arbetsförmedlingen API...")

    # Iterate through categories and request metrics
    for category, skills in TECH_STACKS.items():
        results["data"][category] = []

        for skill in skills:
            # Query parameter 'q' handles free text matching over titles and descriptions.
            # limit>0 still returns the full match count in `total`, plus that many sample ads.
            params = {"q": skill, "limit": POSTINGS_PER_SKILL}

            try:
                response = requests.get(API_URL, params=params, headers={"accept": "application/json"}, timeout=10)

                if response.status_code == 200:
                    data = response.json()
                    # Extract the total hits found on the live platform
                    total_ads = data.get("total", {}).get("value", 0)

                    results["data"][category].append({
                        "name": skill,
                        "value": total_ads
                    })
                    postings_by_skill[skill] = [
                        {
                            "headline": hit.get("headline"),
                            "employer": (hit.get("employer") or {}).get("name"),
                            "location": (hit.get("workplace_address") or {}).get("municipality")
                                or (hit.get("workplace_address") or {}).get("region")
                                or "Sweden",
                            "url": hit.get("webpage_url"),
                            "published": (hit.get("publication_date") or "")[:10]
                        }
                        for hit in data.get("hits", [])
                    ]
                    print(f"✅ {skill}: found {total_ads} job posts.")
                else:
                    print(f"⚠️ Failed fetching data for {skill}. HTTP Status: {response.status_code}")

            except Exception as e:
                print(f"❌ Error communicating with API for {skill}: {e}")

            # Simple rate limiting window compliance
            time.sleep(0.2)

    # Persist the dynamic calculations to the data layer directory
    script_dir = os.path.dirname(os.path.abspath(__file__))
    data_dir = os.path.join(script_dir, "data")
    trends_path = os.path.join(data_dir, "tech_trends.json")
    postings_path = os.path.join(data_dir, "job_postings.json")
    history_path = os.path.join(data_dir, "history.json")

    try:
        with open(trends_path, "w", encoding="utf-8") as f:
            json.dump(results, f, indent=4, ensure_ascii=False)
        with open(postings_path, "w", encoding="utf-8") as f:
            json.dump(
                {"last_updated": results["last_updated"], "postings": postings_by_skill},
                f, indent=4, ensure_ascii=False
            )
        update_history(history_path, results["data"])
        print(f"\n🎉 Successfully compiled metrics files saved to: {data_dir}")
    except FileNotFoundError:
        print("❌ Error: Directory 'backend/data/' does not exist. Run setup structure command first.")


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
