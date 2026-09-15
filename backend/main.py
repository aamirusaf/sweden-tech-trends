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

def fetch_skill_demand():
    results = {
        "last_updated": datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S UTC"),
        "data": {}
    }
    
    print("🚀 Fetching live technology metrics from Arbetsförmedlingen API...")
    
    # Iterate through categories and request metrics
    for category, skills in TECH_STACKS.items():
        results["data"][category] = []
        
        for skill in skills:
            # Query parameter 'q' handles free text matching over titles and descriptions
            params = {"q": skill, "limit": 0} 
            
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
                    print(f"✅ {skill}: found {total_ads} job posts.")
                else:
                    print(f"⚠️ Failed fetching data for {skill}. HTTP Status: {response.status_code}")
                    
            except Exception as e:
                print(f"❌ Error communicating with API for {skill}: {e}")
            
            # Simple rate limiting window compliance
            time.sleep(0.2)

    # Persist the dynamic calculations to the data layer directory
    script_dir = os.path.dirname(os.path.abspath(__file__))
    output_path = os.path.join(script_dir, "data", "tech_trends.json")
    
    try:
        with open(output_path, "w", encoding="utf-8") as f:
            json.dump(results, f, indent=4, ensure_ascii=False)
        print(f"\n🎉 Successfully compiled metrics file saved to: {output_path}")
    except FileNotFoundError:
        print("❌ Error: Directory 'backend/data/' does not exist. Run setup structure command first.")

if __name__ == "__main__":
    fetch_skill_demand()
