"""Import the local file store into one member's account: `<folder>/*.json` saves and `<folder>/calibrations/*.json`.

    uv run python scripts/import-local-projects.py .projects --email alex@example.com [--db path/to/plateway.db]

Each local project becomes a project with a new id; its old id is kept as `legacy_id`, so the browser draft of the same
project adopts it instead of saving a copy. Each save becomes a revision, oldest first, under its own revision id.
Calibration results keep their ids, with no receipt digest (they predate receipts in SQLite). Running it again imports
only what is not imported yet. The local folder is only read. `--db` defaults to the service's database for that folder
(`PLATEWAY_DB`, else `<folder>/plateway.db`).
"""
from __future__ import annotations

import argparse
from datetime import datetime
import json
import os
from pathlib import Path
import re
import stat
import sys
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # run as a file from anywhere: the repository's `cad` package
from cad.service import db  # noqa: E402
from cad.service.calibration import PROCESS_VERSION, TRACK_SYSTEMS, _number  # noqa: E402

SAVE = re.compile(r'([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})-'
                  r'([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.json')


def local_saves(folder: Path) -> dict[str, list[tuple[int, str, dict]]]:
    """Saves by local project id, oldest first: (modified time, revision id, document)."""
    projects: dict[str, list[tuple[int, str, dict]]] = {}
    for path in sorted(folder.iterdir()):
        match = SAVE.fullmatch(path.name)
        if not match or path.is_symlink() or not path.is_file():
            continue
        try:
            body = json.loads(path.read_text(encoding='utf-8'))
            if not isinstance(body, dict) or (body.get('id'), body.get('revision')) != match.groups() or \
                    not isinstance(body.get('name'), str):
                raise ValueError('not a saved project')
            json.dumps(body, allow_nan=False)
        except (OSError, ValueError) as exc:
            print(f'Skipped {path.name}: {exc}', file=sys.stderr)
            continue
        projects.setdefault(match[1], []).append((int(path.stat().st_mtime), match[2], body))
    for saves in projects.values():
        saves.sort(key=lambda save: (save[0], save[1]))
    return projects


def import_projects(conn, owner: str, projects: dict[str, list[tuple[int, str, dict]]]) -> tuple[int, int]:
    """Returns (projects created, revisions added)."""
    created = added = 0
    for legacy_id, saves in sorted(projects.items()):
        row = conn.execute('SELECT id FROM projects WHERE owner_id = ? AND legacy_id = ?', (owner, legacy_id)).fetchone()
        if row is None:
            project_id = str(uuid.uuid4())
            conn.execute('INSERT INTO projects (id, owner_id, name, legacy_id, created_at, updated_at) '
                         'VALUES (?, ?, ?, ?, ?, ?)',
                         (project_id, owner, saves[-1][2]['name'].strip(), legacy_id, saves[0][0], saves[-1][0]))
            created += 1
        else:
            project_id = row['id']
        for modified, revision_id, body in saves:
            if conn.execute('SELECT 1 FROM revisions WHERE id = ?', (revision_id,)).fetchone():
                continue
            latest = conn.execute('SELECT id, number, created_at FROM revisions WHERE project_id = ? '
                                  'ORDER BY number DESC LIMIT 1', (project_id,)).fetchone()
            stored = {**body, 'id': project_id, 'revision': revision_id}
            conn.execute('INSERT INTO revisions (id, project_id, owner_id, number, parent_revision, body, created_at) '
                         'VALUES (?, ?, ?, ?, ?, ?, ?)',
                         (revision_id, project_id, owner, latest['number'] + 1 if latest else 1,
                          latest['id'] if latest else None, json.dumps(stored, ensure_ascii=False, allow_nan=False),
                          modified))
            if latest is None or modified >= latest['created_at']:
                conn.execute('UPDATE projects SET name = ?, updated_at = ? WHERE id = ?',
                             (body['name'].strip(), modified, project_id))
            added += 1
    return created, added


def local_calibrations(directory_fd: int) -> list[dict]:
    """The results in the local `calibrations/` folder that the service accepted, newest first."""
    records = []
    for name in os.listdir(directory_fd):
        if not name.endswith('.json'):
            continue
        try:
            if str(uuid.UUID(name[:-5])) != name[:-5]:
                continue
            fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory_fd)
            with os.fdopen(fd, 'r', encoding='utf-8') as source:
                info = os.fstat(source.fileno())
                if not stat.S_ISREG(info.st_mode) or info.st_size > 2_000_000:
                    continue
                record = json.load(source)
            if (isinstance(record, dict) and record.get('id') == name[:-5] and
                    record.get('calibrationProcessVersion') == PROCESS_VERSION and
                    record.get('trackSystem') in TRACK_SYSTEMS and
                    record.get('result') in ('fits', 'too-tight', 'too-loose') and
                    _number(record.get('adjustmentMm')) and -0.15 <= record['adjustmentMm'] <= 0.15 and
                    all(isinstance(record.get(key), str) for key in ('settingsKey', 'receiptId', 'recordedAt', 'notes')) and
                    isinstance(record.get('conditions'), dict)):
                records.append(record)
        except (OSError, ValueError, TypeError):
            continue
    return sorted(records, key=lambda record: (record['recordedAt'], record['id']), reverse=True)


def import_calibrations(conn, owner: str, folder: Path) -> int:
    """Valid results only (the rules the service listed them by); returns how many were added."""
    if not (folder / 'calibrations').is_dir():
        return 0
    fd = os.open(folder / 'calibrations', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        records = local_calibrations(fd)
    finally:
        os.close(fd)
    added = 0
    for record in sorted(records, key=lambda item: (item['recordedAt'], item['id'])):
        if conn.execute('SELECT 1 FROM calibrations WHERE id = ?', (record['id'],)).fetchone():
            continue
        conn.execute('INSERT INTO calibrations (id, owner_id, settings_key, track_system, result, receipt_id, '
                     'receipt_digest, record, recorded_at) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)',
                     (record['id'], owner, record['settingsKey'], record['trackSystem'], record['result'],
                      record['receiptId'], json.dumps(record, ensure_ascii=False, allow_nan=False),
                      int(datetime.fromisoformat(record['recordedAt']).timestamp())))
        added += 1
    return added


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    parser.add_argument('folder', type=Path, help='the local project folder, usually .projects')
    parser.add_argument('--email', required=True, help="the account's email address")
    parser.add_argument('--db', type=Path, help="the service's SQLite database")
    args = parser.parse_args(argv)
    database = args.db or db.database_path(args.folder)
    db.migrate(database)
    conn = db.connect(database)
    try:
        with db.transaction(conn):
            owner = conn.execute('SELECT id FROM users WHERE email = ?', (args.email.strip(),)).fetchone()
            if owner is None:
                print(f'No account for {args.email}; sign up first.', file=sys.stderr)
                return 1
            created, added = import_projects(conn, owner['id'], local_saves(args.folder))
            results = import_calibrations(conn, owner['id'], args.folder)
    finally:
        conn.close()
    print(f'Imported {created} new projects, {added} saves and {results} calibration results.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
