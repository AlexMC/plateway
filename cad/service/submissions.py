"""Community contributions (R17, R18, R20, KTD10): pieces, trains and furniture uploaded by verified members, the
automatic check (`cad/library/check.py`), Alex's quick look and the contributor's view of each outcome.

An upload carries the contributor's rights attestation and its licence: CC BY 4.0, or for a train model adapted from
another CC BY model that model's licence with its source and authors (R17); a piece adapted from a CC BY model stays CC
BY 4.0 and names its source and authors the same way. The check runs during the upload request; an upload that fails it
is refused with the reason and never stored. One that passes is stored `awaiting_look` with its file, under the
contributor's display name, and every admin gets an email. Each member may upload `DAILY_UPLOADS` a day. Since every
attempt pays for the check, attempts (refused ones included) are capped too: `HOURLY_ATTEMPTS` an hour and
`DAILY_ATTEMPTS` a day, counted as `upload_attempt` rows in `audit_events`. Admins are trusted: no cap applies to them.

Only admins reach the quick look (anyone else gets 404). Rejecting needs a short reason, which the contributor sees next
to "Rejected"; the file is deleted and nothing reaches GitHub. Approving moves the submission to `approved`.

Hand-off to the GitHub bot (`github_app.py`): `Submissions.awaiting_pull_request()` lists approved submissions that
have no pull request yet, each with its metadata and file. The bot commits them, records `pr_number` and moves the
submission to `pr_open`; merges and closes move it on (`merged`, `closed`). `closed` shows to the contributor as
rejected, with the closing comment as its reason. Rejecting a `pr_open` upload stores Alex's reason, and the bot closes
its pull request with it. Approving and rejecting call `changed()`, which wakes the bot. Once a merged upload is
published (`library_publish.py`) the contributor sees its library item's state instead: `live`, `retired` or
`removed`.
"""
from __future__ import annotations

import base64
import binascii
from collections.abc import Awaitable, Callable
import hashlib
import json
import logging
import math
from pathlib import Path
import re
import time
import unicodedata
import uuid

from fastapi import Depends, FastAPI, HTTPException, Request, Response
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse

from cad.library import check
from cad.service import db, ops
from cad.service.accounts import Member, Session
from cad.service.mailer import MailError, Mailer, Message
from cad.service.projects import canonical_id, saved_at

log = logging.getLogger('cad.service.submissions')

DAILY_UPLOADS = 5
# Every upload runs the check (a full mesh build), so attempts are capped too, refused ones included.
HOURLY_ATTEMPTS = 5
DAILY_ATTEMPTS = 15
HOUR = 3600
DAY = 24 * HOUR
REASON_MAX = 1000
# The furniture form's inputs, kept so a rejected preset's form can be filled in again.
DESIGN_BYTES = 20_000
# The JSON upload: the file as base64 plus its metadata.
MAX_UPLOAD_REQUEST = check.PIECE_BYTES * 4 // 3 + 1_000_000
FILE_NAMES = {'piece': 'piece.stl', 'train': 'car.glb', 'furniture': 'furniture.json'}
NOUNS = {'piece': 'a piece', 'train': 'a train model', 'furniture': 'a furniture preset'}
NOT_FOUND = 'There is no such upload.'
RECENTLY_REVIEWED = 20
OUTCOMES = {'rejected', 'closed'}
# Ids taken by an upload that can still reach the library.
LIVE_STATES = ('awaiting_look', 'approved', 'pr_open', 'merged')


class SubmissionError(Exception):
    def __init__(self, status: int, detail: str, extra: dict | None = None):
        super().__init__(detail)
        self.status = status
        self.detail = detail
        self.extra = extra or {}


def _slug(name: str) -> str:
    ascii_name = unicodedata.normalize('NFKD', name).encode('ascii', 'ignore').decode().lower()
    return re.sub(r'[^a-z0-9]+', '_', ascii_name).strip('_')[:48].strip('_')


def _file(body: dict) -> bytes:
    encoded = body.get('file')
    if not isinstance(encoded, str) or not encoded:
        raise SubmissionError(422, 'Choose a file to upload.')
    if len(encoded) > MAX_UPLOAD_REQUEST:
        raise SubmissionError(413, f'The file is larger than {check.PIECE_BYTES / 1e6:.0f} MB.')
    try:
        return base64.b64decode(encoded, validate=True)
    except (binascii.Error, ValueError):
        raise SubmissionError(422, 'The file did not arrive whole. Try again.') from None


def _train_metadata(metadata: dict, licence: object, data: bytes) -> dict:
    """The contributor's train fields, with the car's measured fields (`check.measure_train`) added."""
    car = metadata.get('car')
    if not isinstance(car, dict):
        raise check.Refused('The car measurements are incomplete.')
    bogies, couplers = car.get('bogies'), car.get('couplers')
    measured = check.measure_train(data, couplers)
    wheelbase = (round(bogies[-1] - bogies[0], 1) if isinstance(bogies, list) and len(bogies) >= 2 and
                 all(check.is_finite(value) for value in bogies) else None)
    result = {key: metadata.get(key) for key in ('name', 'year', 'power', 'gauge')}
    result['car'] = {'kind': car.get('kind'), 'motorised': car.get('motorised'), 'bogies': bogies, 'couplers': couplers,
                     'wheelbase': wheelbase, **measured}
    result['licence'] = licence
    if metadata.get('source') is not None:
        result['source'] = metadata['source']
    return result


class Submissions:
    def __init__(self, database: Path, mailer: Mailer, public_origin: str, clock: Callable[[], float] = time.time,
                 changed: Callable[[], None] = lambda: None):
        self.database = database
        self.mailer = mailer
        self.origin = public_origin.rstrip('/')
        self.clock = clock
        self.changed = changed

    def _connect(self):
        return db.connect(self.database)

    def link(self, submission_id: str) -> str:
        return f'{self.origin}/app/#review={submission_id}'

    def _send(self, messages: list[Message]) -> None:
        for message in messages:
            try:
                self.mailer.send(message)
            except (MailError, OSError) as exc:
                log.error('Submission mail "%s" was not sent: %s', message.subject, exc)

    @staticmethod
    def _uploads_today(conn, owner: str, now: int) -> list[int]:
        return [row[0] for row in conn.execute(
            'SELECT created_at FROM submissions WHERE owner_id = ? AND created_at > ? ORDER BY created_at',
            (owner, now - DAY))]

    def _limit(self, conn, owner: str, now: int) -> None:
        today = self._uploads_today(conn, owner, now)
        if len(today) >= DAILY_UPLOADS:
            raise SubmissionError(429, f'You have sent {DAILY_UPLOADS} uploads today, the daily limit. Try again later.',
                                  {'resetsAt': saved_at(today[0] + DAY)})

    @staticmethod
    def _attempts(conn, owner: str, now: int, window: int) -> list[int]:
        return [row[0] for row in conn.execute(
            "SELECT at FROM audit_events WHERE kind = 'upload_attempt' AND user_id = ? AND at > ? ORDER BY at",
            (owner, now - window))]

    def _attempt(self, conn, owner: str, now: int) -> None:
        """Count an upload attempt in `audit_events` before the check runs; 429 past the hourly or daily cap."""
        for cap, window, span in ((DAILY_ATTEMPTS, DAY, 'today'), (HOURLY_ATTEMPTS, HOUR, 'this hour')):
            attempts = self._attempts(conn, owner, now, window)
            if len(attempts) >= cap:
                raise SubmissionError(429, f'You have sent {cap} uploads {span}, counting refused ones. Try again later.',
                                      {'resetsAt': saved_at(attempts[0] + window)})
        conn.execute("INSERT INTO audit_events (at, kind, user_id) VALUES (?, 'upload_attempt', ?)", (now, owner))

    @staticmethod
    def _free_id(conn, name: str, kind: str) -> str:
        base = f'community_{_slug(name) or kind}'
        taken = {row[0] for row in conn.execute('SELECT id FROM library_items')} | {
            row[0] for row in conn.execute(
                f"SELECT json_extract(metadata, '$.id') FROM submissions WHERE state IN ({','.join('?' * len(LIVE_STATES))})",
                LIVE_STATES)}
        candidate, number = base, 2
        while candidate in taken:
            candidate, number = f'{base}_{number}', number + 1
        return candidate

    def _prepare(self, conn, kind: str, body: dict) -> tuple[dict, str, bytes]:
        """The stored metadata, licence and file bytes of an upload, checked; `check.Refused` when it fails."""
        metadata, licence = body.get('metadata'), body.get('licence')
        if not isinstance(metadata, dict):
            raise check.Refused('The metadata must be an object.')
        name = check.required_text(metadata.get('name'), 'The name')
        item_id = self._free_id(conn, name, kind)
        if kind == 'furniture':
            furniture, design = metadata.get('type'), metadata.get('design')
            if not isinstance(furniture, dict):
                raise check.Refused('The furniture form sent no furniture.')
            if design is not None and (not isinstance(design, dict) or len(json.dumps(design)) > DESIGN_BYTES):
                raise check.Refused('The furniture form sent an invalid design.')
            terms = furniture.get('terms')
            data = json.dumps({**furniture, 'family': item_id, 'label': name,
                               'terms': f'{item_id} {terms}'.strip() if isinstance(terms, str) else terms},
                              ensure_ascii=False, allow_nan=False, indent=2).encode()
            stored = {'id': item_id, 'name': name, **({'design': design} if design is not None else {})}
        else:
            data = _file(body)
            stored = ({'id': item_id, 'name': name, 'ends': metadata.get('ends'),
                       **({'source': metadata['source']} if metadata.get('source') is not None else {})}
                      if kind == 'piece' else {'id': item_id, **_train_metadata(metadata, licence, data)})
        if kind != 'train' and licence != check.ORIGINAL_LICENCE:
            raise check.Refused('Pieces and furniture are shared under CC BY 4.0.')
        check.check(kind, data, stored)
        return stored, licence, data

    def submit(self, member: Member, body: dict) -> dict:
        kind = body.get('kind')
        if kind not in FILE_NAMES:
            raise SubmissionError(422, 'Choose a piece, a train or furniture.')
        if body.get('attest') is not True:
            raise SubmissionError(422, 'Confirm you have the right to share it under its licence.')
        now = int(self.clock())
        capped = not ops.is_admin(self.database, member.id)
        conn = self._connect()
        try:
            if capped:
                self._limit(conn, member.id, now)
                with db.transaction(conn):
                    self._attempt(conn, member.id, now)
            try:
                metadata, licence, data = self._prepare(conn, kind, body)
            except check.Refused as refused:
                raise SubmissionError(422, str(refused)) from None
            submission_id = str(uuid.uuid4())
            with db.transaction(conn):
                if capped:
                    self._limit(conn, member.id, now)
                if self._free_id(conn, metadata['name'], kind) != metadata['id']:
                    raise SubmissionError(409, 'Another upload took this name a moment ago. Send it again.')
                conn.execute('INSERT INTO submissions (id, owner_id, kind, state, author_name, licence, metadata, '
                             'file_digest, attested_at, created_at, updated_at) '
                             "VALUES (?, ?, ?, 'awaiting_look', ?, ?, ?, ?, ?, ?, ?)",
                             (submission_id, member.id, kind, member.display_name, licence,
                              json.dumps(metadata, ensure_ascii=False, allow_nan=False),
                              hashlib.sha256(data).hexdigest(), now, now, now))
                conn.execute('INSERT INTO submission_files (submission_id, name, data) VALUES (?, ?, ?)',
                             (submission_id, FILE_NAMES[kind], data))
                admins = [row[0] for row in conn.execute('SELECT email FROM users WHERE is_admin = 1 ORDER BY email')]
            row = self._row(conn, submission_id)
        finally:
            conn.close()
        log.info('Member %s uploaded %s %s', member.id, kind, submission_id)
        if not admins:
            log.warning('Upload %s awaits review, but no account is an admin to tell', submission_id)
        self._send([Message(email, f'Plateway: upload awaiting review: {metadata["name"]}',
                            f'{member.display_name} uploaded {NOUNS[kind]}, “{metadata["name"]}”. It passed the automatic '
                            f'check and waits for your quick look:\n\n{self.link(submission_id)}') for email in admins])
        return self._summary(row)

    _COLUMNS = ('SELECT s.id, s.kind, s.state, s.author_name, s.licence, s.metadata, s.reason, s.pr_number, s.created_at, '
                's.reviewed_at, f.name AS file_name, length(f.data) AS file_bytes, '
                '(SELECT l.state FROM library_items l WHERE l.submission_id = s.id ORDER BY l.version DESC LIMIT 1) '
                'AS library_state '
                'FROM submissions s LEFT JOIN submission_files f ON f.submission_id = s.id ')

    def _row(self, conn, submission_id: str):
        return conn.execute(self._COLUMNS + 'WHERE s.id = ?', (submission_id,)).fetchone()

    @staticmethod
    def _summary(row) -> dict:
        metadata = json.loads(row['metadata'])
        # A published upload reads as its library item: live, retired or removed.
        return {'id': row['id'], 'kind': row['kind'], 'state': row['library_state'] or row['state'],
                'name': metadata.get('name', ''),
                'author': row['author_name'], 'licence': row['licence'], 'metadata': metadata,
                'reason': row['reason'] if row['state'] in OUTCOMES else None,
                'uploadedAt': saved_at(row['created_at']),
                'reviewedAt': saved_at(row['reviewed_at']) if row['reviewed_at'] is not None else None}

    def mine(self, member: str) -> dict:
        """The member's uploads, newest first, with each outcome; whether they may review; and the uploads left under the
        cap that binds now (`limit`: stored uploads today, attempts today or attempts this hour), with `resetsAt`, when
        `left` next goes up (null while it is already at its most). An admin has no cap: `left` and `limit` are null."""
        now = int(self.clock())
        conn = self._connect()
        try:
            rows = conn.execute(self._COLUMNS + 'WHERE s.owner_id = ? ORDER BY s.created_at DESC, s.id DESC',
                                (member,)).fetchall()
            submissions = [self._summary(row) for row in rows]
            if ops.is_admin(self.database, member):
                return {'submissions': submissions, 'left': None, 'limit': None, 'resetsAt': None, 'canReview': True}
            caps = (('uploads', DAILY_UPLOADS, DAY, self._uploads_today(conn, member, now)),
                    ('attempts_today', DAILY_ATTEMPTS, DAY, self._attempts(conn, member, now, DAY)),
                    ('attempts_hour', HOURLY_ATTEMPTS, HOUR, self._attempts(conn, member, now, HOUR)))
        finally:
            conn.close()
        left = min(max(0, cap - len(times)) for _, cap, _, times in caps)
        # `left` goes up once every cap at that value frees a slot; a cap with nothing counted never frees one.
        reset, limit = max(((times[0] + window if times else math.inf, name) for name, cap, window, times in caps
                            if max(0, cap - len(times)) == left), key=lambda binding: binding[0])
        return {'submissions': submissions, 'left': left, 'limit': limit,
                'resetsAt': saved_at(reset) if reset != math.inf else None, 'canReview': False}

    def queue(self) -> dict:
        """Uploads waiting for the quick look, oldest first, then the most recently reviewed."""
        conn = self._connect()
        try:
            waiting = conn.execute(self._COLUMNS + "WHERE s.state = 'awaiting_look' ORDER BY s.created_at, s.id").fetchall()
            reviewed = conn.execute(self._COLUMNS + 'WHERE s.reviewed_at IS NOT NULL ORDER BY s.reviewed_at DESC, s.id '
                                    'LIMIT ?', (RECENTLY_REVIEWED,)).fetchall()
        finally:
            conn.close()
        return {'waiting': [self._summary(row) for row in waiting], 'reviewed': [self._summary(row) for row in reviewed]}

    def look(self, submission_id: str) -> dict:
        conn = self._connect()
        try:
            row = self._row(conn, submission_id)
        finally:
            conn.close()
        if row is None:
            raise SubmissionError(404, NOT_FOUND)
        return {**self._summary(row), 'file': {'name': row['file_name'], 'bytes': row['file_bytes']} if row['file_name'] else None}

    def file(self, submission_id: str) -> tuple[str, bytes]:
        conn = self._connect()
        try:
            row = conn.execute('SELECT name, data FROM submission_files WHERE submission_id = ?', (submission_id,)).fetchone()
        finally:
            conn.close()
        if row is None:
            raise SubmissionError(404, 'This upload has no file any more.')
        return row['name'], bytes(row['data'])

    def _review(self, admin: str, submission_id: str, state: str, reason: str | None) -> dict:
        now = int(self.clock())
        conn = self._connect()
        try:
            with db.transaction(conn):
                current = conn.execute('SELECT state FROM submissions WHERE id = ?', (submission_id,)).fetchone()
                if current is None:
                    raise SubmissionError(404, NOT_FOUND)
                closing = current['state'] == 'pr_open' and state == 'rejected'
                if closing:
                    # The bot posts the reason on the pull request and closes it; the upload then reads `closed`.
                    if conn.execute('SELECT reason FROM submissions WHERE id = ?', (submission_id,)).fetchone()[0]:
                        raise SubmissionError(409, 'This pull request is already being closed.')
                    conn.execute('UPDATE submissions SET reason = ?, updated_at = ? WHERE id = ?', (reason, now, submission_id))
                elif current['state'] != 'awaiting_look':
                    raise SubmissionError(409, 'This upload was already reviewed.')
                else:
                    conn.execute('UPDATE submissions SET state = ?, reason = ?, reviewed_at = ?, updated_at = ? WHERE id = ?',
                                 (state, reason, now, now, submission_id))
                if state == 'rejected' and not closing:
                    # A rejected upload never leaves Plateway, and its file is not kept.
                    conn.execute('DELETE FROM submission_files WHERE submission_id = ?', (submission_id,))
                conn.execute('INSERT INTO audit_events (at, kind, user_id, detail) VALUES (?, ?, ?, ?)',
                             (now, 'submission_close_requested' if closing else f'submission_{state}', admin,
                              json.dumps({'submission': submission_id})))
            row = self._row(conn, submission_id)
        finally:
            conn.close()
        log.info('Admin %s %s upload %s', admin, 'closed the pull request of' if closing else state, submission_id)
        if state == 'approved' or closing:
            self.changed()
        return self._summary(row)

    def approve(self, admin: str, submission_id: str) -> dict:
        return self._review(admin, submission_id, 'approved', None)

    def reject(self, admin: str, submission_id: str, reason: object) -> dict:
        if not isinstance(reason, str) or not reason.strip() or len(reason.strip()) > REASON_MAX:
            raise SubmissionError(422, f'Give the contributor a reason (1–{REASON_MAX} characters).')
        return self._review(admin, submission_id, 'rejected', reason.strip())

    def awaiting_pull_request(self) -> list[dict]:
        """Approved uploads with no pull request yet, oldest first, each with its file: the GitHub bot's queue (U16)."""
        conn = self._connect()
        try:
            rows = conn.execute("SELECT s.id, s.kind, s.author_name, s.licence, s.metadata, s.file_digest, f.name, f.data "
                                'FROM submissions s JOIN submission_files f ON f.submission_id = s.id '
                                "WHERE s.state = 'approved' AND s.pr_number IS NULL ORDER BY s.reviewed_at, s.id").fetchall()
        finally:
            conn.close()
        return [{'id': row['id'], 'kind': row['kind'], 'author': row['author_name'], 'licence': row['licence'],
                 'metadata': json.loads(row['metadata']), 'digest': row['file_digest'], 'file': row['name'],
                 'data': bytes(row['data'])} for row in rows]


def register(app: FastAPI, submissions: Submissions, *, verified_member: Callable[..., Session],
             member: Callable[..., Session], admin: Callable[..., Session],
             read_body: Callable[[Request, int], Awaitable[dict]]) -> None:
    """`/api/submissions` for members and `/api/admin/submissions` for the quick look; `read_body(request, limit)` reads
    a size-limited JSON object body."""

    def submission(submission_id: str) -> str:
        try:
            return canonical_id(submission_id)
        except ValueError:
            raise HTTPException(status_code=404, detail=NOT_FOUND) from None

    async def call(work, *args):
        try:
            return await run_in_threadpool(work, *args)
        except SubmissionError as exc:
            if exc.extra:
                return JSONResponse({'detail': exc.detail, **exc.extra}, status_code=exc.status)
            raise HTTPException(status_code=exc.status, detail=exc.detail) from None

    @app.get('/api/submissions')
    async def my_submissions(session: Session = Depends(member)):
        return await call(submissions.mine, session.member.id)

    @app.post('/api/submissions', status_code=201)
    async def upload(request: Request, session: Session = Depends(verified_member)):
        return await call(submissions.submit, session.member, await read_body(request, MAX_UPLOAD_REQUEST))

    @app.get('/api/admin/submissions')
    async def review_queue(_session: Session = Depends(admin)):
        return await call(submissions.queue)

    @app.get('/api/admin/submissions/{submission_id}')
    async def quick_look(submission_id: str, _session: Session = Depends(admin)):
        return await call(submissions.look, submission(submission_id))

    @app.get('/api/admin/submissions/{submission_id}/file')
    async def submission_file(submission_id: str, _session: Session = Depends(admin)):
        result = await call(submissions.file, submission(submission_id))
        if isinstance(result, Response):
            return result
        name, data = result
        return Response(data, media_type='application/octet-stream', headers={
            'Content-Disposition': f'attachment; filename="{name}"', 'Cache-Control': 'private, no-store'})

    @app.post('/api/admin/submissions/{submission_id}/approve')
    async def approve(submission_id: str, session: Session = Depends(admin)):
        return await call(submissions.approve, session.member.id, submission(submission_id))

    @app.post('/api/admin/submissions/{submission_id}/reject')
    async def reject(submission_id: str, request: Request, session: Session = Depends(admin)):
        body = await read_body(request, 8192)
        return await call(submissions.reject, session.member.id, submission(submission_id), body.get('reason'))
