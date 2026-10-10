"""Publishing the community library (KTD9, R19): merged submissions go into the public-read `plateway-library` bucket
and its `index.json` (README, "Community library"), and Alex retires or removes items from the quick look.

An item lives under `<folder>/<id>/<version>/` (`pieces`, `trains` or `furniture`), with the same paths in the bucket
and in the library repository, where the bot also commits the item's `metadata.json` for the pull-request check
(`library-repo/`). Publishing copies the merged file to the bucket, adds or replaces the item's entry in the index
(its credit snapshot is the contributor's display name, with "adapted from" the source's authors for a piece or train
adapted from a CC BY model, and its digest the file's sha256), records it in `library_items` and drops the
submission's copy of the file. The index is read, changed and written back under one lock, so entries the service did
not write (the sample library, say) stay.

Items are retired, not deleted: a retired item stays in the index and the bucket, and the app keeps showing it in
layouts that use it. A merged item whose files later disappear from the repository (a revert) is retired too.
Removing an item (a takedown) turns its index entry into a tombstone, deletes its files from the bucket, and leaves
`repo_removed_at` unset so the bot deletes them from the repository's current tree (`github_app.py`).
"""
from __future__ import annotations

from collections.abc import Callable, Iterable
from contextlib import closing
import json
import logging
from pathlib import Path
import threading
import time

from fastapi import Depends, FastAPI, HTTPException
from fastapi.concurrency import run_in_threadpool

from cad.library import check
from cad.service import db
from cad.service.accounts import Session
from cad.service.storage import INDEX_FORMAT, INDEX_KEY, Bucket, MissingObject

log = logging.getLogger('cad.service.library_publish')

FOLDERS = {'piece': 'pieces', 'train': 'trains', 'furniture': 'furniture'}
NOUNS = {'piece': 'piece', 'train': 'train model', 'furniture': 'furniture preset'}
METADATA_FILE = 'metadata.json'
# Every item a submission publishes is its first version: an upload always takes a new library id.
FIRST_VERSION = 1
CREDIT_MAX = 120
NOT_FOUND = 'There is no such library item.'


class LibraryError(Exception):
    def __init__(self, status: int, detail: str):
        super().__init__(detail)
        self.status = status
        self.detail = detail


def item_folder(kind: str, item_id: str, version: int | None = None) -> str:
    """`pieces/<id>/` (every version), or `pieces/<id>/<version>/`; the same in the bucket and the repository."""
    return f'{FOLDERS[kind]}/{item_id}/' + (f'{version}/' if version is not None else '')


def credit(author: str, metadata: dict) -> str:
    """The credit snapshot: the display name, and for a model adapted from another CC BY model its authors."""
    source = metadata.get('source')
    text = f'{author}, adapted from {", ".join(source["authors"])}' if isinstance(source, dict) else author
    return text if len(text) <= CREDIT_MAX else text[:CREDIT_MAX - 1].rstrip() + '…'


def repo_metadata(metadata: dict) -> dict:
    """The item's `metadata.json` in the repository: what `check.py` checks, without the furniture form's inputs."""
    return {key: value for key, value in metadata.items() if key != 'design'}


def repo_files(submission: dict) -> dict[str, bytes]:
    """What the bot commits for an approved submission (`Submissions.awaiting_pull_request`): its file and metadata."""
    folder = item_folder(submission['kind'], submission['metadata']['id'], FIRST_VERSION)
    metadata = json.dumps(repo_metadata(submission['metadata']), ensure_ascii=False, allow_nan=False, indent=2) + '\n'
    return {folder + submission['file']: submission['data'], folder + METADATA_FILE: metadata.encode()}


def index_entry(kind: str, metadata: dict, *, author: str, licence: str, file_name: str, digest: str) -> dict:
    item_id = metadata['id']
    entry = {'id': item_id, 'version': FIRST_VERSION, 'kind': kind, 'state': 'live', 'name': metadata['name'],
             'licence': licence, 'credit': credit(author, metadata),
             'file': item_folder(kind, item_id, FIRST_VERSION) + file_name, 'digest': digest}
    if kind == 'piece':
        entry['piece'] = {'ends': metadata['ends']}
    elif kind == 'train':
        entry['train'] = {key: metadata[key] for key in ('year', 'power', 'gauge', 'car')}
    if kind != 'furniture' and metadata.get('source') is not None:
        entry[kind]['source'] = metadata['source']
    return entry


# The columns of an index entry that `library_items` keeps in its own columns; the rest is its `metadata`.
_COLUMNS = ('id', 'version', 'kind', 'state', 'digest', 'licence', 'credit')


def _tombstone(kind: str, item_id: str, version: int) -> dict:
    return {'id': item_id, 'version': version, 'kind': kind, 'state': 'removed'}


class Library:
    def __init__(self, database: Path, bucket: Bucket, clock: Callable[[], float] = time.time):
        self.database = database
        self.bucket = bucket
        self.clock = clock
        self._index_lock = threading.Lock()

    def _connect(self):
        return closing(db.connect(self.database))

    # ------------------------------------------------------------------------------------------------- the index

    def _read_index(self) -> dict:
        try:
            with self.bucket.open(INDEX_KEY) as source:
                index = json.loads(source.read())
        except MissingObject:
            return {'format': INDEX_FORMAT, 'items': []}
        if not isinstance(index, dict) or index.get('format') != INDEX_FORMAT or not isinstance(index.get('items'), list):
            # Never overwrite an index this code doesn't understand: the app would lose every item in it.
            raise LibraryError(500, 'The library index is not in a format this service writes.')
        return index

    def _put_entries(self, entries: Iterable[dict]) -> None:
        """Replace each entry's item in the index (matched by id), or append it."""
        with self._index_lock:
            index = self._read_index()
            items = index['items']
            for entry in entries:
                at = next((n for n, item in enumerate(items) if isinstance(item, dict) and item.get('id') == entry['id']), None)
                if at is None:
                    items.append(entry)
                else:
                    items[at] = entry
            self.bucket.put_bytes(INDEX_KEY, (json.dumps(index, ensure_ascii=False, allow_nan=False, indent=2) + '\n').encode())

    @staticmethod
    def _entry(row) -> dict:
        """A `library_items` row as its index entry."""
        extra = json.loads(row['metadata'])
        return {'id': row['id'], 'version': row['version'], 'kind': row['kind'], 'state': row['state'],
                'name': extra.pop('name'), 'licence': row['licence'], 'credit': json.loads(row['credit']),
                'file': extra.pop('file'), 'digest': row['digest'], **extra}

    # ----------------------------------------------------------------------------------------------- publishing

    def publish(self, submission_id: str) -> dict:
        """Publish a merged submission: its file into the bucket, its entry into the index, its row into
        `library_items`. Safe to repeat after a failure part-way."""
        now = int(self.clock())
        with self._connect() as conn:
            row = conn.execute('SELECT s.id, s.kind, s.state, s.author_name, s.licence, s.metadata, s.file_digest, '
                               'f.name, f.data FROM submissions s LEFT JOIN submission_files f ON f.submission_id = s.id '
                               'WHERE s.id = ?', (submission_id,)).fetchone()
        if row is None or row['state'] != 'merged':
            raise LibraryError(409, 'Only a merged submission is published.')
        if row['data'] is None:
            raise LibraryError(409, 'The merged submission has no file to publish.')
        metadata = json.loads(row['metadata'])
        entry = index_entry(row['kind'], metadata, author=row['author_name'], licence=row['licence'],
                            file_name=row['name'], digest=row['file_digest'])
        self.bucket.put_bytes(entry['file'], bytes(row['data']))
        self._put_entries([entry])
        extra = {key: value for key, value in entry.items() if key not in _COLUMNS}
        with self._connect() as conn, db.transaction(conn):
            conn.execute('INSERT INTO library_items (id, version, kind, state, digest, licence, credit, metadata, '
                         "submission_id, created_at, updated_at) VALUES (?, ?, ?, 'live', ?, ?, ?, ?, ?, ?, ?) "
                         'ON CONFLICT (id, version) DO NOTHING',
                         (entry['id'], entry['version'], entry['kind'], entry['digest'], entry['licence'],
                          json.dumps(entry['credit'], ensure_ascii=False), json.dumps(extra, ensure_ascii=False),
                          submission_id, now, now))
            # The bucket and the repository hold the file now.
            conn.execute('DELETE FROM submission_files WHERE submission_id = ?', (submission_id,))
        log.info('Published library item %s from submission %s', entry['id'], submission_id)
        return entry

    def unpublished(self) -> list[str]:
        """Merged submissions not yet in the library, oldest first."""
        with self._connect() as conn:
            return [row[0] for row in conn.execute(
                "SELECT s.id FROM submissions s WHERE s.state = 'merged' AND NOT EXISTS "
                '(SELECT 1 FROM library_items l WHERE l.submission_id = s.id) ORDER BY s.updated_at, s.id')]

    # ------------------------------------------------------------------------------------- retiring and removing

    def _items(self, conn, item_id: str) -> list:
        rows = conn.execute('SELECT * FROM library_items WHERE id = ? ORDER BY version', (item_id,)).fetchall()
        if not rows:
            raise LibraryError(404, NOT_FOUND)
        return rows

    def _audit(self, conn, kind: str, admin: str | None, now: int, detail: dict) -> None:
        conn.execute('INSERT INTO audit_events (at, kind, user_id, detail) VALUES (?, ?, ?, ?)',
                     (now, kind, admin, json.dumps(detail)))

    def retire(self, admin: str | None, item_id: str, *, why: str = 'admin') -> dict:
        """Take a live item out of the palette; layouts that use it keep it (KTD9)."""
        now = int(self.clock())
        with self._connect() as conn:
            rows = self._items(conn, item_id)
        latest = rows[-1]
        if latest['state'] != 'live':
            raise LibraryError(409, 'Only a live item can be retired.')
        self._put_entries([self._entry(latest) | {'state': 'retired'}])
        with self._connect() as conn, db.transaction(conn):
            conn.execute("UPDATE library_items SET state = 'retired', updated_at = ? WHERE id = ? AND state = 'live'",
                         (now, item_id))
            self._audit(conn, 'library_retired', admin, now, {'item': item_id, 'why': why})
        log.info('Retired library item %s (%s)', item_id, why)
        return self.item(item_id)

    def remove(self, admin: str, item_id: str) -> dict:
        """A takedown: the index keeps a tombstone, the files leave the bucket now and the repository's current tree
        when the bot next runs."""
        now = int(self.clock())
        with self._connect() as conn:
            rows = self._items(conn, item_id)
        latest = rows[-1]
        if latest['state'] == 'removed':
            raise LibraryError(409, 'This item was already removed.')
        # The tombstone first, so the app stops loading the files before they go.
        self._put_entries([_tombstone(latest['kind'], item_id, latest['version'])])
        self.bucket.delete_prefix(item_folder(latest['kind'], item_id))
        with self._connect() as conn, db.transaction(conn):
            conn.execute("UPDATE library_items SET state = 'removed', updated_at = ? WHERE id = ?", (now, item_id))
            self._audit(conn, 'library_removed', admin, now, {'item': item_id})
        log.info('Admin %s removed library item %s', admin, item_id)
        return self.item(item_id)

    def item(self, item_id: str) -> dict:
        with self._connect() as conn:
            latest = self._items(conn, item_id)[-1]
        return {'id': latest['id'], 'version': latest['version'], 'kind': latest['kind'], 'state': latest['state']}

    def retire_missing(self, paths: set[str]) -> list[str]:
        """Retire every live published item whose file is gone from the repository's tree (`paths`): its merge was
        reverted."""
        with self._connect() as conn:
            rows = conn.execute("SELECT id, metadata FROM library_items WHERE state = 'live' AND submission_id IS NOT NULL "
                                'ORDER BY id').fetchall()
        gone = [row['id'] for row in rows if json.loads(row['metadata']).get('file') not in paths]
        for item_id in gone:
            self.retire(None, item_id, why='reverted')
        return gone

    def owed_repo_removals(self) -> list[tuple[str, str]]:
        """Removed items whose files the bot still has to delete from the repository: (id, folder)."""
        with self._connect() as conn:
            rows = conn.execute("SELECT DISTINCT id, kind FROM library_items WHERE state = 'removed' "
                                'AND repo_removed_at IS NULL ORDER BY id').fetchall()
        return [(row['id'], item_folder(row['kind'], row['id'])) for row in rows]

    def repo_removed(self, item_id: str) -> None:
        now = int(self.clock())
        with self._connect() as conn, db.transaction(conn):
            conn.execute("UPDATE library_items SET repo_removed_at = ? WHERE id = ? AND state = 'removed'", (now, item_id))


def register(app: FastAPI, library: Library, *, admin: Callable[..., Session], changed: Callable[[], None]) -> None:
    """`/api/admin/library/<id>/retire` and `/remove` for the quick look; `changed()` wakes the bot after a removal."""

    async def call(work, *args):
        try:
            return await run_in_threadpool(work, *args)
        except LibraryError as exc:
            raise HTTPException(status_code=exc.status, detail=exc.detail) from None

    def library_id(item_id: str) -> str:
        if not check.LIBRARY_ID.fullmatch(item_id):
            raise HTTPException(status_code=404, detail=NOT_FOUND)
        return item_id

    @app.post('/api/admin/library/{item_id}/retire')
    async def retire(item_id: str, session: Session = Depends(admin)):
        return await call(library.retire, session.member.id, library_id(item_id))

    @app.post('/api/admin/library/{item_id}/remove')
    async def remove(item_id: str, session: Session = Depends(admin)):
        result = await call(library.remove, session.member.id, library_id(item_id))
        changed()
        return result
