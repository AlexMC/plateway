"""Feedback (`feedback.py`): anyone sends it from the app or the site, it is stored without the sender's IP, the admins
get it by email, and the admin ops page lists it."""
from contextlib import ExitStack, closing, contextmanager
import json

from fastapi.testclient import TestClient

from cad.service import db, feedback, ops
from cad.service.app import create_app
from cad.service.mailer import FileSink
from signed_in import PASSWORD, session_headers, signed_in_client

HOST = '127.0.0.1:8765'
ORIGIN = f'http://{HOST}'
IP = '203.0.113.7'
HOUR, DAY = 3600, 24 * 3600
NOW = 1_800_000_000
TEXT = 'The curve piece snaps off when I drag it onto the turntable.'


class Clock:
    def __init__(self, now: float = NOW):
        self.now = now

    def __call__(self):
        return self.now


def app(root, clock):
    return create_app(root, expected_host=HOST, allowed_origin=ORIGIN, mailer=FileSink(root / 'mail'), clock=clock)


@contextmanager
def visitor(root, clock, ip=IP):
    with TestClient(app(root, clock), base_url=ORIGIN, headers={'CF-Connecting-IP': ip}) as client:
        yield client


def member(stack, root, clock, email, name):
    return stack.enter_context(signed_in_client(root, ORIGIN, expected_host=HOST, email=email, display_name=name,
                                                clock=clock))


def make_admin(root, email):
    with closing(db.connect(db.database_path(root))) as conn:
        conn.execute('UPDATE users SET is_admin = 1 WHERE email = ?', (email,))


def send(client, headers=None, **fields):
    body = {'message': TEXT, 'email': 'tester@example.org', 'page': '/app/#build', 'version': 'abc1234', 'website': '',
            **fields}
    return client.post('/api/feedback', json=body, headers=headers or {'Origin': ORIGIN})


def stored(root) -> list[dict]:
    with closing(db.connect(db.database_path(root))) as conn:
        return [dict(row) for row in conn.execute('SELECT * FROM feedback ORDER BY id')]


def mail(root, subject='feedback') -> list[dict]:
    messages = [json.loads(path.read_text()) for path in sorted((root / 'mail').glob('*.json'))]
    return [message for message in messages if subject in message['subject'].lower()]


def everything_stored(root) -> str:
    """Every value in every table, as text."""
    with closing(db.connect(db.database_path(root))) as conn:
        tables = [row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'")]
        return '\n'.join(repr(tuple(row)) for table in tables for row in conn.execute(f'SELECT * FROM "{table}"'))


def test_a_visitor_sends_feedback_which_is_stored_without_their_ip_and_emailed_to_every_admin(tmp_path):
    clock = Clock()
    with ExitStack() as stack:
        member(stack, tmp_path, clock, 'alex@example.com', 'Alex')
        member(stack, tmp_path, clock, 'sam@example.com', 'Sam')
        member(stack, tmp_path, clock, 'ada@example.com', 'Ada')
        make_admin(tmp_path, 'alex@example.com')
        make_admin(tmp_path, 'sam@example.com')
        with visitor(tmp_path, clock) as anyone:
            sent = send(anyone, message=f'  {TEXT}\nSecond line.  ')
    assert sent.status_code == 202, sent.text
    [row] = stored(tmp_path)
    assert row == {'id': row['id'], 'created_at': NOW, 'member_id': None, 'email': 'tester@example.org',
                   'message': f'{TEXT}\nSecond line.', 'page': '/app/#build', 'version': 'abc1234', 'handled_at': None}
    assert IP not in everything_stored(tmp_path)
    alerts = mail(tmp_path)
    assert sorted(alert['to'] for alert in alerts) == ['alex@example.com', 'sam@example.com']
    for alert in alerts:
        assert alert['reply_to'] == 'tester@example.org'
        assert f'{TEXT}\nSecond line.' in alert['text']
        assert '/app/#build' in alert['text'] and 'abc1234' in alert['text'] and 'tester@example.org' in alert['text']
        assert IP not in alert['text']


def test_feedback_without_an_email_is_stored_and_its_alert_has_no_reply_to(tmp_path):
    clock = Clock()
    with ExitStack() as stack:
        member(stack, tmp_path, clock, 'alex@example.com', 'Alex')
        make_admin(tmp_path, 'alex@example.com')
        with visitor(tmp_path, clock) as anyone:
            assert send(anyone, email='').status_code == 202
            assert send(anyone, email=None, page=None, version=None).status_code == 202
    assert [(row['email'], row['page'], row['version']) for row in stored(tmp_path)] == [
        (None, '/app/#build', 'abc1234'), (None, '', '')]
    alerts = mail(tmp_path)
    assert len(alerts) == 2 and all('reply_to' not in alert for alert in alerts)
    assert all('No email given' in alert['text'] for alert in alerts)


def test_a_signed_in_members_feedback_links_them_until_they_delete_their_account(tmp_path):
    clock = Clock()
    with ExitStack() as stack:
        ada = member(stack, tmp_path, clock, 'ada@example.com', 'Ada')
        # A member's POST needs the session's CSRF header, as every other member POST does.
        assert send(ada).status_code == 403
        assert send(ada, headers=session_headers(ada, ORIGIN)).status_code == 202
        ada_id = ada.get('/api/auth/me').json()['user']['id']
        assert [row['member_id'] for row in stored(tmp_path)] == [ada_id]
        deleted = ada.request('DELETE', '/api/account', json={'password': PASSWORD},
                              headers=session_headers(ada, ORIGIN))
        assert deleted.status_code == 200, deleted.text
    [row] = stored(tmp_path)
    assert row['member_id'] is None and row['message'] == TEXT


def test_the_message_is_10_to_4000_characters_and_the_email_must_be_an_address(tmp_path):
    with visitor(tmp_path, Clock()) as anyone:
        for fields in ({'message': 'x' * 9}, {'message': '   ' + 'x' * 9 + '   '}, {'message': 'x' * 4001},
                       {'message': None}, {'message': 42}, {'email': 'not an address'}, {'email': 'a@b'},
                       {'email': 'x' * 250 + '@example.org'}, {'email': ['a@example.org']}, {'page': 7},
                       {'version': {}}):
            response = send(anyone, **fields)
            assert response.status_code == 422, fields
            assert response.json()['detail'], fields
        assert send(anyone, message='x' * 10).status_code == 202
        assert send(anyone, message='y' * 4000).status_code == 202
        # The page and version are context: an overlong one is cut, never a reason to lose the feedback.
        assert send(anyone, page='/' + 'p' * 500, version='v' * 100).status_code == 202
        assert anyone.post('/api/feedback', content=b'{not json', headers={'Origin': ORIGIN}).status_code == 422
        assert anyone.post('/api/feedback', json=[TEXT], headers={'Origin': ORIGIN}).status_code == 422
    rows = stored(tmp_path)
    assert [len(row['message']) for row in rows] == [10, 4000, len(TEXT)]
    assert (len(rows[2]['page']), len(rows[2]['version'])) == (feedback.PAGE_MAX, feedback.VERSION_MAX)


def test_a_filled_honeypot_is_answered_as_sent_but_stores_and_emails_nothing(tmp_path):
    clock = Clock()
    with ExitStack() as stack:
        member(stack, tmp_path, clock, 'alex@example.com', 'Alex')
        make_admin(tmp_path, 'alex@example.com')
        with visitor(tmp_path, clock) as anyone:
            assert send(anyone, website='https://spam.example').status_code == 202
    assert stored(tmp_path) == [] and mail(tmp_path) == []


def test_feedback_needs_this_sites_origin(tmp_path):
    with visitor(tmp_path, Clock()) as anyone:
        assert anyone.post('/api/feedback', json={'message': TEXT}).status_code == 403
        assert send(anyone, headers={'Origin': 'https://elsewhere.example'}).status_code == 403
    assert stored(tmp_path) == []


def test_feedback_is_deleted_after_365_days_when_the_service_starts_or_its_daily_purge_runs(tmp_path):
    clock = Clock()
    with visitor(tmp_path, clock) as anyone:
        assert send(anyone, message='The oldest feedback here.').status_code == 202
        clock.now += DAY
        assert send(anyone, message='A day newer than the oldest.').status_code == 202
    clock.now = NOW + feedback.RETENTION_DAYS * DAY + 1
    with visitor(tmp_path, clock):
        pass
    assert [row['message'] for row in stored(tmp_path)] == ['A day newer than the oldest.']
    clock.now += DAY
    assert feedback.Feedback(db.database_path(tmp_path), FileSink(tmp_path / 'mail'), clock).purge() == 1
    assert stored(tmp_path) == []


def add_feedback(root, at, message, *, member_id=None, email=None):
    with closing(db.connect(db.database_path(root))) as conn:
        conn.execute('INSERT INTO feedback (created_at, member_id, email, message, page, version) VALUES (?, ?, ?, ?, ?, ?)',
                     (at, member_id, email, message, '/app/#build', 'abc1234'))


def test_the_ops_page_counts_feedback_and_lists_the_latest_twenty(tmp_path):
    clock = Clock()
    with ExitStack() as stack:
        alex = member(stack, tmp_path, clock, 'alex@example.com', 'Alex')
        ada = member(stack, tmp_path, clock, 'ada@example.com', 'Ada')
        make_admin(tmp_path, 'alex@example.com')
        ada_id = ada.get('/api/auth/me').json()['user']['id']
        add_feedback(tmp_path, NOW - 30 * DAY, 'Exactly thirty days old.')
        add_feedback(tmp_path, NOW - 20 * DAY, 'Twenty days old.', email='old@example.org')
        add_feedback(tmp_path, NOW - 7 * DAY, 'Exactly seven days old.')
        for index in range(20):
            add_feedback(tmp_path, NOW - 3 * DAY + index, f'Recent feedback number {index}.', member_id=ada_id)
        view = alex.get('/api/admin/ops').json()['feedback']
        page = alex.get('/admin/ops').text
    # Rolling windows as the rest of the page: a row counts when it is newer than the window's start.
    assert (view['7d'], view['30d']) == (20, 22)
    latest = view['latest']
    assert len(latest) == 20
    assert latest[0] == {'id': latest[0]['id'], 'message': 'Recent feedback number 19.', 'page': '/app/#build',
                         'version': 'abc1234', 'email': None, 'member': 'Ada', 'createdAt': NOW - 3 * DAY + 19}
    assert [row['message'] for row in latest[-2:]] == ['Recent feedback number 1.', 'Recent feedback number 0.']
    assert '<section class="section" id="feedback"' in page and '<a href="#feedback">Feedback</a>' in page
    assert 'Recent feedback number 19.' in page and 'Twenty days old.' not in page
    assert '2 d ago' in page and '>Ada<' in page
    assert '<script' not in page and 'style=' not in page


def test_the_ops_page_escapes_feedback(tmp_path):
    with visitor(tmp_path, Clock()) as anyone:
        assert send(anyone, message='<script>alert(1)</script> breaks', email='a"b@example.org').status_code == 202
    page = ops.render(ops.report(db.database_path(tmp_path), NOW))
    assert '<script>' not in page and '&lt;script&gt;alert(1)&lt;/script&gt; breaks' in page
    assert 'a&quot;b@example.org' in page


def test_opening_the_feedback_dialog_is_a_counted_feature(tmp_path):
    with visitor(tmp_path, Clock()) as anyone:
        assert anyone.post('/api/events', json={'events': ['feedback_open']}, headers={'Origin': ORIGIN}).status_code == 204
    with closing(db.connect(db.database_path(tmp_path))) as conn:
        assert [tuple(row) for row in conn.execute('SELECT name, count FROM event_counts')] == [('feedback_open', 1)]
