-- A layout's piece count, stored at publish so a gallery page never parses the bodies it lists.
ALTER TABLE gallery_layouts ADD COLUMN pieces INTEGER NOT NULL DEFAULT 0;
UPDATE gallery_layouts SET pieces = coalesce(
    (SELECT sum(json_array_length(r.value, '$.pieces')) FROM json_each(gallery_layouts.body, '$.routes') r), 0);

-- The gallery's page order. The visibility filter (visible, the viewer's own, or an admin) is checked as the newest rows
-- are walked, so a page stops after its cards instead of sorting the whole gallery.
DROP INDEX gallery_layouts_listing;
CREATE INDEX gallery_layouts_published ON gallery_layouts (published_at DESC, id DESC);

-- The credit snapshot of a layout that left the gallery, by unpublishing or by its author's account deletion, so a
-- remix published later can still credit it; a claimed ancestor in neither table is dropped as made up (R15, R25).
CREATE TABLE gallery_tombstones (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    author_name TEXT NOT NULL,
    licence TEXT NOT NULL,
    ancestors TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(ancestors))
);

-- Unpublishing deletes the row; an account deletion deletes it by cascade, which fires this trigger too.
CREATE TRIGGER gallery_layouts_tombstone AFTER DELETE ON gallery_layouts
BEGIN
    INSERT OR REPLACE INTO gallery_tombstones (id, title, author_name, licence, ancestors)
    VALUES (old.id, old.title, old.author_name, old.licence, old.ancestors);
END;
