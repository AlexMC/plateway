"""Digital plate fit and exact bundled-printer selection; no physical test claims."""

import copy
import math
from pathlib import Path
import re
import xml.etree.ElementTree as ET

import numpy as np
from PIL import Image
import pytest
import json
import zipfile

import trimesh

from cad.models import track_assembly
from cad.service.errors import UserError
from cad.service.generate import generate_part
from cad.service.package import export_trial
from cad.service.plates import RAIL_BAND, arrange, export_plates, fast_process, plate_style, select_presets, write_core_3mf
from cad.service.thumbnails import PART_COLOURS

COUPON = [{'id': 'brick-end-coupon', 'family': 'brick_end_coupon',
           'parameters': {'body_length': 24, 'connector_version': 1, 'fit_adjustment': 0},
           'part_revision': 'connector-v1', 'layout_revision': 'calibration'}]
# The calibration coupon sliced by the pinned Bambu Studio (deploy/Dockerfile) on the X1 Carbon.
COUPON_REFERENCE = json.loads((Path(__file__).parent / 'fixtures/coupon-slice-reference.json').read_text())

X1C = {'name': 'X1 Carbon', 'material': 'Bambu PLA Basic', 'profile': '0.20mm Standard @BBL X1C',
       'nozzleMm': .4, 'orientation': 'flat', 'envelope': {'x': 256, 'y': 256, 'z': 250}}
SHARED_RAIL = {'rail_gauge': 40, 'rail_interface_width': 2.4, 'body_width': 63.8,
               'base_thickness': 3.2, 'rail_height': 6.4, 'connector_version': 1, 'fit_adjustment': 0}


@pytest.fixture
def printer():
    return {'name': 'A1 mini', 'material': 'Bambu PLA Basic',
            'profile': '0.20mm Standard @BBL A1M', 'nozzleMm': .4,
            'orientation': 'flat', 'envelope': {'x': 180, 'y': 180, 'z': 180}}


def test_repeated_parts_arrange_once_each_across_multiple_plates(printer):
    parts = [{'instanceId': f'module:{n}', 'bounds': {'size': [80, 80, 5]}} for n in range(5)]
    plates = arrange(parts, printer, select_presets(printer))
    assert [p['instanceId'] for plate in plates for p in plate] == [p['instanceId'] for p in parts]
    assert len(plates) >= 2
    assert all(p['plannedPlacement']['orientation'] == 'flat' for p in parts)


def test_x1_exclusion_and_envelope_are_enforced():
    printer = {'name': 'X1 Carbon', 'material': 'Bambu PLA Basic',
               'profile': '0.20mm Standard @BBL X1C', 'nozzleMm': .4,
               'orientation': 'flat', 'envelope': {'x': 256, 'y': 256, 'z': 250}}
    presets = select_presets(printer)
    item = {'instanceId': 'a', 'bounds': {'size': [40, 40, 4]}}
    arrange([item], printer, presets)
    assert item['plannedPlacement']['x'] >= 18 or item['plannedPlacement']['y'] >= 28
    with pytest.raises(UserError):
        arrange([{'instanceId': 'oversize', 'bounds': {'size': [257, 20, 5]}}], printer, presets)
    mismatched = copy.deepcopy(printer)
    mismatched['envelope']['x'] = 180
    with pytest.raises(ValueError, match='envelope'):
        select_presets(mismatched)
    printer['material'] = 'Generic PLA'
    with pytest.raises(UserError):
        select_presets(printer)


@pytest.mark.parametrize('name,nozzle,expected', [
    ('X1 Carbon', .4, '0.28mm Extra Draft @BBL X1C'),
    ('A1 mini', .4, '0.28mm Extra Draft @BBL A1M'),
    ('A1 mini', .6, '0.24mm Optimal @BBL A1M 0.6 nozzle'),
    ('A1 mini', .8, '0.24mm Fine @BBL A1M 0.8 nozzle'),
])
def test_fast_process_is_the_coarsest_bundled_layer_up_to_028(name, nozzle, expected):
    assert fast_process({**X1C, 'name': name, 'nozzleMm': nozzle}) == expected


def test_plates_never_mix_styles_and_mechanisms_print_detailed(printer):
    def part(ident, parameters, role=None):
        return {'instanceId': ident, 'bounds': {'size': [60, 60, 9.6]}, 'parameters': parameters,
                **({'componentRole': role} if role else {})}
    parts = [part('fast-straight', {'lite': 1}), part('straight', {}),
             part('switch:keyed-base-01', {'lite': 1}, 'keyed-base-01'),
             part('switch:selector-1', {'lite': 1}, 'selector-1'),
             part('switch:keeper-1-1', {'lite': 1}, 'keeper-1-1'),
             part('switch:selector-lock-1', {'lite': 1}, 'selector-lock-1'),
             part('fast-curve', {'lite': 1})]
    plates = arrange(parts, printer, select_presets(printer))
    assert sorted(p['instanceId'] for plate in plates for p in plate) == sorted(p['instanceId'] for p in parts)
    for plate in plates:
        assert len({plate_style(p) for p in plate}) == 1
    styles = {p['instanceId']: plate_style(p) for p in parts}
    assert {ident for ident, style in styles.items() if style == 'fast'} == {
        'fast-straight', 'switch:keyed-base-01', 'fast-curve'}


def _support_extrusions(gcode):
    """(x, y, z) midpoints of every support extrusion that deposits material."""
    feature, x, y, z, points = None, 0.0, 0.0, 0.0, []
    for line in gcode.read_text().splitlines():
        if line.startswith('; FEATURE:'):
            feature = line.split(':', 1)[1].strip()
            continue
        if line.startswith('; Z_HEIGHT:'):
            z = float(line.split(':', 1)[1])
            continue
        if not line.startswith(('G1 ', 'G2 ', 'G3 ')):
            continue
        values = dict((key, float(value)) for key, value in re.findall(r'([XYE])(-?[\d.]+)', line.split(';')[0]))
        nx, ny = values.get('X', x), values.get('Y', y)
        if feature and feature.startswith('Support') and values.get('E', 0) > 0 and (nx, ny) != (x, y):
            points.append(((x + nx) / 2, (y + ny) / 2, z))
        x, y = nx, ny
    return points


def test_detailed_track_supports_only_the_connector_tongues(tmp_path):
    """No support in hollow rail channels or clutch bays; every port's tongues supported."""
    parts = []
    for family, shape in [('printed_straight', {'run': 128}),
                          ('printed_curve', {'radius': 320, 'sweep': math.pi / 8})]:
        generated = generate_part({
            'version': 1, 'units': 'mm', 'family': family, 'parameters': {**SHARED_RAIL, **shape},
            'printer_envelope': X1C['envelope'], 'part_revision': 'synthetic-supports',
            'layout_revision': 'synthetic-supports'}, tmp_path / family)
        parts.append({'instanceId': family, 'code': str(len(parts) + 1), 'name': family, 'family': family, 'parameters': {**SHARED_RAIL, **shape},
                      'meshPath': generated['mesh'], 'bounds': generated['bounds'], 'ports': generated['ports']})
    (tmp_path / 'plates').mkdir()
    plates = export_plates(parts, X1C, tmp_path / 'plates')
    assert len(plates) == 1 and plates[0]['supportsEnabled'] is True
    with zipfile.ZipFile(tmp_path / 'plates' / plates[0]['project']) as archive:
        settings = json.loads(archive.read('Metadata/project_settings.config'))
        painted = sum(archive.read(name).count(b'paint_supports="4"') for name in archive.namelist()
                      if name.startswith('3D/Objects/'))
    assert settings['support_type'] == 'normal(manual)' and painted > 0
    assert {'enable_support', 'support_type'} <= set(settings['different_settings_to_system'][0].split(';'))
    # Every support extrusion stays within a port's end half-tie (tongues protrude
    # 3.7 mm past the port face) under a rail, or in open air in front of the port
    # face. The support base spreads up to 4.5 mm past painted roofs (7 mm on the
    # first layer). Hollow rail channels begin at the half tie's inner wall (7.9).
    ends = {(part['instanceId'], index): 0 for part in parts for index in (0, 1)}
    points = _support_extrusions(tmp_path / 'plates' / plates[0]['gcode'])
    assert points
    for px, py, pz in points:
        margin = 4.5 if pz > .25 else 7.0
        hits = []
        for part in parts:
            place, low = part['plannedPlacement'], part['bounds']['min']
            x, y = px - place['x'] + low[0], py - place['y'] + low[1]
            for index, port in enumerate(part['ports']):
                heading = port['heading'] + (math.pi if index else 0)
                dx, dy = x - port['position'][0], y - port['position'][1]
                u = dx * math.cos(heading) + dy * math.sin(heading)
                v = abs(dy * math.cos(heading) - dx * math.sin(heading))
                in_tie = -3.7 - margin <= u <= 7.9 + .5 and RAIL_BAND[0] - margin <= v <= RAIL_BAND[1] + margin
                in_front = -3.7 - margin <= u < -.5 and v <= 31.9 + margin
                if in_tie or in_front:
                    hits.append((part['instanceId'], index))
        assert hits, f'support outside every connector end at plate ({px:.1f}, {py:.1f}, {pz:.2f})'
        ends[hits[0]] += 1
    assert all(count > 20 for count in ends.values()), ends


def test_every_family_slices_on_crowded_fast_and_detailed_plates(tmp_path):
    """Painted supports of neighbouring parts must not meet (Bambu rejects the plate);
    fast track shares plates only with fast track, on the fast process."""
    shapes = [('printed_straight', {'run': 128}), ('printed_curve', {'radius': 320, 'sweep': math.pi / 8}),
              ('vertical_transition', {'run': 128, 'rise': 8, 'start_grade': 0, 'end_grade': 0}),
              ('bridge_deck', {'run': 64}), ('bridge_joint', {'joint_length': 24})]
    requests = []
    for family, shape in shapes:
        parameters = {**SHARED_RAIL, **shape}
        if family.startswith('bridge_'):
            parameters['deck_width'], parameters['deck_thickness'] = parameters.pop('body_width'), parameters.pop('base_thickness')
        requests.append((family, family, parameters, None))
    logical = {'connector_version': 1, 'fit_adjustment': 0, 'bend': 0, 'switch_state': 0}
    for assembly in ('printed_flex', 'printed_switch_right', 'printed_crossing90'):
        requests += [(f'{assembly}:{row["role"]}', 'track_component', row['parameters'], row['role'])
                     for row in track_assembly.components(assembly, logical)]
    parts = []
    for ident, family, parameters, role in requests:
        for style, extra in (('detailed', {}), ('fast', {'lite': 1})):
            generated = generate_part({
                'version': 1, 'units': 'mm', 'family': family, 'parameters': {**parameters, **extra},
                'printer_envelope': X1C['envelope'], 'part_revision': 'synthetic-crowded',
                'layout_revision': 'synthetic-crowded'}, tmp_path / 'generated' / style)
            parts.append({'instanceId': f'{style}:{ident}', 'code': str(len(parts) + 1), 'name': family, 'family': family,
                          'parameters': {**parameters, **extra},
                          'meshPath': generated['mesh'], 'bounds': generated['bounds'], 'ports': generated['ports'],
                          **({'componentRole': role} if role else {})})
    (tmp_path / 'plates').mkdir()
    plates = export_plates(parts, X1C, tmp_path / 'plates')
    by_id = {part['instanceId']: part for part in parts}
    crowded = {'0.20mm Standard @BBL X1C': 0, '0.28mm Extra Draft @BBL X1C': 0}
    for plate in plates:
        members = [by_id[obj['instanceId']] for obj in plate['objects']]
        assert len({plate_style(part) for part in members}) == 1
        assert plate['process'] == ('0.28mm Extra Draft @BBL X1C' if plate_style(members[0]) == 'fast'
                                    else '0.20mm Standard @BBL X1C')
        with zipfile.ZipFile(tmp_path / 'plates' / plate['project']) as archive:
            settings = json.loads(archive.read('Metadata/project_settings.config'))
        assert settings['print_settings_id'] == plate['process']
        assert settings['layer_height'] == ('0.28' if '0.28mm' in plate['process'] else '0.2')
        assert plate['slice']['warning_message'] == ''
        if plate['supportsEnabled'] and len(members) > 1:
            crowded[plate['process']] += 1
    # Mechanism parts print on detailed plates even when the track is fast.
    assert all(by_id[f'fast:printed_switch_right:{role}']['plate'] in
               {p['plate'] for p in plates if p['process'] == '0.20mm Standard @BBL X1C'}
               for role in ('selector-1', 'keeper-1-1', 'keeper-1-2', 'selector-lock-1'))
    assert all(count > 0 for count in crowded.values()), crowded


def test_sloped_transition_slices_on_its_side_without_floating_features(tmp_path, printer):
    parameters = {'run': 125, 'rise': 2.5, 'start_grade': 0, 'end_grade': .025,
                  'body_width': 30, 'base_thickness': 4, 'rail_gauge': 16,
                  'rail_interface_width': 2, 'rail_height': 2,
                  'joint_width': 6, 'joint_depth': 5, 'joint_height': 2, 'joint_clearance': .2}
    part = generate_part({
        'version': 1, 'units': 'mm', 'family': 'vertical_transition',
        'parameters': parameters,
        'printer_envelope': printer['envelope'], 'part_revision': 'synthetic-grade',
        'layout_revision': 'synthetic-grade'
    }, tmp_path / 'generated')
    item = {'instanceId': 'grade:1', 'code': '1', 'name': 'Ramp · part 1 of 2', 'family': 'vertical_transition', 'parameters': parameters,
            'meshPath': part['mesh'], 'bounds': part['bounds']}
    plate = export_plates([item], printer, tmp_path)[0]
    assert item['printOrientation'] == 'side-on-bed'
    assert item['printBounds']['size'][2] == part['bounds']['size'][1]
    label = item['plateLabel']
    assert label == '1-ramp-part-1-of-2.stl'  # its code and name, as the guide lists it
    assert item['printMesh'] == f"plate-01/{label}"
    assert plate['objects'] == [{'instanceId': 'grade:1', 'label': label}]
    with zipfile.ZipFile(tmp_path / plate['project']) as archive:
        settings = ET.fromstring(archive.read('Metadata/model_settings.config'))
    # The slicer lists the part (and its one volume) by its code; the file keeps the long label.
    assert [node.attrib['value'] for node in settings.findall('./object/metadata[@key="name"]')] == ['1']
    assert [node.attrib['value'] for node in settings.findall('./object/part/metadata[@key="name"]')] == ['1']
    assert [node.attrib['value'] for node in settings.findall('./object/part/metadata[@key="source_file"]')] == [label]
    assert [row['name'] for row in plate['slice']['objects']] == ['1']
    assert item['printBounds']['size'] == [part['bounds']['size'][0], part['bounds']['size'][2], part['bounds']['size'][1]]
    print_mesh = trimesh.load_mesh(tmp_path / item['printMesh'])
    assert print_mesh.is_watertight
    assert print_mesh.extents.tolist() == pytest.approx(
        [part['bounds']['size'][0], part['bounds']['size'][2], part['bounds']['size'][1]], abs=.02)
    assert print_mesh.bounds[0][2] == pytest.approx(0, abs=.01)
    assert plate['slice']['warning_message'] == ''
    assert plate['supportsEnabled'] is True


def test_anchored_bracket_slices_with_explicit_verified_support_override(tmp_path, printer):
    part = generate_part({
        'version': 1, 'units': 'mm', 'family': 'anchored_bracket',
        'parameters': {'height': 80, 'reach': 40, 'plate_width': 24, 'plate_thickness': 5,
                       'arm_width': 8, 'arm_thickness': 8, 'hole_diameter': 5,
                       'hole_spacing': 35, 'seat_width': 24, 'seat_depth': 20,
                       'seat_thickness': 5},
        'printer_envelope': printer['envelope'], 'part_revision': 'synthetic-anchor',
        'layout_revision': 'synthetic-anchor'
    }, tmp_path / 'generated')
    plate = export_plates([{'instanceId': 'anchor:1', 'code': 'S1', 'name': 'Anchored bracket', 'family': 'anchored_bracket',
                            'meshPath': part['mesh'], 'bounds': part['bounds']}], printer, tmp_path)[0]
    assert plate['supportsEnabled'] is True
    assert plate['processOverride']
    with zipfile.ZipFile(tmp_path / plate['project']) as archive:
        settings = json.loads(archive.read('Metadata/project_settings.config'))
    assert settings['enable_support'] == '1'
    assert 'enable_support' in settings['different_settings_to_system'][0].split(';')
    assert plate['slice']['warning_message'] == ''


def test_local_rail_relief_slices_with_supported_underside(tmp_path, printer):
    part = generate_part({
        'version': 1, 'units': 'mm', 'family': 'brick_end_coupon',
        'parameters': {'body_length': 24, 'connector_version': 1, 'fit_adjustment': 0},
        'printer_envelope': printer['envelope'], 'part_revision': 'synthetic-shared-connector',
        'layout_revision': 'synthetic-shared-connector'
    }, tmp_path / 'generated')
    item = {'instanceId': 'brick-end-coupon', 'code': '1', 'name': 'Calibration sample', 'family': 'brick_end_coupon',
            'meshPath': part['mesh'], 'bounds': part['bounds']}
    plate = export_plates([item], printer, tmp_path)[0]
    assert plate['supportsEnabled'] is True
    assert plate['processOverride']
    with zipfile.ZipFile(tmp_path / plate['project']) as archive:
        settings = json.loads(archive.read('Metadata/project_settings.config'))
    assert settings['enable_support'] == '1'
    assert settings['support_type'] == 'normal(manual)'
    assert settings['support_remove_small_overhang'] == '0'
    assert settings['support_top_z_distance'] == '0.2'
    assert settings['support_interface_top_layers'] == '3'
    assert settings['brim_type'] == 'no_brim'
    # The GUI restores unmarked values from its system preset, even when the CLI
    # slices the same archive with supports. These edits must survive that merge.
    preserved = set(settings['different_settings_to_system'][0].split(';'))
    assert {'enable_support', 'support_type', 'support_remove_small_overhang',
            'support_top_z_distance', 'support_interface_top_layers',
            'support_interface_spacing', 'brim_type'} <= preserved
    assert plate['slice']['feature_type_times']['Support interface'] > 0
    assert plate['slice']['warning_message'] == ''
    assert [obj['name'] for obj in plate['slice']['objects']] == ['1']
    assert plate['slice']['objects'][0]['bbox']['width'] == pytest.approx(31.4, abs=.1)


def test_part_files_are_named_by_code_and_a_filesystem_safe_name(tmp_path, printer):
    part = generate_part({
        'version': 1, 'units': 'mm', 'family': 'connector_joiner',
        'parameters': {'joint_width': 6, 'joint_depth': 5, 'joint_height': 2,
                       'joint_clearance': .2},
        'printer_envelope': printer['envelope'], 'part_revision': 'synthetic-labels',
        'layout_revision': 'synthetic-labels'
    }, tmp_path / 'generated')
    parts = [{'instanceId': ident, 'code': code, 'name': 'Joiner · route a/b (1)', 'family': 'connector_joiner',
              'meshPath': part['mesh'], 'bounds': part['bounds']}
             for code, ident in (('1', 'route:a:joiner:1'), ('2', 'route-a-joiner-1'))]
    plates = export_plates(parts, printer, tmp_path)
    labels = [item['plateLabel'] for item in parts]
    assert labels == ['1-joiner-route-a-b-1.stl', '2-joiner-route-a-b-1.stl']
    assert sorted(obj['label'] for plate in plates for obj in plate['objects']) == sorted(labels)


def test_preparing_without_bambu_studio_asks_to_install_it(tmp_path, monkeypatch):
    monkeypatch.setenv('BAMBU_STUDIO_CLI', str(tmp_path / 'squashfs-root' / 'AppRun'))
    with pytest.raises(UserError, match='^Install Bambu Studio to create print plates\\.$'):
        export_trial(tmp_path / 'packages', COUPON, X1C)
    assert not (tmp_path / 'packages').exists()


def _colour_pixels(image: Image.Image, colour: str) -> int:
    """Opaque pixels drawn in a shade of `colour` (draw_iso shades rgb*f + (1-f)*0.08)."""
    pixels = np.asarray(image.convert('RGBA'), float) / 255
    opaque = pixels[pixels[:, :, 3] > .99][:, :3]
    base = np.array([int(colour[i:i+2], 16) for i in (1, 3, 5)]) / 255 - .08
    factor = (opaque - .08) @ base / (base @ base)
    residual = np.linalg.norm(opaque - .08 - factor[:, None] * base, axis=1)
    return int(((residual < .03) & (factor > .4) & (factor < 1.02)).sum())


def test_plate_thumbnail_draws_each_part_on_the_plate(tmp_path, printer):
    part = generate_part({
        'version': 1, 'units': 'mm', 'family': 'connector_joiner',
        'parameters': {'joint_width': 6, 'joint_depth': 5, 'joint_height': 2, 'joint_clearance': .2},
        'printer_envelope': printer['envelope'], 'part_revision': 'synthetic-thumbnail',
        'layout_revision': 'synthetic-thumbnail'
    }, tmp_path / 'generated')
    parts = [{'instanceId': f'joiner-{code}', 'code': code, 'name': 'Joiner', 'family': 'connector_joiner',
              'meshPath': part['mesh'], 'bounds': part['bounds']} for code in ('1', '2', '3')]
    [plate] = export_plates(parts, printer, tmp_path)
    with Image.open(tmp_path / plate['thumbnail']) as image:
        assert image.format == 'PNG' and min(image.size) >= 256
        drawn = [_colour_pixels(image, colour) for colour in PART_COLOURS[:4]]
    assert all(count > 200 for count in drawn[:3]), drawn
    assert drawn[3] == 0, drawn


def test_calibration_coupon_slices_like_the_pinned_reference(tmp_path):
    receipt, _ = export_trial(tmp_path, COUPON, COUPON_REFERENCE['printer'])
    [plate] = receipt['plates']
    header = (tmp_path / receipt['id'] / plate['gcode']).read_text()[:2000]
    version = re.search(r'^; BambuStudio (\S+)$', header, re.M).group(1)
    if version != COUPON_REFERENCE['bambuStudio']:
        pytest.skip(f"Reference is for Bambu Studio {COUPON_REFERENCE['bambuStudio']}, not {version}")
    minutes = re.search(r'total estimated time: (?:(\d+)h )?(\d+)m (\d+)s$', header, re.M)
    seconds = int(minutes[1] or 0) * 3600 + int(minutes[2]) * 60 + int(minutes[3])
    grams = float(re.search(r'^; total filament weight \[g\] : ([\d.]+)$', header, re.M).group(1))
    assert seconds == pytest.approx(COUPON_REFERENCE['totalSeconds'], rel=.02)
    assert grams == pytest.approx(COUPON_REFERENCE['filamentGrams'], rel=.02)


def test_shared_straight_and_curve_keep_planned_plate_on_standalone_slice(tmp_path):
    printer = {'name': 'X1 Carbon', 'material': 'Bambu PLA Basic',
               'profile': '0.20mm Standard @BBL X1C', 'nozzleMm': .4,
               'orientation': 'flat', 'envelope': {'x': 256, 'y': 256, 'z': 250}}
    rail = {'rail_gauge': 40, 'rail_interface_width': 2.4, 'body_width': 63.8,
            'base_thickness': 3.2, 'rail_height': 6.4, 'connector_version': 1, 'fit_adjustment': 0}
    parts = []
    for family, shape in [('printed_straight', {'run': 160}),
                          ('printed_curve', {'radius': 448, 'sweep': 0.39269908169872414})]:
        parameters = {**rail, **shape}
        generated = generate_part({
            'version': 1, 'units': 'mm', 'family': family, 'parameters': parameters,
            'printer_envelope': printer['envelope'], 'part_revision': 'synthetic-mixed-plate',
            'layout_revision': 'synthetic-mixed-plate'
        }, tmp_path / family)
        parts.append({'instanceId': family, 'code': str(len(parts) + 1), 'name': family, 'family': family, 'parameters': parameters,
                      'meshPath': generated['mesh'], 'bounds': generated['bounds'], 'ports': generated['ports']})
    plates = export_plates(parts, printer, tmp_path)
    assert len(plates) == 1
    plate = plates[0]
    sliced = {obj['name']: obj['bbox'] for obj in plate['slice']['objects']}
    assert set(sliced) == {part['code'] for part in parts}
    for part in parts:
        box = sliced[part['code']]
        assert [box['x'], box['y'], box['z']] == pytest.approx(
            [part['plannedPlacement'][axis] for axis in ('x', 'y', 'z')], abs=.01)
        assert [box['width'], box['depth'], box['height']] == pytest.approx(
            part['bounds']['size'], abs=.01)
    with zipfile.ZipFile(tmp_path / plate['project']) as archive:
        settings = json.loads(archive.read('Metadata/project_settings.config'))
        membership = ET.fromstring(archive.read('Metadata/model_settings.config'))
    assert settings['printable_area'] == ['0x0', '256x0', '256x256', '0x256']
    assert float(settings['printable_height']) == 250
    assert len(membership.findall('plate')) == 1
    assert len(membership.findall('./plate/model_instance')) == 2
    assert plate['slice']['warning_message'] == ''
    assert plate['slice']['feature_type_times']['Support interface'] > 0


CORE_3MF = '{http://schemas.microsoft.com/3dmanufacturing/core/2015/02}'


def read_core_3mf(path):
    """Parse a plain 3MF with the standard library: build items as (name, partnumber, world bounds)."""
    with zipfile.ZipFile(path) as archive:
        names = archive.namelist()
        types = ET.fromstring(archive.read('[Content_Types].xml'))
        rels = ET.fromstring(archive.read('_rels/.rels'))
        model = ET.fromstring(archive.read('3D/3dmodel.model'))
    assert sorted(names) == ['3D/3dmodel.model', '[Content_Types].xml', '_rels/.rels']
    assert {(item.get('Extension'), item.get('ContentType')) for item in types} >= {
        ('model', 'application/vnd.ms-package.3dmanufacturing-3dmodel+xml'),
        ('rels', 'application/vnd.openxmlformats-package.relationships+xml')}
    assert [(rel.get('Target'), rel.get('Type')) for rel in rels] == [
        ('/3D/3dmodel.model', 'http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel')]
    assert model.tag == f'{CORE_3MF}model' and model.get('unit') == 'millimeter'
    # Core vocabulary only: every element is in the core namespace, no slicer-specific attributes or metadata.
    assert {node.tag.split('}')[0][1:] for node in model.iter()} == {CORE_3MF[1:-1]}
    assert all(key in ('name', 'id', 'type', 'unit', 'objectid', 'transform', 'partnumber', 'pid', 'pindex',
                       'displaycolor', 'x', 'y', 'z', 'v1', 'v2', 'v3', '{http://www.w3.org/XML/1998/namespace}lang')
               for node in model.iter() for key in node.attrib)
    objects = {node.get('id'): node for node in model.iter(f'{CORE_3MF}object')}

    def points(ident):
        node = objects[ident]
        mesh = node.find(f'{CORE_3MF}mesh')
        if mesh is None:
            return [p for component in node.iter(f'{CORE_3MF}component') for p in points(component.get('objectid'))]
        vertices = [[float(v.get(axis)) for axis in 'xyz'] for v in mesh.iter(f'{CORE_3MF}vertex')]
        for triangle in mesh.iter(f'{CORE_3MF}triangle'):
            corners = [int(triangle.get(key)) for key in ('v1', 'v2', 'v3')]
            assert len(set(corners)) == 3 and max(corners) < len(vertices)
        return vertices

    items = []
    for item in model.find(f'{CORE_3MF}build'):
        matrix = [float(value) for value in item.get('transform').split()]
        assert matrix[:9] == [1, 0, 0, 0, 1, 0, 0, 0, 1]
        world = [[p[axis] + matrix[9 + axis] for axis in range(3)] for p in points(item.get('objectid'))]
        items.append((objects[item.get('objectid')].get('name'), item.get('partnumber'),
                      [min(p[axis] for p in world) for axis in range(3)], [max(p[axis] for p in world) for axis in range(3)]))
    return items


def test_plain_3mf_places_each_named_part_as_on_the_plate(tmp_path):
    authored = trimesh.creation.box((40, 20, 6), trimesh.transformations.translation_matrix((100, -30, 3)))
    authored.export(tmp_path / 'part-0001-straight.stl')
    turned = trimesh.creation.box((12, 30, 8))
    turned.apply_translation(-turned.bounds[0])  # print-oriented meshes sit at the origin
    turned.export(tmp_path / 'part-0002-ramp.stl')
    spine = trimesh.creation.box((40, 4, 2), trimesh.transformations.translation_matrix((100, -30, 1)))
    spine.export(tmp_path / 'part-0003-flex-spine.stl')
    authored.export(tmp_path / 'part-0003-flex.stl')
    parts = [
        {'instanceId': 'main:0:straight', 'code': '1', 'plateLabel': 'part-0001-straight.stl', 'printOrientation': 'as-authored-flat',
         'bounds': {'min': list(authored.bounds[0])}, 'plannedPlacement': {'x': 7, 'y': 7}},
        {'instanceId': 'main:1:ramp', 'code': '2A', 'plateLabel': 'part-0002-ramp.stl', 'printOrientation': 'side-on-bed',
         'bounds': {'min': [-50, -50, 0]}, 'plannedPlacement': {'x': 54, 'y': 7}},
        {'instanceId': 'main:2:flex', 'code': '3', 'plateLabel': 'part-0003-flex.stl', 'printOrientation': 'as-authored-flat',
         'materialLabels': ['part-0003-flex.stl', 'part-0003-flex-spine.stl'], 'materials': [{'role': 'rigid'}, {'role': 'spine'}],
         'bounds': {'min': list(authored.bounds[0])}, 'plannedPlacement': {'x': 7, 'y': 44}},
    ]
    target = tmp_path / 'plate-01.3mf'
    write_core_3mf(target, tmp_path, parts, 1, ['PLA Basic', 'TPU for AMS'])
    items = read_core_3mf(target)
    # Each object is named by its code, as in the guide and the Print panel.
    assert [(name, number) for name, number, _, _ in items] == [('1', 'main:0:straight'), ('2A', 'main:1:ramp'), ('3', 'main:2:flex')]
    for (_, _, low, high), size in zip(items, ([40, 20, 6], [12, 30, 8], [40, 20, 6])):
        assert [round(v, 6) for v in high] == [round(a + b, 6) for a, b in zip(low, size)]
    assert [[round(v, 6) for v in low] for _, _, low, _ in items] == [[7, 7, 0], [54, 7, 0], [7, 44, 0]]
    with zipfile.ZipFile(target) as archive:
        model = archive.read('3D/3dmodel.model').decode()
    assert 'paint_supports' not in model and 'slic3rpe' not in model.lower() and 'BambuStudio' not in model
    # The two-material strip is one object of two named parts, each on its own base material.
    assert re.search(r'<base name="PLA Basic"[^>]*/><base name="TPU for AMS"', model)
    assert re.search(r'name="3 spine" pid="1" pindex="1"', model)
