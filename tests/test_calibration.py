import json
import uuid

import pytest

from cad.service import db
from cad.service.calibration import BRICK_PROFILE, _conditions, calibration_key
from cad.service.generate import current_request_digest
from cad.service.receipts import Receipts
from cad.service.storage import DAY, PACKAGE_DAYS, open_storage
from signed_in import publish_package, session_headers, signed_in_client

ORIGIN = 'http://127.0.0.1:8765'


class Clock:
    def __init__(self):
        self.now = 1_900_000_000.0

    def __call__(self):
        return self.now


def client(root, name='Member', **options):
    return signed_in_client(root, ORIGIN, email=f'{name.lower()}@example.com', display_name=name, **options)


def snapshot():
    return {'version': 5, 'id': str(uuid.uuid4()), 'revision': str(uuid.uuid4()),
            'layoutRevision': str(uuid.uuid4()), 'name': 'Calibration', 'trackSystem': 'brick-v1',
            'connectorFit': {'adjustmentMm': 0, 'settingsKey': None, 'calibrationId': None},
            'printer': 'X1 Carbon', 'material': 'Bambu PLA Basic',
            'printSettings': {'profile': '0.20mm Standard @BBL X1C', 'nozzleMm': 0.4, 'orientation': 'flat'},
            'partDesign': {}, 'measurements': {}, 'observations': []}


def trial(app, root, project, adjustment=0, *, stale=False, kind='coupon', clock=None):
    """A calibration sample prepared for the signed-in member (`stale`: from CAD sources that changed since), and the
    body that records a result for it."""
    profile = json.loads(BRICK_PROFILE.read_text())
    receipt_id = 'trial-' + uuid.uuid4().hex
    conditions = _conditions(project)
    if project['trackSystem'] == 'brick-v1':
        family = 'brick_end_coupon'
        parameters = {'body_length': profile['sampleLength'], 'connector_version': profile['version'], 'fit_adjustment': adjustment}
    else:
        family = 'connector_coupon'
        parameters = {'body_length': 50, 'body_width': 60, 'base_thickness': 4, 'rail_gauge': 37.5,
                      'rail_width': 4, 'rail_height': 8, 'tongue_length': 8 - (0.25 + adjustment),
                      'tongue_width': 10, 'tongue_height': 3, 'socket_clearance': 0.25 + adjustment, 'socket_depth': 8}
    request = {'version': 1, 'units': 'mm', 'family': family, 'parameters': parameters,
               'part_revision': project['revision'], 'layout_revision': project['layoutRevision'],
               'printer_envelope': {'x': 256, 'y': 256, 'z': 250}}
    receipt = {'id': receipt_id, 'status': 'prepared-digital-only', 'physicalStatus': 'unverified',
               'layoutRevision': project['layoutRevision'],
               'printer': {'name': conditions['printer'], 'material': conditions['material'],
                           'profile': conditions['printProfile'], 'nozzleMm': conditions['nozzleMm'],
                           'orientation': conditions['orientation'], 'envelope': request['printer_envelope']},
               'parts': [{'family': family, 'parameters': parameters, 'request': 'request.json',
                          'partRevision': project['revision'],
                          'requestDigest': '0' * 64 if stale else current_request_digest(request)}]}
    publish_package(app, root, receipt, {'request.json': json.dumps(request).encode()}, kind=kind,
                    **({'clock': clock} if clock else {}))
    return {'project': project, 'receiptId': receipt_id, 'result': 'fits', 'notes': 'Manually printed and fitted'}


def stored_digest(root, receipt_id):
    with db.connect(db.database_path(root)) as conn:
        return conn.execute('SELECT digest FROM receipts WHERE package_id = ?', (receipt_id,)).fetchone()[0]


def test_results_persist_per_member_bound_to_the_receipt_digest_across_projects(tmp_path):
    project = snapshot()
    with client(tmp_path) as app:
        body = trial(app, tmp_path, project)
        digest = stored_digest(tmp_path, body['receiptId'])
        assert app.get('/api/calibrations').json() == []
        assert app.post('/api/calibrations', json=body).status_code == 403
        bad_headers = {**session_headers(app, ORIGIN), 'Origin': 'https://other.example'}
        assert app.post('/api/calibrations', json=body, headers=bad_headers).status_code == 403
        response = app.post('/api/calibrations', json=body, headers=session_headers(app, ORIGIN))
        assert response.status_code == 201, response.text
        saved = response.json()
        assert saved['conditions'] == _conditions(project)
        assert saved['adjustmentMm'] == 0
        assert saved['notes'] == body['notes']
        assert saved['receiptDigest'] == digest
        assert 'physicalStatus' not in saved
        assert app.get('/api/projects').json() == []
        # An unrelated route/project revision does not change a connector's fit conditions.
        project.update(id=str(uuid.uuid4()), revision=str(uuid.uuid4()), layoutRevision=str(uuid.uuid4()))
        body['result'] = 'too-tight'
        second = app.post('/api/calibrations', json=body, headers=session_headers(app, ORIGIN))
        assert second.status_code == 201
        assert second.json()['settingsKey'] == saved['settingsKey']
    with client(tmp_path) as app:
        persisted = app.get('/api/calibrations').json()
        assert {item['result'] for item in persisted} == {'fits', 'too-tight'}
        assert {item['receiptId'] for item in persisted} == {body['receiptId']}
    assert stored_digest(tmp_path, body['receiptId']) == digest
    with client(tmp_path / 'other-workspace') as other:
        assert other.get('/api/calibrations').json() == []


def test_a_member_neither_lists_nor_records_against_another_members_results(tmp_path):
    project = snapshot()
    with client(tmp_path, 'Ada') as ada:
        body = trial(ada, tmp_path, project)
        assert ada.post('/api/calibrations', json=body, headers=session_headers(ada, ORIGIN)).status_code == 201
    with client(tmp_path, 'Bob') as bob:
        assert bob.get('/api/calibrations').json() == []
        assert bob.post('/api/calibrations', json=body, headers=session_headers(bob, ORIGIN)).status_code == 422
        own = trial(bob, tmp_path, project)
        assert bob.post('/api/calibrations', json=own, headers=session_headers(bob, ORIGIN)).status_code == 201
        assert [item['receiptId'] for item in bob.get('/api/calibrations').json()] == [own['receiptId']]
    with client(tmp_path, 'Ada') as ada:
        assert [item['receiptId'] for item in ada.get('/api/calibrations').json()] == [body['receiptId']]


def test_a_result_is_recorded_after_the_samples_files_expired(tmp_path):
    clock = Clock()
    project = snapshot()
    with client(tmp_path, clock=clock) as app:
        body = trial(app, tmp_path, project, clock=clock)
        owner = app.get('/api/auth/me').json()['user']['id']
        storage = open_storage({}, db.storage_root(tmp_path))
        stored = Receipts(db.database_path(tmp_path), storage.packages).get(owner, body['receiptId'])
        storage.packages.delete_prefix(stored.prefix)
        for days in (4, PACKAGE_DAYS - 4):  # visiting in between keeps the session alive
            clock.now += days * DAY
            assert app.get('/api/auth/me').status_code == 200
        assert app.get(f'/api/packages/{body["receiptId"]}').json()['expired']
        response = app.post('/api/calibrations', json=body, headers=session_headers(app, ORIGIN))
        assert response.status_code == 201, response.text
        assert response.json()['receiptDigest'] == stored.digest


@pytest.mark.parametrize('mutation', ['printer', 'material', 'nozzle', 'process', 'orientation', 'track', 'adjustment', 'version', 'forged-key'])
def test_rejects_unbound_results_even_with_a_supplied_settings_key(tmp_path, mutation):
    project = snapshot()
    with client(tmp_path) as app:
        body = trial(app, tmp_path, project)
        if mutation == 'printer':
            project['printer'] = 'A1 mini'
        elif mutation == 'material':
            project['material'] = 'Generic PLA'
        elif mutation == 'nozzle':
            project['printSettings']['nozzleMm'] = 0.6
        elif mutation == 'process':
            project['printSettings']['profile'] = 'Different process'
        elif mutation == 'orientation':
            project['printSettings']['orientation'] = 'side'
        elif mutation == 'track':
            project['trackSystem'] = 'custom-joiner-v1'
        elif mutation == 'version':
            project['trackSystem'] = 'brick-v2'
        elif mutation == 'adjustment':
            project['connectorFit'] = {'adjustmentMm': 0.1, 'calibrationId': None,
                                       'settingsKey': calibration_key(project, _conditions(project), json.loads(BRICK_PROFILE.read_text()))}
        else:
            body['settingsKey'] = 'forged'
        response = app.post('/api/calibrations', json=body, headers=session_headers(app, ORIGIN))
        assert response.status_code == 422, response.text
        assert app.get('/api/calibrations').json() == []


@pytest.mark.parametrize('adjustment', [-0.15, 0.15])
def test_bounds_are_bound_to_exact_coupon_and_stale_adjustment_is_zero(tmp_path, adjustment):
    project = snapshot()
    project['connectorFit'] = {'adjustmentMm': adjustment, 'calibrationId': None,
                              'settingsKey': calibration_key(project, _conditions(project), json.loads(BRICK_PROFILE.read_text()))}
    with client(tmp_path) as app:
        body = trial(app, tmp_path, project, adjustment)
        response = app.post('/api/calibrations', json=body, headers=session_headers(app, ORIGIN))
        assert response.status_code == 201, response.text
        assert response.json()['adjustmentMm'] == adjustment
        project['connectorFit']['settingsKey'] = 'obsolete-process'
        assert app.post('/api/calibrations', json=body, headers=session_headers(app, ORIGIN)).status_code == 422
        zero = trial(app, tmp_path, project, 0)
        response = app.post('/api/calibrations', json=zero, headers=session_headers(app, ORIGIN))
        assert response.status_code == 201
        assert response.json()['adjustmentMm'] == 0
        project['connectorFit']['adjustmentMm'] = adjustment * 1.01
        assert app.post('/api/calibrations', json=zero, headers=session_headers(app, ORIGIN)).status_code == 422


def test_custom_connector_geometry_is_part_of_key_and_receipt_binding(tmp_path):
    project = snapshot()
    project['trackSystem'] = 'custom-joiner-v1'
    project['partDesign'] = {'coupon_body_length': 50, 'joint_width': 10, 'joint_height': 3, 'joint_depth': 8, 'joint_clearance': 0.25}
    project['measurements'] = {key: {'value': None} for key in ('railGauge', 'railBodyWidth', 'railInterfaceWidth', 'railHeight', 'railBaseThickness')}
    with client(tmp_path) as app:
        body = trial(app, tmp_path, project)
        response = app.post('/api/calibrations', json=body, headers=session_headers(app, ORIGIN))
        assert response.status_code == 201, response.text
        assert response.json()['trackSystem'] == 'custom-joiner-v1'
        project['partDesign']['joint_width'] = 11
        assert app.post('/api/calibrations', json=body, headers=session_headers(app, ORIGIN)).status_code == 422


def test_rejects_samples_from_old_cad_sources_and_packages_that_are_not_samples(tmp_path):
    project = snapshot()
    with client(tmp_path) as app:
        for options in ({'stale': True}, {'kind': 'grade'}):
            body = trial(app, tmp_path, project, **options)
            response = app.post('/api/calibrations', json=body, headers=session_headers(app, ORIGIN))
            assert response.status_code == 422, options
        assert app.get('/api/calibrations').json() == []
