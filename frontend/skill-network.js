// "How the skills connect": a radial tree of the tracked skills (Data/IT -> category ->
// skill). Clicking a skill lights up the companion skills that, learned together with
// it, cover most of the Data/IT ads that mention it, and draws a link to every skill
// it shares ads with. Data: backend/data/skill_network.json (see backend/skill_network.py).
// Picking a job title in the "Job Titles" section (job-titles.js) switches the tree to
// that title: its typical skills light up, with the share of its ads that mention each.
// Relies on categoryColor, allSkills and showJobPostings from app.js.

const SVG_NS = 'http://www.w3.org/2000/svg';
const NETWORK_GEOMETRY = {
    view: 360,        // viewBox runs from -view to +view
    categoryRadius: 92,
    leafRadius: 205,
    labelRadius: 222,
    categoryGap: 0.5  // empty leaf slots between categories
};

let skillNetwork = null;
let networkSelected = null;
let networkTitle = null;   // a job title shown in the tree instead of a skill, or null
let networkLayout = {}; // { skillName: { x, y, angle, category } }

function renderSkillNetwork(network) {
    skillNetwork = network && network.bundles ? network : null;
    const container = document.getElementById('skillNetwork');
    if (!container) return;

    if (!skillNetwork) {
        container.innerHTML = '<p class="skill-gap-empty">Skill connections appear after the next weekly data update.</p>';
        return;
    }

    // Default to the skill with the most ads, so the chart opens with something lit up.
    if (!networkSelected || !skillNetwork.ads[networkSelected]) {
        networkSelected = Object.entries(skillNetwork.bundles)
            .sort((a, b) => (skillNetwork.ads[b[0]] || 0) - (skillNetwork.ads[a[0]] || 0))
            .map(([name]) => name)[0] || null;
    }

    drawNetworkTree();
    renderNetworkPanel();
}

function networkCategories() {
    if (skillNetwork.categories) return skillNetwork.categories;
    const byCategory = {};
    allSkills.forEach(skill => (byCategory[skill.category] ||= []).push(skill.name));
    return byCategory;
}

function polar(radius, angle) {
    // angle 0 points up, clockwise
    return { x: radius * Math.sin(angle), y: -radius * Math.cos(angle) };
}

function svgEl(tag, attrs = {}) {
    const el = document.createElementNS(SVG_NS, tag);
    Object.entries(attrs).forEach(([key, value]) => el.setAttribute(key, value));
    return el;
}

function bundleOf(skill) {
    const bundle = skillNetwork.bundles[skill];
    return bundle ? bundle.steps.map(step => step.skill) : [];
}

function drawNetworkTree() {
    const container = document.getElementById('skillNetwork');
    container.innerHTML = '';
    const g = NETWORK_GEOMETRY;
    const categories = networkCategories();

    // Lay the leaves out on a circle, grouped by category, with a gap between groups.
    const slots = Object.values(categories).reduce((n, skills) => n + skills.length + g.categoryGap, 0);
    const step = (2 * Math.PI) / slots;
    let cursor = step * g.categoryGap / 2;
    const categoryAngles = {};
    networkLayout = {};
    Object.entries(categories).forEach(([category, skills]) => {
        const start = cursor;
        skills.forEach(name => {
            const angle = cursor + step / 2;
            networkLayout[name] = { ...polar(g.leafRadius, angle), angle, category };
            cursor += step;
        });
        categoryAngles[category] = (start + cursor) / 2;
        cursor += step * g.categoryGap;
    });

    const svg = svgEl('svg', {
        viewBox: `${-g.view} ${-g.view} ${2 * g.view} ${2 * g.view}`,
        class: 'network-svg',
        role: 'group',
        'aria-label': 'Tree of the tracked skills. Select a skill to highlight the skills to learn with it.'
    });

    const defs = svgEl('defs');
    const glow = svgEl('filter', { id: 'networkGlow', x: '-100%', y: '-100%', width: '300%', height: '300%' });
    glow.append(
        svgEl('feGaussianBlur', { in: 'SourceGraphic', stdDeviation: '4', result: 'blur' }),
        (() => {
            const merge = svgEl('feMerge');
            merge.append(svgEl('feMergeNode', { in: 'blur' }), svgEl('feMergeNode', { in: 'SourceGraphic' }));
            return merge;
        })()
    );
    defs.appendChild(glow);
    svg.appendChild(defs);

    // Title mode: no selected skill; the title's typical skills light up instead.
    const titleSkills = networkTitle && typeof typicalSkills === 'function' ? typicalSkills(networkTitle) : [];
    const titlePercent = Object.fromEntries(titleSkills.map(t => [t.skill, t.percent]));
    const selected = networkTitle ? null : networkSelected;
    const bundle = new Set(networkTitle ? titleSkills.map(t => t.skill) : bundleOf(selected));
    const lit = new Set([selected, ...bundle].filter(Boolean));
    const litCategories = new Set([...lit].map(name => networkLayout[name]?.category));
    const pairs = (skillNetwork.pairs && skillNetwork.pairs[selected]) || {};
    const selectedAds = skillNetwork.ads[selected] || 0;

    // Tree branches: root -> category -> skill.
    const branches = svgEl('g', { class: 'network-branches' });
    Object.entries(categories).forEach(([category, skills]) => {
        const c = polar(g.categoryRadius, categoryAngles[category]);
        branches.appendChild(svgEl('line', {
            x1: 0, y1: 0, x2: c.x, y2: c.y,
            class: 'network-branch' + (litCategories.has(category) ? ' is-lit' : ''),
            style: litCategories.has(category) ? `stroke: ${categoryColor(category)}` : ''
        }));
        skills.forEach(name => {
            const leaf = networkLayout[name];
            const mid = (g.categoryRadius + g.leafRadius) / 2;
            const c1 = polar(mid, categoryAngles[category]);
            const c2 = polar(mid, leaf.angle);
            branches.appendChild(svgEl('path', {
                d: `M${c.x},${c.y} C${c1.x},${c1.y} ${c2.x},${c2.y} ${leaf.x},${leaf.y}`,
                class: 'network-branch' + (lit.has(name) ? ' is-lit' : ''),
                style: lit.has(name) ? `stroke: ${categoryColor(category)}` : ''
            }));
        });
    });
    svg.appendChild(branches);

    // Links from the selected skill to every skill it shares ads with, bent toward the
    // centre. Width shows the share of the selected skill's ads that mention the other.
    const links = svgEl('g', { class: 'network-links' });
    const from = networkLayout[selected];
    if (from && selectedAds) {
        Object.entries(pairs)
            .filter(([name]) => networkLayout[name])
            .sort((a, b) => bundle.has(a[0]) - bundle.has(b[0])) // bundle links on top
            .forEach(([name, count]) => {
                const to = networkLayout[name];
                const share = count / selectedAds;
                const inBundle = bundle.has(name);
                const path = svgEl('path', {
                    d: `M${from.x},${from.y} Q${(from.x + to.x) * 0.15},${(from.y + to.y) * 0.15} ${to.x},${to.y}`,
                    class: 'network-link' + (inBundle ? ' is-bundle' : ''),
                    'stroke-width': (0.75 + share * 9).toFixed(2),
                    style: inBundle ? `stroke: ${categoryColor(to.category)}` : ''
                });
                const title = svgEl('title');
                title.textContent = `${Math.round(100 * share)}% of ${selected} ads also mention ${name}`;
                path.appendChild(title);
                links.appendChild(path);
            });
    }
    svg.appendChild(links);

    // Root and category nodes.
    const hubs = svgEl('g', { class: 'network-hubs' });
    const root = svgEl('circle', { r: 26, class: 'network-root' });
    const rootLabel = svgEl('text', { class: 'network-root-label', 'text-anchor': 'middle', dy: '0.35em' });
    rootLabel.textContent = 'Data/IT';
    if (networkTitle) root.classList.add('is-title');
    hubs.append(root, rootLabel);
    Object.keys(categories).forEach(category => {
        const c = polar(g.categoryRadius, categoryAngles[category]);
        hubs.appendChild(svgEl('circle', {
            cx: c.x, cy: c.y, r: 7,
            fill: categoryColor(category),
            class: 'network-category-node' + (litCategories.has(category) ? ' is-lit' : '')
        }));
        const label = svgEl('text', {
            x: c.x, y: c.y + (c.y < 0 ? -14 : 22),
            'text-anchor': 'middle',
            class: 'network-category-label'
        });
        label.textContent = category;
        hubs.appendChild(label);
    });
    svg.appendChild(hubs);

    // Skill leaves, sized by how many Data/IT ads mention them.
    const maxAds = Math.max(1, ...Object.values(skillNetwork.ads));
    const leaves = svgEl('g', { class: 'network-leaves' });
    const order = bundleOf(selected);
    Object.entries(networkLayout).forEach(([name, leaf]) => {
        const ads = skillNetwork.ads[name] || 0;
        const radius = 5 + 8 * Math.sqrt(ads / maxAds);
        const color = categoryColor(leaf.category);
        const state = name === selected ? 'is-selected' : bundle.has(name) ? 'is-bundle' : 'is-dim';

        const node = svgEl('g', {
            class: `network-leaf ${state}`,
            tabindex: 0,
            role: 'button',
            'aria-pressed': name === selected ? 'true' : 'false',
            'aria-label': `${name}, ${ads} live Data/IT ads`
        });
        const title = svgEl('title');
        title.textContent = `${name}: ${ads.toLocaleString()} live Data/IT ads`;
        node.appendChild(title);

        if (state !== 'is-dim') {
            node.appendChild(svgEl('circle', {
                cx: leaf.x, cy: leaf.y, r: radius + 5,
                class: 'network-halo', stroke: color
            }));
        }
        node.appendChild(svgEl('circle', {
            cx: leaf.x, cy: leaf.y, r: radius,
            fill: color,
            class: 'network-dot',
            filter: state !== 'is-dim' ? 'url(#networkGlow)' : ''
        }));
        // Generous invisible hit area for touch screens.
        node.appendChild(svgEl('circle', { cx: leaf.x, cy: leaf.y, r: 18, class: 'network-hit' }));

        const l = polar(g.labelRadius, leaf.angle);
        const sin = Math.sin(leaf.angle);
        const anchor = Math.abs(sin) < 0.2 ? 'middle' : sin > 0 ? 'start' : 'end';
        const dy = Math.abs(sin) < 0.2 ? (l.y < 0 ? -4 : 12) : 4;
        const label = svgEl('text', { x: l.x, y: l.y + dy, 'text-anchor': anchor, class: 'network-label' });
        label.textContent = name;
        if (bundle.has(name)) {
            // Step number (or, for a title, the share of its ads) on the side facing
            // away from the circle.
            const badge = svgEl('tspan', { class: 'network-step' });
            const number = networkTitle ? `${titlePercent[name]}%` : order.indexOf(name) + 1;
            badge.textContent = anchor === 'end' ? `${number} ` : ` ${number}`;
            if (anchor === 'end') label.prepend(badge);
            else label.appendChild(badge);
        }
        node.appendChild(label);

        const choose = () => selectNetworkSkill(name);
        node.addEventListener('click', choose);
        node.addEventListener('keydown', event => {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                choose();
            }
        });
        leaves.appendChild(node);
    });
    svg.appendChild(leaves);

    container.appendChild(svg);
}

// Show a job title's typical skills in the tree (called from job-titles.js).
function showTitleInNetwork(title) {
    if (!skillNetwork) return;
    networkTitle = title;
    drawNetworkTree();
    renderNetworkPanel();
}

function selectNetworkSkill(name) {
    if (!skillNetwork) return;
    networkSelected = name;
    networkTitle = null;
    const focused = document.activeElement && document.activeElement.closest
        ? document.activeElement.closest('.network-leaf') : null;
    drawNetworkTree();
    renderNetworkPanel();
    if (focused) {
        const again = [...document.querySelectorAll('.network-leaf')]
            .find(node => node.getAttribute('aria-label').startsWith(`${name},`));
        if (again) again.focus();
    }
}

// How lenient "match" is: older data files (no missing_allowed) used the strict rule.
function matchRule() {
    const missing = skillNetwork.missing_allowed || 0;
    if (!missing) return ' (they ask for no other tracked skill)';
    return missing === 1
        ? ' (you have every tracked skill they ask for, or all but one)'
        : ` (you lack at most ${missing} of the tracked skills they ask for)`;
}

function renderNetworkPanel() {
    const panel = document.getElementById('skillNetworkPanel');
    if (!panel) return;
    panel.innerHTML = '';
    if (skillNetwork && networkTitle) {
        renderNetworkTitlePanel(panel);
        return;
    }
    const name = networkSelected;
    if (!skillNetwork || !name) return;

    const ads = skillNetwork.ads[name] || 0;
    const bundle = skillNetwork.bundles[name];
    const category = networkLayout[name]?.category;

    const heading = document.createElement('h4');
    heading.className = 'network-panel-title';
    const swatch = document.createElement('span');
    swatch.className = 'skill-swatch';
    swatch.style.backgroundColor = categoryColor(category);
    heading.append(swatch, document.createTextNode(name));
    panel.appendChild(heading);

    const meta = document.createElement('p');
    meta.className = 'network-panel-meta';
    meta.textContent = `Mentioned in ${ads.toLocaleString()} of ${skillNetwork.total_ads.toLocaleString()} live Data/IT ads.`;
    panel.appendChild(meta);

    if (!bundle) {
        const few = document.createElement('p');
        few.className = 'network-panel-note';
        few.textContent = 'Too few ads right now to suggest companion skills.';
        panel.appendChild(few);
        return;
    }

    const intro = document.createElement('p');
    intro.className = 'network-panel-subhead';
    intro.textContent = `Learn with ${name}`;
    panel.appendChild(intro);

    const list = document.createElement('ol');
    list.className = 'network-steps';
    const rows = [{ label: `${name} alone`, coverage: bundle.alone, skill: null }]
        .concat(bundle.steps.map((step, index) => ({ label: `+ ${step.skill}`, coverage: step.coverage, skill: step.skill, index })));
    rows.forEach(row => {
        const item = document.createElement('li');
        item.className = 'network-step-row';

        const label = row.skill ? document.createElement('button') : document.createElement('span');
        label.className = 'network-step-label';
        if (row.skill) {
            label.type = 'button';
            label.title = `Show ${row.skill}'s connections`;
            label.addEventListener('click', () => selectNetworkSkill(row.skill));
            const num = document.createElement('span');
            num.className = 'network-step-num';
            num.textContent = row.index + 1;
            label.append(num, document.createTextNode(row.skill));
        } else {
            label.textContent = row.label;
        }

        const bar = document.createElement('span');
        bar.className = 'network-step-bar';
        const fill = document.createElement('span');
        fill.className = 'network-step-fill';
        fill.style.width = `${row.coverage}%`;
        fill.style.backgroundColor = categoryColor(category);
        bar.appendChild(fill);

        const value = document.createElement('span');
        value.className = 'network-step-value';
        value.textContent = `${row.coverage}%`;

        item.append(label, bar, value);
        list.appendChild(item);
    });
    panel.appendChild(list);

    const last = bundle.steps.length ? bundle.steps[bundle.steps.length - 1].coverage : bundle.alone;
    const summary = document.createElement('p');
    summary.className = 'network-panel-note';
    summary.textContent = !bundle.steps.length
        ? `${name} alone covers ${last}% of its ads; the rest ask for a wide mix of other skills.`
        : last >= (skillNetwork.target_percent || 50)
        ? `Knowing these makes you a match for ${last}% of ${name} ads${matchRule()}.`
        : `${name} ads ask for a wide mix of skills; these make you a match for ${last}% of them${matchRule()}.`;
    panel.appendChild(summary);

    appendTitlesForSkill(panel, name);

    const openings = document.createElement('button');
    openings.type = 'button';
    openings.className = 'location-pill network-openings';
    openings.textContent = `See live ${name} openings ↓`;
    openings.addEventListener('click', () => {
        showJobPostings(name);
        document.getElementById('jobPostings')?.closest('.card')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    panel.appendChild(openings);
}

// The job titles whose ads mention the skill most, each a link to the Job Titles section.
function appendTitlesForSkill(panel, skill) {
    const titles = typeof titlesForSkill === 'function' ? titlesForSkill(skill) : [];
    if (!titles.length) return;
    const sub = document.createElement('p');
    sub.className = 'network-panel-subhead';
    sub.textContent = `Job titles that ask for ${skill} most`;
    panel.appendChild(sub);
    const list = document.createElement('ul');
    list.className = 'network-title-links';
    titles.forEach(title => {
        const item = document.createElement('li');
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'network-title-link';
        button.title = `Open ${title.name} in Job Titles`;
        const label = document.createElement('span');
        label.textContent = title.name;
        const value = document.createElement('span');
        value.className = 'network-title-value';
        value.textContent = `${title.percent}% of its ads`;
        button.append(label, value);
        button.addEventListener('click', () => selectTitle(title.name, { scroll: true, fromTree: true }));
        item.appendChild(button);
        list.appendChild(item);
    });
    panel.appendChild(list);
}

function renderNetworkTitlePanel(panel) {
    const title = typeof titleByName === 'function' ? titleByName(networkTitle) : null;
    const skills = typicalSkills(networkTitle);

    const kicker = document.createElement('p');
    kicker.className = 'network-panel-subhead';
    kicker.textContent = 'Job title';
    const heading = document.createElement('h4');
    heading.className = 'network-panel-title';
    heading.textContent = networkTitle;
    panel.append(kicker, heading);

    const meta = document.createElement('p');
    meta.className = 'network-panel-meta';
    meta.textContent = title
        ? `${title.ads.toLocaleString()} live Data/IT ads have a title like this. Lit up: the skills at least ${TYPICAL_SKILL_PERCENT}% of them mention.`
        : '';
    panel.appendChild(meta);

    if (!skills.length) {
        const none = document.createElement('p');
        none.className = 'network-panel-note';
        none.textContent = `No tracked skill reaches ${TYPICAL_SKILL_PERCENT}% of these ads.`;
        panel.appendChild(none);
    } else {
        const categoryOf = Object.fromEntries(Object.entries(networkLayout).map(([n, l]) => [n, l.category]));
        const list = document.createElement('ol');
        list.className = 'network-steps';
        skills.forEach(({ skill, percent }) => {
            const item = document.createElement('li');
            item.className = 'network-step-row';
            const label = document.createElement('button');
            label.type = 'button';
            label.className = 'network-step-label';
            label.title = `Show ${skill}'s connections`;
            const swatch = document.createElement('span');
            swatch.className = 'skill-swatch';
            swatch.style.backgroundColor = categoryColor(categoryOf[skill]);
            label.append(swatch, document.createTextNode(skill));
            label.addEventListener('click', () => selectNetworkSkill(skill));
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
    }

    const actions = document.createElement('div');
    actions.className = 'network-actions';
    const back = document.createElement('button');
    back.type = 'button';
    back.className = 'location-pill';
    back.textContent = '← Back to skill connections';
    back.addEventListener('click', () => selectNetworkSkill(networkSelected));
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'location-pill';
    open.textContent = 'Open in Job Titles ↓';
    open.addEventListener('click', () => selectTitle(networkTitle, { scroll: true, fromTree: true }));
    actions.append(back, open);
    panel.appendChild(actions);
}

// Light/dark switches redraw the tree through refreshTheme() in app.js.
