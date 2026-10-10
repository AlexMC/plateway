"""The printable assembly guide of real prepared packages (real CAD and Bambu slicing), read back as PDF text, the
short part codes it shares with the plates and the slicer, and one package combined from a layout's parts."""

import json
import math
import re
import uuid
import xml.etree.ElementTree as ET
import zipfile

from pypdf import PdfReader

from cad.service.hardware import manifest_pieces, shopping_list
from cad.service.combine import combine_parts
from cad.service.package import export_package, validate_manifest
from cad.tests.test_package import (community_instance, community_library, ordinary_manifest, sample_curve, straight_entry,
                                    straight_upload, turnout_manifest, with_community)

import pytest

ROOM = {'width': 1200, 'depth': 900, 'furniture': [{'label': 'KALLAX 5×5', 'height': 1820, 'outline': [
    {'x': 100, 'y': 600}, {'x': 1100, 'y': 600}, {'x': 1100, 'y': 890}, {'x': 100, 'y': 890}]}]}
UUID = re.compile(r'[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}')
CORE = '{http://schemas.microsoft.com/3dmanufacturing/core/2015/02}'


def _pages(path) -> list[str]:
    return [page.extract_text() for page in PdfReader(path).pages]


def _heading(text: str) -> str:
    return text.strip().splitlines()[0].strip()


def _flat(text: str) -> str:
    return re.sub(r'\s+', '', text)


def _contents(cover: str) -> dict[str, int]:
    """The cover's contents: section title → page number."""
    rows = cover.split('Contents', 1)[1]
    return {match.group(1).strip(): int(match.group(2)) for match in re.finditer(r'^(\D+?)\s+(\d+)\s*$', rows, re.M)}


def _named_turnout() -> tuple[dict, str]:
    """The turnout layout with a room, a UUID piece id as the app makes them, and the app's piece name."""
    request = turnout_manifest()
    request['room'] = ROOM
    piece = request['instances'][0]
    ident = str(uuid.uuid4())
    piece.update(id=ident, sectionId=ident)
    request['requiredPrintedInstanceIds'] = [ident]
    request['billOfMaterials'][0]['instanceIds'] = [ident]
    request['pieceNames'] = {ident: 'Points to the yard'}
    return request, ident


def test_layout_guide_pdf_has_overview_shopping_plates_and_a_page_per_mechanism(tmp_path):
    request, ident = _named_turnout()
    receipt, created = export_package(tmp_path, request)
    assert created and receipt['assemblyGuidePdf'] == 'assembly-guide.pdf'
    root = tmp_path / receipt['id']
    assert (root / 'assembly-guide.md').read_text().startswith('# Shopping list\n')
    codes = [part['code'] for part in receipt['parts']]
    assert codes == [f'1{letter}' for letter in 'ABCDEFGHI']
    assert all(part['name'].startswith('Points to the yard · ') for part in receipt['parts'])
    pages = _pages(root / receipt['assemblyGuidePdf'])
    headings = [_heading(text) for text in pages]
    cover = pages[0]
    assert headings[0] == 'ASSEMBLY GUIDE' and request['project']['name'] in cover
    assert 'A1 mini' in cover and re.search(rf'Plates\s+{len(receipt["plates"])}\b', cover)

    # Contents on the cover point at the pages each section starts on, and every page belongs to a section.
    contents = _contents(cover)
    assert list(contents) == ['Layout overview', 'Shopping list', 'Plates', 'Assembly', 'Reference notes',
                              'Physical trial and credits']
    assert headings[contents['Layout overview']-1] == 'Layout overview'
    assert headings[contents['Shopping list']-1] == 'Shopping list'
    assert headings[contents['Plates']-1] == 'Plate 1'
    assert headings[contents['Assembly']-1] == '1 · Points to the yard'
    assert headings[contents['Reference notes']-1] == 'Reference notes'
    assert contents['Physical trial and credits'] == len(pages) == headings.index('Physical trial and credits') + 1
    plate_pages = [index for index, heading in enumerate(headings) if re.fullmatch(r'Plate \d+', heading)]
    assert len(plate_pages) == len(receipt['plates'])
    assembly = [heading for heading in headings if heading.startswith('1 · Points to the yard')]
    assert assembly[0] == '1 · Points to the yard' and all(heading.endswith('(continued)') for heading in assembly[1:])
    assert 'Joining printed track' not in headings  # no plain printed track in this layout
    continued = sum(heading.endswith('(continued)') for heading in headings) - len(assembly) + 1
    assert len(pages) == 1 + 1 + 1 + len(receipt['plates']) + len(assembly) + 1 + continued + 1

    overview = pages[contents['Layout overview']-1]
    assert 'KALLAX 5×5' in overview and 'Room 1200 × 900 mm' in overview and 'Your track' in overview
    assert re.search(r'^1\s+Points to the yard\s+1A–1I\s', overview, re.M)  # the piece and its parts' codes

    shopping = pages[contents['Shopping list']-1]
    listed = shopping_list(manifest_pieces(request['instances'], {ident: '1 · Points to the yard'}))
    assert listed['lines'] and all(line['name'] in shopping and '1 · Points to the yard' in line['pieces']
                                   for line in listed['lines'])

    parts = {part['instanceId']: part for part in receipt['parts']}
    for index, plate in zip(plate_pages, receipt['plates']):
        text = _flat(pages[index] + (pages[index+1] if headings[index+1].endswith('(continued)') else ''))
        for item in plate['objects']:
            part = parts[item['instanceId']]
            assert _flat(f'{part["code"]} {part["name"]}') in text and _flat(item['label']) in text
        # The slicer lists the same codes: the plain 3MF, the Bambu project and the sliced plate.
        with zipfile.ZipFile(root / plate['model']) as archive:
            model = ET.fromstring(archive.read('3D/3dmodel.model'))
        names = {node.get('id'): node.get('name') for node in model.iter(f'{CORE}object')}
        expected = sorted(parts[item['instanceId']]['code'] for item in plate['objects'])
        assert sorted(names[item.get('objectid')] for item in model.find(f'{CORE}build')) == expected
        with zipfile.ZipFile(root / plate['project']) as archive:
            settings = ET.fromstring(archive.read('Metadata/model_settings.config'))
        assert sorted(node.get('value') for node in settings.findall('./object/metadata[@key="name"]')) == expected
        assert sorted(obj['name'] for obj in plate['slice']['objects']) == expected

    steps = ''.join(pages[contents['Assembly']-1:contents['Reference notes']-1])
    turnout = receipt['assemblies'][0]
    assert all(f'{row["quantity"]} × {row["name"]}' in steps for row in turnout['hardware'])
    assert all(_flat(f'{number}.{note[:40]}') in _flat(steps) for number, note in enumerate(turnout['instructions'], 1))
    assert all(_flat(f'{part["code"]} {part["name"].split(" · ")[1]}') in _flat(steps) for part in receipt['parts'])

    # People read codes and names; no layout UUID shows anywhere in the guide.
    assert ident not in ''.join(pages).replace('\n', '')
    assert not any(UUID.search(_flat(text)) for text in pages)
    closing = pages[-1]
    assert 'calibration sample' in closing and _flat('straight rerailer by lev (Printables #466240') in _flat(closing)
    # No toy-company trademark anywhere in the shipped guide.
    assert not re.search('lego', ''.join(pages), re.I)


def test_plain_track_gets_one_joining_page_and_no_mechanism_pages(tmp_path):
    request = ordinary_manifest()  # earlier manifests without a room or piece names still prepare
    receipt, _ = export_package(tmp_path, request)
    assert [(part['code'], part['name']) for part in receipt['parts']] == [('1', 'Straight')]
    pages = _pages(tmp_path / receipt['id'] / receipt['assemblyGuidePdf'])
    headings = [_heading(text) for text in pages]
    assert headings.count('Joining printed track') == 1
    assert not any(' · ' in heading for heading in headings)
    joining = pages[headings.index('Joining printed track')]
    assert 'Steps' in joining and '1.' in joining
    assert headings[:4] == ['ASSEMBLY GUIDE', 'Layout overview', 'Shopping list', 'Plate 1']
    assert re.search(r'^1\s+Straight\s+1\s+1\s', pages[1], re.M)


@pytest.mark.parametrize('field, value', [
    ('room', {'width': 0, 'depth': 900, 'furniture': []}),
    ('room', {'width': 1200, 'depth': 900, 'furniture': [{'label': 'shelf', 'height': 10, 'outline': [{'x': 0, 'y': 0}]}]}),
    ('room', {'width': 1200, 'depth': 900, 'furniture': [{'label': 'a | b', 'height': 10,
                                                          'outline': [{'x': 0, 'y': 0}, {'x': 1, 'y': 0}, {'x': 1, 'y': 1}]}]}),
    ('room', {'width': 1200, 'depth': 900}),
    ('pieceNames', {'upper:0:printed_straight:0': 'Straight | forged'}),
    ('pieceNames', {'upper:0:printed_straight:0': 'x' * 121}),
    ('pieceNames', ['Straight']),
])
def test_manifest_room_and_piece_names_are_validated(field, value):
    request = ordinary_manifest()
    request[field] = value
    with pytest.raises(ValueError):
        validate_manifest(request)


def _three_pieces() -> dict:
    """A line of three plain printed straights, each its own layout piece; two share one CAD build."""
    request = ordinary_manifest()
    template = request['instances'][0]
    instances, tiles, x = [], [], 0.
    for index, run in enumerate((80., 80., 96.)):
        ident = f'upper:{index}:printed_straight:0'
        instance = json.loads(json.dumps(template))
        instance.update(id=ident, sectionId=f'piece-{index}', parameters={**template['parameters'], 'run': run},
                        pose={**template['pose'], 'x': x})
        instance['startPort']['pose']['x'], instance['endPort']['pose']['x'] = x, x + run
        instances.append(instance)
        tiles.append({'id': f'piece-{index}'})
        x += run
    ids = [instance['id'] for instance in instances]
    request['routes'][0]['pieces'] = tiles
    request.update(instances=instances, requiredPrintedInstanceIds=ids,
                   billOfMaterials=[{'source': 'printed', 'family': 'printed_straight', 'count': 3, 'instanceIds': ids}])
    return request


def test_a_layout_prepared_in_three_parts_combines_into_one_package_with_plates_numbered_on(tmp_path):
    request = _three_pieces()
    ids = request['requiredPrintedInstanceIds']
    parts = [export_package(tmp_path, request, part={'index': index, 'count': 3, 'instanceIds': [ident]})[0]
             for index, ident in enumerate(ids, 1)]
    assert [[plate['plate'] for plate in part['plates']] for part in parts] == [[1], [1], [1]]
    # Parts 1 and 2 share a CAD build, so its files have the same names; one may differ (a STEP records its time).
    shared = parts[1]['parts'][0]['source']
    assert shared == parts[0]['parts'][0]['source']
    (tmp_path / parts[1]['id'] / shared).write_bytes((tmp_path / parts[1]['id'] / shared).read_bytes() + b'\n# rebuilt\n')
    originals = [(tmp_path / part['id'] / shared).read_bytes() for part in parts[:2]]
    steps = []
    combined = combine_parts(tmp_path, request, [part['id'] for part in parts],
                             lambda *step: steps.append(step), taken=lambda base: {base})
    root = tmp_path / combined['id']
    assert combined['id'].startswith(f'{validate_manifest(request)[0]}-')  # the layout's id is in use: a variant
    assert steps == [('combine', 0, 3), ('combine', 1, 3), ('combine', 2, 3)]
    # The part packages stay until the combined package is published (`prepare_job`).
    assert sorted(path.name for path in tmp_path.iterdir()) == sorted([combined['id'], *(part['id'] for part in parts)])
    assert json.loads((root / 'receipt.json').read_text()) == combined

    # Plates run 1 to 3, each in its own renamed folder, its plain 3MF titled by its new number.
    assert [plate['plate'] for plate in combined['plates']] == [1, 2, 3]
    for plate in combined['plates']:
        folder = f'plate-{plate["plate"]:02d}'
        assert all(plate[key].startswith(f'{folder}/') for key in ('model', 'project', 'gcode', 'thumbnail'))
        assert all((root / plate[key]).is_file() for key in ('model', 'project', 'gcode', 'thumbnail'))
        with zipfile.ZipFile(root / plate['model']) as model:
            assert f'<metadata name="Title">Plate {plate["plate"]}</metadata>' in model.read('3D/3dmodel.model').decode()
    assert {part['instanceId']: part['plate'] for part in combined['parts']} == dict(zip(ids, (1, 2, 3)))
    assert all((root / part['printMesh']).is_file() and (root / part['mesh']).is_file() for part in combined['parts'])
    assert combined['parts'][0]['mesh'] == combined['parts'][1]['mesh']  # identical files are kept once
    assert [(root / part['source']).read_bytes() for part in combined['parts'][:2]] == originals
    assert [part['plates'] for part in combined['layoutParts']] == [[1], [2], [3]]

    # One guide for the whole layout, listing every part.
    pages = _pages(root / combined['assemblyGuidePdf'])
    headings = [_heading(text) for text in pages]
    assert [heading for heading in headings if re.fullmatch(r'Plate \d+', heading)] == ['Plate 1', 'Plate 2', 'Plate 3']
    listing = _flat(pages[headings.index('Prepared in parts')])
    assert all(_flat(f'{index} of 3') in listing for index in (1, 2, 3))
    assert 'Shopping list' in headings and headings.count('Shopping list') == 1
    assert (root / 'assembly-guide.md').read_text().startswith('# Prepared in parts\n')


class Opened:
    """A library bucket that records the keys a prepare reads."""

    def __init__(self, bucket):
        self.bucket, self.keys = bucket, []

    def open(self, key):
        self.keys.append(key)
        return self.bucket.open(key)


def test_community_pieces_in_two_parts_get_one_credits_page_listing_both_with_their_makers_and_licences(tmp_path):
    data, ends = straight_upload()
    straight = straight_entry(data, ends)
    curve, curve_data = sample_curve()
    library = community_library(tmp_path, (straight, data), (curve, curve_data))
    request = ordinary_manifest()
    request.update(instances=[], requiredPrintedInstanceIds=[], billOfMaterials=[])
    request['routes'][0]['pieces'] = [{'id': 'upper:0:community:0'}, {'id': 'upper:1:community:0'}]
    request['pieceNames'] = {'upper:0:community:0': 'Shelf straight', 'upper:1:community:0': 'Sample 90° curve'}
    first = community_instance('upper:0:community:0', 'upper', straight, 0, 0, 0)
    # The curve laid from its second marked end: it turns right, not left.
    end = first['endPort']['pose']
    second = community_instance('upper:1:community:0', 'upper', curve, end['x'], end['y'], end['heading'], reversed=True)
    assert second['endPort']['pose']['heading'] == pytest.approx(-math.pi / 2)
    with_community(request, (first, straight), (second, curve))
    parts, reads = [], []
    for index, ident in enumerate(request['requiredPrintedInstanceIds'], 1):
        opened = Opened(library)
        parts.append(export_package(tmp_path / 'exports', request, part={'index': index, 'count': 2, 'instanceIds': [ident]},
                                    library=opened)[0])
        reads.append(opened.keys)
    # Each part reads only its own community mesh.
    assert reads == [['index.json', straight['file']], ['index.json', curve['file']]]
    assert [port['position'][:2] for port in parts[1]['parts'][0]['ports']] == [
        [end['x'], end['y']] for end in curve['piece']['ends'][::-1]]
    combined = combine_parts(tmp_path / 'exports', request, [part['id'] for part in parts], lambda *_: None)
    root = tmp_path / 'exports' / combined['id']
    assert [part['library']['id'] for part in combined['parts']] == [straight['id'], curve['id']]
    assert combined['notes'] == parts[0]['notes'] == parts[1]['notes']
    pages = _pages(root / combined['assemblyGuidePdf'])
    headings = [_heading(text) for text in pages]
    assert headings.count('Physical trial and credits') == 1
    credits = _flat(pages[headings.index('Physical trial and credits')])
    assert _flat('Community pieces') in credits and _flat('printed exactly as uploaded') in credits
    assert _flat(f'Shelf straight (piece 1): by Ada Lovelace, licensed CC-BY-4.0. Library item {straight["id"]}, version 1.') in credits
    assert _flat(f'Sample 90° curve (piece 2): by Plateway sample, licensed CC-BY-4.0. Library item {curve["id"]}, version 1.') in credits
    guide = (root / 'assembly-guide.md').read_text()
    assert '| 1 | Shelf straight | Ada Lovelace | CC-BY-4.0 |' in guide and '| 2 | Sample 90° curve | Plateway sample | CC-BY-4.0 |' in guide
