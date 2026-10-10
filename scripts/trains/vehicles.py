"""Find rail vehicles in an LDraw model and measure them in the catalogue's car frame.

Car frame (contract, public/trains/index.json): x forward (front coupler at +x), y left, z up, mm;
origin = midpoint between the outer bogie pivots, on the track centreline, at railhead top
(z = 0 where the wheel treads touch the rail).
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field

import numpy as np

from ldraw import LDU, Library, PartInstance

# Wheel parts and their tread (rail contact) radius in LDU, read from each part's LDraw geometry
# (radial profile of the part's vertices about its axle, local z). The flange is larger and sits
# below the railhead; the tread radius is what puts the wheel on the rail. Tyres and traction
# bands are listed as their own "wheels" because they are what touches the rail.
WHEELS: dict[str, float] = {
    '2879.dat': 21.0,     # Train Wheel with Open Centre for Wheel Bogie (9V era)
    '57878.dat': 21.0,    # Train Wheel with Closed Centre for Wheel Bogie
    '38340.dat': 21.0,    # Train Wheel with Pin for Wheel Bogie
    '2895.dat': 20.0,     # 9V motor wheel
    '55423.dat': 22.9,    # RC/IR train wheel with rubber ring (ring radius)
    'u9241.dat': 21.4,    # RC/IR train wheel without ring
    '867.dat': 20.0,      # 12V motor wheel
    '458.dat': 22.0,      # 12V motor tyre
    '458c01.dat': 22.0,   # 12V motor tyre, conically deformed
    '243.dat': 20.0, '244.dat': 20.0, '245.dat': 20.0, '447.dat': 21.5,   # 4.5V/12V era wheels
    'u9550.dat': 20.0,    # spoked wheel on steel axle (Train Base Type 1 wheelsets)
    '996.dat': 20.0,      # Train Wheel Small with Pin Axle Hole (4180c02)
    '995.dat': 28.0,      # Train Wheel Large with Pin Axle Hole (4180c01)
    '85489a.dat': 38.0, '85489b.dat': 38.0,   # Large drivers (flanged / blind)
    '85544.dat': 39.5,    # traction band on 85489a
    '90840.dat': 58.0,    # 50 mm driver
    '50254.dat': 10.0,    # Train Wheel Small (2010s wagons, e.g. 60052's cattle wagon)
    'u9186.dat': 12.0,    # monorail wheel 1.6 x 10 (runs on the beam top)
}
# 2927 'Train Wheel Tiny' is left out on purpose: in the OMR it only guides road-rail trucks.

TRACK = re.compile(r'^(Train Track|Monorail Track|~?Train Track|Track)', re.I)
COUPLER = re.compile(r'magnet|coupling|buffer beam|train buffer|hook', re.I)
MOTOR = re.compile(r'(train motor|monorail motor|power functions train motor)', re.I)
PRIMITIVE = re.compile(r'^(\d+-\d+|8/|48/|box|rect|tri|stu|edge|con|ring|cyl|disc|ndis|axl|peghole|connect|npeg|beam|logo|t\d|s/)', re.I)

UP = np.array([0.0, -1.0, 0.0])  # LDraw -Y is up


@dataclass
class Wheel:
    centre: np.ndarray  # LDU, root frame
    axis: np.ndarray    # unit, root frame
    radius: float       # tread radius, LDU
    part: int           # index of the owning PartInstance
    leaf: str


@dataclass
class Vehicle:
    node: str                     # submodel path key ('' = model root)
    name: str
    parts: list[int]              # PartInstance indices
    wheels: list[Wheel] = field(default_factory=list)


class WheelFinder:
    """Locate wheel leaf parts inside composite parts (wheelsets, motors, bogies)."""

    def __init__(self, lib: Library):
        self.lib = lib
        self.cache: dict[str, list[tuple[str, np.ndarray]]] = {}

    def leaves(self, name: str) -> list[tuple[str, np.ndarray]]:
        if name.endswith('#tris'):  # a submodel's own faces: no sub-files
            return []
        if name in WHEELS:
            return [(name, np.eye(4))]
        if name in self.cache:
            return self.cache[name]
        self.cache[name] = []
        f = self.lib.lookup(name)
        out: list[tuple[str, np.ndarray]] = []
        if f is not None:
            for r in f.refs:
                if PRIMITIVE.match(r.name) and r.name not in WHEELS:
                    continue
                out += [(leaf, r.matrix @ m) for leaf, m in self.leaves(r.name)]
        self.cache[name] = out
        return out


def wheels_of(instances: list[PartInstance], finder: WheelFinder) -> list[Wheel]:
    out = []
    for i, inst in enumerate(instances):
        for leaf, m in finder.leaves(inst.name):
            world = inst.matrix @ m
            axis = world[:3, 2] / np.linalg.norm(world[:3, 2])
            out.append(Wheel(world[:3, 3].copy(), axis, WHEELS[leaf], i, leaf))
    return out


@dataclass
class Axle:
    wheels: list[Wheel]
    gauge: str  # 'standard' | 'monorail'

    @property
    def centre(self) -> np.ndarray:
        return np.mean([w.centre for w in self.wheels], axis=0)

    @property
    def axis(self) -> np.ndarray:
        ref = self.wheels[0].axis
        acc = sum((w.axis if w.axis @ ref >= 0 else -w.axis) for w in self.wheels)
        return acc / np.linalg.norm(acc)


# Lateral spacing of the two wheel centres of one axle, LDU. Standard brick gauge puts the
# rail centres 40 mm (100 LDU) apart. Wheel part origins are not always on the wheel's mid-plane,
# so the origin spacing is 80 LDU (9V motor), 100 LDU (9V/RC/IR wheelsets) or up to ~125 LDU
# (12V motor wheel+tyre pairs). Monorail wheels sit 56.4 LDU apart.
STANDARD_SPACING = (70.0, 130.0)
MONORAIL_SPACING = (50.0, 62.0)


def pair_axles(wheels: list[Wheel]) -> list[Axle]:
    """Union wheels that share an axle line (parallel axes, centres on a common line)."""
    parent = list(range(len(wheels)))

    def find(i: int) -> int:
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    for i, a in enumerate(wheels):
        for j in range(i + 1, len(wheels)):
            b = wheels[j]
            if abs(a.axis @ b.axis) < 0.98:
                continue
            d = b.centre - a.centre
            off = d - (d @ a.axis) * a.axis
            if np.linalg.norm(off) < 6.0 and abs(d @ a.axis) < 140.0:
                parent[find(j)] = find(i)
    groups: dict[int, list[Wheel]] = {}
    for i, w in enumerate(wheels):
        groups.setdefault(find(i), []).append(w)
    out = []
    for g in groups.values():
        ax = g[0].axis
        ys = [w.centre @ ax for w in g]
        spread = max(ys) - min(ys)
        monorail = all(w.leaf == 'u9186.dat' for w in g)
        lo, hi = MONORAIL_SPACING if monorail else STANDARD_SPACING
        if lo <= spread <= hi and abs(ax @ UP) < 0.05:
            out.append(Axle(g, 'monorail' if monorail else 'standard'))
    return out


def car_axes(axles_: list[Axle]) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """(forward, left, up) unit vectors in the LDraw root frame for a car's axles; forward sign arbitrary.

    Forward is the principal direction of the axle centres (the chord of a car standing on a
    curve or a ramp in the model), left the mean axle direction made square to it, up their
    cross product turned to point up."""
    ref = axles_[0].axis
    lat = sum((a.axis if a.axis @ ref >= 0 else -a.axis) for a in axles_)
    # Rail contact points (wheel radii differ: drivers vs pony trucks), not axle centres.
    centres = np.array([np.mean([w.centre - w.radius * UP for w in a.wheels], axis=0) for a in axles_])
    if len(axles_) >= 2 and np.ptp(centres, axis=0).max() > 1.0:
        fwd = np.linalg.svd(centres - centres.mean(0))[2][0]
    else:
        fwd = np.cross(lat, UP)
    fwd /= np.linalg.norm(fwd)
    lat = lat - (lat @ fwd) * fwd
    lat /= np.linalg.norm(lat)
    up = np.cross(fwd, lat)
    if up @ UP < 0:
        lat, up = -lat, -up
    return fwd, lat, up


def frame_axes(axles_: list[Axle]) -> tuple[np.ndarray, np.ndarray]:
    """(forward, left) unit vectors in the LDraw root frame for a group of axles; forward sign arbitrary."""
    fwd, left, _ = car_axes(axles_)
    return fwd, left


@dataclass
class Node:
    key: tuple[str, ...]
    parts: list[int] = field(default_factory=list)       # all PartInstances in the subtree
    axles: list[int] = field(default_factory=list)       # all axles (indices) in the subtree
    children: list[tuple[str, ...]] = field(default_factory=list)


def build_tree(instances: list[PartInstance], axles_: list[Axle]) -> dict[tuple[str, ...], Node]:
    nodes: dict[tuple[str, ...], Node] = {(): Node(())}
    for i, inst in enumerate(instances):
        for k in range(len(inst.path) + 1):
            key = inst.path[:k]
            if key not in nodes:
                nodes[key] = Node(key)
                nodes[key[:-1]].children.append(key)
            nodes[key].parts.append(i)
    for ai, a in enumerate(axles_):
        paths = [instances[w.part].path for w in a.wheels]
        common = paths[0]
        for p in paths[1:]:
            n = 0
            while n < min(len(common), len(p)) and common[n] == p[n]:
                n += 1
            common = common[:n]
        for k in range(len(common) + 1):
            nodes[common[:k]].axles.append(ai)
    return nodes


def extent(node: Node, instances: list[PartInstance], axles_: list[Axle]) -> float:
    """Length (LDU) of the node's part origins along its own track direction."""
    if not node.axles:
        return 0.0
    fwd, _ = frame_axes([axles_[i] for i in node.axles])
    s = [instances[i].matrix[:3, 3] @ fwd for i in node.parts if not instances[i].name.endswith('#tris')]
    return (max(s) - min(s)) if s else 0.0


# A submodel is a separate vehicle (rather than a bogie or a wheel frame) if it carries running
# gear and its parts spread at least 10 studs along the track.
VEHICLE_MIN_EXTENT = 200.0


def find_vehicles(instances: list[PartInstance], axles_: list[Axle],
                  nodes: dict[tuple[str, ...], Node], is_track) -> list[tuple[str, ...]]:
    """Submodel keys of the rail vehicles in a model ('()' = the whole model is one vehicle).

    A node splits into its vehicle-sized child submodels when those children cover the node's
    length along the track (a consist, or a set's main model wrapping one vehicle with figures,
    track or scenery beside it). Children that only cover part of it are bogies or wheel frames
    under a longer body, so the node itself is the vehicle. A single vehicle-sized child with many
    of the node's other parts standing on it (a crane on a wagon base) is a chassis, not the vehicle."""

    def coverage(node: Node, kids: list[Node]) -> float:
        fwd, left = frame_axes([axles_[i] for i in node.axles])
        centre_y = np.mean([axles_[i].centre @ left for i in node.axles])
        body = [instances[i].matrix[:3, 3] for i in node.parts
                if not is_track(instances[i].name) and not instances[i].name.endswith('#tris')]
        s = np.array([p @ fwd for p in body if abs(p @ left - centre_y) <= 90.0])
        if len(s) == 0:
            return 1.0
        covered = np.zeros(len(s), dtype=bool)
        for k in kids:
            ks = [instances[i].matrix[:3, 3] @ fwd for i in k.parts]
            covered |= (s >= min(ks) - 20.0) & (s <= max(ks) + 20.0)
        return float(covered.mean())

    def riders(node: Node, kid: Node) -> int:
        """Other (non-track) parts of node that sit on kid's plan footprint, above its wheels."""
        fwd, left = frame_axes([axles_[i] for i in kid.axles])
        centre_y = np.mean([axles_[i].centre @ left for i in kid.axles])
        top = max(axles_[i].centre @ UP for i in kid.axles)
        ks = [instances[i].matrix[:3, 3] @ fwd for i in kid.parts]
        mine = set(kid.parts)
        n = 0
        for i in node.parts:
            if i in mine or is_track(instances[i].name):
                continue
            p = instances[i].matrix[:3, 3]
            if min(ks) <= p @ fwd <= max(ks) and abs(p @ left - centre_y) <= 70.0 and p @ UP > top:
                n += 1
        return n

    def visit(key: tuple[str, ...]) -> list[tuple[str, ...]]:
        node = nodes[key]
        kids = [nodes[k] for k in node.children
                if nodes[k].axles and extent(nodes[k], instances, axles_) >= VEHICLE_MIN_EXTENT]
        if len(kids) == 1 and riders(node, kids[0]) >= max(10, 0.25 * (len(node.parts) - len(kids[0].parts))):
            return [key]
        if kids and coverage(node, kids) >= 0.9:
            return [v for k in kids for v in visit(k.key)]
        return [key] if node.axles else []

    return visit(())
