"""The prepare worker (KTD5): claims one job at a time and runs it in a fresh `prepare_job` process in its own session.

`python -m cad.service.worker` runs it on the project directory the API uses (`TRAIN_PROJECT_DIR`, `PLATEWAY_DB`,
`TRAIN_EXPORT_DIR`, and `PLATEWAY_STORAGE_DIR` or the S3 settings of `storage.py`). Hosted, it is its own capped
container; `python -m cad.service.app` runs one in a thread for local development.

While the child runs, the worker keeps the job's heartbeat fresh and watches for a cancel; a cancel or the 90-minute
timeout ends the child's whole process group (the slicer with it). A child killed by SIGKILL while the cgroup's
`oom_kill` count rises ran out of memory: the job is `failed_too_large`.
"""
from __future__ import annotations

from collections.abc import Callable
import logging
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import time

from cad.service import db
from cad.service.jobs import MEMBER_ERROR, Jobs

log = logging.getLogger('cad.service.worker')

TIMEOUT = 90 * 60
# A cancelled child gets this long to clean up after SIGTERM before SIGKILL.
GRACE = 10
HEARTBEAT = 15
FAILED = 'Preparing the print files failed. Try again later.'
TOO_LARGE = ('This layout ran out of memory while preparing: it is too large for one prepare. Split long pieces into '
             'shorter ones, or remove some pieces, and try again.')
TIMED_OUT = 'Preparing took longer than 90 minutes and was stopped. Try again later.'
OOM_EVENTS = Path('/sys/fs/cgroup/memory.events')


def cgroup_oom_kills(events: Path = OOM_EVENTS) -> int | None:
    """The container's `oom_kill` count (cgroup v2), or None where there is no cgroup to read (macOS)."""
    try:
        for line in events.read_text().splitlines():
            key, _, value = line.partition(' ')
            if key == 'oom_kill':
                return int(value)
    except (OSError, ValueError):
        return None
    return None


class Worker:
    def __init__(self, database: Path, exports: Path, storage: Path, *,
                 command: Callable[[str], list[str]] | None = None,
                 oom_kills: Callable[[], int | None] = cgroup_oom_kills, timeout: float = TIMEOUT,
                 poll: float = 1.0, clock: Callable[[], float] = time.time):
        """`storage`: the local storage root, used when no S3 endpoint is configured (`storage.py`)."""
        self.jobs = Jobs(database, clock)
        self.exports = exports
        self.clock = clock
        self.command = command or (lambda job_id: [sys.executable, '-m', 'cad.service.prepare_job', '--database',
                                                   str(database), '--exports', str(exports), '--storage', str(storage),
                                                   job_id])
        self.oom_kills = oom_kills
        self.timeout = timeout
        self.poll = poll

    def run_forever(self, idle: float = 2.0) -> None:
        while True:
            try:
                self.jobs.recover()
                if self.run_once():
                    continue
            except Exception as exc:  # a failing cycle (a locked database) never ends the worker; the next one retries
                log.error('A prepare worker cycle failed', exc_info=exc)
            time.sleep(idle)

    def run_once(self) -> bool:
        """Claim and run the next step; False when there is none."""
        job_id = self.jobs.claim()
        if job_id is None:
            self._remove_abandoned_parts()  # a layout cancelled between its parts ends in `claim`, without a run
            return False
        before = self.oom_kills()
        log.info('Job %s started', job_id)
        child = subprocess.Popen(self.command(job_id), start_new_session=True)
        deadline = time.monotonic() + self.timeout
        beat = time.monotonic()
        stopped = None
        try:
            while True:
                try:
                    code = child.wait(self.poll)
                    break
                except subprocess.TimeoutExpired:
                    pass
                if self.jobs.cancel_requested(job_id):
                    stopped = 'cancelled'
                elif time.monotonic() > deadline:
                    stopped = 'timeout'
                if stopped:
                    code = self._stop(child)
                    break
                if time.monotonic() - beat >= HEARTBEAT:
                    self.jobs.heartbeat(job_id)
                    beat = time.monotonic()
        finally:
            # An error while watching the child stops it rather than leaving it running unwatched; its job's heartbeat
            # goes stale and `recover` requeues it.
            if child.poll() is None:
                self._stop(child)
        state, error = self._verdict(job_id, code, stopped, before)
        if state != 'succeeded':
            self._remove_staging()
        self.jobs.finish(job_id, state, error)
        self._remove_abandoned_parts()
        log.info('Job %s ended %s (exit %s)', job_id, state, code)
        return True

    def _verdict(self, job_id: str, code: int, stopped: str | None, before: int | None) -> tuple[str, str | None]:
        if stopped == 'cancelled':
            return 'cancelled', None
        if stopped == 'timeout':
            return 'failed_system', TIMED_OUT
        if code == 0 and self.jobs.package(job_id):
            return 'succeeded', None
        if code == MEMBER_ERROR:
            return 'failed', None
        after = self.oom_kills()
        if code == -signal.SIGKILL and before is not None and after is not None and after > before:
            return 'failed_too_large', TOO_LARGE
        return 'failed_system', FAILED

    def _stop(self, child: subprocess.Popen) -> int:
        """End the child's process group: SIGTERM, then SIGKILL after the grace period."""
        for sig, wait in ((signal.SIGTERM, GRACE), (signal.SIGKILL, None)):
            try:
                os.killpg(child.pid, sig)
            except ProcessLookupError:
                pass
            try:
                code = child.wait(wait)
                break
            except subprocess.TimeoutExpired:
                continue
        # Anything the child left behind in its group (a slicer that ignored SIGTERM) goes too.
        try:
            os.killpg(child.pid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            pass
        return code

    def _remove_staging(self) -> None:
        """A killed build leaves its staging folder; jobs run one at a time, so any left is a dead job's."""
        if not self.exports.is_dir():
            return
        for entry in self.exports.iterdir():
            if entry.name.startswith('.incomplete-') and entry.is_dir() and not entry.is_symlink():
                shutil.rmtree(entry, ignore_errors=True)

    def _remove_abandoned_parts(self) -> None:
        """Remove the part packages of layouts that failed or were cancelled in the last day; only a layout's combine
        step uses them."""
        for package_id in self.jobs.abandoned_parts(int(self.clock()) - 24 * 3600):
            entry = self.exports / package_id
            if package_id and '/' not in package_id and entry.is_dir() and not entry.is_symlink():
                shutil.rmtree(entry, ignore_errors=True)


def main() -> None:
    logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(name)s: %(message)s')
    root = Path(os.environ.get('TRAIN_PROJECT_DIR', '.projects'))
    database = db.database_path(root)
    db.migrate(database)
    Worker(database, db.export_root(root), db.storage_root(root)).run_forever()


if __name__ == '__main__':
    main()
