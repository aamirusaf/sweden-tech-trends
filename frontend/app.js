// On Windows with non-100% display scaling, devicePixelRatio is fractional
// (e.g. 1.25, 1.5). Chart.js sizes the canvas backing store against that
// fractional ratio, and sub-pixel rounding causes it to re-detect a "resize"
// every frame -> infinite redraw loop. Rounding to a whole number fixes it.
if (window.Chart) {
    Chart.defaults.devicePixelRatio = Math.round(window.devicePixelRatio) || 1;
}

const CATEGORY_COLORS = {
    'Languages':     { light: '#2a78d6', dark: '#3987e5' },
    'Cloud & Infra': { light: '#eb6834', dark: '#d95926' },
    'Platforms & Data': { light: '#1baf7a', dark: '#199e70' }
};

const charts = [];
const KNOWN_SKILLS_KEY = 'techTrends.knownSkills';

const LOCATION_LABELS = {
    'Sweden': '🇸🇪 All of Sweden'
};

let rawCategoryData = {}; // { category: [{ name, value, by_location }] }
let allSkills = [];       // flat list: [{ name, category, by_location }]
let coursesData = {};     // { skillName: [{ title, platform, url }] }
let jobPostingsData = {}; // { skillName: { location: [{ headline, employer, location, url, published }] } }
let coOccurrenceData = {}; // { skillName: [{ name, count, percent }] }
let remoteWorkData = {};   // { skillName: { percent, sample_size } }
let trendsBySkill = {};   // { skillName: { previousValue, previousDate } }
let locationOptions = ['Sweden'];
let selectedLocation = 'Sweden';
let selectedSkill = null;
let knownSkills = new Set(loadKnownSkills());
let historicalYearly = {}; // { location: { year: { total, skills: { skillName: ads } } } }
let selectedHistoryCategory = 'Languages';
let historyChart = null;

// Categorical palette for the history lines, assigned in fixed order by each skill's
// position within its category (so a skill keeps its color across location changes).
// Light/dark steps of the same eight hues; validated for adjacent-pair CVD separation.
const SERIES_COLORS = {
    light: ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948'],
    dark:  ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767']
};

function skillValue(skill, location = selectedLocation) {
    return (skill.by_location && skill.by_location[location]) ?? skill.value ?? 0;
}

document.addEventListener('DOMContentLoaded', () => {
    Promise.all([
        fetch('../backend/data/tech_trends.json').then(response => {
            if (!response.ok) {
                throw new Error('Network response error. Make sure your local server spans both directories.');
            }
            return response.json();
        }),
        fetch('../backend/data/courses.json').then(response => response.ok ? response.json() : {}),
        fetch('../backend/data/job_postings.json').then(response => response.ok ? response.json() : { postings: {} }),
        fetch('../backend/data/history.json').then(response => response.ok ? response.json() : { snapshots: [] }),
        fetch('../backend/data/co_occurrence.json').then(response => response.ok ? response.json() : { co_occurrence: {} }),
        fetch('../backend/data/historical_monthly.csv').then(response => response.ok ? response.text() : '').catch(() => '')
    ])
        .then(([jsonData, courses, jobPostings, history, coOccurrence, historicalCsv]) => {
            historicalYearly = aggregateHistoricalByYear(historicalCsv);
            coursesData = courses;
            jobPostingsData = jobPostings.postings || {};
            coOccurrenceData = coOccurrence.co_occurrence || {};
            remoteWorkData = coOccurrence.remote_work || {};
            trendsBySkill = computeTrends(history);

            // Update the UI timestamp string
            document.getElementById('timestamp').innerText = `Last updated: ${jsonData.last_updated}`;

            rawCategoryData = jsonData.data;
            allSkills = Object.entries(jsonData.data).flatMap(([category, skills]) =>
                skills.map(skill => ({ ...skill, category }))
            );

            const sampleSkill = allSkills.find(skill => skill.by_location);
            if (sampleSkill) locationOptions = Object.keys(sampleSkill.by_location);

            renderLocationFilter();
            renderCharts();
            renderSkillPicker();
            renderSkillGapResults();
            renderJobPostings();
            renderHistory();
        })
        .catch(error => {
            console.error('Error loading dynamic metrics:', error);
            document.getElementById('timestamp').innerText = 'Error loading trending data.';
        });
});

function loadKnownSkills() {
    try {
        return JSON.parse(localStorage.getItem(KNOWN_SKILLS_KEY)) || [];
    } catch {
        return [];
    }
}

function saveKnownSkills() {
    localStorage.setItem(KNOWN_SKILLS_KEY, JSON.stringify([...knownSkills]));
}

function computeTrends(history) {
    const snapshots = [...(history.snapshots || [])].sort((a, b) => a.date.localeCompare(b.date));
    if (snapshots.length < 2) return {};

    const previous = snapshots[snapshots.length - 2];
    const trends = {};
    Object.values(previous.data).flat().forEach(skill => {
        trends[skill.name] = { previousValue: skill.value, previousDate: previous.date };
    });
    return trends;
}

function trendLabel(skillName, currentValue) {
    // history.json only tracks nationwide numbers, so a % change while filtered
    // to a city would be misleading — only show it on the "All of Sweden" view.
    if (selectedLocation !== 'Sweden') return null;

    const trend = trendsBySkill[skillName];
    if (!trend || !trend.previousValue) return null;

    const change = Math.round(((currentValue - trend.previousValue) / trend.previousValue) * 100);
    if (change === 0) return { text: `flat since ${trend.previousDate}`, className: 'trend-flat' };

    const arrow = change > 0 ? '▲' : '▼';
    return {
        text: `${arrow} ${Math.abs(change)}% since ${trend.previousDate}`,
        className: change > 0 ? 'trend-up' : 'trend-down'
    };
}

// A category missing from CATEGORY_COLORS (e.g. data files written before the skill
// list changed) gets a neutral color instead of breaking the page.
const FALLBACK_COLOR = { light: '#6b7280', dark: '#9ca3af' };

function categoryColor(categoryKey) {
    return (CATEGORY_COLORS[categoryKey] || FALLBACK_COLOR)[isDarkMode() ? 'dark' : 'light'];
}

function renderLocationFilter() {
    const container = document.getElementById('locationFilter');
    if (!container) return;
    container.innerHTML = '';

    locationOptions.forEach(location => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'location-pill' + (location === selectedLocation ? ' location-pill-active' : '');
        button.textContent = LOCATION_LABELS[location] || location;
        button.addEventListener('click', () => {
            if (location === selectedLocation) return;
            selectedLocation = location;
            renderLocationFilter();
            renderCharts();
            renderSkillGapResults();
            renderJobPostings();
            renderHistory();
        });
        container.appendChild(button);
    });
}

function renderCharts() {
    charts.forEach(chart => chart && chart.destroy());
    charts.length = 0;

    const buildCategoryData = (categoryKey) =>
        (rawCategoryData[categoryKey] || []).map(skill => ({ name: skill.name, value: skillValue(skill) }));

    charts.push(createChart('languagesChart', buildCategoryData('Languages'), 'Languages'));
    charts.push(createChart('cloudChart', buildCategoryData('Cloud & Infra'), 'Cloud & Infra'));
    charts.push(createChart('dataChart', buildCategoryData('Platforms & Data'), 'Platforms & Data'));
}

function renderSkillPicker() {
    const container = document.getElementById('skillPicker');
    if (!container) return;
    container.innerHTML = '';

    const byCategory = Object.groupBy(allSkills, skill => skill.category);

    Object.entries(byCategory).forEach(([category, skills]) => {
        const heading = document.createElement('p');
        heading.className = 'skill-category-label';
        heading.textContent = category;
        container.appendChild(heading);

        skills.forEach(skill => {
            const row = document.createElement('label');
            row.className = 'skill-check-row';

            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.checked = knownSkills.has(skill.name);
            checkbox.addEventListener('change', () => {
                if (checkbox.checked) {
                    knownSkills.add(skill.name);
                } else {
                    knownSkills.delete(skill.name);
                }
                saveKnownSkills();
                renderSkillGapResults();
            });

            const swatch = document.createElement('span');
            swatch.className = 'skill-swatch';
            swatch.style.backgroundColor = categoryColor(category);

            const label = document.createElement('span');
            label.className = 'skill-label';
            label.textContent = skill.name;

            row.append(checkbox, swatch, label);
            container.appendChild(row);
        });
    });
}

function renderSkillGapResults() {
    const container = document.getElementById('skillGapResults');
    if (!container) return;
    container.innerHTML = '';

    const gaps = allSkills
        .filter(skill => !knownSkills.has(skill.name))
        .sort((a, b) => skillValue(b) - skillValue(a));

    if (gaps.length === 0) {
        const empty = document.createElement('p');
        empty.className = 'skill-gap-empty';
        empty.textContent = allSkills.length
            ? "You've checked off every tracked skill — nice work!"
            : 'Loading recommendations…';
        container.appendChild(empty);
        return;
    }

    gaps.forEach((skill, index) => {
        const item = document.createElement('div');
        item.className = 'skill-gap-item skill-gap-item-clickable';
        item.addEventListener('click', () => showJobPostings(skill.name));

        const header = document.createElement('div');
        header.className = 'skill-gap-item-header';

        const rank = document.createElement('span');
        rank.className = 'skill-gap-rank';
        rank.textContent = `#${index + 1}`;

        const swatch = document.createElement('span');
        swatch.className = 'skill-swatch';
        swatch.style.backgroundColor = categoryColor(skill.category);

        const name = document.createElement('span');
        name.className = 'skill-gap-name';
        name.textContent = skill.name;

        const value = skillValue(skill);

        const count = document.createElement('span');
        count.className = 'skill-gap-count';
        count.textContent = `${value} postings`;

        header.append(rank, swatch, name, count);

        const trend = trendLabel(skill.name, value);
        if (trend) {
            const trendBadge = document.createElement('span');
            trendBadge.className = `skill-gap-trend ${trend.className}`;
            trendBadge.textContent = trend.text;
            header.append(trendBadge);
        }

        const courseLinks = document.createElement('div');
        courseLinks.className = 'skill-gap-courses';
        const courses = coursesData[skill.name] || [];
        if (courses.length) {
            courses.forEach(course => {
                const link = document.createElement('a');
                link.href = course.url;
                link.target = '_blank';
                link.rel = 'noopener noreferrer';
                link.textContent = `${course.title} (${course.platform})`;
                courseLinks.appendChild(link);
            });
        } else {
            courseLinks.textContent = 'No curated courses yet for this skill.';
        }

        item.append(header, courseLinks);
        container.appendChild(item);
    });
}

function showJobPostings(skillName) {
    selectedSkill = skillName;
    renderJobPostings();
}

function renderJobPostings() {
    const container = document.getElementById('jobPostings');
    const title = document.getElementById('jobPostingsTitle');
    if (!container) return;
    container.innerHTML = '';

    if (!selectedSkill) {
        const hint = document.createElement('p');
        hint.className = 'skill-gap-empty';
        hint.textContent = 'Click a skill to see live job postings.';
        container.appendChild(hint);
        return;
    }

    const locationSuffix = selectedLocation === 'Sweden' ? '' : ` · ${selectedLocation}`;
    if (title) title.textContent = `Job Postings — ${selectedSkill}${locationSuffix}`;

    const remoteInfo = remoteWorkData[selectedSkill];
    if (remoteInfo) {
        const remoteBadge = document.createElement('p');
        remoteBadge.className = 'remote-work-badge';
        remoteBadge.textContent = `🏠 ${remoteInfo.percent}% of sampled postings mention remote/hybrid work (of ${remoteInfo.sample_size} nationwide)`;
        container.appendChild(remoteBadge);
    }

    const coOccurring = coOccurrenceData[selectedSkill] || [];
    if (coOccurring.length) {
        const row = document.createElement('div');
        row.className = 'co-occurrence-row';

        const label = document.createElement('span');
        label.className = 'co-occurrence-label';
        label.textContent = 'Also seen with:';
        row.appendChild(label);

        coOccurring.forEach(entry => {
            const chip = document.createElement('span');
            chip.className = 'co-occurrence-chip';
            chip.textContent = `${entry.name} · ${entry.percent}%`;
            row.appendChild(chip);
        });

        container.appendChild(row);
    }

    const postings = (jobPostingsData[selectedSkill] && jobPostingsData[selectedSkill][selectedLocation]) || [];
    if (!postings.length) {
        const empty = document.createElement('p');
        empty.className = 'skill-gap-empty';
        empty.textContent = `No sample postings available for ${selectedSkill}${locationSuffix} right now.`;
        container.appendChild(empty);
        return;
    }

    postings.forEach(posting => {
        const card = document.createElement('a');
        card.className = 'job-posting-card';
        card.href = posting.url || '#';
        card.target = '_blank';
        card.rel = 'noopener noreferrer';

        const headline = document.createElement('div');
        headline.className = 'job-posting-headline';
        headline.textContent = posting.headline || 'Untitled role';

        const meta = document.createElement('div');
        meta.className = 'job-posting-meta';
        meta.textContent = [posting.employer, posting.location].filter(Boolean).join(' · ');

        card.append(headline, meta);
        container.appendChild(card);
    });
}

function isDarkMode() {
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
}

function chartTheme() {
    return isDarkMode()
        ? { ink: '#c3c2b7', grid: '#2c2c2a', axis: '#383835' }
        : { ink: '#52514e', grid: '#e1e0d9', axis: '#c3c2b7' };
}

function createChart(canvasId, categoryData, categoryKey) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return null;

    const ctx = canvas.getContext('2d');
    const theme = chartTheme();
    const barColor = categoryColor(categoryKey);

    // Sort items descending based on active job volume count
    const sorted = [...categoryData].sort((a, b) => b.value - a.value);
    const labels = sorted.map(item => item.name);
    const dataValues = sorted.map(item => item.value);

    return new Chart(ctx, {
        type: 'bar',
        data: {
            labels: labels,
            datasets: [{
                label: 'Active job postings',
                data: dataValues,
                backgroundColor: barColor,
                borderRadius: 4,
                borderSkipped: false,
                maxBarThickness: 28
            }]
        },
        options: {
            indexAxis: 'y', // Generates horizontal bar charts for clean text scanning
            responsive: true,
            maintainAspectRatio: false, // The .chart-wrapper element controls actual height
            layout: {
                padding: { right: 12 }
            },
            onClick: (_evt, elements) => {
                if (elements.length) showJobPostings(labels[elements[0].index]);
            },
            onHover: (evt, elements) => {
                evt.native.target.style.cursor = elements.length ? 'pointer' : 'default';
            },
            plugins: {
                legend: { display: false },
                tooltip: {
                    callbacks: {
                        label: (item) => `${item.formattedValue} job postings`,
                        afterLabel: (item) => trendLabel(item.label, item.raw)?.text || ''
                    }
                }
            },
            scales: {
                x: {
                    beginAtZero: true,
                    grid: { color: theme.grid },
                    border: { color: theme.axis },
                    ticks: { color: theme.ink }
                },
                y: {
                    grid: { display: false },
                    border: { color: theme.axis },
                    ticks: { color: theme.ink }
                }
            }
        }
    });
}

// --- Long-term history (historical_monthly.csv) -------------------------------

function aggregateHistoricalByYear(csvText) {
    // CSV columns: month,category,skill,location,ads,total_ads. Values are plain
    // (no quoted commas), so a simple split is enough.
    const byLocation = {};
    const lines = (csvText || '').trim().split('\n');
    if (lines.length < 2) return byLocation;

    const seenTotals = new Set();
    for (const line of lines.slice(1)) {
        const [month, , skill, location, ads, totalAds] = line.split(',');
        if (!month || !location) continue;
        const year = month.slice(0, 4);
        const yearEntry = ((byLocation[location] ??= {})[year] ??= { total: 0, skills: {} });
        yearEntry.skills[skill] = (yearEntry.skills[skill] || 0) + Number(ads);
        // total_ads repeats on every skill row for a month/location; count it once
        const totalKey = `${month}|${location}`;
        if (!seenTotals.has(totalKey)) {
            seenTotals.add(totalKey);
            yearEntry.total += Number(totalAds);
        }
    }
    return byLocation;
}

function renderHistory() {
    const section = document.querySelector('.history-section');
    const canvas = document.getElementById('historyChart');
    if (!section || !canvas) return;

    const yearly = historicalYearly[selectedLocation];
    if (!yearly || !Object.keys(rawCategoryData).length) {
        section.hidden = true;
        return;
    }
    section.hidden = false;

    renderHistoryCategoryFilter();

    const years = Object.keys(yearly).sort();
    const skills = (rawCategoryData[selectedHistoryCategory] || []).map(skill => skill.name);
    const palette = SERIES_COLORS[isDarkMode() ? 'dark' : 'light'];
    const theme = chartTheme();

    const datasets = skills.map((skill, index) => ({
        label: skill,
        data: years.map(year => {
            const { total, skills: counts } = yearly[year];
            return total ? +(100 * (counts[skill] || 0) / total).toFixed(3) : null;
        }),
        borderColor: palette[index % palette.length],
        backgroundColor: palette[index % palette.length],
        borderWidth: 2,
        pointRadius: 0,
        pointHoverRadius: 5,
        pointHoverBorderWidth: 2,
        pointHoverBorderColor: getComputedStyle(document.documentElement).getPropertyValue('--surface').trim() || '#fff',
        tension: 0.25
    }));

    if (historyChart) historyChart.destroy();
    historyChart = new Chart(canvas.getContext('2d'), {
        type: 'line',
        data: { labels: years, datasets },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            plugins: {
                legend: {
                    position: 'top',
                    align: 'start',
                    labels: { color: theme.ink, usePointStyle: true, pointStyle: 'line', boxWidth: 24 }
                },
                tooltip: {
                    itemSort: (a, b) => b.raw - a.raw,
                    callbacks: {
                        title: (items) => items[0].label === '2026' ? '2026 (Jan–Oct)' : items[0].label,
                        label: (item) => ` ${item.raw.toFixed(2)}%  ${item.dataset.label}`
                    }
                }
            },
            scales: {
                x: {
                    grid: { display: false },
                    border: { color: theme.axis },
                    ticks: { color: theme.ink, maxRotation: 0, autoSkipPadding: 12 }
                },
                y: {
                    beginAtZero: true,
                    grid: { color: theme.grid },
                    border: { display: false },
                    ticks: { color: theme.ink, callback: (value) => `${value}%` },
                    title: { display: true, text: 'Share of all ads', color: theme.ink }
                }
            }
        }
    });

    renderHistoryTable(years, datasets);
}

function renderHistoryCategoryFilter() {
    const container = document.getElementById('historyCategoryFilter');
    if (!container) return;
    container.innerHTML = '';

    Object.keys(rawCategoryData).forEach(category => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'location-pill' + (category === selectedHistoryCategory ? ' location-pill-active' : '');
        button.setAttribute('aria-pressed', String(category === selectedHistoryCategory));
        button.textContent = category;
        button.addEventListener('click', () => {
            if (category === selectedHistoryCategory) return;
            selectedHistoryCategory = category;
            renderHistory();
        });
        container.appendChild(button);
    });
}

function renderHistoryTable(years, datasets) {
    const table = document.getElementById('historyTable');
    if (!table) return;
    table.innerHTML = '';

    const caption = document.createElement('caption');
    caption.className = 'visually-hidden';
    caption.textContent = `Share of job ads (%) by year, ${selectedHistoryCategory}, ${LOCATION_LABELS[selectedLocation] || selectedLocation}`;
    table.appendChild(caption);

    const headRow = table.createTHead().insertRow();
    ['Skill', ...years].forEach(text => {
        const th = document.createElement('th');
        th.scope = 'col';
        th.textContent = text;
        headRow.appendChild(th);
    });

    const body = table.createTBody();
    datasets.forEach(dataset => {
        const row = body.insertRow();
        const th = document.createElement('th');
        th.scope = 'row';
        th.textContent = dataset.label;
        row.appendChild(th);
        dataset.data.forEach(value => {
            row.insertCell().textContent = value == null ? '–' : `${value.toFixed(2)}%`;
        });
    });
}

// React to the viewer switching OS-level light/dark mode without a page reload
if (window.matchMedia) {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
        const theme = chartTheme();
        charts.forEach(chart => {
            if (!chart) return;
            const categoryKey = Object.keys(CATEGORY_COLORS).find(key =>
                CATEGORY_COLORS[key].light === chart.data.datasets[0].backgroundColor ||
                CATEGORY_COLORS[key].dark === chart.data.datasets[0].backgroundColor
            );
            chart.data.datasets[0].backgroundColor = categoryColor(categoryKey);
            chart.options.scales.x.grid.color = theme.grid;
            chart.options.scales.x.border.color = theme.axis;
            chart.options.scales.x.ticks.color = theme.ink;
            chart.options.scales.y.border.color = theme.axis;
            chart.options.scales.y.ticks.color = theme.ink;
            chart.update();
        });
        renderHistory();
    });
}
