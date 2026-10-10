"""The layout's shopping list: every bought part its printed pieces need, added up, plus the control gear.

One function serves the app (POST /api/hardware) and the exported assembly guide. Pieces arrive as printed part
instances ``{id, piece, label, family, parameters}``; each family's own module says what it needs.
"""
from __future__ import annotations

from functools import lru_cache
import math

from cad.models import composite, flex_track, rack, support, track_bracket, track_power
from cad.models import hardware as hw
from cad.service.assemblies import FAMILIES as ASSEMBLY_FAMILIES, module_for

CATEGORY_LABELS = {hw.FASTENERS: 'Fasteners', hw.MAGNETS: 'Magnets', hw.BEARINGS: 'Bearings & weights',
                   hw.BRICK: 'Brick parts', hw.ELECTRONICS: 'Electronics', hw.MATERIALS: 'Materials'}
MAX_PIECES = 5000
_TEXT_LIMIT = 160

SERVOS_PER_DRIVER = 16
MOTORS_PER_HUB = 4
IR_MOTORS_PER_RECEIVER = 2
BT_WARNING = ("Infrared sets such as the 60052 Cargo Train can't drive Bluetooth motors; "
              "these need a Bluetooth hub.")
ANCHOR_NOTE = ("Use wall plugs or anchors suited to your wall or shelf (masonry, plasterboard or timber); "
               "the wall screws listed take a 6 mm plug.")
MOUNTING_FAMILIES = frozenset({'anchored_bracket', track_bracket.FAMILY})


def piece_rows(family: str, parameters: dict) -> list[dict]:
    """Bought parts one printed instance needs; raises ValueError (or KeyError/TypeError) for parameters its module
    rejects. Families without bought parts give []."""
    return [dict(item) for item in _rows(family, tuple(sorted(parameters.items())))]


@lru_cache(maxsize=512)
def _rows(family: str, key: tuple) -> tuple[dict, ...]:
    """Cached: a mechanism's rows may come from building its geometry."""
    parameters = dict(key)
    if family in ASSEMBLY_FAMILIES:
        return tuple(module_for(family).hardware(family, parameters))
    if family == composite.FAMILY:
        return tuple(track_power.hardware(parameters))
    if family == rack.FAMILY:
        # A bogie prints as a frame and a cog; its parts are listed once, with the frame.
        return tuple(rack.HARDWARE) if int(parameters['part']) == 0 else ()
    if family == track_bracket.FAMILY:
        return tuple(track_bracket.hardware(parameters))
    if family == 'anchored_bracket':
        return tuple(support.anchored_hardware(parameters))
    if family == flex_track.FAMILY:
        return tuple(flex_track.hardware(parameters))
    return ()


def servo_supply(servos: int) -> tuple[str, int]:
    """5 V supply for the servos: 2 A, plus 0.5 A per servo beyond 4; a 10 A supply above 16 servos."""
    amps = 2. + .5*max(0, servos - 4)
    if servos <= SERVOS_PER_DRIVER:
        return f'5 V regulated power supply, at least {amps:g} A', 1
    return '5 V 10 A regulated power supply', math.ceil(amps/10.)


def control_items(servos: int, bt_motors: int, ir_motors: int) -> tuple[list[dict], list[str], list[str]]:
    """Layout-level control gear, wiring notes and warnings, computed once per layout. Each row says how it is
    shared (``scope``: per servo, up to 16 servos per board, once per layout…) and may add a ``note``."""
    rows, notes, warnings = [], [], []
    if servos:
        supply, supplies = servo_supply(servos)
        rows += [
            {**hw.row('PCA9685 16-channel servo driver board', math.ceil(servos/SERVOS_PER_DRIVER), hw.ELECTRONICS),
             'scope': 'shared, up to 16 servos per board',
             'note': 'chain boards on the same I²C bus with different addresses'},
            {**hw.row('ESP32 development board', 1, hw.ELECTRONICS),
             'scope': 'once per layout', 'note': 'or any microcontroller with I²C; runs the servo driver'},
            {**hw.row(supply, supplies, hw.ELECTRONICS), 'scope': 'once per layout',
             'note': f'for {servos} servo{"s" if servos != 1 else ""}: 2 A, plus 0.5 A per servo beyond 4'
                     + ('; a 10 A supply above 16 servos' if servos > SERVOS_PER_DRIVER else '')},
            {**hw.row('Servo extension lead (3-pin, length to suit)', servos, hw.ELECTRONICS),
             'scope': 'per servo', 'note': 'from the servo to the driver board'}]
        notes += ['Servo wiring: plug each servo into its own PCA9685 channel; feed the board\'s V+ terminal from the '
                  '5 V supply (never from the ESP32), join all grounds, and wire the ESP32\'s SDA/SCL (GPIO 21/22) '
                  'and 3.3 V to the board\'s SDA/SCL/VCC.',
                  'Each servo\'s two endpoints are trimmed in software (a pulse width per channel and position), '
                  'never by bending the horn or the throw rod.']
    if bt_motors:
        rows.append({**hw.row('Bluetooth 4-port hub (88012)', math.ceil(bt_motors/MOTORS_PER_HUB), hw.BRICK),
                     'scope': 'shared, up to 4 motors per hub',
                     'note': 'the Bluetooth train hub 88009 has only two ports'})
        warnings.append(BT_WARNING)
    if ir_motors:
        receivers = math.ceil(ir_motors/IR_MOTORS_PER_RECEIVER)
        rows += [{**hw.row('IR receiver (8884)', receivers, hw.BRICK),
                  'scope': 'shared, up to 2 motors per receiver', 'note': 'set a free channel (1-4)'},
                 {**hw.row('Infrared battery box (88000) or rechargeable battery (8878)', receivers, hw.BRICK),
                  'scope': 'one per receiver', 'note': ''}]
        notes.append('Your 60052 Cargo Train\'s IR receiver and battery box ride on the train: give the mechanisms '
                     'their own, on another channel; the train\'s 8879 remote can drive that channel too.')
    return rows, notes, warnings


def _text(value: object, label: str) -> str:
    if not isinstance(value, str) or not value.strip() or len(value) > _TEXT_LIMIT:
        raise ValueError(f'{label} must be non-empty text')
    return value


def validate_request(body: object) -> list[dict]:
    """The request's printed part instances, checked."""
    if not isinstance(body, dict) or set(body) != {'pieces'}:
        raise ValueError('Hardware request requires exactly pieces')
    pieces = body['pieces']
    if not isinstance(pieces, list) or len(pieces) > MAX_PIECES:
        raise ValueError('pieces must be a list')
    for piece in pieces:
        if not isinstance(piece, dict) or set(piece) != {'id', 'piece', 'label', 'family', 'parameters'}:
            raise ValueError('Each piece requires exactly id, piece, label, family and parameters')
        for key in ('id', 'piece', 'label', 'family'):
            _text(piece[key], key)
        parameters = piece['parameters']
        if not isinstance(parameters, dict) or not all(
                isinstance(key, str) and type(value) in (int, float) and math.isfinite(value)
                for key, value in parameters.items()):
            raise ValueError('Piece parameters must be finite numbers')
    return pieces


def shopping_list(pieces: list[dict]) -> dict:
    """``{lines, control, notes, warnings}``: every piece's bought parts added up by name and sorted by category,
    each line with the labels of the pieces needing it (``label ×n`` for n pieces), plus the layout's control gear."""
    lines: dict[str, dict] = {}
    users: dict[str, dict[str, set]] = {}
    warnings: list[str] = []
    for piece in pieces:
        try:
            rows = piece_rows(piece['family'], piece['parameters'])
        except (ValueError, KeyError, TypeError, IndexError):
            warnings.append(f'Couldn\'t list the hardware for {piece["label"]}: check its settings.')
            continue
        for item in rows:
            line = lines.get(item['name'])
            if line is None:
                lines[item['name']] = dict(item)
                users[item['name']] = {}
            elif item['name'] in hw.CONSUMABLES:
                line['quantity'] = max(line['quantity'], item['quantity'])
            else:
                line['quantity'] += item['quantity']
            users[item['name']].setdefault(piece['label'], set()).add(piece['piece'])
    order = {category: index for index, category in enumerate(hw.CATEGORIES)}
    out = []
    for name, line in sorted(lines.items(), key=lambda entry: (order[entry[1]['category']], entry[0].casefold())):
        labels = [label if len(ids) == 1 else f'{label} ×{len(ids)}' for label, ids in users[name].items()]
        out.append({'category': line['category'], 'name': name, 'quantity': line['quantity'], 'pieces': labels})
    count = lambda names: sum(line['quantity'] for name, line in lines.items() if name in names)
    control, notes, control_warnings = control_items(count({hw.SERVO}), count(hw.BLUETOOTH_MOTORS),
                                                     count(hw.INFRARED_MOTORS))
    if any(piece['family'] in MOUNTING_FAMILIES for piece in pieces):
        notes.append(ANCHOR_NOTE)
    return {'lines': out, 'control': control, 'notes': notes,
            'warnings': list(dict.fromkeys(control_warnings + warnings))}


def plain_text(result: dict) -> list[str]:
    """Markdown rows for the assembly guide's shopping list (category, quantity, item, pieces)."""
    rows = ['| Category | Qty | Item | For |', '| --- | --- | --- | --- |']
    rows += [f'| {CATEGORY_LABELS[line["category"]]} | {line["quantity"]} | {line["name"]} | {", ".join(line["pieces"])} |'
             for line in result['lines']]
    rows += [f'| Control gear | {item["quantity"]} | {item["name"]} | {"; ".join(filter(None, (item["scope"], item["note"])))} |'
             for item in result['control']]
    return rows


def manifest_pieces(instances: list[dict], labels: dict[str, str]) -> list[dict]:
    """A frozen manifest's printed instances as shopping-list pieces, labelled as the assembly guide names them:
    track pieces by ``labels`` (instance id → "3 · Left turnout"), supports and brackets by kind (so they count as
    ``wall bracket ×6``)."""
    pieces = []
    for item in instances:
        if item['source'] != 'printed':
            continue
        family, parameters = item['family'], item['parameters']
        piece, label = item['id'], labels[item['id']]
        if family == track_bracket.FAMILY:
            label = 'wall bracket' if parameters.get('mount') == track_bracket.WALL else 'shelf bracket'
        elif item['interfaceKind'] == 'mounting':
            label = family.replace('_', ' ')
        else:
            piece = label  # a piece printed in sections (a climb) is one piece
        pieces.append({'id': item['id'], 'piece': piece, 'label': label, 'family': family, 'parameters': parameters})
    return pieces


def guide_section(result: dict) -> str:
    """The assembly guide's shopping list (markdown)."""
    rows = ['# Shopping list', '',
            'Everything to buy besides the printed parts, for the whole layout. Each multipart piece lists its own '
            'share below.', '']
    rows += [f'> **{warning}**' for warning in result['warnings']]
    if result['warnings']:
        rows.append('')
    if not result['lines'] and not result['control']:
        return '\n'.join(rows + ['This layout needs no extra hardware.'])
    rows += plain_text(result)
    if result['notes']:
        rows += ['', *(f'- {note}' for note in result['notes'])]
    return '\n'.join(rows)
