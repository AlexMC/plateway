"""Object storage, receipts and expiry (U8, KTD7, R12). The storage contract runs against the local-disk backend, and
against an S3 server too when `PLATEWAY_TEST_S3_ENDPOINT` (with `PLATEWAY_TEST_S3_ACCESS_KEY_ID`,
`PLATEWAY_TEST_S3_SECRET_ACCESS_KEY` and optionally `PLATEWAY_TEST_S3_REGION`) names one: each test gets its own
buckets there."""
from contextlib import closing
from dataclasses import replace
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import threading
import time
import uuid

import httpx
import pytest
from fastapi.testclient import TestClient

from cad.service import db, prepare_job
from cad.service.app import create_app
from cad.service.jobs import Jobs
from cad.service.receipts import Receipts
from cad.service.storage import (DAY, PACKAGE_DAYS, ExpiryRule, MissingObject, StorageError, check_rules,
                                 library_reader, main as storage_main, open_storage, parse_wrangler_lifecycle)
from signed_in import PASSWORD, publish_package, session_headers, signed_in_client
from test_jobs import coupon

ORIGIN = 'http://127.0.0.1:8765'
S3 = os.environ.get('PLATEWAY_TEST_S3_ENDPOINT')


class Clock:
    def __init__(self):
        self.now = time.time()

    def __call__(self):
        return self.now


@pytest.fixture(params=['local', 's3'])
def storage(request, tmp_path):
    """Fresh buckets on each backend. Lifecycle rules are not part of the contract: R2's are checked at deploy time
    (`check-r2`), a local bucket applies its own."""
    if request.param == 'local':
        yield open_storage({}, tmp_path / 'storage')
        return
    if not S3:
        pytest.skip('No S3 server: set PLATEWAY_TEST_S3_ENDPOINT')
    suffix = uuid.uuid4().hex[:12]
    environ = {'PLATEWAY_S3_ENDPOINT': S3, 'PLATEWAY_S3_REGION': os.environ.get('PLATEWAY_TEST_S3_REGION', 'auto'),
               'PLATEWAY_S3_ACCESS_KEY_ID': os.environ['PLATEWAY_TEST_S3_ACCESS_KEY_ID'],
               'PLATEWAY_S3_SECRET_ACCESS_KEY': os.environ['PLATEWAY_TEST_S3_SECRET_ACCESS_KEY'],
               **{f'PLATEWAY_{role}_BUCKET': f'test-{role.lower()}-{suffix}' for role in ('PACKAGES', 'LIBRARY', 'BACKUPS')}}
    opened = open_storage(environ, tmp_path / 'unused')
    for bucket in (opened.packages, opened.library, opened.backups):
        bucket.client.create_bucket(Bucket=bucket.name)
    yield opened
    for bucket in (opened.packages, opened.library, opened.backups):
        for page in bucket.client.get_paginator('list_objects_v2').paginate(Bucket=bucket.name):
            for item in page.get('Contents', []):
                bucket.client.delete_object(Bucket=bucket.name, Key=item['Key'])
        bucket.client.delete_bucket(Bucket=bucket.name)


def fetch(storage, root: Path, url: str) -> httpx.Response:
    """Follow a presigned link: R2 (S3) serves its own; the API serves the local backend's."""
    if not url.startswith('/'):
        return httpx.get(url)
    with TestClient(create_app(root, allowed_origin=ORIGIN, storage=storage), base_url=ORIGIN) as app:
        return app.get(url)


# Storage contract ---------------------------------------------------------------------------------------------------


def test_objects_round_trip_and_a_prefix_is_deleted_whole(storage, tmp_path):
    bucket = storage.packages
    source = tmp_path / 'plate.gcode'
    source.write_bytes(b'G1 X1\n' * 1000)
    bucket.put_file('packages/u1/p1/plate-01/plate_1.gcode', source)
    bucket.put_bytes('packages/u1/p1/receipt.json', b'{"id": "p1"}')
    bucket.put_bytes('packages/u1/p10/receipt.json', b'{"id": "p10"}')
    with bucket.open('packages/u1/p1/plate-01/plate_1.gcode') as stream:
        assert stream.read() == source.read_bytes()
    assert bucket.exists('packages/u1/p1/receipt.json')
    assert bucket.delete_prefix('packages/u1/p1/') == 2
    assert not bucket.exists('packages/u1/p1/receipt.json')
    with pytest.raises(MissingObject):
        bucket.open('packages/u1/p1/plate-01/plate_1.gcode')
    with bucket.open('packages/u1/p10/receipt.json') as stream:  # a prefix is a folder, not a name start
        assert stream.read() == b'{"id": "p10"}'


@pytest.mark.parametrize('key', ['../outside', 'packages/../x', 'packages//x', '/packages/x', 'packages/x/', '',
                                 'packages/x y'])
def test_keys_that_could_escape_are_refused(storage, key):
    with pytest.raises(ValueError):
        storage.packages.put_bytes(key, b'x')
    with pytest.raises(ValueError):
        storage.packages.presign(key, 'x')


def test_a_presigned_link_downloads_the_object_under_its_name_and_only_while_valid(storage, tmp_path):
    bucket = storage.packages
    bucket.put_bytes('packages/u1/p1/plate-01/plate_1.gcode', b'G1 X1\n')
    good = fetch(storage, tmp_path, bucket.presign('packages/u1/p1/plate-01/plate_1.gcode', 'plate_1.gcode'))
    assert good.status_code == 200 and good.content == b'G1 X1\n'
    assert good.headers['content-disposition'] == 'attachment; filename="plate_1.gcode"'
    link = bucket.presign('packages/u1/p1/plate-01/plate_1.gcode', 'plate_1.gcode')
    assert fetch(storage, tmp_path, link.replace('plate_1.gcode?', 'plate_2.gcode?')).status_code in (403, 404)
    assert fetch(storage, tmp_path, link[:-4] + ('0000' if not link.endswith('0000') else '1111')).status_code in (403, 404)
    short = bucket.presign('packages/u1/p1/plate-01/plate_1.gcode', 'plate_1.gcode', seconds=1)
    time.sleep(2.1)
    assert fetch(storage, tmp_path, short).status_code in (403, 404)


def test_the_library_is_public_at_one_fixed_url_served_locally_and_redirected_to_its_bucket_on_s3(tmp_path):
    local = open_storage({}, tmp_path / 'storage')
    local.library.put_bytes('index.json', b'{"format": 1, "items": []}')
    local.library.put_bytes('pieces/community_a/1/piece.stl', b'stl')
    with TestClient(create_app(tmp_path / 'service', allowed_origin=ORIGIN, storage=local), base_url=ORIGIN) as app:
        index = app.get('/api/library/index.json')
        assert index.status_code == 200 and index.json() == {'format': 1, 'items': []}
        assert index.headers['content-type'].startswith('application/json')
        assert app.get('/api/library/pieces/community_a/1/piece.stl').content == b'stl'
        for missing in ('/api/library/nothing.json', '/api/library/pieces/%2E%2E/index.json', '/api/library/'):
            assert app.get(missing).status_code == 404
        # The other buckets are never reachable through it.
        local.packages.put_bytes('packages/u1/p1/receipt.json', b'{}')
        assert app.get('/api/library/packages/u1/p1/receipt.json').status_code == 404

    class PublicBucket:  # hosted, the api's token cannot read the bucket's lifecycle rules: it never asks
        name = 'plateway-library'

    hosted = replace(local, library=PublicBucket())
    with TestClient(create_app(tmp_path / 'hosted', allowed_origin=ORIGIN, storage=hosted,
                               library_url='https://library.plateway.example/'), base_url=ORIGIN) as app:
        moved = app.get('/api/library/index.json', follow_redirects=False)
        assert moved.status_code == 302 and moved.headers['location'] == 'https://library.plateway.example/index.json'
    with TestClient(create_app(tmp_path / 'unset', allowed_origin=ORIGIN, storage=hosted), base_url=ORIGIN) as app:
        assert app.get('/api/library/index.json', follow_redirects=False).status_code == 404


class Quiet(SimpleHTTPRequestHandler):
    def log_message(self, *_):
        pass


def serve(folder: Path) -> ThreadingHTTPServer:
    """`folder` over HTTP on loopback, on the first free port of 8880–8899, as a public bucket's URL serves it."""
    for port in range(8880, 8900):
        try:
            server = ThreadingHTTPServer(('127.0.0.1', port), partial(Quiet, directory=str(folder)))
        except OSError:
            continue
        threading.Thread(target=server.serve_forever, daemon=True).start()
        return server
    pytest.skip('No free port in 8880-8899')


def test_a_prepare_reads_the_library_from_its_public_url_when_hosted_and_from_the_folder_locally(tmp_path):
    local = open_storage({}, tmp_path / 'storage')
    assert library_reader({}, local) is local.library
    local.library.put_bytes('pieces/community_a/1/piece.stl', b'stl')
    server = serve(local.library.objects)
    try:
        # Hosted, the library bucket is on R2 and the worker's token can't read it; its public URL can be.
        hosted = replace(local, library=object())
        reader = library_reader({'PLATEWAY_LIBRARY_URL': f'http://127.0.0.1:{server.server_port}/'}, hosted)
        with reader.open('pieces/community_a/1/piece.stl') as source:
            assert source.read() == b'stl'
        with pytest.raises(MissingObject):
            reader.open('pieces/community_a/1/other.stl')
        with pytest.raises(ValueError):
            reader.open('pieces/../index.json')
        with pytest.raises(StorageError, match='PLATEWAY_LIBRARY_URL'):
            library_reader({}, hosted)
    finally:
        server.shutdown()
        server.server_close()


def test_a_local_bucket_applies_its_own_lifecycle_when_opened(tmp_path):
    storage = open_storage({}, tmp_path / 'storage')
    assert storage.library.expiry_rules() == []
    assert storage.packages.expiry_rules() == [ExpiryRule('', PACKAGE_DAYS)]
    for bucket in (storage.packages, storage.library):
        bucket.put_bytes('packages/u1/p1/old.gcode', b'old')
        bucket.put_bytes('packages/u1/p1/new.gcode', b'new')
        old = time.time() - (PACKAGE_DAYS + 1) * DAY
        os.utime(bucket.objects / 'packages/u1/p1/old.gcode', (old, old))
    reopened = open_storage({}, tmp_path / 'storage')
    assert not reopened.packages.exists('packages/u1/p1/old.gcode')
    assert reopened.packages.exists('packages/u1/p1/new.gcode')
    assert reopened.library.exists('packages/u1/p1/old.gcode')  # the library never expires


# The R2 lifecycle check run before each deploy (`check-r2`), on the text `wrangler r2 bucket lifecycle list` prints.

# Captured from wrangler 4.54.0 on 2026-10-09.
PACKAGES_LISTING = """
 ⛅️ wrangler 4.54.0 (update available 4.149.0)
──────────────────────────────────────────────
Listing lifecycle rules for bucket 'plateway-packages'...
name:     Default Multipart Abort Rule
enabled:  Yes
prefix:   (all prefixes)
action:   Abort incomplete multipart uploads after 7 days

name:     expire-after-7-days
enabled:  Yes
prefix:   (all prefixes)
action:   Expire objects after 7 days
"""
LIBRARY_LISTING = """
 ⛅️ wrangler 4.54.0 (update available 4.149.0)
──────────────────────────────────────────────
Listing lifecycle rules for bucket 'plateway-library'...
name:     Default Multipart Abort Rule
enabled:  Yes
prefix:   (all prefixes)
action:   Abort incomplete multipart uploads after 7 days
"""
# wrangler 4.54.0's message for a bucket without rules (r2 bucket lifecycle list, in its source).
EMPTY_LISTING = """
 ⛅️ wrangler 4.54.0
──────────────────────────────────────────────
Listing lifecycle rules for bucket 'plateway-library'...
There are no lifecycle rules for bucket 'plateway-library'.
"""


def listing(bucket: str, *rules: tuple[str, str, str, str]) -> str:
    blocks = '\n\n'.join(f'name:     {name}\nenabled:  {enabled}\nprefix:   {prefix}\naction:   {action}'
                         for name, enabled, prefix, action in rules)
    return f"Listing lifecycle rules for bucket '{bucket}'...\n{blocks}\n"


def test_wrangler_listings_parse_to_the_expiry_rules_they_hold():
    assert parse_wrangler_lifecycle(PACKAGES_LISTING, 'plateway-packages') == [ExpiryRule('', PACKAGE_DAYS)]
    assert parse_wrangler_lifecycle(LIBRARY_LISTING, 'plateway-library') == []
    assert parse_wrangler_lifecycle(EMPTY_LISTING, 'plateway-library') == []
    assert parse_wrangler_lifecycle(listing(
        'b', ('dated', 'Yes', 'packages/', 'Expire objects on 2027-01-01'),
        ('off', 'No', '(all prefixes)', 'Expire objects after 1 days'),
        ('both', 'Yes', 'tmp/', 'Expire objects after 30 days, Abort incomplete multipart uploads after 1 days'),
        ('cold', 'Yes', '(all prefixes)', 'Transition to Infrequent Access after 30 days'),
        ('none', 'Yes', '(all prefixes)', '(none)')), 'b') == [ExpiryRule('packages/', None), ExpiryRule('tmp/', 30)]


@pytest.mark.parametrize('output', [
    listing('b', ('odd', 'Yes', '(all prefixes)', 'Delete objects after 7 days')),
    listing('b', ('odd', 'Yes', '(all prefixes)', 'Expire objects after 0.5 days')),
    listing('b', ('odd', 'Yes', '(all prefixes)', 'Expire objects ')),
    listing('b', ('odd', 'Maybe', '(all prefixes)', 'Expire objects after 7 days')),
    "Listing lifecycle rules for bucket 'b'...\nname:     half\nenabled:  Yes\n",
    "Listing lifecycle rules for bucket 'b'...\nsomething else\n",
    "Listing lifecycle rules for bucket 'other'...\nThere are no lifecycle rules for bucket 'other'.\n",
    '',
], ids=['unknown action', 'fractional days', 'unknown condition', 'unknown enabled', 'incomplete rule',
        'unknown line', 'another bucket', 'empty'])
def test_a_listing_it_does_not_understand_fails_closed(output):
    with pytest.raises(StorageError, match="'b'"):
        parse_wrangler_lifecycle(output, 'b')


def test_the_library_never_expires_and_packages_expire_after_seven_days():
    week = ExpiryRule('', PACKAGE_DAYS)
    check_rules([], [week])
    check_rules([], [ExpiryRule('packages/', PACKAGE_DAYS)])
    with pytest.raises(StorageError, match='plateway-library has an expiry rule'):
        check_rules([ExpiryRule('', 30)], [week])
    with pytest.raises(StorageError, match='plateway-library'):
        check_rules([ExpiryRule('pieces/', None)], [week])
    for packages in ([], [ExpiryRule('', 30)], [ExpiryRule('other/', PACKAGE_DAYS)], [week, ExpiryRule('', 30)],
                     [week, ExpiryRule('tmp/', None)]):
        with pytest.raises(StorageError, match='plateway-packages needs one lifecycle rule'):
            check_rules([], packages)
    with pytest.raises(StorageError, match='renamed-packages'):
        check_rules([], [], library_name='renamed-library', packages_name='renamed-packages')


def fake_npx(tmp_path, monkeypatch, outputs: dict[str, str], failing: str = ''):
    """`npx` on PATH answering `npx wrangler r2 bucket lifecycle list <bucket>` with `outputs[bucket]`."""
    for bucket, output in outputs.items():
        (tmp_path / f'{bucket}.txt').write_text(output)
    script = tmp_path / 'bin' / 'npx'
    script.parent.mkdir()
    script.write_text(f'#!/bin/sh\n[ "$6" = "{failing}" ] && {{ echo "The specified bucket does not exist." >&2; '
                      f'exit 1; }}\ncat "{tmp_path}/$6.txt"\n')
    script.chmod(0o755)
    monkeypatch.setenv('PATH', f'{script.parent}{os.pathsep}{os.environ["PATH"]}')


def test_check_r2_prints_ok_only_when_both_buckets_rules_are_right(tmp_path, monkeypatch, capsys):
    fake_npx(tmp_path, monkeypatch, {'plateway-packages': PACKAGES_LISTING, 'plateway-library': LIBRARY_LISTING,
                                     'swapped-packages': LIBRARY_LISTING.replace('plateway-library', 'swapped-packages')})
    assert storage_main(['check-r2']) == 0
    assert capsys.readouterr().out.strip() == 'OK'
    assert storage_main(['check-r2', '--packages', 'swapped-packages']) == 1
    printed = capsys.readouterr()
    assert 'OK' not in printed.out and 'swapped-packages needs one lifecycle rule' in printed.err


def test_check_r2_fails_closed_when_wrangler_fails(tmp_path, monkeypatch, capsys):
    fake_npx(tmp_path, monkeypatch, {'plateway-packages': PACKAGES_LISTING}, failing='plateway-library')
    assert storage_main(['check-r2']) == 1
    printed = capsys.readouterr()
    assert 'OK' not in printed.out and 'The specified bucket does not exist.' in printed.err
    monkeypatch.setenv('PATH', str(tmp_path / 'empty'))  # no npx at all
    assert storage_main(['check-r2']) == 1
    assert 'npx' in capsys.readouterr().err


def test_a_link_planted_in_a_local_bucket_is_never_followed(tmp_path):
    storage = open_storage({}, tmp_path / 'storage')
    outside = tmp_path / 'private.txt'
    outside.write_bytes(b'private')
    folder = storage.packages.objects / 'packages' / 'u1' / 'p1'
    folder.mkdir(parents=True)
    (folder / 'plate.3mf').symlink_to(outside)
    (storage.packages.objects / 'packages' / 'u2').symlink_to(folder.parent, target_is_directory=True)
    for key in ('packages/u1/p1/plate.3mf', 'packages/u2/p1/receipt.json'):
        assert not storage.packages.exists(key)
        with pytest.raises(MissingObject):
            storage.packages.open(key)


# Receipts and downloads ---------------------------------------------------------------------------------------------


def member(root: Path, name: str = 'Ada', **options):
    return signed_in_client(root, ORIGIN, email=f'{name.lower()}@example.com', display_name=name, **options)


def layout_receipt(package_id: str) -> tuple[dict, dict[str, bytes]]:
    receipt = {'id': package_id, 'status': 'prepared-digital-only', 'manifest': 'manifest.json',
               'partRevision': 'r1', 'layoutRevision': 'l1', 'printer': {'name': 'A1 mini'},
               'plates': [{'plate': 1, 'model': 'plate-01/plate-01.3mf', 'project': 'plate-01/project.3mf',
                           'gcode': 'plate-01/plate_1.gcode'}],
               'parts': [{'printMesh': 'plate-01/1-straight.stl'}],
               'assemblyGuide': 'assembly-guide.md', 'assemblyGuidePdf': 'assembly-guide.pdf'}
    files = {'manifest.json': b'{}', 'plate-01/plate-01.3mf': b'plain', 'plate-01/project.3mf': b'bambu',
             'plate-01/plate_1.gcode': b'G1 X1\n', 'plate-01/1-straight.stl': b'solid', 'assembly-guide.md': b'# Guide',
             'assembly-guide.pdf': b'%PDF guide'}
    return receipt, files


def fake_trial(files: dict[str, bytes]):
    """`export_trial` without CAD or slicing: installs a package folder as the real one does."""
    def export(root: Path, parts, printer, progress, taken):
        package_id = f'trial-{uuid.uuid4().hex}'
        receipt = {'id': package_id, 'status': 'prepared-digital-only', 'physicalStatus': 'unverified',
                   'partRevision': 'r1', 'layoutRevision': 'l1', 'printer': printer, 'parts': parts, 'plates': []}
        for name, data in {**files, 'receipt.json': json.dumps(receipt).encode()}.items():
            (root / package_id / name).parent.mkdir(parents=True, exist_ok=True)
            (root / package_id / name).write_bytes(data)
        return receipt, True
    return export


def test_a_prepared_package_goes_to_storage_and_its_receipt_outlives_its_files(tmp_path, monkeypatch):
    clock = Clock()
    database, exports = db.database_path(tmp_path), db.export_root(tmp_path)
    monkeypatch.setattr(prepare_job, 'export_trial', fake_trial({'plate-01/plate_1.gcode': b'G1 X1\n'}))
    with member(tmp_path, clock=clock) as app:
        headers = session_headers(app, ORIGIN)
        job = app.post('/api/jobs', json=coupon(), headers=headers).json()
        jobs = Jobs(database, clock)
        assert jobs.claim() == job['id']
        storage = open_storage({}, db.storage_root(tmp_path))
        assert prepare_job.run(jobs, Receipts(database, storage.packages, clock), exports, job['id']) == 0
        jobs.finish(job['id'], 'succeeded')
        package_id = app.get(f'/api/jobs/{job["id"]}').json()['packageId']
        assert not (exports / package_id).exists()
        owner = app.get('/api/auth/me').json()['user']['id']
        assert storage.packages.exists(f'packages/{owner}/{package_id}/receipt.json')

        [listed] = app.get('/api/packages').json()
        assert listed['id'] == package_id and listed['calibrationSample'] and not listed['expired']
        link = app.get(f'/api/packages/{package_id}/files/plate-01/plate_1.gcode', follow_redirects=False)
        assert link.status_code == 307 and link.headers['location'].startswith('/api/storage/plateway-packages/')
        assert app.get(link.headers['location']).content == b'G1 X1\n'

        # The bucket's lifecycle deletes the files after 7 days; the receipt stays, expired.
        storage.packages.delete_prefix(f'packages/{owner}/{package_id}/')
        for days in (4, PACKAGE_DAYS - 4):  # visiting in between keeps the session alive
            clock.now += days * DAY
            assert app.get('/api/auth/me').status_code == 200
        receipt = app.get(f'/api/packages/{package_id}')
        assert receipt.status_code == 200 and receipt.json()['expired'] and receipt.json()['id'] == package_id
        assert app.get('/api/packages').json()[0]['expired']
        assert app.get(f'/api/jobs/{job["id"]}').json()['state'] == 'expired'
        expired = app.get(f'/api/packages/{package_id}/files/plate-01/plate_1.gcode', follow_redirects=False)
        assert expired.status_code == 410 and 'Prepare them again' in expired.json()['detail']

        again = app.post(f'/api/packages/{package_id}/prepare', headers=headers)
        assert again.status_code == 202, again.text
        assert again.json()['id'] != job['id'] and again.json()['kind'] == 'coupon'
        assert again.json()['state'] == 'queued'


def test_another_members_package_is_not_found(tmp_path):
    receipt, files = layout_receipt(f'{uuid.uuid4()}-{uuid.uuid4()}')
    with member(tmp_path) as ada:
        publish_package(ada, tmp_path, receipt, files)
        assert ada.get(f'/api/packages/{receipt["id"]}/plates.zip').status_code == 200
    with member(tmp_path, 'Bob') as bo:
        assert bo.get('/api/packages').json() == []
        for path in ('', '/plates.zip', '/stls.zip', '/assembly-guide.pdf', '/files/plate-01/plate_1.gcode'):
            response = bo.get(f'/api/packages/{receipt["id"]}{path}', follow_redirects=False)
            assert response.status_code == 404, path
        assert bo.post(f'/api/packages/{receipt["id"]}/prepare', headers=session_headers(bo, ORIGIN)).status_code == 404


def test_the_guide_and_archives_stream_from_storage(tmp_path):
    receipt, files = layout_receipt(f'{uuid.uuid4()}-{uuid.uuid4()}')
    with member(tmp_path) as app:
        stored = publish_package(app, tmp_path, receipt, files)
        guide = app.get(f'/api/packages/{receipt["id"]}/assembly-guide.pdf')
        assert guide.status_code == 200 and guide.content == b'%PDF guide'
        open_storage({}, db.storage_root(tmp_path)).packages.delete_prefix(stored.prefix)
        assert app.get(f'/api/packages/{receipt["id"]}/assembly-guide.pdf').status_code == 404
        assert app.get(f'/api/packages/{receipt["id"]}/plates.zip').status_code == 404


def test_deleting_an_account_deletes_its_package_files(tmp_path):
    receipt, files = layout_receipt(f'{uuid.uuid4()}-{uuid.uuid4()}')
    with member(tmp_path) as app:
        stored = publish_package(app, tmp_path, receipt, files)
        deleted = app.request('DELETE', '/api/account', json={'password': PASSWORD}, headers=session_headers(app, ORIGIN))
        assert deleted.status_code == 200, deleted.text
    assert not open_storage({}, db.storage_root(tmp_path)).packages.exists(stored.key('receipt.json'))


def downloads(root: Path) -> list[tuple]:
    with closing(db.connect(db.database_path(root))) as conn:
        return [tuple(row) for row in conn.execute('SELECT package_id, owner_id, kind, at FROM package_downloads ORDER BY id')]


def test_each_successful_download_is_recorded_against_its_package_and_member(tmp_path):
    clock = Clock()
    receipt, files = layout_receipt(f'{uuid.uuid4()}-{uuid.uuid4()}')
    package = receipt['id']
    with member(tmp_path, clock=clock) as ada:
        stored = publish_package(ada, tmp_path, receipt, files, clock=clock)
        owner = ada.get('/api/auth/me').json()['user']['id']
        assert ada.get(f'/api/packages/{package}/plates.zip').status_code == 200
        assert ada.get(f'/api/packages/{package}/stls.zip').status_code == 200
        link = ada.get(f'/api/packages/{package}/files/plate-01/plate_1.gcode', follow_redirects=False)
        assert link.status_code == 307
        assert ada.get(link.headers['location']).status_code == 200  # following the link is not a second download
        assert ada.get(f'/api/packages/{package}/assembly-guide.pdf').status_code == 200
        at = int(clock.now)
        assert downloads(tmp_path) == [(package, owner, 'zip', at), (package, owner, 'zip', at),
                                       (package, owner, 'file', at), (package, owner, 'file', at)]
        # Refused downloads record nothing: an unsafe path, missing files, another member's package, expired files.
        assert ada.get(f'/api/packages/{package}/files/..%2Freceipt.json', follow_redirects=False).status_code == 404
        open_storage({}, db.storage_root(tmp_path)).packages.delete_prefix(stored.prefix)
        assert ada.get(f'/api/packages/{package}/plates.zip').status_code == 404
        assert ada.get(f'/api/packages/{package}/assembly-guide.pdf').status_code == 404
    with member(tmp_path, 'Bob', clock=clock) as bob:
        assert bob.get(f'/api/packages/{package}/plates.zip').status_code == 404
        assert bob.get(f'/api/packages/{package}/files/plate-01/plate_1.gcode', follow_redirects=False).status_code == 404
    clock.now += (PACKAGE_DAYS + 1) * DAY
    with member(tmp_path, clock=clock) as ada:
        assert ada.get(f'/api/packages/{package}/plates.zip').status_code == 410
    assert len(downloads(tmp_path)) == 4


def test_deleting_an_account_deletes_its_downloads_and_no_one_elses(tmp_path):
    ada_receipt, files = layout_receipt(f'{uuid.uuid4()}-{uuid.uuid4()}')
    bob_receipt, _ = layout_receipt(f'{uuid.uuid4()}-{uuid.uuid4()}')
    with member(tmp_path, 'Bob') as bob:
        publish_package(bob, tmp_path, bob_receipt, files)
        assert bob.get(f'/api/packages/{bob_receipt["id"]}/plates.zip').status_code == 200
    with member(tmp_path) as ada:
        publish_package(ada, tmp_path, ada_receipt, files)
        assert ada.get(f'/api/packages/{ada_receipt["id"]}/plates.zip').status_code == 200
        assert ada.get(f'/api/packages/{ada_receipt["id"]}/files/plate-01/plate_1.gcode',
                       follow_redirects=False).status_code == 307
        assert len(downloads(tmp_path)) == 3
        deleted = ada.request('DELETE', '/api/account', json={'password': PASSWORD}, headers=session_headers(ada, ORIGIN))
        assert deleted.status_code == 200, deleted.text
    assert [row[0] for row in downloads(tmp_path)] == [bob_receipt['id']]
