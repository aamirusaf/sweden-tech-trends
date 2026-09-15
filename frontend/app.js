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
    'Data & AI':     { light: '#1baf7a', dark: '#199e70' }
};

const charts = [];
const KNOWN_SKILLS_KEY = 'techTrends.knownSkills';

let allSkills = [];   // flat list: [{ name, value, category }]
let coursesData = {}; // { skillName: [{ title, platform, url }] }
let knownSkills = new Set(loadKnownSkills());

document.addEventListener('DOMContentLoaded', () => {
    Promise.all([
        fetch('../backend/data/tech_trends.json').then(response => {
            if (!response.ok) {
                throw new Error('Network response error. Make sure your local server spans both directories.');
            }
            return response.json();
        }),
        fetch('../backend/data/courses.json').then(response => response.ok ? response.json() : {})
    ])
        .then(([jsonData, courses]) => {
            coursesData = courses;

            // Update the UI timestamp string
            document.getElementById('timestamp').innerText = `Last updated: ${jsonData.last_updated}`;

            // Build individual metrics charts safely
            charts.push(createChart('languagesChart', jsonData.data['Languages'], 'Languages'));
            charts.push(createChart('cloudChart', jsonData.data['Cloud & Infra'], 'Cloud & Infra'));
            charts.push(createChart('dataChart', jsonData.data['Data & AI'], 'Data & AI'));

            allSkills = Object.entries(jsonData.data).flatMap(([category, skills]) =>
                skills.map(skill => ({ ...skill, category }))
            );

            renderSkillPicker();
            renderSkillGapResults();
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

function categoryColor(categoryKey) {
    return CATEGORY_COLORS[categoryKey][isDarkMode() ? 'dark' : 'light'];
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
        .sort((a, b) => b.value - a.value);

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
        item.className = 'skill-gap-item';

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

        const count = document.createElement('span');
        count.className = 'skill-gap-count';
        count.textContent = `${skill.value} postings`;

        header.append(rank, swatch, name, count);

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
    const barColor = CATEGORY_COLORS[categoryKey][isDarkMode() ? 'dark' : 'light'];

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
            plugins: {
                legend: { display: false },
                tooltip: {
                    callbacks: {
                        label: (item) => `${item.formattedValue} job postings`
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
            chart.data.datasets[0].backgroundColor = CATEGORY_COLORS[categoryKey][isDarkMode() ? 'dark' : 'light'];
            chart.options.scales.x.grid.color = theme.grid;
            chart.options.scales.x.border.color = theme.axis;
            chart.options.scales.x.ticks.color = theme.ink;
            chart.options.scales.y.border.color = theme.axis;
            chart.options.scales.y.ticks.color = theme.ink;
            chart.update();
        });
    });
}
