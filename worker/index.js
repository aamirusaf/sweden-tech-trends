// Skill Matrix Worker: serves the static site (assets) and runs the job alerts.
//
// Alerts, in short:
//   POST /api/alerts/subscribe    {email, skills[], years, location, consent}
//        -> stores the profile as pending and emails a confirmation link.
//   GET  /api/alerts/confirm?t=   -> a page with a button; POST confirms the profile.
//   GET  /api/alerts/unsubscribe?t= -> a page with a button; POST deletes the row.
//        (Buttons, not plain links, so mail scanners that open links change nothing.
//         One-click List-Unsubscribe POSTs straight to the same URL.)
//   Cron (Mondays, after the weekly data refresh): each confirmed subscriber gets the
//   ads that are new since last week's snapshot and match their skills.
//
// Privacy: only email, the ticked tracked skills, years of experience and a city are
// stored. Never the CV. Deleting is one click from every email.
//
// Needs (see README "Job alerts"): a D1 binding DB, the secret RESEND_API_KEY, and
// the vars SITE_URL and MAIL_FROM. Without DB or the key the API answers 503.

const AD_DATA_PATH = '/backend/data/ad_skills.json';
const MISSING_ALLOWED = 1;          // same rule as the CV check and the skill tree
const SKILL_WEIGHT = 0.75;          // match % = 75% skills + 25% experience fit
const SENIOR_YEARS = 5;
const EXPERIENCED_YEARS = 2;
const MAX_JOBS_PER_EMAIL = 15;
const RESEND_WAIT_MS = 2 * 60 * 1000;           // don't resend a confirmation within 2 min
const CONFIRM_TTL_MS = 48 * 60 * 60 * 1000;
const MAX_DATA_AGE_MS = 3 * 24 * 60 * 60 * 1000; // skip a send on stale data
const RESEND_BATCH = 100;                       // Resend's batch limit
const EMAIL_RE = /^[^\s@<>()",;:]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,}$/;

export default {
    async fetch(request, env) {
        const url = new URL(request.url);
        if (url.pathname.startsWith('/api/alerts/')) {
            try {
                return await handleAlerts(request, env, url);
            } catch (err) {
                console.error('alerts error', err && err.stack || err);
                return json({ error: 'Something went wrong. Please try again later.' }, 500);
            }
        }
        return env.ASSETS.fetch(request);
    },

    async scheduled(event, env, ctx) {
        ctx.waitUntil(sendWeeklyAlerts(env).catch(err => console.error('weekly alerts failed', err && err.stack || err)));
    }
};

// ---------- HTTP ----------

async function handleAlerts(request, env, url) {
    if (!env.DB || !env.RESEND_API_KEY) {
        return json({ error: 'Job alerts are not switched on yet. Please check back soon.' }, 503);
    }
    await ensureSchema(env.DB);
    const route = url.pathname.replace(/\/+$/, '');
    const site = siteUrl(env, url);

    if (route === '/api/alerts/subscribe' && request.method === 'POST') return subscribe(request, env, site);
    if (route === '/api/alerts/confirm') return confirm(request, env, url, site);
    if (route === '/api/alerts/unsubscribe') return unsubscribe(request, env, url, site);
    return json({ error: 'Not found' }, 404);
}

async function subscribe(request, env, site) {
    let body;
    try {
        body = await request.json();
    } catch {
        return json({ error: 'Send JSON.' }, 400);
    }
    const email = String(body.email || '').trim().toLowerCase();
    if (!EMAIL_RE.test(email) || email.length > 254) return json({ error: 'Please enter a valid email address.' }, 400);
    if (body.consent !== true) return json({ error: 'Please agree to the privacy notice first.' }, 400);

    const data = await loadAdData(env, site);
    const known = new Set(data.skills);
    const skills = [...new Set(Array.isArray(body.skills) ? body.skills : [])].filter(s => known.has(s));
    if (!skills.length) return json({ error: 'Tick at least one skill first.' }, 400);
    const locations = new Set(['Sweden', ...data.locations]);
    const location = locations.has(body.location) ? body.location : 'Sweden';
    let years = body.years === null || body.years === undefined || body.years === '' ? null : Number(body.years);
    if (years !== null && !(years >= 0 && years <= 60)) years = null;

    const now = Date.now();
    await env.DB.prepare('DELETE FROM subscribers WHERE confirmed = 0 AND confirm_sent_at < ?').bind(now - CONFIRM_TTL_MS).run();
    const row = await env.DB.prepare('SELECT confirm_sent_at FROM subscribers WHERE email = ?').bind(email).first();
    if (row && row.confirm_sent_at && now - row.confirm_sent_at < RESEND_WAIT_MS) {
        // Same answer as a fresh send, so the form can't be used to probe addresses.
        return json({ ok: true });
    }
    const confirmToken = randomToken();
    if (row) {
        await env.DB.prepare(`UPDATE subscribers SET pending_skills = ?, pending_years = ?, pending_location = ?,
            confirm_token = ?, confirm_sent_at = ? WHERE email = ?`)
            .bind(JSON.stringify(skills), years, location, confirmToken, now, email).run();
    } else {
        await env.DB.prepare(`INSERT INTO subscribers (email, pending_skills, pending_years, pending_location,
            confirm_token, confirm_sent_at, manage_token, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
            .bind(email, JSON.stringify(skills), years, location, confirmToken, now, randomToken(), now).run();
    }

    const link = `${site}/api/alerts/confirm?t=${confirmToken}`;
    await sendEmails(env, [{
        to: email,
        subject: 'Confirm your Skill Matrix job alerts',
        html: confirmEmailHtml(link, skills, years, location),
        text: `Confirm your weekly job alerts from Skill Matrix:\n${link}\n\nSkills: ${skills.join(', ')}\nArea: ${location}\n\nIf you didn't ask for this, ignore this email. Unconfirmed requests are deleted after 48 hours.`
    }]);
    return json({ ok: true });
}

async function confirm(request, env, url, site) {
    const token = url.searchParams.get('t') || '';
    if (request.method !== 'POST') {
        return page('Confirm job alerts', `<p>Press the button to start your weekly job alerts.</p>
            <form method="post"><button type="submit">Confirm my job alerts</button></form>`);
    }
    const row = token && await env.DB.prepare('SELECT * FROM subscribers WHERE confirm_token = ?').bind(token).first();
    if (!row || !row.confirm_sent_at || Date.now() - row.confirm_sent_at > CONFIRM_TTL_MS) {
        return page('Link expired', `<p>This link has expired or was already used. Check your CV again on <a href="${site}/">Skill Matrix</a> to get a new one.</p>`, 400);
    }
    await env.DB.prepare(`UPDATE subscribers SET skills = pending_skills, years = pending_years, location = pending_location,
        confirmed = 1, confirmed_at = ?, pending_skills = NULL, pending_years = NULL, pending_location = NULL,
        confirm_token = NULL WHERE email = ?`).bind(Date.now(), row.email).run();
    return Response.redirect(`${site}/frontend/?alerts=confirmed`, 303);
}

async function unsubscribe(request, env, url, site) {
    const token = url.searchParams.get('t') || '';
    if (request.method !== 'POST') {
        return page('Stop job alerts', `<p>Press the button to stop the alerts and delete everything we saved for you.</p>
            <form method="post"><button type="submit">Unsubscribe and delete</button></form>`);
    }
    if (token) await env.DB.prepare('DELETE FROM subscribers WHERE manage_token = ?').bind(token).run();
    // One-click unsubscribe from a mail app expects a plain 200.
    if ((request.headers.get('content-type') || '').includes('application/x-www-form-urlencoded')
        && (await request.clone().text()).includes('List-Unsubscribe=One-Click')) {
        return new Response('Unsubscribed', { status: 200 });
    }
    return Response.redirect(`${site}/frontend/?alerts=unsubscribed`, 303);
}

// ---------- Weekly send ----------

export async function sendWeeklyAlerts(env) {
    if (!env.DB || !env.RESEND_API_KEY) {
        console.log('alerts: not configured, skipping');
        return { sent: 0, reason: 'not configured' };
    }
    await ensureSchema(env.DB);
    const site = siteUrl(env);
    const data = await loadAdData(env, site);
    const updated = Date.parse(String(data.last_updated || '').replace(' UTC', 'Z').replace(' ', 'T'));
    if (!updated || Date.now() - updated > MAX_DATA_AGE_MS) {
        console.log('alerts: ad data is stale, skipping', data.last_updated);
        return { sent: 0, reason: 'stale data' };
    }

    const ids = data.listings.map(listing => listing && listing[0]).filter(Boolean);
    const previous = await env.DB.prepare("SELECT value FROM meta WHERE key = 'last_ad_ids'").first();
    let isNew;
    if (previous) {
        const seen = new Set(JSON.parse(previous.value));
        isNew = listing => !seen.has(listing[0]);
    } else {
        // First run: ads published in the last 7 days.
        const since = new Date(updated - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
        isNew = listing => (listing[4] || '') >= since;
    }
    const fresh = [];
    data.ads.forEach((ad, i) => {
        const listing = data.listings[i];
        if (listing && ad[0] && isNew(listing)) fresh.push({ ad, listing });
    });

    const { results: subscribers = [] } = await env.DB
        .prepare('SELECT email, skills, years, location, manage_token FROM subscribers WHERE confirmed = 1').all();
    const emails = [];
    for (const sub of subscribers) {
        const jobs = matchJobs(data, fresh, sub);
        if (!jobs.length) continue;
        const unsubscribeUrl = `${site}/api/alerts/unsubscribe?t=${sub.manage_token}`;
        emails.push({
            to: sub.email,
            subject: `${jobs.length >= MAX_JOBS_PER_EMAIL ? `${MAX_JOBS_PER_EMAIL}+` : jobs.length} new job${jobs.length === 1 ? '' : 's'} match your skills · Skill Matrix`,
            html: alertEmailHtml(jobs.slice(0, MAX_JOBS_PER_EMAIL), jobs.length, sub, site, unsubscribeUrl, data.url_base),
            text: alertEmailText(jobs.slice(0, MAX_JOBS_PER_EMAIL), jobs.length, site, unsubscribeUrl, data.url_base),
            headers: {
                'List-Unsubscribe': `<${unsubscribeUrl}>`,
                'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click'
            }
        });
    }
    await sendEmails(env, emails);

    const now = Date.now();
    await env.DB.batch([
        env.DB.prepare("INSERT INTO meta (key, value) VALUES ('last_ad_ids', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
            .bind(JSON.stringify(ids)),
        env.DB.prepare('UPDATE subscribers SET last_sent_at = ? WHERE confirmed = 1').bind(now)
    ]);
    // Drop confirmation requests nobody used.
    await env.DB.prepare('DELETE FROM subscribers WHERE confirmed = 0 AND confirm_sent_at < ?').bind(now - CONFIRM_TTL_MS).run();
    console.log(`alerts: ${fresh.length} new ads, ${subscribers.length} subscribers, ${emails.length} emails`);
    return { sent: emails.length, fresh: fresh.length, subscribers: subscribers.length };
}

export function matchJobs(data, fresh, sub) {
    let skills;
    try { skills = JSON.parse(sub.skills || '[]'); } catch { skills = []; }
    let mask = 0;
    data.skills.forEach((name, i) => { if (skills.includes(name)) mask |= (1 << i); });
    if (!mask) return [];
    const cityIndex = sub.location && sub.location !== 'Sweden' ? data.locations.indexOf(sub.location) : null;
    const years = sub.years === null || sub.years === undefined ? null : Number(sub.years);
    const jobs = [];
    for (const { ad, listing } of fresh) {
        if (cityIndex !== null && ad[2] !== cityIndex) continue;
        if (!(ad[0] & mask) || popcount(ad[0] & ~mask) > MISSING_ALLOWED) continue;
        const have = [], missing = [];
        data.skills.forEach((name, bit) => {
            if (ad[0] & (1 << bit)) (mask & (1 << bit) ? have : missing).push(name);
        });
        const skillFit = have.length / (have.length + missing.length);
        const exp = experienceFit(ad, years);
        const match = exp === null ? skillFit : SKILL_WEIGHT * skillFit + (1 - SKILL_WEIGHT) * exp;
        jobs.push({ id: listing[0], headline: listing[1], employer: listing[2], place: listing[3], published: listing[4],
            have, missing, percent: Math.round(100 * match) });
    }
    return jobs.sort((a, b) => b.percent - a.percent || b.have.length - a.have.length || String(b.published).localeCompare(String(a.published)));
}

// Mirrors cvExperienceFit in frontend/cv-check.js.
function experienceFit(ad, years) {
    if (years === null || Number.isNaN(years)) return null;
    if (ad[3] === 2) return Math.min(1, years / SENIOR_YEARS);
    if (ad[3] === 1) return 1;
    if (ad[4]) return Math.min(1, 0.5 + years / (2 * EXPERIENCED_YEARS));
    return 1;
}

function popcount(n) {
    let count = 0;
    while (n) { n &= n - 1; count++; }
    return count;
}

// ---------- Email ----------

async function sendEmails(env, messages) {
    const from = env.MAIL_FROM || 'Skill Matrix <alerts@skillmatris.com>';
    for (let i = 0; i < messages.length; i += RESEND_BATCH) {
        const batch = messages.slice(i, i + RESEND_BATCH).map(m => ({ from, ...m, to: [m.to] }));
        const single = batch.length === 1;
        const api = (env.RESEND_API_URL || 'https://api.resend.com').replace(/\/+$/, '');   // override only for local tests
        const response = await fetch(single ? `${api}/emails` : `${api}/emails/batch`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(single ? batch[0] : batch)
        });
        if (!response.ok) throw new Error(`Resend ${response.status}: ${(await response.text()).slice(0, 300)}`);
    }
}

function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

const MAIL_STYLE = 'font-family:Inter,Segoe UI,Helvetica,Arial,sans-serif;color:#0f172a;line-height:1.5;max-width:560px;margin:0 auto;padding:24px';

function confirmEmailHtml(link, skills, years, location) {
    return `<div style="${MAIL_STYLE}">
<h1 style="font-size:20px;margin:0 0 12px">Confirm your job alerts</h1>
<p>Every Monday, Skill Matrix will email you the new tech job ads in Sweden that match your skills.</p>
<p style="margin:20px 0"><a href="${esc(link)}" style="background:#0f172a;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:600">Confirm my alerts</a></p>
<p style="color:#475569;font-size:14px">What we'll save: this email, your skills (${esc(skills.join(', '))}), ${years === null ? 'no years of experience' : `${esc(years)} years of experience`} and your area (${esc(location)}). Never your CV.</p>
<p style="color:#64748b;font-size:13px">If you didn't ask for this, ignore this email. Unconfirmed requests are deleted after 48 hours.</p>
</div>`;
}

function alertEmailHtml(jobs, total, sub, site, unsubscribeUrl, urlBase) {
    const rows = jobs.map(job => {
        const href = urlBase && job.id ? urlBase + encodeURIComponent(job.id) : site;
        const chips = [...job.have.map(s => `✓ ${esc(s)}`), ...job.missing.map(s => `<span style="color:#c2410c">✗ ${esc(s)}</span>`)].join(' &nbsp; ');
        return `<tr><td style="padding:12px 0;border-top:1px solid #e8ecf1">
<a href="${esc(href)}" style="color:#0f172a;font-weight:600;font-size:16px">${esc(job.headline || 'Untitled ad')}</a>
<div style="color:#64748b;font-size:13px">${esc([job.employer, job.place].filter(Boolean).join(' · '))}</div>
<div style="font-size:13px;margin-top:4px"><strong>Match ${job.percent}%</strong> &nbsp; ${chips}</div>
</td></tr>`;
    }).join('');
    const more = total > jobs.length ? `<p style="font-size:14px">${total - jobs.length} more match you. <a href="${esc(site)}/frontend/#cv">See them all on Skill Matrix</a>.</p>` : '';
    return `<div style="${MAIL_STYLE}">
<h1 style="font-size:20px;margin:0 0 4px">New jobs that match your skills</h1>
<p style="color:#475569;margin:0 0 12px">New this week on Arbetsförmedlingen's Platsbanken${sub.location && sub.location !== 'Sweden' ? ` in ${esc(sub.location)}` : ''}, best match first.</p>
<table style="width:100%;border-collapse:collapse">${rows}</table>
${more}
<p style="color:#64748b;font-size:12px;margin-top:24px">You get this because you asked for weekly job alerts on <a href="${esc(site)}/">Skill Matrix</a>. To change your skills, check your CV again and sign up with the same email. <a href="${esc(unsubscribeUrl)}">Unsubscribe and delete my data</a>.</p>
</div>`;
}

function alertEmailText(jobs, total, site, unsubscribeUrl, urlBase) {
    const lines = jobs.map(job => `- ${job.headline} (${[job.employer, job.place].filter(Boolean).join(', ')}) · Match ${job.percent}%\n  ${urlBase && job.id ? urlBase + encodeURIComponent(job.id) : site}`);
    if (total > jobs.length) lines.push(`\n${total - jobs.length} more on ${site}/`);
    return `New jobs that match your skills\n\n${lines.join('\n')}\n\nUnsubscribe and delete your data: ${unsubscribeUrl}`;
}

// ---------- Helpers ----------

let schemaReady = false;
async function ensureSchema(db) {
    if (schemaReady) return;
    await db.batch([
        db.prepare(`CREATE TABLE IF NOT EXISTS subscribers (email TEXT PRIMARY KEY, skills TEXT, years REAL, location TEXT,
            confirmed INTEGER NOT NULL DEFAULT 0, pending_skills TEXT, pending_years REAL, pending_location TEXT,
            confirm_token TEXT, confirm_sent_at INTEGER, manage_token TEXT NOT NULL, created_at INTEGER NOT NULL,
            confirmed_at INTEGER, last_sent_at INTEGER)`),
        db.prepare('CREATE UNIQUE INDEX IF NOT EXISTS subscribers_confirm ON subscribers (confirm_token)'),
        db.prepare('CREATE UNIQUE INDEX IF NOT EXISTS subscribers_manage ON subscribers (manage_token)'),
        db.prepare('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
    ]);
    schemaReady = true;
}

async function loadAdData(env, site) {
    const response = await env.ASSETS.fetch(new Request(new URL(AD_DATA_PATH, site)));
    if (!response.ok) throw new Error(`ad data ${response.status}`);
    return response.json();
}

function siteUrl(env, url) {
    if (url) return url.origin;   // previews link back to themselves
    return (env.SITE_URL || 'https://skillmatris.com').replace(/\/+$/, '');
}

function randomToken() {
    const bytes = new Uint8Array(24);
    crypto.getRandomValues(bytes);
    return [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
}

function json(body, status = 200) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
    });
}

function page(title, body, status = 200) {
    return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · Skill Matrix</title>
<style>body{font-family:Inter,system-ui,sans-serif;background:#f4f6f9;color:#0f172a;margin:0;padding:48px 16px}
main{max-width:480px;margin:0 auto;background:#fff;border-radius:14px;padding:28px;box-shadow:0 1px 3px rgba(15,23,42,.08)}
button{font:inherit;font-weight:600;background:#0f172a;color:#fff;border:0;border-radius:8px;padding:10px 18px;cursor:pointer}
@media (prefers-color-scheme: dark){body{background:#0b0f15;color:#e8edf4}main{background:#121821}button{background:#e8edf4;color:#0b0f15}a{color:#e8edf4}}</style>
</head><body><main><h1 style="font-size:20px;margin-top:0">${esc(title)}</h1>${body}</main></body></html>`,
        { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
}
