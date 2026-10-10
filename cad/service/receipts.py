"""Package receipts (KTD7, R12). A prepared package is built in the export root, then published: its files go to the
packages bucket under `packages/<owner>/<package id>/`, its receipt to SQLite, and the local copy is removed. The
bucket's lifecycle deletes the files after `PACKAGE_DAYS`; the receipt stays, so the member still sees what was
prepared (as expired, to prepare again) and can still record a calibration result against it.

A receipt's digest is the sha256 of its `receipt.json`; calibration results bind to it (`calibration.py`).
"""
from __future__ import annotations

from collections.abc import Callable
from contextlib import closing
from dataclasses import dataclass
import hashlib
import json
import os
from pathlib import Path
import shutil
import sqlite3
import stat
import time

from cad.service import db
from cad.service.storage import DAY, PACKAGE_DAYS, Bucket


@dataclass(frozen=True)
class Receipt:
    package_id: str
    owner_id: str
    job_id: str | None
    kind: str
    digest: str
    body: dict
    prefix: str
    created_at: int
    expires_at: int

    def expired(self, now: float) -> bool:
        return now >= self.expires_at

    def key(self, artifact: str) -> str:
        return self.prefix + artifact


def _receipt(row: sqlite3.Row) -> Receipt:
    return Receipt(row['package_id'], row['owner_id'], row['job_id'], row['kind'], row['digest'],
                   json.loads(row['body']), row['storage_prefix'], row['created_at'], row['expires_at'])


class Receipts:
    def __init__(self, database: Path, bucket: Bucket, clock: Callable[[], float] = time.time):
        self.database = database
        self.bucket = bucket
        self.clock = clock

    def taken(self, base: str) -> set[str]:
        """Published package ids that are `base` or a variant of it (`<base>-…`): a new build never reuses one, as
        published packages are immutable and their receipts outlive their files."""
        pattern = base.replace('\\', '\\\\').replace('%', '\\%').replace('_', '\\_') + '-%'
        with closing(db.connect(self.database)) as conn:
            return {row[0] for row in conn.execute(
                "SELECT package_id FROM receipts WHERE package_id = ? OR package_id LIKE ? ESCAPE '\\'",
                (base, pattern))}

    def published(self, job_id: str) -> str | None:
        """The package `job_id` has published, if any: a job publishes one package, so a run of it that stopped
        before recording it (`prepare_job`) records this one rather than publishing another."""
        with closing(db.connect(self.database)) as conn:
            row = conn.execute('SELECT package_id FROM receipts WHERE job_id = ? ORDER BY created_at, package_id',
                               (job_id,)).fetchone()
        return row[0] if row is not None else None

    def publish(self, owner: str, job_id: str | None, kind: str, directory: Path) -> Receipt:
        """Upload the package folder (its receipt last), store its receipt and remove the folder, whatever happens:
        a package that could not be published is not kept."""
        try:
            raw = (directory / 'receipt.json').read_bytes()
            body = json.loads(raw)
            if not isinstance(body, dict) or body.get('id') != directory.name:
                raise ValueError('The package receipt does not name its folder')
            prefix = f'packages/{owner}/{directory.name}/'
            files = []
            for folder, subfolders, names in os.walk(directory):
                subfolders.sort()
                for name in sorted(names):
                    path = Path(folder) / name
                    if not stat.S_ISREG(path.lstat().st_mode):
                        raise ValueError(f'Not a regular file in a package: {path.relative_to(directory)}')
                    files.append(path.relative_to(directory).as_posix())
            files.sort(key=lambda name: name == 'receipt.json')
            try:
                for name in files:
                    self.bucket.put_file(prefix + name, directory / name)
                now = int(self.clock())
                stored = Receipt(directory.name, owner, job_id, kind, hashlib.sha256(raw).hexdigest(), body, prefix,
                                 now, now + PACKAGE_DAYS * DAY)
                with closing(db.connect(self.database)) as conn, db.transaction(conn):
                    conn.execute('INSERT INTO receipts (package_id, owner_id, job_id, kind, digest, body, '
                                 'storage_prefix, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
                                 (stored.package_id, owner, job_id, kind, stored.digest, raw.decode(), prefix,
                                  stored.created_at, stored.expires_at))
            except BaseException:
                self.bucket.delete_prefix(prefix)
                raise
            return stored
        finally:
            shutil.rmtree(directory, ignore_errors=True)

    def get(self, owner: str, package_id: str) -> Receipt | None:
        """The member's own receipt; another member's is indistinguishable from a missing one."""
        with closing(db.connect(self.database)) as conn:
            row = conn.execute('SELECT * FROM receipts WHERE package_id = ? AND owner_id = ?',
                               (package_id, owner)).fetchone()
        return _receipt(row) if row is not None else None

    def listed(self, owner: str) -> list[Receipt]:
        with closing(db.connect(self.database)) as conn:
            return [_receipt(row) for row in conn.execute(
                'SELECT * FROM receipts WHERE owner_id = ? ORDER BY package_id', (owner,))]
