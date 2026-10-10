-- Stored ids move to the neutral brick names: piece families, the track system (and the calibration settings key that
-- embeds it), the owned-piece source, the port profile, the hardware category, the coupon's instance id, and the train
-- power codes of uploads. This is the one server-side place that names the old values; the service accepts only the
-- new ones. Each replacement is an exact quoted JSON token, so names, notes and other free text keep their words.
-- The backslash-quoted track system is the settings key inside a JSON string (a project's `connectorFit.settingsKey`,
-- a calibration record's `settingsKey`); SQL keeps the backslashes literally.
CREATE TEMP TABLE brick_ids (step INTEGER PRIMARY KEY, old TEXT NOT NULL, new TEXT NOT NULL);
INSERT INTO brick_ids (old, new) VALUES
    ('"lego_straight_nominal"', '"brick_straight_nominal"'),
    ('"lego_curve_r40"', '"brick_curve_r40"'),
    ('"lego_flex"', '"brick_flex"'),
    ('"lego_switch_left"', '"brick_switch_left"'),
    ('"lego_switch_right"', '"brick_switch_right"'),
    ('"lego_crossing90"', '"brick_crossing90"'),
    ('"lego_double_crossover"', '"brick_double_crossover"'),
    ('"printed_lego_straight"', '"printed_brick_straight"'),
    ('"lego_end_coupon"', '"brick_end_coupon"'),
    ('"lego-end-coupon"', '"brick-end-coupon"'),
    ('"lego-compatible-v1"', '"brick-v1"'),
    ('\"lego-compatible-v1\"', '\"brick-v1\"'),
    ('"owned-lego"', '"owned"'),
    ('"lego-compatible"', '"brick"'),
    ('"lego-coupling-unfitted"', '"brick-coupling-unfitted"'),
    ('"category": "lego"', '"category": "brick"'),
    ('"category":"lego"', '"category":"brick"');

-- Upload metadata names a train's power system.
CREATE TEMP TABLE power_codes (step INTEGER PRIMARY KEY, old TEXT NOT NULL, new TEXT NOT NULL);
INSERT INTO power_codes (old, new) VALUES
    ('"power": "PF"', '"power": "IR"'), ('"power":"PF"', '"power":"IR"'),
    ('"power": "PU"', '"power": "BT"'), ('"power":"PU"', '"power":"BT"');

-- Each column's text with every pair applied in step order.
UPDATE revisions SET body = (
    WITH RECURSIVE applied (step, text) AS (
        SELECT 0, revisions.body
        UNION ALL
        SELECT applied.step + 1, replace(applied.text, pair.old, pair.new)
        FROM applied JOIN brick_ids pair ON pair.step = applied.step + 1)
    SELECT text FROM applied ORDER BY step DESC LIMIT 1)
WHERE body LIKE '%lego%';

UPDATE gallery_layouts SET body = (
    WITH RECURSIVE applied (step, text) AS (
        SELECT 0, gallery_layouts.body
        UNION ALL
        SELECT applied.step + 1, replace(applied.text, pair.old, pair.new)
        FROM applied JOIN brick_ids pair ON pair.step = applied.step + 1)
    SELECT text FROM applied ORDER BY step DESC LIMIT 1)
WHERE body LIKE '%lego%';

UPDATE jobs SET manifest = (
    WITH RECURSIVE applied (step, text) AS (
        SELECT 0, jobs.manifest
        UNION ALL
        SELECT applied.step + 1, replace(applied.text, pair.old, pair.new)
        FROM applied JOIN brick_ids pair ON pair.step = applied.step + 1)
    SELECT text FROM applied ORDER BY step DESC LIMIT 1)
WHERE manifest LIKE '%lego%';

-- A receipt keeps its digest: calibration results bind to it, and its files in the bucket are unchanged.
UPDATE receipts SET body = (
    WITH RECURSIVE applied (step, text) AS (
        SELECT 0, receipts.body
        UNION ALL
        SELECT applied.step + 1, replace(applied.text, pair.old, pair.new)
        FROM applied JOIN brick_ids pair ON pair.step = applied.step + 1)
    SELECT text FROM applied ORDER BY step DESC LIMIT 1)
WHERE body LIKE '%lego%';

UPDATE calibrations SET settings_key = (
    WITH RECURSIVE applied (step, text) AS (
        SELECT 0, calibrations.settings_key
        UNION ALL
        SELECT applied.step + 1, replace(applied.text, pair.old, pair.new)
        FROM applied JOIN brick_ids pair ON pair.step = applied.step + 1)
    SELECT text FROM applied ORDER BY step DESC LIMIT 1)
WHERE settings_key LIKE '%lego%';

UPDATE calibrations SET record = (
    WITH RECURSIVE applied (step, text) AS (
        SELECT 0, calibrations.record
        UNION ALL
        SELECT applied.step + 1, replace(applied.text, pair.old, pair.new)
        FROM applied JOIN brick_ids pair ON pair.step = applied.step + 1)
    SELECT text FROM applied ORDER BY step DESC LIMIT 1)
WHERE record LIKE '%lego%';

UPDATE calibrations SET track_system = 'brick-v1' WHERE track_system = 'lego-compatible-v1';

UPDATE submissions SET metadata = (
    WITH RECURSIVE applied (step, text) AS (
        SELECT 0, submissions.metadata
        UNION ALL
        SELECT applied.step + 1, replace(applied.text, pair.old, pair.new)
        FROM applied JOIN power_codes pair ON pair.step = applied.step + 1)
    SELECT text FROM applied ORDER BY step DESC LIMIT 1)
WHERE kind = 'train';

UPDATE library_items SET metadata = (
    WITH RECURSIVE applied (step, text) AS (
        SELECT 0, library_items.metadata
        UNION ALL
        SELECT applied.step + 1, replace(applied.text, pair.old, pair.new)
        FROM applied JOIN power_codes pair ON pair.step = applied.step + 1)
    SELECT text FROM applied ORDER BY step DESC LIMIT 1)
WHERE kind = 'train';

DROP TABLE brick_ids;
DROP TABLE power_codes;
