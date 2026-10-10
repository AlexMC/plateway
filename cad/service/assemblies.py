"""Logical track interfaces and deterministic physical component membership.

Every junction CAD module registers in JUNCTION_MODULES. A module exposes
FAMILIES, COMPONENT_FAMILY, validate(family, p), ports(family, p),
route_pairs(family, p) -> {frozenset((a, b)): enabled}, components(family, p),
component_keys(p), validate_component(p), build_component(p), component_ports(p),
hardware(family, p), assembly_notes(family, p) and SOURCE_DEPENDENCIES.
"""

from __future__ import annotations

import math
from pathlib import Path
import re
from types import SimpleNamespace

from cad.models import crossing_any, crossover_slip, funicular, gauge_junctions, monorail, moving_bridge, rotary_dumper, tables, track_assembly, turnout, uncoupler


def _legacy_pairs(family: str, p: dict) -> dict[frozenset, bool]:
    state = bool(p['switch_state'])
    if family == 'printed_flex':
        return {frozenset(('in', 'out')): True}
    if family.startswith('printed_switch_'):
        return {frozenset(('in', 'out')): not state, frozenset(('in', 'branch')): state}
    if family == 'printed_crossing90':
        return {frozenset(('in', 'out')): True, frozenset(('north', 'south')): True}
    return {frozenset(('in', 'out')): not state,
            frozenset(('parallel-in', 'parallel-out')): not state,
            frozenset(('in', 'parallel-out')): state,
            frozenset(('parallel-in', 'out')): state}


def _legacy_logical(p: dict) -> dict:
    return {key: p[key] for key in track_assembly.LOGICAL_PARAMETERS}


# The original mechanisms keep their module untouched; this adapter gives them the registry interface.
_LEGACY = SimpleNamespace(
    FAMILIES=track_assembly.FAMILIES, COMPONENT_FAMILY='track_component',
    validate=track_assembly.validate, ports=track_assembly.ports, route_pairs=_legacy_pairs,
    components=track_assembly.components, component_keys=lambda p: set(track_assembly.COMPONENT_PARAMETERS),
    validate_component=track_assembly.validate_component, build_component=track_assembly.build_component,
    component_ports=lambda p: track_assembly.ports(track_assembly.FAMILIES[int(p['shape_code'])], _legacy_logical(p)),
    hardware=track_assembly.hardware, assembly_notes=track_assembly.assembly_notes,
    SOURCE_DEPENDENCIES=[Path(track_assembly.__file__).resolve().parents[1] / 'profiles/track-assemblies-v1.json'])

JUNCTION_MODULES = (_LEGACY, crossing_any, turnout, crossover_slip, moving_bridge, tables, uncoupler, funicular, monorail, gauge_junctions, rotary_dumper)
MODULES = {family: module for module in JUNCTION_MODULES for family in module.FAMILIES}
COMPONENT_MODULES = {module.COMPONENT_FAMILY: module for module in JUNCTION_MODULES}
FAMILIES = frozenset(MODULES)
_NAME = re.compile(r'[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}\Z')


def module_for(family: str):
    """The junction module of a printed assembly family."""
    return MODULES[printed_family(family)]


def component_module(family: str):
    """The junction module that builds a component family, or None."""
    return COMPONENT_MODULES.get(family)


def printed_family(family: str) -> str:
    if not isinstance(family, str):
        raise ValueError('Track assembly family must be a string')
    candidate = 'printed_' + family.removeprefix('brick_') if family.startswith('brick_') else family
    if candidate not in FAMILIES:
        raise ValueError('Unsupported track assembly family')
    return candidate


def validate_assembly(instance: dict) -> None:
    """Compare declared ports and routing to the authoritative local CAD recipe."""
    family = printed_family(instance['family'])
    expected_source = 'printed' if instance['family'] in FAMILIES else 'owned'
    if instance['source'] != expected_source:
        raise ValueError('Track assembly family and source disagree')
    p = instance['parameters']
    module = MODULES[family]
    module.validate(family, p)
    pose = instance['pose']
    if abs(pose['pitch']) > 1e-9:
        raise ValueError('Track assemblies require a level pose')
    expected = {port['id']: port for port in module.ports(family, p)}
    supplied = instance['ports']
    if not isinstance(supplied, list) or len(supplied) != len(expected):
        raise ValueError('Track assembly port membership differs from CAD')
    seen = set()
    for port in supplied:
        if not isinstance(port, dict) or set(port) != {'id', 'pose', 'profile', 'railGauge', 'interfaceWidth'}:
            raise ValueError('Track assembly named port fields are invalid')
        ident = port['id']
        if not isinstance(ident, str) or ident not in expected or ident in seen:
            raise ValueError('Track assembly has unknown or duplicate ports')
        seen.add(ident)
        reference = expected[ident]
        actual = port['pose']
        if (not isinstance(actual, dict) or set(actual) != {'x', 'y', 'z', 'heading', 'pitch'} or
                any(type(value) not in (int, float) or not math.isfinite(value) for value in actual.values())):
            raise ValueError('Track assembly port pose must be finite')
        x, y, z = reference['position']
        c, s = math.cos(pose['heading']), math.sin(pose['heading'])
        position = (pose['x'] + x*c-y*s, pose['y'] + x*s+y*c, pose['z'] + z)
        angle = actual['heading']-pose['heading']-reference['heading']
        if (math.dist(position, (actual['x'], actual['y'], actual['z'])) > .01 or
                abs(math.atan2(math.sin(angle), math.cos(angle))) > .001 or
                abs(actual['pitch']-reference['pitch']) > .001 or
                port['profile'] != 'brick' or
                port['railGauge'] != reference['rail_gauge'] or
                port['interfaceWidth'] != reference['rail_interface_width']):
            raise ValueError('Track assembly port differs from CAD')
    pairs = module.route_pairs(family, p)
    paths = instance['paths']
    if not isinstance(paths, list) or len(paths) != len(pairs):
        raise ValueError('Track assembly path membership differs from CAD')
    path_ids, actual_pairs = set(), set()
    for path in paths:
        if not isinstance(path, dict) or set(path) != {'id', 'from', 'to', 'enabled'}:
            raise ValueError('Track assembly path fields are invalid')
        ident, start, end = path['id'], path['from'], path['to']
        if (not isinstance(ident, str) or not _NAME.fullmatch(ident) or '..' in ident or
                ident in path_ids or not isinstance(start, str) or not isinstance(end, str)):
            raise ValueError('Track assembly path identity is invalid')
        pair = frozenset((start, end))
        if pair not in pairs or pair in actual_pairs or type(path['enabled']) is not bool or path['enabled'] != pairs[pair]:
            raise ValueError('Track assembly routing differs from its selected state')
        path_ids.add(ident)
        actual_pairs.add(pair)


def primary_ports(instance: dict) -> tuple[dict, dict]:
    """Convert outward assembly ports to the existing forward chain convention."""
    if instance['interfaceKind'] == 'rail':
        return instance['startPort'], instance['endPort']
    ports = {port['id']: port for port in instance['ports']}
    start = ports['in']
    return ({**start, 'pose': {**start['pose'], 'heading': start['pose']['heading'] + math.pi}}, ports['out'])


def expand_components(parts: list[dict]) -> list[dict]:
    """Expand each logical assembly once; never count traversal edges as physical parts."""
    expanded = []
    ids = set()
    for part in parts:
        if part.get('interfaceKind') != 'track-assembly':
            rows = [part]
        else:
            module = module_for(part['family'])
            recipes = module.components(printed_family(part['family']), part['parameters'])
            if not recipes:
                raise ValueError('Track assembly has no physical components')
            rows = []
            for recipe in recipes:
                role = recipe['role']
                ident = f'{part["id"]}:{role}'
                if not isinstance(role, str) or not _NAME.fullmatch(ident) or '..' in ident:
                    raise ValueError('Invalid assembly component identity')
                module.validate_component(recipe['parameters'])
                rows.append({
                    'id': ident, 'family': module.COMPONENT_FAMILY, 'parameters': recipe['parameters'],
                    'interfaceKind': 'assembly-component', 'pose': part['pose'],
                    'part_revision': part['part_revision'], 'layout_revision': part['layout_revision'],
                    'assemblyInstanceId': part['id'], 'assemblyFamily': part['family'], 'componentRole': role,
                    'assemblyParameters': dict(part['parameters']),
                })
        for row in rows:
            if row['id'] in ids:
                raise ValueError('Duplicate physical component identity')
            ids.add(row['id'])
            expanded.append(row)
    return expanded
