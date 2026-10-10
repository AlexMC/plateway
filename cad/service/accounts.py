"""Member accounts (KTD3): passwords, sessions, email tokens, display names, export and deletion.

Brute-force controls (ASVS 6.1.1, 6.3.1), counted in `audit_events` over a sliding hour:
- failed sign-ins: 10 per account and client IP pair, 30 per client IP. An attacker elsewhere cannot lock a member
  out: the pair limit binds only the attacker's IP, and the member's own IP keeps its budget;
- sign-ups and reset requests: 5 per client IP; reset emails: 3 per account (extra requests send nothing);
- verification resends: 3 per account.
Failed re-authentication (password change, email change, deletion) counts as a failed sign-in.

Only sha256 hashes of session and email tokens are stored. A session's CSRF token is an HMAC keyed by the raw
session token, so it can be recomputed from the cookie but never from the database. Times are Unix seconds.
"""
from __future__ import annotations

from collections.abc import Callable
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timezone
import hashlib
import hmac
from io import BytesIO
import json
import logging
from pathlib import Path
import re
import secrets
import sqlite3
import time
import uuid
from zipfile import ZIP_DEFLATED, ZipFile

from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError

from cad.service import db
from cad.service.mailer import MailError, Mailer, Message

log = logging.getLogger('cad.service.accounts')

HOUR = 3600
DAY = 24 * HOUR
VERIFY_TTL = DAY
RESET_TTL = HOUR
EMAIL_CHANGE_TTL = DAY
SESSION_TTL = 30 * DAY
SESSION_IDLE = 7 * DAY
SEEN_EVERY = 5 * 60
UNVERIFIED_TTL = 7 * DAY
# The privacy policy's retention of security logs: every `audit_events` row, sign-ins included.
AUDIT_TTL = 90 * DAY

FAILED_SIGN_INS_PER_PAIR = 10
FAILED_SIGN_INS_PER_IP = 30
SIGN_UPS_PER_IP = 5
RESET_REQUESTS_PER_IP = 5
RESET_EMAILS_PER_ACCOUNT = 3
RESENDS_PER_ACCOUNT = 3

PASSWORD_MIN, PASSWORD_MAX = 8, 128
EMAIL_MAX = 254
DISPLAY_NAME = re.compile(r"[^\W_][\w .'-]{1,28}[^\W_]")
EMAIL = re.compile(r'[^@\s]+@[^@\s.]+(?:\.[^@\s.]+)+')

TOO_MANY = 'Too many attempts. Try again later.'
BAD_LINK = 'This link has expired or was already used.'
WRONG_SIGN_IN = 'Email or password is wrong.'
WRONG_PASSWORD = 'That password is wrong.'
NAME_TAKEN = 'That display name is taken.'

# OWASP's argon2id minimum: 19 MiB, 2 iterations, 1 lane.
HASHER = PasswordHasher(time_cost=2, memory_cost=19456, parallelism=1)
COMMON_PASSWORDS = frozenset(
    line for line in (Path(__file__).with_name('common-passwords.txt').read_text(encoding='utf-8').splitlines())
    if line and not line.startswith('#'))
LOCAL_MEMBER_EMAIL = 'local@plateway.invalid'


class AccountError(Exception):
    def __init__(self, status: int, detail: str):
        super().__init__(detail)
        self.status = status
        self.detail = detail


@dataclass(frozen=True)
class Member:
    id: str
    email: str
    display_name: str
    verified: bool
    created_at: int

    def public(self) -> dict:
        """`purgeAt`: when an unverified account and its projects are deleted (UTC, ISO 8601); null once verified."""
        purge_at = None if self.verified else datetime.fromtimestamp(
            self.created_at + UNVERIFIED_TTL, timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
        return {'id': self.id, 'email': self.email, 'displayName': self.display_name, 'verified': self.verified,
                'purgeAt': purge_at}


@dataclass(frozen=True)
class Session:
    member: Member
    token_hash: str
    csrf: str


@dataclass(frozen=True)
class SignedIn:
    """A new session; `token` is the raw cookie value and is never stored."""
    token: str
    session: Session


@dataclass(frozen=True)
class Deletion:
    """What an account deletion leaves for other services: object-store prefixes to purge and pull requests to close."""
    user_id: str
    storage_prefixes: tuple[str, ...]
    pull_requests: tuple[int, ...]


def token_hash(raw: str) -> str:
    return hashlib.sha256(raw.encode()).hexdigest()


def csrf_token(raw_session: str) -> str:
    return hmac.new(raw_session.encode(), b'plateway-csrf', hashlib.sha256).hexdigest()


def _account_key(email: str) -> str:
    """The throttle key for an address, whether or not it has an account; never the address itself."""
    return hashlib.sha256(b'account:' + email.strip().lower().encode()).hexdigest()


def _email(value: object) -> str:
    if not isinstance(value, str) or len(value.strip()) > EMAIL_MAX or not EMAIL.fullmatch(value.strip()):
        raise AccountError(422, 'Enter a valid email address.')
    return value.strip()


def _password(value: object) -> str:
    """Taken exactly as typed: no trimming, no case folding, no composition rules (ASVS 6.2.5, 6.2.8)."""
    if not isinstance(value, str) or not PASSWORD_MIN <= len(value) <= PASSWORD_MAX:
        raise AccountError(422, f'Use a password of {PASSWORD_MIN} to {PASSWORD_MAX} characters.')
    if value.lower() in COMMON_PASSWORDS:
        raise AccountError(422, 'That password is too common. Choose another.')
    return value


def display_name(value: object) -> str:
    """3–30 characters: letters, digits, spaces and . ' - _, starting and ending with a letter or digit."""
    if not isinstance(value, str) or not DISPLAY_NAME.fullmatch(value.strip()):
        raise AccountError(422, 'Use a display name of 3 to 30 letters, digits, spaces, dots, dashes or underscores.')
    return value.strip()


def _matches(password_hash: str | None, password: str) -> bool:
    """Verify against the stored hash, or a dummy one so an unknown address takes as long as a known one."""
    try:
        return HASHER.verify(password_hash or _dummy_hash(), password) and password_hash is not None
    except (VerificationError, InvalidHashError):
        return False


_DUMMY: list[str] = []


def _dummy_hash() -> str:
    if not _DUMMY:
        _DUMMY.append(HASHER.hash(secrets.token_urlsafe(16)))
    return _DUMMY[0]


def _member(row: sqlite3.Row) -> Member:
    return Member(row['id'], row['email'], row['display_name'], row['email_verified_at'] is not None, row['created_at'])


class Accounts:
    def __init__(self, database: Path, mailer: Mailer, public_origin: str, clock: Callable[[], float] = time.time):
        self.database = database
        self.mailer = mailer
        self.origin = public_origin.rstrip('/')
        self.clock = clock

    def now(self) -> int:
        return int(self.clock())

    @contextmanager
    def _connect(self):
        conn = db.connect(self.database)
        try:
            yield conn
        finally:
            conn.close()

    def _link(self, kind: str, raw: str) -> str:
        # In the fragment, so the token never reaches a server log or a Referer header (ASVS 14.2.1).
        return f'{self.origin}/app/#{kind}={raw}'

    def _send(self, messages: list[Message]) -> None:
        for message in messages:
            try:
                self.mailer.send(message)
            except (MailError, OSError) as exc:
                log.error('Account mail "%s" was not sent: %s', message.subject, exc)

    # Throttling and audit trail.

    @staticmethod
    def _record(conn, kind: str, now: int, *, user_id: str | None = None, ip: str | None = None,
                detail: dict | None = None) -> None:
        conn.execute('INSERT INTO audit_events (at, kind, user_id, client_ip, detail) VALUES (?, ?, ?, ?, ?)',
                     (now, kind, user_id, ip, json.dumps(detail) if detail is not None else None))

    @staticmethod
    def _count(conn, kind: str, now: int, *, ip: str | None = None, user_id: str | None = None,
               account: str | None = None) -> int:
        query, values = 'SELECT count(*) FROM audit_events WHERE kind = ? AND at > ?', [kind, now - HOUR]
        if ip is not None:
            query, values = query + ' AND client_ip = ?', [*values, ip]
        if user_id is not None:
            query, values = query + ' AND user_id = ?', [*values, user_id]
        if account is not None:
            query, values = query + " AND json_extract(detail, '$.account') = ?", [*values, account]
        return conn.execute(query, values).fetchone()[0]

    def _check_password(self, conn, email: str, password: object, ip: str, now: int) -> sqlite3.Row | None:
        """The account row when the password is right; else records a failed sign-in. Refuses throttled attempts.
        Runs inside the caller's write transaction, so concurrent guesses cannot overshoot the limits."""
        account = _account_key(email)
        if (self._count(conn, 'login_failed', now, ip=ip, account=account) >= FAILED_SIGN_INS_PER_PAIR or
                self._count(conn, 'login_failed', now, ip=ip) >= FAILED_SIGN_INS_PER_IP):
            raise AccountError(429, TOO_MANY)
        row = conn.execute('SELECT * FROM users WHERE email = ?', (email,)).fetchone()
        if isinstance(password, str) and _matches(row['password_hash'] if row else None, password):
            if HASHER.check_needs_rehash(row['password_hash']):
                conn.execute('UPDATE users SET password_hash = ? WHERE id = ?', (HASHER.hash(password), row['id']))
            return row
        self._record(conn, 'login_failed', now, user_id=row['id'] if row else None, ip=ip, detail={'account': account})
        return None

    # Sessions.

    def _open_session(self, conn, row: sqlite3.Row, now: int) -> SignedIn:
        raw = secrets.token_urlsafe(32)
        hashed = token_hash(raw)
        conn.execute('INSERT INTO sessions (token_hash, user_id, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?)',
                     (hashed, row['id'], now, now, now + SESSION_TTL))
        return SignedIn(raw, Session(_member(row), hashed, csrf_token(raw)))

    def session(self, raw: str) -> Session | None:
        """The live session for a cookie value, or None when it is unknown, expired or idle too long."""
        now, hashed = self.now(), token_hash(raw)
        with self._connect() as conn:
            row = conn.execute('SELECT s.last_seen_at, u.* FROM sessions s JOIN users u ON u.id = s.user_id '
                               'WHERE s.token_hash = ? AND s.expires_at > ? AND s.last_seen_at > ?',
                               (hashed, now, now - SESSION_IDLE)).fetchone()
            if row is None:
                return None
            if row['last_seen_at'] < now - SEEN_EVERY:
                conn.execute('UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?', (now, hashed))
        return Session(_member(row), hashed, csrf_token(raw))

    def logout(self, session: Session) -> None:
        with self._connect() as conn:
            conn.execute('DELETE FROM sessions WHERE token_hash = ?', (session.token_hash,))

    # Email tokens.

    def _issue(self, conn, user_id: str, purpose: str, ttl: int, now: int, new_email: str | None = None) -> str:
        raw = secrets.token_urlsafe(32)
        conn.execute('INSERT INTO email_tokens (token_hash, user_id, purpose, new_email, created_at, expires_at) '
                     'VALUES (?, ?, ?, ?, ?, ?)', (token_hash(raw), user_id, purpose, new_email, now, now + ttl))
        return raw

    @staticmethod
    def _void(conn, user_id: str, now: int, *purposes: str) -> None:
        marks = ', '.join('?' for _ in purposes)
        conn.execute(f'UPDATE email_tokens SET used_at = ? WHERE user_id = ? AND used_at IS NULL AND purpose IN ({marks})',
                     (now, user_id, *purposes))

    @staticmethod
    def _consume(conn, raw: object, purpose: str, now: int) -> sqlite3.Row:
        """Use a token once; an unknown, expired, used or other-purpose token is refused."""
        if not isinstance(raw, str) or not raw or len(raw) > 128:
            raise AccountError(400, BAD_LINK)
        hashed = token_hash(raw)
        row = conn.execute('SELECT * FROM email_tokens WHERE token_hash = ? AND purpose = ? AND used_at IS NULL '
                           'AND expires_at > ?', (hashed, purpose, now)).fetchone()
        if row is None:
            raise AccountError(400, BAD_LINK)
        conn.execute('UPDATE email_tokens SET used_at = ? WHERE token_hash = ?', (now, hashed))
        return row

    # Flows.

    def signup(self, email: object, password: object, name: object, ip: str) -> None:
        """The same reply for new and existing addresses; an existing one gets an "already registered" email."""
        email, password, name = _email(email), _password(password), display_name(name)
        now = self.now()
        with self._connect() as conn:
            with db.transaction(conn):
                if self._count(conn, 'signup', now, ip=ip) >= SIGN_UPS_PER_IP:
                    raise AccountError(429, TOO_MANY)
                self._record(conn, 'signup', now, ip=ip)
            # Hashed after the throttle, so refused requests cost nothing, and for every allowed one, so a known
            # address answers as slowly as a new one.
            password_hash = HASHER.hash(password)
            with db.transaction(conn):
                self._purge(conn, now)
                # Checked before the address, so the reply to a free name never depends on whether the email exists.
                if conn.execute('SELECT 1 FROM users WHERE display_name = ?', (name,)).fetchone():
                    raise AccountError(409, NAME_TAKEN)
                existing = conn.execute('SELECT email FROM users WHERE email = ?', (email,)).fetchone()
                if existing:
                    message = Message(existing['email'], 'Your Plateway account',
                                      'Someone tried to create a Plateway account with this address, which already '
                                      f'has one. Sign in, or reset your password from the sign-in page: {self.origin}/app/\n\n'
                                      'If it was not you, you can ignore this email.')
                else:
                    user_id = str(uuid.uuid4())
                    conn.execute('INSERT INTO users (id, email, password_hash, display_name, created_at) '
                                 'VALUES (?, ?, ?, ?, ?)', (user_id, email, password_hash, name, now))
                    raw = self._issue(conn, user_id, 'verify', VERIFY_TTL, now)
                    message = self._verify_message(email, raw)
        self._send([message])

    def _verify_message(self, email: str, raw: str) -> Message:
        return Message(email, 'Verify your Plateway email',
                       f'Open this link within 24 hours to verify your email:\n\n{self._link("verify", raw)}\n\n'
                       'If you did not sign up for Plateway, you can ignore this email.')

    def verify_email(self, raw: object) -> Member:
        """Marks the address verified; opens no session, so a link never signs a browser in (login CSRF)."""
        now = self.now()
        with self._connect() as conn, db.transaction(conn):
            token = self._consume(conn, raw, 'verify', now)
            self._void(conn, token['user_id'], now, 'verify')
            conn.execute('UPDATE users SET email_verified_at = coalesce(email_verified_at, ?) WHERE id = ?',
                         (now, token['user_id']))
            return _member(conn.execute('SELECT * FROM users WHERE id = ?', (token['user_id'],)).fetchone())

    def resend_verification(self, session: Session) -> None:
        now, member = self.now(), session.member
        with self._connect() as conn, db.transaction(conn):
            row = conn.execute('SELECT * FROM users WHERE id = ?', (member.id,)).fetchone()
            if row['email_verified_at'] is not None:
                raise AccountError(409, 'Your email is already verified.')
            if self._count(conn, 'verification_resent', now, user_id=member.id) >= RESENDS_PER_ACCOUNT:
                raise AccountError(429, TOO_MANY)
            self._record(conn, 'verification_resent', now, user_id=member.id)
            self._void(conn, member.id, now, 'verify')
            raw = self._issue(conn, member.id, 'verify', VERIFY_TTL, now)
        self._send([self._verify_message(row['email'], raw)])

    def login(self, email: object, password: object, ip: str) -> SignedIn:
        if not isinstance(email, str) or not isinstance(password, str) or len(email) > EMAIL_MAX or len(password) > PASSWORD_MAX:
            raise AccountError(401, WRONG_SIGN_IN)
        now = self.now()
        with self._connect() as conn:
            with db.transaction(conn):
                self._purge(conn, now)
                row = self._check_password(conn, email.strip(), password, ip, now)
            if row is None:
                raise AccountError(401, WRONG_SIGN_IN)
            with db.transaction(conn):
                self._record(conn, 'login', now, user_id=row['id'], ip=ip)
                signed_in = self._open_session(conn, row, now)
        log.info('Member %s signed in', row['id'])
        return signed_in

    def forgot_password(self, email: object, ip: str) -> None:
        """The same reply whether or not the address has an account; unknown addresses get no email."""
        now = self.now()
        with self._connect() as conn:
            with db.transaction(conn):
                if self._count(conn, 'reset_requested', now, ip=ip) >= RESET_REQUESTS_PER_IP:
                    raise AccountError(429, TOO_MANY)
                self._record(conn, 'reset_requested', now, ip=ip)
            if not isinstance(email, str) or len(email) > EMAIL_MAX:
                return
            with db.transaction(conn):
                row = conn.execute('SELECT * FROM users WHERE email = ?', (email.strip(),)).fetchone()
                if row is None or self._count(conn, 'reset_sent', now, user_id=row['id']) >= RESET_EMAILS_PER_ACCOUNT:
                    return
                self._record(conn, 'reset_sent', now, user_id=row['id'], ip=ip)
                raw = self._issue(conn, row['id'], 'reset', RESET_TTL, now)
        self._send([Message(row['email'], 'Reset your Plateway password',
                            f'Open this link within an hour to choose a new password:\n\n{self._link("reset", raw)}\n\n'
                            'Resetting signs you out everywhere. If you did not ask for this, ignore this email.')])

    def reset_password(self, raw: object, password: object) -> SignedIn:
        """Single use; revokes every session of the account, then signs in fresh. It also proves the address."""
        password = _password(password)
        now = self.now()
        with self._connect() as conn, db.transaction(conn):
            token = self._consume(conn, raw, 'reset', now)
            # Hashed only for a live link, so junk tokens cost no argon2 work.
            password_hash = HASHER.hash(password)
            user_id = token['user_id']
            self._void(conn, user_id, now, 'reset', 'change_email')
            conn.execute('DELETE FROM sessions WHERE user_id = ?', (user_id,))
            conn.execute('UPDATE users SET password_hash = ?, email_verified_at = coalesce(email_verified_at, ?) WHERE id = ?',
                         (password_hash, now, user_id))
            self._record(conn, 'password_reset', now, user_id=user_id)
            row = conn.execute('SELECT * FROM users WHERE id = ?', (user_id,)).fetchone()
            return self._open_session(conn, row, now)

    def _reauthenticate(self, conn, session: Session, password: object, ip: str, now: int) -> sqlite3.Row:
        """Check the current password in its own transaction, so a failure is recorded even though the request fails."""
        with db.transaction(conn):
            row = self._check_password(conn, session.member.email, password, ip, now)
        if row is None or row['id'] != session.member.id:
            raise AccountError(403, WRONG_PASSWORD)
        return row

    def change_password(self, session: Session, current: object, password: object, ip: str) -> None:
        """Keeps this session and signs out every other one."""
        password_hash = HASHER.hash(_password(password))
        now = self.now()
        with self._connect() as conn:
            self._reauthenticate(conn, session, current, ip, now)
            with db.transaction(conn):
                conn.execute('UPDATE users SET password_hash = ? WHERE id = ?', (password_hash, session.member.id))
                conn.execute('DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?',
                             (session.member.id, session.token_hash))
                self._void(conn, session.member.id, now, 'reset', 'change_email')
                self._record(conn, 'password_changed', now, user_id=session.member.id, ip=ip)

    def request_email_change(self, session: Session, password: object, new_email: object, ip: str) -> None:
        """Sends a confirmation link to the new address; the old one keeps working until the link is used."""
        now = self.now()
        with self._connect() as conn:
            row = self._reauthenticate(conn, session, password, ip, now)
            new_email = _email(new_email)
            with db.transaction(conn):
                self._void(conn, row['id'], now, 'change_email')
                if conn.execute('SELECT 1 FROM users WHERE email = ?', (new_email,)).fetchone():
                    message = Message(new_email, 'Your Plateway account',
                                      'Someone asked to move a Plateway account to this address, which already has an '
                                      'account. Nothing was changed.')
                else:
                    raw = self._issue(conn, row['id'], 'change_email', EMAIL_CHANGE_TTL, now, new_email)
                    message = Message(new_email, 'Confirm your new Plateway email',
                                      'Open this link within 24 hours to use this address for your Plateway account:\n\n'
                                      f'{self._link("confirm-email", raw)}\n\nUntil then your old address stays in use.')
                self._record(conn, 'email_change_requested', now, user_id=row['id'], ip=ip)
        self._send([message])

    def confirm_email_change(self, raw: object) -> Member:
        """Moves the account to the new address and voids every other outstanding email token."""
        now = self.now()
        with self._connect() as conn, db.transaction(conn):
            token = self._consume(conn, raw, 'change_email', now)
            row = conn.execute('SELECT * FROM users WHERE id = ?', (token['user_id'],)).fetchone()
            try:
                conn.execute('UPDATE users SET email = ?, email_verified_at = ? WHERE id = ?',
                             (token['new_email'], now, row['id']))
            except sqlite3.IntegrityError:
                raise AccountError(409, 'That address now belongs to another account.') from None
            self._void(conn, row['id'], now, 'verify', 'reset', 'change_email')
            self._record(conn, 'email_changed', now, user_id=row['id'])
            member = _member(conn.execute('SELECT * FROM users WHERE id = ?', (row['id'],)).fetchone())
        self._send([Message(row['email'], 'Your Plateway email was changed',
                            f'Your Plateway account now uses {member.email}. If you did not do this, reply to this '
                            'email at once.')])
        return member

    def rename(self, session: Session, name: object) -> Member:
        name = display_name(name)
        with self._connect() as conn, db.transaction(conn):
            try:
                conn.execute('UPDATE users SET display_name = ? WHERE id = ?', (name, session.member.id))
            except sqlite3.IntegrityError:
                raise AccountError(409, NAME_TAKEN) from None
            return _member(conn.execute('SELECT * FROM users WHERE id = ?', (session.member.id,)).fetchone())

    def export(self, session: Session) -> bytes:
        """A ZIP of everything the member owns; package files are left out because they can be prepared again."""
        user_id = session.member.id
        with self._connect() as conn:
            conn.execute('BEGIN')  # one consistent snapshot
            try:
                user = conn.execute('SELECT * FROM users WHERE id = ?', (user_id,)).fetchone()
                projects = conn.execute('SELECT * FROM projects WHERE owner_id = ? ORDER BY created_at, id', (user_id,)).fetchall()
                revisions = conn.execute('SELECT * FROM revisions WHERE owner_id = ? ORDER BY project_id, number',
                                         (user_id,)).fetchall()
                calibrations = conn.execute('SELECT * FROM calibrations WHERE owner_id = ? ORDER BY recorded_at, id',
                                            (user_id,)).fetchall()
                receipts = conn.execute('SELECT * FROM receipts WHERE owner_id = ? ORDER BY created_at, package_id',
                                        (user_id,)).fetchall()
                submissions = conn.execute('SELECT id, kind, state, author_name, licence, metadata, file_digest, reason, '
                                           'pr_number, attested_at, created_at, reviewed_at, updated_at FROM submissions '
                                           'WHERE owner_id = ? ORDER BY created_at, id', (user_id,)).fetchall()
                gallery = conn.execute('SELECT id, title, description, body, author_name, licence, ancestors, '
                                       'published_at, hidden_at FROM gallery_layouts WHERE owner_id = ? '
                                       'ORDER BY published_at, id', (user_id,)).fetchall()
                downloads = conn.execute('SELECT package_id, kind, at FROM package_downloads WHERE owner_id = ? '
                                         'ORDER BY at, id', (user_id,)).fetchall()
            finally:
                conn.execute('COMMIT')
        archive = BytesIO()
        dump = lambda value: json.dumps(value, indent=2, ensure_ascii=False)
        with ZipFile(archive, 'w', ZIP_DEFLATED) as target:
            target.writestr('account.json', dump({
                'id': user['id'], 'email': user['email'], 'displayName': user['display_name'],
                'emailVerifiedAt': user['email_verified_at'], 'createdAt': user['created_at'],
                'timesAre': 'Unix seconds'}))
            for project in projects:
                target.writestr(f'projects/{project["id"]}/project.json', dump({
                    'id': project['id'], 'name': project['name'], 'createdAt': project['created_at'],
                    'updatedAt': project['updated_at']}))
            for revision in revisions:
                target.writestr(f'projects/{revision["project_id"]}/revisions/{revision["number"]}-{revision["id"]}.json',
                                revision['body'])
            target.writestr('calibrations.json', dump([{
                'id': row['id'], 'settingsKey': row['settings_key'], 'trackSystem': row['track_system'],
                'result': row['result'], 'receiptId': row['receipt_id'], 'receiptDigest': row['receipt_digest'],
                'record': json.loads(row['record']), 'recordedAt': row['recorded_at']} for row in calibrations]))
            for receipt in receipts:
                target.writestr(f'receipts/{receipt["package_id"]}.json', receipt['body'])
            target.writestr('downloads.json', dump([{'packageId': row['package_id'], 'kind': row['kind'], 'at': row['at']}
                                                    for row in downloads]))
            target.writestr('contributions.json', dump({
                'submissions': [{**dict(row), 'metadata': json.loads(row['metadata'])} for row in submissions],
                'gallery': [{**dict(row), 'body': json.loads(row['body']), 'ancestors': json.loads(row['ancestors'])}
                            for row in gallery]}))
        return archive.getvalue()

    def delete(self, session: Session, password: object, ip: str) -> Deletion:
        now = self.now()
        with self._connect() as conn:
            row = self._reauthenticate(conn, session, password, ip, now)
            with db.transaction(conn):
                deletion = self._delete(conn, row['id'], now)
        self._send([Message(row['email'], 'Your Plateway account was deleted',
                            'Your Plateway account and its projects, calibration results and gallery layouts are '
                            'deleted. Library items already merged stay public under the CC BY licence with your '
                            'display name as it was.')])
        log.info('Member %s deleted their account', row['id'])
        return deletion

    @staticmethod
    def _delete(conn, user_id: str, now: int) -> Deletion:
        """Cancel the member's jobs, withdraw unmerged submissions, then delete the account; personal data cascades.
        Merged library items, queue history and audit rows outlive it with the owner cleared."""
        prefixes = tuple(row[0] for row in conn.execute(
            'SELECT storage_prefix FROM receipts WHERE owner_id = ? ORDER BY package_id', (user_id,)))
        pull_requests = tuple(row[0] for row in conn.execute(
            "SELECT pr_number FROM submissions WHERE owner_id = ? AND state = 'pr_open' AND pr_number IS NOT NULL "
            'ORDER BY pr_number', (user_id,)))
        conn.execute("UPDATE jobs SET state = 'cancelled', cancel_requested_at = ?, finished_at = ? "
                     "WHERE owner_id = ? AND state IN ('queued', 'interrupted')", (now, now, user_id))
        # A running job is stopped by its worker, which watches `cancel_requested_at`.
        conn.execute("UPDATE jobs SET cancel_requested_at = ? WHERE owner_id = ? AND state = 'running'", (now, user_id))
        # Unpublished uploads go with the account; a pull request's files are already public (U16 closes it).
        conn.execute("DELETE FROM submission_files WHERE submission_id IN (SELECT id FROM submissions "
                     "WHERE owner_id = ? AND state IN ('awaiting_look', 'approved'))", (user_id,))
        conn.execute("UPDATE submissions SET state = 'withdrawn', updated_at = ? "
                     "WHERE owner_id = ? AND state IN ('awaiting_look', 'approved', 'pr_open')", (now, user_id))
        conn.execute('DELETE FROM users WHERE id = ?', (user_id,))
        # Durable record of the outside clean-up still owed (objects, pull requests), with no personal data.
        Accounts._record(conn, 'account_deleted', now, detail={'storagePrefixes': list(prefixes),
                                                               'pullRequests': list(pull_requests)})
        return Deletion(user_id, prefixes, pull_requests)

    def _purge(self, conn, now: int) -> list[Deletion]:
        """Drop accounts left unverified for 7 days, expired sessions and email tokens, and audit rows over 90 days old
        (the throttles look back a day at most)."""
        stale = [row[0] for row in conn.execute(
            'SELECT id FROM users WHERE email_verified_at IS NULL AND created_at <= ? AND email <> ?',
            (now - UNVERIFIED_TTL, LOCAL_MEMBER_EMAIL))]
        deletions = [self._delete(conn, user_id, now) for user_id in stale]
        conn.execute('DELETE FROM sessions WHERE expires_at <= ? OR last_seen_at <= ?', (now, now - SESSION_IDLE))
        conn.execute('DELETE FROM email_tokens WHERE expires_at <= ?', (now - DAY,))
        conn.execute('DELETE FROM audit_events WHERE at <= ?', (now - AUDIT_TTL,))
        return deletions

    def purge(self) -> list[Deletion]:
        with self._connect() as conn, db.transaction(conn):
            return self._purge(conn, self.now())

    def local_member(self) -> SignedIn:
        """Development only: a session for the one verified local member, created on first use; it has no usable password."""
        now = self.now()
        with self._connect() as conn, db.transaction(conn):
            row = conn.execute('SELECT * FROM users WHERE email = ?', (LOCAL_MEMBER_EMAIL,)).fetchone()
            if row is None:
                conn.execute('INSERT INTO users (id, email, password_hash, display_name, email_verified_at, created_at) '
                             'VALUES (?, ?, ?, ?, ?, ?)', (str(uuid.uuid4()), LOCAL_MEMBER_EMAIL,
                                                           HASHER.hash(secrets.token_urlsafe(32)), 'Local workshop', now, now))
                row = conn.execute('SELECT * FROM users WHERE email = ?', (LOCAL_MEMBER_EMAIL,)).fetchone()
            return self._open_session(conn, row, now)
