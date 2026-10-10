-- The R24 SetScout trigger (KTD12, `ops.py`): one probe of SetScout's health endpoint a minute. `seconds` is the
-- response time; a probe that times out or fails is recorded at the probe timeout, so an outage raises the p95.
-- `load1` and `steal` are the host's 1-minute load and CPU steal share since the previous probe: context only.
CREATE TABLE health_probes (
    at INTEGER NOT NULL,
    seconds REAL NOT NULL CHECK (seconds >= 0),
    ok INTEGER NOT NULL CHECK (ok IN (0, 1)),
    load1 REAL,
    steal REAL CHECK (steal IS NULL OR steal BETWEEN 0 AND 1)
);
CREATE INDEX health_probes_at ON health_probes (at);

-- The p95 response time over the 7 days before launch, stored once (`python -m cad.service.ops baseline`).
CREATE TABLE health_baseline (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    seconds REAL NOT NULL CHECK (seconds > 0),
    samples INTEGER NOT NULL,
    measured_from INTEGER NOT NULL,
    measured_to INTEGER NOT NULL,
    stored_at INTEGER NOT NULL
);

CREATE TRIGGER health_baseline_kept BEFORE UPDATE ON health_baseline
BEGIN
    SELECT RAISE(ABORT, 'The SetScout baseline is stored once');
END;

CREATE TRIGGER health_baseline_not_deleted BEFORE DELETE ON health_baseline
BEGIN
    SELECT RAISE(ABORT, 'The SetScout baseline is stored once');
END;
