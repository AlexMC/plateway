-- Contribution review (U15, R18). Submission states follow the plan's diagram: an upload that passes the in-app check
-- waits for Alex's quick look (`awaiting_look`, formerly `pending_review`); `approved` waits for the GitHub bot to open
-- its pull request (U16), which moves it to `pr_open`. A failed check refuses the upload, so no row is ever
-- `checking` or `rejected_check`. The uploaded file moves out of `file_key` into `submission_files`, kept only until
-- the submission is rejected or withdrawn.
CREATE TABLE submissions_reviewed (
    id TEXT PRIMARY KEY,
    owner_id TEXT REFERENCES users (id) ON DELETE SET NULL,
    kind TEXT NOT NULL CHECK (kind IN ('piece', 'train', 'furniture')),
    state TEXT NOT NULL CHECK (state IN ('awaiting_look', 'rejected', 'approved', 'pr_open', 'merged', 'closed',
                                         'withdrawn')),
    author_name TEXT NOT NULL,
    licence TEXT NOT NULL,
    metadata TEXT NOT NULL CHECK (json_valid(metadata)),
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

INSERT INTO submissions_reviewed (id, owner_id, kind, state, author_name, licence, metadata, file_digest, attested_at,
                                  reason, pr_number, pr_etag, created_at, reviewed_at, updated_at)
SELECT id, owner_id, kind, CASE state WHEN 'pending_review' THEN 'awaiting_look' ELSE state END, author_name, licence,
       metadata, file_digest, attested_at, reason, pr_number, pr_etag, created_at, reviewed_at, updated_at
FROM submissions;

-- Dropping `submissions` clears `library_items.submission_id` (ON DELETE SET NULL); the links are put back below.
CREATE TEMP TABLE library_links AS
SELECT id, version, submission_id FROM library_items WHERE submission_id IS NOT NULL;

DROP TABLE submissions;
ALTER TABLE submissions_reviewed RENAME TO submissions;
CREATE INDEX submissions_owner ON submissions (owner_id, created_at);
CREATE INDEX submissions_state ON submissions (state);

UPDATE library_items SET submission_id = (
    SELECT l.submission_id FROM library_links l WHERE l.id = library_items.id AND l.version = library_items.version)
WHERE EXISTS (SELECT 1 FROM library_links l WHERE l.id = library_items.id AND l.version = library_items.version);
DROP TABLE library_links;

-- The uploaded file, byte for byte, as the bot commits it: `name` is its file name in the library (`piece.stl`,
-- `car.glb`, `furniture.json`).
CREATE TABLE submission_files (
    submission_id TEXT PRIMARY KEY REFERENCES submissions (id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    data BLOB NOT NULL
);
