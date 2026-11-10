-- Job alerts (worker/index.js creates these on first use; kept here for reference
-- and for `wrangler d1 execute skillmatris --file worker/schema.sql`).
-- Only what an alert needs is stored: no CV, no name, no free text.
CREATE TABLE IF NOT EXISTS subscribers (
    email            TEXT PRIMARY KEY,
    skills           TEXT,              -- JSON array of tracked skill names (confirmed profile)
    years            REAL,              -- years of experience, or NULL
    location         TEXT,              -- 'Sweden' or a city from ad_skills.json
    confirmed        INTEGER NOT NULL DEFAULT 0,
    pending_skills   TEXT,              -- a new profile waits here until its email link is used
    pending_years    REAL,
    pending_location TEXT,
    confirm_token    TEXT,
    confirm_sent_at  INTEGER,           -- ms since epoch
    manage_token     TEXT NOT NULL,     -- in every email's unsubscribe link
    created_at       INTEGER NOT NULL,
    confirmed_at     INTEGER,
    last_sent_at     INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS subscribers_confirm ON subscribers (confirm_token);
CREATE UNIQUE INDEX IF NOT EXISTS subscribers_manage ON subscribers (manage_token);

-- Small key/value store: the ad ids of last week's snapshot, so each alert holds
-- only ads that are new since the previous one.
CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
