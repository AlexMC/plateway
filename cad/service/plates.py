"""Arrange labelled STL instances, write a plain core-spec 3MF per plate for any slicer, and
verify real Bambu Studio project/slice output."""

from __future__ import annotations

from collections import Counter
from collections.abc import Callable
from functools import lru_cache
import hashlib
import json
import logging
import math
import os
from pathlib import Path
import re
import shutil
import subprocess
from xml.sax.saxutils import escape, quoteattr
import xml.etree.ElementTree as ET
import zipfile

import numpy as np
import trimesh

from cad.models import buffer, composite, flex_track, brick_end, rerailer
from cad.service.assemblies import COMPONENT_MODULES
from cad.service.errors import BAMBU_MISSING, UserError
from cad.service.thumbnails import plate_thumbnail

MACOS_CLI = '/Applications/BambuStudio.app/Contents/MacOS/BambuStudio'
ENVELOPES = {'X1 Carbon': (256, 256, 250), 'A1 mini': (180, 180, 180)}
MACHINE_NAMES = {'X1 Carbon': 'Bambu Lab X1 Carbon', 'A1 mini': 'Bambu Lab A1 mini'}
MATERIALS = ('Bambu PLA Basic', 'Generic PLA')
NOZZLES = (0.2, 0.4, 0.6, 0.8)
log = logging.getLogger(__name__)
# Called at stage boundaries of a package build (`cad`, `arrange`, `slice`, `guide`) with the steps done and the stage's
# total, e.g. ('slice', 2, 8) as the third of eight plates starts; prepare jobs (`jobs.py`) report it as progress.
Progress = Callable[[str, int, int], None]


def no_progress(_stage: str, _done: int, _total: int) -> None:
    pass


def bambu_cli() -> Path:
    """The Bambu Studio executable: BAMBU_STUDIO_CLI (the extracted Linux AppImage's AppRun), else the macOS app."""
    return Path(os.environ.get('BAMBU_STUDIO_CLI') or MACOS_CLI)


def presets_root() -> Path:
    """Bundled BBL profiles beside that executable: Contents/Resources in the macOS app, resources/ in the AppImage."""
    cli = bambu_cli()
    return (cli.parents[1] / 'Resources' if cli.parent.name == 'MacOS' else cli.parent / 'resources') / 'profiles/BBL'


def _preset(folder: str, name: str, trail: tuple[str, ...] = (), *, template: bool = False) -> dict:
    if not isinstance(name, str) or not name or '/' in name or '\\' in name or name in ('.', '..'):
        raise ValueError('Preset must be a bundled preset name')
    if name in trail:
        raise ValueError(f'Circular bundled {folder} preset inheritance: {name}')
    path = presets_root() / folder / f'{name}.json'
    if path.is_symlink() or not path.is_file():
        raise ValueError(f'Bundled {folder} preset not found: {name}')
    data = json.loads(path.read_text())
    if data.get('name') != name or data.get('type', folder if template else None) != folder:
        raise ValueError(f'Invalid bundled {folder} preset: {name}')
    # The CLI loads JSON values but does not resolve bundled inheritance/includes.
    # Materialize the same parent → included template → leaf precedence explicitly.
    trail = (*trail, name)
    resolved = _preset(folder, data['inherits'], trail) if data.get('inherits') else {}
    for included in data.get('include', []):
        resolved.update(_preset(folder, included, trail, template=True))
    resolved.update(data)
    resolved.pop('include', None)
    resolved['inherits'] = ''
    return resolved

def _bundled(folder: str, name: str, missing: str) -> dict:
    if isinstance(name, str) and not (presets_root() / folder / f'{name}.json').is_file():
        raise UserError(missing)
    return _preset(folder, name)


def select_presets(printer: dict) -> dict:
    if not bambu_cli().is_file():
        raise UserError(BAMBU_MISSING)
    if not isinstance(printer, dict) or set(printer) != {'name', 'material', 'profile', 'nozzleMm', 'orientation', 'envelope'}:
        raise ValueError('Printer requires name, material, profile, nozzleMm, orientation and envelope')
    name, nozzle = printer['name'], printer['nozzleMm']
    if name not in ENVELOPES or type(nozzle) not in (int, float) or not math.isfinite(nozzle):
        raise ValueError('Unsupported printer/nozzle')
    expected = dict(zip(('x', 'y', 'z'), ENVELOPES[name]))
    if printer['envelope'] != expected:
        raise ValueError('Selected printer envelope differs from the bundled machine')
    if printer['orientation'] != 'flat':
        raise ValueError('Only flat plate orientation is supported')
    machine = f'{MACHINE_NAMES[name]} {nozzle:g} nozzle'
    machine_data = _bundled('machine', machine, f'Bambu Studio has no {name} profile for a {nozzle:g} mm nozzle.')
    if machine_data.get('printer_model') != MACHINE_NAMES[name] or [str(nozzle)] != machine_data.get('nozzle_diameter'):
        raise ValueError('Machine nozzle does not match selected nozzle')
    process_data = _bundled('process', printer['profile'], f'Bambu Studio has no process named “{printer["profile"]}”.')
    if printer['material'] not in (*MATERIALS, CLEAR_MATERIAL):
        raise UserError('Choose Bambu PLA Basic or Generic PLA.')
    suffix = {'X1 Carbon': 'X1C', 'A1 mini': 'A1M'}[name]
    filament_name = f'{printer["material"]} @BBL {suffix}'
    filament_data = _bundled('filament', filament_name, f'Bambu Studio has no {printer["material"]} profile for the {name}.')
    for label, data in (('process', process_data), ('material', filament_data)):
        if machine not in data.get('compatible_printers', []):
            raise UserError(f'The chosen {label} doesn’t work with the {name} and a {nozzle:g} mm nozzle.')
    area = machine_data.get('printable_area')
    maximum_height = machine_data.get('printable_height')
    if area != ['0x0', f'{expected["x"]}x0', f'{expected["x"]}x{expected["y"]}', f'0x{expected["y"]}'] or float(maximum_height) != expected['z']:
        raise ValueError('Machine printable envelope differs from selected envelope')
    exclusion = [tuple(map(float, point.split('x'))) for point in machine_data.get('bed_exclude_area', [])]
    return {'machine': machine, 'machineConfig': machine_data, 'processConfig': process_data,
            'filamentConfig': filament_data, 'filamentName': filament_name, 'exclusion': exclusion}


# Fast-print track uses the coarsest bundled layer up to this height.
FAST_LAYER_LIMIT = 0.28


def _fast_process(processes: list[str]) -> str | None:
    """Largest bundled layer height ≤ FAST_LAYER_LIMIT; ties avoid Strength variants, then by name."""
    candidates = []
    for name in processes:
        height = float(_preset('process', name)['layer_height'])
        if height <= FAST_LAYER_LIMIT + 1e-9:
            candidates.append((-height, 'Strength' in name, name))
    return min(candidates)[2] if candidates else None


@lru_cache(maxsize=1)
def print_presets() -> dict[str, dict]:
    """Bundled materials and processes select_presets accepts, per printer.

    Top-level lists are for the default 0.4 mm nozzle; byNozzle covers every nozzle.
    fastProcess is the process fast-print track plates use for that printer and nozzle.
    """
    if not bambu_cli().is_file():
        raise UserError(BAMBU_MISSING)
    processes = sorted(path.stem for path in (presets_root() / 'process').glob('*.json'))
    result: dict[str, dict] = {}
    for name, size in ENVELOPES.items():
        envelope = dict(zip(('x', 'y', 'z'), size))
        by_nozzle: dict[str, dict[str, list[str]]] = {}
        for nozzle in NOZZLES:
            machine = f'{MACHINE_NAMES[name]} {nozzle:g} nozzle'
            candidates = []
            for profile in processes:
                try:
                    data = json.loads((presets_root() / 'process' / f'{profile}.json').read_text())
                except (OSError, ValueError):
                    continue
                if machine in data.get('compatible_printers', []):
                    candidates.append(profile)
            accepted: dict[str, list[str]] = {}
            for material in MATERIALS:
                for profile in candidates:
                    try:
                        select_presets({'name': name, 'material': material, 'profile': profile,
                                        'nozzleMm': nozzle, 'orientation': 'flat', 'envelope': envelope})
                    except (ValueError, KeyError, TypeError, OSError):
                        continue
                    accepted.setdefault(material, []).append(profile)
            if accepted:
                listed = sorted(set.intersection(*(set(v) for v in accepted.values())))
                by_nozzle[f'{nozzle:g}'] = {'materials': list(accepted), 'processes': listed,
                                            'fastProcess': _fast_process(listed)}
        default = by_nozzle.get('0.4', {'materials': [], 'processes': [], 'fastProcess': None})
        result[name] = {**default, 'byNozzle': by_nozzle}
    return result


def fast_process(printer: dict) -> str:
    """The bundled process fast-print track plates use for this printer and nozzle."""
    lists = print_presets().get(printer['name'], {}).get('byNozzle', {}).get(f"{printer['nozzleMm']:g}", {})
    if not lists.get('fastProcess'):
        raise UserError(f"Bambu Studio has no fast process for the {printer['name']} with a {printer['nozzleMm']:g} mm nozzle.")
    return lists['fastProcess']
    return result


def _rect_intersects_polygon(x: float, y: float, w: float, h: float, polygon: list[tuple[float, float]]) -> bool:
    if not polygon:
        return False
    # Bundled exclusion is rectangular on supported machines; reject any changed shape rather than guessing.
    xs, ys = {p[0] for p in polygon}, {p[1] for p in polygon}
    if len(xs) != 2 or len(ys) != 2 or set(polygon) != {(a, b) for a in xs for b in ys}:
        raise ValueError('Unsupported machine bed exclusion polygon')
    return x < max(xs) and x + w > min(xs) and y < max(ys) and y + h > min(ys)


# Switch/crossover selectors, keepers and state-lock pins, and the guided parts of
# moving spans (decks, leaves, posts), need the detailed process's tolerances, even
# when the track around them prints fast.
MECHANISM_ROLE = re.compile(r'(selector|keeper|mechanism)-')


def is_mechanism(part: dict) -> bool:
    return bool(MECHANISM_ROLE.match(part.get('componentRole') or ''))


# Colour marker inserts print on their own plates, one per colour, in that colour's filament.
# Bluetooth colour & distance sensor (88007) COLOR mode ids.
MARKER_COLOURS = {10: ('White', '#F4F4F4'), 9: ('Red', '#C91A09'), 7: ('Yellow', '#F2CD37'),
                  5: ('Green', '#237841'), 3: ('Blue', '#0055BF')}


def marker_colour(marker: float) -> tuple[str, str]:
    return MARKER_COLOURS.get(int(marker), (f'Colour {int(marker)}', '#808080'))


# LED-channel track prints in translucent PLA on its own plates (track_power.py); the plate is labelled Clear.
CLEAR, CLEAR_MATERIAL = 'Clear', 'Bambu PLA Translucent'


def plate_style(part: dict) -> str:
    """'fast' for fast-print track pieces, 'marker-<id>' for colour inserts, 'clear'/'clear-fast'
    for LED-channel track, else 'detailed'; plates never mix them."""
    if part.get('family') == composite.INSERT_FAMILY:
        return f"marker-{int(part['parameters']['marker'])}"
    fast = part.get('parameters', {}).get('lite') == 1 and not is_mechanism(part)
    if part.get('family') == composite.FAMILY and part['parameters'].get('led'):
        return 'clear-fast' if fast else 'clear'
    if part.get('materials'):
        return 'flex-fast' if fast else 'flex'
    return 'fast' if fast else 'detailed'


def plate_process(style: str) -> str:
    """The process a plate style prints with: fast track uses the fast process, all else detailed."""
    return 'fast' if style in ('fast', 'clear-fast', 'flex-fast') else 'detailed'


# Multi-material (flexible track) plates: the project filament plus the spine's TPU in AMS slot 2. Bambu adds a
# prime tower; it stands in the back-right corner, in a band no part enters.
TOWER = 45.0
TOWER_COLOURS = ('#F2F2F2', '#3C3C3C')
# Per-filament project settings the CLI writes with one entry for a multi-filament load (it then rejects the 3MF).
FILAMENT_LISTS = ('default_filament_colour', 'filament_change_length_nc', 'filament_is_mixed', 'filament_map',
                  'filament_map_2', 'filament_mixed_components', 'filament_nozzle_map', 'filament_volume_map')


def _multi_filament(config: dict, width: float, depth: float) -> None:
    """Complete a multi-filament project's per-filament lists and flush matrix, and seat the prime tower."""
    count = len(config['filament_settings_id'])
    config['filament_colour'] = list(TOWER_COLOURS[:count])
    for key in FILAMENT_LISTS:
        if len(config.get(key, [])) == 1:
            config[key] = config[key] * count
    flush = config['flush_volumes_matrix'][1]
    config['flush_volumes_matrix'] = ['0' if row == column else flush for row in range(count) for column in range(count)]
    config['wipe_tower_x'], config['wipe_tower_y'] = [f'{width - 7.0 - TOWER + 3:g}'], [f'{depth - 7.0 - TOWER + 3:g}']


# Painted supports spread past a part's own outline: first-layer support reaches up
# to 6.7 mm beyond it (ramp rails; lock-pin heads 6.5; track connector ends ≤ 5.3,
# measured on sliced G-code). Bambu rejects a plate whose neighbouring toolpaths meet,
# so supported neighbours stand at least this far apart plus a line's clearance.
SUPPORT_REACH = 7.0
SUPPORT_CLEARANCE = 1.0


def arrange(parts: list[dict], printer: dict, presets: dict,
            supported: frozenset[str] = frozenset()) -> list[list[dict]]:
    """Deterministic shelf packing per print style (first-seen order); margin permits
    skirts and excludes the X1 purge zone. Parts whose instanceId is in supported
    keep room for their painted supports."""
    styles = list(dict.fromkeys(plate_style(part) for part in parts))
    return [plate for style in styles
            for plate in _shelves([p for p in parts if plate_style(p) == style], printer, presets, supported,
                                  TOWER + 7.0 if style.startswith('flex') else 0.)]


def _shelves(parts: list[dict], printer: dict, presets: dict, supported: frozenset[str],
             reserve: float = 0.) -> list[list[dict]]:
    """``reserve``: a band along the back edge kept free (a multi-material plate's prime tower)."""
    width, depth, height = ENVELOPES[printer['name']]
    depth -= reserve
    margin = 7.0
    # A new row may hold a supported part, so it clears the previous row's reach too.
    any_support = any(part['instanceId'] in supported for part in parts)

    def gap(a: float, b: float) -> float:
        return max(margin, a + b + SUPPORT_CLEARANCE) if a or b else margin

    plates: list[list[dict]] = []
    plate: list[dict] = []
    x = y = margin
    row_height = row_reach = previous = 0.0
    for part in parts:
        sx, sy, sz = part.get('printBounds', part['bounds'])['size']
        if any(not math.isfinite(n) or n <= 0 for n in (sx, sy, sz)) or sx + 2 * margin > width or sy + 2 * margin > depth or sz > height:
            raise UserError(f"A printed part is too large for the {printer['name']} bed.")
        reach = SUPPORT_REACH if part['instanceId'] in supported else 0.0
        if row_height:
            x += gap(previous, reach) - margin
        if x + sx + margin > width:
            x, y = margin, y + row_height + gap(row_reach, SUPPORT_REACH if any_support else 0.0)
            row_height = row_reach = 0.0
        if y + sy + margin > depth:
            if not plate:
                raise UserError(f"A printed part is too large for the {printer['name']} bed.")
            plates.append(plate)
            plate = []
            x = y = margin
            row_height = row_reach = 0.0
        if _rect_intersects_polygon(x, y, sx, sy, presets['exclusion']):
            x = max(v[0] for v in presets['exclusion']) + margin
            if x + sx + margin > width:
                x, y = margin, max(v[1] for v in presets['exclusion']) + margin
        if y + sy + margin > depth or x + sx + margin > width:
            raise UserError(f"A printed part is too large for the {printer['name']} bed.")
        part['plannedPlacement'] = {'x': x, 'y': y, 'z': 0, 'orientation': 'flat'}
        plate.append(part)
        x += sx + margin
        row_height = max(row_height, sy)
        row_reach, previous = max(row_reach, reach), reach
    if plate:
        plates.append(plate)
    return plates


def _cli(args: list[str], output: Path, plate: int) -> dict:
    try:
        result = subprocess.run([str(bambu_cli()), '--datadir', str(output / 'bambu-config'), *args],
                                cwd=output, capture_output=True, text=True, timeout=600, check=False)
    except subprocess.TimeoutExpired as exc:
        raise UserError(f'Bambu Studio took too long on plate {plate}.') from exc
    receipt_path = output / 'result.json'
    receipt = json.loads(receipt_path.read_text()) if receipt_path.is_file() else {}
    if result.returncode or receipt.get('return_code') != 0:
        log.error('Bambu Studio failed on plate %s (exit %s): %s\n%s', plate, result.returncode,
                  receipt.get('error_string'), result.stderr[-4000:])
        raise UserError(f'Bambu Studio couldn’t slice plate {plate}. See the service log.')
    return receipt


# Supports are painted per triangle (Bambu's "paint_supports" enforcer state for a
# whole triangle) and generated in normal(manual) mode, so Bambu adds support only
# where it is painted: never inside hollow rail channels, clutch bays or other
# bridgeable roofs. Enforcers are ignored while enable_support is off.
ENFORCER = '4'
SUPPORT_OVERRIDES = {'enable_support': '1', 'support_type': 'normal(manual)',
                     # These narrow contact roofs are small overhangs Bambu would otherwise drop.
                     'support_remove_small_overhang': '0', 'support_top_z_distance': '0.2',
                     'support_interface_top_layers': '3', 'support_interface_spacing': '0.2'}
# Connector contact tongues protrude 3.7 mm past each port face within the rail
# stringer band; painted roofs reach 1 mm beyond them and stop before the half-tie
# clutch bays, whose roofs begin 1.6 mm inboard and just outside the band.
END_REACH = (-4.7, 2.8)
RAIL_BAND = (brick_end.PROFILE['railGauge'] / 2 - brick_end.PROFILE['baseStringerWidth'] / 2,
             brick_end.PROFILE['railGauge'] / 2 + brick_end.PROFILE['baseStringerWidth'] / 2)
# Bambu's bundled support threshold: roofs within 30° of horizontal need support.
FLAT_ROOF = -math.cos(math.radians(30))
SHARED_END_FAMILIES = {'printed_straight', 'printed_curve', 'vertical_transition', 'bridge_deck', 'bridge_joint'}
# Level composite straights with their own options: connector ends as composite ones.
SCENIC_TRACK = {buffer.FAMILY: buffer, rerailer.FAMILY: rerailer}
# A composite connector end above its flat underside (graded pieces) floats: every
# face on its underside plane is supported, from the tongue roofs back to the half
# tie's inner wall. Clutch and coupon roofs above that plane bridge from it.
FLOATING_END = (END_REACH[0], brick_end.PROFILE['endTieWidth'] + .3)
FLOATING_PLANE = .3


def _end_frames(part: dict) -> list[tuple[float, float, float]]:
    """(x, y, inward heading) of every shared brick port face in part coordinates."""
    p, family = part.get('parameters') or {}, part.get('family')
    if family == 'brick_end_coupon':
        return [(0.0, 0.0, 0.0), (brick_end.PROFILE['sampleLength'], 0.0, math.pi)]
    if part.get('library'):
        # A community piece: its marked ends (`generate.mesh_ports`), whatever its uploaded mesh overhangs there.
        ports = part['ports']
        return [(*ports[0]['position'][:2], ports[0]['heading']),
                (*ports[1]['position'][:2], ports[1]['heading'] + math.pi)]
    if p.get('connector_version') != 1 or is_mechanism(part):
        return []
    if family == composite.FAMILY:
        return [(end['x'], end['y'], end['heading']) for end in composite.connector_ends(p)]
    if family == flex_track.FAMILY:
        return [(end['x'], end['y'], end['heading']) for end in flex_track.connector_ends(p)]
    if family in SCENIC_TRACK:
        return [(end['x'], end['y'], end['heading']) for end in SCENIC_TRACK[family].connector_ends(p)]
    if family in COMPONENT_MODULES:
        return [(port['position'][0], port['position'][1], port['heading'] + math.pi)
                for port in COMPONENT_MODULES[family].component_ports(p)]
    if family in SHARED_END_FAMILIES:
        ports = part.get('ports')
        if not isinstance(ports, list) or len(ports) != 2:
            raise ValueError('Shared track ends need their CAD ports to place connector supports')
        return [(*ports[0]['position'][:2], ports[0]['heading']),
                (*ports[1]['position'][:2], ports[1]['heading'] + math.pi)]
    return []


def _ramp_floor(p: dict, x: np.ndarray) -> np.ndarray:
    """Deck underside height along a ramp's Hermite centre path, extended at the ends."""
    run = p['run']
    t = np.clip(x / run, 0, 1)
    z = ((t**3 - 2*t*t + t) * run * p['start_grade'] + (-2*t**3 + 3*t*t) * p['rise']
         + (t**3 - t*t) * run * p['end_grade'])
    return z + np.minimum(x, 0) * p['start_grade'] + np.maximum(x - run, 0) * p['end_grade']


def enforced_faces(part: dict, centroids: np.ndarray, normals: np.ndarray, bed: np.ndarray) -> np.ndarray:
    """Triangles that must carry removable support.

    centroids are in part (CAD) coordinates; normals and bed (height above the plate)
    in the printed orientation. Only these print with support:
    - connector contact tongues under both rails at every shared brick port;
    - side-on ramps: rails and studs, which face sideways into open air;
    - floating composite connector ends: their underside plane back to the half tie;
    - anchored brackets and selector state-lock heads: every flat roof;
    - junction components whose module names their own (`support_faces`, e.g. a bent monorail ramp's underside).
    """
    mask = np.zeros(len(centroids), dtype=bool)
    down = (normals[:, 2] < -.5) & (bed > .05)
    for x0, y0, heading in _end_frames(part):
        dx, dy = centroids[:, 0] - x0, centroids[:, 1] - y0
        u = dx * math.cos(heading) + dy * math.sin(heading)
        v = np.abs(dy * math.cos(heading) - dx * math.sin(heading))
        mask |= down & (u >= END_REACH[0]) & (u <= END_REACH[1]) & (v >= RAIL_BAND[0]) & (v <= RAIL_BAND[1])
    roof = (normals[:, 2] < FLAT_ROOF) & (bed > .05)
    family, role = part.get('family'), part.get('componentRole') or ''
    if family == 'anchored_bracket' or role.startswith('selector-lock-'):
        mask |= roof
    elif family == 'vertical_transition':
        p = part['parameters']
        mask |= roof & (centroids[:, 2] - _ramp_floor(p, centroids[:, 0]) >= p['base_thickness'] - .3)
    elif family == composite.FAMILY and _end_frames(part):
        for end in composite.connector_ends(part['parameters']):
            if not end['elevated']:
                continue
            dx, dy = centroids[:, 0] - end['x'], centroids[:, 1] - end['y']
            u = dx * math.cos(end['heading']) + dy * math.sin(end['heading'])
            v = np.abs(dy * math.cos(end['heading']) - dx * math.sin(end['heading']))
            plane = end['z'] + end['slope'] * np.maximum(u, 0)
            mask |= (down & (u >= FLOATING_END[0]) & (u <= FLOATING_END[1])
                     & (v <= brick_end.PROFILE['bodyWidth'] / 2 + .5) & (centroids[:, 2] - plane <= FLOATING_PLANE))
    module = COMPONENT_MODULES.get(family)
    if module and hasattr(module, 'support_faces'):
        mask |= module.support_faces(part['parameters'], centroids, normals, bed)
    return mask


def _side_on(part: dict) -> bool:
    """Ramps, and junction components whose module prints them on their side (tall posts, counterweights)."""
    family = part.get('family')
    module = COMPONENT_MODULES.get(family)
    return family == 'vertical_transition' or bool(module and hasattr(module, 'side_on') and module.side_on(part['parameters']))


def _print_yaw(part: dict) -> float:
    """Junction components whose module turns them flat on the bed to fit (keyed pit and well pieces)."""
    module = COMPONENT_MODULES.get(part.get('family'))
    return float(module.print_yaw(part['parameters'])) if module and hasattr(module, 'print_yaw') else 0.


def _end_on(part: dict) -> bool:
    """Junction components whose module prints them standing on an end face (rings and cradles turning about x)."""
    module = COMPONENT_MODULES.get(part.get('family'))
    return bool(module and hasattr(module, 'end_on') and module.end_on(part['parameters']))


def _print_matrix(part: dict, mesh: trimesh.Trimesh) -> np.ndarray:
    """Part (CAD) coordinates → the printed mesh handed to Bambu Studio."""
    if part['printOrientation'] == 'as-authored-flat':
        return np.eye(4)
    rotation = (trimesh.transformations.rotation_matrix(part['printYaw'], (0, 0, 1))
                if part['printOrientation'] == 'rotated-flat' else
                trimesh.transformations.rotation_matrix(-math.pi / 2, (0, 1, 0))
                if part['printOrientation'] == 'end-on-bed' else
                trimesh.transformations.rotation_matrix(math.pi / 2, (1, 0, 0)))
    low = trimesh.transform_points(mesh.vertices, rotation).min(axis=0)
    return trimesh.transformations.translation_matrix(-low) @ rotation


def _enforced_mask(part: dict, vertices: np.ndarray, faces: np.ndarray, print_matrix: np.ndarray) -> np.ndarray:
    """Enforcer mask for triangles given in the printed-mesh frame."""
    triangles = vertices[faces]
    normals = np.cross(triangles[:, 1] - triangles[:, 0], triangles[:, 2] - triangles[:, 0])
    normals /= np.maximum(np.linalg.norm(normals, axis=1), 1e-12)[:, None]
    centroids = triangles.mean(axis=1)
    local = trimesh.transform_points(centroids, np.linalg.inv(print_matrix))
    return enforced_faces(part, local, normals, centroids[:, 2] - vertices[:, 2].min())


def _paint_object(text: str, object_id: str, transform: np.ndarray, part: dict,
                  print_matrix: np.ndarray) -> tuple[str, int]:
    """Mark enforced triangles of one 3MF mesh object; returns (text, painted count)."""
    block = re.search(rf'<object id="{re.escape(object_id)}"[^>]*>.*?</object>', text, re.S)
    if block is None:
        raise ValueError('3MF object mesh is missing')
    body = block.group(0)
    vertices = np.array(re.findall(r'<vertex x="([^"]+)" y="([^"]+)" z="([^"]+)"', body), dtype=float)
    faces = np.array(re.findall(r'<triangle v1="(\d+)" v2="(\d+)" v3="(\d+)"', body), dtype=int)
    if not len(vertices) or not len(faces):
        raise ValueError('3MF object mesh is empty')
    mask = iter(_enforced_mask(part, vertices @ transform[:3] + transform[3], faces, print_matrix))
    painted = 0

    def paint(match: re.Match) -> str:
        nonlocal painted
        if not next(mask):
            return match.group(0)
        painted += 1
        return f'{match.group(1)}{match.group(2)} paint_supports="{ENFORCER}"/>'

    body = re.sub(r'(<triangle v1="\d+" v2="\d+" v3="\d+")([^>]*?)\s*/>', paint, body)
    return text[:block.start()] + body + text[block.end():], painted


def _plate_offset(part: dict) -> tuple[float, float, float]:
    """Translation that puts a part's printed mesh where the shelf plan placed it on the bed."""
    origin = [0, 0, 0] if part['printOrientation'] != 'as-authored-flat' else part['bounds']['min']
    placement = part['plannedPlacement']
    return placement['x'] - origin[0], placement['y'] - origin[1], -origin[2]


CORE = 'http://schemas.microsoft.com/3dmanufacturing/core/2015/02'
MODEL_RELATIONSHIP = 'http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel'
CONTENT_TYPES = ('<?xml version="1.0" encoding="UTF-8"?>\n'
                 '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
                 '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
                 '<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>'
                 '</Types>\n')
RELATIONSHIPS = ('<?xml version="1.0" encoding="UTF-8"?>\n'
                 '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
                 f'<Relationship Target="/3D/3dmodel.model" Id="rel0" Type="{MODEL_RELATIONSHIP}"/>'
                 '</Relationships>\n')


def _mesh_xml(path: Path) -> str:
    """A core-spec <mesh>: shared vertices, and no triangle that repeats a vertex."""
    mesh = trimesh.load_mesh(path, force='mesh', process=False)
    mesh.merge_vertices()
    faces = np.asarray(mesh.faces)
    faces = faces[(faces[:, 0] != faces[:, 1]) & (faces[:, 1] != faces[:, 2]) & (faces[:, 0] != faces[:, 2])]
    if not len(faces):
        raise ValueError(f'Printed mesh {path.name} is empty')
    used, indices = np.unique(faces, return_inverse=True)
    vertices = '\n'.join(f'<vertex x="{x:.9g}" y="{y:.9g}" z="{z:.9g}"/>' for x, y, z in np.asarray(mesh.vertices)[used].tolist())
    triangles = '\n'.join(f'<triangle v1="{a}" v2="{b}" v3="{c}"/>' for a, b, c in indices.reshape(-1, 3).tolist())
    return f'<mesh><vertices>\n{vertices}\n</vertices><triangles>\n{triangles}\n</triangles></mesh>'


def object_names(part: dict) -> dict[str, str]:
    """Plate file label → the object name a slicer lists: the part's code (as in the guide and the Print panel);
    each material mesh of a multi-material part adds its role ("7 spine")."""
    if part.get('materialLabels'):
        return {label: f"{part['code']} {material['role']}" for label, material in zip(part['materialLabels'], part['materials'])}
    return {part['plateLabel']: part['code']}


def write_core_3mf(path: Path, folder: Path, objects: list[dict], plate: int, materials: list[str] | None = None) -> None:
    """One plate as a plain 3MF (core specification only, millimetres) that any slicer opens: each
    printed part is one object named by its code and placed as on the plate. Supports are
    left to the slicer. A multi-material part is one object with a component per material."""
    resources, build = [], []
    if materials:
        bases = ''.join(f'<base name={quoteattr(name)} displaycolor="{colour}FF"/>' for name, colour in zip(materials, TOWER_COLOURS))
        resources.append(f'<basematerials id="1">{bases}</basematerials>')
    next_id = 2
    for part in objects:
        meshes = []
        for slot, (label, name) in enumerate(object_names(part).items()):
            colour = f' pid="1" pindex="{slot}"' if materials else ''
            resources.append(f'<object id="{next_id}" type="model" name={quoteattr(name)}{colour}>{_mesh_xml(folder / label)}</object>')
            meshes.append(next_id)
            next_id += 1
        target = meshes[0]
        if len(meshes) > 1:
            components = ''.join(f'<component objectid="{ident}"/>' for ident in meshes)
            resources.append(f'<object id="{next_id}" type="model" name={quoteattr(part["code"])}><components>{components}</components></object>')
            target = next_id
            next_id += 1
        x, y, z = _plate_offset(part)
        build.append(f'<item objectid="{target}" partnumber={quoteattr(part["instanceId"])} transform="1 0 0 0 1 0 0 0 1 {x:.9g} {y:.9g} {z:.9g}"/>')
    model = (f'<?xml version="1.0" encoding="UTF-8"?>\n<model unit="millimeter" xml:lang="en-US" xmlns="{CORE}">\n'
             f'<metadata name="Title">{escape(f"Plate {plate}")}</metadata>\n'
             '<metadata name="Application">Plateway</metadata>\n'
             f'<resources>\n{chr(10).join(resources)}\n</resources>\n<build>\n{chr(10).join(build)}\n</build>\n</model>\n')
    with zipfile.ZipFile(path, 'w', zipfile.ZIP_DEFLATED) as archive:
        archive.writestr('[Content_Types].xml', CONTENT_TYPES)
        archive.writestr('_rels/.rels', RELATIONSHIPS)
        archive.writestr('3D/3dmodel.model', model)
    with zipfile.ZipFile(path) as archive:
        written = ET.fromstring(archive.read('3D/3dmodel.model'))
    names = {item.get('id'): item.get('name') for item in written.iter(f'{{{CORE}}}object')}
    if Counter(names[item.get('objectid')] for item in written.iter(f'{{{CORE}}}item')) != Counter(part['code'] for part in objects):
        raise ValueError('Plain 3MF does not place each coded part exactly once')


def _finalize_project(path: Path, overrides: dict[str, str], objects: list[dict],
                      enforcers: dict[str, tuple[np.ndarray, int]], bed: tuple[float, float] | None = None) -> None:
    """Preserve process edits and the checked shelf plan, not CLI auto-placement, paint support enforcers
    (label → (part-to-print matrix, expected painted triangles)) and name each object by its code."""
    rewritten = path.with_suffix('.tmp')
    core = 'http://schemas.microsoft.com/3dmanufacturing/core/2015/02'
    production = 'http://schemas.microsoft.com/3dmanufacturing/production/2015/06'
    ET.register_namespace('', core)
    ET.register_namespace('p', production)
    with zipfile.ZipFile(path) as source, zipfile.ZipFile(rewritten, 'w') as target:
        config = json.loads(source.read('Metadata/project_settings.config'))
        different = config.setdefault(
            'different_settings_to_system', [''] * (len(config['filament_settings_id']) + 2))
        keys = set(filter(None, different[0].split(';'))) | overrides.keys()
        different[0] = ';'.join(sorted(keys))
        if bed:
            _multi_filament(config, *bed)
        settings = ET.fromstring(source.read('Metadata/model_settings.config'))
        model = ET.fromstring(source.read('3D/3dmodel.model'))
        labels = {obj.get('id'): next((meta.get('value') for meta in obj.findall('metadata')
                  if meta.get('key') == 'name'), None) for obj in settings.findall('object')}
        # A multi-material part is one object per material, all placed as the part.
        by_label = {label: item for item in objects for label in item.get('materialLabels', [item['plateLabel']])}
        build = model.find(f'{{{core}}}build')
        if build is None or Counter(labels.get(item.get('objectid')) for item in build) != Counter(by_label.keys()):
            raise ValueError('3MF build does not reconcile with the planned plate')
        for item in build:
            x, y, z = _plate_offset(by_label[labels[item.get('objectid')]])
            item.set('transform', f'1 0 0 0 1 0 0 0 1 {x:.9g} {y:.9g} {z:.9g}')
        meshes: dict[str, str] = {}
        resources = {obj.get('id'): obj for obj in model.iter(f'{{{core}}}object')}
        for item in build:
            label = labels[item.get('objectid')]
            if label not in enforcers:
                continue
            print_matrix, expected = enforcers[label]
            components = resources[item.get('objectid')].findall(f'.//{{{core}}}component')
            if len(components) != 1:
                raise ValueError('3MF object must reference exactly one mesh to paint supports')
            component = components[0]
            name = component.get(f'{{{production}}}path', '').lstrip('/')
            transform = np.array([float(v) for v in component.get('transform', '1 0 0 0 1 0 0 0 1 0 0 0').split()]).reshape(4, 3)
            text = meshes.get(name) or source.read(name).decode()
            meshes[name], painted = _paint_object(text, component.get('objectid'), transform,
                                                  by_label[label], print_matrix)
            if painted != expected:
                raise ValueError('3MF mesh does not reconcile with the planned support enforcers')
        # The slicer lists objects (and their single volume) by these names; source_file keeps the plate file.
        names = {label: name for item in objects for label, name in object_names(item).items()}
        for obj in settings.findall('object'):
            label = labels[obj.get('id')]
            for meta in (*obj.findall('metadata'), *obj.findall('part/metadata')):
                if meta.get('key') == 'name' and meta.get('value') == label:
                    meta.set('value', names[label])
        plates = settings.findall('plate')
        if not plates:
            raise ValueError('3MF has no plate metadata')
        # Membership follows our build transforms; import-time membership can
        # omit objects whose original CAD coordinates lie outside the bed.
        for plate in plates[1:]:
            settings.remove(plate)
        for instance in plates[0].findall('model_instance'):
            plates[0].remove(instance)
        for index, item in enumerate(build, 1):
            instance = ET.SubElement(plates[0], 'model_instance')
            for key, value in (('object_id', item.get('objectid')), ('instance_id', '0'), ('identify_id', str(index))):
                ET.SubElement(instance, 'metadata', key=key, value=value)
        replacements = {
            'Metadata/project_settings.config': json.dumps(config, indent=2).encode(),
            'Metadata/model_settings.config': ET.tostring(settings, encoding='utf-8', xml_declaration=True),
            '3D/3dmodel.model': ET.tostring(model, encoding='utf-8', xml_declaration=True),
            **{name: text.encode() for name, text in meshes.items()},
        }
        for entry in source.infolist():
            data = replacements[entry.filename] if entry.filename in replacements else source.read(entry.filename)
            target.writestr(entry, data)
    rewritten.replace(path)


def _verify_project(path: Path, expected: list[str], presets: dict, printer: dict,
                    supports_enabled: bool, process_overrides: dict[str, str], filaments: list[str] | None = None) -> None:
    with zipfile.ZipFile(path) as archive:
        config = json.loads(archive.read('Metadata/project_settings.config'))
        settings = ET.fromstring(archive.read('Metadata/model_settings.config'))
    required = {'printer_model': MACHINE_NAMES[printer['name']], 'printer_settings_id': presets['machine'],
                'print_settings_id': printer['profile'], 'filament_settings_id': filaments or [presets['filamentName']],
                'nozzle_diameter': [str(printer['nozzleMm'])],
                'printable_area': presets['machineConfig']['printable_area'],
                'printable_height': presets['machineConfig']['printable_height'], **process_overrides}
    if any(config.get(key) != value for key, value in required.items()) or config.get('enable_support') != ('1' if supports_enabled else '0'):
        raise ValueError('Exported 3MF does not contain selected machine/process/filament/nozzle/support settings')
    preserved = set(config.get('different_settings_to_system', [''])[0].split(';'))
    if not process_overrides.keys() <= preserved:
        raise ValueError('Exported 3MF would discard process overrides when opened in Bambu Studio')
    names = [node.attrib['value'] for node in settings.findall('./object/metadata[@key="name"]')]
    if Counter(names) != Counter(expected):
        raise ValueError('3MF does not name each printed part by its code exactly once')
    instance_ids = settings.findall('./plate/model_instance')
    if len(settings.findall('./plate')) != 1 or len(instance_ids) != len(expected):
        raise ValueError('3MF plate instance count does not match labelled parts')


def export_plates(parts: list[dict], printer: dict, output: Path, progress: Progress = no_progress) -> list[dict]:
    """Return receipts only after inspecting each exported project and actual sliced G-code.

    Fast-print track plates use the printer's fast process; every other plate uses
    the chosen process. LED-channel track plates load the translucent filament."""
    presets = select_presets(printer)
    styles = {'detailed': (printer, presets)}
    if any(plate_process(plate_style(part)) == 'fast' for part in parts):
        fast = {**printer, 'profile': fast_process(printer)}
        styles['fast'] = (fast, select_presets(fast))
    for clear in sorted({style for style in map(plate_style, parts) if style.startswith('clear')}):
        chosen = {**styles[plate_process(clear)][0], 'material': CLEAR_MATERIAL}
        styles[clear] = (chosen, select_presets(chosen))
    spine = None
    if any(plate_style(part).startswith('flex') for part in parts):
        spine_name = f"{flex_track.SPINE_MATERIAL} @BBL {presets['filamentName'].rsplit(' @BBL ', 1)[1]}"
        spine_config = _bundled('filament', spine_name, f"Bambu Studio has no {flex_track.SPINE_MATERIAL} profile for the {printer['name']}.")
        if presets['machine'] not in spine_config.get('compatible_printers', []):
            raise UserError(f"{flex_track.SPINE_MATERIAL} doesn’t work with the {printer['name']} and a {printer['nozzleMm']:g} mm nozzle.")
        spine = (spine_name, spine_config)
    progress('arrange', 0, 1)
    prepared: dict[str, tuple[trimesh.Trimesh, np.ndarray, int]] = {}
    for part in parts:
        size = part['bounds']['size']
        if part.get('family') in (composite.FAMILY, flex_track.FAMILY):
            width, depth, _ = ENVELOPES[printer['name']]
            if size[0] + 14 > width or size[1] + 14 > depth:
                raise UserError(f"Track piece {part['instanceId']} is {size[0]:.0f} x {size[1]:.0f} mm, "
                                f"larger than the {printer['name']} bed; split it into bed-sized pieces first.")
        yaw = 0. if _side_on(part) else _print_yaw(part)
        part['printOrientation'] = ('side-on-bed' if _side_on(part) else 'end-on-bed' if _end_on(part)
                                    else 'rotated-flat' if yaw else 'as-authored-flat')
        part['printBounds'] = ({'size': [size[0], size[2], size[1]]} if part['printOrientation'] == 'side-on-bed' else
                               {'size': [size[2], size[1], size[0]]} if part['printOrientation'] == 'end-on-bed' else part['bounds'])
        mesh = trimesh.load_mesh(part['meshPath'], force='mesh', process=False)
        if yaw:
            part['printYaw'] = yaw
        print_matrix = _print_matrix(part, mesh)
        if part['printOrientation'] != 'as-authored-flat':
            mesh.apply_transform(print_matrix)
        if yaw:
            part['printBounds'] = {'size': [float(v) for v in mesh.extents]}
        # A multi-material part's supports are painted on its first (project filament) object.
        painting = trimesh.load_mesh(part['materials'][0]['meshPath'], force='mesh', process=False) if part.get('materials') else mesh
        painted = int(_enforced_mask(part, np.asarray(painting.vertices), np.asarray(painting.faces), print_matrix).sum())
        if not painted and part.get('family') in SHARED_END_FAMILIES | SCENIC_TRACK.keys() | {'brick_end_coupon', composite.FAMILY, flex_track.FAMILY} and _end_frames(part):
            raise ValueError(f'No connector overhang found to support on {part["instanceId"]}')
        prepared[part['instanceId']] = (mesh, print_matrix, painted)
    plans = arrange(parts, printer, presets, frozenset(ident for ident, row in prepared.items() if row[2]))
    results = []
    for index, objects in enumerate(plans, 1):
        progress('slice', index - 1, len(plans))
        style = plate_style(objects[0])
        plate_printer, plate_presets = styles[style if style.startswith('clear') else plate_process(style)]
        colour = marker_colour(objects[0]['parameters']['marker']) if style.startswith('marker-') else None
        folder = output / f'plate-{index:02d}'
        folder.mkdir(mode=0o700)
        inputs, filament_ids = [], []
        enforcers: dict[str, tuple[np.ndarray, int]] = {}
        for item in objects:
            # The part's file is named by its code and name ("1A-left-turnout-base-1-of-5.stl"); codes are unique.
            name = re.sub(r'[^a-z0-9]+', '-', item['name'].lower()).strip('-')[:48]
            label = f"{item['code']}-{name}.stl"
            target = folder / label
            mesh, print_matrix, painted = prepared[item['instanceId']]
            if item['printOrientation'] != 'as-authored-flat':
                mesh.export(target)
            else:
                shutil.copyfile(item['materials'][0]['meshPath'] if item.get('materials') else item['meshPath'], target)
            if painted:
                enforcers[label] = (print_matrix, painted)
            item['printMesh'] = str(target.relative_to(output))
            item['printDigest'] = hashlib.sha256(target.read_bytes()).hexdigest()
            item['plateLabel'] = label
            item['plate'] = index
            inputs.append(target)
            filament_ids.append(1)
            if item.get('materials'):
                if [material['filament'] for material in item['materials']] != [1, 2]:
                    raise ValueError('A multi-material part is its project-filament body then its TPU spine')
                extra = folder / f"{label[:-4]}-{item['materials'][1]['role']}.stl"
                shutil.copyfile(item['materials'][1]['meshPath'], extra)
                item['materialLabels'] = [label, extra.name]
                inputs.append(extra)
                filament_ids.append(2)
        model = folder / f'plate-{index:02d}.3mf'
        write_core_3mf(model, folder, objects, index, [name.split(' @BBL ')[0] for name in (
            plate_presets['filamentName'], spine[0])] if style.startswith('flex') else None)
        supports_enabled = bool(enforcers)
        process_path = folder / 'resolved-process.json'
        process_override = None
        process_overrides = {}
        if supports_enabled:
            process_override = folder / 'supported-process.json'
            process = dict(plate_presets['processConfig'])
            process_overrides.update(SUPPORT_OVERRIDES)
            if any(_end_frames(item) for item in objects):
                process_overrides['brim_type'] = 'no_brim'
            process.update(process_overrides)
            process_override.write_text(json.dumps(process, sort_keys=True, indent=2) + '\n')
            process_path = process_override
        else:
            process_path.write_text(json.dumps(plate_presets['processConfig'], sort_keys=True, indent=2) + '\n')
        machine_path, filament_path = folder / 'resolved-machine.json', folder / 'resolved-filament.json'
        machine_path.write_text(json.dumps(plate_presets['machineConfig'], sort_keys=True, indent=2) + '\n')
        filament = dict(plate_presets['filamentConfig'])
        if colour:
            filament['filament_colour'] = [colour[1]]
        filament_path.write_text(json.dumps(filament, sort_keys=True, indent=2) + '\n')
        settings = [str(machine_path), str(process_path)]
        common = ['--load-settings', ';'.join(settings), '--load-filaments', str(filament_path)]
        multi = style.startswith('flex')
        names = [name for item in objects for name in object_names(item).values()]
        if multi:
            spine_path = folder / 'resolved-spine-filament.json'
            spine_path.write_text(json.dumps(spine[1], sort_keys=True, indent=2) + '\n')
            common = ['--load-settings', ';'.join(settings), '--load-filaments', f'{filament_path};{spine_path}',
                      '--load-filament-ids', ','.join(map(str, filament_ids))]
        _cli([*common, '--arrange', '0', '--orient', '0', '--export-3mf', 'project.3mf', '--outputdir', str(folder),
              *(str(p) for p in inputs)], folder, index)
        project = folder / 'project.3mf'
        if not project.is_file():
            raise ValueError('Bambu Studio did not export a 3MF project')
        _finalize_project(project, process_overrides, objects, enforcers,
                          ENVELOPES[printer['name']][:2] if multi else None)
        _verify_project(project, names, plate_presets, plate_printer, supports_enabled, process_overrides,
                        [plate_presets['filamentName'], spine[0]] if multi else None)
        # The preview is drawn from the plate's own meshes, as placed, so no slicer rendering is needed.
        thumbnail = folder / 'thumbnail.png'
        plate_thumbnail(thumbnail, [[trimesh.load_mesh(folder / label, force='mesh', process=False).apply_translation(
            _plate_offset(item)) for label in object_names(item)] for item in objects])
        # Reopen the delivered archive, without masking missing settings with the source presets.
        slice_receipt = _cli(['--slice', '1', '--arrange', '0', '--orient', '0',
                              '--outputdir', str(folder), str(project)], folder, index)
        slices = slice_receipt.get('sliced_plates', [])
        if len(slices) == 1 and slices[0].get('warning_message'):
            log.error('Bambu Studio warned on plate %s: %s', index, slices[0]['warning_message'])
            raise UserError(f'Bambu Studio reported a problem on plate {index}. See the service log.')
        if len(slices) != 1 or Counter(obj.get('name') for obj in slices[0].get('objects', [])) != Counter(names):
            raise ValueError('Slice receipt does not reconcile every labelled plate object')
        gcode = folder / 'plate_1.gcode'
        if not gcode.is_file() or gcode.stat().st_size == 0:
            raise ValueError('Bambu Studio did not produce sliced G-code')
        if multi:
            used = {row.get('id'): row.get('total_used_g', 0) for row in slices[0].get('filaments', [])}
            text = gcode.read_text()
            if not (used.get(1, 0) > 0 and used.get(2, 0) > 0) or not re.search(r'^M620 S1A', text, re.M) or (
                    f'; filament_settings_id = "{plate_presets["filamentName"]}";"{spine[0]}"' not in text):
                raise ValueError('Multi-material G-code does not print both filaments')
        for obj in slices[0]['objects']:
            box = obj['bbox']
            if box['x'] < 0 or box['y'] < 0 or box['z'] < -0.01 or box['x'] + box['width'] > printer['envelope']['x'] + .01 or box['y'] + box['depth'] > printer['envelope']['y'] + .01 or box['z'] + box['height'] > printer['envelope']['z'] + .01 or _rect_intersects_polygon(box['x'], box['y'], box['width'], box['depth'], presets['exclusion']):
                raise ValueError('Slicer placed object outside machine bed or within exclusion')
        results.append({'plate': index, 'model': str(model.relative_to(output)),
                        'project': str(project.relative_to(output)), 'gcode': str(gcode.relative_to(output)),
                        'objects': [{'instanceId': i['instanceId'], 'label': i['plateLabel'],
                                     **({'materialLabels': i['materialLabels']} if 'materialLabels' in i else {})} for i in objects],
                        'process': plate_printer['profile'], 'supportsEnabled': supports_enabled,
                        **({'filamentColour': colour[0]} if colour else {}),
                        **({'filamentColour': CLEAR, 'filament': plate_printer['material']} if style.startswith('clear') else {}),
                        **({'filaments': [plate_presets['filamentName'], spine[0]]} if multi else {}),
                        'processOverride': str(process_override.relative_to(output)) if process_override else None,
                        'slice': slices[0], 'gcodeSha256': hashlib.sha256(gcode.read_bytes()).hexdigest(),
                        'thumbnail': thumbnail.relative_to(output).as_posix()})
    return results
