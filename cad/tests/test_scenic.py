"""Buffer stop, rerailer, level-crossing road tiles and colour marker plates:
watertight single solids, ports, running clearance and real slices; digital geometry only."""

import json
import zipfile

import numpy as np
import pytest
import trimesh

from cad.models import buffer, composite, brick_end, rerailer, road
from cad.service.generate import generate_part
from cad.service.plates import export_plates, plate_style

SHARED = {'rail_gauge': 40, 'rail_interface_width': 2.4, 'body_width': 63.8, 'base_thickness': 3.2,
          'rail_height': 6.4, 'connector_version': 1, 'fit_adjustment': 0}
X1C = {'name': 'X1 Carbon', 'material': 'Bambu PLA Basic', 'profile': '0.20mm Standard @BBL X1C',
       'nozzleMm': .4, 'orientation': 'flat', 'envelope': {'x': 256, 'y': 256, 'z': 250}}
A1M = {'name': 'A1 mini', 'material': 'Bambu PLA Basic', 'profile': '0.20mm Standard @BBL A1M',
       'nozzleMm': .4, 'orientation': 'flat', 'envelope': {'x': 180, 'y': 180, 'z': 180}}
STYLES = {'detailed': {}, 'fast': {'lite': 1}}
RAIL_TOP = brick_end.RAIL_TOP
# Running envelope of brick train wheels: flanges in the 64022 flangeway down to 3.2 mm below the
# rail tops, treads and everything else above the rail tops.
FLANGEWAY = composite.FLANGEWAY


def solid_volume(mesh, low, high):
    """Volume of the mesh inside an axis-aligned box."""
    part = trimesh.boolean.intersection([mesh, brick_end._box(low, high)], engine='manifold')
    return part.volume if len(part.faces) else 0.


def running_clearance(mesh, low, high):
    """Material where wheels run between two stations (inside the end ties: the connector ends
    are the shared, accepted brick ends): flangeways from the flange floor up, and anything
    above the rail tops."""
    flangeways = sum(solid_volume(mesh, (low, lo + .05, composite.FLANGE_FLOOR + .05), (high, hi - .05, 60))
                     for lo, hi in (FLANGEWAY, (-FLANGEWAY[1], -FLANGEWAY[0])))
    return flangeways + solid_volume(mesh, (low, -40, RAIL_TOP + .05), (high, 40, 60))


def request(family, parameters, envelope=X1C['envelope']):
    return {'version': 1, 'units': 'mm', 'family': family, 'parameters': parameters,
            'printer_envelope': envelope, 'part_revision': 'synthetic-scenic', 'layout_revision': 'synthetic-scenic'}


@pytest.mark.parametrize('style', STYLES)
@pytest.mark.parametrize('run', buffer.RUNS)
def test_buffer_stop_is_one_solid_with_one_connector_and_a_beam_at_coupler_height(run, style):
    p = {**SHARED, 'run': run, **STYLES[style]}
    mesh = buffer.mesh(p)
    assert mesh.is_watertight and len(mesh.split(only_watertight=False)) == 1
    assert [end['index'] for end in buffer.connector_ends(p)] == [0]
    assert [port['id'] for port in buffer.ports(p)] == ['start', 'end']
    face = buffer.face(run)
    # The beam spans the full track width at 25.6 mm (8 plates) and stands proud of the block below it.
    low, high = buffer.BEAM
    assert solid_volume(mesh, (face - buffer.LIP, -31, low), (face - buffer.LIP + .5, 31, high)) == pytest.approx(
        .5 * 62 * (high - low), rel=1e-3)
    assert solid_volume(mesh, (face - buffer.LIP, -31, RAIL_TOP + .1), (face - .05, 31, low - buffer.LIP - .1)) == 0
    assert low < buffer.COUPLER < high and buffer.COUPLER == pytest.approx(RAIL_TOP + 16)
    # Rails and flangeways stay clear up to the block.
    assert running_clearance(mesh, composite.END_TIE, face - buffer.LIP) == 0
    assert mesh.bounds[1, 2] == pytest.approx(high)


@pytest.mark.parametrize('style', STYLES)
@pytest.mark.parametrize('run', rerailer.RUNS)
def test_rerailer_guides_never_touch_normal_running(run, style):
    p = {**SHARED, 'run': run, **STYLES[style]}
    mesh = rerailer.mesh(p)
    assert mesh.is_watertight and len(mesh.split(only_watertight=False)) == 1
    assert running_clearance(mesh, composite.END_TIE, run - composite.END_TIE) == 0
    foot, top, far_top, far_foot = rerailer.stations(run)
    middle = (top + far_top) / 2
    for side in (1, -1):
        # Outside ramps lift a flange-riding wheel to within 0.2 mm of the rail tops...
        lo, hi = sorted((side * (rerailer.HEAD + .1), side * 31.5))
        assert solid_volume(mesh, (middle - 1, lo, rerailer.PLATEAU - .1), (middle + 1, hi, rerailer.PLATEAU)) > 0
        # ...and the guard ridge meets the bow-tie guide at rail-top height.
        lo, hi = sorted((side * (composite.GUARD[0] + .1), side * (composite.GUARD[1] - .1)))
        assert solid_volume(mesh, (middle - 1, lo, RAIL_TOP - .2), (middle + 1, hi, RAIL_TOP)) > 0
    # The bow ties start on the centreline, low, near each end.
    assert solid_volume(mesh, (foot + 2.5, -.3, composite.FLANGE_FLOOR - .5), (foot + 3, .3, composite.FLANGE_FLOOR)) > 0
    assert solid_volume(mesh, (far_foot - 3, -.3, composite.FLANGE_FLOOR - .5), (far_foot - 2.5, .3, composite.FLANGE_FLOOR)) > 0
    # Guides are symmetric end for end, so it rerails both ways.
    mirrored = mesh.copy()
    mirrored.apply_transform(np.diag([-1, -1, 1, 1]))
    mirrored.apply_translation((run, 0, 0))
    difference = trimesh.boolean.difference([mesh, mirrored], engine='manifold')
    assert difference.volume < .01 * mesh.volume


def test_scenic_track_rejects_other_lengths():
    with pytest.raises(ValueError, match='32 or 64'):
        buffer.validate({**SHARED, 'run': 48})
    with pytest.raises(ValueError, match='64 or 128'):
        rerailer.validate({**SHARED, 'run': 96})


ROAD_CASES = [dict(run=128, angle=90, side=side, kind=kind, half=0) for side in (1, -1) for kind in (0, 1)] + \
    [dict(run=256, angle=angle, side=side, kind=kind, half=half)
     for angle in (45, 135) for side in (1, -1) for kind in (0, 1) for half in (1, -1)]


@pytest.mark.parametrize('p', ROAD_CASES, ids=lambda p: '-'.join(f'{k}{v}' for k, v in p.items()))
def test_road_tiles_meet_the_track_flush_and_step_down_to_60304_plates(p):
    mesh = road.mesh(p)
    assert mesh.is_watertight and len(mesh.split(only_watertight=False)) == 1
    assert mesh.bounds[1, 2] == pytest.approx(RAIL_TOP)
    assert mesh.bounds[0, 2] == pytest.approx(0)
    y = sorted(abs(v) for v in mesh.bounds[:, 1])
    # Clear of the 63.8 mm track body; a filler stops on the midline between tracks 16 studs apart.
    assert y[0] == pytest.approx(road.TRACK_EDGE)
    if p['kind']:
        assert y[1] == pytest.approx(road.TRACK_EDGE + road.FILLER)
    # Top at rail height along the track edge; an apron ends on the road plates' 6.4 mm top.
    side = p['side']
    edge = sorted((side * road.TRACK_EDGE, side * (road.TRACK_EDGE + 2)))
    assert solid_volume(mesh, (-400, edge[0], RAIL_TOP - .3), (600, edge[1], RAIL_TOP)) > 0
    tops = mesh.vertices[mesh.vertices[:, 2] > road.ROAD_TOP - road.ROOF - .1][:, 2]
    assert np.isclose(tops, road.ROAD_TOP, atol=1e-4).any() == (not p['kind'])
    # Studs under the tile: a pocket over each keeps the roof clear of them.
    stud = brick_end.PROFILE['brickAttachment']
    for x, yy in road.Tile(p).studs(road.Tile(p).plan()):
        column = brick_end._box((x - .5, yy - .5, 0), (x + .5, yy + .5, stud['studHeight']))
        hit = trimesh.boolean.intersection([mesh, column], engine='manifold')
        assert not len(hit.faces) or hit.volume < 1e-6


def test_road_tile_rejects_unknown_shapes():
    with pytest.raises(ValueError, match='45, 90 or 135'):
        road.validate(dict(run=128, angle=60, side=1, kind=0, half=0))
    with pytest.raises(ValueError, match='whole studs'):
        road.validate(dict(run=130, angle=90, side=1, kind=0, half=0))


def test_marker_inserts_print_on_their_own_colour_plate():
    detailed = {'family': composite.FAMILY, 'parameters': {'marker': 3, 'marker_s': 64}}
    insert = {'family': composite.INSERT_FAMILY, 'parameters': {'marker': 9}}
    assert plate_style(detailed) == 'detailed'
    assert plate_style(insert) == 'marker-9'
    assert plate_style({**insert, 'parameters': {'marker': 3}}) == 'marker-3'


def generate(tmp_path, family, parameters, printer, name):
    generated = generate_part(request(family, parameters, printer['envelope']), tmp_path / 'generated' / name)
    return {'instanceId': name, 'code': name, 'name': name, 'family': family, 'parameters': parameters, 'meshPath': generated['mesh'],
            'bounds': generated['bounds'], 'ports': generated['ports']}


@pytest.mark.parametrize('printer', [X1C, A1M], ids=['X1C', 'A1mini'])
def test_every_scenic_part_slices_without_warnings_in_both_styles(tmp_path, printer):
    parts = []
    for style, extra in STYLES.items():
        parts.append(generate(tmp_path, buffer.FAMILY, {**SHARED, 'run': 32, **extra}, printer, f'{style}-buffer'))
        parts.append(generate(tmp_path, rerailer.FAMILY, {**SHARED, 'run': 128, **extra}, printer, f'{style}-rerailer'))
        street = composite.straight(SHARED, 128)
        parts.append(generate(tmp_path, composite.FAMILY, {**street, 'street': 1, 'marker': 9, 'marker_s': 64, **extra},
                              printer, f'{style}-street-marker'))
    parts.append(generate(tmp_path, road.FAMILY, dict(run=128, angle=90, side=1, kind=0, half=0), printer, 'apron'))
    parts.append(generate(tmp_path, road.FAMILY, dict(run=256, angle=45, side=-1, kind=1, half=1), printer, 'filler'))
    parts.append(generate(tmp_path, composite.INSERT_FAMILY, {'marker': 9}, printer, 'marker-red'))
    parts.append(generate(tmp_path, composite.INSERT_FAMILY, {'marker': 10}, printer, 'marker-white'))
    (tmp_path / 'plates').mkdir()
    plates = export_plates(parts, printer, tmp_path / 'plates')
    by_id = {part['instanceId']: part for part in parts}
    for plate in plates:
        styles = {plate_style(by_id[obj['instanceId']]) for obj in plate['objects']}
        assert len(styles) == 1
        assert plate['slice']['warning_message'] == ''
        style = styles.pop()
        if style.startswith('marker-'):
            colour = {'marker-9': ('Red', '#C91A09'), 'marker-10': ('White', '#F4F4F4')}[style]
            assert plate['filamentColour'] == colour[0]
            with zipfile.ZipFile(tmp_path / 'plates' / plate['project']) as archive:
                settings = json.loads(archive.read('Metadata/project_settings.config'))
            assert settings['filament_colour'] == [colour[1]]
        else:
            assert 'filamentColour' not in plate
    # Connector tongues are painted for support; loose tiles and inserts need none.
    for plate in plates:
        families = {by_id[obj['instanceId']]['family'] for obj in plate['objects']}
        assert plate['supportsEnabled'] == bool(families & {buffer.FAMILY, rerailer.FAMILY, composite.FAMILY})
    assert {plate['filamentColour'] for plate in plates if 'filamentColour' in plate} == {'Red', 'White'}
