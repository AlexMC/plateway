"""Build public/trains/ (index.json, per-car .glb, ATTRIBUTION.md) from the cached LDraw data.

Run after fetch.py (and procedural_60052.py):
  uv run --with shapely --with numpy --with moderngl python scripts/trains/build.py

Every car is measured from its LDraw geometry: wheels (tread radius) set the railhead, axle lines
set the track direction and centreline, bogie/axle groups give the pivots, coupler parts give
the coupling faces. Nothing here is typed in by hand except the curated overrides below, each
with its reason.
"""
from __future__ import annotations

import json
import os
import re
import sys
from dataclasses import dataclass
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
from glb import cluster, weld, write_glb  # noqa: E402
from visibility import visible  # noqa: E402
from ldraw import LDU, MAIN_COLOUR, Library, PartInstance, parse_mpd, transform, walk  # noqa: E402
from vehicles import (COUPLER, MOTOR, TRACK, UP, WheelFinder, build_tree, car_axes,  # noqa: E402
                      find_vehicles, frame_axes, pair_axles, wheels_of)

DATA = Path(os.environ.get('TRAIN_DATA_DIR', '/tmp/train-data'))
REPO = Path(__file__).resolve().parents[2]
OUT = REPO / 'public' / 'trains'
OMR = 'https://library.ldraw.org'
TRI_BUDGET = 9000  # contract cap is 12 000; 9 000 keeps the catalogue ~25% lighter with clean shapes
BYTE_BUDGET = 250_000

# ---- curated decisions (each one a reason, never a measurement) ---------------------------------

# Alternate builds of the same parts: the catalogue uses the set's main build.
ALTERNATE = re.compile(r'(B-Model|Model B)', re.I)
# Sets whose only OMR model is an alternate build: use it.
ALTERNATE_ONLY_OK = {'3740-1', '3741-1'}
# Models that are not the set's own rolling stock.
SKIP_MODELS = {
    ('10183-1', 'Main Model'): 'Hobby Train main model combines the alternate builds; each alternate build is listed instead',
    ('7936-1', 'Main Model'): 'road-rail excavator (rail guide wheels, no couplers): not train rolling stock',
}
# Car front (+x) flips for single locomotives whose model faces cab-first, decided from the
# review renders (scripts/trains/render.py): the smokebox / long-nose end is the front.
FLIP: set[str] = {'126-1/steam-locomotive-push', '7810-1/push-along-steam-engine',
                  '10133-1/burlington-northern-santa-fe-locomotive'}
# Explicit car definitions where the submodel tree does not say it. 'nodes' carry geometry,
# 'shared' only lends its axles (a bogie the car rests on but that belongs to its neighbour),
# 'pick' adds loose parts of those submodels standing on the car's footprint.
# Monorail trains are two cars resting on a motor unit between them; 10233's second
# coach rests on the first coach's articulated rear bogie.
CARS: dict[str, list[dict]] = {
    '4544-1': [{'name': 'Car Transport Wagon with Car', 'nodes': ['4544 - train car.ldr', '4544 - car.ldr', '4544 - minifig.ldr']}],
    '7997-1': [{'name': 'Handcar', 'nodes': ['7997 - handcar.ldr']}],
    '167-1': [{'name': 'Car Transport Wagon', 'nodes': ['167 - freight wagon.ldr']}],
    '6399-1': [{'name': 'Front coach with motor unit', 'nodes': ['6399 - train a.ldr', '6399 - train b.ldr']},
               {'name': 'Rear coach', 'nodes': ['6399 - train c.ldr'], 'shared': ['6399 - train b.ldr']}],
    '6990-1': [{'name': 'Front coach with motor unit', 'nodes': ['6990 - train 1 + vehicle 1.ldr', '6990 - train 2.ldr'],
                'pick': ['6990 - track + train.ldr']},
               {'name': 'Rear coach', 'nodes': ['6990 - train 3.ldr'], 'shared': ['6990 - train 2.ldr']}],
    '6991-1': [{'name': 'Front coach with motor unit',
                'nodes': ['6991 - monorail train2.ldr', '6991 - cabin1.ldr', '6991 - monorail train middle motor.ldr',
                          '6991 - eleccable2brick-1.ldr']},
               {'name': 'Rear coach', 'nodes': ['6991 - monorail train1.ldr', '6991 - cabin2.ldr'],
                'shared': ['6991 - monorail train middle motor.ldr']}],
    '10233-1': [{'name': 'Locomotive', 'nodes': ['10233 - locomotive.ldr']},
                {'name': 'Coach 1', 'nodes': ['10233 - wagon 1.ldr']},
                {'name': 'Coach 2', 'nodes': ['10233 - wagon 2.ldr'], 'shared': ['10233 - w1 s26.ldr']}],
}
# Display names where the OMR submodel name is generic or misleading: (set, OMR name) -> name.
NAMES: dict[tuple[str, str], str] = {
    ('4558-1', 'Train 3'): 'Power car', ('4558-1', 'Train 2'): 'Middle coach', ('4558-1', 'Train 1'): 'Cab car',
    ('10001-1', 'Train 3'): 'Power car', ('10001-1', 'Train 2'): 'Middle coach', ('10001-1', 'Train 1'): 'Cab car',
    ('7745-1', 'Train car 1'): 'Power car', ('7745-1', 'Train car 2'): 'Coach', ('7745-1', 'Train car 3'): 'Driving trailer',
    ('7725-1', 'Train 1'): 'Motor railcar', ('7725-1', 'Train 2'): 'Middle coach', ('7725-1', 'Train 3'): 'Driving trailer',
    ('7740-1', 'Train 1'): 'Electric locomotive', ('7740-1', 'Train 2'): 'Coach', ('7740-1', 'Train 3'): 'Coach',
    ('10277-1', 'Middle drivetrain'): 'Centre cab', ('10277-1', 'Front driveline'): 'Hood unit',
    ('7750-1', 'Trailer'): 'Tender (motor)',
    ('7817-1', 'Wahon base'): 'Crane Wagon',
}

# Parts that carry two or more axles in their own frame even when the wheels are separate parts.
CARRIER = re.compile(r'train motor|monorail motor|monorail wheel chassis', re.I)

POWER_BY_MOTOR = [(re.compile(r'Power Functions Train Motor', re.I), 'IR'),
                  (re.compile(r'Train Motor\s+9V', re.I), '9V'),
                  (re.compile(r'12V|12 Volt', re.I), '12V'),
                  (re.compile(r'4\.5V|4 x 12 x  4', re.I), '4.5V'),
                  (re.compile(r'Monorail Motor', re.I), 'monorail')]

KIND_RULES = [('other', re.compile(r'handcar|snow remover', re.I)),
              ('tender', re.compile(r'tender', re.I)),
              ('caboose', re.compile(r'caboose', re.I)),
              ('loco', re.compile(r'loco|locomotive|engine|lokomotive|shunter|switcher|crocodile|hood unit|centre cab', re.I)),
              ('coach', re.compile(r'cab car|coach|passenger|carriage|club|sleep|dining|observation|excursion|baggage|mail|tram|shuttle|cabin', re.I)),
              ('wagon', re.compile(r'wagon|car\b|tank|hopper|flat|container|freight|crane|stack|remover|trailer|transport', re.I))]


@dataclass
class Source:
    set_id: str
    name: str
    year: int
    theme: str
    model: str            # OMR model name ('Main Model', 'Observation Car', ...)
    path: Path
    url: str | None
    page: str | None
    kind: str             # 'omr' | 'procedural'
    evidence: str | None = None


def is_track(lib: Library, name: str) -> bool:
    return bool(TRACK.match(lib.description(name)))


def colour_rgba(lib: Library, code: int) -> tuple[float, float, float, float]:
    if code >= 0x2000000:
        v = code - 0x2000000
        return ((v >> 16 & 255) / 255, (v >> 8 & 255) / 255, (v & 255) / 255, 1.0)
    c = lib.colours.get(code)
    if c is None:
        return (0.6, 0.6, 0.6, 1.0)
    return (*c.rgb, c.alpha)


def model_meta(files) -> tuple[list[str], str | None]:
    authors, licence = [], None
    for f in files.values():
        for h in f.header:
            m = re.match(r'0\s+Author:\s*(.+)', h)
            if m and m.group(1).strip() not in authors:
                authors.append(m.group(1).strip())
            m = re.match(r'0\s+!LICENSE\s+(.+)', h)
            if m and licence is None:
                licence = m.group(1).strip()
    return authors, licence


GENERIC = re.compile(r'^(train car|train|car|wagon|freightcar|freight wagon)\s*\d*$', re.I)


def pretty(name: str, set_number: str) -> str:
    base = re.sub(r'\.(ldr|mpd|dat)$', '', name.split('@')[0], flags=re.I)
    base = re.sub(rf'^{re.escape(set_number.split("-")[0])}(-\d+)?\s*-\s*', '', base).strip()
    base = re.sub(r'\s+', ' ', base)
    return base[:1].upper() + base[1:]


def slug(s: str) -> str:
    return re.sub(r'[^a-z0-9]+', '-', s.lower()).strip('-') or 'car'


@dataclass
class CarGeometry:
    tris: np.ndarray       # (N,3,3) mm, car frame
    colours: list          # per-triangle rgba
    parts: list[int]


class SetBuilder:
    def __init__(self, lib: Library):
        self.lib = lib
        self.finder = WheelFinder(lib)
        self.motor_bbox_cache: dict[str, np.ndarray] = {}

    def part_bounds(self, name: str) -> np.ndarray | None:
        if name not in self.motor_bbox_cache:
            t, _ = self.lib.flatten_part(name)
            self.motor_bbox_cache[name] = None if len(t) == 0 else np.array([t.reshape(-1, 3).min(0), t.reshape(-1, 3).max(0)])
        return self.motor_bbox_cache[name]

    def vehicles(self, src: Source) -> tuple[list, dict]:
        order, files = parse_mpd(src.path)
        self.lib.use_model(files)
        inst = walk(files, order[0])
        wheels = wheels_of(inst, self.finder)
        axles = pair_axles(wheels)
        if not axles:
            return [], files
        nodes = build_tree(inst, axles)
        override = CARS.get(src.set_id)
        if override:
            groups = []
            for car in override:
                keys = [k for k in nodes if k and k[-1].split('@')[0] in car['nodes']]
                shared = [k for k in nodes if k and k[-1].split('@')[0] in car.get('shared', [])]
                pick = [k for k in nodes if k and k[-1].split('@')[0] in car.get('pick', [])]
                groups.append({'name': car['name'], 'keys': keys, 'shared': shared, 'pick': pick})
        else:
            groups = [{'name': None, 'keys': [k], 'shared': [], 'pick': []}
                      for k in find_vehicles(inst, axles, nodes, lambda n: is_track(self.lib, n))]
        out = []
        for g in groups:
            parts = {i for k in g['keys'] for i in nodes[k].parts}
            ax = sorted({a for k in g['keys'] + g['shared'] for a in nodes[k].axles})
            if not ax:
                continue
            if g['pick']:
                claimed = {i for other in groups for k in other['keys'] for i in nodes[k].parts}
                fwd, left = frame_axes([axles[a] for a in ax])
                s = [inst[i].matrix[:3, 3] @ fwd for i in parts]
                centre_y = np.mean([axles[a].centre @ left for a in ax])
                wheel_top = max(axles[a].centre @ UP for a in ax)  # loose parts must stand above the wheels
                for k in g['pick']:
                    for i in nodes[k].parts:
                        p = inst[i].matrix[:3, 3]
                        if (i not in claimed and min(s) - 10 <= p @ fwd <= max(s) + 10
                                and abs(p @ left - centre_y) <= 70 and p @ UP > wheel_top
                                and not is_track(self.lib, inst[i].name)):
                            parts.add(i)
            parts = sorted(parts)
            key = g['keys'][0]
            if g['name']:
                name = g['name']
            elif len(groups) == 1:
                name = src.name if src.model.lower() in ('main model', '') else src.model
            else:
                name = pretty(key[-1], src.set_id)
            out.append({'key': key, 'name': name, 'parts': parts, 'axles': [axles[a] for a in ax],
                        'inst': inst, 'nodes': nodes})
        return out, files

    def measure(self, v: dict) -> dict:
        lib, inst, axles = self.lib, v['inst'], v['axles']
        fwd, left, up = car_axes(axles)
        # Railhead: the lowest tread contact. Every axle's contact height is reported for validation.
        contacts = [min(w.centre @ up - w.radius for w in a.wheels) for a in axles]
        rail_up = min(contacts)
        centre_y = float(np.mean([a.centre @ left for a in axles]))
        s_axle = np.array([a.centre @ fwd for a in axles])

        # Bogie groups: a multi-axle part (motor) or a bogie-sized submodel carries its axles;
        # loose single axles closer than 3.5 studs form one group.
        carriers = []
        for a in axles:
            idx = {w.part for w in a.wheels}
            carrier = None
            for i in idx:
                if sum(1 for b in axles if i in {w.part for w in b.wheels}) >= 2:
                    carrier = ('part', i)
            if carrier is None:
                for i in v['parts']:
                    if CARRIER.search(lib.description(inst[i].name)):
                        bb = self.part_bounds(inst[i].name)
                        if bb is None:
                            continue
                        local = np.linalg.inv(inst[i].matrix) @ np.append(a.centre, 1.0)
                        if np.all(local[:3] >= bb[0] - 12) and np.all(local[:3] <= bb[1] + 12):
                            carrier = ('part', i)
            if carrier is None:
                paths = [inst[w.part].path for w in a.wheels]
                common = paths[0]
                for p in paths[1:]:
                    n = 0
                    while n < min(len(common), len(p)) and common[n] == p[n]:
                        n += 1
                    common = common[:n]
                for k in range(len(common), len(v['key']), -1):
                    node = v['nodes'][common[:k]]
                    # A sub-assembly carrying some (not all) of the vehicle's axles is a bogie.
                    if 2 <= len(node.axles) < len(v['axles']):
                        carrier = ('node', common[:k])
                        break
            carriers.append(carrier)
        order = np.argsort(s_axle)
        groups: list[list[int]] = []
        for i in order:
            c = carriers[i]
            if c is not None:
                for g in groups:
                    if carriers[g[0]] == c:
                        g.append(i)
                        break
                else:
                    groups.append([i])
            elif groups and carriers[groups[-1][-1]] is None and s_axle[i] - s_axle[groups[-1][-1]] < 70.0:
                groups[-1].append(i)
            else:
                groups.append([i])
        pivots = sorted(float(np.mean(s_axle[g])) for g in groups)
        if len(pivots) == 1:  # one rigid wheel group: its outer axles guide the body
            g = groups[0]
            pivots = [float(s_axle[g].min()), float(s_axle[g].max())]
        origin_s = (pivots[0] + pivots[-1]) / 2

        def to_car(p: np.ndarray) -> np.ndarray:
            return np.stack([(p @ fwd - origin_s), (p @ left - centre_y), (p @ up - rail_up)], axis=-1) * LDU

        # Geometry: every part of the vehicle except track, and (for whole-model vehicles) scenery
        # standing off the track corridor.
        tris, cols, used = [], [], []
        for i in v['parts']:
            name = inst[i].name
            if is_track(lib, name):
                continue
            o = to_car(inst[i].matrix[:3, 3])
            if abs(o[1]) > 60 or o[2] < -12:
                continue
            t, c = lib.flatten_part(name)
            if len(t) == 0:
                continue
            c = np.where(c == MAIN_COLOUR, inst[i].colour, c)
            tris.append(to_car(transform(t, inst[i].matrix)))
            cols.append(c)
            used.append(i)
        tris_a = np.concatenate(tris)
        cols_a = np.concatenate(cols)
        lo, hi = tris_a.reshape(-1, 3).min(0), tris_a.reshape(-1, 3).max(0)

        # Coupling faces: outermost geometry of coupler parts at each end.
        fronts, rears = [], []
        for i in used:
            if COUPLER.search(lib.description(inst[i].name)):
                t, _ = lib.flatten_part(inst[i].name)
                pts = to_car(transform(t, inst[i].matrix)).reshape(-1, 3)
                if abs(pts[:, 1].mean()) > 30:  # off-centre magnet: a load, not a coupling
                    continue
                if pts[:, 0].mean() > 0:
                    fronts.append(pts[:, 0].max())
                else:
                    rears.append(pts[:, 0].min())
        couplers = {'front': float(max(fronts)) if fronts else float(hi[0]),
                    'rear': float(min(rears)) if rears else float(lo[0])}
        windows = sum(1 for i in used if re.search(r'window|glass|windscreen', lib.description(inst[i].name), re.I))
        motor = None
        for i in used:
            d = lib.description(inst[i].name)
            if MOTOR.search(d):
                for rx, p in POWER_BY_MOTOR:
                    if rx.search(d):
                        motor = p
                        break
        return {
            'fwd': fwd, 'left': left, 'origin_s': origin_s, 'rail_up': rail_up, 'centre_y': centre_y,
            'tris': tris_a, 'cols': cols_a, 'lo': lo, 'hi': hi,
            'pivots': [(p - origin_s) * LDU for p in pivots],
            'axles_x': sorted(float((s - origin_s) * LDU) for s in s_axle),
            'contacts': [float((c - rail_up) * LDU) for c in contacts],
            'wheel_y': [float((a.centre @ left - centre_y) * LDU) for a in axles],
            'couplers': couplers, 'motor': motor, 'coupler_found': (bool(fronts), bool(rears)),
            'gauge': axles[0].gauge, 'windows': windows,
        }


def flip(m: dict) -> dict:
    """Turn a measured car end for end (front becomes rear)."""
    tris = m['tris'].copy()
    tris[..., 0] *= -1
    tris[..., 1] *= -1
    m = dict(m, tris=tris)  # 180° turn about z: a rotation, winding unchanged
    m['pivots'] = sorted(-p for p in m['pivots'])
    m['axles_x'] = sorted(-p for p in m['axles_x'])
    m['couplers'] = {'front': -m['couplers']['rear'], 'rear': -m['couplers']['front']}
    m['coupler_found'] = m['coupler_found'][::-1]
    m['fwd'] = -m['fwd']
    m['left'] = -m['left']
    lo, hi = m['lo'].copy(), m['hi'].copy()
    m['lo'] = np.array([-hi[0], -hi[1], lo[2]])
    m['hi'] = np.array([-lo[0], -lo[1], hi[2]])
    return m


def outline(tris: np.ndarray, max_points: int = 40) -> list[list[float]]:
    from shapely.geometry import Polygon
    from shapely.ops import unary_union

    polys = []
    for t in tris[:, :, :2]:
        area = 0.5 * abs((t[1, 0] - t[0, 0]) * (t[2, 1] - t[0, 1]) - (t[2, 0] - t[0, 0]) * (t[1, 1] - t[0, 1]))
        if area > 0.05:
            polys.append(Polygon(t))
    shape = unary_union(polys).buffer(0.6, join_style=2).buffer(-0.6, join_style=2)
    if shape.geom_type == 'MultiPolygon':
        shape = max(shape.geoms, key=lambda g: g.area)
    shape = Polygon(shape.exterior)
    tol = 0.25
    simple = shape.simplify(tol)
    while len(simple.exterior.coords) - 1 > max_points:
        tol *= 1.4
        simple = shape.simplify(tol)
    coords = list(simple.exterior.coords)[:-1]
    if simple.exterior.is_ccw is False:
        coords = coords[::-1]
    return [[round(x, 1), round(y, 1)] for x, y in coords]


def kind_of(name: str, motorised: bool, windows: int, fallback: str = '') -> str:
    """Car kind from its name (a motor makes anything but a tender a loco), else the set name
    (single-car sets), else glazing."""
    for kind, rx in KIND_RULES:
        if rx.search(name):
            return 'loco' if motorised and kind != 'tender' else kind
    if motorised:
        return 'loco'
    for kind, rx in KIND_RULES:
        if fallback and rx.search(fallback):
            return kind
    return 'coach' if windows >= 6 else 'wagon'


def export_car(lib: Library, m: dict, path: Path) -> tuple[int, int, np.ndarray]:
    translucent = np.array([colour_rgba(lib, int(c))[3] < 0.99 for c in m['cols']])
    seen = visible(m['tris'], translucent)
    groups = []
    for code in np.unique(m['cols']):
        sel = (m['cols'] == code) & seen
        v, f = weld(m['tris'][sel])
        if len(f):
            groups.append((v, f, colour_rgba(lib, int(code))))
    budget = TRI_BUDGET
    while True:
        dec = cluster(groups, budget)
        tri, size = write_glb(path, dec)
        if size <= BYTE_BUDGET:
            break
        budget = int(budget * 0.85)
    final = np.concatenate([v[f] for v, f, _ in dec])
    return tri, size, final


def sources() -> list[Source]:
    out = []
    sets = json.loads((DATA / 'omr_models.json').read_text())
    for s in sets:
        models = [m for m in s['models'] if (DATA / 'mpd' / m['url'].rsplit('/', 1)[1]).exists()]
        has_main = any(not ALTERNATE.search(m['name']) for m in models)
        for m in models:
            if ALTERNATE.search(m['name']) and (has_main or s['number'] not in ALTERNATE_ONLY_OK):
                continue
            if (s['number'], m['name']) in SKIP_MODELS:
                continue
            out.append(Source(s['number'], s['name'], int(s['year']), s['theme'], m['name'],
                              DATA / 'mpd' / m['url'].rsplit('/', 1)[1], m['url'], s['page'], 'omr'))
    proc = DATA / 'procedural' / 'procedural.json'
    if proc.exists():
        for p in json.loads(proc.read_text()):
            out.append(Source(p['id'], p['name'], p['year'], p['theme'], 'Main Model', DATA / 'procedural' / p['file'],
                              None, p.get('url'), 'procedural', p['evidence']))
    return out


def main() -> None:
    lib = Library(DATA / 'lib' / 'ldraw')
    builder = SetBuilder(lib)
    OUT.mkdir(parents=True, exist_ok=True)
    catalogue: dict[str, dict] = {}
    report = []
    only = set(sys.argv[1:])
    for src in sources():
        if only and src.set_id not in only:
            continue
        found, files = builder.vehicles(src)
        if not found:
            continue
        authors, licence = model_meta(files)
        st = catalogue.setdefault(src.set_id, {
            'id': src.set_id, 'name': src.name, 'year': src.year, 'theme': src.theme,
            'power': 'none', 'gauge': found[0]['axles'][0].gauge,
            'source': ({'kind': 'omr', 'url': src.page, 'authors': [], 'license': licence or 'CC BY 2.0'}
                       if src.kind == 'omr' else {'kind': 'procedural', 'evidence': src.evidence, 'url': src.page}),
            'cars': []})
        if src.kind == 'omr':
            for a in authors:
                if a not in st['source']['authors']:
                    st['source']['authors'].append(a)
        measured = [(v, builder.measure(v)) for v in found]
        # Front direction: a consist leads with its (first) locomotive; every car then faces the
        # same way. Wagon-only sets keep the first car's own direction; FLIP overrides single cars.
        centres = np.array([np.mean([a.centre for a in v['axles']], axis=0) for v, _ in measured])
        locos = [k for k, (v, m) in enumerate(measured) if m['motor'] or kind_of(v['name'], False, 0) == 'loco']
        direction = measured[0][1]['fwd']
        if len(measured) > 1 and locos:
            proj = centres @ direction
            if proj[locos[0]] < np.median(proj):
                direction = -direction
        for v, m in measured:
            if m['fwd'] @ direction < 0:
                m = flip(m)
            raw = v['name']
            name = NAMES.get((src.set_id, raw), raw)
            generic = bool(GENERIC.match(name))
            kind = kind_of('' if generic else name, bool(m['motor']), m['windows'],
                           src.name if len(measured) == 1 else '')
            if generic:
                name = {'loco': 'Locomotive', 'coach': 'Coach', 'tender': 'Tender', 'caboose': 'Caboose'}.get(kind, 'Wagon')
            names = [c['name'] for c in st['cars']]
            if name in names:
                k = 2
                while f'{name} {k}' in names:
                    k += 1
                name = f'{name} {k}'
            car_id = f"{src.set_id}/{slug(name)}"
            if car_id in FLIP:
                m = flip(m)
            if m['motor']:
                st['power'] = m['motor'] if st['power'] == 'none' else st['power']
            asset = f"trains/{src.set_id}/{slug(name)}.glb"
            (OUT / src.set_id).mkdir(parents=True, exist_ok=True)
            tri, size, final = export_car(lib, m, OUT / src.set_id / f'{slug(name)}.glb')
            fl, fh = m['lo'], m['hi']  # full-resolution geometry, before culling and simplification
            car = {
                'id': car_id, 'name': name,
                'kind': kind,
                'motorised': bool(m['motor']), 'asset': asset,
                'length': round(float(max(m['couplers']['front'], fh[0]) - min(m['couplers']['rear'], fl[0])), 1),
                'width': round(float(fh[1] - fl[1]), 1),
                'height': round(float(fh[2]), 1),
                'bogies': [round(p, 1) for p in m['pivots']],
                'wheelbase': round(m['pivots'][-1] - m['pivots'][0], 1),
                'couplers': {'front': round(m['couplers']['front'], 1), 'rear': round(m['couplers']['rear'], 1)},
                'outline': outline(final),
                'triangles': tri, 'bytes': size,
            }
            st['cars'].append(car)
            report.append({'set': src.set_id, 'car': car_id, 'contacts': m['contacts'], 'wheel_y': m['wheel_y'],
                           'axles_x': m['axles_x'], 'coupler_found': m['coupler_found'], 'gauge': m['gauge'],
                           'model': src.model})
            print(f"{car_id:48s} {car['kind']:7s} L{car['length']:6.1f} W{car['width']:5.1f} H{car['height']:5.1f} "
                  f"bogies {car['bogies']} cpl {car['couplers']} tris {tri} {size // 1024}KB", flush=True)
    sets = list(catalogue.values())
    if only and (OUT / 'index.json').exists():  # partial rebuild: keep the other sets
        built = {s['id'] for s in sets}
        sets += [s for s in json.loads((OUT / 'index.json').read_text())['sets'] if s['id'] not in built]
    sets.sort(key=lambda s: (s['year'], s['id']))
    index = {'version': 1, 'sets': sets}
    (OUT / 'index.json').write_text(json.dumps(index, indent=1) + '\n')
    (DATA / 'build_report.json').write_text(json.dumps(report, indent=1))
    write_attribution(sets)
    print(f"{len(sets)} sets, {sum(len(s['cars']) for s in sets)} cars")


def write_attribution(sets: list[dict]) -> None:
    lines = ['# Train models: attribution', '',
             'The train models in this folder are converted from LDraw files.', '',
             'LEGO® is a trademark of the LEGO Group, which does not sponsor, authorize or endorse Plateway.', '',
             'Official set models come from the LDraw.org Official Model Repository (OMR,',
             f'{OMR}/omr). OMR models are redistributable under the Creative Commons Attribution 2.0',
             'licence (CCAL / CC BY 2.0, https://creativecommons.org/licenses/by/2.0/). Part geometry comes',
             f'from the LDraw parts library ({OMR}/library/updates/complete.zip), same licence.',
             'Changes made here: cars split per vehicle, studs dropped, low-resolution primitives,',
             'meshes simplified, converted to glTF in a millimetre car frame.', '']
    lines += ['| Set | Name | Source | Authors | Licence |', '|---|---|---|---|---|']
    for s in sets:
        src = s['source']
        if src['kind'] == 'omr':
            lines.append(f"| {s['id']} | {s['name']} | [OMR]({src['url']}) | {', '.join(src['authors'])} | {src['license']} |")
        else:
            lines.append(f"| {s['id']} | {s['name']} | procedural (not an LDraw model) | — | built from LDraw parts library geometry; see evidence below |")
    proc = [s for s in sets if s['source']['kind'] != 'omr']
    if proc:
        lines += ['', '## Procedural models', '']
        for s in proc:
            lines += [f"### {s['id']} {s['name']}", '', s['source']['evidence'], '']
    (OUT / 'ATTRIBUTION.md').write_text('\n'.join(lines) + '\n')


if __name__ == '__main__':
    main()
