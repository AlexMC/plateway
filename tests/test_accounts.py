from hashlib import sha256
from http.server import BaseHTTPRequestHandler, HTTPServer
from io import BytesIO
import json
import logging
import re
import threading
import uuid
from zipfile import ZipFile

from fastapi.testclient import TestClient
import pytest

from cad.service import accounts, db
from cad.service.app import create_app
from cad.service.mailer import CloudflareEmail, FileSink, MailError, Message, from_env

HOST = '127.0.0.1:8765'
ORIGIN = f'http://{HOST}'
COOKIE = 'plateway'
PASSWORD = 'correct horse battery'
HOUR = 3600
DAY = 24 * HOUR


class Clock:
    def __init__(self):
        self.now = 1_900_000_000.0

    def __call__(self):
        return self.now

    def advance(self, seconds):
        self.now += seconds


@pytest.fixture
def clock():
    return Clock()


def service(tmp_path, clock, **options):
    root = tmp_path / 'root'
    app = create_app(root, expected_host=HOST, allowed_origin=ORIGIN, clock=clock,
                     mailer=FileSink(tmp_path / 'mail'), **options)
    return TestClient(app, base_url=ORIGIN)


def mails(tmp_path, to=None):
    folder = tmp_path / 'mail'
    sent = [json.loads(path.read_text()) for path in sorted(folder.glob('*.json'))] if folder.is_dir() else []
    return [mail for mail in sent if to is None or mail['to'] == to]


def link_token(mail, kind):
    match = re.search(rf'{re.escape(ORIGIN)}/app/#{kind}=([A-Za-z0-9_-]+)', mail['text'])
    return match.group(1) if match else None


def latest_token(tmp_path, to, kind):
    tokens = [token for token in (link_token(mail, kind) for mail in mails(tmp_path, to)) if token]
    return tokens[-1]


def post(app, path, body=None, *, csrf=None, ip=None, origin=ORIGIN, method='POST'):
    headers = {}
    if origin:
        headers['Origin'] = origin
    if csrf:
        headers['X-Workshop-Session'] = csrf
    if ip:
        headers['CF-Connecting-IP'] = ip
    return app.request(method, path, json=body if body is not None else {}, headers=headers)


def signup(app, email='ada@example.com', name='Ada', password=PASSWORD, ip=None):
    return post(app, '/api/auth/signup', {'email': email, 'password': password, 'displayName': name}, ip=ip)


def login(app, email='ada@example.com', password=PASSWORD, ip=None):
    return post(app, '/api/auth/login', {'email': email, 'password': password}, ip=ip)


def csrf(app):
    return app.get('/api/auth/me').json()['csrf']


def member(app, tmp_path, email='ada@example.com', name='Ada'):
    """A verified member, signed in on `app`; returns the session's CSRF token."""
    app.cookies.clear()
    assert signup(app, email, name).status_code == 202
    token = login(app, email).json()['csrf']
    verified = post(app, '/api/auth/verify-email', {'token': latest_token(tmp_path, email, 'verify')}, csrf=token)
    assert verified.status_code == 200 and verified.json()['signedIn'] is True, verified.text
    return token


def project():
    return {'version': 5, 'id': str(uuid.uuid4()), 'revision': str(uuid.uuid4()), 'name': 'Loop',
            'parentRevision': None, 'provenance': {'account': None},
            'routes': [], 'measurements': {}, 'furniture': [], 'trackSystem': 'brick-v1',
            'connectorFit': {'adjustmentMm': 0, 'settingsKey': None, 'calibrationId': None}}


def database(tmp_path):
    return db.connect(tmp_path / 'root' / 'plateway.db')


def test_signup_answers_the_same_for_new_and_existing_emails(tmp_path, clock):
    with service(tmp_path, clock) as app:
        first = signup(app, 'ada@example.com', 'Ada')
        second = signup(app, 'ADA@example.com', 'Somebody', password='another long secret')
        assert (first.status_code, first.json()) == (second.status_code, second.json()) == (202, {'status': 'check-email'})
        assert 'set-cookie' not in first.headers and 'set-cookie' not in second.headers
    verify, already = mails(tmp_path)
    assert verify['to'] == already['to'] == 'ada@example.com'
    assert link_token(verify, 'verify')
    assert 'already' in already['text'] and '#verify=' not in already['text'] and '#reset=' not in already['text']


def test_signup_rejects_weak_passwords_and_invalid_details_without_sending_mail(tmp_path, clock):
    with service(tmp_path, clock) as app:
        assert signup(app, password='short').status_code == 422
        assert signup(app, password='PassWord1').status_code == 422  # a common password, any case
        assert signup(app, password='x' * 129).status_code == 422
        assert signup(app, email='not-an-email').status_code == 422
        assert signup(app, name='ab').status_code == 422
        assert signup(app, name='x' * 31).status_code == 422
        assert signup(app, password='  spaces count  ').status_code == 202
        assert login(app, password='spaces count').status_code == 401
    assert len(mails(tmp_path)) == 1


def test_verification_link_works_once_and_expires_after_24_hours(tmp_path, clock):
    with service(tmp_path, clock) as app:
        signup(app, 'ada@example.com', 'Ada')
        signup(app, 'bob@example.com', 'Bob')
        ada, bob = latest_token(tmp_path, 'ada@example.com', 'verify'), latest_token(tmp_path, 'bob@example.com', 'verify')
        verified = post(app, '/api/auth/verify-email', {'token': ada})
        assert (verified.status_code, verified.json()) == (200, {'verified': True, 'signedIn': False})
        assert login(app, 'ada@example.com').json()['user']['verified'] is True
        app.cookies.clear()
        assert post(app, '/api/auth/verify-email', {'token': ada}).status_code == 400
        clock.advance(DAY + 1)
        assert post(app, '/api/auth/verify-email', {'token': bob}).status_code == 400
        assert login(app, 'bob@example.com').json()['user']['verified'] is False


def test_a_verify_link_never_signs_a_browser_in(tmp_path, clock):
    """Login CSRF: a link someone else sends must not put this browser in their account."""
    with service(tmp_path, clock) as app:
        signup(app, 'eve@example.com', 'Eve')
        visitor = post(app, '/api/auth/verify-email', {'token': latest_token(tmp_path, 'eve@example.com', 'verify')})
        assert (visitor.status_code, visitor.json()) == (200, {'verified': True, 'signedIn': False})
        assert 'set-cookie' not in visitor.headers and COOKIE not in app.cookies
        assert app.get('/api/auth/me').status_code == 401


def test_a_verify_link_leaves_another_members_session_in_place(tmp_path, clock):
    with service(tmp_path, clock) as app:
        signup(app, 'eve@example.com', 'Eve')
        eve = latest_token(tmp_path, 'eve@example.com', 'verify')
        ada = member(app, tmp_path)
        cookie = app.cookies[COOKIE]
        other = post(app, '/api/auth/verify-email', {'token': eve}, csrf=ada)
        assert (other.status_code, other.json()) == (200, {'verified': True, 'signedIn': False})
        assert 'set-cookie' not in other.headers and app.cookies[COOKIE] == cookie
        signed = app.get('/api/auth/me').json()
        assert (signed['user']['email'], signed['csrf']) == ('ada@example.com', ada)
        app.cookies.clear()
        assert login(app, 'eve@example.com').json()['user']['verified'] is True


def test_a_verify_link_keeps_the_same_member_signed_in(tmp_path, clock):
    with service(tmp_path, clock) as app:
        signup(app)
        token = login(app).json()['csrf']
        cookie = app.cookies[COOKIE]
        verified = post(app, '/api/auth/verify-email', {'token': latest_token(tmp_path, 'ada@example.com', 'verify')},
                        csrf=token)
        assert verified.status_code == 200
        body = verified.json()
        assert (body['verified'], body['signedIn'], body['user']['verified'], body['csrf']) == (True, True, True, token)
        assert 'set-cookie' not in verified.headers and app.cookies[COOKIE] == cookie
        assert app.get('/api/auth/me').json()['user']['verified'] is True


def test_resend_sends_a_fresh_link_and_the_fourth_in_an_hour_is_refused(tmp_path, clock):
    with service(tmp_path, clock) as app:
        signup(app)
        token = login(app).json()['csrf']
        for _ in range(3):
            assert post(app, '/api/auth/resend-verification', csrf=token).status_code == 202
        assert post(app, '/api/auth/resend-verification', csrf=token).status_code == 429
        links = [link_token(mail, 'verify') for mail in mails(tmp_path, 'ada@example.com')]
        assert len(links) == len(set(links)) == 4
        clock.advance(HOUR + 1)
        assert post(app, '/api/auth/resend-verification', csrf=token).status_code == 202
        assert post(app, '/api/auth/verify-email', {'token': latest_token(tmp_path, 'ada@example.com', 'verify')},
                    csrf=token).status_code == 200
        assert post(app, '/api/auth/resend-verification', csrf=csrf(app)).status_code == 409


def test_reset_link_expires_after_an_hour_works_once_and_revokes_older_sessions(tmp_path, clock):
    with service(tmp_path, clock) as app:
        member(app, tmp_path)
        first_device = app.cookies[COOKIE]
        app.cookies.clear()
        login(app)
        second_device = app.cookies[COOKIE]
        app.cookies.clear()
        assert post(app, '/api/auth/password/forgot', {'email': 'ada@example.com'}).status_code == 202
        expired = latest_token(tmp_path, 'ada@example.com', 'reset')
        clock.advance(HOUR + 1)
        assert post(app, '/api/auth/password/reset', {'token': expired, 'password': 'a brand new secret'}).status_code == 400
        assert post(app, '/api/auth/password/forgot', {'email': 'ada@example.com'}).status_code == 202
        token = latest_token(tmp_path, 'ada@example.com', 'reset')
        reset = post(app, '/api/auth/password/reset', {'token': token, 'password': 'a brand new secret'})
        assert reset.status_code == 200
        assert app.get('/api/auth/me').status_code == 200
        app.cookies.clear()
        assert post(app, '/api/auth/password/reset', {'token': token, 'password': 'yet another secret'}).status_code == 400
        for old in (first_device, second_device):
            app.cookies.set(COOKIE, old)
            assert app.get('/api/auth/me').status_code == 401
            app.cookies.clear()
        assert login(app).status_code == 401
        assert login(app, password='a brand new secret').status_code == 200


def test_forgot_password_answers_the_same_for_unknown_emails(tmp_path, clock):
    with service(tmp_path, clock) as app:
        member(app, tmp_path)
        app.cookies.clear()
        known = post(app, '/api/auth/password/forgot', {'email': 'ada@example.com'})
        unknown = post(app, '/api/auth/password/forgot', {'email': 'nobody@example.com'})
        assert (known.status_code, known.json()) == (unknown.status_code, unknown.json()) == (202, {'status': 'check-email'})
    assert not mails(tmp_path, 'nobody@example.com')


def test_failed_sign_ins_throttle_the_account_and_ip_pair_without_locking_out_other_ips(tmp_path, clock):
    with service(tmp_path, clock) as app:
        member(app, tmp_path)
        app.cookies.clear()
        for _ in range(10):
            assert login(app, password='wrong password!', ip='203.0.113.1').status_code == 401
        assert login(app, ip='203.0.113.1').status_code == 429
        assert login(app, ip='198.51.100.7').status_code == 200
        app.cookies.clear()
        clock.advance(HOUR + 1)
        assert login(app, ip='203.0.113.1').status_code == 200


def test_thirty_failed_sign_ins_from_one_ip_block_that_ip_for_every_account(tmp_path, clock):
    with service(tmp_path, clock) as app:
        for index in range(4):
            assert signup(app, f'm{index}@example.com', f'Member {index}', ip=f'192.0.2.{index}').status_code == 202
        for index in range(3):
            for _ in range(10):
                assert login(app, f'm{index}@example.com', 'wrong password!', ip='203.0.113.9').status_code == 401
        assert login(app, 'm3@example.com', ip='203.0.113.9').status_code == 429
        assert login(app, 'm3@example.com', ip='198.51.100.7').status_code == 200


def test_sign_ups_and_reset_requests_are_limited_per_ip(tmp_path, clock):
    with service(tmp_path, clock) as app:
        for index in range(5):
            assert signup(app, f'm{index}@example.com', f'Member {index}', ip='203.0.113.1').status_code == 202
        assert signup(app, 'm5@example.com', 'Member 5', ip='203.0.113.1').status_code == 429
        assert signup(app, 'm5@example.com', 'Member 5', ip='198.51.100.7').status_code == 202
        for _ in range(5):
            assert post(app, '/api/auth/password/forgot', {'email': 'm0@example.com'}, ip='203.0.113.2').status_code == 202
        assert post(app, '/api/auth/password/forgot', {'email': 'm0@example.com'}, ip='203.0.113.2').status_code == 429
        assert post(app, '/api/auth/password/forgot', {'email': 'm0@example.com'}, ip='198.51.100.8').status_code == 202


def test_mutations_with_a_session_need_that_sessions_csrf_token(tmp_path, clock):
    with service(tmp_path, clock) as app:
        ada = member(app, tmp_path, 'ada@example.com', 'Ada')
        bob = member(app, tmp_path, 'bob@example.com', 'Bob')
        assert post(app, '/api/projects', project()).status_code == 403
        assert post(app, '/api/projects', project(), csrf=ada).status_code == 403
        assert post(app, '/api/projects', project(), csrf=bob).status_code == 201


def test_visitor_needs_no_session_or_csrf_for_the_shopping_list(tmp_path, clock):
    bracket = {'family': 'track_bracket', 'label': 'Wall bracket', 'parameters': {'mount': 1, 'reach': 72, 'height': 0}}
    body = {'pieces': [{'id': 'w1', 'piece': 'w1', **bracket}]}
    with service(tmp_path, clock) as app:
        assert post(app, '/api/hardware', body).status_code == 200
        member(app, tmp_path)
        assert post(app, '/api/hardware', body).status_code == 403
        assert post(app, '/api/hardware', body, csrf=csrf(app)).status_code == 200


def test_unsafe_requests_need_an_allowed_origin_even_without_a_session(tmp_path, clock):
    bodies = {'/api/auth/signup': {'email': 'ada@example.com', 'password': PASSWORD, 'displayName': 'Ada'},
              '/api/auth/login': {'email': 'ada@example.com', 'password': PASSWORD},
              '/api/auth/password/forgot': {'email': 'ada@example.com'},
              '/api/auth/password/reset': {'token': 'x', 'password': PASSWORD},
              '/api/auth/verify-email': {'token': 'x'},
              '/api/hardware': {'pieces': []}}
    with service(tmp_path, clock) as app:
        for path, body in bodies.items():
            for origin in (None, 'https://evil.example', 'http://127.0.0.1:8766'):
                assert post(app, path, body, origin=origin).status_code == 403, (path, origin)
        assert app.get('/api/auth/me', headers={'Origin': 'https://evil.example'}).status_code == 403
    assert not mails(tmp_path)


def test_database_holds_only_hashes_of_session_and_email_tokens(tmp_path, clock):
    with service(tmp_path, clock) as app:
        token = member(app, tmp_path)
        raw = {app.cookies[COOKIE], token, latest_token(tmp_path, 'ada@example.com', 'verify')}
        assert post(app, '/api/account/email', {'password': PASSWORD, 'newEmail': 'ada@new.example'}, csrf=token).status_code == 202
        raw.add(latest_token(tmp_path, 'ada@new.example', 'confirm-email'))
        app.cookies.clear()
        post(app, '/api/auth/password/forgot', {'email': 'ada@example.com'})
        raw.add(latest_token(tmp_path, 'ada@example.com', 'reset'))
        login(app)
        raw.add(app.cookies[COOKIE])
        session_hash = sha256(app.cookies[COOKIE].encode()).hexdigest()
    conn = database(tmp_path)
    tables = [row['name'] for row in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'")]
    stored = '\n'.join(str(value) for table in tables for row in conn.execute(f'SELECT * FROM {table}') for value in row)
    assert session_hash in stored
    assert all(value and value not in stored for value in raw)
    assert conn.execute('SELECT count(*) FROM email_tokens').fetchone()[0] == 3


def test_email_links_carry_the_token_in_the_fragment(tmp_path, clock):
    with service(tmp_path, clock) as app:
        token = member(app, tmp_path)
        post(app, '/api/account/email', {'password': PASSWORD, 'newEmail': 'ada@new.example'}, csrf=token)
        app.cookies.clear()
        post(app, '/api/auth/password/forgot', {'email': 'ada@example.com'})
    links = [link for mail in mails(tmp_path) for link in re.findall(r'https?://\S+', mail['text'])]
    assert {link.split('=', 1)[0] for link in links if '=' in link} == {
        f'{ORIGIN}/app/#verify', f'{ORIGIN}/app/#confirm-email', f'{ORIGIN}/app/#reset'}
    assert all('?' not in link and link.startswith(f'{ORIGIN}/app/') for link in links)


def test_changing_the_password_needs_the_current_one_and_signs_out_other_sessions(tmp_path, clock):
    with service(tmp_path, clock) as app:
        member(app, tmp_path)
        other_device = app.cookies[COOKIE]
        app.cookies.clear()
        token = login(app).json()['csrf']
        change = lambda current: post(app, '/api/account/password', {'current': current, 'password': 'a brand new secret'},
                                      csrf=token)
        assert change('not my password').status_code == 403
        assert change(PASSWORD).status_code == 200
        assert app.get('/api/auth/me').status_code == 200
        app.cookies.set(COOKIE, other_device)
        assert app.get('/api/auth/me').status_code == 401
        app.cookies.clear()
        assert login(app).status_code == 401
        assert login(app, password='a brand new secret').status_code == 200


def test_changing_the_email_or_deleting_the_account_needs_the_current_password(tmp_path, clock):
    with service(tmp_path, clock) as app:
        token = member(app, tmp_path)
        for body in ({'newEmail': 'ada@new.example'}, {'password': 'not my password', 'newEmail': 'ada@new.example'}):
            assert post(app, '/api/account/email', body, csrf=token).status_code == 403
        for body in ({}, {'password': 'not my password'}):
            assert post(app, '/api/account', body, csrf=token, method='DELETE').status_code == 403
        assert app.get('/api/auth/me').json()['user']['email'] == 'ada@example.com'
    assert not mails(tmp_path, 'ada@new.example')


def test_a_new_email_takes_effect_only_once_confirmed_and_voids_older_links(tmp_path, clock):
    with service(tmp_path, clock) as app:
        token = member(app, tmp_path)
        assert post(app, '/api/account/email', {'password': PASSWORD, 'newEmail': 'ada@new.example'}, csrf=token).status_code == 202
        confirm = latest_token(tmp_path, 'ada@new.example', 'confirm-email')
        app.cookies.clear()
        post(app, '/api/auth/password/forgot', {'email': 'ada@example.com'})
        reset = latest_token(tmp_path, 'ada@example.com', 'reset')
        assert login(app, 'ada@new.example').status_code == 401
        assert login(app, 'ada@example.com').status_code == 200
        app.cookies.clear()
        confirmed = post(app, '/api/auth/email/confirm', {'token': confirm})
        assert confirmed.status_code == 200
        assert confirmed.json()['user']['email'] == 'ada@new.example'
        assert post(app, '/api/auth/email/confirm', {'token': confirm}).status_code == 400
        assert post(app, '/api/auth/password/reset', {'token': reset, 'password': 'a brand new secret'}).status_code == 400
        assert login(app, 'ada@example.com').status_code == 401
        assert login(app, 'ada@new.example').status_code == 200
    assert mails(tmp_path, 'ada@example.com')[-1]['subject'] == 'Your Plateway email was changed'


class CountingHasher:
    """The real hasher, counting the (deliberately expensive) hashes it computes."""
    def __init__(self, hasher):
        self.hasher, self.hashed = hasher, 0

    def hash(self, password):
        self.hashed += 1
        return self.hasher.hash(password)

    def __getattr__(self, name):
        return getattr(self.hasher, name)


def test_throttled_sign_ups_and_bad_reset_links_cost_no_password_hash(tmp_path, clock, monkeypatch):
    hasher = CountingHasher(accounts.HASHER)
    monkeypatch.setattr(accounts, 'HASHER', hasher)
    with service(tmp_path, clock) as app:
        for index in range(5):
            assert signup(app, f'm{index}@example.com', f'Member {index}', ip='203.0.113.1').status_code == 202
        hasher.hashed = 0
        assert signup(app, 'm5@example.com', 'Member 5', ip='203.0.113.1').status_code == 429
        assert post(app, '/api/auth/password/reset', {'token': 'not-a-link', 'password': 'a brand new secret'}).status_code == 400
        assert hasher.hashed == 0
        post(app, '/api/auth/password/forgot', {'email': 'm0@example.com'})
        reset = latest_token(tmp_path, 'm0@example.com', 'reset')
        assert post(app, '/api/auth/password/reset', {'token': reset, 'password': 'short'}).status_code == 422
        assert post(app, '/api/auth/password/reset', {'token': reset, 'password': 'a brand new secret'}).status_code == 200
        assert hasher.hashed == 1


def test_resetting_or_changing_the_password_voids_a_pending_email_change(tmp_path, clock):
    with service(tmp_path, clock) as app:
        token = member(app, tmp_path)
        assert post(app, '/api/account/email', {'password': PASSWORD, 'newEmail': 'eve@example.net'}, csrf=token).status_code == 202
        before_reset = latest_token(tmp_path, 'eve@example.net', 'confirm-email')
        post(app, '/api/auth/password/forgot', {'email': 'ada@example.com'}, csrf=token)
        reset = latest_token(tmp_path, 'ada@example.com', 'reset')
        assert post(app, '/api/auth/password/reset', {'token': reset, 'password': 'a brand new secret'},
                    csrf=token).status_code == 200
        token = csrf(app)
        assert post(app, '/api/auth/email/confirm', {'token': before_reset}, csrf=token).status_code == 400
        assert post(app, '/api/account/email', {'password': 'a brand new secret', 'newEmail': 'eve@example.org'},
                    csrf=token).status_code == 202
        before_change = latest_token(tmp_path, 'eve@example.org', 'confirm-email')
        assert post(app, '/api/account/password', {'current': 'a brand new secret', 'password': 'yet another secret'},
                    csrf=token).status_code == 200
        assert post(app, '/api/auth/email/confirm', {'token': before_change}, csrf=token).status_code == 400
        assert app.get('/api/auth/me').json()['user']['email'] == 'ada@example.com'


def test_sign_out_deletes_the_session_on_the_server_and_clears_site_storage(tmp_path, clock):
    with service(tmp_path, clock) as app:
        token = member(app, tmp_path)
        cookie = app.cookies[COOKIE]
        out = post(app, '/api/auth/logout', csrf=token)
        assert out.status_code == 200
        assert out.headers['clear-site-data'] == '"storage"'
        assert f'{COOKIE}=""' in out.headers['set-cookie'] or 'Max-Age=0' in out.headers['set-cookie']
        app.cookies.set(COOKIE, cookie)
        assert app.get('/api/auth/me').status_code == 401
        assert app.get('/api/projects').status_code == 401
    assert database(tmp_path).execute('SELECT count(*) FROM sessions').fetchone()[0] == 0


def test_hosted_cookie_is_host_prefixed_secure_http_only_and_lax(tmp_path, clock):
    host = 'plateway.example'
    app = create_app(tmp_path / 'root', expected_host=host, allowed_origin=f'https://{host}', clock=clock,
                     mailer=FileSink(tmp_path / 'mail'))
    with TestClient(app, base_url=f'https://{host}') as client:
        headers = {'Origin': f'https://{host}'}
        assert client.post('/api/auth/signup', json={'email': 'ada@example.com', 'password': PASSWORD, 'displayName': 'Ada'},
                           headers=headers).status_code == 202
        signed_in = client.post('/api/auth/login', json={'email': 'ada@example.com', 'password': PASSWORD}, headers=headers)
        cookie = signed_in.headers['set-cookie']
        assert cookie.startswith('__Host-plateway=')
        attributes = {part.strip().split('=')[0].lower() for part in cookie.split(';')[1:]}
        assert {'httponly', 'secure', 'path', 'samesite'} <= attributes and 'domain' not in attributes
        assert 'samesite=lax' in cookie.lower() and 'path=/' in cookie.lower()
        assert client.get('/api/auth/me').status_code == 200


def test_unverified_member_can_save_but_not_prepare(tmp_path, clock):
    with service(tmp_path, clock) as app:
        signup(app)
        token = login(app).json()['csrf']
        assert post(app, '/api/projects', project(), csrf=token).status_code == 201
        for body in ({'kind': 'layout', 'manifest': {}}, {'kind': 'coupon', 'parts': [], 'printer': {}}):
            refused = post(app, '/api/jobs', body, csrf=token)
            assert refused.status_code == 403
            assert refused.json()['detail'] == 'Verify your email first'


def test_visitors_cannot_reach_member_data(tmp_path, clock):
    with service(tmp_path, clock) as app:
        for path in ('/api/projects', '/api/calibrations', '/api/packages', '/api/account/export'):
            assert app.get(path).status_code == 401
        assert post(app, '/api/projects', project()).status_code == 401
        assert app.get('/api/print-presets').status_code != 401
        assert app.get('/api/session').status_code == 404


def test_display_names_are_unique_without_regard_to_case(tmp_path, clock):
    with service(tmp_path, clock) as app:
        assert signup(app, 'ada@example.com', 'Ada').status_code == 202
        assert signup(app, 'bob@example.com', 'ADA').status_code == 409
        assert signup(app, 'bob@example.com', 'Bob').status_code == 202
        token = login(app, 'bob@example.com').json()['csrf']
        rename = lambda name: post(app, '/api/account', {'displayName': name}, csrf=token, method='PATCH')
        assert rename('aDa').status_code == 409
        assert rename('ab').status_code == 422
        assert rename('Bobby').json()['user']['displayName'] == 'Bobby'
        assert rename('BOBBY').json()['user']['displayName'] == 'BOBBY'


def seed_member_data(conn, user_id):
    conn.execute('INSERT INTO projects (id, owner_id, name, created_at, updated_at) VALUES (?, ?, ?, 0, 0)', ('p1', user_id, 'Loop'))
    conn.execute('INSERT INTO revisions (id, project_id, owner_id, number, body, created_at) VALUES (?, ?, ?, 1, ?, 0)',
                 ('r1', 'p1', user_id, json.dumps({'name': 'Loop'})))
    conn.execute('INSERT INTO calibrations (id, owner_id, settings_key, track_system, result, receipt_id, record, recorded_at) '
                 "VALUES ('c1', ?, 'key', 'brick-v1', 'fits', 'trial-1', '{}', 0)", (user_id,))
    conn.execute('INSERT INTO receipts (package_id, owner_id, kind, digest, body, storage_prefix, created_at, expires_at) '
                 "VALUES ('pkg1', ?, 'layout', 'd1', '{\"id\": \"pkg1\"}', ?, 0, 0)", (user_id, f'packages/{user_id}/pkg1'))
    conn.execute('INSERT INTO gallery_layouts (id, owner_id, title, body, author_name, published_at) '
                 "VALUES ('g1', ?, 'Loop', '{}', 'Ada', 0)", (user_id,))
    conn.execute("INSERT INTO package_downloads (package_id, owner_id, kind, at) VALUES ('pkg1', ?, 'zip', 5)", (user_id,))


def test_deleting_an_account_cancels_its_job_and_removes_its_data_and_session(tmp_path, clock):
    cleaned = []
    with service(tmp_path, clock, account_cleanup=cleaned.append) as app:
        token = member(app, tmp_path)
        user_id = app.get('/api/auth/me').json()['user']['id']
        cookie = app.cookies[COOKIE]
        conn = database(tmp_path)
        seed_member_data(conn, user_id)
        conn.execute("INSERT INTO jobs (id, owner_id, kind, state, manifest, created_at) VALUES ('j1', ?, 'layout', 'queued', '{}', 0)",
                     (user_id,))
        deleted = post(app, '/api/account', {'password': PASSWORD}, csrf=token, method='DELETE')
        assert deleted.status_code == 200
        assert deleted.headers['clear-site-data'] == '"storage"'
        app.cookies.set(COOKIE, cookie)
        assert app.get('/api/auth/me').status_code == 401
        assert login(app).status_code == 401
    assert dict(conn.execute("SELECT state, owner_id FROM jobs WHERE id = 'j1'").fetchone()) == {'state': 'cancelled', 'owner_id': None}
    for table in ('users', 'sessions', 'email_tokens', 'projects', 'revisions', 'calibrations', 'receipts', 'gallery_layouts'):
        assert conn.execute(f'SELECT count(*) FROM {table}').fetchone()[0] == 0, table
    assert [deletion.storage_prefixes for deletion in cleaned] == [(f'packages/{user_id}/pkg1',)]
    assert mails(tmp_path, 'ada@example.com')[-1]['subject'] == 'Your Plateway account was deleted'


def test_deleting_an_account_withdraws_unmerged_submissions_and_closes_their_pull_requests(tmp_path, clock):
    cleaned = []
    with service(tmp_path, clock, account_cleanup=cleaned.append) as app:
        token = member(app, tmp_path)
        user_id = app.get('/api/auth/me').json()['user']['id']
        conn = database(tmp_path)
        for submission, state, pr in (('s1', 'pr_open', 42), ('s2', 'merged', 7), ('s3', 'awaiting_look', None)):
            conn.execute('INSERT INTO submissions (id, owner_id, kind, state, author_name, licence, metadata, attested_at, '
                         "pr_number, created_at, updated_at) VALUES (?, ?, 'piece', ?, 'Ada', 'CC-BY-4.0', '{}', 0, ?, 0, 0)",
                         (submission, user_id, state, pr))
            conn.execute("INSERT INTO submission_files (submission_id, name, data) VALUES (?, 'piece.stl', x'00')",
                         (submission,))
        assert post(app, '/api/account', {'password': PASSWORD}, csrf=token, method='DELETE').status_code == 200
    states = {row['id']: (row['state'], row['owner_id'], row['author_name'])
              for row in conn.execute('SELECT id, state, owner_id, author_name FROM submissions')}
    assert states == {'s1': ('withdrawn', None, 'Ada'), 's2': ('merged', None, 'Ada'), 's3': ('withdrawn', None, 'Ada')}
    assert [deletion.pull_requests for deletion in cleaned] == [(42,)]
    # The upload Alex never looked at goes with the account; files already on GitHub stay for the bot.
    assert {row[0] for row in conn.execute('SELECT submission_id FROM submission_files')} == {'s1', 's2'}


def test_export_holds_projects_calibrations_and_receipts_but_no_password_hash(tmp_path, clock):
    with service(tmp_path, clock) as app:
        member(app, tmp_path)
        user_id = app.get('/api/auth/me').json()['user']['id']
        seed_member_data(database(tmp_path), user_id)
        exported = app.get('/api/account/export')
    assert exported.status_code == 200
    assert exported.headers['content-type'] == 'application/zip'
    archive = ZipFile(BytesIO(exported.content))
    names = set(archive.namelist())
    assert {'account.json', 'projects/p1/revisions/1-r1.json', 'calibrations.json', 'receipts/pkg1.json',
            'downloads.json'} <= names
    assert json.loads(archive.read('downloads.json')) == [{'packageId': 'pkg1', 'kind': 'zip', 'at': 5}]
    account = json.loads(archive.read('account.json'))
    assert account['email'] == 'ada@example.com' and account['displayName'] == 'Ada'
    assert json.loads(archive.read('projects/p1/revisions/1-r1.json')) == {'name': 'Loop'}
    assert [row['id'] for row in json.loads(archive.read('calibrations.json'))] == ['c1']
    contents = b''.join(archive.read(name) for name in names)
    assert b'argon2' not in contents and b'password' not in contents.lower()


def test_unverified_accounts_are_purged_after_seven_days(tmp_path, clock):
    with service(tmp_path, clock) as app:
        signup(app)
        clock.advance(7 * DAY + 1)
        assert login(app).status_code == 401
        assert signup(app).status_code == 202
    assert [bool(link_token(mail, 'verify')) for mail in mails(tmp_path)] == [True, True]


def test_security_log_rows_are_kept_for_90_days(tmp_path, clock):
    with service(tmp_path, clock) as app:
        member(app, tmp_path)
        conn = database(tmp_path)
        now = int(clock.now)
        ages = {'kept': 90 * DAY - 1, 'day': 90 * DAY, 'older': 90 * DAY + 1, 'oldest': 400 * DAY}
        for kind, age in ages.items():
            conn.execute('INSERT INTO audit_events (at, kind, detail) VALUES (?, ?, ?)',
                         (now - age, 'account_deleted', json.dumps({'case': kind})))
        app.cookies.clear()
        assert login(app).status_code == 200  # any sign-in sweeps, as for unverified accounts
    kept = [row[0] for row in conn.execute("SELECT json_extract(detail, '$.case') FROM audit_events "
                                           "WHERE kind = 'account_deleted'")]
    assert kept == ['kept']
    assert conn.execute("SELECT count(*) FROM audit_events WHERE kind = 'login'").fetchone()[0] == 2


def test_an_unverified_member_is_told_when_the_account_will_be_purged(tmp_path, clock):
    with service(tmp_path, clock) as app:
        signup(app)
        clock.advance(HOUR)  # the date counts from sign-up, not from this session
        signed = login(app).json()
        assert signed['user']['verified'] is False
        assert signed['user']['purgeAt'] == '2030-03-24T17:46:40Z'  # sign-up (1_900_000_000) plus 7 days
        verified = post(app, '/api/auth/verify-email', {'token': latest_token(tmp_path, 'ada@example.com', 'verify')},
                        csrf=signed['csrf'])
        assert verified.json()['user']['purgeAt'] is None
        assert app.get('/api/auth/me').json()['user']['purgeAt'] is None


def test_logs_carry_no_password_cookie_or_token(tmp_path, clock, caplog):
    caplog.set_level(logging.DEBUG)
    with service(tmp_path, clock) as app:
        token = member(app, tmp_path)
        secrets = {PASSWORD, 'a brand new secret', 'wrong password!', token, app.cookies[COOKIE],
                   latest_token(tmp_path, 'ada@example.com', 'verify')}
        app.cookies.clear()
        login(app, password='wrong password!')
        post(app, '/api/auth/password/forgot', {'email': 'ada@example.com'})
        reset = latest_token(tmp_path, 'ada@example.com', 'reset')
        secrets.add(reset)
        post(app, '/api/auth/password/reset', {'token': reset, 'password': 'a brand new secret'})
        secrets.update({app.cookies[COOKIE], csrf(app)})
        post(app, '/api/auth/logout', csrf=csrf(app))
    logged = caplog.text + '\n'.join(repr(record.__dict__) for record in caplog.records)
    assert caplog.records
    assert not [secret for secret in secrets if secret in logged]


def test_local_member_session_is_development_only(tmp_path, clock):
    with pytest.raises(ValueError):
        create_app(tmp_path / 'hosted', expected_host='plateway.example', allowed_origin='https://plateway.example',
                   local_member=True)
    with service(tmp_path, clock, local_member=True) as app:
        token = app.get('/api/session').json()['token']
        assert app.get('/api/auth/me').json()['user']['verified'] is True
        assert post(app, '/api/projects', project(), csrf=token).status_code == 201
        assert app.get('/api/session').json()['token'] == token


class _CloudflareEmail(BaseHTTPRequestHandler):
    received = []
    status = 200
    reply = {}

    def do_POST(self):
        body = self.rfile.read(int(self.headers['Content-Length']))
        type(self).received.append((self.path, self.headers['Authorization'], self.headers['Content-Type'],
                                    json.loads(body)))
        self.send_response(type(self).status)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(json.dumps(type(self).reply).encode())

    def log_message(self, *args):
        pass


@pytest.fixture
def cloudflare_email():
    _CloudflareEmail.received = []
    server = HTTPServer(('127.0.0.1', 8897), _CloudflareEmail)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield _CloudflareEmail
    finally:
        server.shutdown()
        server.server_close()


CF_TOKEN = 'cf-token-secret-1234'
VERIFY = Message('ada@example.com', 'Verify your Plateway email', 'Open the link: https://x/#verify=secret-link')


def _cloudflare_mailer():
    return CloudflareEmail(api_token=CF_TOKEN, account_id='acct-1', sender='accounts@mail.plateway.example',
                           api_base='http://127.0.0.1:8897/client/v4')


def _sent(delivered=(), queued=(), permanent_bounces=()):
    return {'success': True, 'errors': [], 'messages': [],
            'result': {'delivered': list(delivered), 'queued': list(queued),
                       'permanent_bounces': list(permanent_bounces)}}


def test_cloudflare_mailer_posts_the_message_to_the_email_sending_api(cloudflare_email):
    cloudflare_email.status, cloudflare_email.reply = 200, _sent(delivered=['ada@example.com'])
    _cloudflare_mailer().send(VERIFY)
    path, auth, content_type, body = cloudflare_email.received[-1]
    assert path == '/client/v4/accounts/acct-1/email/sending/send'
    assert auth == f'Bearer {CF_TOKEN}'
    assert content_type == 'application/json'
    assert body == {'to': 'ada@example.com', 'from': {'address': 'accounts@mail.plateway.example', 'name': 'Plateway'},
                    'subject': VERIFY.subject, 'text': VERIFY.text}


def test_cloudflare_mailer_sets_reply_to_only_when_the_message_has_one(cloudflare_email):
    cloudflare_email.status, cloudflare_email.reply = 200, _sent(delivered=['ada@example.com'])
    _cloudflare_mailer().send(Message('ada@example.com', 'Plateway feedback', 'Text', reply_to='tester@example.org'))
    assert cloudflare_email.received[-1][3]['reply_to'] == 'tester@example.org'


def test_cloudflare_mailer_accepts_a_queued_message(cloudflare_email):
    cloudflare_email.status, cloudflare_email.reply = 200, _sent(queued=['ada@example.com'])
    _cloudflare_mailer().send(VERIFY)
    assert len(cloudflare_email.received) == 1


@pytest.mark.parametrize('status, reply, reason', [
    (200, _sent(permanent_bounces=['ada@example.com']), 'bounce'),
    (200, _sent(delivered=['someone-else@example.com']), 'not accepted'),
    (200, {'success': False, 'errors': [{'code': 10001, 'message': 'email.sending.error.invalid_request_schema'}],
           'result': None}, '10001'),
    (403, {'success': False, 'errors': [{'code': 10102, 'message': 'email.sending.error.forbidden'}],
           'result': None}, '10102'),
    (429, {'success': False, 'errors': [{'code': 10004, 'message': 'email.sending.error.throttled'}],
           'result': None}, '10004'),
    (500, {}, '500'),
])
def test_cloudflare_mailer_fails_loudly_without_leaking_the_token_or_the_message(cloudflare_email, status, reply,
                                                                                  reason):
    cloudflare_email.status, cloudflare_email.reply = status, reply
    with pytest.raises(MailError) as raised:
        _cloudflare_mailer().send(VERIFY)
    error = str(raised.value)
    assert reason in error
    assert CF_TOKEN not in error and 'secret-link' not in error


def test_cloudflare_mailer_fails_loudly_when_the_api_is_unreachable():
    mailer = CloudflareEmail(api_token=CF_TOKEN, account_id='acct-1', sender='accounts@mail.plateway.example',
                             api_base='http://127.0.0.1:8898/client/v4')
    with pytest.raises(MailError) as raised:
        mailer.send(VERIFY)
    assert CF_TOKEN not in str(raised.value)


def test_mailer_from_env_needs_every_cloudflare_variable(tmp_path):
    full = {'PLATEWAY_MAILER': 'cloudflare', 'CLOUDFLARE_EMAIL_TOKEN': CF_TOKEN, 'CLOUDFLARE_ACCOUNT_ID': 'acct-1',
            'PLATEWAY_MAIL_FROM': 'accounts@mail.plateway.example'}
    for name in ('CLOUDFLARE_EMAIL_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'PLATEWAY_MAIL_FROM'):
        with pytest.raises(ValueError, match=name):
            from_env({key: value for key, value in full.items() if key != name}, default_directory=tmp_path)
    mailer = from_env({**full, 'PLATEWAY_MAIL_FROM_NAME': 'Plateway Accounts'}, default_directory=None)
    assert isinstance(mailer, CloudflareEmail)
    assert (mailer.sender, mailer.sender_name) == ('accounts@mail.plateway.example', 'Plateway Accounts')
    assert mailer.url == 'https://api.cloudflare.com/client/v4/accounts/acct-1/email/sending/send'
    assert isinstance(from_env({}, default_directory=tmp_path), FileSink)
