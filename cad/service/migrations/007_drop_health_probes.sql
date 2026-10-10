-- Plateway has its own server, so the shared-server health trigger (003) is gone with its probes and baseline.
-- Dropping a table drops its index and triggers.
DROP TABLE health_probes;
DROP TABLE health_baseline;
