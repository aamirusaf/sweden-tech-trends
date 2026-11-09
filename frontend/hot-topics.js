// "Big Themes": broad themes such as AI, LLMs and cybersecurity. They aren't tools, so
// they aren't among the 20 tracked skills, but they're measured the same way: the share
// of Data/IT job ads that mention them, live and every year since 2008.
// They appear in two places: a "Big Themes" tab beside "Most used job titles" (with
// the same list, panel and heatmap as the titles), and a "Big Themes" pill in the
// "Demand over time" chart (app.js).
// Data: backend/data/hot_topics.json (live ads, weekly) and
// backend/data/historical_topics_monthly.csv (Historical Ads); the themes and their
// patterns are defined in backend/hot_topics.py.
// Relies on historicalYearly, validHistoryYears, isDarkMode, categoryColor, SERIES_COLORS
// and SVG_NS from app.js and skill-network.js, and on job-titles.js for the shared
// list, heatmap and tab state (titleTab).

const BIG_THEMES = 'Big Themes';
const HOT_SAMPLES_SHOWN = 4;
const HOT_TITLES_SHOWN = 4;

let hotTopics = null;               // hot_topics.json
let hotHistory = {};                // { location: { theme: { year: share% } } }
let hotYears = [];                  // years shown, same as the skills history chart
let hotMatchers = [];               // [{ name, patterns: [RegExp] }] for the CV check
let selectedHotTopic = null;

// Called by app.js once the data files have loaded (after historicalYearly is set).
function initHotTopics(data, csv) {
    hotTopics = data && Array.isArray(data.topics) && data.total_ads ? data : null;
    hotHistory = aggregateHotHistory(csv);
    hotMatchers = buildHotMatchers(hotTopics?.patterns);
    selectedHotTopic = hotTopics?.topics.find(t => /LLM/.test(t.name))?.name || hotTopics?.topics[0]?.name || null;
}

function hasBigThemes() {
    return !!hotTopics;
}

function hasBigThemesHistory(location) {
    return !!(hotHistory[location] && hotYears.length > 1);
}

function aggregateHotHistory(csvText) {
    // CSV columns: month,topic,location,it_ads,it_total_ads (Data/IT ads only).
    const ads = {};      // location -> theme -> year -> ads
    const totals = {};   // location -> year -> month -> Data/IT ads
    const lines = (csvText || '').trim().split('\n');
    for (const line of lines.slice(1)) {
        const [month, topic, location, itAds, itTotal] = line.split(',');
        if (!month || !topic || !location) continue;
        const year = month.slice(0, 4);
        const byTopic = ((ads[location] ??= {})[topic] ??= {});
        byTopic[year] = (byTopic[year] || 0) + Number(itAds);
        ((totals[location] ??= {})[year] ??= {})[month] = Number(itTotal);
    }
    // Start where the skills history chart starts (older ads mostly have no job category).
    const allYears = Object.keys(totals.Sweden || {}).sort();
    hotYears = typeof validHistoryYears === 'function' && historicalYearly?.Sweden
        ? validHistoryYears(historicalYearly.Sweden).filter(year => allYears.includes(year))
        : allYears;
    const result = {};
    Object.entries(ads).forEach(([location, topics]) => {
        result[location] = {};
        Object.entries(topics).forEach(([topic, years]) => {
            result[location][topic] = {};
            hotYears.forEach(year => {
                const total = Object.values(totals[location]?.[year] || {}).reduce((a, b) => a + b, 0);
                result[location][topic][year] = total ? 100 * (years[year] || 0) / total : null;
            });
        });
    });
    return result;
}

function buildHotMatchers(patterns) {
    return Object.entries(patterns || {}).map(([name, list]) => ({
        name,
        patterns: list.map(p => {
            try { return new RegExp(p.source, p.flags); } catch { return null; }
        }).filter(Boolean)
    }));
}

// Big Themes mentioned in a piece of text (the CV check uses this).
function hotTopicsInText(text) {
    if (!text) return [];
    return hotMatchers.filter(m => m.patterns.some(p => p.test(text))).map(m => m.name);
}

function hotTopicByName(name) {
    return hotTopics?.topics.find(t => t.name === name) || null;
}

// The eight series colors from app.js plus a ninth, so no two themes share one.
const HOT_EXTRA_COLOR = { light: '#1a8fa0', dark: '#2bb3c4' };

function hotColor(name) {
    const mode = isDarkMode() ? 'dark' : 'light';
    const palette = [...SERIES_COLORS[mode], HOT_EXTRA_COLOR[mode]];
    const index = (hotTopics?.topics || []).findIndex(t => t.name === name);
    return palette[(index < 0 ? 0 : index) % palette.length];
}

// Yearly share (%) of Data/IT ads mentioning each theme, for the "Demand over time" chart.
function bigThemesHistory(location) {
    const history = hotHistory[location] || {};
    return (hotTopics?.topics || []).map(topic => ({ name: topic.name, color: hotColor(topic.name), years: history[topic.name] || {} }));
}

// Change in share from the year before the latest one, in percentage points (Sweden),
// the same comparison as the job titles.
function hotTrend(name) {
    const series = hotHistory.Sweden?.[name];
    if (!series || hotYears.length < 2) return null;
    const last = hotYears[hotYears.length - 1];
    const previous = hotYears[hotYears.length - 2];
    if (series[last] == null || series[previous] == null) return null;
    return { last, previous, now: series[last], before: series[previous], change: series[last] - series[previous] };
}

// Share of live Data/IT ads in Sweden (%), from the counts so small themes don't round to 0.
function hotShare(topic) {
    const ads = topic.ads_by_location?.Sweden;
    const total = hotTopics?.totals_by_location?.Sweden || hotTopics?.total_ads;
    if (ads != null && total) return 100 * ads / total;
    return topic.percent_by_location?.Sweden ?? 0;
}

function fmtHotShare(share) {
    if (share >= 10) return `${Math.round(share)}%`;
    if (share >= 1 || share === 0) return `${share.toFixed(1)}%`;
    return `${share.toFixed(2)}%`;
}

// Open a theme in the Big Themes tab (from the CV check).
function selectHotTopic(name, { scroll = false } = {}) {
    if (!hotTopicByName(name)) return;
    selectedHotTopic = name;
    if (typeof setTitleTab === 'function') setTitleTab('themes');
    if (scroll) document.getElementById('titles')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ---------- The Big Themes tab (drawn into the job-title card's containers) ----------

function renderThemeList() {
    const container = document.getElementById('titleList');
    container.innerHTML = '';
    const topics = hotTopics.topics;
    const shares = new Map(topics.map(t => [t.name, hotShare(t)]));
    const max = Math.max(...shares.values(), 1);
    const hasHistory = hotYears.length > 1 && !!hotHistory.Sweden;

    const head = document.createElement('div');
    head.className = 'title-row title-row-head';
    head.setAttribute('aria-hidden', 'true');
    head.innerHTML = `<span>Theme</span><span>Share of live Data/IT ads</span>` +
        (hasHistory ? `<span class="title-col-trend">vs ${hotYears[hotYears.length - 2]}</span><span class="title-col-spark">${hotYears[0]}–${hotYears[hotYears.length - 1]}</span>` : '');
    container.appendChild(head);

    const ol = document.createElement('ol');
    ol.className = 'title-rows';
    topics.forEach((topic, index) => {
        const share = shares.get(topic.name);
        const selected = topic.name === selectedHotTopic;
        const item = document.createElement('li');
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'title-row theme-row' + (selected ? ' is-selected' : '') + (hasHistory ? '' : ' no-history');
        button.setAttribute('aria-pressed', String(selected));
        // The row's bar and sparkline take the theme's own color.
        button.style.setProperty('--title', hotColor(topic.name));

        const name = el('span', 'title-name');
        name.append(el('span', 'title-rank', String(index + 1)), document.createTextNode(topic.name));

        const bar = el('span', 'title-bar');
        const fill = el('span', 'title-bar-fill');
        fill.style.width = `${(100 * share / max).toFixed(1)}%`;
        bar.append(fill, el('span', 'title-bar-value', fmtHotShare(share)));
        button.append(name, bar);

        if (hasHistory) {
            const trend = hotTrend(topic.name);
            const badge = el('span', 'title-trend');
            if (trend) {
                const rounded = Math.abs(trend.change) < 0.05 ? 0 : trend.change;
                badge.classList.add(rounded > 0 ? 'trend-up' : rounded < 0 ? 'trend-down' : 'trend-flat');
                badge.textContent = rounded === 0 ? '±0 pts' : `${rounded > 0 ? '▲' : '▼'} ${Math.abs(rounded).toFixed(1)} pts`;
                badge.title = `${fmtHotShare(trend.now)} of Data/IT ads published in ${trend.last}${trend.last === '2026' ? ' (Jan–Oct)' : ''}, ${fmtHotShare(trend.before)} in ${trend.previous}`;
            } else {
                badge.textContent = '–';
            }
            button.append(badge, themeSparkline(topic.name));
        }

        const ads = topic.ads_by_location?.Sweden ?? 0;
        button.setAttribute('aria-label', `${topic.name}: ${fmtHotShare(share)} of live Data/IT ads, ${ads.toLocaleString()} ad${ads === 1 ? '' : 's'}`);
        button.addEventListener('click', () => {
            selectedHotTopic = topic.name;
            drawJobTitles();
        });
        item.appendChild(button);
        ol.appendChild(item);
    });
    container.appendChild(ol);

    container.appendChild(el('p', 'title-note',
        `Themes overlap: an ad about LLMs also counts under AI. Out of ${(hotTopics.totals_by_location?.Sweden || hotTopics.total_ads).toLocaleString()} live Data/IT ads in Sweden.`));
}

function themeSparkline(name) {
    const series = hotHistory.Sweden?.[name] || {};
    const values = hotYears.map(year => series[year]);
    const width = 96, height = 28, pad = 3;
    const max = Math.max(...values.filter(v => v != null), 0.01);
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
    const wrap = el('span', 'title-spark-wrap');
    const first = values.find(v => v != null);
    const last = values[values.length - 1];
    wrap.title = first != null && last != null
        ? `${hotYears[0]}: ${fmtHotShare(first)} → ${hotYears[hotYears.length - 1]}: ${fmtHotShare(last)} of Data/IT ads published`
        : '';
    wrap.appendChild(svg);
    return wrap;
}

function renderThemePanel() {
    const panel = document.getElementById('titlePanel');
    panel.innerHTML = '';
    const topic = hotTopicByName(selectedHotTopic);
    if (!topic) return;

    const heading = el('h4', 'network-panel-title');
    const swatch = el('span', 'skill-swatch');
    swatch.style.backgroundColor = hotColor(topic.name);
    heading.append(swatch, document.createTextNode(topic.name));
    panel.appendChild(heading);
    panel.appendChild(el('p', 'network-panel-meta', topic.description));

    const ads = topic.ads_by_location?.Sweden ?? 0;
    const total = hotTopics.totals_by_location?.Sweden || hotTopics.total_ads;
    panel.appendChild(el('p', 'network-panel-meta',
        `${ads.toLocaleString()} of ${total.toLocaleString()} live Data/IT ads (${fmtHotShare(hotShare(topic))}).`));
    const trend = hotTrend(topic.name);
    if (trend) {
        const first = hotHistory.Sweden?.[topic.name]?.[hotYears[0]];
        panel.appendChild(el('p', 'network-panel-meta',
            `In published ads: ${first == null ? '–' : fmtHotShare(first)} in ${hotYears[0]}, ${fmtHotShare(trend.before)} in ${trend.previous}, ${fmtHotShare(trend.now)} in ${trend.last}${trend.last === '2026' ? ' so far' : ''}.`));
    }

    const shares = topic.skill_shares || Object.fromEntries((topic.skills || []).map(s => [s.name, s.percent]));
    const skills = Object.entries(shares).filter(([, p]) => p > 0).sort((a, b) => b[1] - a[1]).slice(0, 6);
    if (skills.length && ads >= 3) {
        panel.appendChild(el('p', 'network-panel-subhead', 'Skills these ads ask for'));
        const list = el('ol', 'network-steps');
        const categoryOf = skillCategories();
        skills.forEach(([skill, percent]) => {
            const item = el('li', 'network-step-row');
            const label = el('button', 'network-step-label');
            label.type = 'button';
            label.title = `Show ${skill} in the skill tree`;
            const dot = el('span', 'skill-swatch');
            dot.style.backgroundColor = categoryColor(categoryOf[skill]);
            label.append(dot, document.createTextNode(skill));
            label.addEventListener('click', () => {
                if (typeof selectNetworkSkill === 'function') selectNetworkSkill(skill);
                document.getElementById('connections')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
            });
            const bar = el('span', 'network-step-bar');
            const fill = el('span', 'network-step-fill');
            fill.style.width = `${percent}%`;
            fill.style.backgroundColor = categoryColor(categoryOf[skill]);
            bar.appendChild(fill);
            item.append(label, bar, el('span', 'network-step-value', `${percent}%`));
            list.appendChild(item);
        });
        panel.appendChild(list);
    }

    if (topic.titles?.length && ads >= 3) {
        panel.appendChild(el('p', 'network-panel-subhead', 'Job titles of these ads'));
        const row = el('div', 'hot-chips');
        topic.titles.slice(0, HOT_TITLES_SHOWN).forEach(title => {
            const chip = el('button', 'co-occurrence-chip hot-chip-link', `${title.name} ${title.percent}%`);
            chip.type = 'button';
            chip.title = `Open ${title.name} in the Job titles tab`;
            chip.addEventListener('click', () => selectTitle(title.name));
            row.appendChild(chip);
        });
        panel.appendChild(row);
    }

    const samples = (topic.samples?.Sweden || []).slice(0, HOT_SAMPLES_SHOWN);
    panel.appendChild(el('p', 'network-panel-subhead', samples.length ? 'Latest openings' : 'No live openings right now'));
    if (samples.length) {
        const list = el('div', 'job-postings-list');
        samples.forEach(post => {
            const card = document.createElement('a');
            card.className = 'job-posting-card';
            card.href = post.url || '#';
            card.target = '_blank';
            card.rel = 'noopener noreferrer';
            card.append(
                el('div', 'job-posting-headline', post.headline || 'Untitled ad'),
                el('div', 'job-posting-meta', [post.employer, post.location, post.published].filter(Boolean).join(' · '))
            );
            list.appendChild(card);
        });
        panel.appendChild(list);
    }
}

function renderThemeHeatmap() {
    const rows = hotTopics.topics
        .filter(t => (t.ads_by_location?.Sweden ?? 0) >= MIN_TITLE_ADS)
        .map(t => ({ name: t.name, skills: t.skill_shares || Object.fromEntries((t.skills || []).map(s => [s.name, s.percent])) }));
    renderSkillHeatmap({
        rows,
        selected: selectedHotTopic,
        onSelect: name => { selectedHotTopic = name; drawJobTitles(); },
        corner: 'Theme ↓ · Skill →',
        caption: 'Share of live Data/IT ads about each big theme that mention each skill',
        legendLabel: '% of the theme\'s ads that mention the skill',
        cellTitle: (row, skill, percent) => `${percent}% of ${row} ads mention ${skill}`,
        rerender: renderThemeHeatmap
    });
}
