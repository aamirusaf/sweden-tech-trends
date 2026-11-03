// "Job Titles": what employers call the job in the headline of a Data/IT ad, and which
// of the tracked skills each kind of job asks for.
// Data: backend/data/job_titles.json (live ads, weekly) and
// backend/data/historical_titles_monthly.csv (Historical Ads, since 2006); the title
// families are defined in backend/job_titles.py.
// Linked both ways with the skill tree in skill-network.js: picking a title lights up
// its typical skills in the tree, and a skill's panel in the tree lists the titles that
// ask for it most. Relies on categoryColor, rawCategoryData, historicalYearly,
// validHistoryYears and isDarkMode from app.js.

// A skill is "typical" for a title when at least this share of the title's ads mention it.
const TYPICAL_SKILL_PERCENT = 20;
const TYPICAL_SKILLS_MAX = 6;
// Titles with fewer live ads than this are left out of the heatmap and skill lists.
const MIN_TITLE_ADS = 10;
const TITLES_SHOWN = 12;
const HEATMAP_ROWS = 30; // every title with enough ads; AI and data roles are small but asked about most

let jobTitles = null;         // job_titles.json
let titleHistory = {};        // { title: { year: share% } }
let titleYears = [];          // years shown in the sparklines
let selectedTitle = null;
let showAllTitles = false;
let heatmapSkill = null;      // column highlighted in the heatmap

function renderJobTitles(data, historyCsv) {
    jobTitles = data && Array.isArray(data.titles) && data.total_ads ? data : null;
    titleHistory = aggregateTitleHistory(historyCsv);
    if (jobTitles && !jobTitles.titles.some(t => t.name === selectedTitle)) {
        selectedTitle = jobTitles.titles[0]?.name || null;
    }
    drawJobTitles();
}

function aggregateTitleHistory(csvText) {
    // CSV columns: month,title,it_ads,it_total_ads (nationwide, Data/IT ads only).
    const ads = {};
    const totals = {};
    const lines = (csvText || '').trim().split('\n');
    for (const line of lines.slice(1)) {
        const [month, title, itAds, itTotal] = line.split(',');
        if (!month || !title) continue;
        const year = month.slice(0, 4);
        ((ads[title] ??= {})[year] = (ads[title][year] || 0) + Number(itAds));
        (totals[year] ??= {})[month] = Number(itTotal);
    }
    // Same years as the skills history chart, so both start where the data is reliable.
    titleYears = typeof validHistoryYears === 'function'
        ? validHistoryYears(historicalYearly.Sweden || {}).filter(year => totals[year])
        : Object.keys(totals).sort();
    const byTitle = {};
    Object.entries(ads).forEach(([title, years]) => {
        byTitle[title] = {};
        titleYears.forEach(year => {
            const total = Object.values(totals[year]).reduce((a, b) => a + b, 0);
            byTitle[title][year] = total ? 100 * (years[year] || 0) / total : null;
        });
    });
    return byTitle;
}

function titleByName(name) {
    return jobTitles?.titles.find(t => t.name === name) || null;
}

// Skills that at least TYPICAL_SKILL_PERCENT of the title's ads mention, most first.
function typicalSkills(name, limit = TYPICAL_SKILLS_MAX) {
    const title = titleByName(name);
    if (!title || title.ads < MIN_TITLE_ADS) return [];
    return Object.entries(title.skills || {})
        .filter(([, percent]) => percent >= TYPICAL_SKILL_PERCENT)
        .sort((a, b) => b[1] - a[1])
        .slice(0, limit)
        .map(([skill, percent]) => ({ skill, percent }));
}

// Titles whose ads mention the skill most often (share of the title's ads), for the tree panel.
function titlesForSkill(skill, limit = 4) {
    if (!jobTitles) return [];
    return jobTitles.titles
        .filter(t => t.ads >= MIN_TITLE_ADS && t.skills && t.skills[skill] != null)
        .map(t => ({ name: t.name, percent: t.skills[skill], ads: t.ads }))
        .filter(t => t.percent > 0)
        .sort((a, b) => b.percent - a.percent || b.ads - a.ads)
        .slice(0, limit);
}

// Change in share from the year before the latest one, in percentage points.
function titleTrend(name) {
    const history = titleHistory[name];
    if (!history || titleYears.length < 2) return null;
    const last = titleYears[titleYears.length - 1];
    const previous = titleYears[titleYears.length - 2];
    if (history[last] == null || history[previous] == null) return null;
    return { last, previous, now: history[last], before: history[previous], change: history[last] - history[previous] };
}

function drawJobTitles() {
    const section = document.getElementById('titles');
    if (!section) return;
    const list = document.getElementById('titleList');
    const panel = document.getElementById('titlePanel');
    const heatmap = document.getElementById('titleHeatmap');
    if (!jobTitles) {
        list.innerHTML = '<p class="skill-gap-empty">Job titles appear after the next weekly data update.</p>';
        panel.innerHTML = '';
        heatmap.innerHTML = '';
        return;
    }
    renderTitleList();
    renderTitlePanel();
    renderTitleHeatmap();
}

function selectTitle(name, { scroll = false, fromTree = false } = {}) {
    if (!titleByName(name)) return;
    selectedTitle = name;
    renderTitleList();
    renderTitlePanel();
    renderTitleHeatmap();
    // Light up the title's typical skills in the skill tree too.
    if (!fromTree && typeof showTitleInNetwork === 'function') showTitleInNetwork(name);
    if (scroll) document.getElementById('titles')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function renderTitleList() {
    const container = document.getElementById('titleList');
    container.innerHTML = '';
    const titles = jobTitles.titles.filter(t => t.ads > 0);
    const shown = showAllTitles ? titles : titles.slice(0, TITLES_SHOWN);
    const max = Math.max(...titles.map(t => t.percent), 1);
    const hasHistory = Object.keys(titleHistory).length > 0 && titleYears.length > 1;

    const head = document.createElement('div');
    head.className = 'title-row title-row-head';
    head.setAttribute('aria-hidden', 'true');
    head.innerHTML = `<span>Title</span><span>Share of live Data/IT ads</span>` +
        (hasHistory ? `<span class="title-col-trend">vs ${titleYears[titleYears.length - 2]}</span><span class="title-col-spark">${titleYears[0]}–${titleYears[titleYears.length - 1]}</span>` : '');
    container.appendChild(head);

    const ol = document.createElement('ol');
    ol.className = 'title-rows';
    shown.forEach((title, index) => {
        const item = document.createElement('li');
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'title-row' + (title.name === selectedTitle ? ' is-selected' : '') + (hasHistory ? '' : ' no-history');
        button.setAttribute('aria-pressed', String(title.name === selectedTitle));

        const name = document.createElement('span');
        name.className = 'title-name';
        const rank = document.createElement('span');
        rank.className = 'title-rank';
        rank.textContent = index + 1;
        name.append(rank, document.createTextNode(title.name));

        const bar = document.createElement('span');
        bar.className = 'title-bar';
        const fill = document.createElement('span');
        fill.className = 'title-bar-fill';
        fill.style.width = `${(100 * title.percent / max).toFixed(1)}%`;
        const value = document.createElement('span');
        value.className = 'title-bar-value';
        value.textContent = `${title.percent}%`;
        bar.append(fill, value);
        button.append(name, bar);

        if (hasHistory) {
            const trend = titleTrend(title.name);
            const badge = document.createElement('span');
            badge.className = 'title-trend';
            if (trend) {
                const pts = trend.change;
                const rounded = Math.abs(pts) < 0.05 ? 0 : pts;
                badge.classList.add(rounded > 0 ? 'trend-up' : rounded < 0 ? 'trend-down' : 'trend-flat');
                badge.textContent = rounded === 0 ? '±0 pts' : `${rounded > 0 ? '▲' : '▼'} ${Math.abs(rounded).toFixed(1)} pts`;
                badge.title = `${trend.now.toFixed(1)}% of Data/IT ads published in ${trend.last}${trend.last === '2026' ? ' (Jan–Oct)' : ''}, ${trend.before.toFixed(1)}% in ${trend.previous}`;
            } else {
                badge.textContent = '–';
            }
            button.appendChild(badge);
            button.appendChild(sparkline(title.name));
        }

        button.setAttribute('aria-label', `${title.name}: ${title.percent}% of live Data/IT ads, ${title.ads.toLocaleString()} ads`);
        button.addEventListener('click', () => selectTitle(title.name));
        item.appendChild(button);
        ol.appendChild(item);
    });
    container.appendChild(ol);

    const other = document.createElement('p');
    other.className = 'title-note';
    const otherShare = jobTitles.total_ads ? Math.round(100 * jobTitles.other_ads / jobTitles.total_ads) : 0;
    other.textContent = `Each ad counts once, in the first family its title fits. ${otherShare}% of the ${jobTitles.total_ads.toLocaleString()} live Data/IT ads have a title outside these families.`;
    if (titles.length > TITLES_SHOWN) {
        const more = document.createElement('button');
        more.type = 'button';
        more.className = 'link-button';
        more.textContent = showAllTitles ? 'Show fewer' : `Show all ${titles.length}`;
        more.addEventListener('click', () => {
            showAllTitles = !showAllTitles;
            renderTitleList();
        });
        other.append(' ', more);
    }
    container.appendChild(other);
}

function sparkline(name) {
    const values = titleYears.map(year => titleHistory[name]?.[year]);
    const width = 96, height = 28, pad = 3;
    const max = Math.max(...values.filter(v => v != null), 0.1);
    const x = i => pad + (width - 2 * pad) * i / Math.max(values.length - 1, 1);
    const y = v => height - pad - (height - 2 * pad) * v / max;
    const points = values.map((v, i) => v == null ? null : `${x(i).toFixed(1)},${y(v).toFixed(1)}`).filter(Boolean);

    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    svg.setAttribute('class', 'title-spark');
    svg.setAttribute('aria-hidden', 'true');
    if (points.length > 1) {
        const area = document.createElementNS(SVG_NS, 'polygon');
        area.setAttribute('points', `${points[0].split(',')[0]},${height - pad} ${points.join(' ')} ${points[points.length - 1].split(',')[0]},${height - pad}`);
        area.setAttribute('class', 'title-spark-area');
        const line = document.createElementNS(SVG_NS, 'polyline');
        line.setAttribute('points', points.join(' '));
        line.setAttribute('class', 'title-spark-line');
        const [lx, ly] = points[points.length - 1].split(',');
        const dot = document.createElementNS(SVG_NS, 'circle');
        dot.setAttribute('cx', lx);
        dot.setAttribute('cy', ly);
        dot.setAttribute('r', 2.5);
        dot.setAttribute('class', 'title-spark-dot');
        svg.append(area, line, dot);
    }
    const wrap = document.createElement('span');
    wrap.className = 'title-spark-wrap';
    const first = values.find(v => v != null);
    const last = values[values.length - 1];
    wrap.title = first != null && last != null
        ? `${titleYears[0]}: ${first.toFixed(1)}% → ${titleYears[titleYears.length - 1]}: ${last.toFixed(1)}% of Data/IT ads published`
        : '';
    wrap.appendChild(svg);
    return wrap;
}

function renderTitlePanel() {
    const panel = document.getElementById('titlePanel');
    panel.innerHTML = '';
    const title = titleByName(selectedTitle);
    if (!title) return;

    const heading = document.createElement('h4');
    heading.className = 'network-panel-title';
    heading.textContent = title.name;
    panel.appendChild(heading);

    const meta = document.createElement('p');
    meta.className = 'network-panel-meta';
    meta.textContent = `${title.ads.toLocaleString()} of ${jobTitles.total_ads.toLocaleString()} live Data/IT ads (${title.percent}%). Titles like ${title.examples}.`;
    panel.appendChild(meta);

    const trend = titleTrend(title.name);
    if (trend) {
        const history = document.createElement('p');
        history.className = 'network-panel-meta';
        const first = titleHistory[title.name][titleYears[0]];
        history.textContent = `In published ads: ${first == null ? '–' : first.toFixed(1) + '%'} in ${titleYears[0]}, ${trend.before.toFixed(1)}% in ${trend.previous}, ${trend.now.toFixed(1)}% in ${trend.last}${trend.last === '2026' ? ' so far' : ''}.`;
        panel.appendChild(history);
    }

    const skills = Object.entries(title.skills || {}).sort((a, b) => b[1] - a[1]).slice(0, 8);
    if (!skills.length) {
        const few = document.createElement('p');
        few.className = 'network-panel-note';
        few.textContent = 'Too few ads right now to show which skills this title asks for.';
        panel.appendChild(few);
        return;
    }

    const sub = document.createElement('p');
    sub.className = 'network-panel-subhead';
    sub.textContent = 'Skills these ads ask for';
    panel.appendChild(sub);

    const list = document.createElement('ol');
    list.className = 'network-steps';
    const categoryOf = skillCategories();
    skills.forEach(([skill, percent]) => {
        const item = document.createElement('li');
        item.className = 'network-step-row';
        const label = document.createElement('button');
        label.type = 'button';
        label.className = 'network-step-label';
        label.title = `Show ${skill} in the skill tree`;
        const swatch = document.createElement('span');
        swatch.className = 'skill-swatch';
        swatch.style.backgroundColor = categoryColor(categoryOf[skill]);
        label.append(swatch, document.createTextNode(skill));
        label.addEventListener('click', () => {
            if (typeof selectNetworkSkill === 'function') selectNetworkSkill(skill);
            document.getElementById('connections')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
        const bar = document.createElement('span');
        bar.className = 'network-step-bar';
        const fill = document.createElement('span');
        fill.className = 'network-step-fill';
        fill.style.width = `${percent}%`;
        fill.style.backgroundColor = categoryColor(categoryOf[skill]);
        bar.appendChild(fill);
        const value = document.createElement('span');
        value.className = 'network-step-value';
        value.textContent = `${percent}%`;
        item.append(label, bar, value);
        list.appendChild(item);
    });
    panel.appendChild(list);

    const typical = typicalSkills(title.name);
    const note = document.createElement('p');
    note.className = 'network-panel-note';
    note.textContent = typical.length
        ? `Share of ${title.name} ads that mention each skill. ${typical.length === 1 ? 'The one' : `The ${typical.length}`} at ${TYPICAL_SKILL_PERCENT}% or more light up in the skill tree.`
        : `Share of ${title.name} ads that mention each skill. None reaches ${TYPICAL_SKILL_PERCENT}%: these ads ask for a wide mix, or for skills outside the 20 tracked.`;
    panel.appendChild(note);

    const toTree = document.createElement('button');
    toTree.type = 'button';
    toTree.className = 'location-pill network-openings';
    toTree.textContent = 'See it in the skill tree ↑';
    toTree.addEventListener('click', () => {
        if (typeof showTitleInNetwork === 'function') showTitleInNetwork(title.name);
        document.getElementById('connections')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    panel.appendChild(toTree);
}

function skillCategories() {
    const map = {};
    Object.entries(rawCategoryData || {}).forEach(([category, skills]) => skills.forEach(s => { map[s.name] = category; }));
    return map;
}

function renderTitleHeatmap() {
    const container = document.getElementById('titleHeatmap');
    container.innerHTML = '';
    // The most used titles, plus the selected one if it's further down the list.
    const eligible = jobTitles.titles.filter(t => t.ads >= MIN_TITLE_ADS && Object.keys(t.skills || {}).length);
    const rows = eligible.slice(0, HEATMAP_ROWS);
    const chosen = eligible.find(t => t.name === selectedTitle);
    if (chosen && !rows.includes(chosen)) rows.push(chosen);
    if (!rows.length) return;
    const categories = Object.entries(rawCategoryData || {}).map(([category, skills]) => [category, skills.map(s => s.name)]);
    const columns = categories.flatMap(([category, skills]) => skills.map(skill => ({ skill, category })));

    const table = document.createElement('table');
    table.className = 'heatmap';
    const caption = document.createElement('caption');
    caption.className = 'visually-hidden';
    caption.textContent = 'Share of live Data/IT ads with each job title that mention each skill';
    table.appendChild(caption);

    const thead = table.createTHead();
    const groupRow = thead.insertRow();
    groupRow.className = 'heatmap-groups';
    const corner = document.createElement('th');
    corner.rowSpan = 2;
    corner.className = 'heatmap-corner';
    corner.textContent = 'Title ↓ · Skill →';
    groupRow.appendChild(corner);
    categories.forEach(([category, skills], index) => {
        const th = document.createElement('th');
        th.colSpan = skills.length;
        th.scope = 'colgroup';
        th.className = 'heatmap-group' + (index ? ' heatmap-group-start' : '');
        const dot = document.createElement('span');
        dot.className = 'card-dot';
        dot.style.backgroundColor = categoryColor(category);
        th.append(dot, document.createTextNode(category));
        groupRow.appendChild(th);
    });

    const headRow = thead.insertRow();
    columns.forEach(({ skill, category }, index) => {
        const th = document.createElement('th');
        th.scope = 'col';
        const first = index > 0 && columns[index - 1].category !== category;
        th.className = 'heatmap-col' + (first ? ' heatmap-group-start' : '') + (skill === heatmapSkill ? ' is-active' : '');
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'heatmap-col-button';
        button.textContent = skill;
        button.title = `Highlight ${skill}, and show it in the skill tree`;
        button.addEventListener('click', () => {
            heatmapSkill = heatmapSkill === skill ? null : skill;
            renderTitleHeatmap();
            if (heatmapSkill && typeof selectNetworkSkill === 'function') selectNetworkSkill(skill);
        });
        th.appendChild(button);
        headRow.appendChild(th);
    });

    const body = table.createTBody();
    rows.forEach(title => {
        const tr = body.insertRow();
        tr.className = title.name === selectedTitle ? 'is-selected' : '';
        const th = document.createElement('th');
        th.scope = 'row';
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'heatmap-row-button';
        button.textContent = title.name;
        button.addEventListener('click', () => selectTitle(title.name));
        th.appendChild(button);
        tr.appendChild(th);
        columns.forEach(({ skill, category }, index) => {
            const percent = title.skills[skill] ?? 0;
            const td = tr.insertCell();
            const first = index > 0 && columns[index - 1].category !== category;
            td.className = 'heatmap-cell' + (first ? ' heatmap-group-start' : '') +
                (skill === heatmapSkill ? ' is-active' : '') + (percent >= 45 ? ' is-strong' : '');
            // Sequential scale, one hue: mix the accent into the surface by the share.
            td.style.setProperty('--level', `${Math.min(100, Math.round(percent * 1.4))}%`);
            td.textContent = percent >= 5 ? percent : '';
            td.title = `${percent}% of ${title.name} ads mention ${skill}`;
        });
    });

    const scroll = document.createElement('div');
    scroll.className = 'heatmap-scroll';
    scroll.tabIndex = 0;
    scroll.setAttribute('role', 'region');
    scroll.setAttribute('aria-label', 'Job title by skill heatmap, scrolls sideways');
    scroll.appendChild(table);
    container.appendChild(scroll);

    const legend = document.createElement('div');
    legend.className = 'heatmap-legend';
    legend.innerHTML = '<span>% of the title\'s ads that mention the skill</span>' +
        '<span class="heatmap-legend-scale" aria-hidden="true">' +
        [0, 10, 20, 35, 50, 70].map(p => `<span class="heatmap-legend-step" style="--level:${Math.min(100, Math.round(p * 1.4))}%">${p}</span>`).join('') +
        '</span>';
    container.appendChild(legend);
}
