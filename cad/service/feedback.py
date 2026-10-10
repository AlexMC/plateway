"""Feedback from the app's and the site's feedback form (`POST /api/feedback`), for testers without a GitHub account.

Anyone may send it, signed in or not; a signed-in member's is linked to their account (a member's POST carries the CSRF
header as every other). Each one is stored and emailed to every admin, with reply-to set to the address the sender gave,
if any. The sender's IP is used only by the in-memory rate limit (`FEEDBACK_PER_HOUR`) and never stored. A filled
`website` field (a honeypot, hidden from people) is answered as sent and dropped. Feedback is deleted `RETENTION_DAYS`
after it was sent: on every send, when the service starts, and daily (`run`). The admin ops page lists it (`ops.py`).
"""
from __future__ import annotations

from collections.abc import Awaitable, Callable
from contextlib import closing
from dataclasses import dataclass
import logging
from pathlib import Path
import threading
import time

from fastapi import FastAPI, HTTPException, Request
from fastapi.concurrency import run_in_threadpool

from cad.service import db
from cad.service.accounts import EMAIL, EMAIL_MAX, Member
from cad.service.mailer import MailError, Mailer, Message
from cad.service.usage import RateLimit

log = logging.getLogger('cad.service.feedback')

MESSAGE_MIN, MESSAGE_MAX = 10, 4000
PAGE_MAX, VERSION_MAX = 200, 40
MAX_BODY_BYTES = 16 * 1024
FEEDBACK_PER_HOUR = 5
HOUR, DAY = 3600, 24 * 3600
RETENTION_DAYS = 365
SUBJECT_MAX = 60


class FeedbackError(ValueError):
    """Feedback the API refuses (422), with the reason to show the sender."""


@dataclass(frozen=True)
class Entry:
    message: str
    email: str | None
    page: str
    version: str


def _context(value: object, limit: int, name: str) -> str:
    """The page or version: one line, cut to `limit`; context is never a reason to refuse the feedback."""
    if value is None:
        return ''
    if not isinstance(value, str):
        raise FeedbackError(f'"{name}" must be text.')
    return ' '.join(value.split())[:limit]


def validate(body: dict) -> Entry | None:
    """The feedback to store, or None for a filled honeypot."""
    if body.get('website'):
        return None
    message = body.get('message')
    if not isinstance(message, str) or not MESSAGE_MIN <= len(message.strip()) <= MESSAGE_MAX:
        raise FeedbackError(f'Write {MESSAGE_MIN} to {MESSAGE_MAX:,} characters of feedback.')
    email = body.get('email')
    if email is not None and not isinstance(email, str):
        raise FeedbackError('Enter a valid email address, or leave it empty.')
    email = (email or '').strip() or None
    if email is not None and (len(email) > EMAIL_MAX or not EMAIL.fullmatch(email)):
        raise FeedbackError('Enter a valid email address, or leave it empty.')
    return Entry(message.strip(), email, _context(body.get('page'), PAGE_MAX, 'page'),
                 _context(body.get('version'), VERSION_MAX, 'version'))


class Feedback:
    def __init__(self, database: Path, mailer: Mailer, clock: Callable[[], float] = time.time,
                 public_origin: str = ''):
        self.database, self.mailer, self.clock = database, mailer, clock
        self.origin = public_origin.rstrip('/')

    def record(self, entry: Entry, member: Member | None) -> None:
        """Store `entry`, then email it to every admin; a failed email is logged, the feedback stays stored."""
        now = int(self.clock())
        with closing(db.connect(self.database)) as conn, db.transaction(conn):
            self._purge(conn, now)
            conn.execute('INSERT INTO feedback (created_at, member_id, email, message, page, version) '
                         'VALUES (?, ?, ?, ?, ?, ?)', (now, member.id if member else None, entry.email, entry.message,
                                                       entry.page, entry.version))
            admins = [row[0] for row in conn.execute('SELECT email FROM users WHERE is_admin = 1 ORDER BY email')]
        if not admins:
            log.warning('Feedback was sent, but no account is an admin to tell')
        first = entry.message.split('\n', 1)[0].strip()
        subject = f'Plateway feedback: {first[:SUBJECT_MAX]}{"…" if len(first) > SUBJECT_MAX else ""}'
        sender = f'{member.display_name} (signed in, {member.email})' if member else 'A visitor (not signed in)'
        text = (f'{entry.message}\n\n'
                f'From: {sender}\n'
                f'Reply to: {entry.email or "No email given"}\n'
                f'Page: {entry.page or "unknown"}\n'
                f'Version: {entry.version or "unknown"}\n\n'
                f'The latest feedback: {self.origin}/admin/ops#feedback')
        for address in admins:
            try:
                self.mailer.send(Message(address, subject, text, reply_to=entry.email))
            except (MailError, OSError) as exc:
                log.error('Feedback mail to an admin was not sent: %s', exc)

    def _purge(self, conn, now: int) -> int:
        return conn.execute('DELETE FROM feedback WHERE created_at < ?', (now - RETENTION_DAYS * DAY,)).rowcount

    def purge(self) -> int:
        """Delete feedback older than `RETENTION_DAYS`; returns how many."""
        with closing(db.connect(self.database)) as conn, db.transaction(conn):
            return self._purge(conn, int(self.clock()))

    def run(self, stop: threading.Event, every: float = DAY) -> None:
        """Purge every `every` seconds until `stop` is set (the service also purges once when it starts)."""
        while not stop.wait(every):
            try:
                self.purge()
            except Exception as exc:  # retried on the next run
                log.error('Purging old feedback failed', exc_info=exc)


def register(app: FastAPI, feedback: Feedback, *, read_body: Callable[[Request, int], Awaitable[dict]],
             client_ip: Callable[[Request], str], limit: RateLimit) -> None:
    """`POST /api/feedback`: `{"message", "email"?, "page"?, "version"?, "website"?}`. 202 once sent (or dropped as
    spam), 422 with the reason when refused, 429 after `FEEDBACK_PER_HOUR` sends from one IP within an hour."""

    @app.post('/api/feedback', status_code=202)
    async def send_feedback(request: Request):
        body = await read_body(request, MAX_BODY_BYTES)
        try:
            entry = validate(body)
        except FeedbackError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from None
        if entry is None:
            return {'status': 'sent'}
        if not limit.allow(client_ip(request)):
            raise HTTPException(status_code=429, detail='You sent a lot of feedback this hour. Try again later.')
        session = request.state.session
        await run_in_threadpool(feedback.record, entry, session.member if session is not None else None)
        return {'status': 'sent'}
