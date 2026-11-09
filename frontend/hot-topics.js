// "Hot topics": broad themes such as AI, LLMs and cybersecurity. They aren't tools, so
// they aren't among the 20 tracked skills, but they're measured the same way: the share
// of Data/IT job ads that mention them, live and every year since 2008.
// Data: backend/data/hot_topics.json (live ads, weekly) and
// backend/data/historical_topics_monthly.csv (Historical Ads); the topics and their
// patterns are defined in backend/hot_topics.py.
// Relies on selectedLocation, historicalYearly, validHistoryYears, chartTheme,
// tooltipStyle, isDarkMode, categoryColor, skillCategories, SERIES_COLORS, SVG_NS and
// LOCATION_LABELS from app.js and the other scripts, and on selectTitle from job-titles.js.

const HOT_TREND_YEARS_BACK = 5;     // "since 2021" when the latest year is 2026
const HOT_SAMPLES_SHOWN = 4;

let hotTopics = null;               // hot_topics.json
let hotHistory = {};                // { location: { topic: { year: share% } } }
let hotYears = [];                  // years shown, same as the skills history chart
let hotMatchers = [];               // [{ name, patterns: [RegExp] }] for the CV check
let selectedHotTopic = null;
let hotChart = null;

function initHotTopics() {
    Promise.all([
        fetch('../backend/data/hot_topics.json').then(r => r.ok ? r.json() : null).catch(() => null),
        fetch('../backend/data/historical_topics_monthly.csv').then(r => r.ok ? r.text() : '').catch(() => '')
    ]).then(([data, csv]) => {
        hotTopics = data && Array.isArray(data.topics) && data.total_ads ? data : null;
        hotHistory = aggregateHotHistory(csv);
        hotMatchers = buildHotMatchers(hotTopics?.patterns);
        if (!selectedHotTopic) selectedHotTopic = defaultHotTopic();
        renderHotTopics();
        // The CV may have been read before the topics arrived.
        if (typeof renderCvFound === 'function' && typeof cvHasCv !== 'undefined' && cvHasCv) renderCvFound();
    });
}

function aggregateHotHistory(csvText) {
    // CSV columns: month,topic,location,it_ads,it_total_ads (Data/IT ads only).
    const ads = {};      // location -> topic -> year -> ads
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

// Hot topics mentioned in a piece of text (the CV check uses this).
function hotTopicsInText(text) {
    if (!text) return [];
    return hotMatchers.filter(m => m.patterns.some(p => p.test(text))).map(m => m.name);
}

function defaultHotTopic() {
    if (!hotTopics) return null;
    return hotTopics.topics.find(t => /LLM/.test(t.name))?.name || hotTopics.topics[0]?.name || null;
}

function hotTopicByName(name) {
    return hotTopics?.topics.find(t => t.name === name) || null;
}

// The eight series colors from app.js plus a ninth, so no two topics share one.
const HOT_EXTRA_COLOR = { light: '#1a8fa0', dark: '#2bb3c4' };

function hotColor(name) {
    const mode = isDarkMode() ? 'dark' : 'light';
    const palette = [...SERIES_COLORS[mode], HOT_EXTRA_COLOR[mode]];
    const index = (hotTopics?.topics || []).findIndex(t => t.name === name);
    return palette[(index < 0 ? 0 : index) % palette.length];
}

function hotSeries(name, location = selectedLocation) {
    return hotHistory[location]?.[name] || hotHistory.Sweden?.[name] || null;
}

// Change in yearly share over the last HOT_TREND_YEARS_BACK years, in percentage points.
function hotTrend(name, location = selectedLocation) {
    const series = hotSeries(name, location);
    if (!series || hotYears.length < 2) return null;
    const last = hotYears[hotYears.length - 1];
    const fromIndex = Math.max(0, hotYears.length - 1 - HOT_TREND_YEARS_BACK);
    const from = hotYears[fromIndex];
    if (series[last] == null || series[from] == null) return null;
    return { from, last, before: series[from], now: series[last], change: series[last] - series[from] };
}

function hotShare(topic, location = selectedLocation) {
    return topic.percent_by_location?.[location] ?? topic.percent_by_location?.Sweden ?? 0;
}

function renderHotTopics() {
    const section = document.getElementById('hot');
    if (!section) return;
    const grid = document.getElementById('hotGrid');
    const panel = document.getElementById('hotPanel');
    if (!hotTopics) {
        grid.innerHTML = '<p class="skill-gap-empty">Hot topics appear after the next weekly data update.</p>';
        panel.innerHTML = '';
        document.getElementById('hotChartCard').hidden = true;
        return;
    }
    renderHotGrid();
    renderHotPanel();
    renderHotChart();
}

function renderHotGrid() {
    const grid = document.getElementById('hotGrid');
    grid.innerHTML = '';
    const location = selectedLocation;
    const total = hotTopics.totals_by_location?.[location] ?? hotTopics.total_ads;
    hotTopics.topics.forEach(topic => {
        const button = document.createElement('button');
        button.type = 'button';
        const selected = topic.name === selectedHotTopic;
        button.className = 'hot-tile' + (selected ? ' is-selected' : '');
        button.setAttribute('aria-pressed', String(selected));
        button.style.setProperty('--hot-color', hotColor(topic.name));

        const name = el('span', 'hot-tile-name', topic.name);
        const share = hotShare(topic, location);
        const value = el('span', 'hot-tile-value', `${share >= 10 ? Math.round(share) : share.toFixed(1)}%`);
        const ads = topic.ads_by_location?.[location] ?? 0;
        const sub = el('span', 'hot-tile-sub', `of live Data/IT ads · ${ads.toLocaleString()} ads`);

        const foot = el('span', 'hot-tile-foot');
        const trend = hotTrend(topic.name, location);
        const badge = el('span', 'title-trend hot-tile-trend');
        if (trend) {
            const rounded = Math.abs(trend.change) < 0.05 ? 0 : trend.change;
            badge.classList.add(rounded > 0 ? 'trend-up' : rounded < 0 ? 'trend-down' : 'trend-flat');
            badge.textContent = rounded === 0
                ? `±0 pts since ${trend.from}`
                : `${rounded > 0 ? '▲' : '▼'} ${Math.abs(rounded).toFixed(1)} pts since ${trend.from}`;
            badge.title = `${trend.before.toFixed(1)}% of Data/IT ads published in ${trend.from}, ${trend.now.toFixed(1)}% in ${trend.last}${trend.last === '2026' ? ' (Jan–Oct)' : ''}`;
        } else {
            badge.textContent = hotYears.length ? '–' : '';
        }
        foot.append(badge, hotSparkline(topic.name, location));

        button.append(name, value, sub, foot);
        button.setAttribute('aria-label', `${topic.name}: ${share}% of ${total.toLocaleString()} live Data/IT ads${trend ? `, ${trend.change >= 0 ? 'up' : 'down'} ${Math.abs(trend.change).toFixed(1)} points since ${trend.from}` : ''}`);
        button.addEventListener('click', () => selectHotTopic(topic.name));
        grid.appendChild(button);
    });
}

function hotSparkline(name, location) {
    const series = hotSeries(name, location) || {};
    const values = hotYears.map(year => series[year]);
    const width = 120, height = 32, pad = 3;
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    svg.setAttribute('class', 'hot-spark');
    svg.setAttribute('aria-hidden', 'true');
    const max = Math.max(...values.filter(v => v != null), 0.1);
    const x = i => pad + (width - 2 * pad) * i / Math.max(values.length - 1, 1);
    const y = v => height - pad - (height - 2 * pad) * v / max;
    const points = values.map((v, i) => v == null ? null : [x(i), y(v)]).filter(Boolean);
    if (points.length > 1) {
        const path = points.map(([px, py]) => `${px.toFixed(1)},${py.toFixed(1)}`).join(' ');
        const area = document.createElementNS(SVG_NS, 'polygon');
        area.setAttribute('points', `${points[0][0].toFixed(1)},${height - pad} ${path} ${points[points.length - 1][0].toFixed(1)},${height - pad}`);
        area.setAttribute('class', 'hot-spark-area');
        const line = document.createElementNS(SVG_NS, 'polyline');
        line.setAttribute('points', path);
        line.setAttribute('class', 'hot-spark-line');
        const dot = document.createElementNS(SVG_NS, 'circle');
        const [lx, ly] = points[points.length - 1];
        dot.setAttribute('cx', lx.toFixed(1));
        dot.setAttribute('cy', ly.toFixed(1));
        dot.setAttribute('r', 2.5);
        dot.setAttribute('class', 'hot-spark-dot');
        svg.append(area, line, dot);
    }
    return svg;
}

function selectHotTopic(name, { scroll = false } = {}) {
    if (!hotTopicByName(name)) return;
    selectedHotTopic = name;
    renderHotGrid();
    renderHotPanel();
    renderHotChart();
    if (scroll) document.getElementById('hot')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function renderHotPanel() {
    const panel = document.getElementById('hotPanel');
    panel.innerHTML = '';
    const topic = hotTopicByName(selectedHotTopic);
    if (!topic) return;
    const location = selectedLocation;
    const locationName = location === 'Sweden' ? 'Sweden' : location;

    const heading = el('h4', 'network-panel-title');
    const swatch = el('span', 'skill-swatch');
    swatch.style.backgroundColor = hotColor(topic.name);
    heading.append(swatch, document.createTextNode(topic.name));
    panel.appendChild(heading);
    panel.appendChild(el('p', 'network-panel-meta', topic.description));

    const ads = topic.ads_by_location?.[location] ?? 0;
    const total = hotTopics.totals_by_location?.[location] ?? hotTopics.total_ads;
    const trend = hotTrend(topic.name, location);
    let summary = `${ads.toLocaleString()} of ${total.toLocaleString()} live Data/IT ads in ${locationName} (${hotShare(topic, location)}%).`;
    if (trend) {
        const first = hotSeries(topic.name, location)?.[hotYears[0]];
        summary += ` In ads published: ${first == null ? '–' : first.toFixed(1) + '%'} in ${hotYears[0]}, ${trend.before.toFixed(1)}% in ${trend.from}, ${trend.now.toFixed(1)}% in ${trend.last}${trend.last === '2026' ? ' so far' : ''}.`;
    }
    panel.appendChild(el('p', 'network-panel-meta', summary));

    if (topic.skills?.length) {
        panel.appendChild(el('p', 'network-panel-subhead', 'Skills these ads ask for'));
        const row = el('div', 'hot-chips');
        const categoryOf = typeof skillCategories === 'function' ? skillCategories() : {};
        topic.skills.slice(0, 6).forEach(skill => {
            const chip = el('span', 'co-occurrence-chip hot-chip');
            const dot = el('span', 'skill-swatch');
            dot.style.backgroundColor = categoryColor(categoryOf[skill.name]);
            chip.append(dot, document.createTextNode(`${skill.name} ${skill.percent}%`));
            chip.title = `${skill.percent}% of the ${topic.name} ads (all of Sweden) mention ${skill.name}`;
            row.appendChild(chip);
        });
        panel.appendChild(row);
    }

    if (topic.titles?.length) {
        panel.appendChild(el('p', 'network-panel-subhead', 'Most common job titles'));
        const row = el('div', 'hot-chips');
        topic.titles.forEach(title => {
            const chip = document.createElement('button');
            chip.type = 'button';
            chip.className = 'co-occurrence-chip hot-chip hot-chip-link';
            chip.textContent = `${title.name} ${title.percent}%`;
            chip.title = `See ${title.name} in Job titles`;
            chip.addEventListener('click', () => {
                if (typeof selectTitle === 'function') selectTitle(title.name, { scroll: true });
            });
            row.appendChild(chip);
        });
        panel.appendChild(row);
    }

    const samples = (topic.samples?.[location] || []).slice(0, HOT_SAMPLES_SHOWN);
    panel.appendChild(el('p', 'network-panel-subhead', samples.length ? 'Latest openings' : 'No live openings here right now'));
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

function renderHotChart() {
    const card = document.getElementById('hotChartCard');
    const canvas = document.getElementById('hotChart');
    if (!card || !canvas || !window.Chart) return;
    const history = hotHistory[selectedLocation] || hotHistory.Sweden;
    if (!history || hotYears.length < 2) {
        card.hidden = true;
        return;
    }
    card.hidden = false;
    const theme = chartTheme();
    const datasets = hotTopics.topics.map(topic => {
        const selected = topic.name === selectedHotTopic;
        const color = hotColor(topic.name);
        return {
            label: topic.name,
            data: hotYears.map(year => {
                const v = history[topic.name]?.[year];
                return v == null ? null : +v.toFixed(2);
            }),
            borderColor: selected ? color : color + '80',
            backgroundColor: color,
            borderWidth: selected ? 3 : 1.75,
            pointRadius: 0,
            pointHoverRadius: 5,
            pointHoverBorderWidth: 2,
            pointHoverBorderColor: theme.surface,
            tension: 0.3,
            cubicInterpolationMode: 'monotone',
            order: selected ? 0 : 1   // drawn on top
        };
    });
    if (hotChart) hotChart.destroy();
    hotChart = new Chart(canvas.getContext('2d'), {
        type: 'line',
        data: { labels: hotYears, datasets },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            onClick: (event, elements, chart) => {
                const hit = chart.getElementsAtEventForMode(event, 'nearest', { intersect: true }, false)[0];
                if (hit) selectHotTopic(datasets[hit.datasetIndex].label);
            },
            plugins: {
                legend: {
                    position: 'top',
                    align: 'start',
                    onClick: (event, item) => selectHotTopic(item.text),
                    // Keep the topics' own order; Chart.js would otherwise sort by draw order.
                    labels: { sort: (a, b) => a.datasetIndex - b.datasetIndex, color: theme.ink, usePointStyle: true, pointStyle: 'circle', boxWidth: 8, boxHeight: 8, padding: 16, font: { size: 12.5, weight: '500' } }
                },
                tooltip: {
                    ...tooltipStyle(theme),
                    displayColors: true,
                    usePointStyle: true,
                    itemSort: (a, b) => b.raw - a.raw,
                    callbacks: {
                        title: (items) => items[0].label === '2026' ? '2026 (Jan–Oct)' : items[0].label,
                        label: (item) => ` ${item.raw.toFixed(1)}%  ${item.dataset.label}`,
                        labelColor: (item) => ({ borderColor: item.dataset.backgroundColor, backgroundColor: item.dataset.backgroundColor })
                    }
                }
            },
            scales: {
                x: {
                    grid: { display: false },
                    border: { color: theme.axis },
                    ticks: { color: theme.muted, maxRotation: 0, autoSkipPadding: 12 }
                },
                y: {
                    beginAtZero: true,
                    grid: { color: theme.grid },
                    border: { display: false },
                    ticks: { color: theme.muted, callback: (value) => `${value}%`, padding: 8 },
                    title: { display: true, text: 'Share of Data/IT ads', color: theme.muted, font: { size: 12 } }
                }
            }
        }
    });
}
