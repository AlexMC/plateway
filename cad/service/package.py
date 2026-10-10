"""Layout-revision-bound CAD package transactions under a selected export root."""

from __future__ import annotations

from collections import Counter
from collections.abc import Callable, Collection, Iterable, Iterator
from contextlib import contextmanager
import ctypes
import errno
import hashlib
import json
import math
import os
from pathlib import Path
import re
import shutil
import stat
import sys
import uuid

from cad.library.check import LIBRARY_ID, PIECE_BYTES
from cad.models import composite, flex_track, helix_column, brick_end, rack, road, track_bracket, track_power
from cad.service.assemblies import expand_components, module_for, primary_ports, validate_assembly
from cad.service.errors import UserError
from cad.service.generate import DIGEST, current_request_digest, generate_part, mesh_part, mesh_ports
from cad.service.hardware import guide_section, manifest_pieces, shopping_list
from cad.service.labels import label_parts
from cad.service.plates import Progress, export_plates, marker_colour, no_progress, select_presets
from cad.service.storage import INDEX_FORMAT, INDEX_KEY, MissingObject, Reader, check_key
from cad.service import guide_pdf

INSTANCE_ID = re.compile(r'[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}\Z')

IDENTITY = re.compile(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,79}\Z')
# Base id plus an optional -<8 hex fingerprint>[-<6 hex>] suffix for rebuilt packages.
PACKAGE_ID = re.compile(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,119}\Z')
VARIANT = re.compile(r'-[0-9a-f]{8}(-[0-9a-f]{6})?\Z')
ARTIFACT = re.compile(r'[A-Za-z0-9_.-]+\Z')
# Loose printed parts placed on or beside a track piece: they carry no ports.
ACCESSORY_FAMILIES = {composite.INSERT_FAMILY, road.FAMILY, helix_column.FAMILY, track_bracket.FAMILY, rack.FAMILY}
# Community pieces one manifest may use (KTD9): distinct library items, not pieces.
MAX_LIBRARY_ITEMS = 200
PRINTS_AS_UPLOADED = 'Community pieces print as uploaded: print style and fit adjustment don’t apply to them.'


def _revision(value: object) -> str:
    if not isinstance(value, str) or not IDENTITY.fullmatch(value) or '..' in value:
        raise ValueError('Invalid revision or instance identity')
    return value

def _instance_id(value: object) -> str:
    if not isinstance(value, str) or not INSTANCE_ID.fullmatch(value) or '..' in value:
        raise ValueError('Invalid fitted instance identity')
    return value


def _uuid(value: object) -> str:
    try:
        if not isinstance(value, str) or str(uuid.UUID(value)) != value:
            raise ValueError('Project identity must be a canonical UUID')
    except (TypeError, ValueError) as exc:
        raise ValueError('Project identity must be a canonical UUID') from exc
    return value


def _dict(value: object, fields: set[str], label: str) -> dict:
    if not isinstance(value, dict) or set(value) != fields:
        raise ValueError(f'{label} requires exactly {sorted(fields)}')
    return value


def _rail_top(part: dict) -> float:
    if part['interfaceKind'] == 'track-assembly':
        return brick_end.RAIL_TOP
    parameters = part['parameters']
    thickness = parameters.get('deck_thickness' if part['family'].startswith('bridge_')
                               else 'base_thickness')
    height = parameters.get('rail_height')
    if any(type(value) not in (int, float) or not math.isfinite(value)
           for value in (thickness, height)):
        raise ValueError('Printed rail running-surface dimensions are missing')
    return thickness + height


def library_refs(manifest: dict) -> dict[str, dict]:
    """The community pieces a manifest uses (KTD9), by library id: `{id, version, digest}`, the item's version and the
    sha256 of the file the app loaded. Each is fetched from the library and checked against `digest` before use."""
    value = manifest.get('library', [])
    if not isinstance(value, list) or len(value) > MAX_LIBRARY_ITEMS:
        raise ValueError('Invalid community piece references')
    refs: dict[str, dict] = {}
    for ref in value:
        ref = _dict(ref, {'id', 'version', 'digest'}, 'community piece')
        if (not isinstance(ref['id'], str) or not LIBRARY_ID.fullmatch(ref['id']) or ref['id'] in refs or
                type(ref['version']) is not int or ref['version'] < 1 or
                not isinstance(ref['digest'], str) or not DIGEST.fullmatch(ref['digest'])):
            raise ValueError('Invalid community piece reference')
        refs[ref['id']] = ref
    return refs


def validate_manifest(manifest: object) -> tuple[str, list[dict]]:
    fields = {'version', 'units', 'project', 'printer', 'mounting', 'routes',
              'crossings', 'cars', 'instances', 'requiredPrintedInstanceIds',
              'billOfMaterials', 'mountingSiteChecks', 'warnings'}
    # `devices` (automation export), `room` and `pieceNames` (the guide's overview and part names) and `library` (the
    # community pieces it uses) are optional so earlier manifests validate.
    optional = {'devices', 'room', 'pieceNames', 'library'}
    m = _dict(manifest, fields | (optional & set(manifest) if isinstance(manifest, dict) else set()), 'manifest')
    if type(m['version']) is not int or m['version'] != 1 or m['units'] != 'mm':
        raise ValueError('Unsupported millimetre-only manifest version')
    project = _dict(m['project'], {'id', 'revision', 'layoutRevision', 'name'}, 'project')
    _uuid(project['id'])
    _uuid(project['revision'])
    _uuid(project['layoutRevision'])
    if not isinstance(project['name'], str) or not project['name'].strip():
        raise UserError('Give the project a name before preparing plates.')
    select_presets(m['printer'])
    if m['mounting'] not in ('reversible', 'anchored'):
        raise ValueError('Invalid mounting')
    for label in ('mountingSiteChecks', 'warnings'):
        if not isinstance(m[label], list) or not all(isinstance(v, str) for v in m[label]):
            raise ValueError(f'{label} requires strings')
    routes, crossings = m['routes'], m['crossings']
    if not isinstance(routes, list) or not routes or not isinstance(crossings, list):
        raise ValueError('Layout requires at least one route and a crossings list')
    route_ids = set()
    for route in routes:
        if not isinstance(route, dict) or not isinstance(route.get('points'), list) or len(route['points']) < 2:
            raise ValueError('Routes require points')
        route_id = _revision(route.get('id'))
        if route_id in route_ids:
            raise ValueError('Duplicate route identity')
        route_ids.add(route_id)
    if 'devices' in m:
        _validate_devices(m['devices'], route_ids)
    if 'room' in m:
        _validate_room(m['room'])
    if 'pieceNames' in m and (not isinstance(m['pieceNames'], dict) or len(m['pieceNames']) > 5000 or not all(
            isinstance(key, str) and INSTANCE_ID.fullmatch(key) and isinstance(value, str) and DEVICE_TEXT.fullmatch(value)
            for key, value in m['pieceNames'].items())):
        raise ValueError('Invalid piece names')
    for crossing in crossings:
        if not isinstance(crossing, dict) or crossing.get('upperRouteId') not in route_ids or crossing.get('lowerRouteId') not in route_ids:
            # A route passing over itself (a helix, a figure eight) has the same upper and lower route.
            raise ValueError('Crossing references unknown routes')
    if not isinstance(m['cars'], list):
        raise ValueError('Cars list required')
    library = library_refs(m)
    instances = m['instances']
    if not isinstance(instances, list) or not instances:
        raise ValueError('Package needs fitted instances')
    ids = set()
    printed = []
    used = set()
    base = {'id', 'routeId', 'sectionId', 'family', 'parameters', 'pose', 'interfaceKind',
            'status', 'source', 'geometryAvailable', 'quantity'}
    for instance in instances:
        kind = instance.get('interfaceKind') if isinstance(instance, dict) else None
        extra = ({'startPort', 'endPort'} if kind == 'rail' else {'mountingSeat'} if kind == 'mounting'
                 else {'ports', 'paths'} if kind == 'track-assembly' else set())
        if kind not in ('rail', 'mounting', 'connector', 'track-assembly', 'accessory'):
            raise ValueError('Instance needs an explicit physical interface')
        _dict(instance, base | extra, 'instance')
        ident = _instance_id(instance['id'])
        if ident in ids or instance['routeId'] not in route_ids or not isinstance(instance['sectionId'], str):
            raise ValueError('Duplicate instance or unknown route/section')
        ids.add(ident)
        if type(instance['quantity']) is not int or instance['quantity'] != 1:
            raise ValueError('Every fitted instance requires quantity one')
        if instance['source'] not in ('printed', 'owned') or type(instance['geometryAvailable']) is not bool:
            raise ValueError('Invalid instance source or CAD availability')
        if instance['status'] not in ('unverified', 'fit-tested', 'run-tested'):
            raise ValueError('Invalid instance fit status')
        if not isinstance(instance['parameters'], dict):
            raise ValueError('Instance CAD parameters required')
        community = isinstance(instance['family'], str) and instance['family'] in library
        if community:
            # A community piece prints as uploaded (R20): one printed rail, no parameters (no style, no fit adjustment).
            if kind != 'rail' or instance['source'] != 'printed' or instance['parameters']:
                raise ValueError('A community piece is one printed rail without parameters')
            used.add(instance['family'])
        elif isinstance(instance['family'], str) and LIBRARY_ID.fullmatch(instance['family']):
            raise ValueError('A community piece needs its library reference')
        for key in ('pose',):
            pose = _dict(instance[key], {'x', 'y', 'z', 'heading', 'pitch'}, key)
            if any(type(v) not in (int, float) or not math.isfinite(v) for v in pose.values()):
                raise ValueError('Instance pose must be finite')
        if kind == 'rail':
            for key in ('startPort', 'endPort'):
                port = _dict(instance[key], {'pose', 'profile', 'railGauge', 'interfaceWidth'}, key)
                if port['profile'] != 'brick':
                    raise ValueError('Unsupported port profile')
                if any(value is not None and (type(value) not in (int, float) or not math.isfinite(value)) for value in (port['railGauge'], port['interfaceWidth'])):
                    raise ValueError('Port dimensions must be finite')
                port_pose = _dict(port['pose'], {'x', 'y', 'z', 'heading', 'pitch'}, 'port pose')
                if any(type(v) not in (int, float) or not math.isfinite(v) for v in port_pose.values()):
                    raise ValueError('Port pose must be finite')
        elif kind == 'track-assembly':
            validate_assembly(instance)
        elif kind == 'mounting':
            if instance['source'] != 'printed' or instance['family'] not in ('reversible_column', 'anchored_bracket', 'layout_riser'):
                raise ValueError('Only printed structural supports have mounting seats')
            seat = _dict(instance['mountingSeat'], {'x', 'y', 'z', 'heading', 'pitch'}, 'mounting seat')
            if any(type(v) not in (int, float) or not math.isfinite(v) for v in seat.values()):
                raise ValueError('Mounting seat must be finite')
        elif kind == 'accessory':
            if instance['source'] != 'printed' or instance['family'] not in ACCESSORY_FAMILIES:
                raise ValueError('Only printed marker inserts and road tiles are loose accessories')
        elif instance['source'] != 'printed' or instance['family'] != 'connector_joiner':
            raise ValueError('Connector joiner must be an authored printed part')
        if instance['source'] == 'printed':
            if not instance['geometryAvailable']:
                raise ValueError(f'Printed instance lacks CAD: {ident}')
            printed.append(instance)
    if used != set(library):
        raise ValueError('A community piece reference is not used')
    expected = m['requiredPrintedInstanceIds']
    socketed = {'printed_straight', 'printed_curve', 'vertical_transition', 'bridge_deck'}
    joints = {item['id']: item for item in instances if item['interfaceKind'] == 'connector'}
    needed_joints = set()
    for route_id in route_ids:
        rails = [item for item in instances if item['interfaceKind'] in ('rail', 'track-assembly') and item['routeId'] == route_id]
        for index in range(1, len(rails)):
            before, after = rails[index - 1], rails[index]
            end, start = primary_ports(before)[1], primary_ports(after)[0]
            p, q = end['pose'], start['pose']
            angle = math.atan2(math.sin(p['heading'] - q['heading']), math.cos(p['heading'] - q['heading']))
            if (math.dist((p['x'], p['y'], p['z']), (q['x'], q['y'], q['z'])) > .01 or
                    abs(angle) > .01 or abs(p['pitch'] - q['pitch']) > .01 or
                    end['profile'] != start['profile'] or end['railGauge'] != start['railGauge'] or
                    end['interfaceWidth'] != start['interfaceWidth']):
                raise ValueError('Adjacent fitted rail ports are discontinuous')
            # A community piece's marked ends are shared brick ends; its rail height is its mesh's own (R20).
            before_community, after_community = before['family'] in library, after['family'] in library
            community = before_community or after_community
            before_shared = (before['source'] == 'owned' or before['parameters'].get('connector_version') == 1
                             or before_community)
            after_shared = (after['source'] == 'owned' or after['parameters'].get('connector_version') == 1
                            or after_community)
            if before['source'] != after['source'] and not (before_shared and after_shared):
                raise ValueError('Printed rail does not use the selected brick track interface')
            if before['source'] == after['source'] == 'printed' and not community:
                if abs(_rail_top(before) - _rail_top(after)) > .01:
                    raise ValueError('Adjacent fitted rails have a running-surface height step')
            if before['parameters'].get('connector_version') or after['parameters'].get('connector_version') or community:
                if not (before_shared and after_shared):
                    raise ValueError('Shared track ends cannot mate with custom joiner sockets')
                if before['source'] == after['source'] == 'printed' and not community and (
                        before['parameters'].get('fit_adjustment') != after['parameters'].get('fit_adjustment')):
                    raise ValueError('Adjacent shared connectors use different fit adjustments')
                continue
            if 'bridge_joint' in (before['family'], after['family']):
                other = after if before['family'] == 'bridge_joint' else before
                if other['family'] not in socketed or any(
                    before['parameters'].get(key) != after['parameters'].get(key)
                    for key in ('joint_width', 'joint_depth', 'joint_height', 'joint_clearance')
                ):
                    raise ValueError('Bridge joint tongue does not match an adjacent rail socket')
                continue
            if before['family'] not in socketed or after['family'] not in socketed:
                continue
            ident = f'{route_id}:joiner:{index}'
            needed_joints.add(ident)
            joint = joints.get(ident)
            dims = ('joint_width', 'joint_depth', 'joint_height', 'joint_clearance')
            if (joint is None or joint['sectionId'] != before['sectionId'] or
                    any(type(joint['parameters'].get(key)) not in (int, float) or
                        not math.isfinite(joint['parameters'][key]) or
                        joint['parameters'][key] != before['parameters'].get(key) or
                        joint['parameters'][key] != after['parameters'].get(key) for key in dims)):
                raise ValueError('A printed rail seam lacks its dimension-matched joiner')
            insertion = joint['parameters']['joint_depth'] - joint['parameters']['joint_clearance']
            pose = joint['pose']
            if (insertion <= 0 or
                    math.dist((pose['x'], pose['y'], pose['z']),
                              (p['x'] - insertion * math.cos(p['heading']) * math.cos(p['pitch']),
                               p['y'] - insertion * math.sin(p['heading']) * math.cos(p['pitch']),
                               p['z'] - insertion * math.sin(p['pitch']))) > .1 or
                    abs(math.atan2(math.sin(pose['heading'] - p['heading']),
                                   math.cos(pose['heading'] - p['heading']))) > .001 or
                    abs(pose['pitch'] - p['pitch']) > .001):
                raise ValueError('Printed joiner pose does not bridge the fitted rail seam')
    if set(joints) != needed_joints:
        raise ValueError('Fitted connector bill contains an orphan or missing joiner')
    if not isinstance(expected, list) or len(expected) != len(printed) or len(set(expected)) != len(expected) or set(expected) != {p['id'] for p in printed}:
        raise ValueError('Required printed instance IDs do not reconcile')
    bom = m['billOfMaterials']
    if not isinstance(bom, list):
        raise ValueError('Bill of materials required')
    grouped = Counter((p['source'], p['family'], p['id']) for p in instances)
    listed = Counter()
    for row in bom:
        row = _dict(row, {'family', 'source', 'count', 'instanceIds'}, 'BOM row')
        if row['source'] not in ('printed', 'owned') or not isinstance(row['instanceIds'], list) or type(row['count']) is not int or row['count'] != len(row['instanceIds']):
            raise ValueError('Invalid BOM count')
        listed.update((row['source'], row['family'], ident) for ident in row['instanceIds'])
    if not printed:
        raise UserError('Add at least one printed piece before preparing plates.')
    if listed != grouped:
        raise ValueError('BOM or printed instances incomplete')
    return f"{project['id']}-{project['layoutRevision']}", printed


DEVICE_KINDS = ('turnout', 'mechanism', 'uncoupler', 'colour-marker')
# Device labels and controls go into the assembly guide's table: one line, no table pipes.
DEVICE_TEXT = re.compile(r'[^|\r\n]{1,120}\Z')


def _validate_devices(devices: object, route_ids: set[str]) -> None:
    """The automation export: controllable devices by piece or marker-part id."""
    if not isinstance(devices, list):
        raise ValueError('devices requires a list')
    seen = set()
    for device in devices:
        d = _dict(device, {'id', 'kind', 'family', 'label', 'control', 'states', 'state', 'routeId', 'x', 'y', 'colourId'}, 'device')
        if _instance_id(d['id']) in seen:
            raise ValueError('Duplicate device identity')
        seen.add(d['id'])
        if d['kind'] not in DEVICE_KINDS or d['routeId'] not in route_ids:
            raise ValueError('Invalid device kind or route')
        if not all(isinstance(d[key], str) and DEVICE_TEXT.fullmatch(d[key]) for key in ('family', 'label', 'control')):
            raise ValueError('Invalid device text')
        if not isinstance(d['states'], list) or not all(
                isinstance(state, dict) and set(state) == {'id', 'label'} and
                all(isinstance(state[key], str) and DEVICE_TEXT.fullmatch(state[key]) for key in ('id', 'label'))
                for state in d['states']):
            raise ValueError('Invalid device states')
        if d['state'] is not None and d['state'] not in {state['id'] for state in d['states']}:
            raise ValueError('Invalid device state')
        if any(type(d[key]) not in (int, float) or not math.isfinite(d[key]) for key in ('x', 'y')):
            raise ValueError('Invalid device position')
        if (d['colourId'] is None) != (d['kind'] != 'colour-marker') or (
                d['colourId'] is not None and type(d['colourId']) is not int):
            raise ValueError('Invalid device colour')


def _validate_room(room: object) -> None:
    """The room the guide's overview draws: its size (mm, from 0, 0) and each furniture outline in the room frame."""
    r = _dict(room, {'width', 'depth', 'furniture'}, 'room')
    finite = lambda value: type(value) in (int, float) and math.isfinite(value)
    if not all(finite(r[key]) and 0 < r[key] <= 100_000 for key in ('width', 'depth')):
        raise ValueError('Invalid room size')
    if not isinstance(r['furniture'], list) or len(r['furniture']) > 200:
        raise ValueError('Invalid room furniture')
    for item in r['furniture']:
        f = _dict(item, {'label', 'height', 'outline'}, 'furniture')
        if not isinstance(f['label'], str) or not DEVICE_TEXT.fullmatch(f['label']) or not finite(f['height']):
            raise ValueError('Invalid furniture label or height')
        if not isinstance(f['outline'], list) or not 3 <= len(f['outline']) <= 64 or not all(
                finite(_dict(point, {'x', 'y'}, 'outline point')[key]) for point in f['outline'] for key in ('x', 'y')):
            raise ValueError('Invalid furniture outline')


def _device_guide(devices: list[dict], codes: dict[str, str], *, ids: bool = True) -> str:
    """Guide section listing the layout's controllable devices (manifest.json `devices` has the same rows) by their
    piece or part code; `ids` adds the device id a program uses (the markdown guide; the PDF shows codes only)."""
    head = ['Code', *(['Device'] if ids else []), 'Kind', 'Piece', 'Control', 'Settings', 'Position (mm)']
    rows = ['# Automation devices', '',
            'Every servo, motor and colour marker a program can use, by its code in this guide and on its plate'
            + (' and by the id `manifest.json` lists under `devices`' if ids else '; programs use the device ids in '
               'Layout data (manifest.json)') + '. Positions are layout millimetres.', '',
            '| ' + ' | '.join(head) + ' |', '| ' + ' | '.join(['---']*len(head)) + ' |']
    for d in devices:
        settings = (f'Colour sensor {d["colourId"]}' if d['kind'] == 'colour-marker' else
                    ', '.join(f'{state["label"]}{" (set)" if state["id"] == d["state"] else ""}' for state in d['states']))
        cells = [codes.get(d['id'], ''), *([d['id']] if ids else []), d['kind'], d['label'], d['control'], settings,
                 f'{d["x"]:.0f}, {d["y"]:.0f}']
        rows.append('| ' + ' | '.join(cells) + ' |')
    return '\n'.join(rows)


def install_no_replace(root_fd: int, stage: str, final: str) -> None:
    """Kernel-enforced no-replace directory rename: renameatx_np(RENAME_EXCL) on macOS, renameat2(RENAME_NOREPLACE)
    on Linux. Never replaces an existing package, even an empty folder; refuses on any other platform."""
    if sys.platform == 'darwin':
        symbol, flag = 'renameatx_np', 0x4  # RENAME_EXCL
    elif sys.platform.startswith('linux'):
        symbol, flag = 'renameat2', 0x1  # RENAME_NOREPLACE
    else:
        raise OSError(f'No-replace package install is not supported on {sys.platform}')
    rename = getattr(ctypes.CDLL(None, use_errno=True), symbol, None)
    if rename is None:
        raise OSError(f'No-replace package install needs {symbol}, which this C library lacks')
    rename.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    rename.restype = ctypes.c_int
    if rename(root_fd, os.fsencode(stage), root_fd, os.fsencode(final), flag):
        code = ctypes.get_errno()
        if code == errno.EEXIST:
            raise FileExistsError(final)
        raise OSError(code, os.strerror(code), final)


def write_exclusive(directory_fd: int, name: str, data: bytes) -> None:
    fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=directory_fd)
    with os.fdopen(fd, 'wb') as target:
        target.write(data)
        target.flush()
        os.fsync(target.fileno())


@contextmanager
def staged_package(root: Path, name: str) -> Iterator[tuple[Path, int]]:
    """A staging folder (its path and descriptor) to build a package in. When the block ends without an error it is
    installed as `name`, which must not exist yet; otherwise it is removed."""
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    root_fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    stage = f'.incomplete-{uuid.uuid4()}'
    created = False
    try:
        os.mkdir(stage, mode=0o700, dir_fd=root_fd)
        created = True
        stage_fd = os.open(stage, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=root_fd)
        try:
            yield root / stage, stage_fd
            os.fsync(stage_fd)
            install_no_replace(root_fd, stage, name)
            created = False
            os.fsync(root_fd)
        finally:
            os.close(stage_fd)
    finally:
        if created:
            shutil.rmtree(root / stage, ignore_errors=True)
        os.close(root_fd)


def _cad_request(part: dict, printer: dict) -> dict:
    request = {'version': 1, 'units': 'mm', 'family': part['family'], 'parameters': part['parameters'],
               'printer_envelope': printer['envelope'], 'part_revision': part['part_revision'],
               'layout_revision': part['layout_revision']}
    if part.get('library'):
        request['mesh'] = {'version': part['library']['version'], 'digest': part['library']['digest']}
    return request


def cad_requests(parts: list[dict], printer: dict) -> list[dict]:
    """The distinct CAD build requests of these parts: one build each (`_run` reuses a build for equal requests)."""
    return list({json.dumps(request, sort_keys=True, separators=(',', ':'), allow_nan=False): request
                 for request in (_cad_request(part, printer) for part in parts)}.values())


def printed_parts(manifest: dict, instances: list[dict]) -> list[dict]:
    """A validated manifest's printed instances as build parts, before assemblies are expanded: each with the
    layout's revisions, and a community piece with its library reference (`library_refs`)."""
    project, refs = manifest['project'], library_refs(manifest)
    return [{**instance, 'part_revision': project['revision'], 'layout_revision': project['layoutRevision'],
             **({'library': refs[instance['family']]} if instance['family'] in refs else {})} for instance in instances]


class CommunityLibrary:
    """The community meshes one package prints (KTD9), from the library bucket: each item's index entry and STL, the
    file checked against the manifest's digest before use. A retired item still prints; a removed item, or one the
    index doesn't list, is refused. Read only when the package has a community piece, each item once."""

    def __init__(self, bucket: Reader):
        self.bucket = bucket
        self._index: dict[str, dict] | None = None
        self._pieces: dict[str, tuple[bytes, dict]] = {}

    def _entries(self) -> dict[str, dict]:
        if self._index is None:
            try:
                with self.bucket.open(INDEX_KEY) as source:
                    index = json.loads(source.read())
            except MissingObject:
                index = {'format': INDEX_FORMAT, 'items': []}
            if not isinstance(index, dict) or index.get('format') != INDEX_FORMAT or not isinstance(index.get('items'), list):
                raise ValueError('The library index is not in a format this service reads')
            self._index = {item['id']: item for item in index['items'] if isinstance(item, dict) and isinstance(item.get('id'), str)}
        return self._index

    def piece(self, ref: dict, name: str) -> tuple[bytes, dict]:
        """The STL of the community piece `ref` names (`{id, version, digest}`) and its credited library entry
        (`id`, `version`, `digest`, `name`, `licence`, `credit`, `ends`). `name` is the piece as the guide names it."""
        if ref['id'] in self._pieces:
            return self._pieces[ref['id']]
        entry = self._entries().get(ref['id'])
        gone = UserError(f'“{name}” is not in the community library any more. Replace it to prepare this layout.')
        if entry is None or entry.get('kind') != 'piece' or entry.get('state') not in ('live', 'retired'):
            raise gone
        if entry.get('version') != ref['version'] or entry.get('digest') != ref['digest']:
            raise UserError(f'“{name}” changed in the community library since this layout was opened. '
                            'Reload Plateway and prepare again.')
        ends = entry.get('piece', {}).get('ends') if isinstance(entry.get('piece'), dict) else None
        if not isinstance(ends, list) or len(ends) != 2 or not all(
                isinstance(end, dict) and all(type(end.get(key)) in (int, float) and math.isfinite(end[key])
                                              for key in ('x', 'y', 'z', 'heading')) for end in ends):
            raise ValueError(f'The library entry of {ref["id"]} has no marked ends')
        if not all(isinstance(entry.get(key), str) for key in ('name', 'licence', 'credit', 'file')):
            raise ValueError(f'The library entry of {ref["id"]} is incomplete')
        key = check_key(entry['file'])
        if not key.startswith(f'pieces/{ref["id"]}/'):
            raise ValueError(f'The library entry of {ref["id"]} names a file outside its folder')
        try:
            with self.bucket.open(key) as source:
                data = source.read(PIECE_BYTES + 1)
        except MissingObject:
            raise gone from None
        if hashlib.sha256(data).hexdigest() != ref['digest']:
            raise UserError(f'The community library’s file for “{name}” doesn’t match the piece this layout uses, '
                            'so it can’t be printed.')
        credited = {field: entry[field] for field in ('id', 'version', 'digest', 'name', 'licence', 'credit')}
        self._pieces[ref['id']] = data, {**credited, 'ends': [{axis: float(end[axis]) for axis in ('x', 'y', 'z', 'heading')}
                                                              for end in ends]}
        return self._pieces[ref['id']]


def _turn(angle: float) -> float:
    return math.atan2(math.sin(angle), math.cos(angle))


def _mesh_placement(part: dict, ends: list[dict]) -> tuple[dict, list[dict]]:
    """Where a community piece's mesh sits in the layout: the pose that takes its STL's frame there (heading, then
    offset, as an assembly pose places a part), and its marked ends in laying order, the first at the fitted start
    port. The app lays a piece from either end; the fitted ports tell which."""
    start, end = part['startPort']['pose'], part['endPort']['pose']
    for first, last in (ends, ends[::-1]):
        turn = start['heading'] - first['heading'] - math.pi
        c, s = math.cos(turn), math.sin(turn)
        pose = {'x': start['x'] - (c*first['x'] - s*first['y']), 'y': start['y'] - (s*first['x'] + c*first['y']),
                'z': start['z'], 'heading': _turn(turn), 'pitch': 0.}
        x, y = pose['x'] + c*last['x'] - s*last['y'], pose['y'] + s*last['x'] + c*last['y']
        if math.hypot(x - end['x'], y - end['y']) <= .1 and abs(_turn(turn + last['heading'] - end['heading'])) <= .001:
            return pose, [first, last]
    raise ValueError(f'CAD port pose differs from fitted instance {part["id"]}')


def _accessory_guide(receipt_parts: list[dict]) -> str:
    """Guide sections for colour marker inserts, level-crossing road tiles, helix columns, track brackets, 9V/LED track
    and cog bogies."""
    sections = []
    markers = [item for item in receipt_parts if item['family'] == composite.INSERT_FAMILY]
    if markers:
        rows = ['# Colour marker inserts', '',
                'Load each insert’s colour for its plate; press it into its marked sleeper (see Colour markers below).', '',
                '| Insert | Colour | Plate | File |', '| --- | --- | --- | --- |']
        rows.extend(f'| {item["code"]} | {marker_colour(item["parameters"]["marker"])[0]} | '
                    f'{item["plate"]} | {item["plateLabel"]} |' for item in markers)
        sections.append('\n'.join(rows))
    tiles = [item for item in receipt_parts if item['family'] == road.FAMILY]
    if tiles:
        rows = ['# Level-crossing road tiles', '',
                'Set each tile beside its crossing’s street track, on the side listed (see Level crossings below).', '',
                '| Tile | Side | Kind | Plate | File |', '| --- | --- | --- | --- | --- |']
        rows.extend(f'| {item["code"]} | {"left" if item["parameters"]["side"] > 0 else "right"} | '
                    f'{"filler" if item["parameters"]["kind"] else "apron"} | {item["plate"]} | {item["plateLabel"]} |'
                    for item in tiles)
        sections.append('\n'.join(rows))
    tubes = [item for item in receipt_parts if item['family'] == helix_column.FAMILY]
    if tubes:
        rows = ['# Helix columns', '',
                'Each column is a stack: stand its footed tube on the table, thread the lowest lug of the helix onto its '
                'spigot, then each next tube onto the spigot through the lug below it, in this order (see Helix below).', '',
                '| Tube | Column | Foot | Height (mm) | Plate | File |', '| --- | --- | --- | --- | --- | --- |']
        rows.extend(f'| {item["code"]} | {item["instanceId"].split(":")[-2]} | {"yes" if item["parameters"]["foot"] else "no"} | '
                    f'{item["parameters"]["height"]:.1f} | {item["plate"]} | {item["plateLabel"]} |'
                    for item in sorted(tubes, key=lambda item: item['instanceId']))
        sections.append('\n'.join(rows))
    brackets = [item for item in receipt_parts if item['family'] == track_bracket.FAMILY]
    if brackets:
        rows = ['# Track brackets', '',
                'Screw each bracket to the wall (or down on the shelf) under its marked sleeper, at the wall distance '
                'listed, then press the track onto the seat studs (see Wall and shelf brackets below).', '',
                '| Bracket | Kind | Wall to track (mm) | Plate | File |', '| --- | --- | --- | --- | --- |']
        rows.extend(f'| {item["code"]} | {"wall" if item["parameters"]["mount"] == track_bracket.WALL else "shelf"} | '
                    f'{item["parameters"]["reach"]:g} | {item["plate"]} | {item["plateLabel"]} |' for item in brackets)
        sections.append('\n'.join(rows))
    powered = [item for item in receipt_parts if item['family'] == composite.FAMILY
               and (item['parameters'].get('metal') or item['parameters'].get('led'))]
    if powered:
        rows = ['# Metal 9 V rails and LED track (experimental)', '',
                'Print LED track on its Clear-filament plates. Fit the bought parts listed for each piece.', '',
                '| Part | Metal 9 V rails | LED strip | Plate | File |', '| --- | --- | --- | --- | --- |']
        rows.extend(f'| {item["code"]} | {("", "nickel-silver code 250", "copper tape")[int(item["parameters"].get("metal", 0))]} | '
                    f'{f"{track_power.LED_STRIPS[int(led)]:g} mm" if (led := item["parameters"].get("led")) else ""} | '
                    f'{item["plate"]} | {item["plateLabel"]} |' for item in powered)
        for item in powered:
            rows.extend(['', f'## {item["code"]} · {item["name"]}', ''])
            rows.extend(f'- Hardware: {row["quantity"]} × {row["name"]}' for row in track_power.hardware(item['parameters']))
            rows.extend(f'{index}. {note}' for index, note in enumerate(track_power.assembly_notes(item['parameters']), 1))
        sections.append('\n'.join(rows))
    bogies = [item for item in receipt_parts if item['family'] == rack.FAMILY]
    if bogies:
        rows = ['# Cog bogies (experimental)', '',
                'Each bogie is a frame and a cog printed separately. Bought parts per bogie:', '']
        rows.extend(f'- {row["quantity"]} × {row["name"]}' for row in rack.HARDWARE)
        rows.extend(['', *(f'{index}. {note}' for index, note in enumerate(rack.NOTES, 1)), '',
                     '| Part | Piece | Plate | File |', '| --- | --- | --- | --- |'])
        rows.extend(f'| {item["code"]} | {"frame" if item["parameters"]["part"] == 0 else "cog"} | '
                    f'{item["plate"]} | {item["plateLabel"]} |' for item in bogies)
        sections.append('\n'.join(rows))
    strips = [item for item in receipt_parts if item['family'] == flex_track.FAMILY]
    if strips:
        rows = ['# Flexible track (experimental)', '',
                f'Each strip prints straight on a two-filament plate: your PLA plus {flex_track.SPINE_MATERIAL} in AMS slot 2.', '',
                *(f'{index}. {note}' for index, note in enumerate(flex_track.assembly_notes(strips[0]['parameters']), 1)), '',
                '| Strip | Length (mm) | Plate | File |', '| --- | --- | --- | --- |']
        rows.extend(f'| {item["code"]} | {sum(item["parameters"][f"s{i}_len"] for i in range(int(item["parameters"]["segments"]))):g} | '
                    f'{item["plate"]} | {item["plateLabel"]} |' for item in strips)
        sections.append('\n'.join(rows))
    return '\n\n'.join(sections)


def _guide_text(manifest: dict | None, parts: list[dict]) -> str:
    """The shipped markdown guide a package starts from: the fit-coupon steps for a lone calibration sample."""
    coupon = manifest is None and len(parts) == 1 and parts[0]['family'] in ('brick_end_coupon', 'connector_coupon')
    guide = Path(__file__).resolve().parents[2] / 'docs/assembly' / ('fit-coupon.md' if coupon else 'print-and-build.md')
    return guide.read_text(encoding='utf-8')


def _before_steps(manifest: dict, parts: list[dict]) -> list[str]:
    """A layout's checks before running trains."""
    metal = any(part['family'] == composite.FAMILY and part['parameters'].get('metal') for part in parts)
    steps = ['Only the metal-rail 9 V pieces carry track power; isolate any reversing loop and give it its own '
             'polarity switch.' if metal else 'Printed rails don’t carry 9 V power.',
             'Test-fit one joint and run a wagon over every route before final assembly.']
    if any(part['family'] == 'vertical_transition' for part in parts):
        steps.append('Run your train up and down each ramp before relying on it.')
    if manifest['crossings']:
        steps.append('Run your train over and under each overpass before relying on it.')
    return steps


def _part_codes(parts: list[dict]) -> dict[str, str]:
    """Code by part id, and by piece id (a mechanism's or a marker's device id)."""
    return {**{part.get('assemblyInstanceId') or part['instanceId']: part['piece'] for part in parts},
            **{part['instanceId']: part['code'] for part in parts}}


def _shopping(manifest: dict, parts: list[dict]) -> dict:
    """The shopping list of the package's printed pieces (a layout part's own, `export_package(part=…)`), each piece
    named as the guide does: "3 · Left turnout"."""
    labels = {part.get('assemblyInstanceId') or part['instanceId']: f'{part["piece"]} · {part["pieceName"]}'
              for part in parts}
    return shopping_list(manifest_pieces([item for item in manifest['instances'] if item['id'] in labels], labels))


def _parts_guide(layout_parts: list[dict]) -> str:
    """The guide section of a layout prepared in parts (`combine.py`): which plates and pieces each part holds."""
    rows = ['# Prepared in parts', '',
            f'This layout was prepared in {len(layout_parts)} parts, one after another. Plate numbers run on across '
            'them, and part codes are the whole layout’s: print every plate.', '',
            '| Part | Plates | Pieces |', '| --- | --- | --- |']
    rows.extend(f'| {part["index"]} of {len(layout_parts)} | {", ".join(map(str, part["plates"]))} | '
                f'{", ".join(part["pieces"])} |' for part in layout_parts)
    return '\n'.join(rows)


def _community_guide(receipt_parts: list[dict]) -> str:
    """Credits for the community pieces a package prints (R19, R20), once each, with their pieces' codes."""
    items = guide_pdf.community_items(receipt_parts)
    if not items:
        return ''
    rows = ['# Community pieces', '', f'{PRINTS_AS_UPLOADED} They come from the Plateway community library; '
            'credit their makers when you share them.', '',
            '| Pieces | Name | By | Licence |', '| --- | --- | --- | --- |']
    rows.extend(f'| {", ".join(item["pieces"])} | {item["name"]} | {item["credit"]} | {item["licence"]} |' for item in items)
    return '\n'.join(rows)


def guide_markdown(manifest: dict | None, receipt_parts: list[dict], assemblies: list[dict],
                   layout_parts: list[dict] | None = None) -> str:
    """The package's markdown guide (`assembly-guide.md`) from its coded, plated receipt parts."""
    sections = [_guide_text(manifest, receipt_parts)]
    if assemblies:
        rows = ['# Multipart track pieces', '',
                'Print every part listed for a piece, even for a route you won’t use. '
                'Move each switch through its full travel before running a train.', '',
                '| Part | Name | Plate | File |', '| --- | --- | --- | --- |']
        rows.extend(f'| {item["code"]} | {item["name"]} | {item["plate"]} | {item["plateLabel"]} |'
                    for item in receipt_parts if item.get('assemblyInstanceId'))
        for assembly in assemblies:
            first = next(item for item in receipt_parts if item.get('assemblyInstanceId') == assembly['instanceId'])
            rows.extend(['', f'## {first["piece"]} · {first["pieceName"]}', ''])
            rows.extend(f'- Hardware: {item["quantity"]} × {item["name"]}' for item in assembly['hardware'])
            rows.extend(f'{index}. {note}' for index, note in enumerate(assembly['instructions'], 1))
        sections.insert(0, '\n'.join(rows))
    accessories = _accessory_guide(receipt_parts)
    if accessories:
        sections.insert(0, accessories)
    if manifest is not None and manifest.get('devices'):
        sections.append(_device_guide(manifest['devices'], _part_codes(receipt_parts)))
    community = _community_guide(receipt_parts)
    if community:
        sections.append(community)
    if manifest is not None:
        sections.insert(0, '# Before you build\n\n' + '\n\n'.join(_before_steps(manifest, receipt_parts)))
        sections.insert(0, guide_section(_shopping(manifest, receipt_parts)))
    if layout_parts:
        sections.insert(0, _parts_guide(layout_parts))
    return '\n\n'.join(sections)


def guide_pdf_bytes(read: guide_pdf.Reader, receipt: dict, manifest: dict | None) -> bytes:
    """The printable assembly guide of a package whose coded receipt and artefacts (`read`) are given."""
    parts = receipt['parts']
    devices = manifest.get('devices') if manifest is not None else None
    reference = '\n\n'.join(filter(None, (_accessory_guide(parts),
                                           _device_guide(devices, _part_codes(parts), ids=False) if devices else '')))
    return guide_pdf.build(read, receipt, manifest, _shopping(manifest, parts) if manifest is not None else None,
                           _before_steps(manifest, parts) if manifest is not None else [], _guide_text(manifest, parts),
                           reference)


def receipt_notes(receipt_parts: list[dict]) -> dict:
    """The receipt's `notes` field: what the member should know about how its parts were made."""
    return {'notes': [PRINTS_AS_UPLOADED]} if any(part.get('library') for part in receipt_parts) else {}


def _run(root: Path, name: str, manifest: dict | None, parts: list[dict], printer: dict,
         progress: Progress = no_progress, layout_part: dict | None = None,
         library: CommunityLibrary | None = None) -> dict:
    """Build into a staging folder, then install it under a name that must not exist yet. `layout_part` marks one part
    of a layout prepared in parts (`jobs.py`): its index, the part count and the printed instance ids it holds.
    `library` supplies the package's community pieces."""
    with staged_package(root, name) as (directory, stage_fd):
        sources = directory / 'sources'
        os.mkdir('sources', mode=0o700, dir_fd=stage_fd)
        label_parts(parts, manifest)
        generated: dict[str, dict] = {}
        receipt_parts = []
        for built, part in enumerate(parts):
            progress('cad', built, len(parts))
            request = _cad_request(part, printer)
            key = json.dumps(request, sort_keys=True, separators=(',', ':'), allow_nan=False)
            credit = None
            if part.get('library'):
                # A community piece (R20): its uploaded mesh, verified and placed as laid; its ports are its marked ends.
                if library is None:
                    raise ValueError('Community pieces need the library to read their meshes from')
                data, entry = library.piece(part['library'], part['pieceName'])
                pose, ends = _mesh_placement(part, entry['ends'])
                if key not in generated:
                    generated[key] = mesh_part(request, data, entry, sources)
                cad = {**generated[key], 'ports': mesh_ports(ends)}
                credit = {field: entry[field] for field in ('id', 'version', 'digest', 'name', 'licence', 'credit')}
            else:
                if key not in generated:
                    generated[key] = generate_part(request, sources)
                cad = generated[key]
                pose = part.get('pose')
            if pose is not None:
                def assembled(local):
                    heading = pose['heading']
                    return [pose['x'] + local[0]*math.cos(heading)-local[1]*math.sin(heading),
                            pose['y'] + local[0]*math.sin(heading)+local[1]*math.cos(heading),
                            pose['z'] + local[2]]

                if part['interfaceKind'] == 'rail':
                    ports = cad['ports']
                    if len(ports) != 2:
                        raise ValueError(f'CAD rail ports missing from {part["id"]}')
                    for label, expected in zip(('startPort', 'endPort'), ports):
                        supplied = part[label]
                        if not credit and (supplied['railGauge'] != expected['rail_gauge'] or
                                           supplied['interfaceWidth'] != expected['rail_interface_width']):
                            raise ValueError(f'CAD port profile differs from fitted instance {part["id"]}')
                        actual = supplied['pose']
                        xyz = assembled(expected['position'])
                        if any(abs(actual[axis] - xyz[i]) > .1 for i, axis in enumerate(('x', 'y', 'z'))) or (
                                abs(math.atan2(math.sin(actual['heading'] - pose['heading'] - expected['heading']),
                                               math.cos(actual['heading'] - pose['heading'] - expected['heading']))) > .001
                                or abs(actual['pitch'] - expected['pitch']) > .001):
                            raise ValueError(f'CAD port pose differs from fitted instance {part["id"]}')
                elif part['interfaceKind'] == 'mounting':
                    mount = cad['mounting_interface']
                    if not mount or cad['ports']:
                        raise ValueError(f'CAD mounting interface missing from {part["id"]}')
                    seat = part['mountingSeat']
                    xyz = assembled(mount['position'])
                    if any(abs(seat[axis] - xyz[i]) > .1 for i, axis in enumerate(('x', 'y', 'z'))) or (
                            abs(math.atan2(math.sin(seat['heading'] - pose['heading']),
                                           math.cos(seat['heading'] - pose['heading']))) > .001):
                        raise ValueError(f'CAD mounting seat differs from fitted instance {part["id"]}')
                elif cad['ports'] or cad['mounting_interface']:
                    raise ValueError(f'CAD joiner must not advertise rail or mounting ports: {part["id"]}')
            item = {'instanceId': part['id'], 'code': part['code'], 'piece': part['piece'], 'pieceName': part['pieceName'],
                    'name': part['name'], 'family': part['family'], 'parameters': part['parameters'],
                    'partRevision': part['part_revision'], 'layoutRevision': part['layout_revision'],
                    'assemblyPose': pose, 'digest': cad['digest'],
                    'requestDigest': cad['request_digest'], 'bounds': cad['bounds'], 'ports': cad['ports'],
                    'source': Path(cad['source']).relative_to(directory).as_posix(),
                    'sourceDependencies': [Path(source).relative_to(directory).as_posix()
                                           for source in cad['source_dependencies']],
                    'request': Path(cad['request']).relative_to(directory).as_posix(),
                    'mesh': Path(cad['mesh']).relative_to(directory).as_posix(),
                    **({'step': Path(cad['step']).relative_to(directory).as_posix()} if cad['step'] else {}),
                    # Multi-material parts (flexible track): one mesh per material and its filament slot.
                    **({'materials': [{'role': material['role'], 'filament': material['filament'],
                                       'mesh': Path(material['mesh']).relative_to(directory).as_posix(),
                                       'meshPath': material['mesh']} for material in cad['materials']]}
                       if cad.get('materials') else {}),
                    # A community piece's library item and credit (R19); its mesh is the uploaded file (`digest`).
                    **({'library': credit} if credit else {}),
                    'meshPath': cad['mesh']}
            receipt_parts.append(item)
            if part.get('assemblyInstanceId'):
                item.update({key: part[key] for key in (
                    'assemblyInstanceId', 'assemblyFamily', 'assemblyParameters', 'componentRole')})
        plates = export_plates(receipt_parts, printer, directory, progress)
        if Counter(obj['instanceId'] for plate in plates for obj in plate['objects']) != Counter(p['instanceId'] for p in receipt_parts):
            raise ValueError('Plate objects do not reconcile with printed manifest instances')
        for item in receipt_parts:
            del item['meshPath']
            for material in item.get('materials', []):
                del material['meshPath']
        payload = {'version': 1, 'id': name, 'status': 'prepared-digital-only',
                   'partRevision': parts[0]['part_revision'] if not manifest else manifest['project']['revision'],
                   'layoutRevision': parts[0]['layout_revision'] if not manifest else manifest['project']['layoutRevision'],
                   'printer': printer, 'parts': receipt_parts, 'plates': plates,
                   'physicalStatus': 'unverified', 'assemblyGuide': 'assembly-guide.md',
                   'assemblyGuidePdf': 'assembly-guide.pdf', **({'part': layout_part} if layout_part else {}),
                   **receipt_notes(receipt_parts)}
        assemblies = {}
        for item in receipt_parts:
            if item.get('assemblyInstanceId'):
                assembly = assemblies.get(item['assemblyInstanceId'])
                if assembly is None:
                    assembly = {
                        'instanceId': item['assemblyInstanceId'], 'family': item['assemblyFamily'], 'componentIds': [],
                        'hardware': module_for(item['assemblyFamily']).hardware(item['assemblyFamily'], item['assemblyParameters']),
                        'instructions': module_for(item['assemblyFamily']).assembly_notes(item['assemblyFamily'], item['assemblyParameters']),
                    }
                    assemblies[item['assemblyInstanceId']] = assembly
                assembly['componentIds'].append(item['instanceId'])
        if assemblies:
            payload['assemblies'] = list(assemblies.values())
        payload['cadSourceCurrent'] = True
        if manifest is not None:
            write_exclusive(stage_fd, 'manifest.json', (json.dumps(manifest, sort_keys=True, indent=2, allow_nan=False)+'\n').encode())
            payload['manifest'] = 'manifest.json'
        progress('guide', 0, 1)
        write_exclusive(stage_fd, 'assembly-guide.md', guide_markdown(manifest, receipt_parts, payload.get('assemblies', [])).encode())
        write_exclusive(stage_fd, 'assembly-guide.pdf', guide_pdf_bytes(
            lambda relative: (directory / relative).read_bytes(), payload, manifest))
        write_exclusive(stage_fd, 'receipt.json', (json.dumps(payload, sort_keys=True, indent=2, allow_nan=False)+'\n').encode())
        return payload


def sources_current(saved: dict) -> bool:
    """True while every part's recipe, as its receipt records it, still hashes to the current geometry inputs. The
    receipt alone decides, so the answer holds after the package's files have expired (KTD7)."""
    parts = saved.get('parts')
    if not isinstance(parts, list) or not parts:
        return False
    checked = set()
    try:
        for part in parts:
            request = _cad_request({'family': part['family'], 'parameters': part['parameters'],
                                    'part_revision': part['partRevision'], 'layout_revision': saved['layoutRevision'],
                                    'library': part.get('library')}, saved['printer'])
            key = json.dumps([request, part['requestDigest']], sort_keys=True)
            if key not in checked:
                if part['requestDigest'] != current_request_digest(request):
                    return False
                checked.add(key)
    except (ValueError, TypeError, KeyError, AttributeError):
        return False
    return True


def public_receipt(saved: dict) -> dict:
    """Receipt as served: drops retired fields and reports whether its CAD is current."""
    receipt = {key: value for key, value in saved.items() if key != 'packageStatus'}
    receipt['cadSourceCurrent'] = sources_current(saved)
    return receipt


def _saved(root: Path, name: str) -> dict | None:
    """The package folder's receipt when readable; a non-folder at that name is unsafe."""
    try:
        info = os.lstat(root / name)
    except FileNotFoundError:
        return None
    if not stat.S_ISDIR(info.st_mode):
        raise FileExistsError(f'Package path is not a folder: {name}')
    try:
        fd, _ = safe_file(root, name, 'receipt.json')
        with os.fdopen(fd, 'r', encoding='utf-8') as source:
            receipt = json.load(source)
    except (OSError, ValueError):
        return None
    return receipt if isinstance(receipt, dict) else None


def _reusable(root: Path, name: str, saved: dict | None, printer: dict, manifest: dict | None,
              part: dict | None = None) -> bool:
    """A complete package for the same parts and printer, built from current CAD sources."""
    if (saved is None or saved.get('id') != name or saved.get('status') != 'prepared-digital-only' or
            saved.get('printer') != printer or bool(saved.get('manifest')) != (manifest is not None) or
            saved.get('part') != part):
        return False
    plates, parts = saved.get('plates'), saved.get('parts')
    if not isinstance(plates, list) or not plates or not isinstance(parts, list) or not parts:
        return False
    try:
        artifacts = [saved['assemblyGuide'], saved['assemblyGuidePdf'],
                     *(plate[key] for plate in plates for key in ('model', 'project', 'gcode')),
                     *(part['mesh'] for part in parts)]
        for artifact in artifacts:
            fd, _ = safe_file(root, name, artifact)
            os.close(fd)
        if manifest is not None:
            fd, _ = safe_file(root, name, saved['manifest'])
            with os.fdopen(fd, 'r', encoding='utf-8') as source:
                stored = json.load(source)
            if (stored.get('instances') != manifest['instances'] or stored.get('mounting') != manifest['mounting'] or
                    stored.get('library') != manifest.get('library')):
                return False
    except (OSError, ValueError, TypeError, KeyError, AttributeError):
        return False
    return sources_current(saved)


def geometry_fingerprint(parts: list[dict], printer: dict) -> str:
    """Hash of every part's current CAD recipe digest and the printer selection."""
    digests = sorted({current_request_digest(_cad_request(part, printer)) for part in parts})
    canonical = json.dumps([digests, printer], sort_keys=True, separators=(',', ':'), allow_nan=False)
    return hashlib.sha256(canonical.encode()).hexdigest()


def fresh_name(base: str, used: set[str], fingerprint: Callable[[], str]) -> str:
    """A new package's name: `base`, else `<base>-<fingerprint()[:8]>`, else that with a random suffix. `used`: the
    names already taken, here or published."""
    if base not in used:
        return base
    name = f'{base}-{fingerprint()[:8]}'
    return name if name not in used else f'{name}-{uuid.uuid4().hex[:6]}'


def variants(names: Iterable[str], base: str) -> set[str]:
    """`base` and its rebuilt variants (`<base>-<8 hex>[-<6 hex>]`) among `names`."""
    return {name for name in names if name == base or name.startswith(base) and VARIANT.fullmatch(name[len(base):])}


def _prepare(root: Path, base: str, manifest: dict | None, parts: list[dict], printer: dict,
             progress: Progress = no_progress, part: dict | None = None,
             taken: Callable[[str], Collection[str]] = lambda _base: (),
             library: CommunityLibrary | None = None) -> tuple[dict, bool]:
    """Return (receipt, created). Existing packages are never modified or removed: reuse a current one here (the
    base id or a rebuilt variant), otherwise build a new variant. `taken(base)`: the names of published packages,
    which are never reused or rebuilt under the same name."""
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    published = variants(taken(base), base)
    local = variants(os.listdir(root), base)
    for name in sorted(local - published, key=lambda name: (name != base, name)):
        saved = _saved(root, name)
        if _reusable(root, name, saved, printer, manifest, part):
            return public_receipt(saved), False
    # e.g. an interrupted earlier build is left untouched.
    name = fresh_name(base, local | published, lambda: geometry_fingerprint(parts, printer))
    return _run(root, name, manifest, parts, printer, progress, part, library), True


def export_package(root: Path, manifest: dict, *, part: dict | None = None, progress: Progress = no_progress,
                   taken: Callable[[str], Collection[str]] = lambda _base: (),
                   library: Reader | None = None) -> tuple[dict, bool]:
    """The layout's package; with `part` ({'index', 'count', 'instanceIds'}, from `split.py`), only that part's printed
    instances, as a package of its own (`<layout package>-part-<index>-of-<count>`) that keeps the whole manifest, so
    part codes match the whole layout's. `library`: the library bucket (`storage.library_reader`), read for the
    community pieces this package prints, and only those."""
    name, printed = validate_manifest(manifest)
    if part is not None:
        _dict(part, {'index', 'count', 'instanceIds'}, 'part')
        chosen = set(part['instanceIds'])
        if (type(part['index']) is not int or type(part['count']) is not int or not 1 <= part['index'] <= part['count']
                or not chosen or len(chosen) != len(part['instanceIds']) or not chosen <= {p['id'] for p in printed}):
            raise ValueError('Invalid layout part')
        printed = [instance for instance in printed if instance['id'] in chosen]
        name = f"{name}-part-{part['index']}-of-{part['count']}"
    return _prepare(root, name, manifest, expand_components(printed_parts(manifest, printed)), manifest['printer'],
                    progress, part, taken, CommunityLibrary(library) if library is not None else None)


def validate_trial(parts: list[dict], printer: dict) -> str:
    """A calibration sample or grade rig request; returns its package base name."""
    select_presets(printer)
    if not isinstance(parts, list) or not parts:
        raise ValueError('Trial requires one or more CAD parts')
    ids = set()
    for part in parts:
        _dict(part, {'id', 'family', 'parameters', 'part_revision', 'layout_revision'}, 'trial part')
        ident = _instance_id(part['id'])
        if ident in ids or part['family'] not in ('connector_coupon', 'brick_end_coupon', 'vertical_transition', 'connector_joiner'):
            raise ValueError('Duplicate trial ID or unsupported trial family')
        ids.add(ident)
        _revision(part['part_revision'])
        _revision(part['layout_revision'])
    if any(part['family'] == 'brick_end_coupon' for part in parts) and (
            len(parts) != 1 or parts[0]['family'] != 'brick_end_coupon'):
        raise ValueError('The track end test must be a standalone trial part')
    canonical = json.dumps({'parts': parts, 'printer': printer}, sort_keys=True, separators=(',', ':'), allow_nan=False)
    return f'trial-{hashlib.sha256(canonical.encode()).hexdigest()[:32]}'


def export_trial(root: Path, parts: list[dict], printer: dict, progress: Progress = no_progress,
                 taken: Callable[[str], Collection[str]] = lambda _base: ()) -> tuple[dict, bool]:
    return _prepare(root, validate_trial(parts, printer), None, parts, printer, progress, taken=taken)


def safe_file(root: Path, package_id: str, artifact_path: str) -> tuple[int, int]:
    """Open only regular artefacts via nofollow descriptors; caller owns returned FD."""
    if not isinstance(package_id, str) or not PACKAGE_ID.fullmatch(package_id) or '..' in package_id:
        raise ValueError('Invalid package identity')
    segments = artifact_path.split('/')
    if not segments or any(not ARTIFACT.fullmatch(p) or p in ('.', '..') or '..' in p for p in segments):
        raise ValueError('Invalid artifact path')
    root_fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    opened = [root_fd]
    try:
        directory = os.open(package_id, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=root_fd)
        opened.append(directory)
        for segment in segments[:-1]:
            directory = os.open(segment, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
            opened.append(directory)
        fd = os.open(segments[-1], os.O_RDONLY | os.O_NOFOLLOW, dir_fd=directory)
        metadata = os.fstat(fd)
        if not stat.S_ISREG(metadata.st_mode):
            os.close(fd)
            raise ValueError('Artifact must be a regular file')
        return fd, metadata.st_size
    finally:
        for directory in reversed(opened):
            os.close(directory)
