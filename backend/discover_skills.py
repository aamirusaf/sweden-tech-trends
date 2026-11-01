"""Discover which technologies Swedish IT job ads actually ask for.

Three independent signals, so the result doesn't just echo a list we picked:

1. live-tags:   employer-tagged skills (must_have / nice_to_have) on the live
                JobSearch ads in the Data/IT occupation field.
2. live-text:   a broad candidate dictionary (~150 technologies) matched against
                the full text of those same live IT ads.
3. hist-enrich: Arbetsförmedlingen's own NLP-extracted skills (keywords.enriched.skill)
                on every Data/IT ad published in a Historical Ads year file,
                plus the candidate dictionary on the same ads.

Usage:
    python backend/discover_skills.py live --out discovery/live.json
    python backend/discover_skills.py hist 2025 --out discovery/hist-2025.json
    python backend/discover_skills.py report discovery/*.json
"""
import argparse
import json
import os
import re
import sys
import tempfile
import time
from collections import Counter

import requests

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from backfill_historical import download, iter_ads, ad_text, DEFAULT_FILE_FOR  # noqa: E402

API_URL = "https://jobsearch.api.jobtechdev.se/search"
DATA_IT_FIELD = "apaJ_2ja_LuF"  # occupation-field concept "Data/IT"

# Candidate dictionary: display name -> regex. Kept broad on purpose; the point is to
# rank, so anything plausible goes in and the data decides.
def wb(*names):
    return r"\b(?:" + "|".join(names) + r")\b"

CANDIDATES = {
    # languages
    "Python": wb("python"), "Java": wb("java") + r"(?!\s*script)", "JavaScript": r"\bjavascript\b|(?<![.\w])js\b",
    "TypeScript": wb("typescript"), "C#": r"(?<![\w])c#", "C++": r"(?<![\w])c\+\+", "C": r"(?<![\w#+.])\bC\b(?![#+])(?=\s*[,/&)]|\s+(?:och|and|or|eller)\b)",
    "Go": r"\bgolang\b|(?<=[,/&(]\s)Go\b|\bGo(?=\s*[,/&)]|\s+(?:och|and|or|eller)\b)",
    "Rust": r"\bRust\b", "Kotlin": wb("kotlin"), "Swift": r"\bSwift\b", "PHP": wb("php"), "Ruby": wb("ruby"),
    "Scala": wb("scala"), "R": r"(?<=[,/(]\s)R\b|\bR(?=\s*[,/)])", "MATLAB": wb("matlab"), "Bash/Shell": wb("bash", "shell scripting"),
    "PowerShell": wb("powershell"), "Perl": wb("perl"), "Dart": wb("dart"), "Elixir": wb("elixir"), "Haskell": wb("haskell"),
    "COBOL": wb("cobol"), "ABAP": wb("abap"), "VHDL/Verilog": wb("vhdl", "verilog", "systemverilog"), "Embedded C": wb("embedded c", "inbyggda system", "embedded"),
    # web / frameworks
    "React": wb("react", "react\\.js", "reactjs"), "Angular": wb("angular"), "Vue": wb("vue", "vue\\.js", "vuejs"), "Node.js": wb("node\\.js", "nodejs", "node"),
    ".NET": r"\.net\b|\bdotnet\b|asp\.net", "Spring": wb("spring", "spring boot"), "Django": wb("django"), "Flask": wb("flask"), "FastAPI": wb("fastapi"),
    "Next.js": wb("next\\.js", "nextjs"), "HTML/CSS": wb("html", "css", "html5", "css3"), "GraphQL": wb("graphql"), "REST": wb("rest", "restful", "rest api", "rest-api"),
    "Microservices": wb("microservices?", "mikrotjänster"), "Flutter": wb("flutter"), "React Native": wb("react native"), "iOS": wb("ios"), "Android": wb("android"),
    # cloud / infra / devops
    "AWS": wb("aws", "amazon web services"), "Azure": wb("azure"), "GCP": wb("gcp", "google cloud"), "Docker": wb("docker"), "Kubernetes": wb("kubernetes", "k8s"),
    "Terraform": wb("terraform"), "Ansible": wb("ansible"), "Linux": wb("linux"), "Windows Server": wb("windows server"), "CI/CD": r"\bci\s*/\s*cd\b|\bcicd\b",
    "Git": wb("git"), "GitHub": wb("github"), "GitLab": wb("gitlab"), "Jenkins": wb("jenkins"), "Azure DevOps": wb("azure devops"), "DevOps": wb("devops"),
    "Helm": wb("helm"), "OpenShift": wb("openshift"), "VMware": wb("vmware"), "Prometheus/Grafana": wb("prometheus", "grafana"), "Networking (TCP/IP)": wb("tcp/ip", "cisco", "ccna"),
    "Microsoft 365": wb("microsoft 365", "office 365", "m365", "o365"), "Active Directory/Entra": wb("active directory", "entra id", "azure ad"), "Intune": wb("intune"),
    "ServiceNow": wb("servicenow"), "ITIL": wb("itil"), "SAP": wb("sap"), "Salesforce": wb("salesforce"), "Dynamics 365": wb("dynamics 365", "dynamics crm", "dynamics nav"),
    # data / AI
    "SQL": wb("sql"), "PostgreSQL": wb("postgresql", "postgres"), "MySQL": wb("mysql"), "SQL Server": wb("sql server", "mssql"), "Oracle": wb("oracle"),
    "MongoDB": wb("mongodb"), "Redis": wb("redis"), "Elasticsearch": wb("elasticsearch", "elastic"), "Kafka": wb("kafka"), "Spark": wb("spark", "pyspark"),
    "Databricks": wb("databricks"), "Snowflake": wb("snowflake"), "dbt": wb("dbt"), "Airflow": wb("airflow"), "Power BI": wb("power bi", "powerbi"), "Tableau": wb("tableau"),
    "Excel": wb("excel"), "Machine learning": wb("machine learning", "maskininlärning", "ml"), "AI": wb("ai", "artificiell intelligens", "artificial intelligence"),
    "Generative AI/LLM": wb("llm", "llms", "generative ai", "generativ ai", "genai", "chatgpt", "openai", "large language models?"),
    "PyTorch": wb("pytorch"), "TensorFlow": wb("tensorflow"), "Pandas": wb("pandas"), "Data engineering": wb("data engineering", "data engineer"),
    # practices / security / other
    "Agile/Scrum": wb("agile", "agil", "agilt", "scrum", "kanban"), "Jira": wb("jira"), "Confluence": wb("confluence"), "TDD/Testing": wb("tdd", "unit test", "enhetstest", "testautomatisering", "test automation"),
    "Selenium": wb("selenium"), "Cypress": wb("cypress"), "Playwright": wb("playwright"), "Cybersecurity": wb("cybersäkerhet", "cyber security", "cybersecurity", "informationssäkerhet", "it-säkerhet", "säkerhetsskydd"),
    "ISO 27001": wb("iso 27001", "iso27001"), "SIEM/SOC": wb("siem", "security operations center", "splunk", "sentinel"), "Figma": wb("figma"), "UX": wb("ux", "ui/ux", "ux/ui"),
    "Unity/Unreal": wb("unity", "unreal"), "Qt": wb("qt"), "AUTOSAR": wb("autosar"), "PLC": wb("plc"), "IoT": wb("iot"),
}
MATCHERS = {name: re.compile(rx, re.IGNORECASE if not any(name == n for n in ("C", "Go", "R", "Rust", "Swift")) else 0)
            for name, rx in CANDIDATES.items()}


def match_text(text):
    return {name for name, m in MATCHERS.items() if m.search(text)}


def get(params, attempts=4):
    for attempt in range(1, attempts + 1):
        try:
            r = requests.get(API_URL, params=params, headers={"accept": "application/json"}, timeout=30)
            if r.status_code == 200:
                return r.json()
            print(f"HTTP {r.status_code} for {params}", flush=True)
        except requests.RequestException as e:
            print(f"Error {e}", flush=True)
        time.sleep(2 * attempt)
    raise SystemExit(f"Giving up on {params}")


def skill_labels(ad):
    out = set()
    for section in ("must_have", "nice_to_have"):
        for s in ((ad.get(section) or {}).get("skills") or []):
            if isinstance(s, dict) and s.get("label"):
                out.add(s["label"])
    return out


def cmd_live(args):
    first = get({"occupation-field": DATA_IT_FIELD, "limit": 5})
    total = first["total"]["value"]
    print("Live Data/IT ads:", total, "| sample fields:",
          [(h.get("occupation_field") or {}).get("label") for h in first["hits"]], flush=True)
    all_total = get({"limit": 0})["total"]["value"]

    tags, text_hits, n, n_tagged = Counter(), Counter(), 0, 0
    seen = set()
    # JobSearch caps offset at 2000; slice by occupation group to reach every ad.
    groups = get({"occupation-field": DATA_IT_FIELD, "limit": 0, "stats": "occupation-group", "stats.limit": 50})
    group_ids = [g["concept_id"] for s in groups.get("stats", []) for g in s.get("values", [])]
    print("Occupation groups:", [(g["term"], g["count"]) for s in groups.get("stats", []) for g in s.get("values", [])], flush=True)
    slices = [{"occupation-group": gid} for gid in group_ids] or [{}]
    for sl in slices:
        offset = 0
        while offset <= 2000:
            page = get({"occupation-field": DATA_IT_FIELD, "limit": 100, "offset": offset, **sl})
            hits = page.get("hits", [])
            if not hits:
                break
            for ad in hits:
                if ad["id"] in seen:
                    continue
                seen.add(ad["id"])
                n += 1
                labels = skill_labels(ad)
                if labels:
                    n_tagged += 1
                tags.update(labels)
                text = ad.get("headline", "") + "\n" + ((ad.get("description") or {}).get("text") or "")
                text_hits.update(match_text(text))
            offset += 100
            time.sleep(0.2)
    print(f"Scanned {n} unique live IT ads; {n_tagged} had employer skill tags", flush=True)

    # Full-index counts with q=, IT field only and across all ads, for the candidate names.
    q_counts = {}
    for name in CANDIDATES:
        if name in ("C", "R", "Go"):
            continue
        it = get({"q": name, "occupation-field": DATA_IT_FIELD, "limit": 0})["total"]["value"]
        q_counts[name] = it
        time.sleep(0.15)

    json.dump({"source": "live", "it_ads": total, "all_ads": all_total, "scanned": n, "tagged": n_tagged,
               "tags": tags.most_common(200), "text": text_hits.most_common(), "q_it": q_counts},
              open(args.out, "w"), ensure_ascii=False, indent=1)


def ad_field(ad):
    f = ad.get("occupation_field")
    if isinstance(f, dict):
        return f.get("label") or f.get("concept_id")
    if isinstance(f, list) and f:
        return (f[0] or {}).get("label")
    return None


def cmd_hist(args):
    name = DEFAULT_FILE_FOR.get(args.name, args.name)
    enriched, text_hits, fields = Counter(), Counter(), Counter()
    n = n_kw = 0
    with tempfile.TemporaryDirectory() as tmp:
        path = download(name, tmp)
        for i, ad in enumerate(iter_ads(path)):
            if not isinstance(ad, dict):
                continue
            if i == 0:
                print("keys:", sorted(ad.keys()), "| keywords:", json.dumps(ad.get("keywords"), ensure_ascii=False)[:600], flush=True)
            field = ad_field(ad)
            fields[field] += 1
            if field not in ("Data/IT", DATA_IT_FIELD):
                continue
            n += 1
            kw = ((ad.get("keywords") or {}).get("enriched") or {}).get("skill") or []
            if kw:
                n_kw += 1
            enriched.update(set(k.lower() for k in kw if isinstance(k, str)))
            text_hits.update(match_text(ad_text(ad)))
    print("Top fields:", fields.most_common(25), flush=True)
    print(f"{name}: {n} Data/IT ads, {n_kw} with enriched skills", flush=True)
    json.dump({"source": f"hist-{name}", "it_ads": n, "with_enriched": n_kw, "enriched": enriched.most_common(300),
               "text": text_hits.most_common()}, open(args.out, "w"), ensure_ascii=False, indent=1)


def cmd_report(args):
    for p in args.files:
        d = json.load(open(p))
        print("=" * 70)
        print(d["source"], {k: v for k, v in d.items() if isinstance(v, int)})
        base = d.get("scanned") or d.get("it_ads") or 1
        for key in ("tags", "enriched", "text"):
            if key in d:
                print(f"--- {key} (top 60, % of IT ads)")
                for label, c in d[key][:60]:
                    print(f"  {c:6d} {100 * c / base:5.1f}%  {label}")
        if "q_it" in d:
            print("--- q= counts within Data/IT (top 60, % of IT ads)")
            for label, c in sorted(d["q_it"].items(), key=lambda kv: -kv[1])[:60]:
                print(f"  {c:6d} {100 * c / d['it_ads']:5.1f}%  {label}")


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
