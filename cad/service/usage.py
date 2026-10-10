"""Usage analytics written by the service: anonymous in-app feature counts, browser error reports and members' package
downloads. `ops.py` reads them for the admin page.

Anonymous use is only ever a per-UTC-day total: no cookie, identifier, client IP or per-person row is stored. The app
sends each feature name at most once per page load (`POST /api/events`), so a day's count reads as "page loads that
used it". Browser errors (`POST /api/client-errors`) are counted per day and fingerprint. Both are kept for
`RETENTION_DAYS`; older days are deleted as new ones are written. The client IP is used only by the in-memory rate
limits below and never written anywhere.

Downloads are members' own (they are signed in), so each one is a row linked to its package and owner, deleted with the
account like the receipts they belong to."""
from __future__ import annotations

from collections.abc import Callable
from contextlib import closing
import hashlib
from pathlib import Path
import threading
import time

from cad.service import db

DAY = 24 * 3600
RETENTION_DAYS = 400
# The in-app features the app counts (`src/` sends them; anything else is ignored).
EVENTS = (
    'app_open',  # the app finished its first render
    'start_example', 'start_describe', 'start_hand',  # the start screen's path
    'describe_run',  # a Describe track generation was sent
    'test_drive',  # Test drive opened
    'print_open',  # the Print step opened
    'prepare_request',  # Prepare clicked
    'gallery_open',  # the gallery list opened
    'gallery_layout_open',  # a shared layout opened
    'remix',  # Remix confirmed
    'contribute_open',  # the contribute dialog opened
    'community_item_placed',  # a community piece or furniture placed
    'signup_open', 'signin_open',  # the sign-up or sign-in dialog opened
    'feedback_open',  # the feedback dialog opened
)
MAX_EVENTS = 20
MAX_MESSAGE, MAX_WHERE, MAX_VERSION = 300, 200, 40
MAX_BODY_BYTES = 4096
DOWNLOAD_KINDS = ('zip', 'file')
# Per client IP and minute, in memory: a page load sends a few event batches and at most 5 error reports.
EVENTS_PER_MINUTE, ERRORS_PER_MINUTE = 60, 20


class UsageError(ValueError):
    """A malformed report: the API answers 422."""


def utc_day(at: float) -> str:
    return time.strftime('%Y-%m-%d', time.gmtime(at))


def fingerprint(message: str, where: str, version: str) -> str:
    return hashlib.sha256((message + where + version).encode()).hexdigest()[:16]


def _text(value: object, limit: int, name: str, *, required: bool = False) -> str:
    if value is None and not required:
        return ''
    if not isinstance(value, str) or (required and not value.strip()):
        raise UsageError(f'"{name}" must be a string')
    # One line, so a report can't fake rows in the admin page or the log.
    return ' '.join(value.split())[:limit]


class RateLimit:
    """At most `limit` requests per key in a fixed `window` of seconds, in memory only. Keys (client IPs) are dropped
    once their window passes, so the table holds only the last window's callers."""

    def __init__(self, limit: int, window: float = 60, clock: Callable[[], float] = time.time):
        self.limit, self.window, self.clock = limit, window, clock
        self._hits: dict[str, tuple[float, int]] = {}
        self._lock = threading.Lock()

    def allow(self, key: str) -> bool:
        now = self.clock()
        with self._lock:
            started, hits = self._hits.get(key, (now, 0))
            if now - started >= self.window:
                started, hits = now, 0
            if hits >= self.limit:
                return False
            self._hits[key] = (started, hits + 1)
            if len(self._hits) > 10_000:
                self._hits = {k: v for k, v in self._hits.items() if now - v[0] < self.window}
            return True


class Usage:
    def __init__(self, database: Path, clock: Callable[[], float] = time.time):
        self.database, self.clock = database, clock

    def record_events(self, body: object) -> int:
        """Count each known name in `{"events": [...]}` once per mention (the app sends each at most once per page
        load); unknown names are ignored. Returns how many were counted."""
        names = body.get('events') if isinstance(body, dict) else None
        if not isinstance(names, list) or not 1 <= len(names) <= MAX_EVENTS or not all(
                isinstance(name, str) for name in names):
            raise UsageError(f'"events" must list 1 to {MAX_EVENTS} names')
        known = [name for name in names if name in EVENTS]
        now = self.clock()
        day = utc_day(now)
        with closing(db.connect(self.database)) as conn, db.transaction(conn):
            self._expire(conn, now)
            for name in known:
                conn.execute('INSERT INTO event_counts (day, name, count) VALUES (?, ?, 1) '
                             'ON CONFLICT (day, name) DO UPDATE SET count = count + 1', (day, name))
        return len(known)

    def record_error(self, body: object) -> str:
        """Count a browser error under its fingerprint for today; returns the fingerprint."""
        if not isinstance(body, dict):
            raise UsageError('An error report must be an object')
        message = _text(body.get('message'), MAX_MESSAGE, 'message', required=True)
        where = _text(body.get('where'), MAX_WHERE, 'where')
        version = _text(body.get('version'), MAX_VERSION, 'version')
        mark = fingerprint(message, where, version)
        now = self.clock()
        with closing(db.connect(self.database)) as conn, db.transaction(conn):
            self._expire(conn, now)
            conn.execute('INSERT INTO client_errors (day, fingerprint, message, where_, version, count, last_at) '
                         'VALUES (?, ?, ?, ?, ?, 1, ?) ON CONFLICT (day, fingerprint) '
                         'DO UPDATE SET count = count + 1, last_at = excluded.last_at',
                         (utc_day(now), mark, message, where, version, int(now)))
        return mark

    def record_download(self, owner_id: str, package_id: str, kind: str) -> None:
        if kind not in DOWNLOAD_KINDS:
            raise ValueError(f'Unknown download kind: {kind}')
        with closing(db.connect(self.database)) as conn, db.transaction(conn):
            conn.execute('INSERT INTO package_downloads (package_id, owner_id, kind, at) VALUES (?, ?, ?, ?)',
                         (package_id, owner_id, kind, int(self.clock())))

    @staticmethod
    def _expire(conn, now: float) -> None:
        oldest = utc_day(now - (RETENTION_DAYS - 1) * DAY)
        conn.execute('DELETE FROM event_counts WHERE day < ?', (oldest,))
        conn.execute('DELETE FROM client_errors WHERE day < ?', (oldest,))
