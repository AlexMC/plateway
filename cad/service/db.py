"""SQLite access for multi-user state: connections, transactions and ordered schema migrations."""
from __future__ import annotations

from collections.abc import Iterator, Mapping
from contextlib import contextmanager
import os
from pathlib import Path
import sqlite3
import time

MIGRATIONS_DIR = Path(__file__).resolve().parent / 'migrations'
BUSY_TIMEOUT_MS = 5000


def database_path(project_root: Path, environ: Mapping[str, str] = os.environ) -> Path:
    """`PLATEWAY_DB` when set, otherwise `plateway.db` inside the project root."""
    configured = environ.get('PLATEWAY_DB')
    return Path(configured) if configured else project_root / 'plateway.db'


def export_root(project_root: Path, environ: Mapping[str, str] = os.environ) -> Path:
    """Where packages are built before they go to storage: `TRAIN_EXPORT_DIR` when set, otherwise `exports` inside
    the project root."""
    return Path(environ.get('TRAIN_EXPORT_DIR', str(project_root / 'exports'))).absolute()


def storage_root(project_root: Path, environ: Mapping[str, str] = os.environ) -> Path:
    """The local-disk buckets (`storage.py`) when no S3 endpoint is configured: `PLATEWAY_STORAGE_DIR` when set,
    otherwise `storage` inside the project root."""
    return Path(environ.get('PLATEWAY_STORAGE_DIR', str(project_root / 'storage'))).absolute()


def connect(path: Path) -> sqlite3.Connection:
    """A connection in WAL mode with foreign keys and a busy timeout; transactions are explicit (`transaction`)."""
    conn = sqlite3.connect(path, timeout=BUSY_TIMEOUT_MS / 1000, isolation_level=None)
    conn.row_factory = sqlite3.Row
    conn.execute(f'PRAGMA busy_timeout = {BUSY_TIMEOUT_MS}')
    conn.execute('PRAGMA journal_mode = WAL')
    conn.execute('PRAGMA synchronous = NORMAL')
    conn.execute('PRAGMA foreign_keys = ON')
    return conn


@contextmanager
def transaction(conn: sqlite3.Connection) -> Iterator[sqlite3.Connection]:
    """Run the block as one write transaction; the write lock is taken up front so the busy timeout applies."""
    conn.execute('BEGIN IMMEDIATE')
    try:
        yield conn
        conn.execute('COMMIT')
    except BaseException:
        if conn.in_transaction:
            conn.execute('ROLLBACK')
        raise


def schema_version(conn: sqlite3.Connection) -> int:
    conn.execute('CREATE TABLE IF NOT EXISTS schema_version ('
                 'version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)')
    return conn.execute('SELECT coalesce(max(version), 0) FROM schema_version').fetchone()[0]


def _migrations(directory: Path) -> list[tuple[int, Path]]:
    return sorted((int(path.name.split('_', 1)[0]), path) for path in directory.glob('[0-9]*_*.sql'))


def _statements(script: str) -> Iterator[str]:
    """Split a script into single statements; semicolons inside strings, comments and triggers stay put."""
    pending = ''
    for piece in script.split(';'):
        pending += piece + ';'
        if sqlite3.complete_statement(pending):
            yield pending
            pending = ''
    if pending[:-1].strip():
        yield pending[:-1]


def migrate(path: Path, directory: Path = MIGRATIONS_DIR) -> int:
    """Apply pending migrations in order, each atomically with its `schema_version` row; return the version."""
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = connect(path)
    try:
        version = schema_version(conn)
        for number, migration in _migrations(directory):
            if number <= version:
                continue
            with transaction(conn):
                # Another process (api or worker) may have applied it while this one waited for the lock.
                if schema_version(conn) >= number:
                    continue
                for statement in _statements(migration.read_text(encoding='utf-8')):
                    conn.execute(statement)
                conn.execute('INSERT INTO schema_version (version, name, applied_at) VALUES (?, ?, ?)',
                             (number, migration.stem, int(time.time())))
            version = number
        return schema_version(conn)
    finally:
        conn.close()
