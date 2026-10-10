-- Feedback sent from the app's and the site's feedback form (`feedback.py`). Never the sender's IP address: that is
-- used only by the in-memory rate limit. `member_id` is set when the sender was signed in; deleting the account keeps
-- the feedback, unlinked. `email` is the address the sender gave for a reply, if any. Rows are deleted 365 days after
-- they were sent. `handled_at` is when an admin dealt with it.
CREATE TABLE feedback (
    id INTEGER PRIMARY KEY,
    created_at INTEGER NOT NULL,
    member_id TEXT REFERENCES users (id) ON DELETE SET NULL,
    email TEXT,
    message TEXT NOT NULL,
    page TEXT NOT NULL,
    version TEXT NOT NULL,
    handled_at INTEGER
);
CREATE INDEX feedback_created ON feedback (created_at);
CREATE INDEX feedback_member ON feedback (member_id);
