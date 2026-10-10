"""Migration 010 moves stored ids to the brick names; this test, like the migration, names the old values."""
import json
import re
import shutil

from cad.service import db
from cad.service.accounts import HASHER
from cad.service.calibration import BRICK_PROFILE, _conditions, calibration_key
from signed_in import EMAIL, PASSWORD, session_headers, signed_in_client

ORIGIN = 'http://127.0.0.1:8765'
OLD = {'system': 'lego-compatible-v1', 'straight': 'lego_straight_nominal', 'curve': 'lego_curve_r40',
       'flex': 'lego_flex', 'left': 'lego_switch_left', 'right': 'lego_switch_right', 'crossing': 'lego_crossing90',
       'crossover': 'lego_double_crossover', 'printed': 'printed_lego_straight', 'coupon': 'lego_end_coupon',
       'coupon_id': 'lego-end-coupon', 'owned': 'owned-lego', 'profile': 'lego-compatible', 'category': 'lego',
       'coupling': 'lego-coupling-unfitted'}
NEW = {'system': 'brick-v1', 'straight': 'brick_straight_nominal', 'curve': 'brick_curve_r40',
       'flex': 'brick_flex', 'left': 'brick_switch_left', 'right': 'brick_switch_right', 'crossing': 'brick_crossing90',
       'crossover': 'brick_double_crossover', 'printed': 'printed_brick_straight', 'coupon': 'brick_end_coupon',
       'coupon_id': 'brick-end-coupon', 'owned': 'owned', 'profile': 'brick', 'category': 'brick',
       'coupling': 'brick-coupling-unfitted'}
PROJECT, REVISION, CALIBRATION = '6f1c2a3e-0000-4000-8000-000000000001', '6f1c2a3e-0000-4000-8000-000000000002', 'cal-1'
# Member text that mentions an old id keeps its words: only quoted JSON tokens are ids.
NOTE = 'Fits my lego_flex and "lego_curve_r40" pieces'
SETTINGS = {'printer': 'X1 Carbon', 'material': 'Bambu PLA Basic',
            'printSettings': {'profile': '0.20mm Standard @BBL X1C', 'nozzleMm': 0.4, 'orientation': 'flat'}}


def settings_key(system):
    """The calibration settings key as `calibration.py` and `src/domain/calibration.ts` wrote it for this setup."""
    return json.dumps(['connector-fit', 1, system, 1, 'X1 Carbon', 'Bambu PLA Basic', 0.4, '0.20mm Standard @BBL X1C',
                       'flat', None], separators=(',', ':'))


def project(ids):
    pieces = [{'id': f'p{index}', 'family': ids[name], 'x': index * 128, 'y': 0, 'rotation': 0}
              for index, name in enumerate(('straight', 'curve', 'flex', 'left', 'right', 'crossing', 'crossover',
                                            'printed'))]
    return {'version': 5, 'id': PROJECT, 'revision': REVISION, 'name': NOTE, 'parentRevision': None,
            'trackSystem': ids['system'], **SETTINGS,
            'connectorFit': {'adjustmentMm': 0.05, 'settingsKey': settings_key(ids['system']), 'calibrationId': CALIBRATION},
            'routes': [{'id': 'main', 'pieces': pieces}], 'measurements': {}, 'furniture': [], 'partDesign': {},
            'observations': [{'note': NOTE}],
            'inventory': {ids['straight']: 16, ids['curve']: 8, ids['left']: 1, ids['right']: 1}}


def manifest(ids):
    port = {'pose': {'x': 0, 'y': 0, 'z': 0, 'heading': 0, 'pitch': 0}, 'profile': ids['profile'], 'railGauge': 40,
            'interfaceWidth': 2.4}
    return {'project': project(ids),
            'instances': [{'id': 'p0', 'family': ids['straight'], 'source': ids['owned'], 'ports': [port, port]},
                          {'id': 'p7', 'family': ids['printed'], 'source': 'printed', 'ports': [port, port]}],
            'billOfMaterials': [{'family': ids['straight'], 'source': ids['owned'], 'count': 1, 'instanceIds': ['p0']}],
            'issues': [{'code': ids['coupling'], 'severity': 'error'}],
            'hardware': {'lines': [{'category': ids['category'], 'name': 'Bluetooth 4-port hub (88012)', 'quantity': 1}]}}


def receipt(ids):
    return {'id': 'trial-1', 'status': 'prepared-digital-only', 'physicalStatus': 'unverified',
            'parts': [{'id': ids['coupon_id'], 'family': ids['coupon'],
                       'parameters': {'body_length': 24, 'connector_version': 1, 'fit_adjustment': 0.05}}],
            'hardware': {'lines': [{'category': ids['category'], 'name': 'Friction pin (2780)', 'quantity': 4}]}}


def record(ids):
    return {'id': CALIBRATION, 'settingsKey': settings_key(ids['system']), 'trackSystem': ids['system'],
            'adjustmentMm': 0.05, 'result': 'fits', 'notes': NOTE, 'receiptId': 'trial-1', 'receiptDigest': 'd1',
            'recordedAt': '2030-01-01T00:00:00.000000+00:00'}


def version_9_database(root):
    """A database at schema version 9 holding one member's data in the old format, written as the service wrote it."""
    before = root / 'before'
    before.mkdir()
    for path in db.MIGRATIONS_DIR.glob('00[1-9]_*.sql'):
        shutil.copy(path, before)
    path = db.database_path(root)
    assert db.migrate(path, before) == 9
    conn = db.connect(path)
    with db.transaction(conn):
        conn.execute('INSERT INTO users (id, email, password_hash, display_name, email_verified_at, created_at) '
                     "VALUES ('alice', ?, ?, 'Member', 0, 0)", (EMAIL, HASHER.hash(PASSWORD)))
        conn.execute("INSERT INTO projects (id, owner_id, name, created_at, updated_at) VALUES (?, 'alice', ?, 0, 0)",
                     (PROJECT, NOTE))
        conn.execute("INSERT INTO revisions (id, project_id, owner_id, number, body, created_at) "
                     "VALUES (?, ?, 'alice', 1, ?, 0)", (REVISION, PROJECT, json.dumps(project(OLD), ensure_ascii=False)))
        conn.execute("INSERT INTO gallery_layouts (id, owner_id, title, body, author_name, published_at) "
                     "VALUES ('g1', 'alice', 'Shared', ?, 'Member', 0)", (json.dumps(project(OLD), ensure_ascii=False),))
        conn.execute("INSERT INTO jobs (id, owner_id, kind, state, project_id, revision_id, manifest, created_at) "
                     "VALUES ('j1', 'alice', 'layout', 'succeeded', ?, ?, ?, 0)",
                     (PROJECT, REVISION, json.dumps(manifest(OLD))))
        conn.execute("INSERT INTO receipts (package_id, owner_id, kind, digest, body, storage_prefix, created_at, "
                     "expires_at) VALUES ('trial-1', 'alice', 'coupon', 'd1', ?, 'packages/alice/trial-1/', 0, 9000000000)",
                     (json.dumps(receipt(OLD), sort_keys=True, indent=2) + '\n',))
        conn.execute("INSERT INTO calibrations (id, owner_id, settings_key, track_system, result, receipt_id, "
                     "receipt_digest, record, recorded_at) VALUES (?, 'alice', ?, ?, 'fits', 'trial-1', 'd1', ?, 0)",
                     (CALIBRATION, settings_key(OLD['system']), OLD['system'],
                      json.dumps(record(OLD), ensure_ascii=False)))
        for table, power in (('submissions', 'PF'), ('library_items', 'PU')):
            metadata = json.dumps({'name': 'Cargo', 'year': 2014, 'power': power, 'gauge': 'standard'})
            if table == 'submissions':
                conn.execute("INSERT INTO submissions (id, owner_id, kind, state, author_name, licence, metadata, "
                             "attested_at, created_at, updated_at) VALUES ('s1', 'alice', 'train', 'awaiting_look', "
                             "'Member', 'CC-BY-4.0', ?, 0, 0, 0)", (metadata,))
            else:
                conn.execute("INSERT INTO library_items (id, version, kind, state, digest, licence, credit, metadata, "
                             "created_at, updated_at) VALUES ('community_cargo', 1, 'train', 'live', 'd', 'CC-BY-4.0', "
                             "'{}', ?, 0, 0)", (metadata,))
    conn.close()
    return path


def test_a_version_9_database_moves_to_the_brick_ids_and_keeps_the_fit_adjustment(tmp_path):
    path = version_9_database(tmp_path)
    assert db.migrate(path) >= 10
    conn = db.connect(path)
    one = lambda sql: json.loads(conn.execute(sql).fetchone()[0])
    assert one('SELECT body FROM revisions') == project(NEW)
    assert one('SELECT body FROM gallery_layouts') == project(NEW)
    assert one('SELECT manifest FROM jobs') == manifest(NEW)
    assert one('SELECT body FROM receipts') == receipt(NEW)
    assert one('SELECT record FROM calibrations') == record(NEW)
    assert tuple(conn.execute('SELECT settings_key, track_system, receipt_digest FROM calibrations').fetchone()) == (
        settings_key('brick-v1'), 'brick-v1', 'd1')
    assert conn.execute('SELECT digest FROM receipts').fetchone()[0] == 'd1'
    assert one('SELECT metadata FROM submissions')['power'] == 'IR'
    assert one('SELECT metadata FROM library_items')['power'] == 'BT'
    assert not conn.execute("SELECT name FROM sqlite_temp_master").fetchall()
    stored = ''.join(row[0] for row in conn.execute(
        'SELECT body FROM revisions UNION ALL SELECT manifest FROM jobs UNION ALL SELECT body FROM receipts '
        'UNION ALL SELECT settings_key || record FROM calibrations'))
    # The only old words left are the member's own text.
    assert re.sub(r'lego_flex and \\"lego_curve_r40\\"', '', stored).lower().count('lego') == 0
    conn.close()

    # The app opens the project with the adjustment still bound to its setup, lists the result, and saves it again.
    with signed_in_client(tmp_path, ORIGIN) as app:
        [listed] = app.get('/api/projects').json()
        opened = app.get(f'/api/projects/{listed["id"]}/{listed["revision"]}').json()
        assert opened['trackSystem'] == 'brick-v1' and opened['routes'] == project(NEW)['routes']
        assert opened['connectorFit']['adjustmentMm'] == 0.05
        assert opened['connectorFit']['settingsKey'] == calibration_key(
            opened, _conditions(opened), json.loads(BRICK_PROFILE.read_text()))
        [result] = app.get('/api/calibrations').json()
        assert (result['settingsKey'], result['trackSystem']) == (opened['connectorFit']['settingsKey'], 'brick-v1')
        saved = app.post(f'/api/projects/{listed["id"]}/revisions', json={**opened, 'parentRevision': listed['revision']},
                         headers=session_headers(app, ORIGIN))
        assert saved.status_code == 201, saved.text
