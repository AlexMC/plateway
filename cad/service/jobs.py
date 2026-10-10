"""Prepare jobs (R9–R11, R13; KTD5, KTD6): the queue the API fills and the worker (`worker.py`) drains, one at a time.

A job prepares a layout (`layout`), a calibration coupon (`coupon`) or a grade rig (`grade`). Before queueing, the
request is validated and its peak memory estimated (`split.py`, KTD6). A layout above the per-part limit becomes a
parent job with one child job per part; the children run one at a time in part order, then the parent's own run
combines their packages (U8, `combine.py`). A parent and its children are one active job and one daily prepare.

States, as in the plan's diagram: queued → running → succeeded, failed (a problem the member can fix),
failed_too_large (the kernel killed it for memory), failed_system (crash, timeout, second interruption) or cancelled.
A running job whose heartbeat is stale is interrupted and requeued once. System failures do not count towards the
daily limit; a cancel does. A succeeded job reads as `expired` once its package's files have (`receipts.py`): the
bucket's lifecycle deletes them, so the state is derived from the receipt, never written.

The worker records each job's state; the child process it runs (`prepare_job.py`) records progress, the package id
or the member-facing error. This module loads no CAD code, so the worker process stays small; the API loads it with
its first prepare request.
"""
from __future__ import annotations

from collections.abc import Callable, Iterator
from contextlib import closing, contextmanager
from dataclasses import dataclass
from datetime import datetime, timezone
import json
import logging
import math
from pathlib import Path
import sqlite3
import time
import uuid

from cad.service import db
from cad.service.errors import UserError

log = logging.getLogger(__name__)

KINDS = ('layout', 'coupon', 'grade')
ACTIVE = ('queued', 'running', 'interrupted')
DAY = 24 * 3600
# A running job's heartbeat (the worker's, every few seconds while its child lives) older than this is stale.
STALE_AFTER = 120
# `prepare_job`'s exit status for a problem the member can fix; its message is on the job row.
MEMBER_ERROR = 3

INVALID_REQUEST = "This layout couldn’t be prepared. Reload the project and try again."
NOT_FOUND = "Job not found"

# KTD6: the peak memory of one prepare (its Python process plus the slicer it runs), estimated before queueing from
# the printed-part count and the distinct CAD builds. Calibrated on measured prepares, macOS, peak RSS of a fresh
# `prepare_job` unless noted (parts, builds, plates):
#   - calibration coupon (1, 1, 1): Python 1.04 GB, slicer 0.11 GB;
#   - Session copy whole (44, 38, 11): Python 3.52 and 4.04 GB over two runs, slicer 0.52-0.53 GB;
#   - Session copy in three parts: (15, 15, 6) 2.80 GB, (22, 19, 5) 3.81 GB, (7, 5, 1) 2.97 GB, slicer 0.26-0.52 GB;
#   - Task2 (37, 25, 8): Python 3.30-3.77 GB over four runs in a service process, slicer 0.40-0.52 GB (SlicerLinux);
#   - hero (212, 103): 6.03 GB when it failed, in a service process already holding 3.2 GB (SlicerLinux).
# Building the first track piece costs about 1.9 GB over the coupon (two composite track pieces and five columns
# peak at 2.97 GB), and each further part adds about 30 MB, more by parts than by builds (the Session copy has 52%
# more builds than Task2 and peaks about 7% higher). `BASE_MB` is that first-piece Python peak plus 0.6 GB for the
# slicer, whose peak stays at 0.1-0.6 GB per plate whatever the plate count, so the plate count is left out. Every
# layout run above is within its estimate with its slicer peak added; the closest is the Session copy's second part,
# 4.56 GB for 3.81 + 0.52 GB. The hero is over-estimated (12.1 GB), which only splits it sooner: four parts.
BASE_MB = 3600
PART_MB = 35
BUILD_MB = 10
# A part's estimate stays at or under this, the 6 GB per-part target, below the worker's 7 GB cap (KTD5). The
# Session copy (5.52 GB estimated) and Task2 (5.15 GB) prepare whole; the hero is split into parts.
PART_LIMIT_MB = 6000

# Overall progress: where each package stage starts and how much of the job it takes. A parent's combine step has
# its own scale.
STAGES = {'cad': (0.0, 0.55), 'arrange': (0.55, 0.05), 'slice': (0.6, 0.35), 'guide': (0.95, 0.05), 'combine': (0.0, 1.0)}
STEPS = {'cad': 'Part', 'slice': 'Plate', 'combine': 'Part'}


@dataclass(frozen=True)
class Limits:
    """The per-part memory limit (KTD6) and the rolling 24-hour prepare limits (R13)."""
    part_mb: int = PART_LIMIT_MB
    layouts_per_day: int = 10
    samples_per_day: int = 20


class JobError(Exception):
    """A request refused before queueing: `status`, the member-facing `detail` and any `extra` reply fields."""

    def __init__(self, status: int, detail: str, extra: dict | None = None):
        super().__init__(detail)
        self.status, self.detail, self.extra = status, detail, extra or {}


def memory_mb(printed_parts: int, cad_builds: int) -> int:
    """KTD6: the estimated peak memory of one prepare of this many printed parts and distinct CAD builds."""
    return BASE_MB + BUILD_MB * cad_builds + PART_MB * printed_parts


def _iso(seconds: int | None) -> str | None:
    return None if seconds is None else datetime.fromtimestamp(seconds, timezone.utc).isoformat(timespec='seconds')


def _gigabytes(megabytes: int) -> str:
    return f'{megabytes / 1000:.1f} GB'


@dataclass(frozen=True)
class Work:
    """What one run of `prepare_job` does for `owner`: build a package (`kind`, `payload`, and for a layout `manifest`
    and the `part` it builds, if any), or combine the parent's part packages (`combine`: their ids in part order)."""
    job_id: str
    owner: str | None
    kind: str
    payload: dict
    manifest: dict | None
    part: dict | None
    combine: list[str] | None


class Jobs:
    def __init__(self, database: Path, clock: Callable[[], float] = time.time, limits: Limits = Limits()):
        self.database = database
        self.clock = clock
        self.limits = limits

    def now(self) -> int:
        return int(self.clock())

    @contextmanager
    def _write(self) -> Iterator[sqlite3.Connection]:
        with closing(db.connect(self.database)) as conn, db.transaction(conn):
            yield conn

    # Requests (the API) -------------------------------------------------------------------------------------------

    def enqueue(self, owner: str, body: object) -> tuple[dict, bool]:
        """Queue a prepare for `owner`; `False` with the member's active job, which a second request returns."""
        kind, payload, whole, parts = self._plan(body)
        now = self.now()
        with self._write() as conn:
            active = self._active(conn, owner)
            if active is not None:
                return self._view(conn, active), False
            self._check_quota(conn, owner, kind, now)
            project_id = revision_id = None
            if kind == 'layout':
                project = payload['project']
                saved = conn.execute('SELECT project_id FROM revisions WHERE id = ? AND project_id = ? AND owner_id = ?',
                                     (project['revision'], project['id'], owner)).fetchone()
                if saved is not None:
                    project_id, revision_id = project['id'], project['revision']
            job_id = str(uuid.uuid4())
            insert = ('INSERT INTO jobs (id, owner_id, kind, state, parent_id, part_index, project_id, revision_id, '
                      "manifest, estimate, created_at) VALUES (?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?)")
            conn.execute(insert, (job_id, owner, kind, None, None, project_id, revision_id, json.dumps(payload),
                                  json.dumps(whole), now))
            for index, (ids, part_estimate) in enumerate(parts, 1):
                conn.execute(insert, (str(uuid.uuid4()), owner, kind, job_id, index, project_id, revision_id,
                                      json.dumps({'instanceIds': ids}), json.dumps(part_estimate), now))
            return self._view(conn, self._row(conn, job_id)), True

    def get(self, owner: str, job_id: str) -> dict:
        with closing(db.connect(self.database)) as conn:
            return self._view(conn, self._owned(conn, owner, job_id))

    def status(self, owner: str) -> dict:
        """What the Print step resumes and shows: the member's active job (`None` without one, whichever project or
        kind it prepares) and what is left of each daily limit (R9, R13)."""
        now = self.now()
        with closing(db.connect(self.database)) as conn:
            active = self._active(conn, owner)
            return {'active': None if active is None else self._view(conn, active),
                    'limits': {'layout': self._quota(conn, owner, 'layout', now),
                               'sample': self._quota(conn, owner, 'coupon', now)}}

    def again(self, owner: str, package_id: str) -> tuple[dict, bool]:
        """Queue the prepare that made the member's package `package_id` once more (`enqueue`), e.g. after its files
        expired (R12)."""
        with closing(db.connect(self.database)) as conn:
            row = conn.execute('SELECT j.kind, j.manifest FROM receipts r JOIN jobs j ON j.id = r.job_id '
                               'WHERE r.package_id = ? AND r.owner_id = ?', (package_id, owner)).fetchone()
        if row is None:
            raise JobError(404, 'Package not found')
        payload = json.loads(row['manifest'])
        return self.enqueue(owner, {'kind': 'layout', 'manifest': payload} if row['kind'] == 'layout'
                            else {'kind': row['kind'], **payload})

    def cancel(self, owner: str, job_id: str) -> dict:
        """Cancel a queued job now; a running one is stopped by the worker. Cancelling a parent cancels every part."""
        now = self.now()
        with self._write() as conn:
            row = self._owned(conn, owner, job_id)
            if row['state'] in ('queued', 'interrupted'):
                conn.execute("UPDATE jobs SET state = 'cancelled', cancel_requested_at = ?, finished_at = ? "
                             'WHERE id = ?', (now, now, job_id))
            if row['state'] in ACTIVE:
                conn.execute("UPDATE jobs SET state = 'cancelled', cancel_requested_at = ?, finished_at = ? "
                             "WHERE parent_id = ? AND state IN ('queued', 'interrupted')", (now, now, job_id))
                conn.execute("UPDATE jobs SET cancel_requested_at = ? WHERE (id = ? OR parent_id = ?) "
                             "AND state = 'running'", (now, job_id, job_id))
            return self._view(conn, self._row(conn, job_id))

    def _plan(self, body: object) -> tuple[str, dict, dict, list[tuple[list[str], dict]]]:
        """(kind, payload, estimate, parts): the validated request, its size estimate and, for a layout above the
        per-part limit, each part's instance ids and estimate."""
        from cad.service.split import TooLarge, plan_request  # CAD code: the API's, never the worker's

        if not isinstance(body, dict) or body.get('kind') not in KINDS:
            raise JobError(422, INVALID_REQUEST)
        try:
            return plan_request(body, self.limits.part_mb)
        except TooLarge as exc:
            raise JobError(422, (
                f"This layout is too large to prepare. {exc.subject} has {exc.size['printedParts']} printed parts "
                f"with {exc.size['cadBuilds']} different shapes, which needs about {_gigabytes(exc.size['memoryMb'])} "
                f"of memory; one prepare can use {_gigabytes(self.limits.part_mb)}, and a piece can’t be split across "
                'prepares. Split it into shorter pieces and try again.'),
                {'limitMb': self.limits.part_mb, 'group': exc.size}) from exc
        except UserError as exc:
            raise JobError(422, str(exc)) from exc
        except (ValueError, KeyError, TypeError, AttributeError) as exc:
            log.warning('Prepare request rejected', exc_info=exc)
            raise JobError(422, INVALID_REQUEST) from exc

    def _counted(self, conn: sqlite3.Connection, owner: str, kind: str, now: int) -> tuple[int, str, list[int]]:
        """R13: (limit, noun, the counted prepares' times, oldest first) of `kind`'s rolling 24 hours: layout prepares
        (a layout prepared in parts is one), and separately calibration coupons and grade rigs. A system failure does
        not count."""
        kinds, limit, noun = ((('layout',), self.limits.layouts_per_day, 'layouts') if kind == 'layout' else
                              (('coupon', 'grade'), self.limits.samples_per_day, 'calibration samples and grade rigs'))
        counted = [row[0] for row in conn.execute(
            f"SELECT created_at FROM jobs WHERE owner_id = ? AND parent_id IS NULL AND kind IN ({','.join('?' * len(kinds))}) "
            "AND created_at > ? AND state <> 'failed_system' ORDER BY created_at", (owner, *kinds, now - DAY))]
        return limit, noun, counted

    def _quota(self, conn: sqlite3.Connection, owner: str, kind: str, now: int) -> dict:
        """`kind`'s daily limit, the prepares left and, once none are, when the next one frees up."""
        limit, _, counted = self._counted(conn, owner, kind, now)
        remaining = max(0, limit - len(counted))
        return {'limit': limit, 'remaining': remaining,
                'resetsAt': None if remaining else _iso(counted[len(counted) - limit] + DAY)}

    def _check_quota(self, conn: sqlite3.Connection, owner: str, kind: str, now: int) -> None:
        limit, noun, counted = self._counted(conn, owner, kind, now)
        if len(counted) >= limit:
            frees = counted[len(counted) - limit] + DAY
            hours = max(1, math.ceil((frees - now) / 3600))
            raise JobError(429, f'You’ve prepared {limit} {noun} in the last 24 hours, the daily limit. Try again in '
                                f'about {hours} {"hour" if hours == 1 else "hours"}.', {'resetsAt': _iso(frees)})

    @staticmethod
    def _row(conn: sqlite3.Connection, job_id: str) -> sqlite3.Row:
        return conn.execute('SELECT rowid AS seq, * FROM jobs WHERE id = ?', (job_id,)).fetchone()

    @staticmethod
    def _owned(conn: sqlite3.Connection, owner: str, job_id: str) -> sqlite3.Row:
        """The member's own job; another member's, or a part of a job, is indistinguishable from a missing one."""
        row = conn.execute('SELECT rowid AS seq, * FROM jobs WHERE id = ? AND owner_id = ? AND parent_id IS NULL',
                           (job_id, owner)).fetchone()
        if row is None:
            raise JobError(404, NOT_FOUND)
        return row

    @staticmethod
    def _active(conn: sqlite3.Connection, owner: str) -> sqlite3.Row | None:
        """The member's one active job (a parent, for a layout in parts)."""
        return conn.execute('SELECT rowid AS seq, * FROM jobs WHERE owner_id = ? AND parent_id IS NULL AND '
                            f'state IN {ACTIVE}', (owner,)).fetchone()

    def _view(self, conn: sqlite3.Connection, row: sqlite3.Row) -> dict:
        """The job as its owner polls it. `position`: how many active jobs are ahead (0 once it runs); `state` is
        `expired` for a succeeded job whose package files have expired; `projectName`: the saved project a layout
        prepares, which the Print step of another project names; `interruptions`: server restarts it went through."""
        position = None
        if row['state'] in ACTIVE:
            position = conn.execute(
                f'SELECT count(*) FROM jobs WHERE parent_id IS NULL AND state IN {ACTIVE} AND '
                '(created_at < ? OR (created_at = ? AND rowid < ?))',
                (row['created_at'], row['created_at'], row['seq'])).fetchone()[0]
            if row['state'] == 'running':
                position = 0
        expires = row['package_id'] and conn.execute('SELECT expires_at FROM receipts WHERE package_id = ?',
                                                     (row['package_id'],)).fetchone()
        state = 'expired' if row['state'] == 'succeeded' and expires and expires[0] <= self.now() else row['state']
        project = row['project_id'] and conn.execute('SELECT name FROM projects WHERE id = ? AND owner_id = ?',
                                                     (row['project_id'], row['owner_id'])).fetchone()
        view = {'id': row['id'], 'kind': row['kind'], 'state': state, 'position': position,
                'stage': row['stage'], 'detail': row['detail'], 'progress': row['progress'],
                'stages': json.loads(row['stages']), 'error': row['error'], 'packageId': row['package_id'],
                'estimate': json.loads(row['estimate']) if row['estimate'] else None,
                'projectId': row['project_id'], 'projectName': project[0] if project else None,
                'interruptions': row['interruptions'],
                'createdAt': _iso(row['created_at']), 'startedAt': _iso(row['started_at']),
                'finishedAt': _iso(row['finished_at']),
                # A running job's cancel takes effect when the worker has stopped its process.
                'cancelling': row['state'] == 'running' and row['cancel_requested_at'] is not None}
        children = conn.execute('SELECT * FROM jobs WHERE parent_id = ? ORDER BY part_index', (row['id'],)).fetchall()
        if children:
            count = len(children)
            view['parts'] = [{'index': child['part_index'], 'state': child['state'], 'stage': child['stage'],
                              'detail': child['detail'], 'progress': child['progress'],
                              'packageId': child['package_id'], 'error': child['error']} for child in children]
            running = next((child for child in children if child['state'] == 'running'), None)
            if running is not None:
                view['stage'] = running['stage']
                view['detail'] = f"Part {running['part_index']} of {count}" + (
                    f" · {running['detail']}" if running['detail'] else '')
            if row['stage'] != 'combine':
                done = sum(1. if child['state'] == 'succeeded' else child['progress'] or 0. for child in children)
                view['progress'] = round(done / count, 4) if row['state'] == 'running' else row['progress']
        return view

    # The worker -----------------------------------------------------------------------------------------------------

    def recover(self) -> None:
        """Interrupt running jobs whose heartbeat is stale (their worker died): requeue each once; a second
        interruption is a system failure."""
        now = self.now()
        with self._write() as conn:
            stale = conn.execute(
                "SELECT * FROM jobs j WHERE state = 'running' AND coalesce(heartbeat_at, started_at, 0) < ? AND "
                "(stage = 'combine' OR NOT EXISTS (SELECT 1 FROM jobs c WHERE c.parent_id = j.id))",
                (now - STALE_AFTER,)).fetchall()
            for row in stale:
                interruptions = row['interruptions'] + 1
                conn.execute("UPDATE jobs SET state = 'interrupted', interruptions = ? WHERE id = ?",
                             (interruptions, row['id']))
                log.warning('Job %s was interrupted (%d)', row['id'], interruptions)
                if interruptions > 1:
                    self._finish(conn, row['id'], 'failed_system',
                                 'Preparing was interrupted twice. Try again later.', now)
                else:
                    conn.execute("UPDATE jobs SET state = 'queued', stage = NULL, detail = NULL, progress = NULL, "
                                 'heartbeat_at = NULL WHERE id = ?', (row['id'],))

    def claim(self) -> str | None:
        """Start the next step, if none is running: the running parent's next part or its combine step, else the
        oldest queued job (or its first part). Returns the job id to run."""
        now = self.now()
        with self._write() as conn:
            while True:
                if conn.execute("SELECT 1 FROM jobs j WHERE state = 'running' AND (stage = 'combine' OR NOT EXISTS "
                                '(SELECT 1 FROM jobs c WHERE c.parent_id = j.id))').fetchone():
                    return None
                job = conn.execute("SELECT * FROM jobs j WHERE parent_id IS NULL AND state = 'running' "
                                   'ORDER BY started_at LIMIT 1').fetchone()
                if job is None:
                    job = conn.execute("SELECT * FROM jobs WHERE parent_id IS NULL AND state = 'queued' "
                                       'ORDER BY created_at, rowid LIMIT 1').fetchone()
                    if job is None:
                        return None
                    conn.execute("UPDATE jobs SET state = 'running', started_at = coalesce(started_at, ?), "
                                 'heartbeat_at = ? WHERE id = ?', (now, now, job['id']))
                children = conn.execute('SELECT * FROM jobs WHERE parent_id = ? ORDER BY part_index',
                                        (job['id'],)).fetchall()
                if not children:
                    return job['id']
                if job['cancel_requested_at'] is not None:
                    self._finish(conn, job['id'], 'cancelled', None, now)
                    continue
                child = next((child for child in children if child['state'] == 'queued'), None)
                if child is not None:
                    conn.execute("UPDATE jobs SET state = 'running', started_at = coalesce(started_at, ?), "
                                 'heartbeat_at = ? WHERE id = ?', (now, now, child['id']))
                    conn.execute('UPDATE jobs SET heartbeat_at = ? WHERE id = ?', (now, job['id']))
                    return child['id']
                if all(child['state'] == 'succeeded' for child in children):
                    conn.execute("UPDATE jobs SET stage = 'combine', heartbeat_at = ? WHERE id = ?", (now, job['id']))
                    return job['id']
                self._finish(conn, job['id'], 'failed_system', 'A part of this layout was lost. Prepare it again.', now)

    def work(self, job_id: str) -> Work:
        with closing(db.connect(self.database)) as conn:
            row = self._row(conn, job_id)
            payload = json.loads(row['manifest'])
            if row['parent_id'] is not None:
                parent = self._row(conn, row['parent_id'])
                count = conn.execute('SELECT count(*) FROM jobs WHERE parent_id = ?', (parent['id'],)).fetchone()[0]
                part = {'index': row['part_index'], 'count': count, 'instanceIds': payload['instanceIds']}
                return Work(job_id, row['owner_id'], row['kind'], payload, json.loads(parent['manifest']), part, None)
            packages = [child['package_id'] for child in conn.execute(
                'SELECT package_id FROM jobs WHERE parent_id = ? ORDER BY part_index', (job_id,))]
            return Work(job_id, row['owner_id'], row['kind'], payload, payload if row['kind'] == 'layout' else None,
                        None, packages or None)

    def abandoned_parts(self, since: int) -> list[str]:
        """The part packages of layouts that ended without combining them (failed or cancelled) since `since`: they
        are only ever an input to their layout's combine step. A package a layout still in progress holds (the same
        layout revision prepared again builds its parts under the same names) is never one of them."""
        with closing(db.connect(self.database)) as conn:
            return [row[0] for row in conn.execute(
                'SELECT c.package_id FROM jobs c JOIN jobs p ON p.id = c.parent_id WHERE c.package_id IS NOT NULL '
                f"AND p.state NOT IN {ACTIVE + ('succeeded',)} AND p.finished_at >= ? AND c.package_id NOT IN "
                '(SELECT l.package_id FROM jobs l JOIN jobs lp ON lp.id = l.parent_id WHERE l.package_id IS NOT NULL '
                f'AND lp.state IN {ACTIVE})', (since,))]

    def progress(self, job_id: str, stage: str, done: int, total: int) -> None:
        """A stage boundary from the package pipeline (`plates.Progress`)."""
        start, weight = STAGES[stage]
        fraction = round(start + weight * (done / total if total else 0.), 4)
        detail = f'{STEPS[stage]} {done + 1} of {total}' if stage in STEPS and done < total else None
        now = self.now()
        with self._write() as conn:
            conn.execute(
                "UPDATE jobs SET stages = CASE WHEN stage IS ? AND stages <> '[]' THEN stages ELSE "
                "json_insert(stages, '$[#]', json_object('stage', ?, 'at', ?)) END, stage = ?, detail = ?, "
                "progress = max(coalesce(progress, 0), ?), heartbeat_at = ? WHERE id = ? AND state = 'running'",
                (stage, stage, _iso(now), stage, detail, fraction, now, job_id))

    def heartbeat(self, job_id: str) -> None:
        now = self.now()
        with self._write() as conn:
            conn.execute('UPDATE jobs SET heartbeat_at = ? WHERE id = ? OR id = (SELECT parent_id FROM jobs WHERE '
                         'id = ?)', (now, job_id, job_id))

    def cancel_requested(self, job_id: str) -> bool:
        with closing(db.connect(self.database)) as conn:
            row = conn.execute('SELECT cancel_requested_at FROM jobs WHERE id = ?', (job_id,)).fetchone()
        return row is not None and row[0] is not None

    def record_package(self, job_id: str, package_id: str) -> None:
        with self._write() as conn:
            conn.execute('UPDATE jobs SET package_id = ? WHERE id = ?', (package_id, job_id))

    def record_error(self, job_id: str, message: str) -> None:
        with self._write() as conn:
            conn.execute('UPDATE jobs SET error = ? WHERE id = ?', (message, job_id))

    def package(self, job_id: str) -> str | None:
        with closing(db.connect(self.database)) as conn:
            return conn.execute('SELECT package_id FROM jobs WHERE id = ?', (job_id,)).fetchone()[0]

    def finish(self, job_id: str, state: str, error: str | None = None) -> None:
        """End a running job (the worker's verdict); `error` replaces any the child recorded."""
        with self._write() as conn:
            self._finish(conn, job_id, state, error, self.now())

    @staticmethod
    def _finish(conn: sqlite3.Connection, job_id: str, state: str, error: str | None, now: int) -> None:
        row = conn.execute('SELECT * FROM jobs WHERE id = ?', (job_id,)).fetchone()
        conn.execute('UPDATE jobs SET state = ?, error = coalesce(?, error), finished_at = ?, heartbeat_at = ? '
                     'WHERE id = ?', (state, error, now, now, job_id))
        if state == 'succeeded':
            conn.execute('UPDATE jobs SET progress = 1 WHERE id = ?', (job_id,))
            return
        # A part that did not succeed ends its layout the same way, and the parts still queued with it.
        parent_id = row['parent_id'] or job_id
        conn.execute("UPDATE jobs SET state = 'cancelled', finished_at = ? WHERE parent_id = ? AND "
                     "state IN ('queued', 'interrupted')", (now, parent_id))
        if row['parent_id'] is not None:
            count = conn.execute('SELECT count(*) FROM jobs WHERE parent_id = ?', (parent_id,)).fetchone()[0]
            message = conn.execute('SELECT error FROM jobs WHERE id = ?', (job_id,)).fetchone()[0]
            conn.execute("UPDATE jobs SET state = ?, error = ?, finished_at = ? WHERE id = ? AND state = 'running'",
                         (state, message and f"Part {row['part_index']} of {count}: {message}", now, parent_id))
