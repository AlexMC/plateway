"""Versioned source-mesh contacts and rail section; no integral print aids.

The bundled profile records source hashes, measurements and credit: the reference
STLs come from a straight rerailer by lev (Printables #466240, CC BY 4.0).
Fit adjustment is a per-side lateral material offset of the mating tongues,
not scaling of the track, rail gauge, running rails, or attachment studs.
"""

from __future__ import annotations

from functools import lru_cache
import hashlib
import json
import math
from pathlib import Path
import tempfile

import cadquery as cq
import manifold3d
import numpy as np
from OCP.BRepBuilderAPI import BRepBuilderAPI_MakeSolid, BRepBuilderAPI_Sewing
from OCP.StlAPI import StlAPI_Reader
from OCP.TopoDS import TopoDS, TopoDS_Shape
import trimesh


PROFILE_PATH = Path(__file__).resolve().parents[1] / "profiles/brick-v1.json"
PROFILE = json.loads(PROFILE_PATH.read_text())
REFERENCE_STL = Path(__file__).resolve().parent / "reference/brick_red_coupon.stl"
RAIL_REFERENCE_STL = REFERENCE_STL.parent / "rerailer_straight_full.stl"
RAIL_TOP = PROFILE["railTop"]
_RAIL_PROFILE = PROFILE["railSection"]
STL_TOLERANCE, STL_ANGULAR_TOLERANCE = .02, .1   # mm, rad: how generate_part tessellates a part for its STL
SLIVER_TOLERANCE = 1e-4                          # mm: furthest a surface moves when needle triangles are simplified away


def validate(p: dict[str, float]) -> None:
    if p.get("connector_version") != PROFILE["version"]:
        raise ValueError("unsupported brick track connector version")
    adjustment = p.get("fit_adjustment", float("nan"))
    if not PROFILE["fitAdjustmentMin"] <= adjustment <= PROFILE["fitAdjustmentMax"]:
        raise ValueError("fit adjustment must be between -0.15 and 0.15 mm")
    for key, expected in (("body_width", "bodyWidth"), ("deck_width", "bodyWidth"),
                          ("base_thickness", "baseThickness"), ("deck_thickness", "baseThickness"),
                          ("rail_gauge", "railGauge"), ("rail_interface_width", "railInterfaceWidth"),
                          ("rail_height", "railHeight")):
        if key in p and not math.isclose(p[key], PROFILE[expected], abs_tol=1e-9):
            raise ValueError(f"{key} must match the versioned brick track profile")


def _box(low, high) -> trimesh.Trimesh:
    low, high = np.asarray(low), np.asarray(high)
    box = trimesh.creation.box(extents=high - low)
    box.apply_translation((low + high) / 2)
    return box


def _mesh(shape: cq.Shape) -> trimesh.Trimesh:
    if not shape.isValid() or len(shape.Solids()) != 1 or shape.Volume() <= 0:
        raise ValueError("centre profile sweep must be one valid solid")
    with tempfile.TemporaryDirectory(prefix="track-profile-") as directory:
        path = Path(directory) / "shape.stl"
        # Relative deflection scales with long edges and can flatten shallow
        # Hermite ramps. Keep the authored path/profile accurate in millimetres.
        shape.exportStl(str(path), tolerance=.001, angularTolerance=.02, relative=False)
        return trimesh.load_mesh(path, process=True)


def _solid(mesh: trimesh.Trimesh) -> cq.Shape:
    """`mesh` as one CAD solid that stays valid when tessellated for STL export. A boolean cut can leave needle
    triangles (well under a micron thick) that sew into a valid solid which OCC rejects once it is tessellated: only
    such a mesh is simplified (by at most SLIVER_TOLERANCE), so every other part is unchanged."""
    if not mesh.is_watertight or len(mesh.split(only_watertight=False)) != 1:
        raise ValueError("shared track geometry must remain one watertight solid")
    shape = _sewn(mesh)
    if _exports_valid(shape):
        return shape
    shape = _sewn(_without_slivers(mesh))
    if not _exports_valid(shape):
        raise ValueError("shared track geometry must stay one valid CAD solid when exported")
    return shape


def _sewn(mesh: trimesh.Trimesh) -> cq.Shape:
    with tempfile.TemporaryDirectory(prefix="track-solid-") as directory:
        path = Path(directory) / "shape.stl"
        mesh.export(path)
        imported = TopoDS_Shape()
        if not StlAPI_Reader().Read(imported, str(path)):
            raise ValueError("cannot read shared track mesh")
        sewing = BRepBuilderAPI_Sewing(0.001)
        sewing.Add(imported)
        sewing.Perform()
        shells = cq.Shape(sewing.SewedShape()).Shells()
        if len(shells) != 1:
            raise ValueError("shared track geometry must retain one exterior shell")
        # Merge coplanar triangle faces without moving their surfaces; otherwise
        # OCC can omit narrow root-junction triangles when exporting the solid.
        shape = cq.Shape(BRepBuilderAPI_MakeSolid(TopoDS.Shell_s(shells[0].wrapped)).Solid()).clean()
        if not shape.isValid() or len(shape.Solids()) != 1 or shape.Volume() <= 0:
            raise ValueError("shared track geometry must retain one valid CAD solid")
        return shape


def _exports_valid(shape: cq.Shape) -> bool:
    """Tessellate as generate_part's STL export does (it reuses this triangulation) and recheck the solid."""
    with tempfile.TemporaryDirectory(prefix="track-export-") as directory:
        shape.exportStl(str(Path(directory) / "shape.stl"), tolerance=STL_TOLERANCE, angularTolerance=STL_ANGULAR_TOLERANCE)
    return shape.isValid() and len(shape.Solids()) == 1 and shape.Volume() > 0


def _without_slivers(mesh: trimesh.Trimesh) -> trimesh.Trimesh:
    solid = manifold3d.Manifold(manifold3d.Mesh(vert_properties=np.asarray(mesh.vertices, dtype=np.float32),
                                                tri_verts=np.asarray(mesh.faces, dtype=np.uint32)))
    out = solid.simplify(SLIVER_TOLERANCE).to_mesh()
    return trimesh.Trimesh(np.asarray(out.vert_properties)[:, :3], np.asarray(out.tri_verts), process=False)


@lru_cache(maxsize=2)
def _nominal_mesh(source_digest: str) -> trimesh.Trimesh:
    """Clean source contacts once; retain the accepted nominal sample construction."""
    source = trimesh.load_mesh(REFERENCE_STL, process=True)
    cutters = []
    for lateral, roof in ((21.55, 3.4), (-19.5, 2.1)):
        cutter = _box((-6, lateral - 5.1, -.2), (-.3, lateral + 5.1, roof))
        opposite = cutter.copy()
        opposite.apply_transform([[-1, 0, 0, 24], [0, -1, 0, 0],
                                  [0, 0, 1, 0], [0, 0, 0, 1]])
        cutters.extend((cutter, opposite))
    for lateral in (-20, 20):
        cutters.append(_box((5.8, lateral - 3.1, 3.2), (18.2, lateral + 3.1, 10)))
    base = trimesh.boolean.difference([source, *cutters], engine="manifold")
    rails = [_mesh(cq.Workplane("YZ", origin=(5.8, lateral, 0)).polyline(
        _RAIL_PROFILE).close().extrude(12.4).val()) for lateral in (-20, 20)]
    return trimesh.boolean.union([base, *rails], engine="manifold")


def nominal_mesh() -> trimesh.Trimesh:
    return _nominal_mesh(hashlib.sha256(REFERENCE_STL.read_bytes()).hexdigest()).copy()


def _adjust_contacts(mesh: trimesh.Trimesh, adjustment: float) -> trimesh.Trimesh:
    if adjustment == 0:
        return mesh
    masks = []
    for lateral in (-20, 20):
        # Extend past the contact's x=4.1 root to avoid a coincident boolean face.
        mask = _box((-4, lateral - 3.2, 2.09), (4.12, lateral + 3.2, 9.61))
        other = mask.copy()
        other.apply_transform([[-1, 0, 0, 24], [0, -1, 0, 0],
                               [0, 0, 1, 0], [0, 0, 0, 1]])
        masks.extend((mask, other))
    mask = trimesh.boolean.union(masks, engine="manifold")
    shifted = []
    for distance in (-abs(adjustment), abs(adjustment)):
        copy = mesh.copy()
        copy.apply_translation((0, distance, 0))
        shifted.append(copy)
    if adjustment > 0:
        changed = trimesh.boolean.intersection([mesh, *shifted], engine="manifold")
    else:
        changed = trimesh.boolean.union([mesh, *shifted], engine="manifold")
    changed = trimesh.boolean.intersection([changed, mask], engine="manifold")
    untouched = trimesh.boolean.difference([mesh, mask], engine="manifold")
    return trimesh.boolean.union([untouched, changed], engine="manifold")


def build(p: dict[str, float]) -> cq.Shape:
    validate(p)
    if p["body_length"] != PROFILE["sampleLength"]:
        raise ValueError("connector sample has a fixed 24 mm body")
    return _solid(_adjust_contacts(nominal_mesh(), p["fit_adjustment"]))


def end_mesh(adjustment: float, *, opposite: bool = False) -> trimesh.Trimesh:
    """Accepted A or B contact, port at origin and inward direction +x."""
    mesh = _adjust_contacts(nominal_mesh(), adjustment)
    if opposite:
        mesh.apply_transform([[-1, 0, 0, PROFILE["sampleLength"]], [0, -1, 0, 0],
                              [0, 0, 1, 0], [0, 0, 0, 1]])
    # Small hidden overlap makes angled faceted end/sweep unions robust.
    return trimesh.boolean.intersection(
        [mesh, _box((-6, -33, -1), (PROFILE["endLength"] + .05, 33, 11))], engine="manifold")


def _frame(position, heading: float, grade: float) -> np.ndarray:
    pitch = math.atan(grade)
    c, s, cp, sp = math.cos(heading), math.sin(heading), math.cos(pitch), math.sin(pitch)
    return np.array([[c * cp, -s, -c * sp, position[0]],
                     [s * cp, c, -s * sp, position[1]],
                     [sp, 0, cp, position[2]], [0, 0, 0, 1]])


def _bezier(points) -> cq.Edge:
    return cq.Edge.makeBezier([cq.Vector(*point) for point in points])


def _split(points: np.ndarray, t: float) -> tuple[np.ndarray, np.ndarray]:
    levels = [points]
    while len(levels[-1]) > 1:
        previous = levels[-1]
        levels.append((1 - t) * previous[:-1] + t * previous[1:])
    return (np.array([level[0] for level in levels]),
            np.array([level[-1] for level in reversed(levels)]))


def _segment(points: np.ndarray, low: float, high: float) -> np.ndarray:
    left, _ = _split(points, high)
    _, segment = _split(left, low / high)
    return segment


def _centre_path(p, family, start, end, length):
    """Return path and conservative maximum centreline deviation between ports.

    Simple upper bounds: curves 2*d²/R; Hermite ramps 2*d²*K, where d=5.8
    and K=max(|6*rise/run²-(4*g0+2*g1)/run|,
              |-6*rise/run²+(2*g0+4*g1)/run|).
    The returned value is the tighter control-point bound used below.
    """
    depth = PROFILE["endLength"]
    blend = min(4 * depth, (length - .8) / 2)
    a, b = start[:3, 3] + depth * start[:3, 0], end[:3, 3] - depth * end[:3, 0]
    if family == "printed_curve":
        radius, angle, side = p["radius"], abs(p["sweep"]), math.copysign(1, p["sweep"])

        def at(theta):
            return np.array([radius * math.sin(theta), side * radius * (1 - math.cos(theta)), 0])

        def tangent(theta):
            return np.array([math.cos(theta), side * math.sin(theta), 0])

        theta = blend / radius
        handle = 4 * radius / 3 * math.tan((blend - depth) / radius / 4)
        first = np.array([a, a + handle * tangent(0),
                          at(theta) - handle * tangent(theta), at(theta)])
        last = np.array([at(angle - theta), at(angle - theta) + handle * tangent(angle - theta),
                         b - handle * tangent(angle), b])
        arc = cq.Edge.makeThreePointArc(cq.Vector(*at(theta)), cq.Vector(*at(angle / 2)),
                                        cq.Vector(*at(angle - theta)))
        # Compare with the cubic Hermite interpolant of the exact circular arc.
        # Its vector remainder is <= R*delta^4/384; Bezier differences are
        # bounded by their control-point differences (convex hull property).
        delta = (blend - depth) / radius
        reference = np.array([at(depth / radius),
                              at(depth / radius) + radius * delta / 3 * tangent(depth / radius),
                              at(theta) - radius * delta / 3 * tangent(theta), at(theta)])
        deviation = max(depth * depth / (2 * radius),
                        np.linalg.norm(first - reference, axis=1).max() + radius * delta ** 4 / 384)
        return cq.Wire.assembleEdges([_bezier(first), arc, _bezier(last)]), float(deviation)
    if family == "vertical_transition":
        run, rise = p["run"], p["rise"]
        original = np.array([[0, 0, 0], [run / 3, 0, p["start_grade"] * run / 3],
                             [2 * run / 3, 0, rise - p["end_grade"] * run / 3],
                             [run, 0, rise]])
        first = _segment(original, a[0] / run, blend / run)
        last = _segment(original, 1 - blend / run, b[0] / run)
        before, after = first.copy(), last.copy()
        first[0] = a
        first[1] = a + np.array([1, 0, p["start_grade"]]) * (blend - a[0]) / 3
        last[3] = b
        last[2] = b - np.array([1, 0, p["end_grade"]]) * (b[0] - run + blend) / 3
        middle = _segment(original, blend / run, 1 - blend / run)
        # Bézier difference lies in the convex hull of its control differences.
        deviation = max(np.linalg.norm(first - before, axis=1).max(),
                        np.linalg.norm(last - after, axis=1).max())
        # Include the rigid region's vertical displacement from the original
        # Hermite curve, bounded by its cubic control differences.
        for low, high, origin, grade in ((0, a[0] / run, start[:3, 3], p["start_grade"]),
                                          (b[0] / run, 1, end[:3, 3], p["end_grade"])):
            section = _segment(original, low, high)
            line = np.array([[q[0], 0, origin[2] + grade * (q[0] - origin[0])] for q in section])
            deviation = max(deviation, np.linalg.norm(section - line, axis=1).max())
        return cq.Wire.assembleEdges([_bezier(first), _bezier(middle), _bezier(last)]), float(deviation)
    return cq.Wire.assembleEdges([cq.Edge.makeLine(cq.Vector(*a), cq.Vector(*b))]), 0.0


def is_official_curve(p, family) -> bool:
    """The catalogue R40 (53400) curve; printed-only radii keep the modular rule."""
    official = PROFILE["officialCurve"]
    return (family == "printed_curve"
            and math.isclose(p["radius"], official["radius"], abs_tol=1e-6)
            and math.isclose(abs(p["sweep"]), math.radians(official["sweepDegrees"]), abs_tol=1e-9))


def tie_intervals(length: float, *, equal_pitch: bool = False) -> list[tuple[float, float]]:
    """Source-width ties, with non-modular residual confined to central gaps.

    Stations are horizontal run (also on ramps), or centreline arc length on
    curves. Never change a port, bend a contact, or stretch a tie to fit a run.
    ``equal_pitch`` is the official R40 layout: rigid ties at equal angles
    (centreline stations length*k/n), so every gap has the same width.
    """
    pitch, half = PROFILE["tiePitch"], PROFILE["tieWidth"] / 2
    if equal_pitch:
        count = max(1, round(length / pitch))
        centres = [length * k / count for k in range(1, count)]
    else:
        count = max(0, math.floor((length - pitch + 1e-9) / pitch))
        centres = [station for k in range(1, count // 2 + 1)
                   for station in (k * pitch, length - k * pitch)]
        if count % 2:
            centres.append(length / 2)
    return [(0, PROFILE["endTieWidth"]),
            *((centre - half, centre + half) for centre in sorted(centres)),
            (length - PROFILE["endTieWidth"], length)]


def rail_channel_bands() -> list[tuple[float, float, float, float]]:
    """Hollow rail-stringer channel as (lateral, half width, z low, z high) bands.

    Official 53401: 1.2 mm walls, open to z=2.2 between them, then a ledge
    open to z=3.2 over the central 4 mm. LDraw's V roof above z=3.2 is not
    copied: it would hollow the printed rail foot and need support.
    """
    c = PROFILE["brickAttachment"]["railChannel"]
    return [band for lateral in (-PROFILE["railGauge"] / 2, PROFILE["railGauge"] / 2)
            for band in ((lateral, c["lowerHalfWidth"], -1, c["lowerCeiling"]),
                         (lateral, c["upperHalfWidth"], c["lowerCeiling"] - .1, c["upperCeiling"]))]


def channel_web() -> trimesh.Trimesh:
    """Tie-local cross-web at a full-tie centre; subtract it from channel cutters."""
    half = PROFILE["brickAttachment"]["railChannel"]["webWidth"] / 2
    reach = PROFILE["railGauge"] / 2 + PROFILE["baseStringerWidth"] / 2 + .1
    return _box((-half, -reach, -2), (half, reach, 4))


def _rib_span(rib, bays):
    """Overlap a rib into the bay wall it grows from (no coincident faces).

    0.03 mm stays inside the accepted coupon's thinnest 0.05 mm bay wall.
    """
    low, high = rib
    for bay_low, bay_high in bays:
        if bay_low - 1e-9 <= low and high <= bay_high + 1e-9:
            if math.isclose(low, bay_low):
                low -= .03
            if math.isclose(high, bay_high):
                high += .03
    return low, high


def tie_clutch(columns=None, *, half: bool = False):
    """Rigid tie-local brick clutch: (cuts, additions) meshes.

    Full ties are centred on u=0; half ties start at the port face u=0 and
    run inward along +u. ``columns`` selects stud laterals; each column also
    brings its own underside seat (outer bay/rib/pin, or central bay/rib).
    Half ties additionally open the baseplate-stud slice behind the accepted
    coupon (u endLength-0.01..halfTieCavityEnd); the coupon is never cut.
    """
    a = PROFILE["brickAttachment"]
    columns = sorted(set(a["studLateralOffsets"] if columns is None else columns))
    outer = max(abs(v) for v in a["studLateralOffsets"])
    depth, row = a["cavityDepth"], a["studRowOffset"]
    if half:
        rows, low, high = [row], a["halfTieCavityStart"], a["halfTieCavityEnd"]
    else:
        rows, low, high = [-row, row], -a["cavityHalfLength"], a["cavityHalfLength"]
    bays = [bay for bay in a["cavityLateralIntervals"]
            if (min(abs(bay[0]), abs(bay[1])) > PROFILE["railGauge"] / 2
                and math.copysign(outer, bay[0]) in columns)
            or (not half and bay[0] < 0 < bay[1] and any(abs(v) < outer for v in columns))]
    cuts = [_box((low, y0, -1), (high, y1, depth)) for y0, y1 in bays]
    additions = []
    for rib in a["ribLateralIntervals"]:
        middle = (rib[0] + rib[1]) / 2
        owner = min(columns, key=lambda v: abs(v - middle), default=None)
        if owner is None or abs(owner - middle) > 4 or not any(
                y0 - 1e-9 <= rib[0] and rib[1] <= y1 + 1e-9 for y0, y1 in bays):
            continue
        y0, y1 = _rib_span(rib, bays)
        additions += [_box((r - a["ribWidth"] / 2, y0, 0), (r + a["ribWidth"] / 2, y1, depth + .1))
                      for r in rows]
    if not half:
        additions += [_cylinder(a["pinDiameter"] / 2, 0, depth + .1, 0, y)
                      for y in a["pinLateralOffsets"] if y in columns]
    else:
        start = PROFILE["endLength"] - .01
        central = a["halfTieCentralHalfWidth"]
        cuts.append(_box((start, -central, -1), (high, central, depth)))
        for lateral, width, _, ceiling in rail_channel_bands()[::2]:
            cuts.append(_box((start, lateral - width, -1), (high, lateral + width, ceiling)))
    additions += [_cylinder(a["studDiameter"] / 2, a["studBaseZ"] - .1,
                            a["studBaseZ"] + a["studHeight"], r, y)
                  for r in rows for y in columns]
    return cuts, additions


def stud_lands(columns=None, *, half: bool = False) -> list[trimesh.Trimesh]:
    """Tie-local 7.8 mm brick seats trimmed above the deck at each stud column."""
    a = PROFILE["brickAttachment"]
    columns = a["studLateralOffsets"] if columns is None else columns
    low = PROFILE["endLength"] + .05 if half else -PROFILE["tieWidth"] / 2
    high = PROFILE["endTieWidth"] if half else PROFILE["tieWidth"] / 2
    return [_box((low, y - a["outerBrickWidth"] / 2, a["studBaseZ"]),
                 (high, y + a["outerBrickWidth"] / 2, a["studBaseZ"] + a["studHeight"] + .1))
            for y in columns]


def _station_mask(p, family, low, high, low_z, high_z):
    """Volume between two stations: transverse planes, or radial on curves."""
    if family != "printed_curve":
        width = PROFILE["bodyWidth"]
        return _box((low, -width, low_z), (high, width, high_z))
    radius, side = p["radius"], math.copysign(1, p["sweep"])
    reach = 4 * (radius + PROFILE["bodyWidth"])
    # The triangle's remote chord is beyond the complete swept body.
    points = [(0, side * radius)]
    points.extend((reach * math.sin(s / radius), side * (radius - reach * math.cos(s / radius)))
                  for s in (low, high))
    return _mesh(cq.Workplane("XY", origin=(0, 0, low_z)).polyline(
        points).close().extrude(high_z - low_z).val())


def _interior_mask(p, family, length, low_z, high_z, start, end):
    """Volume between the two end-tie inner walls.

    Printed-only pieces use station masks (radial on curves). The official
    R40 end half ties are rigid 7.9 mm rectangles in their port frames, like
    53400's s03/s04, so their inner walls are planes normal to each port.
    """
    depth = PROFILE["endTieWidth"]
    if not is_official_curve(p, family):
        return _station_mask(p, family, depth, length - depth, low_z, high_z)
    reach = 2 * length + PROFILE["bodyWidth"]
    halves = []
    for frame in (start, end @ np.diag([-1, -1, 1, 1])):
        half = _box((depth, -reach, low_z), (reach, reach, high_z))
        half.apply_transform(frame)
        halves.append(half)
    return trimesh.boolean.intersection(halves, engine="manifold")


def _open_tie_gaps(centre, plane, path, p, family, length, start, end):
    """Cut real through-openings, retaining source-width rail stringers.

    The existing sweep remains the authority for the outer route and rails.
    Swept cutters follow its local pitch/heading; station masks give straight
    transverse or radial boundaries without changing that sweep's geometry.
    The official R40 curve instead opens its whole interior and restores
    rigid rectangular ties, exactly like 53400's straight-track sleepers.
    """
    width, base = PROFILE["bodyWidth"], PROFILE["baseThickness"]
    rail, half = PROFILE["railGauge"] / 2, PROFILE["baseStringerWidth"] / 2
    voids = []
    for low, high in ((-width / 2 - 1, -rail - half),
                      (-rail + half, rail - half), (rail + half, width / 2 + 1)):
        section = [(low, -1), (high, -1), (high, base + .1), (low, base + .1)]
        voids.append(_mesh(cq.Workplane(plane).polyline(section).close().sweep(
            cq.Workplane().newObject([path]), isFrenet=False).val()))
    void = trimesh.boolean.union(voids, engine="manifold")
    rigid = is_official_curve(p, family)
    ties = tie_intervals(length, equal_pitch=rigid)
    low_z, high_z = centre.bounds[0, 2] - 1, centre.bounds[1, 2] + 1
    if rigid:
        masks = [_interior_mask(p, family, length, low_z, high_z, start, end)]
    else:
        masks = [_station_mask(p, family, left[1], right[0], low_z, high_z)
                 for left, right in zip(ties, ties[1:])]
    openings = trimesh.boolean.intersection(
        [void, trimesh.boolean.union(masks, engine="manifold")], engine="manifold")
    opened = trimesh.boolean.difference([centre, openings], engine="manifold")
    if not rigid:
        return opened
    slabs = []
    for low, high in ties[1:-1]:
        slab = _box((-PROFILE["tieWidth"] / 2, -width / 2, 0),
                    (PROFILE["tieWidth"] / 2, width / 2, base))
        slab.apply_transform(_tie_frame(path, p, family, (low + high) / 2))
        slabs.append(slab)
    return trimesh.boolean.union([opened, *slabs], engine="manifold")


def _rail_channel(plane, path, p, family, length, frames, low_z, high_z, start, end):
    """Continuous hollow channel under both rails, closed by end-tie inner walls
    and by a 1.2 mm cross-web at every full-tie centre."""
    sections = {}
    for lateral, width, z0, z1 in rail_channel_bands():
        sections.setdefault(lateral, []).append((width, z0, z1))
    cutters = []
    for lateral, ((lower, bottom, ledge), (upper, _, ceiling)) in sections.items():
        section = [(lateral - lower, bottom), (lateral + lower, bottom), (lateral + lower, ledge),
                   (lateral + upper, ledge), (lateral + upper, ceiling),
                   (lateral - upper, ceiling), (lateral - upper, ledge), (lateral - lower, ledge)]
        cutters.append(_mesh(cq.Workplane(plane).polyline(section).close().sweep(
            cq.Workplane().newObject([path]), isFrenet=False).val()))
    channel = trimesh.boolean.intersection(
        [trimesh.boolean.union(cutters, engine="manifold"),
         _interior_mask(p, family, length, low_z, high_z, start, end)], engine="manifold")
    webs = []
    for frame in frames:
        web = channel_web()
        web.apply_transform(frame)
        webs.append(web)
    return trimesh.boolean.difference([channel, *webs], engine="manifold") if webs else channel


def _production_end(adjustment: float, *, opposite: bool = False) -> trimesh.Trimesh:
    """Replace only outer brick seating zones; accepted coupon/latches stay intact."""
    mesh = end_mesh(adjustment, opposite=opposite)
    attachment = PROFILE["brickAttachment"]
    additions, cutters = [], []
    for low, high in attachment["endReplacementLateralIntervals"]:
        # The measured source body begins at x=.1. Do not fill the port gap.
        additions.append(_box((.1, low, 0),
                              (PROFILE["endLength"] + .05, high, PROFILE["baseThickness"])))
        cutters.append(_box((0, low, PROFILE["baseThickness"]),
                            (PROFILE["endLength"] + .1, high, 6)))
    mesh = trimesh.boolean.difference([mesh, *cutters], engine="manifold")
    return trimesh.boolean.union([mesh, *additions], engine="manifold")


def _tie_frame(path, p, family, station):
    """Locate a tie centre on the actual blended path, not the ideal route."""
    def coordinate(point):
        if family == "printed_curve":
            side, radius = math.copysign(1, p["sweep"]), p["radius"]
            return radius * math.atan2(point.x, radius - side * point.y)
        return point.x

    for edge in path.Edges():
        if coordinate(edge.startPoint()) - 1e-8 <= station <= coordinate(edge.endPoint()) + 1e-8:
            low, high = 0., 1.
            for _ in range(40):
                middle = (low + high) / 2
                if coordinate(edge.positionAt(middle)) < station:
                    low = middle
                else:
                    high = middle
            point, tangent = edge.positionAt((low + high) / 2), edge.tangentAt((low + high) / 2)
            return _frame(point.toTuple(), math.atan2(tangent.y, tangent.x),
                          tangent.z / math.hypot(tangent.x, tangent.y))
    raise ValueError("tie centre lies outside the swept path")


def _cylinder(radius, low, high, x, y):
    mesh = trimesh.creation.cylinder(radius=radius, height=high - low, sections=96)
    mesh.apply_translation((x, y, (low + high) / 2))
    return mesh


def _brick_attachments(mesh, plane, path, p, family, length, start, end):
    """Rigid brick grids in local tie frames; never warp the physical clutch."""
    a = PROFILE["brickAttachment"]
    cutters, additions, frames = [], [], []
    rigid = is_official_curve(p, family)
    ties = tie_intervals(length, equal_pitch=rigid)
    for index, (low, high) in enumerate(ties):
        half = index in (0, len(ties) - 1)
        if half:
            frame = start if index == 0 else end @ np.diag([-1, -1, 1, 1])
            pocket_low, pocket_high = a["halfTieCavityStart"], a["halfTieCavityEnd"]
        else:
            frame = _tie_frame(path, p, family, (low + high) / 2)
            frames.append(frame)
            pocket_low, pocket_high = -a["cavityHalfLength"], a["cavityHalfLength"]
        if family == "printed_curve" and not rigid:
            # A rigid rectangular clutch must fit inside the approved
            # radial tie. The source end itself is already a rigid footprint.
            side, radius = math.copysign(1, p["sweep"]), p["radius"]
            bays = a["cavityLateralIntervals"]
            for x in (pocket_low, pocket_high):
                if half and x <= PROFILE["endLength"] + .05:
                    continue
                for y in (bays[0][0], bays[-1][1]):
                    point = frame @ np.array([x, y, 0, 1])
                    station = radius * math.atan2(point[0], radius - side * point[1])
                    lateral = radius - math.hypot(point[0], radius - side * point[1])
                    if not low < station < high or abs(lateral) >= PROFILE["bodyWidth"] / 2:
                        raise ValueError("rigid brick cavity would break through a curved tie wall")
        # A studded brick also has a flat body. Clear its complete seating
        # footprint below z=0, including the swept rail-support undersides:
        # concave Hermite paths otherwise collide despite clear stud sockets.
        seat_low = .1 if half else -PROFILE["tieWidth"] / 2
        seat_high = PROFILE["endTieWidth"] if half else PROFILE["tieWidth"] / 2
        # The accepted rigid contact already has planar seating surfaces.
        # Do not boolean its coincident planes after a float32 world rotation.
        trim_low = PROFILE["endLength"] + .05 if half else seat_low
        local_cuts = [_box((trim_low, -PROFILE["bodyWidth"] / 2, -RAIL_TOP),
                           (seat_high, PROFILE["bodyWidth"] / 2, 0))]
        # Each stud column's brick needs a planar seat; lands never reach a rail.
        local_cuts += stud_lands(half=half)
        clutch_cuts, local_additions = tie_clutch(half=half)
        for shape in local_cuts + clutch_cuts:
            shape.apply_transform(frame)
            cutters.append(shape)
        for shape in local_additions:
            shape.apply_transform(frame)
            additions.append(shape)
    cutters.append(_rail_channel(plane, path, p, family, length, frames,
                                 mesh.bounds[0, 2] - 1, mesh.bounds[1, 2] + 1, start, end))
    opened = trimesh.boolean.difference([mesh, *cutters], engine="manifold")
    return trimesh.boolean.union([opened, *additions], engine="manifold")


def track(p: dict[str, float], family: str) -> cq.Shape:
    """Rigid contacts with local blends, exact circular/Hermite centre paths.

    Only the first/last min(23.2, (length-0.8)/2) mm differ from the declared path.
    _centre_path also returns a conservative centreline deviation bound in mm;
    end contacts and source rail section are never scaled or bent.
    """
    validate(p)
    sweep = p.get("sweep", 0)
    if family == "printed_curve":
        radius = p["radius"]
        length = radius * abs(sweep)
        endpoint = (radius * math.sin(abs(sweep)),
                    math.copysign(radius * (1 - math.cos(sweep)), sweep), 0)
    else:
        length = p.get("run", p.get("joint_length", 0))
        endpoint = (length, 0, p.get("rise", 0))
    if length < PROFILE["minimumLength"]:
        raise ValueError("shared connector rails require at least 24 mm between ports")
    start = _frame((0, 0, 0), 0, p.get("start_grade", 0))
    end = _frame(endpoint, sweep, p.get("end_grade", 0))
    depth = PROFILE["endLength"]
    a = start[:3, 3] + depth * start[:3, 0]
    b = end[:3, 3] - depth * end[:3, 0]
    if np.dot(b - a, start[:3, 0]) <= 0 or np.dot(b - a, end[:3, 0]) <= 0:
        raise ValueError("rigid connector ends leave no forward centre web")
    path, _ = _centre_path(p, family, start, end, length)
    plane = cq.Plane(origin=cq.Vector(*a), xDir=cq.Vector(*start[:3, 1]),
                     normal=cq.Vector(*start[:3, 0]))
    width, base = PROFILE["bodyWidth"], PROFILE["baseThickness"]
    # Sweep one exterior contour: independently tessellated touching rail/base
    # surfaces leave microscopic internal cavities on vertically curved paths.
    section = [(-width / 2, 0), (width / 2, 0), (width / 2, base)]
    for lateral in (20, -20):
        section.extend((y + lateral, z) for y, z in reversed(_RAIL_PROFILE))
    section.append((-width / 2, base))
    centre = _mesh(cq.Workplane(plane).polyline(section).close().sweep(
        cq.Workplane().newObject([path]), isFrenet=False).val())
    centre = _open_tie_gaps(centre, plane, path, p, family, length, start, end)
    first = _production_end(p["fit_adjustment"])
    last = _production_end(p["fit_adjustment"], opposite=True)
    first.apply_transform(start)
    reverse = np.diag([-1, -1, 1, 1])
    last.apply_transform(end @ reverse)
    collision = trimesh.boolean.intersection([first, last], engine="manifold")
    if len(collision.faces) and collision.volume > .001:
        raise ValueError("rigid connector ends overlap")
    mesh = trimesh.boolean.union([first, last, centre], engine="manifold")
    mesh = _brick_attachments(mesh, plane, path, p, family, length, start, end)
    # Float32 boolean junctions can contain zero-area triangles. Retriangulate
    # coplanar seams at 0.00001 mm, far below the 0.02 mm export tolerance.
    joined = manifold3d.Manifold(manifold3d.Mesh(np.float32(mesh.vertices), np.uint32(mesh.faces)))
    joined_mesh = joined.simplify(1e-5).to_mesh()
    return _solid(trimesh.Trimesh(joined_mesh.vert_properties[:, :3], joined_mesh.tri_verts, process=True))
