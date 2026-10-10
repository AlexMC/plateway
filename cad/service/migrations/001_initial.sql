-- Multi-user state (KTD1). Ids are server-minted text; times are Unix seconds; JSON columns hold documents.
-- Owner-scoped tables reference users(id): personal data cascades on account deletion, while records that
-- outlive the account (public contributions, queue history, audit trail) keep their row with the owner cleared.

CREATE TABLE users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL COLLATE NOCASE UNIQUE,
    password_hash TEXT NOT NULL,
    display_name TEXT NOT NULL COLLATE NOCASE UNIQUE
        CHECK (length(display_name) BETWEEN 3 AND 30),
    email_verified_at INTEGER,
    -- Granted only by `python -m cad.service.set_admin`; no account can be created as an admin.
    is_admin INTEGER NOT NULL DEFAULT 0 CHECK (is_admin IN (0, 1)),
    created_at INTEGER NOT NULL
);

CREATE TRIGGER users_insert_not_admin BEFORE INSERT ON users WHEN NEW.is_admin <> 0
BEGIN
    SELECT RAISE(ABORT, 'is_admin is set only by the set_admin script');
END;

-- Only sha256 hashes of tokens are stored (KTD3).
CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
);
CREATE INDEX sessions_user ON sessions (user_id);

CREATE TABLE email_tokens (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    purpose TEXT NOT NULL CHECK (purpose IN ('verify', 'reset', 'change_email')),
    -- The address an email change moves to; it takes effect only when the token is used.
    new_email TEXT CHECK ((purpose = 'change_email') = (new_email IS NOT NULL)),
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    used_at INTEGER
);
CREATE INDEX email_tokens_user ON email_tokens (user_id, purpose, created_at);

CREATE TABLE projects (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    -- The id a project had before it was imported from local `.projects`, so re-importing is a no-op.
    legacy_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (id, owner_id)
);
CREATE INDEX projects_owner ON projects (owner_id, updated_at);
CREATE UNIQUE INDEX projects_legacy ON projects (owner_id, legacy_id) WHERE legacy_id IS NOT NULL;

-- A save names the revision it was based on (KTD2); `number` orders a project's revisions, and its uniqueness
-- makes two saves from the same parent conflict instead of both landing.
CREATE TABLE revisions (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    number INTEGER NOT NULL,
    parent_revision TEXT REFERENCES revisions (id) ON DELETE SET NULL,
    body TEXT NOT NULL CHECK (json_valid(body)),
    created_at INTEGER NOT NULL,
    UNIQUE (project_id, number),
    FOREIGN KEY (project_id, owner_id) REFERENCES projects (id, owner_id) ON DELETE CASCADE
);
CREATE INDEX revisions_owner ON revisions (owner_id);
CREATE INDEX revisions_parent ON revisions (parent_revision);

-- Prepare jobs (KTD5). A layout prepared in parts is a parent job with one child per part (KTD6).
CREATE TABLE jobs (
    id TEXT PRIMARY KEY,
    -- Cleared on account deletion so queue-wait history (R24) survives.
    owner_id TEXT REFERENCES users (id) ON DELETE SET NULL,
    kind TEXT NOT NULL CHECK (kind IN ('layout', 'coupon', 'grade')),
    state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'interrupted', 'succeeded', 'failed',
                                         'failed_too_large', 'failed_system', 'cancelled')),
    parent_id TEXT REFERENCES jobs (id) ON DELETE CASCADE,
    part_index INTEGER,
    project_id TEXT REFERENCES projects (id) ON DELETE SET NULL,
    revision_id TEXT REFERENCES revisions (id) ON DELETE SET NULL,
    manifest TEXT NOT NULL CHECK (json_valid(manifest)),
    estimate TEXT CHECK (estimate IS NULL OR json_valid(estimate)),
    stage TEXT,
    progress REAL CHECK (progress IS NULL OR progress BETWEEN 0 AND 1),
    error TEXT,
    package_id TEXT,
    interruptions INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    started_at INTEGER,
    heartbeat_at INTEGER,
    cancel_requested_at INTEGER,
    finished_at INTEGER,
    CHECK ((parent_id IS NULL) = (part_index IS NULL)),
    UNIQUE (parent_id, part_index)
);
CREATE INDEX jobs_queue ON jobs (state, created_at);
CREATE INDEX jobs_owner ON jobs (owner_id, created_at);
CREATE INDEX jobs_parent ON jobs (parent_id, part_index);
CREATE INDEX jobs_revision ON jobs (revision_id);
-- One active job per member; a parent and its children count as one.
CREATE UNIQUE INDEX jobs_one_active_per_owner ON jobs (owner_id)
    WHERE parent_id IS NULL AND state IN ('queued', 'running', 'interrupted');

-- Receipts outlive their package files (KTD7); calibration binds to the digest.
CREATE TABLE receipts (
    package_id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    job_id TEXT REFERENCES jobs (id) ON DELETE SET NULL,
    kind TEXT NOT NULL CHECK (kind IN ('layout', 'coupon', 'grade')),
    digest TEXT NOT NULL UNIQUE,
    body TEXT NOT NULL CHECK (json_valid(body)),
    storage_prefix TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
);
CREATE INDEX receipts_owner ON receipts (owner_id, created_at);

-- Owner-scoped coupon results. `receipt_digest` is null only for results imported from local `.projects`.
CREATE TABLE calibrations (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    settings_key TEXT NOT NULL,
    track_system TEXT NOT NULL,
    result TEXT NOT NULL CHECK (result IN ('fits', 'too-tight', 'too-loose')),
    receipt_id TEXT NOT NULL,
    receipt_digest TEXT,
    record TEXT NOT NULL CHECK (json_valid(record)),
    recorded_at INTEGER NOT NULL
);
CREATE INDEX calibrations_owner_setup ON calibrations (owner_id, settings_key, recorded_at);

-- A published layout is a stripped copy with a credit snapshot (KTD11).
CREATE TABLE gallery_layouts (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    body TEXT NOT NULL CHECK (json_valid(body)),
    thumbnail BLOB,
    -- Display name at publish time (R25).
    author_name TEXT NOT NULL,
    licence TEXT NOT NULL DEFAULT 'CC-BY-4.0',
    -- Remix ancestry as snapshots: title, display name, link, licence (R15).
    ancestors TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(ancestors)),
    published_at INTEGER NOT NULL,
    hidden_at INTEGER,
    hidden_reason TEXT
);
CREATE INDEX gallery_layouts_listing ON gallery_layouts (hidden_at, published_at);
CREATE INDEX gallery_layouts_owner ON gallery_layouts (owner_id);

CREATE TABLE reports (
    id INTEGER PRIMARY KEY,
    layout_id TEXT NOT NULL REFERENCES gallery_layouts (id) ON DELETE CASCADE,
    reporter_id TEXT REFERENCES users (id) ON DELETE SET NULL,
    client_ip TEXT NOT NULL,
    reason TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    resolved_at INTEGER
);
CREATE INDEX reports_layout ON reports (layout_id);
CREATE INDEX reports_ip ON reports (client_ip, created_at);
CREATE INDEX reports_reporter ON reports (reporter_id);

-- Piece, train and furniture uploads (R17, R18). Approved uploads are public on GitHub permanently, so the row
-- keeps the author's display-name snapshot when the account is deleted.
CREATE TABLE submissions (
    id TEXT PRIMARY KEY,
    owner_id TEXT REFERENCES users (id) ON DELETE SET NULL,
    kind TEXT NOT NULL CHECK (kind IN ('piece', 'train', 'furniture')),
    state TEXT NOT NULL CHECK (state IN ('pending_review', 'rejected', 'approved', 'pr_open', 'merged',
                                         'closed', 'withdrawn')),
    author_name TEXT NOT NULL,
    licence TEXT NOT NULL,
    metadata TEXT NOT NULL CHECK (json_valid(metadata)),
    file_key TEXT,
    file_digest TEXT,
    attested_at INTEGER NOT NULL,
    -- Alex's rejection reason or the pull request's closing comment.
    reason TEXT,
    pr_number INTEGER,
    pr_etag TEXT,
    created_at INTEGER NOT NULL,
    reviewed_at INTEGER,
    updated_at INTEGER NOT NULL
);
CREATE INDEX submissions_owner ON submissions (owner_id, created_at);
CREATE INDEX submissions_state ON submissions (state);

-- The versioned runtime library index (KTD9). Items are retired, not deleted; a removed item is a tombstone.
CREATE TABLE library_items (
    id TEXT NOT NULL,
    version INTEGER NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('piece', 'train', 'furniture')),
    state TEXT NOT NULL CHECK (state IN ('live', 'retired', 'removed')),
    digest TEXT NOT NULL,
    licence TEXT NOT NULL,
    credit TEXT NOT NULL CHECK (json_valid(credit)),
    metadata TEXT NOT NULL CHECK (json_valid(metadata)),
    submission_id TEXT REFERENCES submissions (id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (id, version)
);
CREATE INDEX library_items_submission ON library_items (submission_id);

-- Security and rate-limit evidence: sign-ins, sign-ups, resets, admin actions.
CREATE TABLE audit_events (
    id INTEGER PRIMARY KEY,
    at INTEGER NOT NULL,
    kind TEXT NOT NULL,
    user_id TEXT REFERENCES users (id) ON DELETE SET NULL,
    client_ip TEXT,
    detail TEXT CHECK (detail IS NULL OR json_valid(detail))
);
CREATE INDEX audit_events_ip ON audit_events (kind, client_ip, at);
CREATE INDEX audit_events_user ON audit_events (kind, user_id, at);
