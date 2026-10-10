"""Authored, manually operated plastic track mechanisms; dimensions are millimetres.

These are NOT conversions of LDraw display meshes, replicas of official mechanisms,
or physical-fit certifications. Source contacts and clutch dimensions come from
brick_end's versioned profile. Track endpoint geometry follows L-Gauge/LDraw.

Junction selectors are captive linear cassettes, not bendable static rail unions.
Each cassette carries a straight route and a curved route 56 mm apart. Sliding it
56 mm selects the other route. This deliberately trades footprint for printable,
inspectable mechanics. Collision checks must use the swept envelope of both
selector states, never the original moulded-track silhouette. Operate all four
crossover cassettes to the same marked state; no train movement while changing a selector.

Ties are rigid 15.8 x 63.8 mm rectangles (turnout diverging stations from LDraw
53404; the 32087 crossing arm/centre layout). Each tie carries one clutch in its
own frame; turnout ties never exceed 53404's stud columns. A stud column group
whose footprint would reach another route's rails, flangeways, gauge or
stringers, another tie's clutch, a seam or a mechanism part is dropped whole,
never clipped into an irregular pocket. Rail stringers are hollow baseplate
channels (flat ceilings; LDraw's V roof is not copied). The crossing and the
flex outer leaf seat on a studded baseplate; the selector cassette floors (like
53404's solid cover plate), the flex pivot plate, diverging ties and seam key
plugs do not. The cassette pocket ends at 88.0, before the first straight tie;
the far keeper stands on that tie beside the diverging inner rail. The flex
link is open outside the rails and carries 64022's guard ridges and z=6.4 floor.

Base tiles split only through tie gaps and selector floors. Complementary
vertical-insertion dovetails (0.20 mm clearance) sit in the floors or in solid
stringer plugs where a seam crosses a rail; their slots are blind from below.
Assemble tiles on a flat surface, then slide in cassettes BEFORE installing the
printed keeper bridges with M3 x 4 self-tapping screws into 2.6 mm pilot bores.
Each cassette needs two keepers, one removable printed state-lock pin and four screws. Flex uses a recessed M3 nut,
M3 x 4 button-head bolt and 3.2 ID x 12 OD x 1 mm washer, all above the base datum.
No glue is required. Fit and wheel-flange clearance remain physical trial gates.

Fast print (``lite``) bases keep every mechanism, seam and key but replace the
tie clutch, studs, full tie slabs and hollow channels with solid stringers and
2.8 mm gauge braces (lite.py); the far keeper gets a solid seat instead of the
first straight tie. Selectors, keepers, lock pins and flex leaves are unchanged.
"""
from __future__ import annotations

from functools import lru_cache
import math
import json
from pathlib import Path

import cadquery as cq
import manifold3d
import numpy as np
import trimesh

from . import hardware as hw
from . import brick_end as end
from . import lite as fast

FAMILIES = ("printed_flex", "printed_switch_right", "printed_switch_left",
            "printed_crossing90", "printed_double_crossover")
LOGICAL_PARAMETERS = {"connector_version", "fit_adjustment", "bend", "switch_state"}
COMPONENT_PARAMETERS = LOGICAL_PARAMETERS | {"shape_code", "component_index"}
MAX_BEND = math.pi / 32
MECHANISM_PROFILE = json.loads((Path(__file__).resolve().parents[1] /
                               "profiles/track-assemblies-v1.json").read_text())
SLIDE = MECHANISM_PROFILE["mechanism"]["selectorTravel"]
FLANGE_CLEARANCE = MECHANISM_PROFILE["mechanism"]["flangewayWidth"]
FLANGE_DEPTH = MECHANISM_PROFILE["mechanism"]["flangewayDepth"]
JOINT_CLEARANCE = MECHANISM_PROFILE["mechanism"]["tileJointClearance"]


def validate(family: str, p: dict[str, float]) -> None:
    if family not in FAMILIES or set(p) - {"lite"} != LOGICAL_PARAMETERS:
        raise ValueError("unknown assembly family or parameter keys")
    fast.validate(p)
    if any(not isinstance(v, (int, float)) or isinstance(v, bool) or not math.isfinite(v)
           for v in p.values()):
        raise ValueError("assembly parameters must be finite numbers")
    end.validate(p)
    if abs(p["bend"]) > MAX_BEND + 1e-12 or (family != FAMILIES[0] and p["bend"] != 0):
        raise ValueError("bend is only supported on flex, within +/-5.625 degrees")
    if p["switch_state"] not in (0, 1) or (family in (FAMILIES[0], FAMILIES[3]) and p["switch_state"] != 0):
        raise ValueError("switch_state must be 0 or 1 and applies only to junctions")


def ports(family: str, p: dict[str, float]) -> list[dict]:
    validate(family, p)
    rows = [("in", 0., 0., math.pi)]
    if family == FAMILIES[0]:
        b = p["bend"]
        rows.append(("out", 16 + 16 * math.cos(b), 16 * math.sin(b), b))
    elif family in FAMILIES[1:3]:
        sign = -1 if family == FAMILIES[1] else 1
        x, y, h = _branch_endpoint()
        rows += [("out", 256., 0., 0.), ("branch", x, sign * y, sign * h)]
    elif family == FAMILIES[3]:
        rows += [("out", 128., 0., 0.), ("north", 64., 64., math.pi / 2),
                 ("south", 64., -64., -math.pi / 2)]
    else:
        rows += [("out", 384., 0., 0.), ("parallel-in", 0., 128., math.pi),
                 ("parallel-out", 384., 128., 0.)]
    return [{"id": name, "position": [x, y, 0.], "heading": h, "pitch": 0.,
             "rail_gauge": 40., "rail_interface_width": 2.4} for name, x, y, h in rows]


def _branch_endpoint():
    a, b = math.atan2(3, 4), math.pi / 8
    return (320 * (2 * math.sin(a) - math.sin(b)),
            320 * (1 - 2 * math.cos(a) + math.cos(b)), b)


def _arc_path(crossover=False, sign=1):
    a = math.atan2(3, 4)
    final = 0 if crossover else math.pi / 8
    first = np.linspace(0, a, 81)
    second = np.linspace(a, final, 61)[1:]
    return np.array([(320 * math.sin(t), sign * 320 * (1 - math.cos(t)), sign * t)
                     for t in first] +
                    [(320 * (2 * math.sin(a) - math.sin(t)),
                      sign * 320 * (1 - 2 * math.cos(a) + math.cos(t)), sign * t)
                     for t in second])


def _line(length, y=0):
    return np.array([(0., y, 0.), (length, y, 0.)])


def _transform_path(path, origin, heading):
    c, s = math.cos(heading), math.sin(heading)
    out = path.copy()
    out[:, 0] = origin[0] + c * path[:, 0] - s * path[:, 1]
    out[:, 1] = origin[1] + s * path[:, 0] + c * path[:, 1]
    out[:, 2] += heading
    return out


def _clip_path(path, lo, hi):
    rows = [path[(path[:, 0] > lo) & (path[:, 0] < hi)]]
    endpoints = np.array([[x, np.interp(x, path[:, 0], path[:, 1]),
                          np.interp(x, path[:, 0], path[:, 2])] for x in (lo, hi)])
    return np.vstack([endpoints[0], rows[0], endpoints[1]])


def _selector_branch(sign):
    # Rigid source lead-in and a tangent-continuous cubic into the R40 route.
    target = _clip_path(_arc_path(sign=sign), 88, 89)[0]
    x = np.linspace(14, 88, 49)
    t = (x - 14) / 74
    y = (-2*t**3 + 3*t**2)*target[1] + (t**3-t**2)*74*math.tan(target[2])
    dy = ((-6*t**2+6*t)*target[1] + (3*t**2-2*t)*74*math.tan(target[2])) / 74
    return np.column_stack((x, y, np.arctan(dy)))


def _selectors(code):
    if code in (1, 2):
        return [((0., 0.), 0., -1 if code == 1 else 1)]
    if code == 4:
        return [((0., 0.), 0., 1), ((0., 128.), 0., -1),
                ((384., 0.), math.pi, -1), ((384., 128.), math.pi, 1)]
    return []


def _union(meshes):
    meshes = [m for m in meshes if len(m.faces)]
    return trimesh.boolean.union(meshes, engine="manifold") if len(meshes) > 1 else meshes[0]


def _difference(mesh, cutters):
    return trimesh.boolean.difference([mesh, *cutters], engine="manifold") if cutters else mesh


def _polygon(points, low, high):
    points = np.asarray(points, dtype=float)
    points = points[np.r_[True, np.linalg.norm(np.diff(points, axis=0), axis=1) > 1e-9]]
    if np.linalg.norm(points[0]-points[-1]) < 1e-9:
        points = points[:-1]
    points = [tuple(point) for point in points]
    return end._mesh(cq.Workplane("XY", origin=(0, 0, low)).polyline(points).close().extrude(high-low).val())


def _ribbon(path, lateral, half, low, high):
    normal = np.column_stack((-np.sin(path[:, 2]), np.cos(path[:, 2])))
    left = path[:, :2] + normal*(lateral-half)
    right = path[:, :2] + normal*(lateral+half)
    return _polygon(np.vstack([left, right[::-1]]).tolist(), low, high)


def _rails(path, bottom=3.2):
    # Exact versioned rail profile represented as overlapping prismatic bands.
    # Sloped shoulder uses a mesh loft; the running head remains 2.4 mm wide.
    profile = np.array(end.PROFILE["railSection"])
    if np.sum(profile[:, 0]*np.roll(profile[:, 1], -1)-np.roll(profile[:, 0], -1)*profile[:, 1]) < 0:
        profile = profile[::-1]
    vertices, faces = [], []
    n = len(profile)
    for lateral in (-20., 20.):
        offset = len(vertices)
        for x, y, h in path:
            for lateral_profile, z in profile:
                vertices.append((x-math.sin(h)*(lateral+lateral_profile),
                                 y+math.cos(h)*(lateral+lateral_profile), z))
        # Profile is concave; planar caps are separately triangulated by CQ.
        for j in range(len(path)-1):
            for k in range(n):
                a, b = offset+j*n+k, offset+j*n+(k+1)%n
                c, d = b+n, a+n
                faces.extend([(a, b, c), (a, c, d)])
        # Ear triangulation of this fixed profile; no fan across its concavity.
        for j, reverse in ((0, True), (len(path)-1, False)):
            # Explicit fill is independent of source contour orientation.
            polygon = manifold3d.CrossSection([profile.tolist()], manifold3d.FillRule.EvenOdd)
            cap = polygon.extrude(.01).to_mesh()
            for face in cap.tri_verts:
                coords = cap.vert_properties[face, :3]
                if not np.all(np.abs(coords[:, 2]) < 1e-7):
                    continue
                indices = [offset+j*n+int(np.argmin(np.linalg.norm(profile-v[:2], axis=1))) for v in coords]
                faces.append(tuple(indices[::-1] if not reverse else indices))
    mesh = trimesh.Trimesh(vertices=vertices, faces=faces, process=True)
    if not mesh.is_volume:
        raise ValueError("Authored rail loft must have closed, outward-wound caps and side walls")
    if bottom < 3.2:
        mesh = _union([mesh, *[_ribbon(path, y, 3, bottom, 3.21) for y in (-20, 20)]])
    return mesh


def _flangeways(paths):
    channels = []
    low, high = end.RAIL_TOP-FLANGE_DEPTH, end.RAIL_TOP+.1
    for path in paths:
        hinges = np.flatnonzero((np.linalg.norm(np.diff(path[:, :2], axis=0), axis=1) < 1e-9)
                               & (np.abs(np.diff(path[:, 2])) > 1e-9))
        sections, start = [], 0
        for hinge in hinges:
            sections.append(path[start:hinge+1])
            start = hinge+1
        sections.append(path[start:])
        for sign in (-1, 1):
            lateral, half = sign*(18.8-FLANGE_CLEARANCE/2), FLANGE_CLEARANCE/2
            solids = [_ribbon(section, lateral, half, low, high) for section in sections]
            for hinge in hinges:
                a, b = path[hinge:hinge+2]
                na, nb = np.array([-math.sin(a[2]), math.cos(a[2])]), np.array([-math.sin(b[2]), math.cos(b[2])])
                points = [a[:2]+na*(lateral-half), a[:2]+na*(lateral+half),
                          b[:2]+nb*(lateral+half), b[:2]+nb*(lateral-half)]
                solids.append(_polygon(points, low, high))
            channels.append(_union(solids))
    return channels


def _contact(port, adjustment):
    inward = port["heading"] + math.pi
    mesh = end._production_end(adjustment, opposite=port["id"] not in ("in", "parallel-in", "south"))
    mesh.apply_transform(end._frame(port["position"], inward, 0))
    return mesh


def _end_attachments(port, columns=None):
    """Shared production half-tie clutch and stud seats in the port frame."""
    cuts, additions = end.tie_clutch(columns, half=True)
    cuts += end.stud_lands(columns, half=True)
    frame = end._frame(port["position"], port["heading"]+math.pi, 0)
    for m in cuts + additions:
        m.apply_transform(frame)
    return cuts, additions


def _rigid_lead_out(path):
    """Blend the last 24 mm into the unwarped 6 mm source contact lead."""
    length = np.linalg.norm(np.diff(path[:, :2], axis=0), axis=1).sum()
    start = _station_path(path, length-24, length)[0]
    finish = path[-1]
    target = finish[:2]-6*np.array([math.cos(finish[2]), math.sin(finish[2])])
    tangent0 = 18*np.array([math.cos(start[2]), math.sin(start[2])])
    tangent1 = 18*np.array([math.cos(finish[2]), math.sin(finish[2])])
    blend = []
    for t in np.linspace(0, 1, 25):
        xy = (2*t**3-3*t**2+1)*start[:2]+(t**3-2*t**2+t)*tangent0+(-2*t**3+3*t**2)*target+(t**3-t**2)*tangent1
        derivative = (6*t*t-6*t)*start[:2]+(3*t*t-4*t+1)*tangent0+(-6*t*t+6*t)*target+(3*t*t-2*t)*tangent1
        blend.append((*xy, math.atan2(derivative[1], derivative[0])))
    return np.vstack([_station_path(path, 0, length-24)[:-1], blend, finish])


def _fixed_paths(code):
    if code in (1, 2):
        sign = -1 if code == 1 else 1
        branch = _arc_path(sign=sign)
        route = np.vstack([(0., 0., 0.), _selector_branch(sign), branch[branch[:, 0] > 88]])
        return [_line(256), _rigid_lead_out(route)]
    if code == 3:
        return [_line(128), _transform_path(_line(128), (64, -64), math.pi/2)]
    diagonal = _arc_path(True)
    middle = _clip_path(diagonal, 88, 296)
    last = _transform_path(_selector_branch(1), (384, 128), math.pi)[::-1]
    last[:, 2] -= math.pi
    diagonal = np.vstack([(0., 0., 0.), _selector_branch(1), middle[1:-1], last, (384., 128., 0.)])
    other = diagonal.copy()
    other[:, 1] = 128 - other[:, 1]
    other[:, 2] *= -1
    paths = [_line(384), _line(384, 128), diagonal, other]
    return paths


def _slide_bounds(sign, slide_sign):
    branch_low, branch_high = (-12., 0.) if sign < 0 else (0., 12.)
    return (min(-23., branch_low-SLIDE*slide_sign-23)-3,
            max(23., branch_high-SLIDE*slide_sign+23)+3)


def _slide_land(code, sign):
    slide_sign = 1 if code == 4 else sign
    low, high = _slide_bounds(sign, slide_sign)
    return low + min(0, SLIDE*slide_sign)-2, high + max(0, SLIDE*slide_sign)+2


# Official 53404/53407 diverging sleeper centres: arc length from the in-port
# (LDraw s\53404s01.dat). 63.38 lies inside the selector cassette floor.
SWITCH_DIVERGING_TIES = (95.365, 127.339, 159.314, 191.289, 222.228, 254.202)
# 60128 has no LDraw model. The crossover diagonals reuse the turnout's first
# official sleepers from each end; the diamond stays tie-free so the 166 mm base
# tiles separate along y=64 through tie gaps only.
CROSSOVER_DIAGONAL_TIES = (95.365, 127.339)
# Official 53404 top-stud columns per tie (right turnout, +lateral = left of
# travel); the left turnout mirrors them. Conflict checks may drop more.
SWITCH_OFFICIAL_COLUMNS = (
    {96.: (28,), 128.: (28,), 160.: (28,), 192.: (-12, -4, 4, 12, 28), 224.: (-28, -12, -4, 4, 12, 28)},
    {95.365: (-28,), 127.339: (-28,), 159.314: (-28,), 191.289: (-28, -12, -4, 4, 12),
     222.228: (-28, -12, -4, 4, 12, 28), 254.202: (-28, -12, -4, 4, 12, 28)})
# Cassette floor recess in the selector frame. The in-port half tie keeps its
# full 7.9 mm; the far end stops before the straight tie at 88.1-103.9 and
# clears the plate end by 0.6 mm.
POCKET = (end.PROFILE["endTieWidth"], 88.)
PLATE = (12.2, POCKET[1]-.6)
# Another route's rails, flangeways, gauge and stringers (23.9) plus 0.3 mm.
ROUTE_KEEP_OUT = 24.2
# Clutch column groups: lateral footprint (bay walls / 7.8 mm seats) and studs.
CLUTCH_GROUPS = ((-16.8, 16.8, (-12, -4, 4, 12)), (23.2, 31.9, (28,)), (-31.9, -23.2, (-28,)))
KEY_NECK, KEY_HEAD = 1.8, 2.8


def _length(path):
    return float(np.linalg.norm(np.diff(path[:, :2], axis=0), axis=1).sum())


def _path_frame(path, station):
    lengths = np.r_[0., np.cumsum(np.linalg.norm(np.diff(path[:, :2], axis=0), axis=1))]
    x, y, heading = (np.interp(station, lengths, path[:, axis]) for axis in range(3))
    return end._frame((x, y, 0), heading, 0)


def _local(frame, points):
    return [tuple((frame @ np.array([u, v, 0, 1]))[:2]) for u, v in points]


def _section(points):
    return manifold3d.CrossSection([np.asarray(points, dtype=float).tolist()], manifold3d.FillRule.EvenOdd)


def _rect(frame, u0, u1, v0, v1):
    return _section(_local(frame, ((u0, v0), (u1, v0), (u1, v1), (u0, v1))))


def _band(path, half):
    normal = np.column_stack((-np.sin(path[:, 2]), np.cos(path[:, 2])))
    return _section(np.vstack([path[:, :2] - normal*half, (path[:, :2] + normal*half)[::-1]]))


def _overlaps(a, b):
    return (a ^ b).area() > 1e-6


def _selector_frame(origin, heading):
    return end._frame((*origin, 0), heading, 0)


def _in_pocket(code, x, y):
    for origin, heading, sign in _selectors(code):
        local = np.linalg.inv(_selector_frame(origin, heading)) @ np.array([x, y, 0, 1])
        low, high = _slide_land(code, sign)
        if POCKET[0] <= local[0] <= POCKET[1] and low <= local[1] <= high:
            return True
    return False


def _tie_frames(code):
    """(route, station, frame) of every full tie outside the selector floors."""
    rows = []
    for route, path in enumerate(_fixed_paths(code)):
        length = _length(path)
        if code in (1, 2) and route == 1:
            stations = SWITCH_DIVERGING_TIES
        elif code == 4 and route > 1:
            stations = CROSSOVER_DIAGONAL_TIES + tuple(length-s for s in CROSSOVER_DIAGONAL_TIES[::-1])
        else:
            stations = [(low+high)/2 for low, high in end.tie_intervals(length)[1:-1]]
        for station in stations:
            frame = _path_frame(path, station)
            if not _in_pocket(code, *frame[:2, 3]):
                rows.append((route, station, frame))
    return rows


def _keeper_layout(x, sign):
    """Keeper (left, right, low, high, screw laterals) in the selector frame.

    Keeper 1 clears the in-port half-tie studs at (4, +/-4), which reach 6.4.
    Keeper 2 overhangs the plate end by 1 mm and stands on the straight tie
    beside the diverging route's inner rail, which crosses y = -sign*(0..9).
    """
    if x == 9.5:
        return 6.7, 13.6, -9.2, 9.2, (-6., 6.)
    low, high = sorted((sign*1., sign*16.))
    return PLATE[1]-1, 96.8, low, high, (sign*4.5, sign*12.5)


def _seams(code):
    """Authored base-tile cut lines (XY polylines) in tie gaps or selector floors."""
    if code in (1, 2):
        side = -1 if code == 1 else 1
        # Cross the diverging route square to its gap between the official
        # 191.289 and 222.228 sleepers, then the straight route's 200-216 gap.
        frame = _path_frame(_fixed_paths(code)[1], (SWITCH_DIVERGING_TIES[3]+SWITCH_DIVERGING_TIES[4])/2)
        centre, inward = frame[:2, 3], -side*frame[:2, 1]
        corner = centre + 34*inward
        return [[(-20., -33.*side), (300., -33.*side)],
                [(80., -33.*side), (80., 150.*side)],
                [tuple(centre-45*inward), tuple(corner), (208., corner[1]), (208., -40.*side)]]
    if code == 4:
        return [[(80., -150.), (80., 280.)], [(304., -150.), (304., 280.)], [(-20., 64.), (404., 64.)],
                [(176., 64.), (176., -150.)], [(208., 64.), (208., 280.)]]
    return []


def _seam_segments(code):
    return [(a, b) for seam in _seams(code)
            for a, b in zip(np.asarray(seam[:-1], float), np.asarray(seam[1:], float))]


def _segment_quad(a, b, half):
    direction = (b-a)/np.linalg.norm(b-a)
    normal = np.array([direction[1], -direction[0]])
    return [a-direction*half-normal*half, b+direction*half-normal*half,
            b+direction*half+normal*half, a-direction*half+normal*half]


def _selector_zones(code):
    """XY cassette floor recesses and keeper footprints (+0.3 mm)."""
    pockets, keepers = manifold3d.CrossSection(), manifold3d.CrossSection()
    for origin, heading, sign in _selectors(code):
        frame = _selector_frame(origin, heading)
        low, high = _slide_land(code, sign)
        pockets += _rect(frame, *POCKET, low, high)
        for x in (9.5, 92.):
            left, right, y0, y1, _ = _keeper_layout(x, sign)
            keepers += _rect(frame, left-.3, right+.3, y0-.3, y1+.3)
    return pockets, keepers


@lru_cache(maxsize=6)
def _clutch_plan(code):
    """One rigid clutch per full tie; conflicting column groups are dropped.

    Ties are resolved in route priority (straight routes first). A group is
    kept only if its whole footprint (bays + 0.8 mm walls, 7.8 mm brick seats)
    stays clear of every other route's rails/flangeways/gauge/stringers, of
    already accepted clutches of other ties, of seams and of keepers; its studs
    must stand on the full-height deck, never over a cassette floor.
    """
    paths = _fixed_paths(code)
    bands = [_band(path, ROUTE_KEEP_OUT) for path in paths]
    pockets, blocked = _selector_zones(code)
    for a, b in _seam_segments(code):
        blocked += _section(_segment_quad(a, b, .9))
    accepted = manifold3d.CrossSection()
    for port in ports(FAMILIES[code], dict(connector_version=1, fit_adjustment=0, bend=0, switch_state=0)):
        accepted += _rect(end._frame(port["position"], port["heading"]+math.pi, 0), 0, 7.9, -31.9, 31.9)
    plan = []
    for route, station, frame in _tie_frames(code):
        columns, footprints = [], []
        official = (None if code not in (1, 2) else
                    {v*(1 if code == 1 else -1) for v in SWITCH_OFFICIAL_COLUMNS[route][round(station, 3)]})
        for low, high, group in CLUTCH_GROUPS:
            if official is not None and not set(group) <= official:
                continue
            footprint = _rect(frame, -7.9, 7.9, low, high)
            studs = _rect(frame, -6.7, 6.7, min(group)-2.7, max(group)+2.7)
            if any(_overlaps(footprint, band) for other, band in enumerate(bands) if other != route):
                continue
            if _overlaps(footprint, blocked) or _overlaps(footprint, accepted) or _overlaps(studs, pockets):
                continue
            columns += group
            footprints.append(footprint)
        for footprint in footprints:
            accepted += footprint
        plan.append((route, station, frame, tuple(sorted(columns))))
    return plan


def _placed(meshes, frame):
    for mesh in meshes:
        mesh.apply_transform(frame)
    return meshes


def _station_path(path, low, high):
    lengths = np.r_[0., np.cumsum(np.linalg.norm(np.diff(path[:, :2], axis=0), axis=1))]
    ends = np.array([[np.interp(s, lengths, path[:, axis]) for axis in range(3)]
                     for s in (low, high)])
    return np.vstack([ends[0], path[(lengths > low) & (lengths < high)], ends[1]])


def _floor_zones(code):
    """Cassette floor regions (selector frames), extruded through the deck."""
    zones = []
    for origin, heading, sign in _selectors(code):
        low, high = _slide_land(code, sign)
        zones += _placed([end._box((POCKET[0]-.05, low-.05, -2), (POCKET[1], high+.05, 4))],
                         _selector_frame(origin, heading))
    return zones


def _deck_bodies(code, paths, ps, lite=False):
    """Stringers, rigid rectangular full ties and square end ties at every port.

    A tie never continues into a cassette floor; the floor replaces it there.
    Fast print replaces each full tie with a thin gauge brace between the
    (solid) rail stringers."""
    half, width, base = end.PROFILE["tieWidth"]/2, end.PROFILE["bodyWidth"]/2, end.PROFILE["baseThickness"]
    bodies = [_ribbon(path, y, end.PROFILE["baseStringerWidth"]/2, 0, base) for path in paths for y in (-20, 20)]
    if lite:
        span = fast.RAIL_BAND[0] + fast.BRACE_OVERLAP
        ties = [fast.brace(frame, span) for _, _, frame in _tie_frames(code)]
    else:
        ties = [] if code == 3 else [_placed([end._box((-half, -width, 0), (half, width, base))], frame)[0]
                                     for _, _, frame in _tie_frames(code)]
    zones = _floor_zones(code)
    bodies += [_difference(tie, zones) if zones else tie for tie in ties]
    for port in ps:
        bodies += _placed([end._box((0, -width, 0), (end.PROFILE["endTieWidth"], width, base))],
                          end._frame(port["position"], port["heading"]+math.pi, 0))
    return bodies


def _crossing_layout():
    """Official 32087 arms and centre, built in each arm's inward port frame.

    Per arm: an 8 mm tie at s 24-32 (studs at s=28, pins at lateral 0/+-8)
    whose outer 16 mm lugs (studs at s=28/36, pin at s=32) meet the crossing
    route's stringer at s=40; gaps at s 8-24 and 32-40. Adjacent lugs share a
    corner, so their outer bays join into 32087's L-shaped bay. The studless
    central block has a 3x3 tube bay with wall ribs on the 8 mm grid. Channel
    webs sit at s=32, between baseplate studs.
    """
    a = end.PROFILE["brickAttachment"]
    depth, width, base = a["cavityDepth"], end.PROFILE["bodyWidth"]/2, end.PROFILE["baseThickness"]

    def box(u0, u1, v0, v1, z0, z1):
        return end._box((min(u0, u1), min(v0, v1), z0), (max(u0, u1), max(v0, v1), z1))

    bodies, cuts, additions, webs, studs, pins = [], [], [], {0: [], 1: []}, {}, {}
    p = dict(connector_version=1, fit_adjustment=0, bend=0, switch_state=0)
    for port in ports(FAMILIES[3], p):
        frame = end._frame(port["position"], port["heading"]+math.pi, 0)
        local_bodies = [box(24.1, 31.9, -width, width, 0, base)]
        local_cuts = [box(25.6, 30.4, -16, 16, -1, depth)]
        local_additions = [box(27.2, 28.8, s*14.4, s*16.03, 0, depth+.1) for s in (-1, 1)]
        for s in (-1, 1):
            local_bodies.append(box(24.1, 40.2, s*23.9, s*width, 0, base))
            local_cuts.append(box(25.6, 40., s*24, s*30.4, -1, depth))
            local_additions += [box(u-.8, u+.8, s*23.97, s*25.6, 0, depth+.1) for u in (28, 36)]
        bodies += _placed(local_bodies, frame)
        cuts += _placed(local_cuts, frame)
        additions += _placed(local_additions, frame)
        for u, v in [(28, v) for v in a["studLateralOffsets"]] + [(36, -28), (36, 28)]:
            studs[tuple(np.round(_local(frame, [(u, v)])[0], 3))] = None
        for u, v in ((28, 0), (28, -8), (28, 8), (32, -28), (32, 28)):
            pins[tuple(np.round(_local(frame, [(u, v)])[0], 3))] = None
        webs[0 if port["id"] in ("in", "out") else 1].append(frame @ end._frame((32, 0, 0), 0, 0))
    additions += [end._cylinder(a["studDiameter"]/2, a["studBaseZ"]-.1, a["studBaseZ"]+a["studHeight"], x, y)
                  for x, y in studs]
    additions += [end._cylinder(a["pinDiameter"]/2, 0, depth+.1, x, y) for x, y in pins]
    # Central block: both routes' stringers plus a 32 x 32 tube bay.
    bodies.append(end._box((40.1, -23.9, 0), (87.9, 23.9, base)))
    cuts.append(end._box((48, -16, -1), (80, 16, depth)))
    for x in (56, 64, 72):
        for y in (-8, 0, 8):
            additions.append(_difference(end._cylinder(3.2, 0, depth+.1, x, y),
                                         [end._cylinder(2.4, -1, depth+1, x, y)]))
    for s in (-1, 1):
        additions += [box(x-.8, x+.8, s*14.4, s*16.03, 0, depth+.1) for x in (52, 60, 68, 76)]
        additions += [box(47.97, 49.6, s*y-.8, s*y+.8, 0, depth+.1) for y in (4, 12)]
        additions += [box(78.4, 80.03, s*y-.8, s*y+.8, 0, depth+.1) for y in (4, 12)]
    return bodies, cuts, additions, webs


def _channel_void(paths, webs, zones):
    """Hollow rail channels (shared brick_end bands) from 7.9 mm inside each port.

    Each route keeps its own cross-webs; another route's 1.2 mm stringer walls
    are never cut, so crossing channels stay partitioned and every rail keeps
    its walls. Upper bands overshoot the deck top before the rails are united.
    """
    et = end.PROFILE["endTieWidth"]
    walls = [[_difference(_ribbon(path, y, 3.9, -1, 3.3), [_ribbon(path, y, 2.7, -2, 4)])
              for y in (-20, 20)] for path in paths]
    voids = []
    for route, path in enumerate(paths):
        span = _station_path(path, et, _length(path)-et)
        channel = _union([_ribbon(span, lateral, width, z0, z1+.05 if z1 >= 3.2 else z1)
                          for lateral, width, z0, z1 in end.rail_channel_bands()])
        cutters = [_placed([end.channel_web()], frame)[0] for frame in webs[route]]
        cutters += [wall for other, pair in enumerate(walls) if other != route for wall in pair]
        voids.append(_difference(channel, cutters))
    return _difference(_union(voids), zones)


def _seam_sites(code):
    """Key stations: every seam/rail-line crossing (a plugged stringer) and
    8 mm stations inside selector floors."""
    candidates, segments = [], _seam_segments(code)
    for a, b in segments:
        direction = (b-a)/np.linalg.norm(b-a)
        normal = np.array([direction[1], -direction[0]])
        for path in _fixed_paths(code):
            lateral_normal = np.column_stack((-np.sin(path[:, 2]), np.cos(path[:, 2])))
            for lateral in (-20, 20):
                line = path[:, :2] + lateral_normal*lateral
                for p, q in zip(line[:-1], line[1:]):
                    matrix = np.column_stack((b-a, p-q))
                    if abs(np.linalg.det(matrix)) < 1e-12:
                        continue
                    t, r = np.linalg.solve(matrix, p-a)
                    if 0 <= t <= 1 and 0 <= r <= 1 and not _in_pocket(code, *(a+t*(b-a))):
                        candidates.append((a+t*(b-a), normal, True))
        for t in np.arange(4., np.linalg.norm(b-a), 8.):
            point = a + direction*t
            if all(_in_pocket(code, *(point+k*normal)) for k in (-6, 6)):
                candidates.append((point, normal, False))
    def distance(point, a, b):
        t = np.clip(np.dot(point-a, b-a)/np.dot(b-a, b-a), 0, 1)
        return np.linalg.norm(point-a-t*(b-a))

    sites = []
    for point, normal, plugged in candidates:
        # A key and its slot stay clear of neighbouring keys and other seams.
        crossing = [distance(point, a, b) for a, b in segments if distance(point, a, b) > 1e-6]
        if any(np.linalg.norm(point-other) < 6.5 for other, _, _ in sites) or min(crossing, default=99) < 5.5:
            continue
        sites.append((point, normal, plugged))
    return sites


def _site_box(point, normal, u0, u1, v0, v1, z0, z1):
    tangent = np.array([-normal[1], normal[0]])
    return _polygon([point+normal*u+tangent*v for u, v in ((u0, v0), (u1, v0), (u1, v1), (u0, v1))], z0, z1)


def _seam_plugs(code, paths):
    """Solid stringer blocks where a seam crosses a rail; they carry the keys."""
    plugs = [_site_box(point, normal, -5.5, 5.5, -6.5, 6.5, 0, end.PROFILE["baseThickness"])
             for point, normal, plugged in _seam_sites(code) if plugged]
    if not plugs:
        return []
    stringers = _union([_ribbon(path, y, end.PROFILE["baseStringerWidth"]/2, -1, 4)
                        for path in paths for y in (-20, 20)])
    return [trimesh.boolean.intersection([plug, stringers], engine="manifold") for plug in plugs]


@lru_cache(maxsize=12)
def _fixed_mesh(code, adjustment, lite=False):
    p = dict(connector_version=1, fit_adjustment=adjustment, bend=0, switch_state=0)
    ps = ports(FAMILIES[code], p)
    paths = _fixed_paths(code)
    bases = _deck_bodies(code, paths, ps, lite)
    # Fast print keeps solid stringers and braces: no tie clutch, studs or channels.
    cuts, additions = [], []
    if code == 3 and not lite:
        bodies, cuts, additions, webs = _crossing_layout()
        bases += bodies
    elif not lite:
        webs = {route: [] for route in range(len(paths))}
        for route, _, frame in _tie_frames(code):
            webs[route].append(frame)
        for _, _, frame, columns in _clutch_plan(code):
            if columns:
                tie_cuts, tie_additions = end.tie_clutch(columns)
                cuts += _placed(tie_cuts, frame)
                additions += _placed(tie_additions, frame)
    for origin, heading, sign in _selectors(code):
        low, high = _slide_land(code, sign)
        if lite:
            # Floor land and a solid seat under the far keeper and its posts.
            left, right, y0, y1, _ = _keeper_layout(92., sign)
            bases += _placed([end._box((POCKET[0]-.05, low, 0), (POCKET[1], high, 2)),
                              end._box((POCKET[1]-.05, y0-.3, 0), (right+.3, y1+.3, 3.2))],
                             _selector_frame(origin, heading))
            continue
        # Floor land, plus a closure under the pocket end so the straight tie's
        # face at 88.1 never leaves a slit.
        bases += _placed([end._box((POCKET[0]-.05, low, 0), (POCKET[1], high, 2)),
                          end._box((POCKET[1]-.05, -31.9, 0), (POCKET[1]+.3, 31.9, 3.2))],
                         _selector_frame(origin, heading))
    deck = _union(bases)
    if not lite:
        # Channels stop at every end tie's inner wall, square to the port.
        ends = [_placed([end._box((-4, -34, -2), (end.PROFILE["endTieWidth"], 34, 4))],
                        end._frame(port["position"], port["heading"]+math.pi, 0))[0] for port in ps]
        deck = _union([_difference(deck, [_channel_void(paths, webs, _floor_zones(code)+ends), *cuts]), *additions])
    # Rigid source end replaces all authored geometry in its own first 5.8 mm.
    masks, contacts, cuts, additions = [], [], [], []
    for port in ps:
        mask = end._box((-8, -34, -1), (5.8, 34, 12))
        mask.apply_transform(end._frame(port["position"], port["heading"]+math.pi, 0))
        masks.append(mask)
        contacts.append(_contact(port, adjustment))
        c, a = _end_attachments(port)
        cuts += c
        additions += a
    rails = _union([_rails(path) for path in paths])
    # Clear both sides of every crossing rail. This makes actual frog gaps,
    # not rail-shaped solids intersecting the wheel-flange corridor.
    rails = _difference(rails, _flangeways(paths))
    rail_webs = _union([_ribbon(path, lateral, 3, 1.9, 3.21)
                       for path in paths for lateral in (-20, 20)])
    body = _union([deck, rails])
    for origin, heading, sign in _selectors(code):
        frame = _selector_frame(origin, heading)
        # Cassette runs above a 2 mm floor with 0.3 mm vertical clearance.
        low, high = _slide_land(code, sign)
        pocket = end._box((POCKET[0], low, 2), (POCKET[1], high, 3.2))
        rail_gap = end._box((13.6, -94, 3.19), (86.4, 94, 11))
        body = _difference(body, _placed([pocket, rail_gap], frame))
        # The fixed rail overhangs end outside the moving plate, not across a
        # tile boundary in mid-air. Webs here attach every rail nose to its tile.
        # Overlap the uncut deck beyond both pocket ends. Exact butt faces can
        # leave coincident internal sheets that OCC exposes as nonmanifold edges.
        abutments = _placed([end._box((a, low, 1.9), (b, high, 3.21)) for a, b in ((6., 11.), (POCKET[1]-.2, POCKET[1]+5))], frame)
        supports = trimesh.boolean.intersection([rail_webs, _union(abutments)], engine="manifold")
        body = _union([body, supports])
        # Screw pilots and integral keeper support posts, outside the rail ends.
        posts, holes = [], []
        for x in (9.5, 92.):
            for y in _keeper_layout(x, sign)[4]:
                posts.append(end._cylinder(2.3 if x == 9.5 else 3.2, 1.9, 3.2, x, y))
                holes.append(end._cylinder(1.3, -.1, 3.3, x, y))
        posts.append(end._cylinder(1.3, 1.9, 3.1, 50, 0))
        holes.append(end._cylinder(1.6, .4, 2.1, 64, 0))
        body = _difference(_union([body, *_placed(posts, frame)]), _placed(holes, frame))
    body = _union([body, *_seam_plugs(code, paths)])
    body = _difference(body, masks)
    return _union([_difference(_union([body, *contacts]), cuts), *additions])


def _dovetail(point, normal, clearance=0):
    # A narrow neck and wider head give a positive in-plane pull-out stop. The
    # slot is blind from below; its 6 mm ceiling bridges under the rail.
    tangent = np.array([-normal[1], normal[0]])
    pts = [(-.4, -KEY_NECK-clearance), (4+clearance, -KEY_HEAD-clearance),
           (4+clearance, KEY_HEAD+clearance), (-.4, KEY_NECK+clearance)]
    return _polygon([point+normal*u+tangent*v for u, v in pts], -.1 if clearance else 0,
                    2.05 if clearance else 1.95)


def _piece_at(pieces, point):
    probe = end._box((point[0]-.1, point[1]-.1, .9), (point[0]+.1, point[1]+.1, 1.1))
    return next((i for i, piece in enumerate(pieces)
                 if trimesh.boolean.intersection([piece, probe], engine="manifold").volume > 1e-4), None)


@lru_cache(maxsize=6)
def _base_pieces(code, adjustment, lite=False):
    """Split the fixed base along the authored seams; key every adjacent pair."""
    full = _fixed_mesh(code, adjustment, lite)
    kerf = _union([_polygon(_segment_quad(a, b, .1), -1, 12) for a, b in _seam_segments(code)])
    pieces = sorted(_difference(full, [kerf]).split(only_watertight=False),
                    key=lambda m: (round(m.bounds[0, 0], 1), round(m.bounds[0, 1], 1)))
    for point, normal, _ in _seam_sites(code):
        probe = _site_box(point, normal, -.6, 4.4, -KEY_HEAD-.4, KEY_HEAD+.4, .1, 1.8)
        if trimesh.boolean.intersection([full, probe], engine="manifold").volume < probe.volume*.995:
            continue
        owner, other = [_piece_at(pieces, point+normal*k) for k in (-2., 2.)]
        if owner is None or other is None or owner == other:
            continue
        pieces[owner] = _union([pieces[owner], _dovetail(point, normal)])
        pieces[other] = _difference(pieces[other], [_dovetail(point, normal, JOINT_CLEARANCE)])
    return pieces


def _cassette(origin, heading, sign, state, slide_sign=None):
    slide_sign = sign if slide_sign is None else slide_sign
    low, high = _slide_bounds(sign, slide_sign)
    plate = end._box((PLATE[0], low, 2.3), (PLATE[1], high, 2.9))
    straight = _clip_path(_line(100), 14, 88)
    branch = _selector_branch(sign).copy()
    branch[:, 1] -= slide_sign*SLIDE
    rails = _union([_rails(straight, 2.8), _rails(branch, 2.8)])
    rails = trimesh.boolean.intersection(
        [rails, end._box((14.4, low-1, 2.7), (85.6, high+1, 10))], engine="manifold")
    mesh = _union([plate, rails])
    # Captive longitudinal slot and fixed stop pin limit travel mechanically.
    slot_low, slot_high = sorted((0., -SLIDE*slide_sign))
    slot = _union([end._box((48.4, slot_low, 2.2), (51.6, slot_high, 3.3)),
                   end._cylinder(1.6, 2.2, 3.3, 50, slot_low),
                   end._cylinder(1.6, 2.2, 3.3, 50, slot_high)])
    mesh = _difference(mesh, [slot])
    mesh = _difference(mesh, [end._cylinder(1.6, 2.2, 3.3, 64, y)
                              for y in (0, -SLIDE*slide_sign)])
    mesh.apply_translation((0, slide_sign*SLIDE*state, 0))
    mesh.apply_transform(end._frame((*origin, 0), heading, 0))
    return mesh


def _selector_lock(origin, heading):
    """Removable positive state lock; tip and socket stay above the table."""
    pin = _union([end._cylinder(1.4, .5, 3.05, 64, 0),
                  end._cylinder(3.2, 2.9, 5.1, 64, 0)])
    pin.apply_transform(end._frame((*origin, 0), heading, 0))
    return pin


def _keeper(origin, heading, x, sign):
    left, right, low, high, screws = _keeper_layout(x, sign)
    mesh = end._box((left, low, 3.2), (right, high, 5.2))
    # Overhang catches the plate flange; moving rails stop short of the keeper.
    mesh = _difference(mesh, [end._cylinder(1.65, 3.1, 5.3, x, y) for y in screws])
    mesh.apply_transform(end._frame((*origin, 0), heading, 0))
    return mesh


def _flex_mesh(index, bend, adjustment):
    # Two staggered deck leaves and laterally interdigitating rail fingers.
    contact = _contact(ports(FAMILIES[0], dict(connector_version=1, fit_adjustment=adjustment,
                                             bend=0, switch_state=0))[index], adjustment)
    if index == 0:
        body = _union([contact, end._box((5.8, -31.9, 0), (16, 31.9, 1.4)),
                       end._cylinder(9, 0, 1.4, 16, 0)])
        # Full 7.9 mm half tie: complete bay ceilings and z=3.2 stud lands. It
        # clears the moving leaf's hub disc and keeps the nut drop open above.
        tie = _difference(end._box((5.8, -31.9, 0), (7.9, 31.9, 3.2)),
                          [end._cylinder(9.3, 1.5, 3.3, 16, 0), end._box((5.79, -2.95, 1.4), (8, 2.95, 3.3))])
        body = _union([body, tie, end._cylinder(5, 1.3, 3.5, 16, 0),
                       end._cylinder(.8, 1.3, 3.0, 23.5, 0)])
        # Drop the nut into the inlet-side channel, then slide it under the hub.
        hexagon = [(16+3.4*math.cos(a), 3.4*math.sin(a))
                   for a in np.arange(6)*math.pi/3]
        pocket = _union([_polygon(hexagon, .4, 2.85),
                         end._box((6, -2.95, .4), (16, 2.95, 2.85))])
        body = _difference(body, [pocket])
        full = _rails(_clip_path(_line(32), 5.8, 8))
        fingers = [end._box((7.9, y-.4, 1.3), (20, y+.4, 9.6)) for y in (-20.8, 20.8)]
        # 64022 guard ridge and z=6.4 floor inside each rail. They stop at
        # x=13.8, >=0.4 mm clear of the moving leaf's swept ridge, deck and toe.
        fingers += [end._box((7.85, min(sign*13.4, sign*14.8), 1.3), (13.8, max(sign*13.4, sign*14.8), 9.6))
                    for sign in (-1, 1)]
        fingers += [end._box((7.85, min(sign*14.75, sign*18.2), 1.3), (13.8, max(sign*14.75, sign*18.2), 6.4))
                    for sign in (-1, 1)]
    else:
        # The outer 7.9 mm half tie is full depth outside the fixed hub disc.
        tie = _difference(end._box((24.1, -31.9, 0), (26.21, 31.9, 3.2)),
                          [end._cylinder(9.4, -1, 1.8, 16, 0)])
        body = _union([contact, end._box((16, -31.9, 1.8), (26.2, 31.9, 3.2)),
                       end._cylinder(9, 1.8, 3.2, 16, 0), tie])
        body = _difference(body, [end._box((10, y-1.6, 1.7), (23, y+1.6, 3.3))
                                  for y in (-20.7, 20.7)])
        stop_angles = np.linspace(-MAX_BEND + math.asin(.15/7.5),
                                  MAX_BEND - math.asin(.15/7.5), 17)
        stop_slot = _union([end._cylinder(.95, 1.7, 3.3,
                    16+7.5*math.cos(a), 7.5*math.sin(a)) for a in stop_angles])
        body = _difference(body, [stop_slot])
        full = _rails(_clip_path(_line(32), 24, 26.2))
        # Toe relief keeps the flange corridor clear at both articulation limits;
        # a constant-width straight inner finger would sweep into the inlet.
        toe = [(13, 19.2), (16, 18.91), (18, 18.8), (24.1, 18.8),
               (24.1, 19.6), (18, 19.6), (16, 19.71), (13, 20.)]
        fingers = [_polygon([(x, sign*y) for x, y in toe], 3.1, 9.6) for sign in (-1, 1)]
        guard = [(16, 14.75), (24.15, 14.75), (24.15, 18.85), (18, 18.85), (16, 18.95)]
        fingers += [end._box((16, min(sign*13.4, sign*14.8), 3.1), (24.15, max(sign*13.4, sign*14.8), 9.6))
                    for sign in (-1, 1)]
        fingers += [_polygon([(x, sign*y) for x, y in guard], 3.1, 6.4) for sign in (-1, 1)]
    # 64022's link is open outside the rails; keep the 7.8 mm rail stringers.
    link = (7.85, 16) if index == 0 else (16, 24.1)
    outside = [end._box((link[0], min(sign*23.9, sign*40), -1), (link[1], max(sign*23.9, sign*40), 12))
               for sign in (-1, 1)]
    mesh = _difference(_union([_difference(body, outside), full, *fingers]),
                       [end._cylinder(1.7 if index == 0 else 5.3, -.1, 4, 16, 0)])
    # Same production half-tie clutch as every other official-facing port.
    port = ports(FAMILIES[0], dict(connector_version=1, fit_adjustment=adjustment, bend=0, switch_state=0))[index]
    cuts, additions = _end_attachments(port, end.PROFILE["brickAttachment"]["flexStudLateralOffsets"])
    mesh = _union([_difference(mesh, cuts), *additions])
    if index == 1:
        frame = end._frame((16, 0, 0), bend, 0)
        frame[:3, 3] -= frame[:3, :3] @ np.array([16, 0, 0])
        mesh.apply_transform(frame)
    return mesh


@lru_cache(maxsize=12)
def _component_meshes(code, adjustment, bend, state, lite=False):
    # Fast print leaves the flex leaves (only end half ties and mechanism) and
    # every selector, keeper and state-lock pin unchanged.
    if code == 0:
        return [("pivot-leaf", _flex_mesh(0, 0, adjustment)),
                ("articulating-leaf", _flex_mesh(1, bend, adjustment))]
    full = _fixed_mesh(code, adjustment, lite)
    rows = []
    if code == 3:
        rows.append(("crossing-base", full))
    else:
        for index, piece in enumerate(_base_pieces(code, adjustment, lite)):
            rows.append((f"keyed-base-{index+1:02d}", piece))
        for index, (origin, heading, sign) in enumerate(_selectors(code)):
            rows.append((f"selector-{index+1}", _cassette(
                origin, heading, sign, state, 1 if code == 4 else sign)))
            for side, x in enumerate((9.5, 92.)):
                rows.append((f"keeper-{index+1}-{side+1}", _keeper(origin, heading, x, sign)))
            rows.append((f"selector-lock-{index+1}", _selector_lock(origin, heading)))
    return rows


def _meshes(code, p):
    return _component_meshes(code, p["fit_adjustment"], p["bend"], p["switch_state"], fast.enabled(p))


def components(family: str, p: dict[str, float]) -> list[dict]:
    validate(family, p)
    code = FAMILIES.index(family)
    return [{"role": role, "parameters": {**p, "shape_code": code, "component_index": index}}
            for index, (role, _) in enumerate(_meshes(code, p))]


def validate_component(p: dict[str, float]) -> None:
    if set(p) - {"lite"} != COMPONENT_PARAMETERS:
        raise ValueError("unexpected track component parameters")
    code, index = p["shape_code"], p["component_index"]
    if isinstance(code, bool) or not isinstance(code, (int, float)) or not math.isfinite(code) or code != int(code) or not 0 <= code < len(FAMILIES):
        raise ValueError("invalid shape_code")
    validate(FAMILIES[int(code)], {k: v for k, v in p.items() if k not in ("shape_code", "component_index")})
    if isinstance(index, bool) or not isinstance(index, (int, float)) or not math.isfinite(index) or index != int(index) or index < 0:
        raise ValueError("invalid component_index")
    if index >= len(_meshes(int(code), p)):
        raise ValueError("component_index outside assembly")


def build_component(p: dict[str, float]) -> cq.Shape:
    validate_component(p)
    role, mesh = _meshes(int(p["shape_code"]), p)[int(p["component_index"])]
    if not mesh.is_watertight or len(mesh.split(only_watertight=False)) != 1:
        raise ValueError(f"{role} is not a connected watertight component")
    if np.any(mesh.extents[:2] > 166+.001):
        raise ValueError(f"{role} exceeds the 166 mm usable mini bed")
    # Same bounded seam retriangulation as brick_end.track: remove float32
    # zero-area boolean junction triangles before OpenCascade sewing.
    manifold = manifold3d.Manifold(manifold3d.Mesh(np.float32(mesh.vertices), np.uint32(mesh.faces)))
    cleaned = manifold.simplify(1e-5).to_mesh()
    result = trimesh.Trimesh(cleaned.vert_properties[:, :3], cleaned.tri_verts, process=True)
    if not result.is_volume or len(result.split(only_watertight=False)) != 1:
        raise ValueError(f"{role} lost connected volume during seam retriangulation")
    return end._solid(result)


def probe_motion(family, p, steps=33):
    """Actual solid interference throughout travel; raises, never records fake passes.

    Physical wheel tread/flange compatibility, friction, flex fatigue and screw
    torque cannot be established by this probe and are explicitly not certified.
    """
    validate(family, p)
    if steps < 3:
        raise ValueError("motion probe needs at least three samples")
    code = FAMILIES.index(family)
    collision_max = 0.
    if code == 0:
        fixed = _union([_flex_mesh(0, 0, p["fit_adjustment"]), _flex_hardware_mesh()])
        states = [(_flex_mesh(1, b, p["fit_adjustment"]), fixed)
                  for b in np.linspace(-MAX_BEND, MAX_BEND, steps)]
    else:
        fixed = _fixed_mesh(code, p["fit_adjustment"], fast.enabled(p))
        selectors = _selectors(code)
        stationary = _union([fixed, *[_keeper(origin, heading, x, sign)
                            for origin, heading, sign in selectors for x in (9.5, 92)]])
        states = []
        for t in np.linspace(0, 1, steps):
            moving = [_cassette(origin, heading, sign, t, 1 if code == 4 else sign)
                      for origin, heading, sign in selectors]
            states += [(mesh, stationary) for mesh in moving]
            states += [(a, b) for i, a in enumerate(moving) for b in moving[i+1:]]
    for moving, fixed in states:
        overlap = trimesh.boolean.intersection([moving, fixed], engine="manifold")
        collision_max = max(collision_max, abs(overlap.volume))
    if collision_max > .01:
        raise ValueError(f"mechanism interferes through travel: {collision_max:.6f} mm^3")
    return {"samples": len(states), "maximumInterferenceMm3": collision_max,
            "state": "unlocked; remove printed state-lock pins before switching",
            "physicalFit": "not_checked", "wheelFlangeClearanceMm": FLANGE_CLEARANCE}


def hardware(family, p):
    validate(family, p)
    if family == FAMILIES[0]:
        return [hw.row("M3 x 4 mm button-head machine screw", 1, hw.FASTENERS),
                hw.row("M3 hex nut, 5.5 mm across flats x 2.4 mm high", 1, hw.FASTENERS),
                hw.row("3.2 mm ID x 12 mm OD x 1 mm thick flat washer", 1, hw.FASTENERS)]
    count = len(_selectors(FAMILIES.index(family)))
    return [hw.m3_screw(4, 4*count)] if count else []


def assembly_notes(family, p):
    validate(family, p)
    if family == FAMILIES[0]:
        return [
            "Keep both leaves in their exported assembly coordinates; do not mirror the source contacts.",
            "Before fitting the moving leaf, drop the M3 nut into the inlet-side centre channel and slide it under the raised hub.",
            "Fit the moving leaf over the hub and engage its curved stop slot with the integral pin.",
            "Fit the specified 12 mm OD, 1 mm thick washer and M3 x 4 button-head screw from above; the washer seats on the stationary hub, leaving 0.3 mm above the moving leaf.",
            "The captive nut starts 0.4 mm above the table datum; no screw, nut or plastic is intended below z=0.",
            "Check the full +/-5.625 degree range by hand before a wheel test."]
    notes = [
        "Lay the keyed base pieces on a flat surface and lower the matching dovetails together.",
        "Support the base on a flat table or clutch it to bricks at the end ties; the dovetails stop sideways separation, not lifting.",
        "Keep frog channels free of support material."]
    if family != FAMILIES[3]:
        notes += [
            "Lower each selector onto its floor and engage the integral stop pin with the long underside slot before fitting its two keepers.",
            "Fit the two keeper bridges using four M3 x 4 self-tapping screws per selector from above. Never substitute a longer screw that protrudes below z=0.",
            "Slide to the physical end stop: travel is 56 mm. Keeper overhangs retain the plate vertically; the pin/slot prevents withdrawal.",
            "Insert the removable printed state-lock pin through the aligned cassette hole into its fixed-floor socket before running a train. Each selector has its own pin.",
            "Remove every selector's state-lock pin before changing route, then move to the other end stop and reinsert all pins.",
            "Don't move a selector while a train is on it."]
    if family == FAMILIES[4]:
        notes.append("Set all four selectors to the same state. The two selectors at each end move in the same direction and must move together.")
    return notes


def _flex_hardware_mesh():
    nut = _polygon([(16+(5.5/math.sqrt(3))*math.cos(a),
                     (5.5/math.sqrt(3))*math.sin(a)) for a in np.arange(6)*math.pi/3], .4, 2.8)
    nut = _difference(nut, [end._cylinder(1.3, .3, 2.9, 16, 0)])
    washer = _difference(end._cylinder(6, 3.5, 4.5, 16, 0),
                         [end._cylinder(1.6, 3.4, 4.6, 16, 0)])
    screw = _union([end._cylinder(1.5, .5, 4.6, 16, 0),
                    end._cylinder(2.85, 4.5, 6.15, 16, 0)])
    # Thread overlap is intentional; this union is only a plastic interference probe.
    return _union([nut, washer, screw])


def probe_running_clearances(family, p):
    """Quantify actual selected-route flange obstruction and running-head gaps.

    The digital wheel envelope here is explicitly 2.2 x 3.2 mm, not a claim about
    every train wheel. A 4 mm unsupported span limit is a design gate, not a
    tested physical wheel/tread acceptance criterion.
    """
    validate(family, p)
    code = FAMILIES.index(family)
    meshes = [mesh for _, mesh in _meshes(code, p)]
    assembly = _union(meshes)
    if code == 0:
        path = np.array([(0., 0., 0.), (16., 0., 0.), (16., 0., p["bend"]),
                         (16+16*math.cos(p["bend"]), 16*math.sin(p["bend"]), p["bend"])])
        paths = [path]
    else:
        all_paths = _fixed_paths(code)
        paths = all_paths if code == 3 else ([all_paths[int(p["switch_state"])]] if code in (1, 2)
                                             else all_paths[2:] if p["switch_state"] else all_paths[:2])
    # Source rigid contacts have separately verified interfaces. Exclude first/
    # last 6 mm here rather than treating decorative latch features as wheels.
    flange_max, gap_max = 0., 0.
    for path in paths:
        lengths = np.r_[0, np.cumsum(np.linalg.norm(np.diff(path[:, :2], axis=0), axis=1))]
        stations = np.arange(6., lengths[-1]-6., .5)
        sampled = np.column_stack([np.interp(stations, lengths, path[:, axis]) for axis in range(3)])
        if not len(sampled):
            continue
        edges = np.array([[np.interp(station, lengths, path[:, axis]) for axis in range(3)]
                          for station in (6., lengths[-1]-6.)])
        flange_path = np.vstack([edges[0], path[(lengths > 6) & (lengths < lengths[-1]-6)], edges[1]])
        for cutter in _flangeways([flange_path]):
            flange_max = max(flange_max, abs(trimesh.boolean.intersection([assembly, cutter], engine="manifold").volume))
        for lateral in (-20., 20.):
            gap = 0.
            for x, y, h in sampled:
                # Use the nominal head footprint, not one arbitrary centre ray:
                # the flex's intentionally interdigitating fingers are offset.
                frame = end._frame((x, y, 0), h, 0)
                probe = end._box((-.1, lateral-1.2, 9.35), (.1, lateral+1.2, 9.55))
                probe.apply_transform(frame)
                supported = trimesh.boolean.intersection([assembly, probe], engine="manifold").volume > .002
                gap = 0. if supported else gap+.5
                gap_max = max(gap_max, gap)
    if flange_max > .01:
        raise ValueError(f"selected wheel-flange corridor obstructed: {flange_max:.6f} mm^3")
    if gap_max > 4.:
        raise ValueError(f"unsupported running-head gap: {gap_max:.3f} mm")
    return {"flangeObstructionMm3": flange_max, "maximumUnsupportedSpanMm": gap_max,
            "samplePitchMm": .5, "physicalWheelAcceptance": "not_checked"}


def probe_operating_envelopes(family, p):
    """Assert shared TS/Python mechanism envelopes contain the moving solids."""
    validate(family, p)
    code = FAMILIES.index(family)
    polygons = MECHANISM_PROFILE["operationalEnvelopes"].get(family, [])
    if not polygons:
        return {"regions": 0}
    regions = _union([_polygon(poly, -.01, MECHANISM_PROFILE["operationalHeight"]+.01) for poly in polygons])
    maximum = 0.
    for state in np.linspace(0, 1, 9):
        for origin, heading, sign in _selectors(code):
            parts = [_cassette(origin, heading, sign, state, 1 if code == 4 else sign),
                     _keeper(origin, heading, 9.5, sign), _keeper(origin, heading, 92, sign),
                     _selector_lock(origin, heading)]
            for part in parts:
                maximum = max(maximum, abs(_difference(part, [regions]).volume))
    if maximum > .01:
        raise ValueError(f"mechanism exceeds published operating envelope: {maximum:.6f} mm^3")
    return {"regions": len(polygons), "outsideVolumeMm3": maximum}


def probe_retention(family, p):
    """Attempt vertical withdrawal and over-travel; actual stops must obstruct."""
    validate(family, p)
    code = FAMILIES.index(family)
    pairs = []
    if code == 0:
        fixed = _union([_flex_mesh(0, 0, p["fit_adjustment"]), _flex_hardware_mesh()])
        lifted = _flex_mesh(1, 0, p["fit_adjustment"])
        lifted.apply_translation((0, 0, .7))
        pairs.append(("washer-uplift", lifted, fixed))
        for direction in (-1, 1):
            pairs.append(("flex-angular-stop", _flex_mesh(1, direction*(MAX_BEND+.04), p["fit_adjustment"]), fixed))
    else:
        fixed = _fixed_mesh(code, p["fit_adjustment"], fast.enabled(p))
        for origin, heading, sign in _selectors(code):
            slide_sign = 1 if code == 4 else sign
            keepers = _union([_keeper(origin, heading, x, sign) for x in (9.5, 92)])
            lifted = _cassette(origin, heading, sign, .5, slide_sign)
            lifted.apply_translation((0, 0, .7))
            pairs.append(("keeper-uplift", lifted, keepers))
            for state in (-1/SLIDE, 1+1/SLIDE):
                pairs.append(("selector-travel-stop", _cassette(origin, heading, sign, state, slide_sign), fixed))
    report = []
    for name, moving, fixed in pairs:
        volume = abs(trimesh.boolean.intersection([moving, fixed], engine="manifold").volume)
        if volume < .01:
            raise ValueError(f"{name} does not mechanically retain the moving part")
        report.append({"stop": name, "blockedVolumeMm3": volume})
    return report


def probe_base_joints(family, p):
    """Every base component must join the assembly through a real pull-out stop."""
    validate(family, p)
    code = FAMILIES.index(family)
    if code in (0, 3):
        return {"components": 1 if code == 3 else 0, "retainedConnections": []}
    rows = [(name, mesh) for name, mesh in _meshes(code, p)
            if name.startswith("keyed-base")]
    adjacency = [set() for _ in rows]
    evidence = []
    for i, (name, mesh) in enumerate(rows):
        for j, (other_name, other) in enumerate(rows[i+1:], i+1):
            if np.any(mesh.bounds[0, :2] > other.bounds[1, :2]+1) or np.any(other.bounds[0, :2] > mesh.bounds[1, :2]+1):
                continue
            rest = abs(trimesh.boolean.intersection([mesh, other], engine="manifold").volume)
            if rest > .01:
                raise ValueError(f"base joint interference: {name}/{other_name}: {rest:.6f} mm^3")
            # A keyed seam blocks every in-plane 1 mm displacement; bare
            # neighbours can always slide apart in at least one direction.
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
        missing = [rows[i][0] for i in range(len(rows)) if i not in reached]
        raise ValueError(f"base components lack retained assembly joints: {missing}")
    return {"components": len(rows), "retainedConnections": evidence}


def probe_source_contacts(family, p):
    """Compare unchanged central source interfaces after full componentization.

    Only the half-tie stud envelopes are exempt: they are brick attachments
    standing on the source deck, not part of the lobe/socket/latch interface.
    """
    validate(family, p)
    code = FAMILIES.index(family)
    assembly = _union([mesh for _, mesh in _meshes(code, p)])
    a = end.PROFILE["brickAttachment"]
    columns = a["flexStudLateralOffsets"] if code == 0 else a["studLateralOffsets"]
    report = []
    for port in ports(family, p):
        local = assembly.copy()
        local.apply_transform(np.linalg.inv(end._frame(port["position"], port["heading"]+math.pi, 0)))
        region = _difference(end._box((-5, -23.9, -.01), (5.79, 23.9, 10)),
                             [end._box((4-2.45, y-2.45, 3.2), (4+2.45, y+2.45, 4.9)) for y in columns])
        source = end.end_mesh(p["fit_adjustment"], opposite=port["id"] not in ("in", "parallel-in", "south"))
        expected = trimesh.boolean.intersection([source, region], engine="manifold")
        actual = trimesh.boolean.intersection([local, region], engine="manifold")
        lost = abs(_difference(expected, [actual]).volume)
        added = abs(_difference(actual, [expected]).volume)
        if max(lost, added) > .005:
            raise ValueError(f"source interface changed at {port['id']}: lost={lost:.6f}, added={added:.6f} mm^3")
        report.append({"port": port["id"], "lostMm3": lost, "addedMm3": added})
    return report


def probe_tie_attachments(family, p):
    """Measure an ordinary-span gap, clutch roof, outer and inner studs and a pin."""
    validate(family, p)
    code = FAMILIES.index(family)
    if code == 0:
        return {"exception": "32 mm articulation leaves; production half-tie clutch at both ports"}
    if fast.enabled(p):
        return {"exception": "fast print: brick clutch only at the end half ties"}
    body = _fixed_mesh(code, p["fit_adjustment"])
    depth = end.PROFILE["brickAttachment"]["cavityDepth"]
    # Crossing arm tie (32087): row at s=28, centre pins at lateral 0/+-8, outer
    # pin at s=32. Turnout straight tie 224 is clear of the diverging route; on
    # the crossover, straight tie 192 keeps its centre and outer clutch.
    if code == 3:
        station, gap, row, pin, bay = 28., 16., 28., (32., -28.), (2.2, 5.8)
    else:
        station = 192. if code == 4 else 224.
        gap, row, pin, bay = station+16, station+4, (station, -28.), (-2., 2.)
    specimens = {
        "openGap": end._box((gap-1, -2, .1), (gap+1, 2, 3.1)),
        "undersideBay": end._box((station-1, bay[0], .1), (station+1, bay[1], depth-.1)),
        "tieRoof": end._box((station-1, bay[0], depth+.1), (station+1, bay[1], 3.1)),
        "stud": end._cylinder(2.3, 3.3, 4.7, row, -28),
        "innerStud": end._cylinder(2.3, 3.3, 4.7, row, 4),
        "undersidePin": end._cylinder(1.5, .1, depth-.1, *pin),
    }
    evidence = {}
    for name, specimen in specimens.items():
        volume = abs(trimesh.boolean.intersection([body, specimen], engine="manifold").volume)
        evidence[name] = volume
        if name in ("openGap", "undersideBay"):
            if volume > .01:
                raise ValueError(f"ordinary track {name} is filled: {volume:.6f} mm^3")
        elif abs(volume-specimen.volume) > .01:
            raise ValueError(f"ordinary track {name} is missing: {volume:.6f}/{specimen.volume:.6f} mm^3")
    return evidence


def probe_state_locks(family, p):
    """A fitted pin must prevent both directions of travel in either selected state."""
    validate(family, p)
    code = FAMILIES.index(family)
    report = []
    for index, (origin, heading, sign) in enumerate(_selectors(code)):
        pin = _selector_lock(origin, heading)
        fixed = _fixed_mesh(code, p["fit_adjustment"], fast.enabled(p))
        if abs(trimesh.boolean.intersection([pin, fixed], engine="manifold").volume) > .01:
            raise ValueError("state-lock pin interferes with its stationary socket")
        slide_sign = 1 if code == 4 else sign
        for state in (0, 1):
            cassette = _cassette(origin, heading, sign, state, slide_sign)
            if abs(trimesh.boolean.intersection([pin, cassette], engine="manifold").volume) > .01:
                raise ValueError("state-lock pin does not fit the selected cassette hole")
            for direction in (-1, 1):
                displaced = cassette.copy()
                displaced.apply_translation((-direction*math.sin(heading), direction*math.cos(heading), 0))
                blocked = abs(trimesh.boolean.intersection([pin, displaced], engine="manifold").volume)
                if blocked < .01:
                    raise ValueError(f"selector {index+1} state {state} is not positively locked")
                report.append({"selector": index+1, "state": state, "direction": direction,
                               "blockedVolumeMm3": blocked})
    return report
