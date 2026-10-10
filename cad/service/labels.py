"""Short, human codes for every printed part: what the guide, the Print panel and the slicer's object list show.

A layout piece is numbered in layout order (1, 2, …); a piece printed as several parts gives each part a letter (1A,
1B, …), a one-part piece is just its number. Supports and track brackets are coded S1, S2, … on their own.
"""
from __future__ import annotations

import re

from cad.models import composite, flex_track, helix_column, rack, track_bracket

NAMES = {
    'printed_straight': 'Straight', 'printed_curve': 'Curve', 'vertical_transition': 'Ramp',
    'bridge_deck': 'Bridge deck', 'bridge_joint': 'Bridge joint', 'connector_joiner': 'Joiner',
    'reversible_column': 'Support column', 'anchored_bracket': 'Anchored bracket', 'reversible_foot': 'Support foot',
    'layout_riser': 'Riser block', 'brick_end_coupon': 'Calibration sample', 'connector_coupon': 'Calibration sample',
    'printed_flex': 'Flex track', 'printed_switch_left': 'Left turnout', 'printed_switch_right': 'Right turnout',
    'printed_crossing90': '90° crossing', 'printed_double_crossover': 'Double crossover',
    'composite_track': 'Printed track', 'track_diamond': 'Diamond crossing', 'track_diamond_curve': 'Curve crossing',
    'track_gauntlet': 'Gauntlet track', helix_column.FAMILY: 'Helix column', rack.FAMILY: 'Cog bogie',
    flex_track.FAMILY: 'Flexible track', composite.INSERT_FAMILY: 'Colour marker insert',
}
ROLE_NAMES = ((r'^keyed-base-', 'base'), (r'^selector-lock-', 'lock pin'), (r'^selector-', 'selector'),
              (r'^keeper-', 'keeper'), (r'^pivot-leaf$', 'fixed leaf'), (r'^articulating-leaf$', 'moving leaf'),
              (r'^crossing-base(-\d+)?$', 'base'))


def family_name(family: str) -> str:
    return NAMES.get(family) or family.replace('_', ' ').capitalize()


def role_name(role: str) -> str:
    return next((name for pattern, name in ROLE_NAMES if re.match(pattern, role)), role.replace('-', ' '))


def is_support(instance: dict) -> bool:
    """Columns, brackets and risers that hold track up: coded S1, S2, … rather than as layout pieces."""
    return instance['interfaceKind'] == 'mounting' or instance['family'] == track_bracket.FAMILY


def support_name(family: str, parameters: dict) -> str:
    if family == track_bracket.FAMILY:
        return 'Wall bracket' if parameters.get('mount') == track_bracket.WALL else 'Shelf bracket'
    return family_name(family)


def letter(index: int) -> str:
    """A, B, … Z, AA, AB, …"""
    return chr(ord('A') + index) if index < 26 else letter(index // 26 - 1) + chr(ord('A') + index % 26)


def _part_title(part: dict, siblings: list[dict]) -> str:
    """A part's name within its piece: its mechanism role ("base 2 of 5"), else its place among same-kind parts."""
    if part.get('componentRole'):
        role = role_name(part['componentRole'])
        same = sorted(item['componentRole'] for item in siblings if item.get('componentRole') and
                      role_name(item['componentRole']) == role)
        return f'{role} {same.index(part["componentRole"])+1} of {len(same)}' if len(same) > 1 else role
    same = [item for item in siblings if not item.get('componentRole') and item['family'] == part['family']]
    return f'part {same.index(part)+1} of {len(same)}' if len(same) > 1 else family_name(part['family']).lower()


def piece_of(manifest: dict):
    """The layout piece an instance belongs to, by its section: a piece printed in several sections (a climb, a long
    ramp) gives them `<piece>:<n>` section ids."""
    tiles = [piece['id'] for route in manifest['routes'] for piece in route.get('pieces', ())
             if isinstance(piece, dict) and isinstance(piece.get('id'), str)]

    def piece(instance: dict) -> str:
        section = instance['sectionId']
        return next((tile for tile in tiles if section == tile or section.startswith(f'{tile}:')), section)
    return piece


def label_parts(parts: list[dict], manifest: dict | None) -> None:
    """Set `code`, `piece` (its piece's code), `pieceName` and `name` on every expanded printed part (`id`, `family`,
    optional `assemblyInstanceId` and `componentRole`), in place. Pieces follow the manifest's order; the manifest's
    optional `pieceNames` (layout piece id → name) names them, else their family does."""
    if manifest is None:
        for number, part in enumerate(parts, 1):
            name = family_name(part['family'])
            part.update(code=str(number), piece=str(number), pieceName=name, name=name)
        return
    piece = piece_of(manifest)
    names = manifest.get('pieceNames', {})
    groups: dict[str, list[dict]] = {}
    supports = []
    for instance in manifest['instances']:
        if instance['source'] != 'printed':
            continue
        if is_support(instance):
            supports.append(instance)
            continue
        groups.setdefault(piece(instance), []).append(instance)
    owner = lambda part: part.get('assemblyInstanceId') or part['id']
    for number, (tile, instances) in enumerate(groups.items(), 1):
        ids = {instance['id'] for instance in instances}
        own = [part for part in parts if owner(part) in ids]
        name = names.get(tile) or family_name(instances[0]['family'])
        for index, part in enumerate(own):
            code = str(number) if len(own) == 1 else f'{number}{letter(index)}'
            part.update(code=code, piece=str(number), pieceName=name,
                        name=name if len(own) == 1 else f'{name} · {_part_title(part, own)}')
    for number, instance in enumerate(supports, 1):
        code, name = f'S{number}', support_name(instance['family'], instance['parameters'])
        for part in parts:
            if owner(part) == instance['id']:
                part.update(code=code, piece=code, pieceName=name, name=name)
