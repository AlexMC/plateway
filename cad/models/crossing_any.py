"""Fixed junction track: diamond crossings at any angle, straight x curve
crossings and gauntlet (interlaced) track; dimensions are millimetres.

No moving parts: every route is always open and trains share the crossing.

Frogs. The rails of every route are united, then every route's wheel-flange
corridor (track_assembly's flangeway: 2.2 mm inside each rail, 3.2 mm deep) is
cut from all of them. That leaves the frog gaps, noses and wing rails at any
angle. Where another route's corridor interrupts a rail's guiding face for
longer than GUIDE_LIMIT (below about 33 degrees), a check rail inside the
opposite rail holds the back of the other wheel's flange across the gap.

Base. Rail stringers and rigid 15.8 mm ties like ordinary track wherever one
route's 63.8 mm body stands alone. Where two routes' bodies overlap, a solid,
studless 3.2 mm crossing plate carries both (like 32087's central block or
53404's cover plate); ties that would reach into it are left out. Parts larger
than the usable mini bed are split along planned straight seams that pass
between ties (or through the plate), clear of frogs, check rails and connector
ends, and every seam is keyed with track_assembly's vertical dovetails.
Seat on a flat table or clutch at the end ties: the plate has no stud bays.

Fast print keeps rails, frogs, check rails, connectors, the plate and the
seams; stringers are solid and ties become gauge braces (lite.py).
"""
from __future__ import annotations

from functools import lru_cache
import math
from pathlib import Path

import cadquery as cq
import manifold3d
import numpy as np
import trimesh

from . import brick_end as end
from . import lite as fast
from . import track_assembly as ta

FAMILIES = ("track_diamond", "track_diamond_curve", "track_gauntlet")
COMPONENT_FAMILY = "crossing_component"
SHAPES = {
    "track_diamond": ("angle", "length", "cross"),
    "track_diamond_curve": ("angle", "length", "radius", "sweep"),
    "track_gauntlet": ("spacing", "offset", "entry", "length"),
}
CONNECTOR = frozenset({"connector_version", "fit_adjustment"})
SOURCE_DEPENDENCIES = [Path(ta.__file__), Path(fast.__file__),
                       Path(ta.__file__).resolve().parents[1] / "profiles/track-assemblies-v1.json"]

HALF = end.PROFILE["bodyWidth"] / 2                          # 31.9
RAIL = end.PROFILE["railGauge"] / 2                          # 20
FACE = RAIL - end.PROFILE["railInterfaceWidth"] / 2          # 18.8: a rail's guiding face
FLANGE = ta.FLANGE_CLEARANCE                                 # 2.2
BACK = FACE - FLANGE                                         # 16.6: flange back, check-rail face
BASE = end.PROFILE["baseThickness"]
END_TIE = end.PROFILE["endTieWidth"]
# Longest interruption of a guiding face a wheelset may cross unguided; the
# same 4 mm design gate as track_assembly's unsupported running-head span.
GUIDE_LIMIT = 4.0
CHECK_WIDTH, CHECK_LEAD, CHECK_FLARE = 2.0, 6.0, (4.0, 1.0)
CHECK_FOOT = RAIL - 2.7                                      # 17.3: stringer channel wall
BED = 166.0
PLAN_BED = 165.0
TONGUE = 4.0                                                 # contact lobes beyond a port face
MIN_ANGLE, WARN_ANGLE, MAX_ANGLE = 15.0, 22.5, 90.0
MIN_RADIUS, MAX_RADIUS = 192.0, 1472.0
FROG_CLEAR = 6.0          # seams stay this far from every rail crossing point (frog noses stay whole)
MIN_PART_AREA = 2000.0    # mm², no sliver parts
PLATE_REACH = 20.0
PLUG_HALF = 6.9           # plugged stringer half-width around a rail line at a seam
KEY_REACH = 4.4           # a dovetail key stands this far proud of its seam
END_ZONE = (-TONGUE - 1, 14.0)
MIN_SEAM_ANGLE = math.radians(30)
SAMPLE = 2.0


def _number(value) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def sbend(entry: float, offset: float) -> tuple[float, float]:
    """(radius, turn) of two equal opposite arcs shifting `offset` over `entry`."""
    turn = 2 * math.atan2(offset, entry)
    return entry / (2 * math.sin(turn)), turn


def _straight(point, heading, length):
    return np.array([(point[0], point[1], heading),
                     (point[0] + length*math.cos(heading), point[1] + length*math.sin(heading), heading)])


def _arc(point, heading, k, length):
    if abs(k) < 1e-12:
        return _straight(point, heading, length)
    t = np.linspace(0, length, max(2, math.ceil(length / SAMPLE)) + 1)
    h = heading + k*t
    return np.column_stack((point[0] + (np.sin(h) - math.sin(heading)) / k,
                            point[1] - (np.cos(h) - math.cos(heading)) / k, h))


def _chain(start, segments):
    parts, (x, y, h) = [], start
    for k, length in segments:
        if length <= 1e-9:
            continue
        piece = _arc((x, y), h, k, length)
        parts.append(piece if not parts else piece[1:])
        x, y, h = piece[-1]
    return np.vstack(parts)


def _rigid_ends(path):
    """Curved route ends blend into the straight 6 mm source contact lead (track_assembly._rigid_lead_out)."""
    if len(path) < 3:
        return path
    start = path[0, 2]
    path = ta._rigid_lead_out(path)
    flipped = path[::-1].copy()
    flipped[:, 2] += math.pi
    result = ta._rigid_lead_out(flipped)[::-1].copy()
    # The blends take headings from atan2; keep them continuous from the original start heading.
    result[:, 2] = np.unwrap(result[:, 2] - math.pi)
    result[:, 2] += 2*math.pi*round((start - result[0, 2]) / (2*math.pi))
    return result


def routes(family: str, p: dict) -> list[tuple[str, str, str, np.ndarray]]:
    """(path id, from port, to port, centre path [x, y, heading]) in the piece frame.

    Diamonds: route A ('main', in→out) runs along +x; route B ('crossing',
    cross-in→cross-out) crosses A's midpoint at `angle` (signed, + heads left),
    straight over `cross` or an arc of signed `radius` over `sweep` degrees.
    Gauntlet: 'main' (in→out) starts on y=0 and 'parallel' (parallel-in→
    parallel-out) on y=`spacing`; both S-bend over `entry` to centres `offset`
    apart, run interlaced for `length`, and S-bend back.
    """
    if family in FAMILIES[:2]:
        run, theta, middle = p["length"], math.radians(p["angle"]), p["length"] / 2
        rows = [("main", "in", "out", _straight((0., 0.), 0., run))]
        if family == FAMILIES[0]:
            half = p["cross"] / 2
            cross = _straight((middle - half*math.cos(theta), -half*math.sin(theta)), theta, p["cross"])
        else:
            k = math.copysign(1 / abs(p["radius"]), p["radius"])
            span = abs(p["radius"]) * math.radians(p["sweep"])
            h0 = theta - k*span/2
            cross = _arc((middle - (math.sin(theta) - math.sin(h0)) / k,
                          (math.cos(theta) - math.cos(h0)) / k), h0, k, span)
        return rows + [("crossing", "cross-in", "cross-out", _rigid_ends(cross))]
    spacing, entry = p["spacing"], p["entry"]
    side, shift = math.copysign(1, spacing), (abs(spacing) - p["offset"]) / 2
    radius, turn = sbend(entry, shift)
    arc = radius * turn
    rows = []
    for ident, a, b, y, sign in (("main", "in", "out", 0., side),
                                 ("parallel", "parallel-in", "parallel-out", spacing, -side)):
        k = sign / radius
        rows.append((ident, a, b, _rigid_ends(_chain((0., y, 0.), [(k, arc), (-k, arc), (0., p["length"]), (-k, arc), (k, arc)]))))
    return rows


def _port_rows(rows):
    """(id, point, outward heading, is the path's far end) of every port."""
    out = []
    for _, a, b, path in rows:
        out += [(a, path[0], float(path[0][2]) + math.pi, False), (b, path[-1], float(path[-1][2]), True)]
    return out


def _band_samples(path, step=1.):
    lengths = np.r_[0., np.cumsum(np.linalg.norm(np.diff(path[:, :2], axis=0), axis=1))]
    s = np.linspace(0, lengths[-1], max(2, math.ceil(lengths[-1] / step)) + 1)
    x, y, h = (np.interp(s, lengths, path[:, axis]) for axis in range(3))
    lateral = np.linspace(-HALF, HALF, 9)
    return np.column_stack(((x[:, None] - np.sin(h)[:, None]*lateral).ravel(),
                            (y[:, None] + np.cos(h)[:, None]*lateral).ravel()))


def corridor_problem(rows) -> str | None:
    """Why another route's body would reach into the track joined at a port, or None.

    The joined track is taken to continue straight out of the port, 63.8 mm wide.
    """
    for ident, point, heading, _ in _port_rows(rows):
        c, s = math.cos(heading), math.sin(heading)
        owner = next(path_id for path_id, a, b, _ in rows if ident in (a, b))
        for other, _, _, path in rows:
            if other == owner:
                continue
            q = _band_samples(path) - point[:2]
            u, v = q[:, 0]*c + q[:, 1]*s, -q[:, 0]*s + q[:, 1]*c
            if np.any((u > .5) & (np.abs(v) < HALF - .5)):
                return f"the {other} route reaches the track joined at {ident}; lengthen the legs"
    return None


def validate(family: str, p: dict) -> None:
    if family not in FAMILIES:
        raise ValueError("unknown crossing family")
    if set(p) - {"lite"} != CONNECTOR | set(SHAPES[family]):
        raise ValueError(f"{family} requires exactly {sorted(CONNECTOR | set(SHAPES[family]))}")
    fast.validate(p)
    if not all(_number(value) for value in p.values()):
        raise ValueError("crossing parameters must be finite numbers")
    end.validate(p)
    if family in FAMILIES[:2]:
        if not MIN_ANGLE - 1e-9 <= abs(p["angle"]) <= MAX_ANGLE + 1e-9:
            raise ValueError("crossing angle must be 15 to 90 degrees")
        if not 64 <= p["length"] <= 1024:
            raise ValueError("crossing length must be 64 to 1024 mm")
    if family == FAMILIES[0] and not 64 <= p["cross"] <= 1024:
        raise ValueError("crossing leg must be 64 to 1024 mm")
    if family == FAMILIES[1]:
        if not MIN_RADIUS <= abs(p["radius"]) <= MAX_RADIUS:
            raise ValueError("crossing curve radius must be 192 to 1472 mm")
        if not 5 <= p["sweep"] <= 90:
            raise ValueError("crossing curve must turn 5 to 90 degrees")
    if family == FAMILIES[2]:
        if not 64 <= abs(p["spacing"]) <= 256 or not 8 <= p["offset"] <= 24:
            raise ValueError("gauntlet spacing must be 64 to 256 mm and offset 8 to 24 mm")
        if not 128 <= p["entry"] <= 1024 or not 0 <= p["length"] <= 1024:
            raise ValueError("gauntlet entry must be 128 to 1024 mm and length 0 to 1024 mm")
        if sbend(p["entry"], (abs(p["spacing"]) - p["offset"]) / 2)[0] < MIN_RADIUS:
            raise ValueError("gauntlet entry is tighter than R24; lengthen it")
    problem = corridor_problem(routes(family, p))
    if problem:
        raise ValueError(problem)


def ports(family: str, p: dict) -> list[dict]:
    validate(family, p)
    return [{"id": ident, "position": [float(point[0]), float(point[1]), 0.], "heading": heading, "pitch": 0.,
             "rail_gauge": 40., "rail_interface_width": 2.4} for ident, point, heading, _ in _port_rows(routes(family, p))]


def route_pairs(family: str, p: dict) -> dict[frozenset, bool]:
    return {frozenset((a, b)): True for _, a, b, _ in routes(family, p)}


# ---------------------------------------------------------------- geometry helpers

def _dense(path, step=.25):
    lengths = np.r_[0., np.cumsum(np.linalg.norm(np.diff(path[:, :2], axis=0), axis=1))]
    s = np.arange(0., lengths[-1] + 1e-9, step)
    return s, np.column_stack([np.interp(s, lengths, path[:, axis]) for axis in range(3)]), float(lengths[-1])


def _normals(points):
    return np.column_stack((-np.sin(points[:, 2]), np.cos(points[:, 2])))


def _project(query, points):
    """Lateral offset of each query point from a densely sampled path, and whether it lies beside it."""
    lateral = np.empty(len(query))
    beside = np.empty(len(query), dtype=bool)
    tangent = np.column_stack((np.cos(points[:, 2]), np.sin(points[:, 2])))
    normal = _normals(points)
    for start in range(0, len(query), 512):
        q = query[start:start+512]
        d = np.linalg.norm(q[:, None, :] - points[None, :, :2], axis=2)
        j = np.argmin(d, axis=1)
        offset = q - points[j, :2]
        lateral[start:start+512] = np.einsum("ij,ij->i", offset, normal[j])
        along = np.einsum("ij,ij->i", offset, tangent[j])
        beside[start:start+512] = ((j > 0) | (along > -.3)) & ((j < len(points)-1) | (along < .3))
    return lateral, beside


def _runs(mask, s):
    """(start, end) stations of every True run."""
    edges = np.flatnonzero(np.diff(np.r_[0, mask.astype(int), 0]))
    return [(float(s[a]), float(s[b-1])) for a, b in zip(edges[::2], edges[1::2])]


def guide_gaps(rows) -> list[dict]:
    """Every stretch where another route's flange corridor interrupts a rail's guiding face.

    `rail` is +1 (left) or -1; stations are centreline arc length of `route`."""
    dense = [_dense(path) for *_, path in rows]
    gaps = []
    for index, (s, points, _) in enumerate(dense):
        for rail in (-1, 1):
            face = points[:, :2] + _normals(points)*rail*FACE
            cut = np.zeros(len(s), dtype=bool)
            for other, (_, others, _) in enumerate(dense):
                if other != index:
                    lateral, beside = _project(face, others)
                    cut |= beside & (np.abs(lateral) >= BACK - 1e-6) & (np.abs(lateral) <= FACE + 1e-6)
            gaps += [{"route": index, "rail": rail, "s0": a, "s1": b, "length": b - a} for a, b in _runs(cut, s)]
    return gaps


def check_rails(rows, limit=GUIDE_LIMIT) -> list[dict]:
    """Check rails (route, rail, s0, s1) opposite every guiding-face gap longer than `limit`."""
    lengths = [_dense(path, 1.)[2] for *_, path in rows]
    specs = []
    for gap in guide_gaps(rows):
        if gap["length"] <= limit:
            continue
        length = lengths[gap["route"]]
        lo, hi = max(gap["s0"]-CHECK_LEAD, END_ZONE[1]), min(gap["s1"]+CHECK_LEAD, length-END_ZONE[1])
        if hi - lo < 2*CHECK_FLARE[0]:
            continue
        spec = {"route": gap["route"], "rail": -gap["rail"], "s0": lo, "s1": hi}
        for other in specs:
            if (other["route"], other["rail"]) == (spec["route"], spec["rail"]) and lo <= other["s1"] and other["s0"] <= hi:
                other["s0"], other["s1"] = min(other["s0"], lo), max(other["s1"], hi)
                break
        else:
            specs.append(spec)
    return specs


def rail_crossings(rows) -> list[dict]:
    """Every point where two routes' rail lines cross: stations, rails and crossing angle (radians, 0..pi/2]."""
    lines = []
    for index, (*_, path) in enumerate(rows):
        s, points, _ = _dense(path, 1.)
        for rail in (-1, 1):
            lines.append((index, rail, s, points[:, :2] + _normals(points)*rail*RAIL, points[:, 2]))
    found = []
    for i, (ra, sa_rail, sa, a, ha) in enumerate(lines):
        for rb, sb_rail, sb, b, hb in lines[i+1:]:
            if ra == rb:
                continue
            p, r = a[:-1], a[1:] - a[:-1]
            q, t = b[:-1], b[1:] - b[:-1]
            cross = r[:, None, 0]*t[None, :, 1] - r[:, None, 1]*t[None, :, 0]
            qp = q[None, :, :] - p[:, None, :]
            with np.errstate(divide="ignore", invalid="ignore"):
                u = (qp[..., 0]*t[None, :, 1] - qp[..., 1]*t[None, :, 0]) / cross
                v = (qp[..., 0]*r[:, None, 1] - qp[..., 1]*r[:, None, 0]) / cross
            hits = np.argwhere((np.abs(cross) > 1e-12) & (u >= 0) & (u < 1) & (v >= 0) & (v < 1))
            for j, k in hits:
                angle = abs(math.remainder(float(ha[j] - hb[k]), math.pi))
                found.append({"point": tuple(p[j] + u[j, k]*r[j]), "a": ra, "b": rb, "rail_a": sa_rail, "rail_b": sb_rail,
                              "station_a": float(sa[j] + u[j, k]*(sa[j+1]-sa[j])),
                              "station_b": float(sb[k] + v[j, k]*(sb[k+1]-sb[k])), "angle": angle})
    return found


def flangeway_cutters(rows):
    """Every route's wheel-flange corridors (track_assembly's flangeway solids)."""
    return ta._flangeways([path for *_, path in rows])


def _station_points(path, stations):
    lengths = np.r_[0., np.cumsum(np.linalg.norm(np.diff(path[:, :2], axis=0), axis=1))]
    return np.column_stack([np.interp(stations, lengths, path[:, axis]) for axis in range(3)])


def check_rail_mesh(rows, specs) -> list[trimesh.Trimesh]:
    """Check rail solids: a 2 mm head flush with the rail top whose face flares 1 mm
    over its last 4 mm, on a foot bonded to the running rail's stringer wall."""
    meshes = []
    for spec in specs:
        path = rows[spec["route"]][3]
        stations = np.linspace(spec["s0"], spec["s1"], max(8, math.ceil((spec["s1"]-spec["s0"]) / .5)) + 1)
        points = _station_points(path, stations)
        normal, rail = _normals(points), spec["rail"]
        edge = np.minimum(stations - spec["s0"], spec["s1"] - stations)
        face = BACK - CHECK_FLARE[1]*np.clip(1 - edge/CHECK_FLARE[0], 0, 1)
        inner = points[:, :2] + normal*rail*(BACK - CHECK_WIDTH)
        head = np.vstack([inner, (points[:, :2] + normal*rail*face[:, None])[::-1]])
        foot = np.vstack([inner, (points[:, :2] + normal*rail*CHECK_FOOT)[::-1]])
        meshes += [ta._polygon(head, 1.9, end.RAIL_TOP), ta._polygon(foot, 1.9, 6.3)]
    return meshes


def junction_rails(rows, specs=None) -> trimesh.Trimesh:
    """Rails of every route plus check rails, less every route's flange corridors."""
    specs = check_rails(rows) if specs is None else specs
    rails = ta._union([ta._rails(path) for *_, path in rows] + check_rail_mesh(rows, specs))
    return ta._difference(rails, flangeway_cutters(rows))


# ---------------------------------------------------------------- layout and seams

def _cs_mesh(section, low, high):
    if section.is_empty():
        return None
    mesh = section.extrude(high - low).to_mesh()
    result = trimesh.Trimesh(mesh.vert_properties[:, :3], mesh.tri_verts, process=True)
    result.apply_translation((0, 0, low))
    return result


def _circle(point, radius):
    return manifold3d.CrossSection.circle(radius, 48).translate(tuple(point))


def _extend(path, length):
    a, b = path[0], path[-1]
    return np.vstack([(a[0]-length*math.cos(a[2]), a[1]-length*math.sin(a[2]), a[2]), path,
                      (b[0]+length*math.cos(b[2]), b[1]+length*math.sin(b[2]), b[2])])


def _inward_frame(point, heading):
    return end._frame((float(point[0]), float(point[1]), 0), heading + math.pi, 0)


def _union_cs(sections):
    result = manifold3d.CrossSection()
    for section in sections:
        result += section
    return result


def _strip(path, lateral, half):
    """Cross-section of a band at `lateral` from a path, `half` either side."""
    normal = _normals(path)
    return ta._section(np.vstack([path[:, :2] + normal*(lateral-half), (path[:, :2] + normal*(lateral+half))[::-1]]))


def _parts(section):
    """Nonempty connected parts of a cross-section."""
    return [part for part in section.decompose() if not part.is_empty() and part.area() > 1e-6]


def _vertices(section):
    return np.vstack([np.asarray(polygon) for polygon in section.to_polygons() if len(polygon)])


class Layout:
    """Everything the solids need, derived once per shape."""

    def __init__(self, family, shape):
        p = dict(shape)
        self.family, self.rows = family, routes(family, p)
        self.paths = [path for *_, path in self.rows]
        self.ports = _port_rows(self.rows)
        bands = [ta._band(path, HALF) for path in self.paths]
        overlaps = _union_cs([bands[i] ^ bands[j] for i in range(len(bands)) for j in range(i+1, len(bands))])
        # The plate reaches PLATE_REACH beyond the overlap so no stringer is left standing beside it.
        self.plate = overlaps.offset(PLATE_REACH) ^ _union_cs(bands) if not overlaps.is_empty() else overlaps
        self.checks = check_rails(self.rows)
        self.crossings = rail_crossings(self.rows)
        self.ties = []
        for route, path in enumerate(self.paths):
            for low, high in end.tie_intervals(ta._length(path))[1:-1]:
                frame = ta._path_frame(path, (low+high)/2)
                if not ta._overlaps(ta._rect(frame, -7.9, 7.9, -HALF, HALF), self.plate):
                    self.ties.append((route, (low+high)/2, frame))
        # What actually carries material: plate, stringers (and contacts beyond each port), ties, end ties.
        self.footprint = _union_cs(
            [self.plate] + [_strip(_extend(path, TONGUE), lateral, end.PROFILE["baseStringerWidth"]/2)
                            for path in self.paths for lateral in (-RAIL, RAIL)]
            + [ta._rect(frame, -7.9, 7.9, -HALF, HALF) for _, _, frame in self.ties]
            + [ta._rect(_inward_frame(point, heading), 0, END_TIE, -HALF, HALF) for _, point, heading, _ in self.ports])
        self.seams = self._plan()
        self.sites = self._sites()

    # -- forbidden zones for seams
    def _forbidden(self):
        zones = [ta._rect(_inward_frame(point, heading), *END_ZONE, -HALF-1, HALF+1) for _, point, heading, _ in self.ports]
        for crossing in self.crossings:
            zones.append(_circle(crossing["point"], FROG_CLEAR))
        zones += [self._check_zone(spec) for spec in self.checks]
        return _union_cs(zones)

    def _check_zone(self, spec):
        path = self.paths[spec["route"]]
        points = _station_points(path, np.linspace(spec["s0"]-2, spec["s1"]+2, 40))
        normal = _normals(points)*spec["rail"]
        return ta._section(np.vstack([points[:, :2] + normal*(BACK-CHECK_WIDTH-3), (points[:, :2] + normal*(RAIL+4))[::-1]]))

    def _rail_lines(self):
        lines = []
        for path in self.paths:
            _, points, _ = _dense(path, 1.)
            for rail in (-1, 1):
                lines.append((points[:, :2] + _normals(points)*rail*RAIL, points[:, 2]))
        return lines

    def _in_plate(self, point):
        return (self.plate ^ manifold3d.CrossSection.square((.2, .2), True).translate(tuple(point))).area() > .039

    def _crossings_of(self, a, b, lines):
        """(point, rail heading) where segment a-b crosses a rail line."""
        hits = []
        for line, headings in lines:
            p, r = line[:-1], line[1:] - line[:-1]
            d = b - a
            cross = r[:, 0]*d[1] - r[:, 1]*d[0]
            qp = a - p
            with np.errstate(divide="ignore", invalid="ignore"):
                u = (qp[:, 0]*d[1] - qp[:, 1]*d[0]) / cross
                v = (qp[:, 0]*r[:, 1] - qp[:, 1]*r[:, 0]) / cross
            for j in np.flatnonzero((np.abs(cross) > 1e-12) & (u >= 0) & (u < 1) & (v >= 0) & (v <= 1)):
                hits.append((p[j] + u[j]*r[j], float(headings[j])))
        return hits

    def _segments(self, component, point, direction):
        """Seam segments of a straight line through a footprint component."""
        reach = 4000.
        a, b = point - direction*reach, point + direction*reach
        pieces = _parts(component ^ ta._section(ta._segment_quad(a, b, .1)))
        segments = []
        for piece in pieces:
            polygon = _vertices(piece)
            along = (polygon - point) @ direction
            lo, hi = along.min() + .1, along.max() - .1
            if hi - lo > 1:
                segments.append((point + direction*lo, point + direction*hi))
        return segments

    def _valid(self, segments, forbidden, ties, lines):
        for a, b in segments:
            if (ta._section(ta._segment_quad(a, b, .4)) ^ forbidden).area() > 1e-6:
                return False
            direction = (b - a) / np.linalg.norm(b - a)
            normal = np.array([direction[1], -direction[0]])
            hits = self._crossings_of(a, b, lines)
            for point, heading in hits:
                if abs(math.sin(math.atan2(direction[1], direction[0]) - heading)) < math.sin(MIN_SEAM_ANGLE):
                    return False
                # A plugged stringer and its dovetail stay clear of every tie.
                plug = ta._section([point + normal*u + direction*v for u, v in ((-5.8, -6.5), (5.8, -6.5), (5.8, 6.5), (-5.8, 6.5))])
                if not self._in_plate(point) and (plug ^ ties).area() > 1e-6:
                    return False
            if not any(not self._in_plate(point) for point, _ in hits) and not self._plate_sites(a, b):
                return False
        return True

    def _plate_sites(self, a, b):
        direction = (b - a) / np.linalg.norm(b - a)
        normal = np.array([direction[1], -direction[0]])
        return [a + direction*t for t in np.arange(4., np.linalg.norm(b - a) - 3.9, 8.)
                if all(self._in_plate(a + direction*t + normal*k) for k in (-6, 6))]

    def _candidates(self, component, axis, low, high):
        """Straight cuts across the component, and sets of cuts square to each route in one of its tie gaps."""
        direction = np.array([0., 1.]) if axis == 0 else np.array([1., 0.])
        for t in np.arange(low + 8, high - 8, 1.):
            point = np.array([t, 0.]) if axis == 0 else np.array([0., t])
            yield self._segments(component, point, direction)
        seen = set()
        for t in np.arange(low + 8, high - 8, 2.):
            chosen = []
            for route, gaps in enumerate(self._gaps):
                near = min(range(len(gaps)), key=lambda i: abs(gaps[i][0][axis] - t), default=None)
                if near is not None and abs(gaps[near][0][axis] - t) <= 24:
                    chosen.append((route, near))
            if not chosen or tuple(chosen) in seen:
                continue
            seen.add(tuple(chosen))
            yield [segment for route, index in chosen
                   for segment in self._segments(component ^ (self._bands[route] - self.plate.offset(1.)), *self._gaps[route][index])]

    def _plan(self):
        ties = _union_cs([ta._rect(frame, -8.2, 8.2, -HALF-.3, HALF+.3) for _, _, frame in self.ties])
        forbidden, lines = _union_cs([self._forbidden(), ties]), self._rail_lines()
        self._bands = [ta._band(_extend(path, TONGUE), HALF + .3) for path in self.paths]
        self._gaps = []
        for path in self.paths:
            intervals, rows = end.tie_intervals(ta._length(path)), []
            for (_, high), (low, _) in zip(intervals[:-1], intervals[1:]):
                x, y, h = _station_points(path, [(high + low) / 2])[0]
                rows.append((np.array([x, y]), np.array([-math.sin(h), math.cos(h)])))
            self._gaps.append(rows)

        def zone(segments):
            return _union_cs([ta._section(ta._segment_quad(a, b, KEY_REACH)) for a, b in segments])

        def extent(part, keys):
            # A seam's dovetail keys may stand up to KEY_REACH proud of the part edge.
            x0, y0, x1, y1 = (part + (keys ^ part.offset(KEY_REACH + .1))).bounds()
            return max(x1 - x0, y1 - y0)

        seams, pending, keys = [], _parts(self.footprint), manifold3d.CrossSection()
        while pending:
            component = pending.pop()
            if extent(component, keys) <= PLAN_BED:
                continue
            x0, y0, x1, y1 = component.bounds()
            axis = 0 if x1 - x0 >= y1 - y0 else 1
            low, high = (x0, y0)[axis], (x1, y1)[axis]
            best = None
            for segments in self._candidates(component, axis, low, high):
                if not segments or not self._valid(segments, forbidden, ties, lines):
                    continue
                kerf = _union_cs([ta._section(ta._segment_quad(a, b, .1)) for a, b in segments])
                parts = _parts(component - kerf)
                if len(parts) < 2 or any(part.area() < MIN_PART_AREA for part in parts):
                    continue
                with_keys = keys + zone(segments)
                sizes = [extent(part, with_keys) for part in parts]
                # Pieces short of the component's far end are the ones this cut completes.
                lower = [(part.bounds(), size) for part, size in zip(parts, sizes) if part.bounds()[2 + axis] < high - 1e-6]
                fits = bool(lower) and all(size <= PLAN_BED for _, size in lower)
                reach = max((box[2 + axis] for box, _ in lower), default=low) - low
                score = (1, reach) if fits else (0, -max(sizes))
                if best is None or score > best[0]:
                    best = (score, segments, parts)
            if best is None:
                raise ValueError(f"{self.family}: no seam between ties splits this shape to the bed; change its size")
            seams += best[1]
            keys += zone(best[1])
            pending += best[2]
        return seams

    def _sites(self):
        """Key sites (point, seam normal, plugged, along-seam span of its segment): plugged stringers where
        a seam crosses a rail line outside the plate, and 8 mm stations along seams through the plate."""
        lines = self._rail_lines()
        candidates = []
        for a, b in self.seams:
            direction = (b - a) / np.linalg.norm(b - a)
            normal = np.array([direction[1], -direction[0]])
            span = lambda point: ((a - point) @ direction, (b - point) @ direction)
            candidates += [(point, normal, True, span(point)) for point, _ in self._crossings_of(a, b, lines) if not self._in_plate(point)]
            candidates += [(point, normal, False, span(point)) for point in self._plate_sites(a, b)]

        def distance(point, a, b):
            t = np.clip(np.dot(point-a, b-a)/np.dot(b-a, b-a), 0, 1)
            return np.linalg.norm(point-a-t*(b-a))

        sites = []
        for point, normal, plugged, span in candidates:
            others = [distance(point, a, b) for a, b in self.seams if distance(point, a, b) > 1e-6]
            if any(np.linalg.norm(point-other[0]) < 6.5 for other in sites) or min(others, default=99) < 5.5:
                continue
            sites.append((point, normal, plugged, span))
        return sites


@lru_cache(maxsize=16)
def layout(family: str, shape: tuple) -> Layout:
    return Layout(family, shape)


def _shape(family, p):
    return tuple((key, float(p[key])) for key in SHAPES[family])


def _clutch_plan(lay):
    bands = [ta._band(path, ta.ROUTE_KEEP_OUT) for path in lay.paths]
    blocked = _union_cs([ta._section(ta._segment_quad(a, b, .9)) for a, b in lay.seams])
    accepted = _union_cs([ta._rect(_inward_frame(point, heading), 0, END_TIE, -HALF, HALF)
                          for _, point, heading, _ in lay.ports])
    plan = []
    for route, station, frame in lay.ties:
        columns, footprints = [], []
        for low, high, group in ta.CLUTCH_GROUPS:
            footprint = ta._rect(frame, -7.9, 7.9, low, high)
            if any(ta._overlaps(footprint, band) for other, band in enumerate(bands) if other != route):
                continue
            if ta._overlaps(footprint, blocked) or ta._overlaps(footprint, accepted):
                continue
            columns += group
            footprints.append(footprint)
        for footprint in footprints:
            accepted += footprint
        plan.append((route, station, frame, tuple(sorted(columns))))
    return plan


def _port_dict(ident, point, heading):
    return {"id": ident, "position": [float(point[0]), float(point[1]), 0.], "heading": heading}


@lru_cache(maxsize=8)
def _fixed_mesh(family, shape, adjustment, lite=False):
    lay = layout(family, shape)
    paths = lay.paths
    width = HALF
    bodies = [ta._ribbon(path, y, end.PROFILE["baseStringerWidth"]/2, 0, BASE) for path in paths for y in (-RAIL, RAIL)]
    if lite:
        bodies += [fast.brace(frame, fast.RAIL_BAND[0] + fast.BRACE_OVERLAP) for _, _, frame in lay.ties]
    else:
        bodies += [ta._placed([end._box((-7.9, -width, 0), (7.9, width, BASE))], frame)[0] for _, _, frame in lay.ties]
    for _, point, heading, _ in lay.ports:
        bodies += ta._placed([end._box((0, -width, 0), (END_TIE, width, BASE))], _inward_frame(point, heading))
    plate = _cs_mesh(lay.plate, 0, BASE)
    if plate is not None:
        bodies.append(plate)
    deck = ta._union(bodies)
    if not lite:
        webs = {route: [] for route in range(len(paths))}
        for route, _, frame in lay.ties:
            webs[route].append(frame)
        cuts, additions = [], []
        for _, _, frame, columns in _clutch_plan(lay):
            if columns:
                tie_cuts, tie_additions = end.tie_clutch(columns)
                cuts += ta._placed(tie_cuts, frame)
                additions += ta._placed(tie_additions, frame)
        zones = [ta._placed([end._box((-4, -34, -2), (END_TIE, 34, 4))], _inward_frame(point, heading))[0]
                 for _, point, heading, _ in lay.ports]
        floor = _cs_mesh(lay.plate, -2, 4)
        if floor is not None:
            zones.append(floor)
        deck = ta._union([ta._difference(deck, [ta._channel_void(paths, webs, zones), *cuts]), *additions])
    masks, contacts, cuts, additions = [], [], [], []
    for ident, point, heading, far in lay.ports:
        frame = _inward_frame(point, heading)
        mask = end._box((-8, -34, -1), (5.8, 34, 12))
        mask.apply_transform(frame)
        masks.append(mask)
        contact = end._production_end(adjustment, opposite=far)
        contact.apply_transform(frame)
        contacts.append(contact)
        c, a = ta._end_attachments(_port_dict(ident, point, heading))
        cuts += c
        additions += a
    body = ta._union([deck, junction_rails(lay.rows, lay.checks)])
    # A plug stays within its seam segment, so the kerf severs it whole.
    plugs = [ta._site_box(point, normal, -5.5, 5.5, max(-6.5, lo), min(6.5, hi), 0, BASE)
             for point, normal, plugged, (lo, hi) in lay.sites if plugged]
    if plugs:
        # Wider than the stringer: an oblique seam's key still sits wholly in solid plug.
        stringers = ta._union([ta._ribbon(path, y, PLUG_HALF, -1, 4) for path in paths for y in (-RAIL, RAIL)])
        body = ta._union([body, *[trimesh.boolean.intersection([plug, stringers], engine="manifold") for plug in plugs]])
    body = ta._difference(body, masks)
    return ta._union([ta._difference(ta._union([body, *contacts]), cuts), *additions])


@lru_cache(maxsize=8)
def _pieces(family, shape, adjustment, lite=False):
    """The fixed base split along the planned seams; every adjacent pair keyed."""
    lay = layout(family, shape)
    full = _fixed_mesh(family, shape, adjustment, lite)
    if not lay.seams:
        return [full]
    kerf = ta._union([ta._polygon(ta._segment_quad(a, b, .1), -1, 12) for a, b in lay.seams])
    pieces = sorted((piece for piece in ta._difference(full, [kerf]).split(only_watertight=False) if piece.volume > 1),
                    key=lambda m: (round(m.bounds[0, 0], 1), round(m.bounds[0, 1], 1)))
    for point, normal, _, _ in lay.sites:
        probe = ta._site_box(point, normal, -.6, 4.4, -ta.KEY_HEAD-.4, ta.KEY_HEAD+.4, .1, 1.8)
        if trimesh.boolean.intersection([full, probe], engine="manifold").volume < probe.volume*.995:
            continue
        owner, other = [ta._piece_at(pieces, point+normal*k) for k in (-2., 2.)]
        if owner is None or other is None or owner == other:
            continue
        pieces[owner] = ta._union([pieces[owner], ta._dovetail(point, normal)])
        pieces[other] = ta._difference(pieces[other], [ta._dovetail(point, normal, ta.JOINT_CLEARANCE)])
    return pieces


def _meshes(family, p):
    return _pieces(family, _shape(family, p), float(p["fit_adjustment"]), fast.enabled(p))


# ---------------------------------------------------------------- service interface

def components(family: str, p: dict) -> list[dict]:
    validate(family, p)
    code = FAMILIES.index(family)
    return [{"role": f"crossing-base-{index+1:02d}", "parameters": {**p, "shape_code": code, "component_index": index}}
            for index in range(len(_meshes(family, p)))]


def _family_of(p) -> str:
    code = p.get("shape_code")
    if not _number(code) or code != int(code) or not 0 <= code < len(FAMILIES):
        raise ValueError("invalid shape_code")
    return FAMILIES[int(code)]


def component_keys(p: dict) -> set[str]:
    return set(CONNECTOR | set(SHAPES[_family_of(p)]) | {"shape_code", "component_index"})


def _logical(p):
    return {key: value for key, value in p.items() if key not in ("shape_code", "component_index")}


def validate_component(p: dict) -> None:
    family = _family_of(p)
    if set(p) - {"lite"} != component_keys(p):
        raise ValueError("unexpected crossing component parameters")
    validate(family, _logical(p))
    index = p["component_index"]
    if not _number(index) or index != int(index) or index < 0:
        raise ValueError("invalid component_index")
    if index >= len(_meshes(family, p)):
        raise ValueError("component_index outside assembly")


def component_ports(p: dict) -> list[dict]:
    return ports(_family_of(p), _logical(p))


def build_component(p: dict) -> cq.Shape:
    validate_component(p)
    role = f"crossing-base-{int(p['component_index'])+1:02d}"
    mesh = _meshes(_family_of(p), p)[int(p["component_index"])]
    if not mesh.is_watertight or len(mesh.split(only_watertight=False)) != 1:
        raise ValueError(f"{role} is not a connected watertight component")
    if np.any(mesh.extents[:2] > BED + .001):
        raise ValueError(f"{role} exceeds the 166 mm usable mini bed")
    manifold = manifold3d.Manifold(manifold3d.Mesh(np.float32(mesh.vertices), np.uint32(mesh.faces)))
    cleaned = manifold.simplify(1e-5).to_mesh()
    result = trimesh.Trimesh(cleaned.vert_properties[:, :3], cleaned.tri_verts, process=True)
    if not result.is_volume or len(result.split(only_watertight=False)) != 1:
        raise ValueError(f"{role} lost connected volume during seam retriangulation")
    return end._solid(result)


def hardware(family: str, p: dict) -> list[dict]:
    validate(family, p)
    return []


def assembly_notes(family: str, p: dict) -> list[str]:
    validate(family, p)
    notes = ["Lay the keyed base pieces on a flat surface and lower the matching dovetails together." if len(_meshes(family, p)) > 1
             else "One printed piece: no assembly needed.",
             "Seat it on a flat table or clutch it to bricks at the end ties; the crossing plate has no stud bays.",
             "Keep the frog gaps and check-rail flangeways free of support material.",
             "Both routes are always open: only one train may occupy the crossing at a time."]
    lay = layout(family, _shape(family, p))
    if min((c["angle"] for c in lay.crossings), default=math.pi/2) < math.radians(WARN_ANGLE) - 1e-9:
        notes.append("Experimental: rails cross below 22.5°, so the frog gaps are long; test-run slowly before use.")
    return notes


# ---------------------------------------------------------------- probes

class _Slices:
    """Point-in-solid tests on horizontal sections of a watertight mesh (even-odd over every contour)."""

    def __init__(self, mesh):
        self._solid = manifold3d.Manifold(manifold3d.Mesh(np.float32(mesh.vertices), np.uint32(mesh.faces)))
        self._edges = {}

    def inside(self, points, z):
        if z not in self._edges:
            polygons = [np.asarray(polygon, float) for polygon in self._solid.slice(z).to_polygons() if len(polygon) > 2]
            self._edges[z] = (np.vstack(polygons), np.vstack([np.roll(polygon, -1, axis=0) for polygon in polygons])) if polygons else None
        if self._edges[z] is None:
            return np.zeros(len(points), dtype=bool)
        a, b = self._edges[z]
        result = np.empty(len(points), dtype=bool)
        for start in range(0, len(points), 256):
            x, y = points[start:start+256, 0, None], points[start:start+256, 1, None]
            spans = (a[None, :, 1] > y) != (b[None, :, 1] > y)
            with np.errstate(divide="ignore", invalid="ignore"):
                cross = a[None, :, 0] + (y - a[None, :, 1]) * (b[None, :, 0] - a[None, :, 0]) / (b[None, :, 1] - a[None, :, 1])
            result[start:start+256] = np.count_nonzero(spans & (x < cross), axis=1) % 2 == 1
        return result


def probe_running_clearances(family: str, p: dict) -> dict:
    """Flange corridors clear on every route; running heads never unsupported over 4 mm.

    Same digital wheel envelope as track_assembly: 2.2 mm flangeway, 2.4 mm head,
    first/last 6 mm (rigid source contacts) excluded."""
    validate(family, p)
    assembly = ta._union(list(_meshes(family, p)))
    flange_max = gap_max = 0.
    solid = _Slices(assembly)
    for *_, path in routes(family, p):
        length = ta._length(path)
        for cutter in ta._flangeways([ta._station_path(path, 6., length-6.)]):
            flange_max = max(flange_max, abs(trimesh.boolean.intersection([assembly, cutter], engine="manifold").volume))
        stations = np.arange(6., length-6., .5)
        points = _station_points(path, stations)
        normal = _normals(points)
        for rail in (-1., 1.):
            offsets = rail*RAIL + np.linspace(-1.1, 1.1, 5)
            query = (points[:, None, :2] + normal[:, None, :]*offsets[None, :, None]).reshape(-1, 2)
            inside = solid.inside(query, 9.45).reshape(len(stations), -1).any(axis=1)
            gap = 0.
            for supported in inside:
                gap = 0. if supported else gap + .5
                gap_max = max(gap_max, gap)
    if flange_max > .01:
        raise ValueError(f"wheel-flange corridor obstructed: {flange_max:.6f} mm^3")
    if gap_max > 4.:
        raise ValueError(f"unsupported running-head gap: {gap_max:.3f} mm")
    return {"flangeObstructionMm3": flange_max, "maximumUnsupportedSpanMm": gap_max, "samplePitchMm": .5,
            "physicalWheelAcceptance": "not_checked"}


def probe_guidance(family: str, p: dict) -> dict:
    """Every wheelset is guided in both lateral directions along every route.

    Drift toward a rail is stopped by that rail's guiding face (lateral 18.8) or by
    a check rail's face (lateral 16.6) holding the other wheel's flange back. The
    longest unguided stretch must not exceed GUIDE_LIMIT."""
    validate(family, p)
    assembly = ta._union(list(_meshes(family, p)))
    heights = (7.0, 8.2, 9.4)
    solid = _Slices(assembly)
    worst, report = 0., []
    for ident, _, _, path in routes(family, p):
        length = ta._length(path)
        stations = np.arange(8., length-8., .25)
        points = _station_points(path, stations)
        normal = _normals(points)

        def present(lateral):
            query = points[:, :2] + normal*lateral
            return np.any([solid.inside(query, z) for z in heights], axis=0)

        for rail in (-1., 1.):
            face, check = present(rail*(FACE + .15)), present(-rail*(BACK - .15))
            run = longest_face = 0.
            unguided = open_face = 0.
            for has_face, has_check in zip(face, check):
                open_face = 0. if has_face else open_face + .25
                unguided = 0. if has_face or has_check else unguided + .25
                longest_face, run = max(longest_face, open_face), max(run, unguided)
            worst = max(worst, run)
            report.append({"route": ident, "rail": "left" if rail > 0 else "right",
                           "longestFaceGapMm": longest_face, "longestUnguidedMm": run})
    if worst > GUIDE_LIMIT:
        raise ValueError(f"wheelset unguided for {worst:.2f} mm")
    return {"limitMm": GUIDE_LIMIT, "rails": report}


def probe_base_joints(family: str, p: dict) -> dict:
    """Every base piece joins the assembly through a real in-plane pull-out stop."""
    validate(family, p)
    rows = [(f"crossing-base-{i+1:02d}", mesh) for i, mesh in enumerate(_meshes(family, p))]
    adjacency = [set() for _ in rows]
    evidence = []
    for i, (name, mesh) in enumerate(rows):
        for j, (other_name, other) in enumerate(rows[i+1:], i+1):
            if np.any(mesh.bounds[0, :2] > other.bounds[1, :2]+1) or np.any(other.bounds[0, :2] > mesh.bounds[1, :2]+1):
                continue
            rest = abs(trimesh.boolean.intersection([mesh, other], engine="manifold").volume)
            if rest > .01:
                raise ValueError(f"base joint interference: {name}/{other_name}: {rest:.6f} mm^3")
            blocked = []
            for translation in ((1, 0, 0), (-1, 0, 0), (0, 1, 0), (0, -1, 0)):
                pulled = mesh.copy()
                pulled.apply_translation(translation)
                blocked.append(abs(trimesh.boolean.intersection([pulled, other], engine="manifold").volume))
            if min(blocked) > .01:
                adjacency[i].add(j)
                adjacency[j].add(i)
                evidence.append({"from": name, "to": other_name, "blockedVolumeMm3": min(blocked)})
    reached, pending = set(), [0]
    while pending:
        node = pending.pop()
        if node not in reached:
            reached.add(node)
            pending.extend(adjacency[node]-reached)
    if len(reached) != len(rows):
        raise ValueError(f"base components lack retained joints: {[rows[i][0] for i in range(len(rows)) if i not in reached]}")
    return {"components": len(rows), "retainedConnections": evidence}


def probe_source_contacts(family: str, p: dict) -> list[dict]:
    """Every port keeps the accepted brick source contact unchanged."""
    validate(family, p)
    assembly = ta._union(list(_meshes(family, p)))
    columns = end.PROFILE["brickAttachment"]["studLateralOffsets"]
    report = []
    for ident, point, heading, far in _port_rows(routes(family, p)):
        local = assembly.copy()
        local.apply_transform(np.linalg.inv(_inward_frame(point, heading)))
        region = ta._difference(end._box((-5, -23.9, -.01), (5.79, 23.9, 10)),
                                [end._box((4-2.45, y-2.45, 3.2), (4+2.45, y+2.45, 4.9)) for y in columns])
        source = end.end_mesh(p["fit_adjustment"], opposite=far)
        expected = trimesh.boolean.intersection([source, region], engine="manifold")
        actual = trimesh.boolean.intersection([local, region], engine="manifold")
        lost, added = abs(ta._difference(expected, [actual]).volume), abs(ta._difference(actual, [expected]).volume)
        if max(lost, added) > .005:
            raise ValueError(f"source interface changed at {ident}: lost={lost:.6f}, added={added:.6f} mm^3")
        report.append({"port": ident, "lostMm3": lost, "addedMm3": added})
    return report
