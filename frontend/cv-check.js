// "Check your CV": reads a CV in the browser, finds the tracked skills in it and
// scores it against every live Data/IT ad (backend/data/ad_skills.json).
//
// Privacy: the file is read with FileReader and parsed here. Nothing about the CV is
// sent anywhere or stored; the PDF and Word parsers are plain libraries fetched from a
// CDN the first time someone picks such a file. Only "Use in my learning plan" saves
// anything, and that is just the skill names, in localStorage like the plan's own ticks.
//
// Scoring: an ad is a match when the CV has every tracked skill the ad names, or all
// but one (the skill tree's rule, see backend/skill_network.py), and at least one of
// them. Ads that name none of the 20 tracked skills are left out of the count, since
// they say nothing about these skills either way.

const PDFJS_URL = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
const PDFJS_WORKER_URL = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
const MAMMOTH_URL = 'https://cdn.jsdelivr.net/npm/mammoth@1.8.0/mammoth.browser.min.js';

const CV_MISSING_ALLOWED = 1;   // same as BUNDLE_MISSING_ALLOWED in skill_network.py
const CV_MIN_TITLE_ADS = 10;    // don't rank a title family on fewer ads than this
const CV_TITLES_SHOWN = 5;
const CV_GAPS_SHOWN = 3;
const CV_TREND_YEARS_BACK = 5;  // "since 2021" when the latest year is 2026
const CV_MAX_FILE_BYTES = 10 * 1024 * 1024;

// Used only until ad_skills.json exists (it carries the backend's own patterns).
// Mirrors SKILL_PATTERNS in backend/main.py.
const FALLBACK_SKILL_PATTERNS = {
    'Java': { source: '\\bjava\\b(?!\\s*script)', flags: 'i' },
    'JavaScript': { source: '\\bjavascript\\b|(?<![.\\w])JS\\b', flags: 'i' },
    'C#': { source: '(?<![\\w])C#|\\bC sharp\\b', flags: 'i' },
    'C++': { source: '(?<![\\w])C\\+\\+', flags: 'i' },
    'C': {
        source: '(?<![\\w#+./-])C(?![\\w#+-])(?=\\s*[,/&)]|\\s+(?:och|and|or|eller)\\b)|(?<=[,/(]\\s)C(?![\\w#+-])|(?<=[,/(])C(?![\\w#+-])',
        flags: '',
        context: { source: 'programmer|programming|utvecklare|developer|mjukvara|software|embedded|inbyggda|firmware|C\\+\\+', flags: 'i' }
    },
    'GCP': { source: '\\bGCP\\b|\\bgoogle cloud\\b', flags: 'i' },
    'AWS': { source: '\\baws\\b|\\bamazon web services\\b', flags: 'i' },
    'Kubernetes': { source: '\\bkubernetes\\b|\\bk8s\\b', flags: 'i' },
    'Git': { source: '\\bgit(?:hub|lab)?\\b', flags: 'i' },
    '.NET': { source: '(?<![\\w])\\.NET\\b|\\bdotnet\\b', flags: 'i' },
    'React': { source: '\\bReact(?:\\.js|JS)?\\b', flags: '' },
    'Microsoft 365': { source: '\\b(?:microsoft|office)\\s?365\\b|\\b[MO]365\\b', flags: 'i' },
    'Active Directory': { source: '\\bactive directory\\b|\\bentra id\\b|\\bmicrosoft entra\\b|\\bazure ad\\b', flags: 'i' }
};

// Common tools that aren't among the 20 tracked skills: shown on the CV, not scored.
const CV_OTHER_SKILLS = [
    ['Go', /\bGolang\b|\bGo\b(?=\s*(?:[,/)]|and\b|och\b|or\b))|(?<=[,/(]\s?)Go\b/],
    ['Rust', /\bRust\b/], ['Kotlin', /\bkotlin\b/i], ['Scala', /\bscala\b/i], ['Swift', /\bSwift\b/],
    ['PHP', /\bPHP\b/i], ['Ruby', /\bruby\b/i], ['R', /(?<=[,/(]\s?)R\b(?!&)|\bR\b(?=\s*[,/)])/],
    ['Kafka', /\bkafka\b/i], ['Spark', /\b(?:apache\s+)?spark\b|\bpyspark\b/i], ['Databricks', /\bdatabricks\b/i],
    ['Snowflake', /\bsnowflake\b/i], ['Airflow', /\bairflow\b/i], ['dbt', /\bdbt\b/i],
    ['PostgreSQL', /\bpostgre(?:s|sql)\b/i], ['MySQL', /\bmysql\b/i], ['MongoDB', /\bmongo(?:db)?\b/i],
    ['Redis', /\bredis\b/i], ['Elasticsearch', /\belastic(?:search)?\b/i],
    ['Power BI', /\bpower\s?bi\b/i], ['Tableau', /\btableau\b/i],
    ['Angular', /\bangular(?:js)?\b/i], ['Vue', /\bvue(?:\.js)?\b/i], ['Node.js', /\bnode(?:\.js|js)\b/i],
    ['Next.js', /\bnext\.js\b/i], ['Django', /\bdjango\b/i], ['Flask', /\bflask\b/i], ['Spring', /\bspring(?:\s?boot)?\b/i],
    ['Ansible', /\bansible\b/i], ['Jenkins', /\bjenkins\b/i], ['GitHub Actions', /\bgithub actions\b/i],
    ['Azure DevOps', /\bazure devops\b/i], ['Helm', /\bhelm\b/i], ['Prometheus', /\bprometheus\b/i], ['Grafana', /\bgrafana\b/i],
    ['PyTorch', /\bpytorch\b/i], ['TensorFlow', /\btensorflow\b/i], ['scikit-learn', /\bscikit[\s-]?learn\b|\bsklearn\b/i],
    ['Pandas', /\bpandas\b/i],
    ['SAP', /\bSAP\b/], ['Salesforce', /\bsalesforce\b/i], ['ServiceNow', /\bservicenow\b/i], ['Figma', /\bfigma\b/i]
];

const CV_SAMPLE = `Alex Lindqvist
Data Engineer

Profile
Data engineer with a background in backend development. I build data pipelines and platforms on Azure.

Experience
Data Engineer, Nordic Retail AB, Stockholm — March 2021 – present
Built batch and streaming pipelines in Python and SQL on Azure (Data Factory, Databricks). Infrastructure as code with Terraform, CI/CD in Azure DevOps, code in Git.

Backend Developer, Fintech Startup, Göteborg — Aug 2018 – Feb 2021
REST services in Java (Spring Boot) with PostgreSQL, deployed with Docker on Linux.

Education
MSc Computer Science, Chalmers, 2013 – 2018

Skills
Python, SQL, Java, Azure, Terraform, Docker, Linux, Git, Databricks, Kafka, PostgreSQL`;

let cvAdData = null;        // ad_skills.json, or null until the weekly job has written it
let cvAdDataLoaded = false;
let cvSkillMatchers = {};   // { skill: { pattern, context } }
let cvFoundSkills = new Set();   // tracked skills found in the CV
let cvChosenSkills = new Set();  // what the viewer kept ticked (starts as found)
let cvOtherSkills = [];
let cvExperience = null;    // { years, ranges } or null
let cvYearsOverride = null;
let cvTitleGuess = null;
let cvSourceName = '';
let cvHasCv = false;
let cvJobsFilter = 'all';   // jobs list tab: all | full | stretch
let cvHotTopics = [];       // Big Themes (hot-topics.js) the CV mentions; shown, not scored
let cvText = '';

function initCvCheck() {
    const fileInput = document.getElementById('cvFile');
    const drop = document.getElementById('cvDrop');
    if (!fileInput || !drop) return;

    fetch('../backend/data/ad_skills.json')
        .then(response => response.ok ? response.json() : null)
        .catch(() => null)
        .then(data => {
            cvAdData = data && Array.isArray(data.ads) && data.ads.length ? data : null;
            cvAdDataLoaded = true;
            cvSkillMatchers = buildCvMatchers((data && data.skill_patterns) || FALLBACK_SKILL_PATTERNS);
            renderCvCheck();
        });

    fileInput.addEventListener('change', () => {
        if (fileInput.files && fileInput.files[0]) readCvFile(fileInput.files[0]);
        fileInput.value = '';
    });
    ['dragenter', 'dragover'].forEach(type => drop.addEventListener(type, event => {
        event.preventDefault();
        drop.classList.add('is-dragging');
    }));
    ['dragleave', 'drop'].forEach(type => drop.addEventListener(type, event => {
        event.preventDefault();
        drop.classList.remove('is-dragging');
    }));
    drop.addEventListener('drop', event => {
        const file = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0];
        if (file) readCvFile(file);
    });

    const paste = document.getElementById('cvPaste');
    document.getElementById('cvPasteToggle')?.addEventListener('click', () => {
        paste.hidden = !paste.hidden;
        if (!paste.hidden) document.getElementById('cvText')?.focus();
    });
    document.getElementById('cvTextGo')?.addEventListener('click', () => {
        const text = document.getElementById('cvText').value;
        if (text.trim()) analyseCv(text, 'Pasted text');
    });
    document.getElementById('cvSample')?.addEventListener('click', () => analyseCv(CV_SAMPLE, 'Sample CV'));
}

function buildCvMatchers(patterns) {
    const matchers = {};
    const names = allSkills.length ? allSkills.map(skill => skill.name) : Object.keys(patterns);
    names.forEach(name => {
        const entry = patterns[name];
        try {
            matchers[name] = entry
                ? {
                    pattern: new RegExp(entry.source, entry.flags || ''),
                    context: entry.context ? new RegExp(entry.context.source, entry.context.flags || '') : null
                }
                : { pattern: new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i'), context: null };
        } catch (error) {
            console.warn(`Skill pattern for ${name} doesn't work in this browser`, error);
        }
    });
    return matchers;
}

function setCvStatus(text, isError = false) {
    const status = document.getElementById('cvStatus');
    if (!status) return;
    status.textContent = text;
    status.classList.toggle('is-error', isError);
}

function loadScript(url) {
    return new Promise((resolve, reject) => {
        const existing = document.querySelector(`script[data-src="${url}"]`);
        if (existing) {
            if (existing.dataset.loaded) return resolve();
            existing.addEventListener('load', () => resolve());
            existing.addEventListener('error', () => reject(new Error(`Couldn't load ${url}`)));
            return;
        }
        const script = document.createElement('script');
        script.src = url;
        script.dataset.src = url;
        script.async = true;
        script.addEventListener('load', () => { script.dataset.loaded = '1'; resolve(); });
        script.addEventListener('error', () => reject(new Error(`Couldn't load ${url}`)));
        document.head.appendChild(script);
    });
}

function readAsArrayBuffer(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error);
        reader.readAsArrayBuffer(file);
    });
}

async function pdfToText(buffer) {
    await loadScript(PDFJS_URL);
    const pdfjs = window.pdfjsLib;
    pdfjs.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_URL;
    const pdf = await pdfjs.getDocument({ data: new Uint8Array(buffer) }).promise;
    const pages = [];
    for (let number = 1; number <= pdf.numPages; number++) {
        const page = await pdf.getPage(number);
        const content = await page.getTextContent();
        let text = '';
        let lastY = null;
        content.items.forEach(item => {
            const y = item.transform ? item.transform[5] : null;
            if (lastY !== null && y !== null && Math.abs(y - lastY) > 2) text += '\n';
            else if (text && !text.endsWith(' ') && !text.endsWith('\n')) text += ' ';
            text += item.str;
            if (item.hasEOL) text += '\n';
            lastY = y;
        });
        pages.push(text);
    }
    return pages.join('\n');
}

async function docxToText(buffer) {
    await loadScript(MAMMOTH_URL);
    const result = await window.mammoth.extractRawText({ arrayBuffer: buffer });
    return result.value;
}

async function readCvFile(file) {
    if (file.size > CV_MAX_FILE_BYTES) {
        setCvStatus('That file is over 10 MB. Try a smaller PDF, or paste the text instead.', true);
        return;
    }
    const name = file.name || 'CV';
    const lower = name.toLowerCase();
    setCvStatus(`Reading ${name}…`);
    try {
        const buffer = await readAsArrayBuffer(file);
        let text;
        if (lower.endsWith('.pdf') || file.type === 'application/pdf') {
            text = await pdfToText(buffer);
        } else if (lower.endsWith('.docx')) {
            text = await docxToText(buffer);
        } else if (lower.endsWith('.doc')) {
            setCvStatus('Old Word files (.doc) can\'t be read here. Save it as .docx or PDF, or paste the text.', true);
            return;
        } else {
            text = new TextDecoder('utf-8').decode(buffer);
        }
        if (!text || text.replace(/\s/g, '').length < 30) {
            setCvStatus(`Found almost no text in ${name}. If it's a scanned PDF, paste the text instead.`, true);
            return;
        }
        analyseCv(text, name);
    } catch (error) {
        console.error('Reading the CV failed', error);
        setCvStatus(`Couldn't read ${name}. Try a PDF or .docx, or paste the text instead.`, true);
    }
}

function findTrackedSkills(text) {
    const found = new Set();
    Object.entries(cvSkillMatchers).forEach(([name, matcher]) => {
        if (matcher.pattern.test(text) && (!matcher.context || matcher.context.test(text))) found.add(name);
    });
    return found;
}

function findOtherSkills(text, tracked) {
    return CV_OTHER_SKILLS
        .filter(([name, pattern]) => !tracked.has(name) && pattern.test(text))
        .map(([name]) => name);
}

// ---------- Experience: add up the date ranges outside the education section ----------

const CV_MONTHS = {
    jan: 0, feb: 1, mar: 2, apr: 3, may: 4, maj: 4, jun: 5, jul: 6, aug: 7,
    sep: 8, okt: 9, oct: 9, nov: 10, dec: 11
};
const CV_DATE = String.raw`(?:(?:\b(jan|feb|mar|apr|may|maj|jun|jul|aug|sep|okt|oct|nov|dec)[a-zåäö]*\.?\s*)|(\d{1,2})\s*[/.]\s*)?((?:19|20)\d{2})(?:\s*[-/.]\s*(\d{1,2})(?!\d))?`;
const CV_PRESENT = String.raw`present|now|current(?:ly)?|today|ongoing|date|nu|idag|pågående|tills vidare`;
const CV_RANGE = new RegExp(`${CV_DATE}\\s*(?:–|—|-|−|to|till|until|→)\\s*(?:${CV_DATE}|(${CV_PRESENT}))`, 'gi');
const CV_EDUCATION_HEAD = /^(?:education|academic|studies|utbildning(?:ar)?|studier|certifi\w*|courses|kurser)\b/i;
const CV_OTHER_HEAD = /^(?:experience|work|employment|professional|career|arbetslivserfarenhet|erfarenhet|anställningar|uppdrag|projects?|projekt|skills|kompetens\w*|languages|språk|profile|profil|summary|sammanfattning|references|referenser|interests|intressen)\b/i;

function monthIndex(monthName, monthNumber, yearMonth, year) {
    let month = 0;
    if (monthName) month = CV_MONTHS[monthName.slice(0, 3).toLowerCase()] ?? 0;
    else if (monthNumber) month = Math.min(Math.max(Number(monthNumber) - 1, 0), 11);
    else if (yearMonth && Number(yearMonth) >= 1 && Number(yearMonth) <= 12) month = Number(yearMonth) - 1;
    return Number(year) * 12 + month;
}

function estimateExperience(text) {
    const now = new Date();
    const nowIndex = now.getFullYear() * 12 + now.getMonth();
    const intervals = [];
    let inEducation = false;
    text.split(/\r?\n/).forEach(rawLine => {
        const line = rawLine.trim();
        if (!line) return;
        if (line.length <= 40) {
            if (CV_EDUCATION_HEAD.test(line)) inEducation = true;
            else if (CV_OTHER_HEAD.test(line)) inEducation = false;
        }
        if (inEducation) return;
        for (const match of line.matchAll(CV_RANGE)) {
            const start = monthIndex(match[1], match[2], match[4], match[3]);
            let end;
            if (match[9]) end = nowIndex;
            else if (match[7]) {
                end = monthIndex(match[5], match[6], match[8], match[7]);
                // "2018 – 2021" without months: count the end year in full.
                if (!match[5] && !match[6] && !match[8]) end += 11;
            } else continue;
            if (end < start || start < 1970 * 12 || end > nowIndex + 1 || end - start > 45 * 12) continue;
            intervals.push([start, end + 1]);
        }
    });
    if (!intervals.length) return null;
    intervals.sort((a, b) => a[0] - b[0]);
    let months = 0;
    let [curStart, curEnd] = intervals[0];
    intervals.slice(1).forEach(([start, end]) => {
        if (start <= curEnd) curEnd = Math.max(curEnd, end);
        else {
            months += curEnd - curStart;
            [curStart, curEnd] = [start, end];
        }
    });
    months += curEnd - curStart;
    return { years: Math.round(months / 12 * 2) / 2, ranges: intervals.length };
}

// The job title the CV opens with: the first title family in the first few lines.
function guessTitle(text) {
    const patterns = (cvAdData && cvAdData.title_patterns) || [];
    if (!patterns.length) return null;
    const head = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean).slice(0, 6);
    for (const line of head) {
        if (line.length > 80) continue;
        for (const entry of patterns) {
            try {
                if (new RegExp(entry.source, entry.flags).test(line)) return entry.title;
            } catch { /* a pattern this browser can't compile; skip it */ }
        }
    }
    return null;
}

function analyseCv(text, sourceName) {
    if (!cvAdDataLoaded) {
        setCvStatus('Still loading the job ads, try again in a moment.');
        return;
    }
    cvFoundSkills = findTrackedSkills(text);
    cvChosenSkills = new Set(cvFoundSkills);
    cvOtherSkills = findOtherSkills(text, cvFoundSkills);
    cvText = text;
    cvExperience = estimateExperience(text);
    cvYearsOverride = null;
    cvTitleGuess = guessTitle(text);
    cvSourceName = sourceName;
    cvHasCv = true;
    const count = cvFoundSkills.size;
    setCvStatus(count
        ? `${sourceName}: found ${count} of the ${Object.keys(cvSkillMatchers).length} tracked skills. Untick any that are wrong, or tick ones it missed.`
        : `${sourceName}: found none of the tracked skills. Tick the ones you have below.`);
    renderCvCheck();
    if (window.matchMedia && window.matchMedia('(max-width: 900px)').matches) {
        document.querySelector('.cv-result-card')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
}

// ---------- Scoring ----------

function cvMask(skills) {
    if (!cvAdData) return 0;
    let mask = 0;
    cvAdData.skills.forEach((name, i) => { if (skills.has(name)) mask |= (1 << i); });
    return mask;
}

function popcount(n) {
    let count = 0;
    while (n) { n &= n - 1; count++; }
    return count;
}

function cvAdsForLocation() {
    if (!cvAdData) return [];
    if (selectedLocation === 'Sweden') return cvAdData.ads;
    const index = cvAdData.locations.indexOf(selectedLocation);
    return index === -1 ? [] : cvAdData.ads.filter(ad => ad[2] === index);
}

function isCvMatch(adMask, mask) {
    return (adMask & mask) !== 0 && popcount(adMask & ~mask) <= CV_MISSING_ALLOWED;
}

function scoreCv(mask, ads) {
    let relevant = 0, matches = 0, full = 0;
    for (const ad of ads) {
        if (!ad[0]) continue;
        relevant++;
        if (isCvMatch(ad[0], mask)) {
            matches++;
            if ((ad[0] & ~mask) === 0) full++;
        }
    }
    return { relevant, matches, full, percent: relevant ? 100 * matches / relevant : 0 };
}

function cvTitleFits(mask, ads) {
    const byTitle = {};
    for (const ad of ads) {
        if (!ad[0] || ad[1] < 0) continue;
        const entry = (byTitle[ad[1]] ??= { relevant: 0, matches: 0 });
        entry.relevant++;
        if (isCvMatch(ad[0], mask)) entry.matches++;
    }
    return Object.entries(byTitle)
        .filter(([, entry]) => entry.relevant >= CV_MIN_TITLE_ADS)
        .map(([index, entry]) => ({
            name: cvAdData.titles[index],
            ...entry,
            percent: 100 * entry.matches / entry.relevant
        }))
        .sort((a, b) => b.percent - a.percent || b.matches - a.matches);
}

function cvBestGaps(mask, ads, base) {
    return cvAdData.skills
        .map((name, i) => ({ name, bit: 1 << i }))
        .filter(skill => !(mask & skill.bit))
        .map(skill => {
            const score = scoreCv(mask | skill.bit, ads);
            return { name: skill.name, percent: score.percent, gain: score.matches - base.matches };
        })
        .filter(skill => skill.gain > 0)
        .sort((a, b) => b.gain - a.gain)
        .slice(0, CV_GAPS_SHOWN);
}

function cvSeniority(mask, ads) {
    const counts = { matches: 0, junior: 0, senior: 0, experience: 0, openToNew: 0 };
    for (const ad of ads) {
        if (!ad[0] || !isCvMatch(ad[0], mask)) continue;
        counts.matches++;
        if (ad[3] === 1) counts.junior++;
        if (ad[3] === 2) counts.senior++;
        if (ad[4]) counts.experience++;
        if (ad[3] === 1 || (!ad[4] && ad[3] !== 2)) counts.openToNew++;
    }
    return counts;
}

// Share of Data/IT ads naming each CV skill in the latest year vs a few years before.
function cvSkillTrends(skills) {
    const yearly = (typeof historicalYearly !== 'undefined' && historicalYearly[selectedLocation]) || {};
    const years = typeof validHistoryYears === 'function' ? validHistoryYears(yearly) : Object.keys(yearly).sort();
    if (years.length < 2) return [];
    const latest = years[years.length - 1];
    const earlier = years.includes(String(Number(latest) - CV_TREND_YEARS_BACK))
        ? String(Number(latest) - CV_TREND_YEARS_BACK) : years[0];
    const share = (year, skill) => yearly[year].total ? 100 * (yearly[year].skills[skill] || 0) / yearly[year].total : 0;
    return [...skills].map(skill => ({
        name: skill,
        then: share(earlier, skill),
        now: share(latest, skill),
        earlier,
        latest
    })).sort((a, b) => (b.now - b.then) - (a.now - a.then));
}

// ---------- Rendering ----------

function renderCvCheck() {
    renderCvFound();
    renderCvResults();
}

function skillCategoryOf(name) {
    const skill = allSkills.find(s => s.name === name);
    return skill ? skill.category : null;
}

function renderCvFound() {
    const container = document.getElementById('cvFound');
    if (!container) return;
    container.hidden = !cvHasCv;
    if (!cvHasCv) return;
    container.innerHTML = '';

    const heading = document.createElement('p');
    heading.className = 'skill-category-label';
    heading.textContent = 'Tracked skills on your CV';
    container.appendChild(heading);

    const group = document.createElement('div');
    group.className = 'skill-picker-group';
    const names = allSkills.length ? allSkills.map(skill => skill.name) : Object.keys(cvSkillMatchers);
    // Found skills first, then the rest so missed ones can be ticked.
    const ordered = [...names.filter(n => cvFoundSkills.has(n)), ...names.filter(n => !cvFoundSkills.has(n))];
    ordered.forEach(name => {
        const row = document.createElement('label');
        row.className = 'skill-check-row' + (cvFoundSkills.has(name) ? '' : ' cv-not-found');
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = cvChosenSkills.has(name);
        checkbox.addEventListener('change', () => {
            if (checkbox.checked) cvChosenSkills.add(name); else cvChosenSkills.delete(name);
            renderCvResults();
        });
        const swatch = document.createElement('span');
        swatch.className = 'skill-swatch';
        swatch.style.backgroundColor = categoryColor(skillCategoryOf(name));
        const label = document.createElement('span');
        label.className = 'skill-label';
        label.textContent = name;
        row.append(checkbox, swatch, label);
        group.appendChild(row);
    });
    container.appendChild(group);

    if (cvOtherSkills.length) {
        const otherHead = document.createElement('p');
        otherHead.className = 'skill-category-label';
        otherHead.textContent = 'Also on your CV (not scored)';
        container.appendChild(otherHead);
        const other = document.createElement('div');
        other.className = 'cv-other';
        cvOtherSkills.forEach(name => {
            const chip = document.createElement('span');
            chip.className = 'co-occurrence-chip';
            chip.textContent = name;
            other.appendChild(chip);
        });
        container.appendChild(other);
    }

    cvHotTopics = typeof hotTopicsInText === 'function' ? hotTopicsInText(cvText) : [];
    if (cvHotTopics.length) {
        const hotHead = document.createElement('p');
        hotHead.className = 'skill-category-label';
        hotHead.textContent = 'Big Themes on your CV (not scored)';
        container.appendChild(hotHead);
        const hot = document.createElement('div');
        hot.className = 'cv-other';
        cvHotTopics.forEach(name => {
            const chip = document.createElement('button');
            chip.type = 'button';
            chip.className = 'co-occurrence-chip hot-chip-link';
            chip.textContent = name;
            chip.title = `See ${name} in Big Themes`;
            chip.addEventListener('click', () => selectHotTopic(name, { scroll: true }));
            hot.appendChild(chip);
        });
        container.appendChild(hot);
    }

    const expHead = document.createElement('p');
    expHead.className = 'skill-category-label';
    expHead.textContent = 'Experience';
    container.appendChild(expHead);
    const exp = document.createElement('div');
    exp.className = 'cv-experience';
    const input = document.createElement('input');
    input.type = 'number';
    input.min = '0';
    input.max = '50';
    input.step = '0.5';
    input.id = 'cvYears';
    input.value = cvYearsOverride ?? (cvExperience ? cvExperience.years : '');
    input.placeholder = '?';
    input.addEventListener('input', () => {
        const value = parseFloat(input.value);
        cvYearsOverride = Number.isFinite(value) && value >= 0 ? value : null;
        renderCvResults();
    });
    const label = document.createElement('label');
    label.htmlFor = 'cvYears';
    label.textContent = 'years of work experience';
    const note = document.createElement('span');
    note.className = 'cv-note';
    note.textContent = cvExperience
        ? `Added up from ${cvExperience.ranges} date range${cvExperience.ranges === 1 ? '' : 's'} outside your education. Change it if it's off.`
        : 'No work dates found. Enter your years to compare with junior and senior ads.';
    exp.append(input, label, note);
    container.appendChild(exp);
}

function cvYears() {
    return cvYearsOverride ?? (cvExperience ? cvExperience.years : null);
}

function fmtPercent(value) {
    return value >= 10 || value === 0 ? `${Math.round(value)}%` : `${value.toFixed(1)}%`;
}

function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

function renderCvResults() {
    const container = document.getElementById('cvResults');
    if (!container || !cvHasCv) return;
    container.innerHTML = '';
    renderCvJobs();
    const locationName = selectedLocation === 'Sweden' ? 'Sweden' : selectedLocation;

    if (!cvAdData) {
        container.append(
            el('p', 'cv-score-label', 'Your match with live Data/IT ads'),
            el('p', 'cv-empty-score', '–'),
            el('p', 'cv-note', 'The match score needs the per-ad skill data from the weekly update, which hasn\'t run yet. It shows here after the next one. Your skills and their trends are below.')
        );
        appendCvTrends(container);
        appendCvPlanButton(container);
        return;
    }

    const mask = cvMask(cvChosenSkills);
    const ads = cvAdsForLocation();
    const score = scoreCv(mask, ads);

    // Headline score
    const head = el('div', 'cv-score');
    const ring = el('div', 'cv-ring');
    ring.style.setProperty('--p', Math.min(score.percent, 100).toFixed(1));
    ring.setAttribute('role', 'img');
    ring.setAttribute('aria-label', `${fmtPercent(score.percent)} of ads matched`);
    ring.appendChild(el('span', 'cv-ring-value', fmtPercent(score.percent)));
    const text = el('div', 'cv-score-text');
    text.append(
        el('p', 'cv-score-label', `Your match, ${locationName}`),
        el('p', 'cv-score-main', cvChosenSkills.size
            ? `You fit ${score.matches.toLocaleString('en-US')} of ${score.relevant.toLocaleString('en-US')} live Data/IT ads`
            : 'Tick at least one skill to see your match'),
        el('p', 'cv-note', `${score.full.toLocaleString('en-US')} ask for nothing you lack; the rest ask for one tracked skill you don't list. Counts the ads that name any of the 20 tracked skills.`)
    );
    head.append(ring, text);
    container.appendChild(head);

    if (!cvChosenSkills.size) return;

    // Best-fit titles
    const fits = cvTitleFits(mask, ads);
    if (fits.length) {
        const block = el('div', 'cv-block');
        block.appendChild(el('h4', 'cv-subhead', 'Job titles that fit you best'));
        if (cvTitleGuess) {
            const guess = fits.find(f => f.name === cvTitleGuess);
            block.appendChild(el('p', 'cv-note', guess
                ? `Your CV reads as ${cvTitleGuess}: you fit ${fmtPercent(guess.percent)} of those ads.`
                : `Your CV reads as ${cvTitleGuess}.`));
        }
        // The top few, plus the title the CV reads as when it ranks lower.
        const shown = fits.slice(0, CV_TITLES_SHOWN);
        const guessFit = fits.find(f => f.name === cvTitleGuess);
        if (guessFit && !shown.includes(guessFit)) shown.push(guessFit);
        const max = Math.max(...shown.map(f => f.percent), 1);
        shown.forEach(fit => {
            const row = el('button', 'cv-bar-row' + (fit.name === cvTitleGuess ? ' is-guess' : ''));
            row.type = 'button';
            row.title = `See ${fit.name} in Job Titles`;
            row.addEventListener('click', () => {
                if (typeof selectTitle === 'function') selectTitle(fit.name, { scroll: true });
            });
            const bar = el('span', 'cv-bar');
            const fill = el('span', 'cv-bar-fill');
            fill.style.width = `${(100 * fit.percent / max).toFixed(1)}%`;
            bar.appendChild(fill);
            row.append(
                el('span', 'cv-bar-name', fit.name),
                bar,
                el('span', 'cv-bar-value', fmtPercent(fit.percent)),
                el('span', 'cv-bar-sub', `${fit.matches} of ${fit.relevant} ads`)
            );
            block.appendChild(row);
        });
        container.appendChild(block);
    }

    // What to learn next
    const gaps = cvBestGaps(mask, ads, score);
    if (gaps.length) {
        const block = el('div', 'cv-block');
        block.appendChild(el('h4', 'cv-subhead', 'Learn next for the biggest jump'));
        gaps.forEach((gap, index) => {
            const row = el('div', 'cv-gap');
            const top = el('div', 'cv-gap-head');
            const swatch = el('span', 'skill-swatch');
            swatch.style.backgroundColor = categoryColor(skillCategoryOf(gap.name));
            const name = el('span', 'cv-gap-name');
            name.append(el('span', 'skill-gap-rank', String(index + 1).padStart(2, '0')), swatch, document.createTextNode(gap.name));
            top.append(name, el('span', 'cv-gap-value', `+${gap.gain.toLocaleString('en-US')} ads → ${fmtPercent(gap.percent)}`));
            row.appendChild(top);
            const courses = (typeof coursesData !== 'undefined' && coursesData[gap.name]) || [];
            if (courses.length) {
                const links = el('div', 'skill-gap-courses');
                courses.forEach(course => {
                    const link = el('a', '', `${course.title} (${course.platform})`);
                    link.href = course.url;
                    link.target = '_blank';
                    link.rel = 'noopener noreferrer';
                    links.appendChild(link);
                });
                row.appendChild(links);
            }
            block.appendChild(row);
        });
        container.appendChild(block);
    }

    // Experience vs what the matching ads ask for
    const level = cvSeniority(mask, ads);
    if (level.matches) {
        const block = el('div', 'cv-block');
        block.appendChild(el('h4', 'cv-subhead', 'Experience'));
        const years = cvYears();
        const pct = n => fmtPercent(100 * n / level.matches);
        let summary = `Of the ads you fit, ${pct(level.senior)} say senior or lead in the title, ${pct(level.junior)} say junior or graduate, and ${pct(level.experience)} ask for earlier experience.`;
        if (years !== null) {
            if (years < 2) summary += ` With about ${years} year${years === 1 ? '' : 's'}, aim for the ${level.openToNew.toLocaleString('en-US')} that are junior or don't ask for experience.`;
            else if (years >= 5) summary += ` With about ${years} years, the ${level.senior.toLocaleString('en-US')} senior ads are within reach too.`;
            else summary += ` With about ${years} years, most of these are open to you; senior roles usually want 5 or more.`;
        }
        block.appendChild(el('p', 'cv-text', summary));
        container.appendChild(block);
    }

    appendCvTrends(container);
    appendCvPlanButton(container);
}

function appendCvTrends(container) {
    const trends = cvSkillTrends(cvChosenSkills);
    if (!trends.length) return;
    const block = el('div', 'cv-block');
    block.appendChild(el('h4', 'cv-subhead', `Your skills, ${trends[0].earlier} to ${trends[0].latest}`));
    block.appendChild(el('p', 'cv-note', 'Share of Data/IT ads that year that name the skill, from the history chart.'));
    const list = el('div', 'cv-trends');
    trends.forEach(trend => {
        const diff = trend.now - trend.then;
        const className = Math.abs(diff) < 0.5 ? 'trend-flat' : diff > 0 ? 'trend-up' : 'trend-down';
        const arrow = className === 'trend-flat' ? '→' : diff > 0 ? '▲' : '▼';
        const chip = el('span', 'cv-trend');
        chip.append(
            el('span', 'cv-trend-name', trend.name),
            el('span', 'cv-trend-then', fmtPercent(trend.then)),
            el('span', `cv-trend-value ${className}`, `${arrow} ${fmtPercent(trend.now)}`)
        );
        chip.title = `${fmtPercent(trend.then)} in ${trend.earlier}, ${fmtPercent(trend.now)} in ${trend.latest}`;
        list.appendChild(chip);
    });
    block.appendChild(list);
    container.appendChild(block);
}

function appendCvPlanButton(container) {
    if (!cvChosenSkills.size || typeof knownSkills === 'undefined') return;
    const row = el('div', 'cv-actions');
    const button = el('button', 'location-pill', 'Use these skills in my learning plan');
    button.type = 'button';
    button.addEventListener('click', () => {
        knownSkills.clear();
        cvChosenSkills.forEach(skill => knownSkills.add(skill));
        try { saveKnownSkills(); } catch { /* storage blocked: the plan still updates */ }
        renderSkillPicker();
        renderSkillGapResults();
        document.getElementById('plan')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    row.appendChild(button);
    container.appendChild(row);
}

// ---------- The matching ads themselves ----------

const CV_STRETCH_MISSING = 2;    // "Stretch" tab: ads that ask for two skills you don't list
const CV_SKILL_WEIGHT = 0.75;    // match % = 75% skills + 25% experience
const CV_SENIOR_YEARS = 5;       // a senior or lead ad counts as a full fit from here
const CV_EXPERIENCED_YEARS = 2;  // an ad that asks for experience counts as a full fit from here

// How well the CV's years fit what an ad says about level. Ads give no year counts,
// only flags: ad[3] = 0 none, 1 junior/graduate, 2 senior/lead; ad[4] = asks for
// earlier experience. Returns null when the CV gives no years to compare.
function cvExperienceFit(ad, years) {
    if (years === null || years === undefined) return null;
    if (ad[3] === 2) {
        const fit = Math.min(1, years / CV_SENIOR_YEARS);
        return { fit, label: fit >= 1 ? 'experience fits' : 'senior role' };
    }
    if (ad[3] === 1) return { fit: 1, label: 'junior role, experience fits' };
    if (ad[4]) {
        const fit = Math.min(1, 0.5 + years / (2 * CV_EXPERIENCED_YEARS));
        return { fit, label: fit >= 1 ? 'experience fits' : 'asks for experience' };
    }
    return { fit: 1, label: 'no level asked' };
}

// Every ad for the chosen skills and location that misses at most two tracked
// skills, with its match %: the share of the ad's tracked skills the CV has,
// blended with the experience fit when the CV gives years.
function cvMatchingJobs() {
    if (!cvAdData || !Array.isArray(cvAdData.listings)) return [];
    const mask = cvMask(cvChosenSkills);
    if (!mask) return [];
    const years = cvYears();
    const cityIndex = selectedLocation === 'Sweden' ? null : cvAdData.locations.indexOf(selectedLocation);
    const jobs = [];
    cvAdData.ads.forEach((ad, i) => {
        if (cityIndex !== null && ad[2] !== cityIndex) return;
        if (!ad[0] || !(ad[0] & mask)) return;
        const missingCount = popcount(ad[0] & ~mask);
        if (missingCount > CV_STRETCH_MISSING) return;
        const listing = cvAdData.listings[i];
        if (!listing) return;
        const have = [], missing = [];
        cvAdData.skills.forEach((name, bit) => {
            if (!(ad[0] & (1 << bit))) return;
            (mask & (1 << bit) ? have : missing).push(name);
        });
        const skillFit = have.length / (have.length + missing.length);
        const experience = cvExperienceFit(ad, years);
        const match = experience
            ? CV_SKILL_WEIGHT * skillFit + (1 - CV_SKILL_WEIGHT) * experience.fit
            : skillFit;
        jobs.push({
            id: listing[0], headline: listing[1], employer: listing[2], place: listing[3], published: listing[4],
            have, missing, experience, percent: Math.round(100 * match),
            full: missing.length === 0, stretch: missing.length === CV_STRETCH_MISSING
        });
    });
    // Ties: ads naming more of your skills first (stronger evidence), then the newest.
    return jobs.sort((a, b) => b.percent - a.percent || b.have.length - a.have.length || b.published.localeCompare(a.published));
}

// The one skill that would turn the most of these jobs into full matches, and what
// it does to the overall score.
function cvJobsNextSkill(jobs) {
    const gained = {};
    jobs.forEach(job => {
        if (job.missing.length === 1) gained[job.missing[0]] = (gained[job.missing[0]] || 0) + 1;
    });
    const best = Object.entries(gained).sort((a, b) => b[1] - a[1])[0];
    if (!best) return null;
    const [name, count] = best;
    const mask = cvMask(cvChosenSkills);
    const ads = cvAdsForLocation();
    const before = scoreCv(mask, ads);
    const after = scoreCv(mask | (1 << cvAdData.skills.indexOf(name)), ads);
    return { name, count, before: before.percent, after: after.percent };
}

function formatJobDate(iso) {
    const date = new Date(`${iso}T00:00:00Z`);
    if (!iso || isNaN(date)) return '';
    return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
}

function matchLevel(percent) {
    if (percent >= 80) return 'is-high';
    if (percent >= 60) return 'is-mid';
    return 'is-low';
}

function renderCvNextSkill(card, jobs) {
    const next = cvJobsNextSkill(jobs);
    if (!next) return;
    const box = el('div', 'cv-next-skill');
    const text = el('p', 'cv-next-skill-text');
    const plural = next.count === 1 ? 'job becomes a full match' : 'jobs become full matches';
    text.append(
        el('span', 'cv-next-skill-label', 'Learn this next'),
        document.createTextNode(' Add '),
        el('strong', '', next.name),
        document.createTextNode(` to your CV and ${next.count.toLocaleString('en-US')} of these ${plural}. `
            + `Your overall score goes from ${fmtPercent(next.before)} to ${fmtPercent(next.after)}.`)
    );
    box.appendChild(text);
    const courses = (typeof coursesData !== 'undefined' && coursesData[next.name]) || [];
    if (courses.length) {
        const links = el('div', 'skill-gap-courses');
        courses.forEach(course => {
            const link = el('a', '', `${course.title} (${course.platform})`);
            link.href = course.url;
            link.target = '_blank';
            link.rel = 'noopener noreferrer';
            links.appendChild(link);
        });
        box.appendChild(links);
    }
    card.appendChild(box);
}

function renderCvJobs() {
    const card = document.getElementById('cvJobs');
    if (!card) return;
    const every = cvHasCv ? cvMatchingJobs() : [];
    const matches = every.filter(job => !job.stretch);
    card.hidden = !every.length;
    if (!every.length) return;
    card.innerHTML = '';

    const counts = {
        all: matches.length,
        full: matches.filter(job => job.full).length,
        stretch: every.length - matches.length
    };
    if (!counts[cvJobsFilter]) cvJobsFilter = counts.all ? 'all' : 'stretch';
    const jobs = cvJobsFilter === 'full' ? matches.filter(job => job.full)
        : cvJobsFilter === 'stretch' ? every.filter(job => job.stretch)
        : matches;
    const where = selectedLocation === 'Sweden' ? 'in Sweden' : `in ${selectedLocation}`;
    const years = cvYears();

    const head = el('header', 'card-head cv-jobs-head');
    const titles = el('div');
    titles.append(
        el('h3', '', `Jobs that match your CV ${where}`),
        el('p', 'card-sub', 'Live ads on Arbetsförmedlingen\'s Platsbanken, best match first. '
            + (years === null
                ? 'Match % is the share of the ad\'s tracked skills on your CV; add your years of experience above to include them.'
                : 'Match % blends the ad\'s tracked skills on your CV (75%) with how your experience fits its level (25%).')
            + ' ✓ = on your CV, ✗ = missing.')
    );
    const filter = el('div', 'pill-group-tabs cv-jobs-filter');
    [['all', 'All matches'], ['full', 'Full matches'], ['stretch', 'Stretch']].forEach(([key, label]) => {
        const button = el('button', 'location-pill' + (cvJobsFilter === key ? ' location-pill-active' : ''),
            `${label} · ${counts[key].toLocaleString('en-US')}`);
        button.type = 'button';
        button.disabled = !counts[key];
        if (key === 'stretch') button.title = 'Ads that ask for two tracked skills your CV doesn\'t list';
        button.addEventListener('click', () => {
            cvJobsFilter = key;
            renderCvJobs();
        });
        filter.appendChild(button);
    });
    head.append(titles, filter);
    card.appendChild(head);

    renderCvNextSkill(card, every);

    const list = el('ol', 'cv-jobs-list');
    jobs.forEach(job => {
        const item = el('li', 'cv-job');
        const title = job.id && cvAdData.url_base ? el('a', 'cv-job-title', job.headline || 'Untitled ad') : el('span', 'cv-job-title', job.headline || 'Untitled ad');
        if (title.tagName === 'A') {
            title.href = cvAdData.url_base + encodeURIComponent(job.id);
            title.target = '_blank';
            title.rel = 'noopener noreferrer';
        }
        const meta = el('p', 'cv-job-meta', [job.employer, job.place, formatJobDate(job.published)].filter(Boolean).join(' · '));

        const total = job.have.length + job.missing.length;
        const match = el('div', `cv-job-match ${matchLevel(job.percent)}`);
        const bar = el('div', 'cv-job-bar');
        bar.setAttribute('role', 'meter');
        bar.setAttribute('aria-valuemin', '0');
        bar.setAttribute('aria-valuemax', '100');
        bar.setAttribute('aria-valuenow', String(job.percent));
        bar.setAttribute('aria-label', 'Match');
        const fill = el('span', 'cv-job-bar-fill');
        fill.style.width = `${job.percent}%`;
        bar.appendChild(fill);
        const detail = [`${job.have.length} of ${total} skill${total === 1 ? '' : 's'}`];
        if (job.experience) detail.push(job.experience.label);
        match.append(
            el('span', 'cv-job-match-value', `Match ${job.percent}%`),
            bar,
            el('span', 'cv-job-match-detail', detail.join(' · '))
        );

        const skills = el('div', 'cv-job-skills');
        job.have.forEach(name => skills.appendChild(el('span', 'cv-job-skill is-have', `✓ ${name}`)));
        job.missing.forEach(name => {
            const chip = el('span', 'cv-job-skill is-missing', `✗ ${name}`);
            chip.title = `This ad also asks for ${name}, which your CV doesn't list`;
            skills.appendChild(chip);
        });
        item.append(title, meta, match, skills);
        list.appendChild(item);
    });
    card.appendChild(list);

    card.appendChild(el('p', 'cv-jobs-count', `${jobs.length.toLocaleString('en-US')} ads · scroll the list to see them all · skills outside the 20 tracked ones aren't counted`));
}
