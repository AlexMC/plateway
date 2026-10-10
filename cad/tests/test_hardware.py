"""Every piece's bought parts are categorised, countable and named one way; the layout list adds them up."""

import json
from pathlib import Path
import re

import pytest

from cad.models import hardware as hw
from cad.service.hardware import (BT_WARNING, guide_section, manifest_pieces, piece_rows, servo_supply,
                                  shopping_list, validate_request)

FIXTURE = json.loads((Path(__file__).parent / 'fixtures/hardware-pieces.json').read_text())
BRACKETS = [('track_bracket', {'mount': 1, 'reach': reach, 'height': 0}) for reach in (48, 72, 150)] + [
    ('track_bracket', {'mount': 2, 'reach': 72, 'height': 16}),
    ('anchored_bracket', {'height': 80, 'reach': 40, 'plate_width': 24, 'plate_thickness': 5, 'arm_width': 8,
                          'arm_thickness': 8, 'hole_diameter': 5, 'hole_spacing': 35, 'seat_width': 24,
                          'seat_depth': 20, 'seat_thickness': 5}),
    ('cog_bogie', {'part': 0}), ('cog_bogie', {'part': 1})]
CASES = [(f'{item["piece"]}:{item["variant"]}', item['family'], item['parameters']) for item in FIXTURE] + [
    (f'{family}:{index}', family, parameters) for index, (family, parameters) in enumerate(BRACKETS)]
NOUNS = ('screw', 'magnet', 'pin', 'axle', 'bearing', 'nut', 'rod', 'washer', 'bolt', 'servo', 'motor', 'gear', 'bush',
         'plate', 'wheel', 'glue', 'tape', 'line', 'plank', 'graphite', 'foil', 'rail', 'strip', 'joint', 'turntable')


def test_fixture_covers_every_registered_family_and_hardware_option():
    from cad.service.assemblies import FAMILIES
    assert set(FAMILIES) - {item['family'] for item in FIXTURE} <= {
        'monorail_ramp', 'bridge_lift', 'train_elevator'} - {item['family'] for item in FIXTURE}
    variants = {item['variant'].split('=')[0] for item in FIXTURE}
    assert {'servo', 'drive', 'motor', 'metal', 'led', 'bracket'} <= variants
    assert {item['piece'] for item in FIXTURE if item['variant'] == 'drive=2'} == {'turntable', 'bridge_bascule', 'rotary_dumper'}


@pytest.fixture(scope='module')
def rows():
    return {case: piece_rows(family, parameters) for case, family, parameters in CASES}


def test_every_row_has_a_category_and_a_positive_whole_quantity(rows):
    for case, items in rows.items():
        for item in items:
            assert set(item) == {'name', 'quantity', 'category'}, case
            assert item['category'] in hw.CATEGORIES, case
            assert type(item['quantity']) is int and item['quantity'] > 0, (case, item)
            assert isinstance(item['name'], str) and item['name'].strip() == item['name'] != '', case


def test_one_spelling_per_item(rows):
    """Two names for one part would split it on the shopping list: same part number, or the same kind of part with
    the same numbers in the same category, must be the same name."""
    names = {item['name']: item['category'] for items in rows.values() for item in items}
    by_part, by_signature = {}, {}
    for name, category in names.items():
        if category == hw.BRICK:
            for number in re.findall(r'\b\d{4,5}[a-z]?\d*\b', name):
                by_part.setdefault(number, set()).add(name)
        nouns = frozenset(noun for noun in NOUNS if noun in name.lower())
        signature = (category, tuple(re.findall(r'\d+(?:\.\d+)?', name)), nouns)
        by_signature.setdefault(signature, set()).add(name)
    assert {number: spellings for number, spellings in by_part.items() if len(spellings) > 1} == {}
    assert {key: spellings for key, spellings in by_signature.items() if len(spellings) > 1} == {}


def test_options_add_their_drive(rows):
    for case, items in rows.items():
        names = {item['name']: item['quantity'] for item in items}
        piece, variant = case.split(':')
        if variant == 'servo=1':
            assert names.get(hw.SERVO, 0) >= 1, case
        if variant == 'drive=1' and piece in ('turntable', 'bridge_bascule', 'rotary_dumper'):
            assert names.get(hw.BT_L_MOTOR) == 1, case
        if variant == 'drive=2':
            assert names.get(hw.IR_L_MOTOR) == 1 and not set(names) & hw.BLUETOOTH_MOTORS, case
        if piece == 'funicular':
            assert sum(names.get(motor, 0) for motor in hw.BLUETOOTH_MOTORS) == 1, case
            assert not any('hub' in name for name in names), case
        if variant.startswith(('metal=', 'led=')):
            assert items, case


def piece(ident, label, family, parameters, part=None):
    return {'id': part or ident, 'piece': ident, 'label': label, 'family': family, 'parameters': parameters}


def fixture(piece_family, variant='default'):
    return next(item['parameters'] for item in FIXTURE if item['piece'] == piece_family and item['variant'] == variant)


def test_layout_list_adds_parts_up_and_adds_the_control_gear_once():
    servo = fixture('turnout_radius', 'servo=1')
    pieces = [piece('t1', 'Turnout', 'turnout_radius', servo), piece('t2', 'Turnout', 'turnout_radius', servo),
              piece('tt', 'Turntable', 'turntable', fixture('turntable', 'drive=1')),
              piece('bb', 'Bascule bridge', 'bridge_bascule', fixture('bridge_bascule', 'drive=1')),
              *(piece(f's{n}', 'Anchored bracket', 'anchored_bracket', BRACKETS[4][1]) for n in range(3)),
              piece('c1', 'Curve', 'composite_track', fixture('track_curve'), 'c1:1'),
              piece('c1', 'Curve', 'composite_track', fixture('track_curve'), 'c1:2')]
    result = shopping_list(pieces)
    lines = {line['name']: line for line in result['lines']}
    switch = piece_rows('turnout_radius', servo)
    per_turnout = next(item['quantity'] for item in switch if item['name'] == hw.SERVO)
    assert lines[hw.SERVO]['quantity'] == 2*per_turnout and lines[hw.SERVO]['pieces'] == ['Turnout ×2']
    assert lines[hw.BT_L_MOTOR]['quantity'] == 2
    assert lines[hw.BT_L_MOTOR]['pieces'] == ['Turntable', 'Bascule bridge']
    assert lines['Wood screw 4.5 x 30 mm (pan head)'] == {
        'category': hw.FASTENERS, 'name': 'Wood screw 4.5 x 30 mm (pan head)', 'quantity': 6, 'pieces': ['Anchored bracket ×3']}
    assert lines[hw.GLUE]['quantity'] == 1  # a consumable counts once
    order = [hw.CATEGORIES.index(line['category']) for line in result['lines']]
    assert order == sorted(order)
    control = {item['name']: item['quantity'] for item in result['control']}
    servos = 2*per_turnout
    assert control['PCA9685 16-channel servo driver board'] == 1
    assert control['Servo extension lead (3-pin, length to suit)'] == servos
    assert control[servo_supply(servos)[0]] == 1
    assert control['Bluetooth 4-port hub (88012)'] == 1
    assert result['warnings'] == [BT_WARNING]
    assert any('anchors suited to your wall' in note for note in result['notes'])
    assert any('trimmed in software' in note for note in result['notes'])


@pytest.mark.parametrize('servos,supply,count', [
    (1, '5 V regulated power supply, at least 2 A', 1), (4, '5 V regulated power supply, at least 2 A', 1),
    (5, '5 V regulated power supply, at least 2.5 A', 1), (16, '5 V regulated power supply, at least 8 A', 1),
    (17, '5 V 10 A regulated power supply', 1), (21, '5 V 10 A regulated power supply', 2)])
def test_servo_supply_grows_half_an_amp_per_servo_beyond_four(servos, supply, count):
    assert servo_supply(servos) == (supply, count)


def test_drivers_and_hubs_by_channel_count():
    servo = fixture('turnout_radius', 'servo=1')
    per_turnout = next(item['quantity'] for item in piece_rows('turnout_radius', servo) if item['name'] == hw.SERVO)
    turnouts = 17//per_turnout + 1
    control = {item['name']: item['quantity'] for item in shopping_list(
        [piece(f't{n}', 'Turnout', 'turnout_radius', servo) for n in range(turnouts)])['control']}
    assert control['PCA9685 16-channel servo driver board'] == -(-turnouts*per_turnout//16)
    tables = [piece(f'tt{n}', 'Turntable', 'turntable', fixture('turntable', 'drive=1')) for n in range(5)]
    control = {item['name']: item['quantity'] for item in shopping_list(tables)['control']}
    assert control == {'Bluetooth 4-port hub (88012)': 2}


def test_infrared_motors_need_receivers_not_a_hub():
    pieces = [piece(name, name, name, fixture(name, 'drive=2')) for name in ('turntable', 'bridge_bascule', 'rotary_dumper')]
    result = shopping_list(pieces)
    control = {item['name']: item['quantity'] for item in result['control']}
    assert control == {'IR receiver (8884)': 2,
                       'Infrared battery box (88000) or rechargeable battery (8878)': 2}
    assert result['warnings'] == [] and any('60052' in note for note in result['notes'])
    mixed = shopping_list(pieces + [piece('tt', 'Turntable', 'turntable', fixture('turntable', 'drive=1'))])
    assert mixed['warnings'] == [BT_WARNING]
    assert {item['name'] for item in mixed['control']} >= {'Bluetooth 4-port hub (88012)', 'IR receiver (8884)'}


def test_hand_options_need_no_control_gear_and_bad_pieces_are_reported_not_fatal():
    result = shopping_list([piece('tt', 'Turntable', 'turntable', fixture('turntable')),
                            piece('x', 'Mystery', 'no_such_family', {}),
                            piece('bad', 'Broken turnout', 'turnout_radius', {'radius': 1})])
    assert result['control'] == [] and result['lines']
    assert result['warnings'] == ["Couldn't list the hardware for Broken turnout: check its settings."]
    assert shopping_list([]) == {'lines': [], 'control': [], 'notes': [], 'warnings': []}


@pytest.mark.parametrize('body', [
    {}, {'pieces': [], 'mounting': 'anchored'}, {'pieces': {}},
    {'pieces': [{'id': 'a', 'piece': 'a', 'label': 'A', 'family': 'turntable'}]},
    {'pieces': [{'id': 'a', 'piece': 'a', 'label': '', 'family': 'turntable', 'parameters': {}}]},
    {'pieces': [{'id': 'a', 'piece': 'a', 'label': 'A', 'family': 'turntable', 'parameters': {'drive': True}}]},
    {'pieces': [{'id': 'a', 'piece': 'a', 'label': 'A', 'family': 'turntable', 'parameters': {'drive': float('inf')}}]}])
def test_request_shape_is_checked(body):
    with pytest.raises(ValueError):
        validate_request(body)


def test_guide_lists_the_same_shopping_list():
    instances = [{'id': 'points', 'sectionId': 'points', 'family': 'turnout_radius', 'source': 'printed',
                  'interfaceKind': 'track-assembly', 'parameters': fixture('turnout_radius', 'servo=1')},
                 {'id': 'own', 'sectionId': 'own', 'family': 'brick_switch_left', 'source': 'owned',
                  'interfaceKind': 'track-assembly', 'parameters': {}},
                 *({'id': f'wall:{n}', 'sectionId': 'run', 'family': 'track_bracket', 'source': 'printed',
                    'interfaceKind': 'accessory', 'parameters': {'mount': 1, 'reach': 72, 'height': 0}} for n in range(2))]
    result = shopping_list(manifest_pieces(instances, {'points': '1 · Turnout', 'wall:0': 'S1 · Wall bracket',
                                                       'wall:1': 'S2 · Wall bracket'}))
    guide = guide_section(result)
    assert guide.startswith('# Shopping list')
    assert f'| Electronics | {next(line["quantity"] for line in result["lines"] if line["name"] == hw.SERVO)} | {hw.SERVO} | 1 · Turnout |' in guide
    assert '| Fasteners | 4 | Wood screw 4 x 30 mm (pan head) | wall bracket ×2 |' in guide
    assert '| Control gear | 1 | PCA9685 16-channel servo driver board | shared, up to 16 servos per board; ' in guide
    assert '| Control gear | 1 | Servo extension lead (3-pin, length to suit) | per servo; ' in guide
    assert 'This layout needs no extra hardware.' in guide_section(shopping_list([]))
