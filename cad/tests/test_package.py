"""A synthetic digital print job tests real Bambu slicing, not physical train acceptance."""

import copy
from functools import cache
import hashlib
import json
import math
import os
from pathlib import Path
import re
import sys
import tempfile
import uuid
import xml.etree.ElementTree as ET
import zipfile

import numpy as np
import pytest
import trimesh

from cad.service.combine import combine_parts
from cad.service.errors import UserError
from cad.service.generate import generate_part
from cad.service.package import (PRINTS_AS_UPLOADED, export_package, geometry_fingerprint, install_no_replace, safe_file,
                                 validate_manifest)
from cad.service.plates import END_REACH, RAIL_BAND
from cad.service.storage import LocalBucket


def manifest():
    project_id, revision, layout = (str(uuid.uuid4()) for _ in range(3))
    parameters = {'run': 80, 'body_width': 30, 'base_thickness': 4,
                  'rail_gauge': 16, 'rail_interface_width': 2, 'rail_height': 2,
                  'joint_width': 6, 'joint_depth': 5, 'joint_height': 2, 'joint_clearance': .2}
    def pose(x):
        return {'x': x, 'y': 0, 'z': 0, 'heading': 0, 'pitch': 0}
    def port(x):
        return {'pose': pose(x), 'profile': 'brick', 'railGauge': 16, 'interfaceWidth': 2}
    instance_id = 'upper:0:printed_straight:0'
    instance = {'id': instance_id, 'routeId': 'upper', 'sectionId': instance_id,
                'family': 'printed_straight', 'parameters': parameters, 'pose': pose(0),
                'interfaceKind': 'rail', 'startPort': port(0), 'endPort': port(80),
                'source': 'printed', 'status': 'unverified', 'geometryAvailable': True, 'quantity': 1}
    return {'version': 1, 'units': 'mm',
            'project': {'id': project_id, 'revision': revision, 'layoutRevision': layout,
                        'name': 'Synthetic unverified crossing'},
            'printer': {'name': 'A1 mini', 'material': 'Bambu PLA Basic',
                        'profile': '0.20mm Standard @BBL A1M', 'nozzleMm': .4,
                        'orientation': 'flat', 'envelope': {'x': 180, 'y': 180, 'z': 180}},
            'mounting': 'reversible',
            'routes': [
                {'id': 'upper', 'name': 'Upper', 'points': [{'id': 'a'}, {'id': 'b'}]},
                {'id': 'lower', 'name': 'Lower', 'points': [{'id': 'c'}, {'id': 'd'}]}],
            'crossings': [{'id': 'x', 'upperRouteId': 'upper', 'lowerRouteId': 'lower'}],
            'cars': [],
            'instances': [instance], 'requiredPrintedInstanceIds': [instance_id],
            'billOfMaterials': [{'source': 'printed', 'family': 'printed_straight',
                                 'count': 1, 'instanceIds': [instance_id]}],
            'mountingSiteChecks': [], 'warnings': ['Synthetic; no physical print']}


def ordinary_manifest():
    request = manifest()
    request['project']['name'] = 'Unverified ordinary brick track'
    request['routes'] = request['routes'][:1]
    request['crossings'] = []
    rail = request['instances'][0]
    rail['parameters'] = {'run': 80, 'body_width': 63.8, 'base_thickness': 3.2,
                          'rail_gauge': 40, 'rail_interface_width': 2.4, 'rail_height': 6.4,
                          'connector_version': 1, 'fit_adjustment': 0}
    for port in (rail['startPort'], rail['endPort']):
        port.update(railGauge=40, interfaceWidth=2.4)
    return request


def turnout_manifest():
    request = ordinary_manifest()
    part = request['instances'][0]
    part.pop('startPort')
    part.pop('endPort')
    part.update(family='printed_switch_right', interfaceKind='track-assembly',
                parameters={'connector_version': 1, 'fit_adjustment': 0, 'bend': 0, 'switch_state': 0},
                ports=[
                    {'id': ident, 'pose': {'x': x, 'y': y, 'z': 0, 'heading': heading, 'pitch': 0},
                     'profile': 'brick', 'railGauge': 40, 'interfaceWidth': 2.4}
                    for ident, x, y, heading in (
                        ('in', 0, 0, math.pi), ('out', 256, 0, 0),
                        ('branch', 261.5408, -103.6412, -math.pi/8))],
                paths=[{'id': 'main', 'from': 'in', 'to': 'out', 'enabled': True},
                       {'id': 'branch', 'from': 'in', 'to': 'branch', 'enabled': False}])
    request['billOfMaterials'][0]['family'] = part['family']
    return request


@pytest.mark.parametrize('mutation', ['missing-port', 'wrong-position', 'wrong-heading', 'both-routes', 'state-mismatch', 'wrong-source'])
def test_turnout_package_rejects_forged_interfaces_before_creating_artifacts(tmp_path, mutation):
    request = turnout_manifest()
    part = request['instances'][0]
    if mutation == 'missing-port':
        part['ports'].pop()
    elif mutation == 'wrong-position':
        part['ports'][2]['pose']['x'] += 1
    elif mutation == 'wrong-heading':
        part['ports'][0]['pose']['heading'] = 0
    elif mutation == 'both-routes':
        part['paths'][1]['enabled'] = True
    elif mutation == 'state-mismatch':
        part['parameters']['switch_state'] = 1
    else:
        part['source'] = 'owned'
    with pytest.raises(ValueError):
        export_package(tmp_path, request)
    assert not list(tmp_path.iterdir())


@pytest.mark.parametrize('make_manifest', [manifest, ordinary_manifest], ids=['crossing', 'ordinary'])
def test_real_slice_reconciles_generated_mesh_and_project(tmp_path, make_manifest):
    request = make_manifest()
    frozen_request = copy.deepcopy(request)
    receipt, created = export_package(tmp_path, request)
    assert created
    assert receipt['id'] == f"{request['project']['id']}-{request['project']['layoutRevision']}"
    assert [part['instanceId'] for part in receipt['parts']] == request['requiredPrintedInstanceIds']
    assert [item['instanceId'] for plate in receipt['plates'] for item in plate['objects']] == request['requiredPrintedInstanceIds']
    assert receipt['parts'][0]['digest'] != receipt['parts'][0]['requestDigest']
    root = tmp_path / receipt['id']
    assert json.loads((root / 'manifest.json').read_text()) == frozen_request
    assert request == frozen_request
    for artifact in ('source', 'mesh'):
        assert (root / receipt['parts'][0][artifact]).is_file()
    plate = receipt['plates'][0]
    with zipfile.ZipFile(root / plate['project']) as project:
        assert 'Metadata/project_settings.config' in project.namelist()
    assert (root / plate['gcode']).stat().st_size > 0
    # The plain 3MF for other slicers places every labelled part exactly where the Bambu slice put it.
    with zipfile.ZipFile(root / plate['model']) as plain:
        model = ET.fromstring(plain.read('3D/3dmodel.model'))
    core = '{http://schemas.microsoft.com/3dmanufacturing/core/2015/02}'
    objects = {node.get('id'): node for node in model.iter(f'{core}object')}
    sliced = {obj['name']: obj['bbox'] for obj in plate['slice']['objects']}
    items = list(model.find(f'{core}build'))
    assert sorted(objects[item.get('objectid')].get('name') for item in items) == sorted(sliced)
    for item in items:
        offset = [float(value) for value in item.get('transform').split()[9:]]
        low = [min(float(vertex.get(axis)) for vertex in objects[item.get('objectid')].iter(f'{core}vertex')) + offset[index]
               for index, axis in enumerate('xyz')]
        box = sliced[objects[item.get('objectid')].get('name')]
        assert low == pytest.approx([box['x'], box['y'], 0], abs=.01)
    assert (root / 'assembly-guide.md').read_text().startswith('# Shopping list\n')


def _snapshot(folder: Path) -> dict:
    return {path.relative_to(folder): path.read_bytes() for path in folder.rglob('*') if path.is_file()}


def test_repreparing_reuses_a_current_package_and_never_touches_a_stale_one(tmp_path):
    request = ordinary_manifest()
    first, created = export_package(tmp_path, request)
    assert created
    renamed = copy.deepcopy(request)
    renamed['project'].update(revision=str(uuid.uuid4()), name='Renamed; same track')
    again, created = export_package(tmp_path, renamed)
    assert not created
    assert again['id'] == first['id'] and again['plates'] == first['plates']
    assert again['cadSourceCurrent'] is True
    old = tmp_path / first['id']
    saved = json.loads((old / 'receipt.json').read_text())
    saved['parts'][0]['requestDigest'] = '0' * 64  # as if built from older CAD sources
    (old / 'receipt.json').write_text(json.dumps(saved))
    before = _snapshot(old)
    project = renamed['project']
    parts = [{**renamed['instances'][0], 'part_revision': project['revision'], 'layout_revision': project['layoutRevision']}]
    interrupted = tmp_path / f"{first['id']}-{geometry_fingerprint(parts, renamed['printer'])[:8]}"
    interrupted.mkdir()  # a crashed earlier rebuild keeps its name
    rebuilt, created = export_package(tmp_path, renamed)
    assert created and rebuilt['cadSourceCurrent'] is True
    assert rebuilt['id'].startswith(f'{interrupted.name}-') and rebuilt['layoutRevision'] == first['layoutRevision']
    assert _snapshot(old) == before
    assert not list(interrupted.iterdir())
    assert json.loads((tmp_path / rebuilt['id'] / 'manifest.json').read_text()) == renamed
    reused, created = export_package(tmp_path, renamed)
    assert not created and reused['id'] == rebuilt['id']
    assert sorted(path.name for path in tmp_path.iterdir()) == sorted([first['id'], interrupted.name, rebuilt['id']])
    # A published package (its receipt in SQLite, its files in storage) is never reused or rebuilt under its name.
    published, created = export_package(tmp_path, renamed, taken=lambda base: {rebuilt['id']})
    assert created and published['id'] not in {first['id'], interrupted.name, rebuilt['id']}


def test_switching_to_fast_print_builds_a_new_package_on_the_fast_process(tmp_path):
    request = ordinary_manifest()
    detailed, created = export_package(tmp_path, request)
    assert created and [plate['process'] for plate in detailed['plates']] == ['0.20mm Standard @BBL A1M']
    fast = copy.deepcopy(request)
    fast['instances'][0]['parameters']['lite'] = 1
    before = _snapshot(tmp_path / detailed['id'])
    receipt, created = export_package(tmp_path, fast)
    assert created and receipt['id'] != detailed['id']
    assert [plate['process'] for plate in receipt['plates']] == ['0.28mm Extra Draft @BBL A1M']
    assert _snapshot(tmp_path / detailed['id']) == before
    again, created = export_package(tmp_path, request)
    assert not created and again['id'] == detailed['id']


def two_pieces() -> dict:
    """`ordinary_manifest` with a second straight, so it can be prepared in two parts."""
    request = ordinary_manifest()
    second = copy.deepcopy(request['instances'][0])
    second['id'] = second['sectionId'] = 'upper:1:printed_straight:0'
    for pose in (second['pose'], second['startPort']['pose'], second['endPort']['pose']):
        pose['x'] += 80
    request['instances'].append(second)
    request['requiredPrintedInstanceIds'].append(second['id'])
    request['billOfMaterials'][0].update(count=2, instanceIds=list(request['requiredPrintedInstanceIds']))
    return request


def test_a_layout_part_packages_only_its_pieces_under_the_whole_layouts_codes(tmp_path):
    request = two_pieces()
    second = request['instances'][1]
    part = {'index': 2, 'count': 2, 'instanceIds': [second['id']]}
    receipt, created = export_package(tmp_path, request, part=part)
    assert created and receipt['id'].endswith('-part-2-of-2') and receipt['part'] == part
    assert [(item['instanceId'], item['code']) for item in receipt['parts']] == [(second['id'], '2')]
    root = tmp_path / receipt['id']
    assert json.loads((root / 'manifest.json').read_text()) == request
    assert (root / 'assembly-guide.pdf').stat().st_size > 0
    again, created = export_package(tmp_path, request, part=part)
    assert not created and again['id'] == receipt['id']


def test_a_combine_run_again_returns_the_combined_package_it_already_installed_and_keeps_the_parts(tmp_path):
    """A worker restart while the combined package was being published requeues the combine: it publishes the package
    it installed (a combined package of the same layout and parts), not a second one, and the parts stay for it."""
    request = two_pieces()
    base, _ = validate_manifest(request)
    ids = request['requiredPrintedInstanceIds']

    def install(name: str, receipt: dict, manifest: dict | None = None) -> None:
        (tmp_path / name).mkdir()
        (tmp_path / name / 'receipt.json').write_text(json.dumps({'id': name, 'status': 'prepared-digital-only',
                                                                  **receipt}))
        if manifest is not None:
            (tmp_path / name / 'manifest.json').write_text(json.dumps(manifest))
    parts = [f'{base}-part-{index}-of-2' for index in (1, 2)]
    for index, (name, ident) in enumerate(zip(parts, ids), 1):
        install(name, {'part': {'index': index, 'count': 2, 'instanceIds': [ident]}, 'printer': request['printer'],
                       'layoutRevision': request['project']['layoutRevision'], 'plates': []})

    def split(*groups):
        return {'layoutParts': [{'index': index, 'instanceIds': group} for index, group in enumerate(groups, 1)]}
    install(f'{base}-00000000', split([ids[0]], [ids[1]]), {**request, 'warnings': []})  # another manifest
    install(f'{base}-11111111', split([ids[1]], [ids[0]]), request)  # split differently
    install(f'{base}-22222222', split([ids[0]], [ids[1]]), request)
    before = sorted(path.name for path in tmp_path.iterdir())
    combined = combine_parts(tmp_path, request, parts, lambda *_: None)
    assert combined['id'] == f'{base}-22222222'
    assert sorted(path.name for path in tmp_path.iterdir()) == before


@pytest.mark.parametrize(('field', 'value'), [
    ('routes', []),
    ('routes', [{'id': 'upper', 'points': []}]),
    ('crossings', None),
    ('crossings', [{'upperRouteId': 'upper', 'lowerRouteId': 'missing'}]),
    ('instances', []),
    ('requiredPrintedInstanceIds', []),
    ('billOfMaterials', []),
])
def test_ordinary_package_rejects_incomplete_or_escalated_manifest(tmp_path, field, value):
    request = ordinary_manifest()
    request[field] = value
    with pytest.raises(ValueError):
        export_package(tmp_path, request)
    assert not list(tmp_path.iterdir())


@pytest.mark.parametrize(('field', 'value'), [
    ('routeId', 'unknown'),
    ('geometryAvailable', False),
    ('pose', {'x': float('nan'), 'y': 0, 'z': 0, 'heading': 0, 'pitch': 0}),
])
def test_ordinary_package_rejects_invalid_fitted_instances(tmp_path, field, value):
    request = ordinary_manifest()
    request['instances'][0][field] = value
    with pytest.raises(ValueError):
        export_package(tmp_path, request)
    assert not list(tmp_path.iterdir())


def test_ordinary_package_rejects_ports_that_disagree_with_generated_cad(tmp_path):
    request = ordinary_manifest()
    request['instances'][0]['endPort']['pose']['x'] += 1
    with pytest.raises(ValueError, match='CAD port pose differs'):
        export_package(tmp_path, request)
    assert not list(tmp_path.iterdir())


def test_manifest_omission_rejects_without_prepared_package(tmp_path):
    request = manifest()
    request['requiredPrintedInstanceIds'].clear()
    with pytest.raises(ValueError):
        export_package(tmp_path, request)
    assert not list(tmp_path.iterdir())


def test_two_adjacent_printed_rails_require_a_matched_joiner_and_owned_seam_is_blocked():
    request = manifest()
    second = copy.deepcopy(request['instances'][0])
    second['id'] = second['sectionId'] = 'upper:1:printed_straight:0'
    second['pose']['x'] = second['startPort']['pose']['x'] = 80
    second['endPort']['pose']['x'] = 160
    request['instances'].append(second)
    request['requiredPrintedInstanceIds'].append(second['id'])
    request['billOfMaterials'][0]['instanceIds'].append(second['id'])
    request['billOfMaterials'][0]['count'] = 2
    with pytest.raises(ValueError, match='dimension-matched joiner'):
        validate_manifest(request)

    joint = {'id': 'upper:joiner:1', 'routeId': 'upper',
             'sectionId': request['instances'][0]['sectionId'], 'family': 'connector_joiner',
             'parameters': {key: second['parameters'][key] for key in (
                 'joint_width', 'joint_depth', 'joint_height', 'joint_clearance')},
             'pose': {'x': 75.2, 'y': 0, 'z': 0, 'heading': 0, 'pitch': 0},
             'interfaceKind': 'connector', 'source': 'printed', 'status': 'unverified',
             'geometryAvailable': True, 'quantity': 1}
    request['instances'].append(joint)
    request['requiredPrintedInstanceIds'].append(joint['id'])
    request['billOfMaterials'].append({'source': 'printed', 'family': 'connector_joiner',
                                       'count': 1, 'instanceIds': [joint['id']]})
    _, printed = validate_manifest(request)
    assert [part['id'] for part in printed] == request['requiredPrintedInstanceIds']
    second['family'] = 'bridge_deck'
    second['parameters'] = {**{key: value for key, value in second['parameters'].items()
                               if key not in ('body_width', 'base_thickness')},
                            'deck_width': 30, 'deck_thickness': 6}
    with pytest.raises(ValueError, match='running-surface height step'):
        validate_manifest(request)
    second['family'] = 'bridge_joint'
    second['parameters'] = {**second['parameters'], 'joint_length': 80,
                            'deck_thickness': 4, 'joint_width': 7}
    with pytest.raises(ValueError, match='Bridge joint tongue'):
        validate_manifest(request)
    second['family'] = 'printed_straight'
    second['parameters'] = copy.deepcopy(request['instances'][0]['parameters'])


    second['source'] = 'owned'
    with pytest.raises(ValueError):
        validate_manifest(request)


def test_symlinked_revision_and_artifact_cannot_escape_selected_root(tmp_path):
    root = tmp_path / 'chosen'
    root.mkdir()
    outside = tmp_path / 'outside'
    outside.mkdir()
    request = manifest()
    name, _ = validate_manifest(request)
    (root / name).symlink_to(outside)
    with pytest.raises(FileExistsError):
        export_package(root, request)
    assert not list(outside.iterdir())
    with pytest.raises((ValueError, OSError)):
        safe_file(root, '../outside', 'receipt.json')
    (root / 'trial-safe').mkdir()
    (root / 'trial-safe' / 'receipt.json').symlink_to(outside / 'private')
    with pytest.raises(OSError):
        safe_file(root, 'trial-safe', 'receipt.json')


def _stage(root: Path, name: str, receipt: str) -> None:
    (root / name).mkdir()
    (root / name / 'receipt.json').write_text(receipt)


def test_install_takes_a_free_name_and_never_replaces_an_existing_package(tmp_path):
    _stage(tmp_path, 'stage-1', 'first')
    _stage(tmp_path, 'stage-2', 'second')
    (tmp_path / 'interrupted').mkdir()  # an empty folder is a taken name too; plain rename(2) would replace it
    root_fd = os.open(tmp_path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        install_no_replace(root_fd, 'stage-1', 'package')
        for taken in ('package', 'interrupted'):
            with pytest.raises(FileExistsError):
                install_no_replace(root_fd, 'stage-2', taken)
    finally:
        os.close(root_fd)
    assert (tmp_path / 'package' / 'receipt.json').read_text() == 'first'
    assert (tmp_path / 'stage-2' / 'receipt.json').read_text() == 'second'
    assert not (tmp_path / 'stage-1').exists() and not list((tmp_path / 'interrupted').iterdir())


def test_install_refuses_on_a_platform_without_a_no_replace_rename(tmp_path, monkeypatch):
    _stage(tmp_path, 'stage', 'staged')
    monkeypatch.setattr(sys, 'platform', 'win32')
    root_fd = os.open(tmp_path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        with pytest.raises(OSError, match='not supported on win32'):
            install_no_replace(root_fd, 'stage', 'package')
    finally:
        os.close(root_fd)
    assert (tmp_path / 'stage' / 'receipt.json').read_text() == 'staged' and not (tmp_path / 'package').exists()


def test_shared_ends_mate_directly_without_joiners_but_reject_mixed_adjustments():
    request = manifest()
    first = request['instances'][0]
    first['parameters'] = {'run': 80, 'body_width': 63.8, 'base_thickness': 3.2,
                           'rail_gauge': 40, 'rail_interface_width': 2.4, 'rail_height': 6.4,
                           'connector_version': 1, 'fit_adjustment': 0}
    for port in (first['startPort'], first['endPort']):
        port.update(railGauge=40, interfaceWidth=2.4)
    second = copy.deepcopy(first)
    second['id'] = second['sectionId'] = 'upper:1:printed_straight:0'
    second['pose']['x'] = second['startPort']['pose']['x'] = 80
    second['endPort']['pose']['x'] = 160
    request['instances'].append(second)
    request['requiredPrintedInstanceIds'].append(second['id'])
    request['billOfMaterials'][0]['instanceIds'].append(second['id'])
    request['billOfMaterials'][0]['count'] = 2
    _, printed = validate_manifest(request)
    assert [part['id'] for part in printed] == [first['id'], second['id']]
    second['parameters']['fit_adjustment'] = .1
    with pytest.raises(ValueError):
        validate_manifest(request)
    second.update(source='owned', family='brick_straight_nominal', parameters={'run': 128})
    second['endPort']['pose']['x'] = 208
    request['requiredPrintedInstanceIds'] = [first['id']]
    request['billOfMaterials'] = [
        {'source': 'printed', 'family': first['family'], 'count': 1, 'instanceIds': [first['id']]},
        {'source': 'owned', 'family': second['family'], 'count': 1, 'instanceIds': [second['id']]}]
    _, printed = validate_manifest(request)
    assert [part['id'] for part in printed] == [first['id']]


def test_automation_devices_are_validated_and_listed_in_the_assembly_guide():
    from cad.service.package import _device_guide
    request = ordinary_manifest()
    points = {'id': 'points', 'kind': 'turnout', 'family': 'turnout_radius', 'label': 'Turnout (radius family)',
              'control': 'SG90 servo', 'states': [{'id': 'straight', 'label': 'Straight'}, {'id': 'diverging', 'label': 'Diverging'}],
              'state': 'straight', 'routeId': 'upper', 'x': 12.4, 'y': -3, 'colourId': None}
    marker = {'id': 'marked:marker', 'kind': 'colour-marker', 'family': 'marker_insert', 'label': 'Red marker',
              'control': 'Colour & distance sensor (88007)', 'states': [], 'state': None,
              'routeId': 'upper', 'x': 64, 'y': 0, 'colourId': 9}
    request['devices'] = [points, marker]
    validate_manifest(request)
    codes = {'points': '4', 'marked:marker': '7B'}
    guide = _device_guide(request['devices'], codes)
    assert '| 4 | points | turnout | Turnout (radius family) | SG90 servo | Straight (set), Diverging | 12, -3 |' in guide
    assert '| 7B | marked:marker | colour-marker | Red marker | Colour & distance sensor (88007) | Colour sensor 9 | 64, 0 |' in guide
    # The printed guide names devices by code only; programs read the ids from manifest.json.
    printed = _device_guide(request['devices'], codes, ids=False)
    assert '| 4 | turnout | Turnout (radius family) |' in printed and 'marked:marker' not in printed
    for mutate in (lambda d: d[0].update(label='Turnout | forged'), lambda d: d[0].update(routeId='nowhere'),
                   lambda d: d[0].update(state='sideways'), lambda d: d[0].update(colourId=3),
                   lambda d: d[1].update(colourId=None), lambda d: d[1].update(id='points'),
                   lambda d: d[0].update(kind='robot'), lambda d: d[0].update(x=float('nan'))):
        forged = copy.deepcopy(request)
        mutate(forged['devices'])
        with pytest.raises(ValueError):
            validate_manifest(forged)


# ------------------------------------------------------------------------------------------- community pieces (U17)

SAMPLE_LIBRARY = Path(__file__).resolve().parents[2] / 'tests' / 'fixtures' / 'library'
SAMPLE_CURVE = next(item for item in json.loads((SAMPLE_LIBRARY / 'index.json').read_text())['items']
                    if item['id'] == 'community_sample_curve_90')
RAIL_TOP = 3.2 + 6.4  # ordinary_manifest's base and rail heights


@cache
def straight_upload() -> tuple[bytes, list[dict]]:
    """A contributor's brick straight, 96 mm long, as uploaded: Plateway's own CAD exported as a binary STL,
    then turned a quarter left and moved, so its frame is its own. Returns the STL and its two marked ends."""
    parameters = {**ordinary_manifest()['instances'][0]['parameters'], 'run': 96}
    with tempfile.TemporaryDirectory() as folder:
        cad = generate_part({'version': 1, 'units': 'mm', 'family': 'printed_straight', 'parameters': parameters,
                             'printer_envelope': {'x': 180, 'y': 180, 'z': 180}, 'part_revision': 'upload',
                             'layout_revision': 'upload'}, Path(folder))
        mesh = trimesh.load_mesh(cad['mesh'], process=False)
    turn, shift = math.pi / 2, np.array([150., 30.])
    mesh.apply_transform(trimesh.transformations.translation_matrix([*shift, 0]) @
                         trimesh.transformations.rotation_matrix(turn, (0, 0, 1)))
    rotate = np.array([[math.cos(turn), -math.sin(turn)], [math.sin(turn), math.cos(turn)]])
    ends = [{'x': float(x), 'y': float(y), 'z': RAIL_TOP, 'heading': heading + turn}
            for (x, y), heading in ((rotate @ [0, 0] + shift, math.pi), (rotate @ [96, 0] + shift, 0.))]
    return mesh.export(file_type='stl'), ends


def straight_entry(data: bytes, ends: list[dict], **changes) -> dict:
    return {'id': 'community_shelf_straight', 'version': 1, 'kind': 'piece', 'state': 'live', 'name': 'Shelf straight',
            'licence': 'CC-BY-4.0', 'credit': 'Ada Lovelace', 'file': 'pieces/community_shelf_straight/1/straight.stl',
            'digest': hashlib.sha256(data).hexdigest(), 'piece': {'ends': ends}, **changes}


def sample_curve() -> tuple[dict, bytes]:
    return SAMPLE_CURVE, (SAMPLE_LIBRARY / SAMPLE_CURVE['file']).read_bytes()


def community_library(root: Path, *items: tuple[dict, bytes | None]) -> LocalBucket:
    """A local library bucket holding these (index entry, file) items, as `library_publish.py` lays them out."""
    bucket = LocalBucket(root / 'plateway-library', 'plateway-library', b'secret')
    for entry, data in items:
        if data is not None:
            bucket.put_bytes(entry['file'], data)
    bucket.put_bytes('index.json', json.dumps({'format': 1, 'items': [entry for entry, _ in items]}).encode())
    return bucket


def community_instance(ident: str, route: str, entry: dict, x: float, y: float, heading: float,
                       reversed: bool = False) -> dict:
    """A fitted community piece as the app freezes it: laid with its `in` end at (x, y) facing `heading`, its first
    marked end there (its second when `reversed`), and its far end where the mesh puts the other marked end."""
    first, last = entry['piece']['ends'][::-1] if reversed else entry['piece']['ends']
    turn = heading - first['heading'] - math.pi
    c, s = math.cos(turn), math.sin(turn)
    dx, dy = last['x'] - first['x'], last['y'] - first['y']

    def port(px, py, yaw):
        return {'pose': {'x': px, 'y': py, 'z': 0, 'heading': yaw, 'pitch': 0}, 'profile': 'brick',
                'railGauge': 40, 'interfaceWidth': 2.4}
    start = port(x, y, heading)
    return {'id': ident, 'routeId': route, 'sectionId': ident, 'family': entry['id'], 'parameters': {},
            'pose': dict(start['pose']), 'interfaceKind': 'rail', 'startPort': start,
            'endPort': port(x + c*dx - s*dy, y + s*dx + c*dy, math.atan2(math.sin(turn + last['heading']), math.cos(turn + last['heading']))),
            'source': 'printed', 'status': 'unverified', 'geometryAvailable': True, 'quantity': 1}


def with_community(request: dict, *pieces: tuple[dict, dict]) -> dict:
    """`request` with these (instance, library entry) community pieces added and referenced by id and digest."""
    request['instances'].extend(instance for instance, _ in pieces)
    request['requiredPrintedInstanceIds'].extend(instance['id'] for instance, _ in pieces)
    for instance, entry in pieces:
        row = next((row for row in request['billOfMaterials'] if row['family'] == entry['id']), None)
        if row is None:
            row = {'source': 'printed', 'family': entry['id'], 'count': 0, 'instanceIds': []}
            request['billOfMaterials'].append(row)
        row['count'] += 1
        row['instanceIds'].append(instance['id'])
    request['library'] = list({entry['id']: {'id': entry['id'], 'version': entry['version'], 'digest': entry['digest']}
                               for _, entry in pieces}.values())
    return request


def community_only(entry: dict) -> dict:
    """A one-route layout of this one community piece."""
    request = ordinary_manifest()
    request.update(instances=[], requiredPrintedInstanceIds=[], billOfMaterials=[])
    return with_community(request, (community_instance('upper:0:community:0', 'upper', entry, 0, 0, 0), entry))


CORE_NS = '{http://schemas.microsoft.com/3dmanufacturing/core/2015/02}'
PRODUCTION_NS = '{http://schemas.microsoft.com/3dmanufacturing/production/2015/06}'


def painted_centroids(project: Path, code: str) -> np.ndarray:
    """Centres of the triangles painted as support enforcers on object `code` of a Bambu project, in its part frame
    (as `plates._paint_object` reads them)."""
    with zipfile.ZipFile(project) as archive:
        settings = ET.fromstring(archive.read('Metadata/model_settings.config'))
        ident = next(obj.get('id') for obj in settings.findall('object')
                     if any(meta.get('key') == 'name' and meta.get('value') == code for meta in obj.findall('metadata')))
        model = ET.fromstring(archive.read('3D/3dmodel.model'))
        component = next(obj for obj in model.iter(f'{CORE_NS}object') if obj.get('id') == ident).find(f'.//{CORE_NS}component')
        transform = np.array([float(v) for v in component.get('transform').split()]).reshape(4, 3)
        text = archive.read(component.get(f'{PRODUCTION_NS}path').lstrip('/')).decode()
    body = re.search(rf'<object id="{component.get("objectid")}"[^>]*>.*?</object>', text, re.S).group(0)
    vertices = np.array(re.findall(r'<vertex x="([^"]+)" y="([^"]+)" z="([^"]+)"', body), dtype=float)
    vertices = vertices @ transform[:3] + transform[3]
    painted = np.array([[int(a), int(b), int(c)] for a, b, c in
                        re.findall(r'<triangle v1="(\d+)" v2="(\d+)" v3="(\d+)"[^>]*paint_supports="4"', body)])
    return vertices[painted].mean(axis=1) if len(painted) else np.zeros((0, 3))


def test_a_community_piece_prints_exactly_as_uploaded_with_supports_painted_at_its_marked_ends(tmp_path):
    data, ends = straight_upload()
    entry = straight_entry(data, ends)
    library = community_library(tmp_path, (entry, data))
    request = ordinary_manifest()
    request['pieceNames'] = {'upper:0:printed_straight:0': 'Straight', 'upper:1:community:0': 'Shelf straight',
                             'lower:0:community:0': 'Shelf straight'}
    # After the built-in straight, and on its own route laid from its far end.
    request['routes'] = [{'id': 'upper', 'name': 'Upper', 'points': [{'id': 'a'}, {'id': 'b'}, {'id': 'c'}]},
                         {'id': 'lower', 'name': 'Lower', 'points': [{'id': 'd'}, {'id': 'e'}]}]
    with_community(request, (community_instance('upper:1:community:0', 'upper', entry, 80, 0, 0), entry),
                   (community_instance('lower:0:community:0', 'lower', entry, 0, 200, math.pi, reversed=True), entry))
    receipt, created = export_package(tmp_path / 'exports', request, library=library)
    assert created
    root = tmp_path / 'exports' / receipt['id']
    community = [part for part in receipt['parts'] if part['family'] == entry['id']]
    assert [part['code'] for part in community] == ['2', '3']
    assert receipt['notes'] == [PRINTS_AS_UPLOADED]
    for part in community:
        assert part['library'] == {key: entry[key] for key in ('id', 'version', 'digest', 'name', 'licence', 'credit')}
        # The uploaded mesh, unchanged on its plate: same bytes, same digest.
        assert part['digest'] == part['printDigest'] == entry['digest']
        assert (root / part['printMesh']).read_bytes() == data == (root / part['mesh']).read_bytes()
        assert part['parameters'] == {}
    # Its ports are its marked ends, at the fitted ports (a straight fits either way round).
    marked = [[end['x'], end['y']] for end in ends]
    assert [port['position'][:2] for port in community[0]['ports']] == marked
    assert sorted(port['position'][:2] for port in community[1]['ports']) == sorted(marked)
    plates = {obj['instanceId']: plate for plate in receipt['plates'] for obj in plate['objects']}
    for part in community:
        plate = plates[part['instanceId']]
        assert plate['supportsEnabled'] and (root / plate['gcode']).stat().st_size > 0
        painted = painted_centroids(root / plate['project'], part['code'])
        # Supports are painted under the connector at each marked end, and nowhere else on the piece.
        near = [np.hypot(painted[:, 0] - end['x'], painted[:, 1] - end['y']) <= math.hypot(END_REACH[0], RAIL_BAND[1]) + .5
                for end in ends]
        assert near[0].any() and near[1].any() and (near[0] | near[1]).all()
    guide = (root / 'assembly-guide.md').read_text()
    assert '# Community pieces' in guide and '| 2, 3 | Shelf straight | Ada Lovelace | CC-BY-4.0 |' in guide
    # Preparing again reuses the package: a community piece's recipe is its digest, still current.
    again, created = export_package(tmp_path / 'exports', request, library=library)
    assert not created and again['id'] == receipt['id'] and again['cadSourceCurrent']


def test_a_layout_with_a_retired_community_piece_still_prepares_and_prints_it(tmp_path):
    entry, data = sample_curve()
    entry = {**entry, 'state': 'retired'}
    receipt, created = export_package(tmp_path / 'exports', community_only(entry),
                                      library=community_library(tmp_path, (entry, data)))
    assert created
    [part] = receipt['parts']
    assert part['library']['id'] == entry['id'] and part['printDigest'] == entry['digest']
    assert [obj['instanceId'] for plate in receipt['plates'] for obj in plate['objects']] == [part['instanceId']]


@pytest.mark.parametrize('library, message', [
    ('tampered', 'doesn’t match the piece this layout uses'),
    ('newer', 'changed in the community library'),
    ('removed', 'not in the community library any more'),
    ('unlisted', 'not in the community library any more'),
    ('file gone', 'not in the community library any more'),
])
def test_a_community_piece_whose_library_file_does_not_match_or_is_gone_is_refused(tmp_path, library, message):
    entry, data = sample_curve()
    request = community_only(entry)
    stored = {'tampered': [(entry, data + b'\0' * 50)],
              'newer': [({**entry, 'version': 2, 'digest': 'f' * 64}, data)],
              'removed': [({'id': entry['id'], 'version': 1, 'kind': 'piece', 'state': 'removed'}, None)],
              'unlisted': [],
              'file gone': [(entry, None)]}[library]
    with pytest.raises(UserError, match=message):
        export_package(tmp_path / 'exports', request, library=community_library(tmp_path, *stored))
    assert not list((tmp_path / 'exports').iterdir())


def test_community_pieces_are_referenced_by_id_and_digest_and_print_without_parameters():
    entry, _ = sample_curve()
    validate_manifest(community_only(entry))
    for forge in (lambda m: m['instances'][0]['parameters'].update(fit_adjustment=.1),
                  lambda m: m['instances'][0]['parameters'].update(lite=1),
                  lambda m: m.pop('library'),
                  lambda m: m['library'][0].update(digest='not-a-digest'),
                  lambda m: m['library'].append({'id': 'community_unused', 'version': 1, 'digest': 'a' * 64}),
                  lambda m: m['library'].append(dict(m['library'][0])),
                  lambda m: m['instances'][0].update(source='owned')):
        request = community_only(entry)
        forge(request)
        with pytest.raises(ValueError):
            validate_manifest(request)
