"""The community gallery (R14–R16, R25–R27, KTD11): published layouts, remix credit, reports and moderation.

Publishing stores a separate, stripped copy of the project: the author's owned-track inventory, test-drive observations, fit
calibration, printer, material and print settings never reach it (R26), whatever the browser sends. The row keeps the
author's display name and the remix ancestry as they were at publish time (R25), and the CC BY 4.0 licence. Its
thumbnail is structured top-view data (box, centrelines, shelves) that the browser draws; no uploaded image or SVG is
stored or served.

Anyone may browse, open and report; publishing needs a verified member, `DAILY_PUBLISHES` a day. A hidden layout is
gone from the list and its link for everyone except admins and its author (AE6); remixes of it stay visible. Each
report emails the admins; hiding and unhiding email the author.
"""
from __future__ import annotations

from collections.abc import Awaitable, Callable
import json
import logging
from pathlib import Path
import re
import time
import uuid

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.concurrency import run_in_threadpool

from cad.service import db, ops
from cad.service.accounts import Member, Session
from cad.service.mailer import MailError, Mailer, Message
from cad.service.projects import canonical_id, saved_at, validate_project

log = logging.getLogger('cad.service.gallery')

LICENCE = 'CC-BY-4.0'
TITLE_MAX = 120
DESCRIPTION_MAX = 2000
REASON_MAX = 1000
CREDIT_NAME_MAX = 30
REPORTS_PER_IP = 5
DAILY_PUBLISHES = 10
HOUR = 3600
DAY = 24 * HOUR
PAGE_SIZE = 48
MAX_CLAIMED_ANCESTORS = 200
NOT_FOUND = 'This layout is not in the gallery.'
# The project's print setup and fit as a new project has them (`createProject` in src/domain/project.ts).
STRIPPED = {
    'inventory': {}, 'observations': [],
    'connectorFit': {'adjustmentMm': 0, 'settingsKey': None, 'calibrationId': None},
    'printer': 'X1 Carbon', 'material': None,
    'printSettings': {'profile': None, 'nozzleMm': None, 'orientation': 'flat'},
    'provenance': {'account': None}, 'parentRevision': None,
}
# Thumbnail bounds: plan millimetres, rounded; as many x, y points as a card can draw (the browser simplifies to fit).
COORDINATE_MAX = 1_000_000
THUMBNAIL_POINTS = 4000
THUMBNAIL_TRACKS = THUMBNAIL_POINTS // 2
THUMBNAIL_BYTES = 64 * 1024
THUMBNAIL_SHELVES = 200
CURSOR = re.compile(r'(\d{1,12}):([0-9a-f-]{36})')


class GalleryError(Exception):
    def __init__(self, status: int, detail: str):
        super().__init__(detail)
        self.status = status
        self.detail = detail


def _text(value: object, limit: int, label: str, *, required: bool) -> str:
    if value is None and not required:
        return ''
    if not isinstance(value, str) or len(value.strip()) > limit or required and not value.strip():
        raise GalleryError(422, f'{label} must be {"1" if required else "0"}-{limit} characters.')
    return value.strip()


def _integer(value: object) -> bool:
    return type(value) is int and abs(value) <= COORDINATE_MAX


def validate_thumbnail(value: object) -> str:
    """`{"box": [x, y, width, height], "tracks": [{"points": [x, y, …], "owned": bool}], "shelves": [[x, y, w, h]]}`,
    whole millimetres only, at most `THUMBNAIL_POINTS` points and `THUMBNAIL_BYTES` as stored; anything else is
    refused. Returns the stored JSON."""
    if not isinstance(value, dict) or set(value) != {'box', 'tracks', 'shelves'}:
        raise GalleryError(422, 'Invalid thumbnail')
    box, tracks, shelves = value['box'], value['tracks'], value['shelves']
    rectangle = lambda item: isinstance(item, list) and len(item) == 4 and all(map(_integer, item)) and item[2] > 0 and item[3] > 0
    if not rectangle(box) or not isinstance(tracks, list) or len(tracks) > THUMBNAIL_TRACKS or \
            not isinstance(shelves, list) or len(shelves) > THUMBNAIL_SHELVES or not all(map(rectangle, shelves)):
        raise GalleryError(422, 'Invalid thumbnail')
    total = 0
    for track in tracks:
        if not isinstance(track, dict) or set(track) != {'points', 'owned'} or type(track['owned']) is not bool:
            raise GalleryError(422, 'Invalid thumbnail')
        points = track['points']
        if not isinstance(points, list) or len(points) < 4 or len(points) % 2 or not all(map(_integer, points)):
            raise GalleryError(422, 'Invalid thumbnail')
        total += len(points)
    if total > 2 * THUMBNAIL_POINTS:
        raise GalleryError(422, 'Invalid thumbnail')
    stored = json.dumps({'box': box, 'tracks': [{'points': track['points'], 'owned': track['owned']} for track in tracks],
                         'shelves': shelves}, separators=(',', ':'))
    if len(stored) > THUMBNAIL_BYTES:
        raise GalleryError(422, 'Invalid thumbnail')
    return stored


def strip(project: dict, layout_id: str, title: str) -> dict:
    """The shared copy (R26): the author's inventory, observations, fit, printer, material, print settings, account and
    save history are replaced by a new project's; the ancestry moves to the row; the id and name become the layout's."""
    body = {key: value for key, value in project.items() if key != 'ancestors'}
    body.update(json.loads(json.dumps(STRIPPED)), id=layout_id, name=title)
    return body


def _piece_count(body: dict) -> int:
    routes = body.get('routes')
    if not isinstance(routes, list):
        return 0
    return sum(len(route['pieces']) for route in routes if isinstance(route, dict) and isinstance(route.get('pieces'), list))


def _credit(entry: object) -> dict:
    """A remix credit as the browser carries it: the layout's id, title, author's display name and licence."""
    if not isinstance(entry, dict):
        raise GalleryError(422, 'Invalid remix credit')
    try:
        layout_id = canonical_id(entry.get('id'))
    except ValueError:
        raise GalleryError(422, 'Invalid remix credit') from None
    title, author, licence = entry.get('title'), entry.get('author'), entry.get('licence')
    if not all(isinstance(item, str) and item.strip() for item in (title, author, licence)) or \
            len(title) > TITLE_MAX or len(author) > CREDIT_NAME_MAX or licence != LICENCE:
        raise GalleryError(422, 'Invalid remix credit')
    return {'id': layout_id, 'title': title.strip(), 'author': author.strip(), 'licence': licence}


def _snapshot(row) -> dict:
    return {'id': row['id'], 'title': row['title'], 'author': row['author_name'], 'licence': row['licence']}


class Gallery:
    def __init__(self, database: Path, mailer: Mailer, public_origin: str, clock: Callable[[], float] = time.time):
        self.database = database
        self.mailer = mailer
        self.origin = public_origin.rstrip('/')
        self.clock = clock

    def _connect(self):
        return db.connect(self.database)

    def link(self, layout_id: str) -> str:
        return f'{self.origin}/app/#gallery={layout_id}'

    def _send(self, messages: list[Message]) -> None:
        for message in messages:
            try:
                self.mailer.send(message)
            except (MailError, OSError) as exc:
                log.error('Gallery mail "%s" was not sent: %s', message.subject, exc)

    def is_admin(self, viewer: str | None) -> bool:
        return viewer is not None and ops.is_admin(self.database, viewer)

    @staticmethod
    def _visible(row, viewer: str | None, admin: bool) -> bool:
        return row is not None and (row['hidden_at'] is None or admin or row['owner_id'] == viewer)

    def _summary(self, row, viewer: str | None, admin: bool) -> dict:
        ancestors = json.loads(row['ancestors'])
        mine = viewer is not None and row['owner_id'] == viewer
        summary = {
            'id': row['id'], 'title': row['title'], 'description': row['description'], 'author': row['author_name'],
            'licence': row['licence'], 'publishedAt': saved_at(row['published_at']), 'pieces': row['pieces'],
            'thumbnail': json.loads(row['thumbnail']) if row['thumbnail'] else None,
            'remixOf': ancestors[0] if ancestors else None, 'mine': mine,
        }
        if row['hidden_at'] is not None and (admin or mine):
            summary['hidden'] = {'at': saved_at(row['hidden_at']), 'reason': row['hidden_reason'] or ''}
        if admin:
            summary['openReports'] = row['open_reports']
        return summary

    _COLUMNS = ("SELECT g.id, g.owner_id, g.title, g.description, g.thumbnail, g.author_name, g.licence, g.ancestors, "
                "g.published_at, g.hidden_at, g.hidden_reason, g.pieces, "
                "(SELECT count(*) FROM reports p WHERE p.layout_id = g.id AND p.resolved_at IS NULL) AS open_reports ")

    def list(self, viewer: str | None, before: str | None = None) -> dict:
        """Newest first, a page at a time; `next` continues after the last one. Hidden layouts are listed only for
        admins and their author."""
        admin = self.is_admin(viewer)
        query, values = self._COLUMNS + 'FROM gallery_layouts g WHERE (g.hidden_at IS NULL OR ? OR g.owner_id = ?) ', \
            [int(admin), viewer]
        if before is not None:
            match = CURSOR.fullmatch(before)
            if not match:
                raise GalleryError(422, 'Invalid page')
            # The bare `<=` lets the next page start inside `gallery_layouts_published` instead of walking to it.
            query += 'AND g.published_at <= ? AND (g.published_at < ? OR g.id < ?) '
            values += [int(match[1]), int(match[1]), match[2]]
        conn = self._connect()
        try:
            rows = conn.execute(query + 'ORDER BY g.published_at DESC, g.id DESC LIMIT ?', [*values, PAGE_SIZE + 1]).fetchall()
        finally:
            conn.close()
        page = rows[:PAGE_SIZE]
        return {'layouts': [self._summary(row, viewer, admin) for row in page],
                'next': f'{page[-1]["published_at"]}:{page[-1]["id"]}' if len(rows) > PAGE_SIZE else None}

    def get(self, viewer: str | None, layout_id: str) -> dict:
        """The layout page: the shared copy and its full credit chain; open reports for admins."""
        admin = self.is_admin(viewer)
        conn = self._connect()
        try:
            row = conn.execute(self._COLUMNS + ', g.body FROM gallery_layouts g WHERE g.id = ?', (layout_id,)).fetchone()
            if not self._visible(row, viewer, admin):
                raise GalleryError(404, NOT_FOUND)
            reports = conn.execute('SELECT reason, created_at FROM reports WHERE layout_id = ? AND resolved_at IS NULL '
                                   'ORDER BY created_at DESC, id DESC', (layout_id,)).fetchall() if admin else []
        finally:
            conn.close()
        detail = {**self._summary(row, viewer, admin), 'project': json.loads(row['body']),
                  'ancestors': json.loads(row['ancestors']), 'canModerate': admin}
        if admin:
            detail['reports'] = [{'reason': report['reason'], 'reportedAt': saved_at(report['created_at'])} for report in reports]
        return detail

    @staticmethod
    def _ancestors(conn, claimed: object) -> list[dict]:
        """The remix chain, nearest first. From the first claimed layout still in the gallery, or recorded when it left
        (unpublished or its author's account deleted), onwards it is the gallery's own record (names as they were when
        each was published). A claimed layout the gallery never published is dropped: nothing ties its credit to a real
        author."""
        if claimed is None:
            return []
        if not isinstance(claimed, list) or len(claimed) > MAX_CLAIMED_ANCESTORS:
            raise GalleryError(422, 'Invalid remix credit')
        for entry in claimed:
            credit = _credit(entry)
            row = conn.execute('SELECT id, title, author_name, licence, ancestors FROM gallery_layouts WHERE id = ? UNION ALL '
                               'SELECT id, title, author_name, licence, ancestors FROM gallery_tombstones WHERE id = ?',
                               (credit['id'], credit['id'])).fetchone()
            if row is not None:
                return [_snapshot(row), *json.loads(row['ancestors'])]
        return []

    @staticmethod
    def _limit(conn, owner: str, now: int) -> None:
        """Counted in `audit_events`, so unpublishing does not give a publish back. Admins have no limit (they are
        trusted, and seed and republish the gallery)."""
        if conn.execute('SELECT is_admin FROM users WHERE id = ?', (owner,)).fetchone()[0]:
            return
        if conn.execute("SELECT count(*) FROM audit_events WHERE kind = 'gallery_published' AND user_id = ? AND at > ?",
                        (owner, now - DAY)).fetchone()[0] >= DAILY_PUBLISHES:
            raise GalleryError(429, f'You have published {DAILY_PUBLISHES} layouts today, the daily limit. '
                                    'Try again tomorrow.')

    def publish(self, member: Member, body: dict) -> dict:
        title = _text(body.get('title'), TITLE_MAX, 'The title', required=True)
        description = _text(body.get('description'), DESCRIPTION_MAX, 'The description', required=False)
        project = body.get('project')
        if not isinstance(project, dict):
            raise GalleryError(422, 'Invalid project data')
        thumbnail = validate_thumbnail(body.get('thumbnail'))
        layout_id = str(uuid.uuid4())
        shared = strip(project, layout_id, title)
        try:
            validate_project(shared)
        except (ValueError, TypeError, KeyError):
            raise GalleryError(422, 'Invalid project data') from None
        pieces = _piece_count(shared)
        if not pieces:
            raise GalleryError(422, 'Lay some track before publishing.')
        now = int(self.clock())
        conn = self._connect()
        try:
            with db.transaction(conn):
                self._limit(conn, member.id, now)
                ancestors = self._ancestors(conn, project.get('ancestors'))
                conn.execute('INSERT INTO gallery_layouts (id, owner_id, title, description, body, thumbnail, author_name, '
                             'licence, ancestors, pieces, published_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                             (layout_id, member.id, title, description,
                              json.dumps(shared, ensure_ascii=False, allow_nan=False), thumbnail, member.display_name,
                              LICENCE, json.dumps(ancestors, ensure_ascii=False), pieces, now))
                conn.execute("INSERT INTO audit_events (at, kind, user_id, detail) VALUES (?, 'gallery_published', ?, ?)",
                             (now, member.id, json.dumps({'layout': layout_id})))
        finally:
            conn.close()
        log.info('Member %s published layout %s', member.id, layout_id)
        return self.get(member.id, layout_id)

    def unpublish(self, owner: str, layout_id: str) -> None:
        """The author's own layout only; the gallery keeps its credit (`gallery_tombstones`) for remixes."""
        conn = self._connect()
        try:
            with db.transaction(conn):
                if not conn.execute('DELETE FROM gallery_layouts WHERE id = ? AND owner_id = ?', (layout_id, owner)).rowcount:
                    raise GalleryError(404, NOT_FOUND)
        finally:
            conn.close()

    def report(self, layout_id: str, reason: object, ip: str, reporter: str | None) -> None:
        """Anyone, with or without a session; 5 reports per IP an hour. The layout stays listed until an admin hides it."""
        reason = _text(reason, REASON_MAX, 'The reason', required=True)
        now = int(self.clock())
        conn = self._connect()
        try:
            with db.transaction(conn):
                row = conn.execute('SELECT id, owner_id, title, author_name, hidden_at FROM gallery_layouts WHERE id = ?',
                                   (layout_id,)).fetchone()
                if not self._visible(row, reporter, False):
                    raise GalleryError(404, NOT_FOUND)
                if conn.execute('SELECT count(*) FROM reports WHERE client_ip = ? AND created_at > ?',
                                (ip, now - HOUR)).fetchone()[0] >= REPORTS_PER_IP:
                    raise GalleryError(429, 'Too many reports from this connection. Try again in an hour.')
                conn.execute('INSERT INTO reports (layout_id, reporter_id, client_ip, reason, created_at) VALUES (?, ?, ?, ?, ?)',
                             (layout_id, reporter, ip, reason, now))
                admins = [item[0] for item in conn.execute('SELECT email FROM users WHERE is_admin = 1 ORDER BY email')]
        finally:
            conn.close()
        if not admins:
            log.warning('Layout %s was reported, but no account is an admin to tell', layout_id)
        self._send([Message(email, f'Plateway: layout reported: {row["title"]}',
                            f'“{row["title"]}” by {row["author_name"]} was reported:\n\n{reason}\n\n'
                            f'It stays in the gallery until you hide it: {self.link(layout_id)}') for email in admins])

    def _moderate(self, admin: str, layout_id: str, hidden: bool, reason: str) -> None:
        now = int(self.clock())
        conn = self._connect()
        try:
            with db.transaction(conn):
                row = conn.execute('SELECT g.title, u.email FROM gallery_layouts g JOIN users u ON u.id = g.owner_id '
                                   'WHERE g.id = ?', (layout_id,)).fetchone()
                if row is None:
                    raise GalleryError(404, NOT_FOUND)
                conn.execute('UPDATE gallery_layouts SET hidden_at = ?, hidden_reason = ? WHERE id = ?',
                             (now if hidden else None, reason if hidden else None, layout_id))
                conn.execute('UPDATE reports SET resolved_at = ? WHERE layout_id = ? AND resolved_at IS NULL', (now, layout_id))
                conn.execute('INSERT INTO audit_events (at, kind, user_id, detail) VALUES (?, ?, ?, ?)',
                             (now, 'gallery_hidden' if hidden else 'gallery_unhidden', admin,
                              json.dumps({'layout': layout_id})))
        finally:
            conn.close()
        if hidden:
            message = Message(row['email'], 'Your Plateway layout was hidden',
                              f'Your layout “{row["title"]}” is hidden from the Plateway gallery:\n\n{reason}\n\n'
                              f'Only you can still open it: {self.link(layout_id)}\nReply to this email if you think '
                              'this is a mistake.')
        else:
            message = Message(row['email'], 'Your Plateway layout is back in the gallery',
                              f'Your layout “{row["title"]}” is visible in the Plateway gallery again: {self.link(layout_id)}')
        self._send([message])

    def hide(self, admin: str, layout_id: str, reason: object) -> dict:
        self._moderate(admin, layout_id, True, _text(reason, REASON_MAX, 'The reason', required=True))
        return self.get(admin, layout_id)

    def unhide(self, admin: str, layout_id: str) -> dict:
        self._moderate(admin, layout_id, False, '')
        return self.get(admin, layout_id)


def register(app: FastAPI, gallery: Gallery, *, verified_member: Callable[..., Session], member: Callable[..., Session],
             admin: Callable[..., Session], read_body: Callable[[Request], Awaitable[dict]],
             client_ip: Callable[[Request], str]) -> None:
    """The `/api/gallery` routes. Browsing, opening and reporting need no session; `read_body` reads a size-limited
    JSON object body."""

    def layout(layout_id: str) -> str:
        try:
            return canonical_id(layout_id)
        except ValueError:
            raise HTTPException(status_code=404, detail=NOT_FOUND) from None

    def viewer(request: Request) -> str | None:
        session = request.state.session
        return session.member.id if session is not None else None

    async def call(work, *args):
        try:
            return await run_in_threadpool(work, *args)
        except GalleryError as exc:
            raise HTTPException(status_code=exc.status, detail=exc.detail) from None

    @app.get('/api/gallery')
    async def list_layouts(request: Request, before: str | None = None):
        return await call(gallery.list, viewer(request), before)

    @app.post('/api/gallery', status_code=201)
    async def publish(request: Request, session: Session = Depends(verified_member)):
        return await call(gallery.publish, session.member, await read_body(request))

    @app.get('/api/gallery/{layout_id}')
    async def get_layout(layout_id: str, request: Request):
        return await call(gallery.get, viewer(request), layout(layout_id))

    @app.delete('/api/gallery/{layout_id}')
    async def unpublish(layout_id: str, session: Session = Depends(member)):
        await call(gallery.unpublish, session.member.id, layout(layout_id))
        return {'status': 'unpublished'}

    @app.post('/api/gallery/{layout_id}/report', status_code=202)
    async def report(layout_id: str, request: Request):
        body = await read_body(request)
        await call(gallery.report, layout(layout_id), body.get('reason'), client_ip(request), viewer(request))
        return {'status': 'reported'}

    @app.post('/api/gallery/{layout_id}/hide')
    async def hide(layout_id: str, request: Request, session: Session = Depends(admin)):
        body = await read_body(request)
        return await call(gallery.hide, session.member.id, layout(layout_id), body.get('reason'))

    @app.post('/api/gallery/{layout_id}/unhide')
    async def unhide(layout_id: str, session: Session = Depends(admin)):
        return await call(gallery.unhide, session.member.id, layout(layout_id))
