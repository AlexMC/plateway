"""Anonymous usage (`usage.py`): in-app feature counts and browser error reports, kept only as per-UTC-day totals."""
from contextlib import closing
import hashlib
import json

from fastapi.testclient import TestClient

from cad.service import db
from cad.service.app import create_app
from cad.service.mailer import FileSink
from signed_in import signed_in_client

ORIGIN = 'http://127.0.0.1:8765'
NOW = 1_800_000_000  # 2027-01-15 08:00 UTC
DAY = 24 * 3600
MIDNIGHT = NOW - NOW % DAY
HEADERS = {'Origin': ORIGIN}


class Clock:
    def __init__(self, now: float = NOW):
        self.now = now

    def __call__(self):
        return self.now


def anonymous(tmp_path, clock):
    return TestClient(create_app(tmp_path, allowed_origin=ORIGIN, mailer=FileSink(tmp_path / 'mail'), clock=clock),
                      base_url=ORIGIN)


def rows(tmp_path, query: str) -> list[tuple]:
    with closing(db.connect(db.database_path(tmp_path))) as conn:
        return [tuple(row) for row in conn.execute(query)]


def counts(tmp_path) -> dict[tuple[str, str], int]:
    return {(day, name): count for day, name, count in rows(tmp_path, 'SELECT day, name, count FROM event_counts')}


def beacon(client, path: str, body, **headers):
    """As `navigator.sendBeacon` sends it: JSON as text/plain, the page's Origin, any cookies, no other header."""
    return client.post(path, content=json.dumps(body), headers={**HEADERS, 'Content-Type': 'text/plain;charset=UTF-8',
                                                                 **headers})


def test_known_events_count_per_utc_day_and_unknown_ones_are_ignored(tmp_path):
    clock = Clock(MIDNIGHT - 1)
    with anonymous(tmp_path, clock) as client:
        assert beacon(client, '/api/events', {'events': ['app_open', 'start_hand', 'made_up']}).status_code == 204
        clock.now = MIDNIGHT
        assert beacon(client, '/api/events', {'events': ['app_open', 'app_open', 'remix']}).status_code == 204
        assert beacon(client, '/api/events', {'events': ['nothing_we_know']}).status_code == 204
    assert counts(tmp_path) == {('2027-01-14', 'app_open'): 1, ('2027-01-14', 'start_hand'): 1,
                                ('2027-01-15', 'app_open'): 2, ('2027-01-15', 'remix'): 1}


def test_a_batch_holds_one_to_twenty_names(tmp_path):
    with anonymous(tmp_path, Clock()) as client:
        assert beacon(client, '/api/events', {'events': ['app_open'] * 20}).status_code == 204
        for body in ({'events': ['app_open'] * 21}, {'events': []}, {'events': 'app_open'}, {'events': [1]}, [],
                     {}):
            assert beacon(client, '/api/events', body).status_code == 422, body
        assert client.post('/api/events', content=b'{not json', headers=HEADERS).status_code == 422
    assert counts(tmp_path) == {('2027-01-15', 'app_open'): 20}


def test_reports_need_this_sites_origin_but_no_session(tmp_path):
    with anonymous(tmp_path, Clock()) as client:
        assert client.post('/api/events', json={'events': ['app_open']}).status_code == 403
        assert client.post('/api/events', json={'events': ['app_open']},
                           headers={'Origin': 'https://elsewhere.example'}).status_code == 403
        assert client.post('/api/client-errors', json={'message': 'x'}).status_code == 403
    # A signed-in member's beacon carries the session cookie but cannot carry the CSRF header.
    with signed_in_client(tmp_path, ORIGIN, clock=Clock()) as member:
        assert beacon(member, '/api/events', {'events': ['signin_open']}).status_code == 204
        assert beacon(member, '/api/client-errors', {'message': 'boom'}).status_code == 204
        assert member.post('/api/projects', json={}, headers=HEADERS).status_code == 403  # elsewhere CSRF still holds
    assert counts(tmp_path) == {('2027-01-15', 'signin_open'): 1}


def test_each_client_ip_is_rate_limited_in_memory_and_never_stored(tmp_path):
    clock = Clock()
    ip, other = '203.0.113.9', '198.51.100.7'
    with anonymous(tmp_path, clock) as client:
        sent = [beacon(client, '/api/client-errors', {'message': f'Error {n}', 'where': 'a.js:1:1', 'version': 'v1'},
                       **{'CF-Connecting-IP': ip}).status_code for n in range(21)]
        assert sent == [204] * 20 + [429]
        assert beacon(client, '/api/client-errors', {'message': 'Other'}, **{'CF-Connecting-IP': other}).status_code == 204
        events = [beacon(client, '/api/events', {'events': ['app_open']}, **{'CF-Connecting-IP': ip}).status_code
                  for _ in range(61)]
        assert events == [204] * 60 + [429]
        clock.now += 60
        assert beacon(client, '/api/client-errors', {'message': 'Later'}, **{'CF-Connecting-IP': ip}).status_code == 204
        assert beacon(client, '/api/events', {'events': ['app_open']}, **{'CF-Connecting-IP': ip}).status_code == 204
    assert counts(tmp_path) == {('2027-01-15', 'app_open'): 61}
    assert rows(tmp_path, 'SELECT sum(count) FROM client_errors') == [(22,)]
    # Only aggregates: no column could hold who sent it, and the IP is nowhere in the database.
    assert [row[1] for row in rows(tmp_path, 'PRAGMA table_info(event_counts)')] == ['day', 'name', 'count']
    assert [row[1] for row in rows(tmp_path, 'PRAGMA table_info(client_errors)')] == [
        'day', 'fingerprint', 'message', 'where_', 'version', 'count', 'last_at']
    tables = [name for (name,) in rows(tmp_path, "SELECT name FROM sqlite_master WHERE type = 'table'")]
    stored = '\n'.join(str(value) for table in tables for row in rows(tmp_path, f'SELECT * FROM {table}') for value in row)
    assert ip not in stored and other not in stored


def test_browser_errors_aggregate_per_day_and_fingerprint_truncated_to_one_line(tmp_path):
    clock = Clock()
    report = {'message': 'TypeError: x is undefined', 'where': 'assets/index-abc.js:12:34', 'version': 'build-1'}
    with anonymous(tmp_path, clock) as client:
        for _ in range(3):
            assert beacon(client, '/api/client-errors', report).status_code == 204
        clock.now += 10
        assert beacon(client, '/api/client-errors', {**report, 'version': 'build-2'}).status_code == 204
        long = {'message': 'M' * 290 + ' line\nbreak ' + 'm' * 100, 'where': 'W' * 500, 'version': 'V' * 99,
                'extra': 'ignored'}
        assert beacon(client, '/api/client-errors', long).status_code == 204
        for bad in ({'message': ''}, {'message': 5}, {'where': 'a.js:1:1'}, {'message': 'x', 'where': ['a']}, []):
            assert beacon(client, '/api/client-errors', bad).status_code == 422, bad
        assert client.post('/api/client-errors', content=b'x' * 5000, headers=HEADERS).status_code == 413
    stored = rows(tmp_path, 'SELECT day, fingerprint, message, where_, version, count, last_at FROM client_errors '
                            'ORDER BY version')
    message = ('M' * 290 + ' line break ' + 'm' * 100)[:300]
    mark = hashlib.sha256((message + 'W' * 200 + 'V' * 40).encode()).hexdigest()[:16]
    first = hashlib.sha256(b'TypeError: x is undefinedassets/index-abc.js:12:34build-1').hexdigest()[:16]
    assert stored == [
        ('2027-01-15', mark, message, 'W' * 200, 'V' * 40, 1, NOW + 10),
        ('2027-01-15', first, report['message'], report['where'], 'build-1', 3, NOW),
        ('2027-01-15', hashlib.sha256(b'TypeError: x is undefinedassets/index-abc.js:12:34build-2').hexdigest()[:16],
         report['message'], report['where'], 'build-2', 1, NOW + 10)]


def test_totals_are_kept_for_400_days(tmp_path):
    clock = Clock(MIDNIGHT)
    with anonymous(tmp_path, clock) as client:
        beacon(client, '/api/events', {'events': ['app_open']})
        beacon(client, '/api/client-errors', {'message': 'old'})
        clock.now += DAY
        beacon(client, '/api/events', {'events': ['remix']})
        clock.now = MIDNIGHT + 399 * DAY  # the first day is the oldest of the 400 kept
        beacon(client, '/api/events', {'events': ['test_drive']})
        assert ('2027-01-15', 'app_open') in counts(tmp_path)
        assert rows(tmp_path, 'SELECT count(*) FROM client_errors') == [(1,)]
        clock.now += DAY
        beacon(client, '/api/client-errors', {'message': 'new'})
    assert set(counts(tmp_path)) == {('2027-01-16', 'remix'), ('2028-02-18', 'test_drive')}
    assert rows(tmp_path, 'SELECT message FROM client_errors') == [('new',)]
