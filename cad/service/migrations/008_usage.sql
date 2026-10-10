-- Usage analytics (`usage.py`, `ops.py`). Anonymous use is kept only as per-UTC-day totals: no cookie, identifier,
-- client IP or per-person row. Both totals tables are kept for 400 days; older days are deleted as new ones are written.

-- How many page loads used each in-app feature (`usage.EVENTS`), per UTC day.
CREATE TABLE event_counts (
    day TEXT NOT NULL,
    name TEXT NOT NULL,
    count INTEGER NOT NULL CHECK (count > 0),
    PRIMARY KEY (day, name)
) WITHOUT ROWID;

-- Browser errors, one row per UTC day and fingerprint (sha256 of message, where and version, first 16 hex digits).
CREATE TABLE client_errors (
    day TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    message TEXT NOT NULL,
    where_ TEXT NOT NULL,
    version TEXT NOT NULL,
    count INTEGER NOT NULL CHECK (count > 0),
    last_at INTEGER NOT NULL,
    PRIMARY KEY (day, fingerprint)
) WITHOUT ROWID;

-- Members' package downloads: `zip` (a whole archive) or `file` (one artefact). Personal data, so it goes with the
-- account like the receipts it belongs to.
CREATE TABLE package_downloads (
    id INTEGER PRIMARY KEY,
    package_id TEXT NOT NULL,
    owner_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('zip', 'file')),
    at INTEGER NOT NULL
);
CREATE INDEX package_downloads_package ON package_downloads (package_id, at);
CREATE INDEX package_downloads_owner ON package_downloads (owner_id, at);
