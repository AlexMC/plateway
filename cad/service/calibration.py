"""User-reported fit results (R27): each member's own, in the owner-scoped `calibrations` table, bound to the digest of
the sample's receipt in SQLite (`receipts.py`, KTD7), so a result can be recorded after the sample's files expired.
Never load evidence."""
from __future__ import annotations

from contextlib import closing
from datetime import datetime, timezone
import json
import math
from pathlib import Path
import uuid

from cad.service import db
from cad.service.errors import UserError
from cad.service.package import sources_current
from cad.service.plates import ENVELOPES
from cad.service.receipts import Receipts

PROCESS_VERSION = 1
# The project format the browser writes (`PROJECT_VERSION` in `src/domain/project.ts`); saves and snapshots must match it.
PROJECT_VERSION = 5
TRACK_SYSTEMS = ('brick-v1', 'custom-joiner-v1')
BRICK_PROFILE = Path(__file__).resolve().parents[1] / 'profiles' / 'brick-v1.json'
CUSTOM_RAIL = {'railBodyWidth': 60, 'railBaseThickness': 4, 'railGauge': 37.5,
               'railInterfaceWidth': 4, 'railHeight': 8}


def _number(value: object) -> bool:
    return type(value) in (int, float) and math.isfinite(value)


def validate_connector_settings(project: dict) -> None:
    fit = project.get('connectorFit')
    if (project.get('trackSystem') not in TRACK_SYSTEMS or not isinstance(fit, dict) or
            set(fit) != {'adjustmentMm', 'settingsKey', 'calibrationId'} or
            not _number(fit['adjustmentMm']) or not -0.15 <= fit['adjustmentMm'] <= 0.15 or
            any(fit[key] is not None and (not isinstance(fit[key], str) or not fit[key])
                for key in ('settingsKey', 'calibrationId'))):
        raise ValueError('Invalid connector fit settings')


def _conditions(project: dict) -> dict:
    settings = project.get('printSettings')
    if not isinstance(settings, dict):
        raise UserError('Choose a material and process in Print → Advanced first.')
    conditions = {'printer': project.get('printer'), 'material': project.get('material'),
                  'nozzleMm': settings.get('nozzleMm'), 'printProfile': settings.get('profile'),
                  'orientation': settings.get('orientation')}
    if (any(not isinstance(conditions[key], str) or not conditions[key].strip()
            for key in ('printer', 'material', 'printProfile', 'orientation')) or
            conditions['printer'] not in ENVELOPES or not _number(conditions['nozzleMm']) or
            conditions['nozzleMm'] <= 0 or conditions['orientation'] != 'flat'):
        raise UserError('Choose a material and process in Print → Advanced first.')
    return conditions


def _custom_parameters(project: dict, adjustment: float) -> dict:
    design, measurements = project.get('partDesign'), project.get('measurements')
    if not isinstance(design, dict) or not isinstance(measurements, dict):
        raise ValueError('Custom connector dimensions are required')
    def dimension(key):
        value = design.get(key)
        if not _number(value) or value <= 0:
            raise ValueError('Custom connector design dimensions must be positive')
        return value
    def rail(key):
        measurement = measurements.get(key)
        if not isinstance(measurement, dict):
            raise ValueError('Custom rail dimensions are required')
        value = measurement.get('value')
        if value is None or measurement.get('status') == 'estimate':
            return CUSTOM_RAIL[key]
        if not _number(value) or value <= 0:
            raise ValueError('Invalid custom rail dimension')
        return value
    clearance = dimension('joint_clearance') + adjustment
    parameters = {'body_length': dimension('coupon_body_length'), 'body_width': rail('railBodyWidth'),
                  'base_thickness': rail('railBaseThickness'), 'rail_gauge': rail('railGauge'),
                  'rail_width': rail('railInterfaceWidth'), 'rail_height': rail('railHeight'),
                  'tongue_length': dimension('joint_depth') - clearance,
                  'tongue_width': dimension('joint_width'), 'tongue_height': dimension('joint_height'),
                  'socket_clearance': clearance, 'socket_depth': dimension('joint_depth')}
    if any(value <= 0 for value in parameters.values()):
        raise ValueError('Custom adjustment leaves no usable connector clearance or insertion')
    return parameters


def _canonical(value):
    # JSON.stringify writes integral numbers without .0; keep the browser/server key identical.
    if isinstance(value, float) and value.is_integer():
        return int(value)
    if isinstance(value, list):
        return [_canonical(item) for item in value]
    return value


def calibration_key(project: dict, conditions: dict, profile: dict) -> str:
    baseline = (sorted([key, value] for key, value in _custom_parameters(project, 0).items())
                if project['trackSystem'] == 'custom-joiner-v1' else None)
    data = ['connector-fit', PROCESS_VERSION, project['trackSystem'],
            profile['version'] if project['trackSystem'] == 'brick-v1' else 1,
            conditions['printer'], conditions['material'], conditions['nozzleMm'],
            conditions['printProfile'], conditions['orientation'], baseline]
    return json.dumps(_canonical(data), ensure_ascii=False, separators=(',', ':'), allow_nan=False)


def record_calibration(database: Path, receipts: Receipts, owner: str, body: dict, now: float) -> dict:
    """Record the member's result for their own calibration sample `receiptId`; another member's sample is
    indistinguishable from a missing one."""
    if set(body) != {'project', 'receiptId', 'result', 'notes'}:
        raise ValueError('Expected project, receiptId, result and notes')
    project = body['project']
    if not isinstance(project, dict) or project.get('version') != PROJECT_VERSION:
        raise ValueError('Calibration requires a current project snapshot')
    validate_connector_settings(project)
    if body['result'] not in ('fits', 'too-tight', 'too-loose'):
        raise ValueError('Invalid fit result')
    if not isinstance(body['notes'], str) or len(body['notes']) > 10000:
        raise ValueError('Notes must be text of at most 10000 characters')
    if not isinstance(body['receiptId'], str):
        raise ValueError('A saved trial receipt is required')
    conditions = _conditions(project)
    profile = json.loads(BRICK_PROFILE.read_text(encoding='utf-8'))
    key = calibration_key(project, conditions, profile)
    fit = project['connectorFit']
    adjustment = fit['adjustmentMm'] if fit['settingsKey'] == key else 0
    brick = project['trackSystem'] == 'brick-v1'
    parameters = ({'body_length': profile['sampleLength'], 'connector_version': profile['version'],
                   'fit_adjustment': adjustment} if brick else _custom_parameters(project, adjustment))
    stored = receipts.get(owner, body['receiptId'])
    if stored is None:
        raise ValueError('No such calibration sample')
    receipt = stored.body
    expected_printer = {'name': conditions['printer'], 'material': conditions['material'],
                        'profile': conditions['printProfile'], 'nozzleMm': conditions['nozzleMm'],
                        'orientation': conditions['orientation'],
                        'envelope': dict(zip(('x', 'y', 'z'), ENVELOPES[conditions['printer']]))}
    parts = receipt.get('parts')
    if (stored.kind != 'coupon' or receipt.get('id') != body['receiptId'] or receipt.get('manifest') or
            receipt.get('status') != 'prepared-digital-only' or receipt.get('physicalStatus') != 'unverified' or
            receipt.get('printer') != expected_printer or not isinstance(parts, list) or len(parts) != 1 or
            not isinstance(parts[0], dict) or parts[0].get('family') != ('brick_end_coupon' if brick else 'connector_coupon') or
            parts[0].get('parameters') != parameters or
            any(not _number(value) for value in parts[0]['parameters'].values()) or
            not sources_current(receipt)):
        raise UserError('This sample doesn’t match your current connector and print settings. Prepare a new sample.')
    record = {'id': str(uuid.uuid4()), 'settingsKey': key, 'trackSystem': project['trackSystem'],
              'adjustmentMm': adjustment, 'result': body['result'], 'notes': body['notes'],
              'receiptId': receipt['id'], 'receiptDigest': stored.digest,
              'recordedAt': datetime.fromtimestamp(now, timezone.utc).isoformat(timespec='microseconds'),
              'conditions': conditions, 'parameters': parameters, 'calibrationProcessVersion': PROCESS_VERSION}
    with closing(db.connect(database)) as conn, db.transaction(conn):
        conn.execute('INSERT INTO calibrations (id, owner_id, settings_key, track_system, result, receipt_id, '
                     'receipt_digest, record, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
                     (record['id'], owner, key, record['trackSystem'], record['result'], record['receiptId'],
                      stored.digest, json.dumps(record, ensure_ascii=False, allow_nan=False), int(now)))
    return record


def list_calibrations(database: Path, owner: str) -> list[dict]:
    """The member's own results, newest first."""
    with closing(db.connect(database)) as conn:
        rows = conn.execute('SELECT record FROM calibrations WHERE owner_id = ? ORDER BY recorded_at DESC, '
                            "json_extract(record, '$.recordedAt') DESC, id DESC", (owner,)).fetchall()
    return [json.loads(row[0]) for row in rows]


