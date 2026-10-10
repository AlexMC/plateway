from pathlib import Path
import sqlite3
import threading
import time

import pytest

from cad.service import db, set_admin

MIGRATIONS = db.MIGRATIONS_DIR
TABLES = {'schema_version', 'users', 'sessions', 'email_tokens', 'projects', 'revisions', 'jobs', 'receipts',
          'calibrations', 'gallery_layouts', 'reports', 'submissions', 'library_items', 'audit_events'}


def latest_version():
    return max(int(path.name.split('_', 1)[0]) for path in MIGRATIONS.glob('*.sql'))


def schema(conn):
    return conn.execute('SELECT type, name, sql FROM sqlite_master ORDER BY type, name').fetchall()


def open_db(tmp_path):
    path = tmp_path / 'plateway.db'
    db.migrate(path)
    return db.connect(path)


def add_user(conn, user_id, email=None, name=None):
    conn.execute('INSERT INTO users (id, email, password_hash, display_name, created_at) VALUES (?, ?, ?, ?, ?)',
                 (user_id, email or f'{user_id}@example.com', 'argon2id$x', name or f'name-{user_id}', 0))


def add_project(conn, project_id, owner):
    conn.execute('INSERT INTO projects (id, owner_id, name, created_at, updated_at) VALUES (?, ?, ?, 0, 0)',
                 (project_id, owner, 'Layout'))


def add_revision(conn, revision_id, project_id, owner, number=1):
    conn.execute('INSERT INTO revisions (id, project_id, owner_id, number, body, created_at) VALUES (?, ?, ?, ?, ?, 0)',
                 (revision_id, project_id, owner, number, '{"version": 5}'))


def test_fresh_database_migrates_to_latest_and_migrating_again_changes_nothing(tmp_path):
    path = tmp_path / 'plateway.db'
    assert db.migrate(path) == latest_version()
    conn = db.connect(path)
    tables = {row['name'] for row in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
    assert TABLES <= tables
    before = schema(conn), conn.execute('SELECT * FROM schema_version').fetchall()
    assert db.migrate(path) == latest_version()
    assert (schema(conn), conn.execute('SELECT * FROM schema_version').fetchall()) == before
    assert conn.execute('PRAGMA journal_mode').fetchone()[0] == 'wal'
    assert conn.execute('PRAGMA foreign_keys').fetchone()[0] == 1


def test_failed_migration_leaves_the_previous_schema_version_intact(tmp_path):
    migrations = tmp_path / 'migrations'
    migrations.mkdir()
    (migrations / '001_first.sql').write_text('CREATE TABLE first (id INTEGER PRIMARY KEY);\n')
    (migrations / '002_second.sql').write_text(
        "CREATE TABLE second (id INTEGER PRIMARY KEY);\n"
        "-- a comment; with a semicolon\n"
        "INSERT INTO first (id) VALUES (1);\n"
        "INSERT INTO missing_table VALUES (1);\n")
    path = tmp_path / 'plateway.db'
    with pytest.raises(sqlite3.OperationalError, match='missing_table'):
        db.migrate(path, migrations)
    conn = db.connect(path)
    assert db.schema_version(conn) == 1
    assert conn.execute("SELECT name FROM sqlite_master WHERE name = 'second'").fetchone() is None
    assert conn.execute('SELECT count(*) FROM first').fetchone()[0] == 0

    (migrations / '002_second.sql').write_text(
        "CREATE TABLE second (id INTEGER PRIMARY KEY, note TEXT DEFAULT 'a;b');\n"
        "CREATE TRIGGER second_note AFTER INSERT ON second BEGIN UPDATE second SET note = 'x;y' WHERE id = NEW.id; END;\n")
    assert db.migrate(path, migrations) == 2
    conn.execute('INSERT INTO second (id) VALUES (1)')
    assert conn.execute('SELECT note FROM second').fetchone()[0] == 'x;y'


def test_review_migration_renames_pending_uploads_and_keeps_library_links(tmp_path):
    """004 rebuilds `submissions`: a `pending_review` upload awaits the quick look, and merged items keep their link."""
    before = tmp_path / 'before'
    before.mkdir()
    for path in MIGRATIONS.glob('00[1-3]_*.sql'):
        (before / path.name).write_text(path.read_text())
    path = tmp_path / 'plateway.db'
    assert db.migrate(path, before) == 3
    conn = db.connect(path)
    add_user(conn, 'alice')
    for submission, state in (('s1', 'pending_review'), ('s2', 'merged')):
        conn.execute('INSERT INTO submissions (id, owner_id, kind, state, author_name, licence, metadata, attested_at, '
                     "created_at, updated_at) VALUES (?, 'alice', 'piece', ?, 'name-alice', 'CC-BY-4.0', '{}', 0, 0, 0)",
                     (submission, state))
    conn.execute("INSERT INTO library_items (id, version, kind, state, digest, licence, credit, metadata, submission_id, "
                 "created_at, updated_at) VALUES ('community_a', 1, 'piece', 'live', 'd', 'CC-BY-4.0', '{}', '{}', 's2', 0, 0)")
    assert db.migrate(path) == latest_version()
    assert dict(conn.execute('SELECT id, state FROM submissions').fetchall()) == {'s1': 'awaiting_look', 's2': 'merged'}
    assert conn.execute('SELECT submission_id FROM library_items').fetchone()[0] == 's2'
    with pytest.raises(sqlite3.IntegrityError):
        conn.execute("UPDATE submissions SET state = 'pending_review' WHERE id = 's1'")
    assert not conn.execute('PRAGMA foreign_key_check').fetchall()


def test_health_probe_tables_are_dropped_from_a_version_6_database(tmp_path):
    """007 drops the shared-server health trigger's probes and stored-once baseline, with their index and triggers."""
    before = tmp_path / 'before'
    before.mkdir()
    for path in MIGRATIONS.glob('00[1-6]_*.sql'):
        (before / path.name).write_text(path.read_text())
    path = tmp_path / 'plateway.db'
    assert db.migrate(path, before) == 6
    conn = db.connect(path)
    conn.execute('INSERT INTO health_probes (at, seconds, ok) VALUES (0, 0.2, 1)')
    conn.execute('INSERT INTO health_baseline (id, seconds, samples, measured_from, measured_to, stored_at) '
                 'VALUES (1, 0.2, 1, 0, 0, 0)')
    assert db.migrate(path) == latest_version()
    assert not conn.execute("SELECT name FROM sqlite_master WHERE name LIKE 'health%'").fetchall()


def test_two_connections_writing_concurrently_both_commit(tmp_path):
    path = tmp_path / 'plateway.db'
    db.migrate(path)
    with db.connect(path) as setup:
        add_user(setup, 'u1')
    errors = []

    def writer(prefix):
        conn = db.connect(path)
        try:
            for index in range(20):
                with db.transaction(conn):
                    conn.execute('INSERT INTO audit_events (at, kind, user_id) VALUES (?, ?, ?)',
                                 (index, prefix, 'u1'))
                    time.sleep(0.005)
        except sqlite3.Error as error:
            errors.append(error)
        finally:
            conn.close()

    threads = [threading.Thread(target=writer, args=(name,)) for name in ('a', 'b')]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert errors == []
    conn = db.connect(path)
    assert dict(conn.execute('SELECT kind, count(*) FROM audit_events GROUP BY kind').fetchall()) == {'a': 20, 'b': 20}


def test_transaction_rolls_back_on_error(tmp_path):
    conn = open_db(tmp_path)
    with pytest.raises(RuntimeError):
        with db.transaction(conn):
            add_user(conn, 'u1')
            raise RuntimeError('boom')
    assert conn.execute('SELECT count(*) FROM users').fetchone()[0] == 0
    assert not conn.in_transaction


def test_revisions_need_an_existing_project_of_the_same_owner(tmp_path):
    conn = open_db(tmp_path)
    add_user(conn, 'alice')
    add_user(conn, 'bob')
    add_project(conn, 'p1', 'alice')
    with pytest.raises(sqlite3.IntegrityError, match='FOREIGN KEY'):
        add_revision(conn, 'r0', 'missing', 'alice')
    with pytest.raises(sqlite3.IntegrityError, match='FOREIGN KEY'):
        add_revision(conn, 'r0', 'p1', 'bob')
    add_revision(conn, 'r1', 'p1', 'alice')
    with pytest.raises(sqlite3.IntegrityError, match='UNIQUE'):
        add_revision(conn, 'r2', 'p1', 'alice', number=1)


def test_display_names_and_emails_are_unique_regardless_of_case(tmp_path):
    conn = open_db(tmp_path)
    add_user(conn, 'u1', email='Ann@Example.com', name='TrackFan')
    with pytest.raises(sqlite3.IntegrityError, match='display_name'):
        add_user(conn, 'u2', name='trackfan')
    with pytest.raises(sqlite3.IntegrityError, match='email'):
        add_user(conn, 'u3', email='ann@example.com')


def test_member_has_at_most_one_active_top_level_job(tmp_path):
    conn = open_db(tmp_path)
    add_user(conn, 'u1')

    def job(job_id, state='queued', parent=None, part=None):
        conn.execute('INSERT INTO jobs (id, owner_id, kind, state, parent_id, part_index, manifest, created_at) '
                     "VALUES (?, 'u1', 'layout', ?, ?, ?, '{}', 0)", (job_id, state, parent, part))

    job('j1')
    job('j1-part1', parent='j1', part=1)
    job('j1-part2', parent='j1', part=2)
    with pytest.raises(sqlite3.IntegrityError, match='UNIQUE'):
        job('j2')
    conn.execute("UPDATE jobs SET state = 'succeeded' WHERE id = 'j1'")
    job('j2')


def test_deleting_a_member_removes_personal_data_but_keeps_public_contributions(tmp_path):
    conn = open_db(tmp_path)
    add_user(conn, 'alice')
    add_project(conn, 'p1', 'alice')
    add_revision(conn, 'r1', 'p1', 'alice')
    conn.execute("INSERT INTO sessions (token_hash, user_id, created_at, last_seen_at, expires_at) VALUES ('h', 'alice', 0, 0, 1)")
    conn.execute("INSERT INTO email_tokens (token_hash, user_id, purpose, created_at, expires_at) VALUES ('e', 'alice', 'verify', 0, 1)")
    conn.execute("INSERT INTO receipts (package_id, owner_id, kind, digest, body, storage_prefix, created_at, expires_at) "
                 "VALUES ('pkg', 'alice', 'coupon', 'd1', '{}', 'packages/alice/pkg/', 0, 1)")
    conn.execute("INSERT INTO calibrations (id, owner_id, settings_key, track_system, result, receipt_id, receipt_digest, record, recorded_at) "
                 "VALUES ('c1', 'alice', 'k', 'brick-v1', 'fits', 'pkg', 'd1', '{}', 0)")
    conn.execute("INSERT INTO gallery_layouts (id, owner_id, title, body, author_name, published_at) "
                 "VALUES ('g1', 'alice', 'Loop', '{}', 'name-alice', 0)")
    conn.execute("INSERT INTO reports (layout_id, client_ip, reason, created_at) VALUES ('g1', '203.0.113.1', 'spam', 0)")
    conn.execute("INSERT INTO submissions (id, owner_id, kind, state, author_name, licence, metadata, attested_at, created_at, updated_at) "
                 "VALUES ('s1', 'alice', 'piece', 'merged', 'name-alice', 'CC-BY-4.0', '{}', 0, 0, 0)")
    conn.execute("INSERT INTO library_items (id, version, kind, state, digest, licence, credit, metadata, submission_id, created_at, updated_at) "
                 "VALUES ('piece-1', 1, 'piece', 'live', 'd2', 'CC-BY-4.0', '{}', '{}', 's1', 0, 0)")
    conn.execute("INSERT INTO jobs (id, owner_id, kind, state, project_id, revision_id, manifest, created_at) "
                 "VALUES ('j1', 'alice', 'layout', 'succeeded', 'p1', 'r1', '{}', 0)")
    conn.execute("INSERT INTO audit_events (at, kind, user_id, client_ip) VALUES (0, 'signin_failed', 'alice', '203.0.113.1')")

    conn.execute("DELETE FROM users WHERE id = 'alice'")

    for table in ('projects', 'revisions', 'sessions', 'email_tokens', 'receipts', 'calibrations',
                  'gallery_layouts', 'reports'):
        assert conn.execute(f'SELECT count(*) FROM {table}').fetchone()[0] == 0, table
    assert tuple(conn.execute("SELECT owner_id, author_name FROM submissions").fetchone()) == (None, 'name-alice')
    assert tuple(conn.execute("SELECT submission_id FROM library_items").fetchone()) == ('s1',)
    assert tuple(conn.execute("SELECT owner_id, project_id, revision_id, state FROM jobs").fetchone()) == (None, None, None, 'succeeded')
    assert tuple(conn.execute("SELECT user_id FROM audit_events").fetchone()) == (None,)


def test_sign_up_cannot_create_an_admin(tmp_path):
    conn = open_db(tmp_path)
    with pytest.raises(sqlite3.IntegrityError, match='is_admin'):
        conn.execute("INSERT INTO users (id, email, password_hash, display_name, is_admin, created_at) "
                     "VALUES ('u1', 'a@example.com', 'x', 'Admin', 1, 0)")


def test_set_admin_script_grants_and_revokes_by_email(tmp_path, monkeypatch, capsys):
    path = tmp_path / 'plateway.db'
    db.migrate(path)
    with db.connect(path) as conn:
        add_user(conn, 'alex', email='alex@example.com')
    monkeypatch.setenv('PLATEWAY_DB', str(path))

    assert set_admin.main(['ALEX@example.com']) == 0
    assert db.connect(path).execute("SELECT is_admin FROM users WHERE id = 'alex'").fetchone()[0] == 1
    assert set_admin.main(['alex@example.com', '--revoke']) == 0
    assert db.connect(path).execute("SELECT is_admin FROM users WHERE id = 'alex'").fetchone()[0] == 0
    assert set_admin.main(['nobody@example.com']) == 1
    assert 'nobody@example.com' in capsys.readouterr().err


def test_database_path_comes_from_plateway_db_or_the_project_root(tmp_path):
    assert db.database_path(tmp_path, {}) == tmp_path / 'plateway.db'
    assert db.database_path(tmp_path, {'PLATEWAY_DB': '/srv/data/p.db'}) == Path('/srv/data/p.db')
