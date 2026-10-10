"""Before queueing a prepare (`jobs.py`): validate it, estimate its size (KTD6) and split a layout too big for one
prepare into parts by region, along its track joints (R11).

A piece group is what one part must keep whole: a layout piece's printed instances (all its sections, the joiners at
its seams and the accessories on it, which share its section ids, so their part codes match the whole layout's), plus
the supports and stray accessories nearest to it. Groups follow the routes in track order, so two consecutive groups
of one route meet at the track joint between their pieces. A part is a run of consecutive groups.
"""
from __future__ import annotations

from collections.abc import Callable
import math

from cad.service.assemblies import expand_components
from cad.service.generate import validate_request
from cad.service.jobs import memory_mb
from cad.service.labels import family_name, is_support, piece_of
from cad.service.package import cad_requests, printed_parts, validate_manifest, validate_trial

TRACK = ('rail', 'track-assembly')
COUPONS = {'connector_coupon', 'brick_end_coupon'}
GRADE = {'vertical_transition', 'connector_joiner'}


class TooLarge(Exception):
    """One prepare that cannot be made smaller is above the limit: `subject` names it, `size` is its estimate."""

    def __init__(self, subject: str, size: dict):
        super().__init__(subject)
        self.subject, self.size = subject, size


def estimate(parts: list[dict], printer: dict) -> dict:
    """KTD6 for one prepare of these expanded printed parts: their count, the distinct CAD builds and the memory."""
    builds = len(cad_requests(parts, printer))
    return {'printedParts': len(parts), 'cadBuilds': builds, 'memoryMb': memory_mb(len(parts), builds)}


def plan_request(body: dict, limit_mb: int) -> tuple[str, dict, dict, list[tuple[list[str], dict]]]:
    """(kind, payload, estimate, parts) of a prepare request `{"kind": "layout", "manifest"}` or `{"kind": "coupon" |
    "grade", "parts", "printer"}`; `parts` is empty unless a layout is above `limit_mb`, then each part's printed
    instance ids and estimate. Raises `TooLarge`, `UserError` or `ValueError`."""
    kind = body['kind']
    if kind == 'layout':
        if set(body) != {'kind', 'manifest'}:
            raise ValueError('A layout prepare is its manifest')
        return kind, body['manifest'], *_plan_layout(body['manifest'], limit_mb)
    if set(body) != {'kind', 'parts', 'printer'}:
        raise ValueError('A calibration sample or grade rig is its parts and printer')
    parts, printer = body['parts'], body['printer']
    validate_trial(parts, printer)
    families = {part['family'] for part in parts}
    if kind == 'coupon' and (len(parts) != 1 or not families <= COUPONS):
        raise ValueError('A calibration sample is one coupon')
    if kind == 'grade' and ('vertical_transition' not in families or not families <= GRADE):
        raise ValueError('A grade rig is ramp pieces and their joiners')
    for request in cad_requests(parts, printer):
        validate_request(request)
    size = {**estimate(parts, printer), 'limitMb': limit_mb}
    if size['memoryMb'] > limit_mb:
        raise TooLarge('This print', size)
    return kind, {'parts': parts, 'printer': printer}, size, []


def _plan_layout(manifest: dict, limit_mb: int) -> tuple[dict, list[tuple[list[str], dict]]]:
    _, printed = validate_manifest(manifest)
    printer = manifest['printer']
    expanded = {part['id']: expand_components([part]) for part in printed_parts(manifest, printed)}
    for request in cad_requests([part for rows in expanded.values() for part in rows], printer):
        validate_request(request)

    def size(instances: list[dict]) -> dict:
        return {**estimate([part for instance in instances for part in expanded[instance['id']]], printer),
                'limitMb': limit_mb}

    whole = size(printed)
    if whole['memoryMb'] <= limit_mb:
        return whole, []
    groups = piece_groups(manifest, printed)
    piece, names = piece_of(manifest), manifest.get('pieceNames', {})
    for group in groups:
        if size(group)['memoryMb'] > limit_mb:
            key = piece(group[0])
            raise TooLarge(f'Its piece “{names.get(key) or family_name(group[0]["family"])}”', size(group))
    parts = split(groups, lambda instances: size(instances)['memoryMb'] <= limit_mb)
    return {**whole, 'parts': len(parts)}, [([instance['id'] for instance in part], size(part)) for part in parts]


def piece_groups(manifest: dict, printed: list[dict]) -> list[list[dict]]:
    """The validated manifest's printed instances (`printed`) in piece groups, in route and track order."""
    piece = piece_of(manifest)
    track = [instance for instance in manifest['instances'] if instance['interfaceKind'] in TRACK]
    groups: dict[str, list[dict]] = {}
    for route in manifest['routes']:
        for instance in track:
            if instance['routeId'] == route['id']:
                groups.setdefault(piece(instance), [])
    strays = []
    for instance in printed:
        key = piece(instance)
        if key in groups and not is_support(instance):
            groups[key].append(instance)
        else:
            strays.append(instance)
    for instance in strays:
        pose = instance['pose']
        nearest = min(track, key=lambda item: math.dist((pose['x'], pose['y']), (item['pose']['x'], item['pose']['y'])),
                      default=None)
        groups.setdefault(piece(nearest) if nearest is not None else piece(instance), []).append(instance)
    return [group for group in groups.values() if group]


def split(groups: list[list[dict]], fits: Callable[[list[dict]], bool]) -> list[list[dict]]:
    """Consecutive groups gathered into parts while `fits` holds; every group must fit on its own."""
    parts: list[list[dict]] = []
    current: list[dict] = []
    for group in groups:
        if current and not fits(current + group):
            parts.append(current)
            current = []
        current = current + group
    if current:
        parts.append(current)
    return parts
