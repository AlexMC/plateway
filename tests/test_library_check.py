"""The community library's shared check (U15, KTD10, cad/library/check.py): binary STL pieces with marked ends, self-contained
train models, furniture presets."""
from functools import cache
import json
import math
from pathlib import Path
import struct
import subprocess
import sys
import tempfile

import numpy as np
import pytest
import trimesh

from cad.library import check
from cad.service.errors import UserError
from cad.service.generate import generate_part
from cad.service.plates import arrange, select_presets

LIBRARY = Path(__file__).resolve().parent / 'fixtures' / 'library'
INDEX = {item['id']: item for item in json.loads((LIBRARY / 'index.json').read_text())['items']}
CURVE, LOCO = INDEX['community_sample_curve_90'], INDEX['community_sample_loco']
FORM = json.loads((LIBRARY / 'furniture-form.json').read_text())


def stl(triangles) -> bytes:
    triangles = np.asarray(triangles, np.float32).reshape(-1, 3, 3)
    records = np.zeros(len(triangles), np.dtype([('normal', '<f4', 3), ('v', '<f4', (3, 3)), ('attr', '<u2')]))
    records['v'] = triangles
    return b'\0' * 80 + struct.pack('<I', len(triangles)) + records.tobytes()


def box(x0, y0, z0, x1, y1, z1):
    """A closed box, wound outwards."""
    v = [(x0, y0, z0), (x1, y0, z0), (x1, y1, z0), (x0, y1, z0), (x0, y0, z1), (x1, y0, z1), (x1, y1, z1), (x0, y1, z1)]
    quads = [(0, 3, 2, 1), (4, 5, 6, 7), (0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)]
    return [[v[a], v[b], v[c]] for q in quads for a, b, c in ((q[0], q[1], q[2]), (q[0], q[2], q[3]))]


# A straight slab of track, 100 mm long, 48 mm wide, 7 mm to the rail top: its ends face -x and +x.
SLAB = box(0, -24, 0, 100, 24, 7)
SLAB_ENDS = [{'x': 0, 'y': 0, 'z': 7, 'heading': math.pi}, {'x': 100, 'y': 0, 'z': 7, 'heading': 0}]


def piece(triangles=SLAB, ends=SLAB_ENDS):
    return check.check('piece', stl(triangles), {'name': 'Slab', 'ends': ends})


def refused(match, work, *args, **kwargs):
    with pytest.raises(check.Refused, match=match):
        work(*args, **kwargs)


def test_the_sample_curve_passes_with_its_marked_ends():
    data = (LIBRARY / CURVE['file']).read_bytes()
    assert check.check('piece', data, {'id': CURVE['id'], 'name': CURVE['name'], 'ends': CURVE['piece']['ends']}) == {
        'triangles': 740, 'size': [144.0, 163.0, 7.0]}


@pytest.mark.parametrize('data, message', [
    (b'solid slab\n facet normal 0 0 1\n  outer loop\n   vertex 0 0 0\n' + b' ' * 200, 'ASCII STL'),
    (stl(SLAB)[:-50], "length doesn't match its triangle count"),
    (stl(SLAB) + b'\0' * 7, "length doesn't match its triangle count"),
    (b'\0' * 25_000_000, 'limit is 20 MB'),
])
def test_ascii_mismatched_and_oversized_stl_are_refused_before_parsing(monkeypatch, data, message):
    monkeypatch.setattr(check, '_solid', lambda _triangles: pytest.fail('parsed'))
    refused(message, check.check, 'piece', data, {'name': 'x', 'ends': SLAB_ENDS})


def test_too_many_triangles_are_refused_before_parsing(monkeypatch):
    monkeypatch.setattr(check, '_solid', lambda _triangles: pytest.fail('parsed'))
    data = b'\0' * 80 + struct.pack('<I', 200_001) + b'\0' * 50 * 200_001
    refused('200,001 triangles; the limit is 200,000', check.check, 'piece', data, {'name': 'x'})


def test_a_mesh_with_holes_is_refused():
    refused('The mesh has holes', piece, SLAB[:-1])


def test_two_separate_parts_are_refused():
    refused('2 separate parts', piece, SLAB + box(0, 40, 0, 100, 60, 7))


def test_an_inside_out_mesh_is_refused():
    refused('inside out', piece, [[a, c, b] for a, b, c in SLAB])


def test_a_tiny_mesh_gets_the_unit_hint():
    refused('only 2 mm across: was it exported in inches or metres?', piece, box(0, -1, 0, 2, 1, 0.5))


def test_a_mesh_larger_than_the_bed_is_refused():
    refused('larger than the A1 mini bed', piece, box(0, -24, 0, 200, 24, 7))


def test_a_piece_too_wide_for_the_a1_mini_arrange_is_refused_with_the_limit():
    refused('170 mm × 48 mm × 7 mm: the A1 mini fits at most 166 mm × 166 mm in plan', piece, box(0, -24, 0, 170, 24, 7))
    refused('48 mm × 167 mm × 7 mm: the A1 mini fits at most 166 mm × 166 mm in plan', piece, box(0, -83.5, 0, 48, 83.5, 7))


def test_the_plan_limit_is_what_the_a1_mini_arrange_accepts():
    """check.py can't import the arrange (it runs standalone in the library repository), so it keeps the limit itself."""
    printer = {'name': 'A1 mini', 'material': 'Bambu PLA Basic', 'profile': '0.20mm Standard @BBL A1M', 'nozzleMm': .4,
               'orientation': 'flat', 'envelope': {'x': 180, 'y': 180, 'z': 180}}
    presets, plan = select_presets(printer), check.PIECE_PLAN
    assert len(arrange([{'instanceId': 'fits', 'bounds': {'size': [plan, plan, check.BED]}}], printer, presets)) == 1
    for size in ([plan + .5, plan, 7], [plan, plan + .5, 7]):
        with pytest.raises(UserError, match='too large for the A1 mini bed'):
            arrange([{'instanceId': 'wider', 'bounds': {'size': size}}], printer, presets)


def test_ends_on_the_end_faces_pass_and_ends_away_from_the_boundary_are_refused():
    assert piece()['triangles'] == 12
    refused('End 2 is not on the boundary of the mesh', piece, SLAB, [SLAB_ENDS[0], {**SLAB_ENDS[1], 'x': 60}])
    refused('End 1 is 10 mm off the middle of its end face', piece, SLAB, [{**SLAB_ENDS[0], 'y': 10}, SLAB_ENDS[1]])
    refused('mark it at rail height', piece, SLAB, [{**SLAB_ENDS[0], 'z': 3}, {**SLAB_ENDS[1], 'z': 3}])


def test_an_end_on_a_face_narrower_than_a_connector_is_refused():
    refused('End 1 is on a face only 12 mm wide', piece, box(0, -6, 0, 100, 6, 7), SLAB_ENDS)


def test_a_flipped_end_points_into_the_piece():
    refused('End 2 points into the piece: flip its arrow', piece, SLAB, [SLAB_ENDS[0], {**SLAB_ENDS[1], 'heading': math.pi}])


def test_ends_must_make_a_piece_as_the_app_requires():
    """`meshEndsProblem` (community.ts): level, at least 16 mm apart, facing away from each other, turning at most 90°."""
    start = {'x': 0, 'y': 0, 'z': 7, 'heading': math.pi}
    assert check.ends_problem(start, {'x': 120, 'y': 120, 'z': 7, 'heading': math.pi / 2}) is None
    assert check.ends_problem(start, {'x': 0, 'y': 100, 'z': 7, 'heading': math.pi}) == 'The ends do not face away from each other.'
    assert check.ends_problem(start, {'x': 10, 'y': 0, 'z': 7, 'heading': 0}) == 'The ends are too close together.'
    assert check.ends_problem(start, {'x': 100, 'y': 0, 'z': 8, 'heading': 0}) == 'The ends are not at the same rail height.'


def test_both_ends_must_be_marked():
    refused('Mark both ends', piece, SLAB, SLAB_ENDS[:1])


@cache
def printed_straight() -> bytes:
    """Plateway's own 128 mm brick straight (connector v1, fit 0) as a binary STL: its tongue and socket split
    each end plane into separate coplanar faces."""
    parameters = {'run': 128, 'body_width': 63.8, 'base_thickness': 3.2, 'rail_gauge': 40, 'rail_interface_width': 2.4,
                  'rail_height': 6.4, 'connector_version': 1, 'fit_adjustment': 0}
    with tempfile.TemporaryDirectory() as folder:
        cad = generate_part({'version': 1, 'units': 'mm', 'family': 'printed_straight', 'parameters': parameters,
                             'printer_envelope': {'x': 180, 'y': 180, 'z': 180}, 'part_revision': 'check',
                             'layout_revision': 'check'}, Path(folder))
        return trimesh.load_mesh(cad['mesh'], process=False).export(file_type='stl')


STRAIGHT_ENDS = [{'x': 0, 'y': 0, 'z': 9.6, 'heading': math.pi}, {'x': 128, 'y': 0, 'z': 9.6, 'heading': 0}]


def test_a_brick_straight_passes_with_ends_mid_span_of_its_split_end_faces():
    """The connector's tongue and socket cut the end plane into pieces; together they span the body's width."""
    data = printed_straight()
    assert check.check('piece', data, {'name': 'Straight', 'ends': STRAIGHT_ENDS})['triangles'] > 0
    off = [{**STRAIGHT_ENDS[0], 'y': 8}, STRAIGHT_ENDS[1]]
    refused('End 1 is 8 mm off the middle of its end face', check.check, 'piece', data, {'name': 'Straight', 'ends': off})


LEV = {'url': 'https://www.printables.com/model/466240', 'authors': ['lev']}


def test_a_piece_adapted_from_a_cc_by_model_names_its_source_url_and_authors():
    def sourced(source):
        return check.check('piece', stl(SLAB), {'name': 'Slab', 'ends': SLAB_ENDS, 'source': source})

    assert sourced(LEV)['triangles'] == 12
    refused("source's web address", sourced, {**LEV, 'url': 'printables.com/model/466240'})
    refused("source's authors", sourced, {**LEV, 'authors': []})
    refused('The source must give its URL and authors', sourced, {**LEV, 'licence': 'CC-BY-4.0'})
    refused('The source must give its URL and authors', sourced, 'lev')


def glb_parts(data: bytes) -> tuple[dict, bytes]:
    json_length = struct.unpack_from('<I', data, 12)[0]
    return json.loads(data[20:20 + json_length]), data[28 + json_length:]


def glb(gltf: dict, binary: bytes) -> bytes:
    text = json.dumps(gltf, separators=(',', ':')).encode()
    text += b' ' * (-len(text) % 4)
    return (struct.pack('<III', 0x46546C67, 2, 28 + len(text) + len(binary)) + struct.pack('<II', len(text), 0x4E4F534A) + text +
            struct.pack('<II', len(binary), 0x004E4942) + binary)


LOCO_GLB = (LIBRARY / LOCO['file']).read_bytes()


def train(data=LOCO_GLB, **changes):
    metadata = {'name': LOCO['name'], **{key: LOCO['train'][key] for key in ('year', 'power', 'gauge', 'car')},
                'licence': 'CC-BY-4.0', **changes}
    return check.check('train', data, {key: value for key, value in metadata.items() if value is not None})


def changed(edit) -> bytes:
    gltf, binary = glb_parts(LOCO_GLB)
    edit(gltf)
    return glb(gltf, binary)


def test_the_sample_locomotive_passes():
    assert train() == {'triangles': 4528, 'bytes': len(LOCO_GLB)}


def test_a_train_with_an_external_image_uri_is_refused():
    data = changed(lambda gltf: gltf.update(images=[{'uri': 'https://example.com/paint.png'}]))
    refused('refers to an external file', train, data)


def test_a_train_with_an_external_buffer_or_a_second_buffer_is_refused():
    refused('refers to an external file', train, changed(lambda gltf: gltf['buffers'][0].update(uri='car.bin')))
    refused('exactly one buffer', train, changed(lambda gltf: gltf['buffers'].append({'byteLength': 4, 'uri': 'x.bin'})))


def test_a_train_with_extensions_or_textures_is_refused():
    refused('glTF extensions', train, changed(lambda gltf: gltf.update(extensionsUsed=['KHR_draco_mesh_compression'])))
    refused('textures', train, changed(lambda gltf: gltf.update(textures=[{'source': 0}])))


def test_every_mesh_and_primitive_counts_towards_the_triangle_budget():
    def doubled(gltf):
        primitives = gltf['meshes'][0]['primitives']
        primitives.extend([dict(primitive) for primitive in primitives] * 2)
    refused('triangles; the limit is 12,000', train, changed(doubled))


def test_a_model_outside_the_car_frame_is_refused():
    def moved(gltf):
        gltf['nodes'][0]['translation'] = [0, 0, 10]
    refused('no transform', train, changed(moved))


def test_a_train_adapted_from_ldraw_keeps_cc_by_2_only_with_its_source_url_and_authors():
    source = {'url': 'https://library.ldraw.org/omr/sets/700-1', 'authors': ['Michael Heidemann', 'Guy Vivan']}
    assert train(licence='CC-BY-2.0', source=source)['triangles'] == 4528
    refused("source's web address", train, licence='CC-BY-2.0', source={**source, 'url': ''})
    refused("source's authors", train, licence='CC-BY-2.0', source={**source, 'authors': []})
    refused('A model of your own is shared under CC BY 4.0', train, licence='CC-BY-2.0')
    refused("keeps its source's CC BY licence", train, licence='CC-BY-NC-2.0', source=source)


def test_measured_car_fields_match_what_the_check_compares():
    car = LOCO['train']['car']
    measured = check.measure_train(LOCO_GLB, car['couplers'])
    assert {key: measured[key] for key in ('length', 'width', 'height', 'triangles')} == {
        key: car[key] for key in ('length', 'width', 'height', 'triangles')}
    assert 3 <= len(measured['outline']) <= 40
    assert train(car={**car, **measured})['triangles'] == car['triangles']


def test_the_furniture_form_writes_a_preset_the_check_accepts():
    data = json.dumps(FORM['type']).encode()
    assert check.check('furniture', data, {'id': FORM['family'], 'name': FORM['name'], 'design': FORM['design']}) == {
        'surfaces': 5, 'panels': 12}


def test_a_cubby_grid_larger_than_the_outline_is_refused():
    narrow = {**FORM['type'], 'width': 600}
    refused('The cubby grid is larger than the 600 mm × 400 mm outline', check.check, 'furniture',
            json.dumps(narrow).encode(), {'name': FORM['name']})


def test_a_preset_whose_family_is_not_its_id_is_refused():
    refused('family must be its library id', check.check, 'furniture', json.dumps(FORM['type']).encode(),
            {'id': 'community_other', 'name': FORM['name']})


def test_the_command_line_check_runs_standalone(tmp_path):
    """The library repository's workflow runs the file on its own, outside the app."""
    meta = tmp_path / 'metadata.json'
    meta.write_text(json.dumps({'name': CURVE['name'], 'ends': CURVE['piece']['ends']}))
    script = Path(check.__file__)
    passed = subprocess.run([sys.executable, str(script), 'piece', str(LIBRARY / CURVE['file']), str(meta)],
                            capture_output=True, text=True, cwd=tmp_path)
    assert passed.returncode == 0 and passed.stdout.startswith('Passed'), passed.stderr
    meta.write_text(json.dumps({'name': CURVE['name'], 'ends': CURVE['piece']['ends'][:1]}))
    failed = subprocess.run([sys.executable, str(script), 'piece', str(LIBRARY / CURVE['file']), str(meta)],
                            capture_output=True, text=True, cwd=tmp_path)
    assert failed.returncode == 1 and 'Mark both ends' in failed.stdout
