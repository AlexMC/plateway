"""Go up or down: one climb piece prints as the composite_track parts fit cuts it into (fixtures/climb-parts.json,
written by scripts/climb-fixture.ts: +38, +64 and -64 mm at 4 % for the X1 Carbon and the A1 mini). Every part is a
valid composite, the joints between parts are continuous in height and grade, and each printer slices all of them,
detailed and fast, without warnings. Digital geometry only."""

from concurrent.futures import ProcessPoolExecutor
import json
import math
import os
from pathlib import Path

import pytest

from cad.models import composite
from cad.service.generate import generate_part
from cad.service.plates import export_plates

CASES = json.loads((Path(__file__).parent / 'fixtures/climb-parts.json').read_text())
PRINTERS = {
    'X1 Carbon': {'name': 'X1 Carbon', 'material': 'Bambu PLA Basic', 'profile': '0.20mm Standard @BBL X1C',
                  'nozzleMm': .4, 'orientation': 'flat', 'envelope': {'x': 256, 'y': 256, 'z': 250}},
    'A1 mini': {'name': 'A1 mini', 'material': 'Bambu PLA Basic', 'profile': '0.20mm Standard @BBL A1M',
                'nozzleMm': .4, 'orientation': 'flat', 'envelope': {'x': 180, 'y': 180, 'z': 180}},
}
STYLES = {'detailed': {}, 'fast': {'lite': 1}}


def _case_id(case):
    return f"{case['rise']:+d}-{case['printer'].replace(' ', '')}"


def _grade(port):
    tangent = port['tangent']
    return tangent[2] / math.hypot(tangent[0], tangent[1])


@pytest.mark.parametrize('case', CASES, ids=_case_id)
def test_climb_parts_join_continuously_in_height_and_grade(case):
    parts = [(part, {port['id']: port for port in composite.ports(part['parameters'])}) for part in case['parts']]
    assert len(parts) > 2
    for part, ports in parts:
        composite.validate(part['parameters'])
        # The CAD's own ends agree with fit's: the height change and the grade at both ends.
        assert ports['end']['position'][2] - ports['start']['position'][2] == pytest.approx(part['end']['z'] - part['start']['z'], abs=1e-6)
        assert _grade(ports['start']) == pytest.approx(math.tan(part['start']['pitch']), abs=1e-9)
        assert _grade(ports['end']) == pytest.approx(math.tan(part['end']['pitch']), abs=1e-9)
    # Level where it starts and ends, the whole height apart.
    assert parts[0][0]['start']['z'] == pytest.approx(case['start'], abs=1e-6)
    assert parts[-1][0]['end']['z'] == pytest.approx(case['start'] + case['rise'], abs=1e-6)
    assert _grade(parts[0][1]['start']) == 0 and _grade(parts[-1][1]['end']) == pytest.approx(0, abs=1e-12)
    for (a, a_ports), (b, b_ports) in zip(parts, parts[1:]):
        # Where one part ends the next begins: the same height and the same grade.
        assert a['end']['z'] == pytest.approx(b['start']['z'], abs=1e-6)
        assert _grade(a_ports['end']) == pytest.approx(_grade(b_ports['start']), abs=1e-9)
    # The easements end at cuts, as long at both ends, and the parts between them hold one grade.
    grades = [(part['parameters']['grade0'], part['parameters']['grade1']) for part, _ in parts]
    lengths = [part['parameters']['s0_len'] for part, _ in parts]
    steepest = max(abs(end) for _, end in grades)
    up = next(n for n, (_, end) in enumerate(grades) if abs(end) > steepest - 1e-9)
    down = max(n for n, (start, _) in enumerate(grades) if abs(start) > steepest - 1e-9)
    assert sum(lengths[:up + 1]) == pytest.approx(sum(lengths[down:]), abs=1e-6)
    for start, end in grades[up + 1:down]:
        assert start == pytest.approx(end, abs=1e-12) and abs(start) == pytest.approx(steepest, abs=1e-12)


@pytest.mark.parametrize('printer', PRINTERS)
def test_climbs_slice_without_warnings_detailed_and_fast(tmp_path, printer):
    requests, outputs, parts = [], [], []
    for case in CASES:
        if case['printer'] != printer:
            continue
        for style, option in STYLES.items():
            for part in case['parts']:
                parameters = {**part['parameters'], **option}
                request = {'version': 1, 'units': 'mm', 'family': 'composite_track', 'parameters': parameters,
                           'printer_envelope': PRINTERS[printer]['envelope'],
                           'part_revision': 'synthetic-climb', 'layout_revision': 'synthetic-climb'}
                instance = f"{_case_id(case)}-{style}-{part['id']}"
                requests.append(request)
                outputs.append(tmp_path / 'parts' / instance)
                parts.append({'instanceId': instance, 'code': str(len(parts) + 1), 'name': instance, 'family': 'composite_track',
                              'parameters': parameters})
    # Graded wedges take tens of seconds each: build them side by side.
    with ProcessPoolExecutor(max_workers=max(1, (os.cpu_count() or 2) - 1)) as pool:
        for part, result in zip(parts, pool.map(generate_part, requests, outputs)):
            part.update(meshPath=result['mesh'], bounds=result['bounds'], ports=result['ports'])
    plates = export_plates(parts, PRINTERS[printer], tmp_path)
    assert sum(len(plate['objects']) for plate in plates) == len(parts)
    for plate in plates:
        assert plate['slice']['warning_message'] == ''
