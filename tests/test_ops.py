"""The admin ops page (U10, `ops.py`): the R24 queue trigger, aggregate usage and the admin-only view."""
from contextlib import closing, contextmanager
import time
import uuid

import pytest

from cad.service import db, ops, set_admin, usage

from signed_in import signed_in_client

ORIGIN = 'http://127.0.0.1:8765'
NOW = 1_800_000_000  # 2027-01-15 08:00 UTC
DAY = 24 * 3600
# One event per age: inside the last day, on the 24-hour boundary, on the 7-day boundary, on the 30-day boundary, and
# long ago. A window starts just after its boundary, so this counts 1, 2, 3 and 5.
AGES = (DAY - 1, DAY, 7 * DAY, 30 * DAY, 400 * DAY)
EVERY_AGE = {'24h': 1, '7d': 2, '30d': 3, 'all': 5}


def windows(day: int, week: int, month: int, total: int) -> dict:
    return {'24h': day, '7d': week, '30d': month, 'all': total}


def database(tmp_path):
    path = db.database_path(tmp_path)
    db.migrate(path)
    return path


def add_waits(path, minutes: list[float]):
    """Prepares started in the last 7 days after waiting `minutes` in the queue."""
    with closing(db.connect(path)) as conn, db.transaction(conn):
        for index, wait in enumerate(minutes):
            started = NOW - 3600 - index
            conn.execute("INSERT INTO jobs (id, owner_id, kind, state, manifest, created_at, started_at, finished_at) "
                         "VALUES (?, NULL, 'coupon', 'succeeded', '{}', ?, ?, ?)",
                         (str(uuid.uuid4()), started - int(wait * 60), started, started + 600))


def seed_usage(path):
    """Members, sessions, sign-ins, saves, prepares, gallery layouts, reports, uploads and library items at known ages."""
    def at(age):
        return NOW - age

    with closing(db.connect(path)) as conn, db.transaction(conn):
        for index, age in enumerate(AGES):
            # Verified 1, 2, 3 and 4 of them at the later ages, so verification counts by its own time.
            conn.execute('INSERT INTO users (id, email, password_hash, display_name, email_verified_at, created_at) '
                         'VALUES (?, ?, ?, ?, ?, ?)', (f'u{index}', f'u{index}@example.com', 'x', f'user{index}',
                                                       at(AGES[index]) if index else None, at(age)))
        # Active: u4 saved inside the day, u0's session was last used on the day boundary, u1 signed in on the week
        # boundary (twice), u2's session was last used on the month boundary; u3 only failed to sign in, and a sign-in of
        # a deleted account has no member.
        for token, user, age in (('s0', 'u0', DAY), ('s2', 'u2', 30 * DAY), ('s4', 'u4', 400 * DAY)):
            conn.execute('INSERT INTO sessions (token_hash, user_id, created_at, last_seen_at, expires_at) '
                         'VALUES (?, ?, ?, ?, ?)', (token, user, at(age), at(age), NOW + DAY))
        for kind, user, age in (('login', 'u1', 7 * DAY), ('login', 'u1', 30 * DAY), ('login', None, 60),
                                ('login_failed', 'u3', 60)):
            conn.execute('INSERT INTO audit_events (at, kind, user_id) VALUES (?, ?, ?)', (at(age), kind, user))
        for project, ages in (('pA', (DAY - 1, DAY, 400 * DAY)), ('pB', (7 * DAY, 30 * DAY))):
            conn.execute("INSERT INTO projects (id, owner_id, name, created_at, updated_at) VALUES (?, 'u4', ?, ?, ?)",
                         (project, project, at(max(ages)), at(min(ages))))
            for number, age in enumerate(sorted(ages, reverse=True), 1):
                conn.execute("INSERT INTO revisions (id, project_id, owner_id, number, body, created_at) "
                             "VALUES (?, ?, 'u4', ?, '{}', ?)", (f'{project}-{number}', project, number, at(age)))
        # Prepares: (id, kind, state, created, started, finished) as ages; L2's part is not a prepare of its own.
        jobs = [('L1', 'layout', 'succeeded', 3600, 3000, 2900), ('L2', 'layout', 'succeeded', DAY + 100, DAY + 50, DAY),
                ('L3', 'layout', 'failed', 7 * DAY + 10, 7 * DAY + 5, 7 * DAY),
                ('L4', 'layout', 'failed_system', 7 * DAY, 7 * DAY - 5, 7 * DAY - 10),
                ('L5', 'layout', 'failed_too_large', 40 * DAY, 40 * DAY - 1, 40 * DAY - 2),
                ('L6', 'layout', 'succeeded', 31 * DAY + 400, 31 * DAY + 300, 31 * DAY),
                ('L7', 'layout', 'queued', 600, None, None), ('L8', 'layout', 'cancelled', 100, None, 90),
                ('C1', 'coupon', 'succeeded', 10, 8, 5)]
        for job_id, kind, state, created, started, finished in jobs:
            conn.execute("INSERT INTO jobs (id, owner_id, kind, state, manifest, created_at, started_at, finished_at) "
                         "VALUES (?, NULL, ?, ?, '{}', ?, ?, ?)", (job_id, kind, state, at(created),
                                                                  started and at(started), finished and at(finished)))
        conn.execute("INSERT INTO jobs (id, owner_id, kind, state, parent_id, part_index, manifest, created_at, "
                     "started_at, finished_at) VALUES ('L2-0', NULL, 'layout', 'succeeded', 'L2', 0, '{}', ?, ?, ?)",
                     (at(DAY + 100), at(DAY + 60), at(DAY + 55)))
        for index, age in enumerate(AGES):
            remix = '[{"title": "Original"}]' if age in (DAY, 30 * DAY) else '[]'
            conn.execute("INSERT INTO gallery_layouts (id, owner_id, title, body, author_name, ancestors, published_at) "
                         "VALUES (?, 'u0', 'Layout', '{}', 'user0', ?, ?)", (f'g{index}', remix, at(age)))
        for age in (DAY - 1, 7 * DAY):
            conn.execute("INSERT INTO reports (layout_id, client_ip, reason, created_at) VALUES ('g0', '203.0.113.1', "
                         "'spam', ?)", (at(age),))
        # Uploads: (id, state, created, reviewed, updated) as ages. S1 was rejected; S5 was approved, then withdrawn.
        uploads = [('S0', 'awaiting_look', DAY - 1, None, DAY - 1), ('S1', 'rejected', DAY, DAY - 10, DAY - 10),
                   ('S2', 'pr_open', 7 * DAY, 7 * DAY - 1, 7 * DAY - 1),
                   ('S3', 'merged', 30 * DAY, 30 * DAY - 1, DAY - 1),
                   ('S4', 'merged', 400 * DAY, 399 * DAY, 398 * DAY), ('S5', 'withdrawn', 50 * DAY, 3600, 3600)]
        for upload, state, created, reviewed, updated in uploads:
            conn.execute("INSERT INTO submissions (id, owner_id, kind, state, author_name, licence, metadata, attested_at, "
                         "created_at, reviewed_at, updated_at) VALUES (?, NULL, 'piece', ?, 'user0', 'CC-BY-4.0', '{}', "
                         "?, ?, ?, ?)", (upload, state, at(created), at(created),
                                         reviewed and at(reviewed), at(updated)))
        for item, state, upload, age in (('a', 'live', 'S3', DAY - 1), ('b', 'retired', 'S4', 398 * DAY),
                                         ('c', 'live', None, 30 * DAY), ('d', 'removed', None, 7 * DAY - 1)):
            conn.execute("INSERT INTO library_items (id, version, kind, state, digest, licence, credit, metadata, "
                         "submission_id, created_at, updated_at) VALUES (?, 1, 'piece', ?, 'sha', 'CC-BY-4.0', '{}', '{}', "
                         "?, ?, ?)", (item, state, upload, at(age), at(age)))


def test_usage_counts_each_window_up_to_its_boundary(tmp_path):
    path = database(tmp_path)
    seed_usage(path)
    usage = ops.report(path, NOW)['usage']
    assert usage['accounts'] == {'signups': EVERY_AGE, 'verified': windows(0, 1, 2, 4)}
    assert usage['members'] == {'active': windows(1, 2, 3, 4)}
    assert usage['projects'] == {'saved': windows(1, 1, 2, 2), 'revisions': EVERY_AGE}
    zero, none = windows(0, 0, 0, 0), dict.fromkeys(EVERY_AGE)
    assert usage['prepares'] == {
        'layout': {'enqueued': windows(3, 4, 6, 8), 'succeeded': windows(1, 2, 2, 3), 'failedMember': windows(0, 0, 1, 1),
                   'failedSystem': windows(0, 1, 1, 1), 'failedTooLarge': windows(0, 0, 0, 1),
                   'p50Seconds': windows(100, 50, 50, 100), 'p95Seconds': windows(100, 100, 100, 300)},
        'coupon': {'enqueued': windows(1, 1, 1, 1), 'succeeded': windows(1, 1, 1, 1), 'failedMember': zero,
                   'failedSystem': zero, 'failedTooLarge': zero, 'p50Seconds': windows(3, 3, 3, 3),
                   'p95Seconds': windows(3, 3, 3, 3)},
        'grade': {'enqueued': zero, 'succeeded': zero, 'failedMember': zero, 'failedSystem': zero,
                  'failedTooLarge': zero, 'p50Seconds': none, 'p95Seconds': none}}
    assert usage['gallery'] == {'published': EVERY_AGE, 'remixes': windows(0, 1, 1, 2), 'reports': windows(1, 1, 2, 2)}
    assert usage['library'] == {'uploads': windows(1, 2, 3, 6), 'approved': windows(1, 2, 3, 4),
                                'merged': windows(1, 1, 1, 2), 'published': windows(1, 2, 2, 4), 'live': 2}


def test_the_daily_series_covers_the_last_30_utc_days(tmp_path):
    path = database(tmp_path)
    seed_usage(path)
    daily = ops.report(path, NOW)['usage']['daily']
    assert len(daily) == 30
    assert daily[0]['date'] == '2026-12-17' and daily[-1]['date'] == '2027-01-15'
    # Sign-ups on the 24-hour and 7-day boundaries land on their UTC days; the 30-day one is the day before the series.
    assert {day['date']: (day['signups'], day['prepares']) for day in daily if day['signups'] or day['prepares']} == {
        '2027-01-08': (1, 2), '2027-01-14': (2, 1), '2027-01-15': (0, 4)}


@pytest.mark.parametrize('minutes, fired', [(11, True), (9, False)])
def test_queue_trigger_fires_when_the_week_p95_wait_passes_ten_minutes(tmp_path, minutes, fired):
    path = database(tmp_path)
    add_waits(path, [1] * 18 + [minutes] * 2)  # the slowest 10%: the p95 is `minutes`
    queue = ops.report(path, NOW)['queue']
    assert queue['fired'] is fired
    assert queue['p95Seconds'] == minutes * 60


@contextmanager
def ops_client(tmp_path, monkeypatch, *, admin: bool):
    with signed_in_client(tmp_path, ORIGIN, clock=lambda: NOW) as client:
        if admin:
            monkeypatch.setenv('TRAIN_PROJECT_DIR', str(tmp_path))
            monkeypatch.delenv('PLATEWAY_DB', raising=False)
            assert set_admin.main(['member@example.com']) == 0
        yield client


def test_the_ops_view_is_hidden_from_members_and_visitors(tmp_path, monkeypatch):
    with ops_client(tmp_path, monkeypatch, admin=False) as client:
        assert client.get('/api/admin/ops').status_code == 404
        assert client.get('/admin/ops').status_code == 404
        client.cookies.clear()
        assert client.get('/api/admin/ops').status_code == 404
        assert client.get('/admin/ops').status_code == 404


def test_the_admin_page_shows_the_queue_trigger_and_usage(tmp_path, monkeypatch):
    path = database(tmp_path)
    add_waits(path, [11] * 3)
    with ops_client(tmp_path, monkeypatch, admin=True) as client:
        view = client.get('/api/admin/ops')
        page = client.get('/admin/ops')
        stylesheet = client.get('/admin/ops.css')
    assert view.status_code == 200 and page.status_code == 200
    report = view.json()
    assert report['queue'] == {'fired': True, 'p95Seconds': 660, 'jobs': 3, 'limitSeconds': 600}
    # The admin signed up, verified and signed in through the real flow just now.
    one = windows(1, 1, 1, 1)
    assert report['usage']['accounts'] == {'signups': one, 'verified': one}
    assert report['usage']['members'] == {'active': one}
    assert report['usage']['prepares']['coupon']['enqueued'] == windows(3, 3, 3, 3)
    assert {'downloads', 'funnel', 'retention', 'events', 'errors', 'kpis'} <= set(report)
    text = page.text
    assert 'Upsize the server' in text
    assert '<th scope="row">Sign-ups</th><td>1</td><td>1</td><td>1</td><td>1</td>' in text
    assert 'Sign-ups per day, last 30 days: 1 in all' in text
    assert 'Package downloads are recorded' in text and 'Anonymous use is measured as daily totals' in text
    # Styled by a same-origin stylesheet only: no inline style or script, so the CSP holds.
    assert '<link rel="stylesheet" href="/admin/ops.css">' in text
    assert '<script' not in text and 'style=' not in text and '<style' not in text
    assert "style-src 'self'" in page.headers['content-security-policy']
    assert stylesheet.status_code == 200 and stylesheet.headers['content-type'].startswith('text/css')
    assert '--lime' in stylesheet.text


def test_the_stylesheet_is_hidden_from_members_too(tmp_path, monkeypatch):
    with ops_client(tmp_path, monkeypatch, admin=False) as client:
        assert client.get('/admin/ops.css').status_code == 404


def add_users(conn, users: dict[str, tuple[int, int | None]]):
    """Members by id: (created, verified) as times."""
    for user, (created, verified) in users.items():
        conn.execute('INSERT INTO users (id, email, password_hash, display_name, email_verified_at, created_at) '
                     'VALUES (?, ?, ?, ?, ?, ?)', (user, f'{user}@example.com', 'x', f'name-{user}', verified, created))


def add_job(conn, job_id: str, owner, *, created: int, kind: str = 'layout', state: str = 'succeeded',
            finished: int | None = None, package: str | None = None):
    conn.execute('INSERT INTO jobs (id, owner_id, kind, state, manifest, created_at, finished_at, package_id) '
                 "VALUES (?, ?, ?, ?, '{}', ?, ?, ?)", (job_id, owner, kind, state, created, finished, package))


def add_download(conn, package: str, owner: str, kind: str, at: int):
    conn.execute('INSERT INTO package_downloads (package_id, owner_id, kind, at) VALUES (?, ?, ?, ?)',
                 (package, owner, kind, at))


def add_counts(conn, name: str, days: dict[int, int]):
    """Daily totals of `name` by days before NOW's UTC day."""
    for before, count in days.items():
        conn.execute('INSERT INTO event_counts (day, name, count) VALUES (?, ?, ?)', (day_of(NOW - before * DAY), name,
                                                                                         count))


def day_of(at: int) -> str:
    return time.strftime('%Y-%m-%d', time.gmtime(at))


def test_downloads_count_packages_and_kinds_per_window(tmp_path):
    path = database(tmp_path)
    with closing(db.connect(path)) as conn, db.transaction(conn):
        add_users(conn, {'a': (NOW - 100 * DAY, None), 'b': (NOW - 100 * DAY, None)})
        for package, owner, kind, age in (('P1', 'a', 'zip', 3600), ('P1', 'a', 'file', 3600),
                                          ('P2', 'b', 'file', 7 * DAY), ('P3', 'a', 'zip', 30 * DAY),
                                          ('P1', 'a', 'zip', 40 * DAY)):
            add_download(conn, package, owner, kind, NOW - age)
    downloads = ops.report(path, NOW)['downloads']
    assert downloads['packages'] == windows(1, 1, 2, 3)
    assert downloads['zip'] == windows(1, 1, 1, 3)
    assert downloads['file'] == windows(1, 1, 2, 2)
    assert downloads['members'] == windows(1, 1, 2, 2)


def test_the_share_of_layouts_downloaded_within_a_week_counts_prepares_that_have_had_their_week(tmp_path):
    path = database(tmp_path)
    with closing(db.connect(path)) as conn, db.transaction(conn):
        add_users(conn, {'a': (NOW - 100 * DAY, None)})
        # (job, finished age, downloaded after finishing): Q1 on the last second of its week, Q2 a second late, Q3 on
        # the 37-day boundary (all time only), Q4 still inside its week.
        for job, age, after in (('J1', 7 * DAY, 7 * DAY), ('J2', 8 * DAY, 7 * DAY + 1), ('J3', 37 * DAY, 3600),
                                ('J4', 6 * DAY, 60)):
            add_job(conn, job, 'a', created=NOW - age - 600, finished=NOW - age, package=f'Q{job[1]}')
            add_download(conn, f'Q{job[1]}', 'a', 'zip', NOW - age + after)
        # Not counted: a coupon, a failed layout, and a layout whose member deleted their account.
        add_job(conn, 'C1', 'a', kind='coupon', created=NOW - 10 * DAY, finished=NOW - 10 * DAY, package='QC')
        add_download(conn, 'QC', 'a', 'zip', NOW - 10 * DAY)
        add_job(conn, 'F1', 'a', state='failed', created=NOW - 10 * DAY, finished=NOW - 10 * DAY)
        add_job(conn, 'D1', None, created=NOW - 10 * DAY, finished=NOW - 10 * DAY, package='QD')
    share = ops.report(path, NOW)['downloads']['layoutsWithin7d']
    assert share == {'30d': {'prepared': 2, 'downloaded': 1, 'share': 0.5},
                     'all': {'prepared': 3, 'downloaded': 2, 'share': pytest.approx(2 / 3)}}


def test_the_funnel_follows_each_sign_up_cohort_from_the_days_app_opens(tmp_path):
    path = database(tmp_path)
    with closing(db.connect(path)) as conn, db.transaction(conn):
        # a: inside the week, did everything; b: on the 7-day boundary; c: just inside the week, unverified; d: on the
        # 30-day boundary; e: long ago, prepared and downloaded without saving.
        add_users(conn, {'a': (NOW - 3600, NOW - 3000), 'b': (NOW - 7 * DAY, NOW - 7 * DAY),
                         'c': (NOW - 7 * DAY + 1, None), 'd': (NOW - 30 * DAY, NOW - 29 * DAY),
                         'e': (NOW - 100 * DAY, NOW - 100 * DAY)})
        for owner in ('a', 'b', 'd'):
            conn.execute("INSERT INTO projects (id, owner_id, name, created_at, updated_at) VALUES (?, ?, 'p', ?, ?)",
                         (f'p{owner}', owner, NOW - 60, NOW - 60))
            conn.execute("INSERT INTO revisions (id, project_id, owner_id, number, body, created_at) "
                         "VALUES (?, ?, ?, 1, '{}', ?)", (f'r{owner}', f'p{owner}', owner, NOW - 60))
        for owner in ('a', 'd', 'e'):
            add_job(conn, f'j{owner}', owner, created=NOW - 60, state='cancelled', finished=NOW - 50)
        for owner in ('a', 'e'):
            add_download(conn, f'P{owner}', owner, 'file', NOW - 10)
        # App opens are daily totals: the 7 days are today and the 6 UTC days before it.
        add_counts(conn, 'app_open', {0: 5, 6: 3, 7: 4, 29: 2, 30: 10})
        add_counts(conn, 'remix', {0: 99})
    funnel = ops.report(path, NOW)['funnel']
    assert funnel == {
        '7d': {'appOpens': 8, 'signups': 2, 'verified': 1, 'saved': 1, 'prepared': 1, 'downloaded': 1},
        '30d': {'appOpens': 14, 'signups': 3, 'verified': 2, 'saved': 2, 'prepared': 1, 'downloaded': 1},
        'all': {'appOpens': 24, 'signups': 5, 'verified': 4, 'saved': 3, 'prepared': 3, 'downloaded': 2}}


def test_weekly_retention_counts_each_member_in_their_own_weeks_once_those_have_passed(tmp_path):
    path = database(tmp_path)
    monday = 1_799_625_600  # 2027-01-11 00:00 UTC, NOW's week
    m1, m2, m3 = monday - 5 * 7 * DAY, monday - 4 * 7 * DAY - 1, NOW - 21 * DAY
    with closing(db.connect(path)) as conn, db.transaction(conn):
        add_users(conn, {'m1': (m1, None), 'm2': (m2, None),  # first and last second of the week of 7 Dec
                         'm3': (m3, None),  # 25 Dec: its third week ends exactly now
                         'm4': (monday + DAY, None),  # this week: no week has passed
                         'm5': (monday - 7 * 7 * DAY - 1, None),  # the Sunday before the first cohort week
                         'm6': (monday - 7 * 7 * DAY, None)})  # the first second of the first cohort week, inactive
        conn.execute("INSERT INTO projects (id, owner_id, name, created_at, updated_at) VALUES ('p1', 'm1', 'p', ?, ?)",
                     (m1, m1))
        conn.execute("INSERT INTO projects (id, owner_id, name, created_at, updated_at) VALUES ('p3', 'm3', 'p', ?, ?)",
                     (m3, m3))
        # m1: signed in as week +1 starts, saved on its last second, used a session as week +3 starts. m2: signed in
        # as week +2 starts. m3: saved in week +2. m6: only failed to sign in.
        for kind, user, at in (('login', 'm1', m1 + 7 * DAY), ('login', 'm2', m2 + 14 * DAY),
                               ('login_failed', 'm6', monday - 6 * 7 * DAY)):
            conn.execute('INSERT INTO audit_events (at, kind, user_id) VALUES (?, ?, ?)', (at, kind, user))
        for revision, project, owner, at in (('r1', 'p1', 'm1', m1 + 14 * DAY - 1), ('r3', 'p3', 'm3', m3 + 20 * DAY)):
            conn.execute("INSERT INTO revisions (id, project_id, owner_id, number, body, created_at) "
                         "VALUES (?, ?, ?, 1, '{}', ?)", (revision, project, owner, at))
        conn.execute("INSERT INTO sessions (token_hash, user_id, created_at, last_seen_at, expires_at) "
                     "VALUES ('s1', 'm1', ?, ?, ?)", (m1, m1 + 21 * DAY, NOW + DAY))
    weeks = ops.report(path, NOW)['retention']['weeks']

    def cell(active, eligible):
        return {'active': active, 'eligible': eligible, 'share': active / eligible if eligible else None}

    none = cell(0, 0)
    assert weeks == [
        {'week': '2026-11-23', 'members': 1, 'weeks': [cell(0, 1), cell(0, 1), cell(0, 1)]},
        {'week': '2026-11-30', 'members': 0, 'weeks': [none, none, none]},
        {'week': '2026-12-07', 'members': 2, 'weeks': [cell(1, 2), cell(1, 2), cell(1, 2)]},
        {'week': '2026-12-14', 'members': 0, 'weeks': [none, none, none]},
        {'week': '2026-12-21', 'members': 1, 'weeks': [cell(0, 1), cell(1, 1), none]},
        {'week': '2026-12-28', 'members': 0, 'weeks': [none, none, none]},
        {'week': '2027-01-04', 'members': 0, 'weeks': [none, none, none]},
        {'week': '2027-01-11', 'members': 1, 'weeks': [none, none, none]}]


def test_the_headline_numbers_compare_the_last_7_days_with_the_7_before(tmp_path):
    path = database(tmp_path)
    seed_usage(path)
    with closing(db.connect(path)) as conn, db.transaction(conn):
        add_counts(conn, 'app_open', {0: 2, 6: 3, 7: 4, 13: 1, 14: 50})
    kpis = ops.report(path, NOW)['kpis']
    # Sign-ups at 1 day less a second and 1 day, then on the 7-day boundary; active: u0 and u4, then u1 and u4.
    assert {name: (kpi['value'], kpi['previous']) for name, kpi in kpis.items()} == {
        'signups': (2, 1), 'activeMembers': (2, 2), 'prepares': (5, 2), 'appOpens': (5, 5)}
    daily = {name: {day['date']: day['count'] for day in kpi['daily'] if day['count']} for name, kpi in kpis.items()}
    assert all(len(kpi['daily']) == 30 and kpi['daily'][-1]['date'] == '2027-01-15' for kpi in kpis.values())
    assert daily['signups'] == {'2027-01-08': 1, '2027-01-14': 2}
    assert daily['activeMembers'] == {'2027-01-08': 2, '2027-01-14': 2}
    assert daily['appOpens'] == {'2027-01-01': 50, '2027-01-02': 1, '2027-01-08': 4, '2027-01-09': 3,
                                 '2027-01-15': 2}


def test_in_app_events_count_per_name_with_their_share_of_app_opens(tmp_path):
    path = database(tmp_path)
    with closing(db.connect(path)) as conn, db.transaction(conn):
        add_counts(conn, 'app_open', {0: 4, 6: 2, 7: 10, 29: 1, 30: 50})
        add_counts(conn, 'remix', {0: 1, 29: 1})
        add_counts(conn, 'test_drive', {6: 3})
        add_counts(conn, 'retired_name', {0: 7})
    events = {row['name']: row for row in ops.report(path, NOW)['events']}
    assert list(events) == list(usage.EVENTS)
    assert {name: (row['today'], row['7d'], row['30d'], row['perAppOpen']) for name, row in events.items()
            if row['30d']} == {'app_open': (4, 6, 17, None), 'remix': (1, 1, 2, 2 / 17),
                               'test_drive': (0, 3, 3, 3 / 17)}
    assert events['signup_open']['perAppOpen'] == 0
    remix = [day['count'] for day in events['remix']['daily']]
    assert len(remix) == 30 and remix[0] == 1 and remix[-1] == 1 and sum(remix) == 2


def test_browser_errors_show_the_ten_most_frequent_fingerprints_of_the_last_7_days(tmp_path):
    path = database(tmp_path)

    def add(mark, before, count, last_at, message='Boom', version='v1'):
        conn.execute('INSERT INTO client_errors (day, fingerprint, message, where_, version, count, last_at) '
                     "VALUES (?, ?, ?, 'a.js:1:2', ?, ?, ?)", (day_of(NOW - before * DAY), mark, message, version, count,
                                                              last_at))

    with closing(db.connect(path)) as conn, db.transaction(conn):
        add('A', 0, 3, NOW - 10, 'A today')
        add('A', 6, 2, NOW - 6 * DAY, 'A before')
        add('A', 7, 100, NOW - 7 * DAY)  # the day before the 7
        add('B', 0, 5, NOW - 5, 'B')
        for index in range(11):
            add(f'F{index:02d}', 1, 1, NOW - DAY - index, f'F{index}')
    errors = ops.report(path, NOW)['errors']
    assert errors['total'] == 21 and errors['fingerprints'] == 13
    assert [(row['fingerprint'], row['count'], row['lastAt']) for row in errors['top']] == [
        ('B', 5, NOW - 5), ('A', 5, NOW - 10), *((f'F{index:02d}', 1, NOW - DAY - index) for index in range(8))]
    assert errors['top'][1] == {'fingerprint': 'A', 'count': 5, 'message': 'A today', 'where': 'a.js:1:2',
                                'version': 'v1', 'lastAt': NOW - 10}
