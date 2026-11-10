// Job alerts sign-up, shown under the CV results. The CV check itself needs no
// account; this card invites people to get new matching ads by email each Monday.
// Only the email, the ticked tracked skills, the years and the chosen area are sent
// (worker/index.js); the CV text never leaves the browser.

const ALERTS_API = '/api/alerts/subscribe';
let alertsState = { status: 'idle', message: '' };   // idle | sending | sent | error

function renderCvAlerts() {
    const card = document.getElementById('cvAlerts');
    if (!card) return;
    const skills = [...cvChosenSkills];
    card.hidden = !cvHasCv || !skills.length;
    if (card.hidden) return;
    card.innerHTML = '';

    const text = el('div', 'cv-alerts-text');
    const area = selectedLocation === 'Sweden' ? 'anywhere in Sweden' : `in ${selectedLocation}`;
    text.append(
        el('h3', '', 'Get new matching jobs by email'),
        el('p', 'card-sub', `Every Monday we email you the new tech ads ${area} that match your ${skills.length} skill${skills.length === 1 ? '' : 's'}, best match first. Free, and one click to stop.`)
    );

    if (alertsState.status === 'sent') {
        text.appendChild(el('p', 'cv-alerts-done', alertsState.message));
        card.appendChild(text);
        return;
    }

    const form = el('form', 'cv-alerts-form');
    form.noValidate = true;
    const row = el('div', 'cv-alerts-row');
    const input = el('input', 'cv-alerts-email');
    Object.assign(input, { type: 'email', name: 'email', placeholder: 'you@example.com', autocomplete: 'email', required: true });
    input.setAttribute('aria-label', 'Email address');
    const button = el('button', 'button-primary', alertsState.status === 'sending' ? 'Sending…' : 'Email me new matches');
    button.type = 'submit';
    button.disabled = alertsState.status === 'sending';
    row.append(input, button);

    const consent = el('label', 'cv-alerts-consent');
    const box = el('input');
    box.type = 'checkbox';
    box.name = 'consent';
    const privacy = el('a', '', 'privacy notice');
    privacy.href = 'privacy.html';
    privacy.target = '_blank';
    const words = el('span');
    words.append(document.createTextNode('Save my email, ticked skills, years of experience and area to send these alerts. Never my CV. I\'ve read the '), privacy, document.createTextNode('.'));
    consent.append(box, words);

    const status = el('p', 'cv-alerts-status' + (alertsState.status === 'error' ? ' is-error' : ''), alertsState.status === 'error' ? alertsState.message : '');
    status.setAttribute('role', 'status');

    form.append(row, consent, status);
    form.addEventListener('submit', event => {
        event.preventDefault();
        submitCvAlerts(input.value.trim(), box.checked);
    });
    card.append(text, form);
}

async function submitCvAlerts(email, consent) {
    if (!/^\S+@\S+\.\S+$/.test(email)) return showAlertsError('Please enter a valid email address.');
    if (!consent) return showAlertsError('Please tick the box to agree first.');
    alertsState = { status: 'sending', message: '' };
    renderCvAlerts();
    try {
        const response = await fetch(ALERTS_API, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                email,
                consent: true,
                skills: [...cvChosenSkills],
                years: cvYears(),
                location: selectedLocation
            })
        });
        const body = await response.json().catch(() => ({}));
        if (!response.ok || !body.ok) throw new Error(body.error || 'Something went wrong. Please try again later.');
        alertsState = { status: 'sent', message: `Almost done: we sent a link to ${email}. Open it to start your alerts.` };
    } catch (err) {
        alertsState = { status: 'error', message: err.message || 'Something went wrong. Please try again later.' };
    }
    renderCvAlerts();
}

function showAlertsError(message) {
    alertsState = { status: 'error', message };
    renderCvAlerts();
    document.querySelector('.cv-alerts-email')?.focus();
}

// After the confirm or unsubscribe link: a short note at the top of the page.
function showAlertsNotice() {
    const params = new URLSearchParams(location.search);
    const result = params.get('alerts');
    const messages = {
        confirmed: 'Your job alerts are on. The first email comes next Monday.',
        unsubscribed: 'You are unsubscribed, and we deleted what we had saved for you.'
    };
    if (!messages[result]) return;
    const note = el('div', 'alerts-notice', messages[result]);
    note.setAttribute('role', 'status');
    const close = el('button', 'alerts-notice-close', '×');
    close.type = 'button';
    close.setAttribute('aria-label', 'Close');
    close.addEventListener('click', () => note.remove());
    note.appendChild(close);
    document.body.prepend(note);
    params.delete('alerts');
    const query = params.toString();
    history.replaceState(null, '', location.pathname + (query ? `?${query}` : '') + location.hash);
}

document.addEventListener('DOMContentLoaded', showAlertsNotice);
