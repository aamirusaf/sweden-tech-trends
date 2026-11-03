"""Job-title families: what employers call the job in the headline of a Data/IT ad.

Each ad's headline is put in one family, the first in TITLE_FAMILIES whose pattern
matches, or in none ("other titles"). One family per ad keeps the shares adding up to
at most 100%, so "Data Engineer 4%" means 4% of Data/IT ads are titled that way.

The order matters: more specific roles come before broader ones, so "Senior Backend
Developer" is a Backend Developer, not a generic Software Developer, and "AI Project
Manager" is a Project & Product role. Headlines mix Swedish and English, and Swedish
compounds words ("Javautvecklare", "Nätverkstekniker"), so many patterns match inside
words on purpose.

Shared by main.py (live ads) and backfill_historical.py (Historical Ads since 2006).
Kept free of network code so it can be tested on hand-made headlines.
"""

import re

# (family, pattern, words shown to readers as "what counts"). Case-insensitive.
TITLE_FAMILIES = [
    ("Project & Product Manager",
     r"projekt?\w*ledare|projektledning|uppdragsledare|projektadministrat|projektsamordnare|samordnare|"
     r"koordinator|coordinator|project\s*manager|project\s*lead|produkt[äa]gare|product\s*owner|"
     r"product\s*manager|scrum\s*master|agil[e]?\s*coach|delivery\s*manager|program\s*manager|programledare|"
     r"f[öo]rvaltningsledare|tj[äa]nste[äa]gare|service\s*owner|release\s*manager",
     "Project manager, Product owner, Scrum master, Förvaltningsledare"),
    ("IT Manager & Lead",
     r"\w*chef\b|\bhead\s+of\b|\bcto\b|\bcio\b|\bciso\b|engineering\s*manager|\bit[\s-]*manager|"
     r"teamledare|team\s*lead|gruppledare|it[\s-]*ansvarig|\bmanager\b",
     "IT-chef, Head of, CTO, Engineering manager, Team lead"),
    # AI and ML count only as part of a role ("AI Engineer", "AI-utvecklare"), not when
    # a title just mentions them ("C# developer with AI focus").
    ("AI Engineer",
     r"\b(?:gen\s*)?ai(?:\s*/\s*ml)?[\s-]*(?:engineer|ingenj|developer|utvecklare|architect|arkitekt|specialist|"
     r"konsult|consultant|lead|scientist|expert|researcher|forskare|strateg|product|solution|platform)|"
     r"\bllm[\s-]*(?:engineer|developer|utvecklare|specialist)|artificial\s*intelligence|artificiell\s*intelligens",
     "AI engineer, AI developer, AI-utvecklare, AI architect"),
    ("ML Engineer",
     r"\b(?:ml|machine\s*learning|maskininl[äa]rnings?)[\s-]*(?:engineer|ingenj|developer|utvecklare|specialist|"
     r"scientist|expert|researcher|forskare|architect|lead)|\bmlops\b",
     "ML engineer, Machine learning engineer, MLOps"),
    ("Data Scientist",
     r"data\s*scien|datascien",
     "Data scientist, Data science"),
    ("Data Engineer",
     r"data\s*engineer|dataingenj[öo]r|data\s*warehouse|\bdwh\b|\betl\b|data\s*platform|dataplattform|"
     r"data[\s-]*utvecklare|data\s*developer|dataspecialist|data\s*specialist|data\s*ops\b|dataops|"
     r"databas|database|\bdba\b|master\s*data|masterdata|data\s*steward",
     "Data engineer, Dataingenjör, Data warehouse, Database administrator"),
    ("Data Analyst & BI",
     r"data\s*analy|dataanaly|\bbi\b|\bbi[\s-]|business\s*intelligence|power\s*bi|analytics|rapport\w*",
     "Data analyst, BI developer, Power BI, Analytics engineer"),
    ("DevOps & Platform",
     r"devops|devsecops|\bsre\b|site\s*reliability|platform\s*engineer|plattforms\w*|platform\s*developer|"
     r"platform\s*team|\bplatform\b",
     "DevOps engineer, Platform engineer, SRE"),
    ("Security",
     r"s[äa]kerhet|security|cyber(?!net)|\bsoc\b|\biam\b|identity|pentest|penetration|\bsiem\b",
     "Security specialist, Cybersecurity, IAM, SOC analyst"),
    ("Architect",
     r"arkitekt|architect|strateg",
     "Solution architect, IT-arkitekt, IT-strateg"),
    ("Cloud Engineer",
     r"cloud|moln|\b(?:azure|aws|gcp)[\s-]*(?:engineer|ingenj|specialist|tekniker|consultant|konsult|administrat|expert)",
     "Cloud engineer, Azure / AWS specialist"),
    ("Embedded Developer",
     r"embedded|inbyggd|firmware|\bfpga\b|realtidssystem|real[\s-]*time",
     "Embedded developer, Inbyggda system, Firmware"),
    ("Test & QA",
     r"testare|\btester\b|testledare|testingenj[öo]r|testautomat|test\s*engineer|test\s*lead|test\s*manager|"
     r"test\s*automation|testspecialist|testkonsult|\bqa\b|quality\s*assurance|kvalitetss[äa]kr|verifieringsingenj",
     "Tester, Test engineer, QA, Testautomatisering"),
    ("UX & Design",
     r"\bux\b|\bui\b|designer|interaktionsdesign|user\s*experience",
     "UX designer, UI designer, Interaction designer"),
    ("Mobile Developer",
     r"android|\bios\b|mobil\w*[\s-]*(?:utvecklare|developer|app)|apputvecklare|app[\s-]*utvecklare|"
     r"app\s*developer|flutter|react\s*native",
     "Android, iOS, App developer"),
    ("Frontend & Web Developer",
     r"front[\s-]*end|webbutvecklare|webb[\s-]*utvecklare|web\s*developer|webbprogrammerare|"
     r"webb?\s*master|webbansvarig|wordpress",
     "Frontend developer, Webbutvecklare, Webmaster"),
    ("Fullstack Developer",
     r"full[\s-]*stack",
     "Fullstack developer"),
    ("Backend Developer",
     r"back[\s-]*end",
     "Backend developer, Backendutvecklare"),
    ("Software Developer",
     r"utvecklare|utvikl|developer|programm?e?rare|programmer|software|mjukvar|systemutveckl|systemvetare|\bcoder\b|"
     r"utveckling|development|kodare",
     "Systemutvecklare, Software engineer, Java/.NET/C++ developer"),
    # Running and looking after business systems, a large group in Swedish public sector ads.
    ("Application Specialist",
     r"systemf[öo]rvalt|systemansvarig|system[äa]gare|applikations|application\s*(?:specialist|manager|management|owner)|"
     r"app\.?\s*specialist|objektledare|objektspecialist|tj[äa]nsteansvarig|\bsap\b|dynamics|salesforce|"
     r"servicenow|business\s*central|\berp\b|\bcrm\b|systemintegrat|integrations?(?:specialist|utvecklare)?\b|\bintegration\b",
     "Systemförvaltare, Applikationsspecialist, SAP / Dynamics specialist"),
    ("Network & Infrastructure",
     r"n[äa]tverk|network|infrastruktur|infrastructure|system\s*administrat|systemadministrat|sysadmin|"
     r"drift(?!ig)|operations|server|datacenter|data\s*center|linux|windows|systemtekniker|systemingenj|"
     r"system\s*engineer|systemspecialist|administrat",
     "Network engineer, Systemadministratör, Drifttekniker"),
    ("IT Support",
     r"support|helpdesk|help\s*desk|servicedesk|service\s*desk|tekniker|first\s*line|1st\s*line|"
     r"2nd\s*line|second\s*line|anv[äa]ndarst[öo]d|technician|it[\s-]*service",
     "IT support, Supporttekniker, Servicedesk, IT-tekniker"),
    ("Analyst",
     r"analytiker|analyst|kravanaly|requirements",
     "Business analyst, Systemanalytiker, Kravanalytiker"),
    ("Researcher",
     r"forskare|researcher|postdo[ck]|\bphd\b|doktorand|research",
     "Forskare, Researcher, Postdoc, PhD student"),
    ("Consultant",
     r"konsult|consultant",
     "IT-konsult, Consultant"),
    # Last resort for titles that only say "engineer", such as "JavaScript Engineer".
    # Network, support and other engineers were placed by the families above.
    ("Software Developer",
     r"engineer|ingenj[öo]r",
     None),
]

# A family can have several entries (to place a broad fallback pattern later in the
# order); the first entry's examples are the ones shown.
FAMILY_NAMES = list(dict.fromkeys(name for name, _, _ in TITLE_FAMILIES))
FAMILY_EXAMPLES = {}
for _name, _, _examples in TITLE_FAMILIES:
    FAMILY_EXAMPLES.setdefault(_name, _examples)
_COMPILED = [(name, re.compile(pattern, re.IGNORECASE)) for name, pattern, _ in TITLE_FAMILIES]

# Don't show a family's skill mix from fewer ads than this; the percentages would be noise.
MIN_ADS_FOR_SKILLS = 10


def classify_title(headline):
    """The family of a job-ad headline, or None if no family matches."""
    if not isinstance(headline, str) or not headline.strip():
        return None
    for name, pattern in _COMPILED:
        if pattern.search(headline):
            return name
    return None


def build_title_stats(ads, all_skills):
    """Summarise title families across ads.

    ads: one (headline, set of tracked skills the ad mentions) pair per Data/IT ad.
    Returns {total_ads, other_ads, titles: [{name, examples, ads, percent, skills}]},
    titles ranked by number of ads, where skills maps each tracked skill to the % of
    the family's ads that mention it (only for families with MIN_ADS_FOR_SKILLS ads)."""
    counts = {name: 0 for name in FAMILY_NAMES}
    skill_counts = {name: {skill: 0 for skill in all_skills} for name in FAMILY_NAMES}
    other = 0
    for headline, skills in ads:
        family = classify_title(headline)
        if family is None:
            other += 1
            continue
        counts[family] += 1
        for skill in skills:
            if skill in skill_counts[family]:
                skill_counts[family][skill] += 1

    total = len(ads)
    titles = []
    for name in FAMILY_NAMES:
        n = counts[name]
        titles.append({
            "name": name,
            "examples": FAMILY_EXAMPLES[name],
            "ads": n,
            "percent": round(100 * n / total, 1) if total else 0,
            "skills": {
                skill: round(100 * c / n) for skill, c in skill_counts[name].items()
            } if n >= MIN_ADS_FOR_SKILLS else {},
        })
    titles.sort(key=lambda t: (-t["ads"], FAMILY_NAMES.index(t["name"])))
    return {"total_ads": total, "other_ads": other, "titles": titles}
