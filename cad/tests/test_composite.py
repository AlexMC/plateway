"""Composite track: parity with printed straight/curves, wedge profiles, cant,
options, validation, support painting and real slices; digital geometry only."""

import math
import re

import numpy as np
import pytest
import trimesh

from cad.models import composite, brick_end
from cad.service.errors import UserError
from cad.service.generate import generate_part
from cad.service.plates import END_REACH, FLOATING_END, RAIL_BAND, enforced_faces, export_plates

SHARED = {'rail_gauge': 40, 'rail_interface_width': 2.4, 'body_width': 63.8, 'base_thickness': 3.2,
          'rail_height': 6.4, 'connector_version': 1, 'fit_adjustment': 0}
X1C = {'name': 'X1 Carbon', 'material': 'Bambu PLA Basic', 'profile': '0.20mm Standard @BBL X1C',
       'nozzleMm': .4, 'orientation': 'flat', 'envelope': {'x': 256, 'y': 256, 'z': 250}}
A1M = {'name': 'A1 mini', 'material': 'Bambu PLA Basic', 'profile': '0.20mm Standard @BBL A1M',
       'nozzleMm': .4, 'orientation': 'flat', 'envelope': {'x': 180, 'y': 180, 'z': 180}}
R40, R56 = 1 / 320, 1 / 448
STUD_TOP = brick_end.PROFILE['brickAttachment']['studBaseZ'] + brick_end.PROFILE['brickAttachment']['studHeight']


def parameters(segments, **changes):
    p = {**SHARED, 'segments': len(segments), 'z0': 0, 'z1': 0, 'grade0': 0, 'grade1': 0,
         'vcurve': 0, 'cant0': 0, 'cant1': 0, 'ends': 3}
    for index, (length, k0, k1) in enumerate(segments):
        p.update({f's{index}_len': length, f's{index}_k0': k0, f's{index}_k1': k1})
    p.update(changes)
    return p


def request(family, p):
    return {'version': 1, 'units': 'mm', 'family': family, 'parameters': p,
            'printer_envelope': X1C['envelope'], 'part_revision': 'synthetic-composite',
            'layout_revision': 'synthetic-composite'}


# Every case fits the A1 mini's 166 mm usable plate.
CASES = {
    'straight': ([(128, 0, 0)], {}),
    'r320': ([(320 * math.pi / 8, R40, R40)], {}),
    'clothoid-arc': ([(48, 0, R56), (64, R56, R56)], {}),
    's-bend': ([(64, R56, R56), (64, -R56, -R56)], {}),
    'graded-helix': ([(120, R56, R56)], {'z1': 3.6, 'grade0': .03, 'grade1': .03, 'vcurve': 2000}),
    'canted-arc': ([(120, R56, R56)], {'ends': 1, 'cant1': 4}),
    'ballast': ([(128, 0, 0)], {'ballast': 1}),
    'guard-rail': ([(128, 0, 0)], {'guard_rail': 1}),
    'street': ([(128, 0, 0)], {'street': 1}),
    'marker': ([(128, 0, 0)], {'marker': 3, 'marker_s': 60}),
}
STYLES = {'detailed': {}, 'fast': {'lite': 1}}


@pytest.fixture(scope='module')
def generated(tmp_path_factory):
    """Each (case, style) is generated once through generate_part (checked STL)."""
    root, cache = tmp_path_factory.mktemp('composite'), {}

    def get(case, style):
        if (case, style) not in cache:
            segments, changes = CASES[case]
            p = parameters(segments, **changes, **STYLES[style])
            result = generate_part(request('composite_track', p), root / f'{case}-{style}')
            cache[case, style] = (p, result, trimesh.load_mesh(result['mesh'], process=True))
        return cache[case, style]
    return get


def _symmetric_difference(a, b):
    return (trimesh.boolean.difference([a, b], engine='manifold').volume +
            trimesh.boolean.difference([b, a], engine='manifold').volume)


def _stud_centres(mesh):
    """Area-weighted centres of every stud top disc (horizontal faces at z=4.8)."""
    faces = np.flatnonzero((mesh.face_normals[:, 2] > .999) &
                           (np.abs(mesh.triangles_center[:, 2] - STUD_TOP) < 1e-3))
    centres, weights = [], []
    for face in faces:
        point, area = mesh.triangles_center[face][:2], mesh.area_faces[face]
        for index, centre in enumerate(centres):
            if np.linalg.norm(centre / weights[index] - point) < 3:
                centres[index] += point * area
                weights[index] += area
                break
        else:
            centres.append(point * area)
            weights.append(area)
    return np.array(sorted((c / w).round(4).tolist() for c, w in zip(centres, weights)))


def _solid(mesh, box):
    return abs(trimesh.boolean.intersection([mesh, box], engine='manifold').volume)


def _placed(low, high, frame):
    box = brick_end._box(low, high)
    box.apply_transform(frame)
    return box


@pytest.mark.parametrize('style', STYLES)
@pytest.mark.parametrize('segment,family,shape', [
    ((128, 0, 0), 'printed_straight', {'run': 128}),
    ((320 * math.pi / 8, R40, R40), 'printed_curve', {'radius': 320, 'sweep': math.pi / 8}),
    ((448 * math.pi / 8, R56, R56), 'printed_curve', {'radius': 448, 'sweep': math.pi / 8}),
])
def test_single_straight_or_arc_equals_the_printed_piece(tmp_path, style, segment, family, shape):
    composite_result = generate_part(request('composite_track', parameters([segment], **STYLES[style])),
                                     tmp_path / 'composite')
    reference = generate_part(request(family, {**SHARED, **shape, **STYLES[style]}), tmp_path / 'reference')
    mesh = trimesh.load_mesh(composite_result['mesh'], process=True)
    expected = trimesh.load_mesh(reference['mesh'], process=True)
    assert abs(mesh.volume - expected.volume) <= 1e-4 * expected.volume
    assert _symmetric_difference(mesh, expected) < 1
    assert np.allclose(_stud_centres(mesh), _stud_centres(expected), atol=1e-3)
    assert len(_stud_centres(mesh)) > 0
    for port, reference_port in zip(composite_result['ports'], reference['ports']):
        assert np.allclose(port['position'], reference_port['position'], atol=1e-9)
        assert port['heading'] == pytest.approx(reference_port['heading'], abs=1e-12)


@pytest.mark.parametrize('style', STYLES)
@pytest.mark.parametrize('case', CASES)
def test_every_case_is_one_flat_bottomed_solid_with_exact_ports(generated, case, style):
    p, result, mesh = generated(case, style)
    assert mesh.is_watertight and mesh.body_count == 1
    spec = composite.validate(p)
    x, y, heading = composite.Plan(spec.segments).final
    start, end = result['ports']
    assert start['position'] == [0, 0, 0] and start['pitch'] == pytest.approx(math.atan(p['grade0']))
    assert np.allclose(end['position'], [x, y, p['z1']], atol=1e-9)
    assert end['heading'] == pytest.approx(heading) and end['pitch'] == pytest.approx(math.atan(p['grade1']))
    # One flat underside: the lowest point of the profile and connector contacts.
    assert mesh.bounds[0, 2] == pytest.approx(spec.base, abs=1e-3)
    bottom = (mesh.face_normals[:, 2] < -.999) & (np.abs(mesh.triangles_center[:, 2] - spec.base) < 1e-3)
    assert mesh.area_faces[bottom].sum() > 600


def test_clothoid_joins_the_arc_with_continuous_curvature():
    plan = composite.Plan(((48, 0, R56), (64, R56, R56)))
    # Heading of a linear-curvature spiral: integral of k.
    assert plan.state(48)[2] == pytest.approx(48 * R56 / 2)
    assert plan.state(48)[3] == pytest.approx(R56)
    x, y, heading, _ = plan.state(112)
    assert heading == pytest.approx(48 * R56 / 2 + 64 * R56)
    # Numerically integrated end point agrees with a fine Riemann sum.
    s = np.linspace(0, 48, 200001)
    theta = R56 * s * s / 96
    assert plan.state(48)[0] == pytest.approx(np.trapezoid(np.cos(theta), s), abs=1e-6)
    assert plan.state(48)[1] == pytest.approx(np.trapezoid(np.sin(theta), s), abs=1e-6)


def test_graded_curve_slice_whose_face_merge_breaks_still_exports_one_closed_solid():
    # The A1 mini's second bed part of a 3 % ramp start on a 22.5 degree R56 curve: OCC's
    # coplanar-face merge invalidates its sewn solid, so it keeps its triangle faces.
    p = parameters([(111.92918860102841, R56, R56)], z1=2.289706411030924, grade0=.010913481812015674,
                   grade1=.03, vcurve=2560)
    shape = composite.build(p)
    assert shape.isValid() and len(shape.Solids()) == 1 and composite._exports_closed(shape)


@pytest.mark.parametrize('style', STYLES)
def test_graded_helix_rails_follow_the_profile_over_a_flat_clutching_underside(generated, style):
    p, _, mesh = generated('graded-helix', style)
    spec = composite.validate(p)
    route = composite.Route(spec)
    for station in (40, 60, 80):
        frame = route.frame(station)
        # Rail head on the Hermite profile; nothing above it.
        assert _solid(mesh, _placed((-.5, 19.5, 9.3), (.5, 20.5, 9.5), frame)) > .15
        assert _solid(mesh, _placed((-.5, 19.5, 9.7), (.5, 20.5, 10.5), frame)) < 1e-6
    if style == 'fast':
        return
    for station in composite.Builder(spec).tie_centres():
        bed = route.bed_frame(station)
        # Standard flat underside clutch at the bed: open central bay, solid tie above.
        assert _solid(mesh, _placed((-2, -8, spec.base + .2), (2, -6, spec.base + 1.6), bed)) < 1e-6
        assert _solid(mesh, _placed((-2, -8, spec.base + 2), (2, -6, spec.base + 2.8), bed)) > .99 * 6.4


@pytest.mark.parametrize('style', STYLES)
def test_cant_lifts_only_the_outer_rail_and_keeps_the_underside_flat(generated, style):
    p, _, mesh = generated('canted-arc', style)
    spec = composite.validate(p)
    route = composite.Route(spec)
    lift = 2 * brick_end.PROFILE['railGauge'] / 2 * math.tan(math.radians(4))
    frame = route.frame(spec.length - 12)
    phi = math.radians(4) * (spec.length - 12) / spec.length
    outer = 9.6 + 40 * math.tan(phi)
    assert lift == pytest.approx(2.797, abs=1e-3)
    # Positive cant raises the right (-y) rail; the inner (+y) rail head stays at 9.6.
    assert _solid(mesh, _placed((-.5, -20.3, outer - .15), (.5, -19.7, outer - .03), frame)) > .03
    assert _solid(mesh, _placed((-.5, -20.3, outer + .03), (.5, -19.7, outer + 1), frame)) < 1e-6
    assert _solid(mesh, _placed((-.5, 19.7, 9.45), (.5, 20.3, 9.57), frame)) > .03
    assert _solid(mesh, _placed((-.5, 19.7, 9.63), (.5, 20.3, 10.5), frame)) < 1e-6
    assert mesh.bounds[0, 2] == pytest.approx(0, abs=1e-3)


def test_canted_studs_stand_perpendicular_on_the_rolled_deck(generated):
    p, _, mesh = generated('canted-arc', 'detailed')
    spec = composite.validate(p)
    builder = composite.Builder(spec)
    station = builder.tie_centres()[-1]
    phi = spec.cant(station)
    for column in (-28, -12, 12):
        # Rolled about the inner rail's deck line: column -28 is lifted most.
        frame = builder.route.frame(station) @ composite._roll(phi, column)
        assert _solid(mesh, brick_end._cylinder(2.2, 3.4, 4.6, 4, column).apply_transform(frame)) > 14
    flat = builder.route.frame(station)
    assert _solid(mesh, brick_end._cylinder(2.2, 3.4, 4.6, 4, 28).apply_transform(flat)) > 14


@pytest.mark.parametrize('style', STYLES)
def test_options_add_their_geometry(generated, style):
    _, _, plain = generated('straight', style)
    level = np.eye(4)
    p, _, ballast = generated('ballast', style)
    for side in (1, -1):
        # Shoulder at deck level, open baseplate stud channel on the y=36 row.
        assert _solid(ballast, _placed((60, side * 33 - .5, 2.4), (68, side * 33 + .5, 3.0), level)) > 4
        assert _solid(ballast, _placed((60, side * 36 - 2, 0), (68, side * 36 + 2, 2.1), level)) < 1e-6
        assert _solid(plain, _placed((60, side * 36 - 2, 0), (68, side * 36 + 2, 3), level)) < 1e-6
    _, _, guard = generated('guard-rail', style)
    gap = 48  # between the ties at 32 and 64
    for side in (1, -1):
        ridge = _placed((gap - 4, side * 14.1 - .5, 8), (gap + 4, side * 14.1 + .5, 9.5), level)
        assert _solid(guard, ridge) > 7 and _solid(plain, ridge) < 1e-6
        flangeway = _placed((gap - 4, side * 16.8 - 1.5, 6.5), (gap + 4, side * 16.8 + 1.5, 9.7), level)
        assert _solid(guard, flangeway) < 1e-6
    _, _, street = generated('street', style)
    road = _placed((40, -10, 9.3), (80, 10, 9.55), level)
    assert _solid(street, road) > 0.99 * 40 * 20 * .25
    for side in (1, -1):
        groove = _placed((40, side * 16.8 - 1.8, 6.5), (80, side * 16.8 + 1.8, 9.7), level)
        assert _solid(street, groove) < 1e-6
    p, _, marker = generated('marker', style)
    tie = composite.Builder(composite.validate(p)).marker_tie()
    centre = (tie[0] + tie[1]) / 2
    assert centre == 64
    rim = _placed((centre - 7.8, -7.8, 3.3), (centre - 6.3, 7.8, 4.7), level)
    pocket = _placed((centre - 6, -6, 3.3), (centre + 6, 6, 5.5), level)
    assert _solid(marker, rim) > .95 * 1.5 * 15.6 * 1.4 and _solid(marker, pocket) < 1e-6
    if style == 'detailed':
        # The central studs make way for the pad; the others stay.
        assert _solid(plain, pocket) > 20
        assert _solid(marker, brick_end._cylinder(2.2, 3.4, 4.6, centre - 4, 12)) > 14


def test_marker_insert_is_a_separate_part_that_fits_the_recess(tmp_path):
    result = generate_part(request('marker_insert', {'marker': 3}), tmp_path)
    mesh = trimesh.load_mesh(result['mesh'])
    assert mesh.is_watertight and result['ports'] == []
    assert np.allclose(mesh.extents, [composite.MARKER_INSERT, composite.MARKER_INSERT, composite.MARKER_HEIGHT])
    assert composite.MARKER_POCKET - composite.MARKER_INSERT == pytest.approx(.4)
    for marker in (0, 11, 2.5):
        with pytest.raises(ValueError, match='marker'):
            generate_part(request('marker_insert', {'marker': marker}), tmp_path / str(marker))


@pytest.mark.parametrize('changes,message', [
    ({'cant0': 1}, 'cant0 must be 0 at a brick track connector end'),
    ({'ends': 2, 'cant1': 1}, 'cant1 must be 0'),
    ({'ends': 0, 'cant0': 4.5}, 'cant0 must not exceed 4'),
    ({'grade1': .061, 'z1': 7}, 'grade1 must not exceed 6'),
    ({'z1': 6}, 'grade exceeds 6 %'),
    ({'z1': 3, 'vcurve': 2000}, 'vertical curve radius'),
    ({'guard_rail': 1, 'street': 1}, 'omit guard_rail'),
    ({'ballast': 2}, 'ballast must be an integer'),
    ({'marker': 11}, 'marker must be an integer'),
    ({'marker': 1, 's0_len': 60}, 'needs at least one full tie'),
    ({'marker': 1, 'marker_s': 130}, 'marker_s must lie on the piece'),
    ({'s0_k0': 1 / 170, 's0_k1': 1 / 170}, 'curvature'),
    ({'s0_len': 20}, 'length must be from 24'),
    ({'ends': 4}, 'ends must be an integer'),
    ({'segments': 2}, 'requires exactly'),
    ({'s1_len': 5}, 'requires exactly'),
    ({'lite': 0}, 'lite must be 1'),
])
def test_invalid_parameters_are_rejected(tmp_path, changes, message):
    p = {**parameters([(128, 0, 0)]), **changes}
    with pytest.raises(ValueError, match=message):
        generate_part(request('composite_track', p), tmp_path)
    assert not list(tmp_path.iterdir())


def test_turning_and_connector_blends_are_bounded():
    with pytest.raises(ValueError, match='180 degrees'):
        composite.validate(parameters([(600, 1 / 176, 1 / 176)]))
    # A plain cut end may carry cant; a keyed assembly continues it.
    spec = composite.validate(parameters([(64, 0, 0)], ends=0, cant0=2, cant1=2))
    assert not spec.level and spec.ends == 0


def _painted(part, mesh):
    return enforced_faces(part, mesh.triangles_center, mesh.face_normals,
                          mesh.triangles_center[:, 2] - mesh.bounds[0, 2])


def test_support_painting_covers_every_connector_and_floating_ends(generated):
    p, result, mesh = generated('straight', 'detailed')
    part = {'family': 'composite_track', 'parameters': p, 'ports': result['ports']}
    painted = _painted(part, mesh)
    assert painted.any()
    centres = mesh.triangles_center[painted]
    near = np.minimum(np.abs(centres[:, 0]), np.abs(centres[:, 0] - 128))
    assert near.max() <= -END_REACH[0] and np.all((np.abs(centres[:, 1]) >= RAIL_BAND[0]) &
                                                  (np.abs(centres[:, 1]) <= RAIL_BAND[1]))
    # Plain ends carry no connector and get no support.
    p, result, mesh = generated('canted-arc', 'detailed')
    part = {'family': 'composite_track', 'parameters': p, 'ports': result['ports']}
    centres = mesh.triangles_center[_painted(part, mesh)]
    assert len(centres) and np.linalg.norm(centres[:, :2], axis=1).max() < 26
    # A graded end above the flat underside floats: its whole underside plane is painted.
    p, result, mesh = generated('graded-helix', 'detailed')
    part = {'family': 'composite_track', 'parameters': p, 'ports': result['ports']}
    ends = composite.connector_ends(p)
    assert [end['elevated'] for end in ends] == [True, True]
    centres = mesh.triangles_center[_painted(part, mesh)]
    for end in ends:
        u = ((centres[:, 0] - end['x']) * math.cos(end['heading'])
             + (centres[:, 1] - end['y']) * math.sin(end['heading']))
        v = np.abs((centres[:, 1] - end['y']) * math.cos(end['heading'])
                   - (centres[:, 0] - end['x']) * math.sin(end['heading']))
        mine = (u > -5) & (u < 8.5) & (v < 33)
        assert v[mine].max() > 30 and u[mine].max() > 7


def test_composite_longer_than_the_bed_never_reaches_a_plate(tmp_path):
    part = {'instanceId': 'long', 'family': 'composite_track',
            'parameters': parameters([(400, 0, 0)]), 'meshPath': str(tmp_path / 'missing.stl'),
            'bounds': {'min': [-3.7, -31.9, 0], 'max': [403.7, 31.9, 9.6], 'size': [407.4, 63.8, 9.6]},
            'ports': []}
    with pytest.raises(UserError, match='larger than the A1 mini bed; split it'):
        export_plates([part], A1M, tmp_path)


def _support_points(gcode):
    feature, x, y, z, points = None, 0., 0., 0., []
    for line in gcode.read_text().splitlines():
        if line.startswith('; FEATURE:'):
            feature = line.split(':', 1)[1].strip()
        elif line.startswith('; Z_HEIGHT:'):
            z = float(line.split(':', 1)[1])
        elif line.startswith(('G1 ', 'G2 ', 'G3 ')):
            values = dict((k, float(v)) for k, v in re.findall(r'([XYE])(-?[\d.]+)', line.split(';')[0]))
            nx, ny = values.get('X', x), values.get('Y', y)
            if feature and feature.startswith('Support') and values.get('E', 0) > 0 and (nx, ny) != (x, y):
                points.append(((x + nx) / 2, (y + ny) / 2, z))
            x, y = nx, ny
    return points


@pytest.mark.parametrize('printer', [X1C, A1M], ids=['X1C', 'A1mini'])
def test_every_case_slices_without_warnings_and_supports_only_its_ends(generated, tmp_path, printer):
    parts = []
    for case in CASES:
        for style in STYLES:
            p, result, _ = generated(case, style)
            parts.append({'instanceId': f'{case}-{style}', 'code': str(len(parts) + 1), 'name': f'{case} {style}',
                          'family': 'composite_track', 'parameters': p,
                          'meshPath': result['mesh'], 'bounds': result['bounds'], 'ports': result['ports']})
    plates = export_plates(parts, printer, tmp_path)
    by_id = {part['instanceId']: part for part in parts}
    ends = {(part['instanceId'], index): 0 for part in parts
            for index in range(2) if part['parameters']['ends'] & (1 << index)}
    for plate in plates:
        assert plate['slice']['warning_message'] == ''
        members = [by_id[obj['instanceId']] for obj in plate['objects']]
        for px, py, pz in _support_points(tmp_path / plate['gcode']):
            margin = 4.5 if pz > .25 else 7.0
            hits = []
            for part in members:
                place, low = part['plannedPlacement'], part['bounds']['min']
                x, y = px - place['x'] + low[0], py - place['y'] + low[1]
                for end in composite.connector_ends(part['parameters']):
                    dx, dy = x - end['x'], y - end['y']
                    u = dx * math.cos(end['heading']) + dy * math.sin(end['heading'])
                    v = abs(dy * math.cos(end['heading']) - dx * math.sin(end['heading']))
                    # Tongues and their half tie (the whole floating half tie when elevated,
                    # its support spreading past the painted faces), or open air in front
                    # of the port face.
                    # A floating end's tall support tower spreads up to 7 mm past its corners.
                    lateral = 31.9 + 7.0 if end['elevated'] else RAIL_BAND[1] + margin
                    reach = FLOATING_END[1] + margin if end['elevated'] else 7.9 + .5
                    in_end = -3.7 - margin <= u <= reach and v <= lateral
                    in_front = -3.7 - margin <= u < -.5 and v <= 31.9 + margin
                    if in_end or in_front:
                        hits.append((part['instanceId'], end['index']))
            assert hits, f'support away from every connector end at ({px:.1f}, {py:.1f}, {pz:.2f})'
            ends[hits[0]] += 1
    assert all(count > 20 for count in ends.values()), ends
