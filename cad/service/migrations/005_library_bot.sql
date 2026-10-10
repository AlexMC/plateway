-- The GitHub library bot (U16, KTD9, KTD10). `pr_closed_at`: when the bot closed the pull request of a submission
-- withdrawn by an account deletion (the poll ignores withdrawn submissions, so this is the only record). A `pr_open`
-- submission with a `reason` is one Alex rejected in Plateway after approving it: the bot posts the reason on the pull
-- request, closes it and moves the submission to `closed`.
ALTER TABLE submissions ADD COLUMN pr_closed_at INTEGER;

-- `repo_removed_at`: when the bot deleted a removed item's files from the library repository's current tree; NULL on a
-- removed item means the deletion is still owed.
ALTER TABLE library_items ADD COLUMN repo_removed_at INTEGER;
