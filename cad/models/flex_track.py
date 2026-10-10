"""Flexible TPU-spine track (family ``flex_tpu_track``): rigid PLA segments on a TPU spine; millimetres.

Experimental. The strip prints STRAIGHT as one two-material object and is bent on site to the curve drawn in
the editor. Parameters are those of a level ``composite_track`` strip (``segments``, ``s{i}_len``/``k0``/``k1``,
``z0`` ... ``ends``, the shared brick profile keys and optionally ``lite``): they describe the installed (bent)
shape, so ``ports`` are where the ends sit once laid. The strip must be level, uncanted, connected at both ends,
a whole number of 32 mm tie pitches long, and nowhere tighter than ``RMIN``.

Rigid body (PLA). The composite straight of the strip's length (full detail or lite), cut at every tie-gap centre
(16 + 32k mm) by a bow-tie kerf whose width at lateral y is ``|y| * PITCH / RMIN`` (never under ``KERF_MIN``).
Each segment turns about the centreline as the strip bends, so at radius R a kerf closes by ``|y| * PITCH / R``
on the inside of the curve and opens as much outside: at RMIN every inner kerf just closes and the outer one is
twice its width. With the rail line at RAIL = 20 mm and a 2 mm rail kerf, RMIN = RAIL * PITCH / KERF = 320 mm,
where the outer rail gap is 4 mm (the 4 mm unsupported running-head gate). Each segment holds one full tie (the
end segments: the connector, its half tie and an anchor plate); the end hinge's window (port to the next segment's
middle) is one pitch too, because the end segments follow the port tangents. The brick connector ends and their
half ties are the composite ones, untouched.

Spine (TPU). One continuous solid: a 2.4 x 1.8 mm web on the centreline from end anchor to end anchor, standing
on the bed between the +/-4 baseplate-stud columns (0.4 mm clear) and under the tie roofs (the clutch bays are
1.8 mm deep), so every stud column and clutch rib stays. Each full tie keys it with a cross bar under its roof
(between the +/-4 stud rows, |x| <= 1.2) and three rivets through the roof (y = -8, 0, 8; 1.6 mm neck, 2.8 mm head
flush with the tie top), so a PLA ledge is clamped between TPU above and below: the spine cannot pull out in any
direction. Each end segment carries a PLA anchor plate behind its half tie (above the baseplate studs in full
detail) with two rivets on the web. Lite adds a solid anchor block round every gauge brace for the same keys.
Between ties the web is free to flex over 16.2 mm (10.2 mm at the end plates).

Outputs: ``materials`` gives the rigid (PLA, the project filament) and spine (TPU, filament 2) meshes in the part
frame; ``build`` is their union (one solid) for the checked STL. Probes report alignment, kerfs at RMIN, wheel dip
over the widest gap for 57878 train wheels and spine bending strain. Physical TPU fatigue, spring-back and
hold-down on a baseplate are trial gates, not certified here.
"""
from __future__ import annotations

from functools import lru_cache
import json
import math

import cadquery as cq
import manifold3d
import numpy as np
import trimesh

from . import composite
from . import brick_end as end
from . import lite as fast

FAMILY = "flex_tpu_track"
# The spine's filament (bundled Bambu preset "<name> @BBL <printer>"), in AMS slot 2.
SPINE_MATERIAL = "Bambu TPU for AMS"
PROFILE = end.PROFILE
RAIL = PROFILE["railGauge"] / 2                      # 20: rail line
PITCH = PROFILE["tiePitch"]                          # 32: segment pitch
KERF = 2.                                            # rail-line kerf, straight
RMIN = RAIL * PITCH / KERF                           # 320
KERF_MIN = .4
BASE, CAVITY = PROFILE["baseThickness"], PROFILE["brickAttachment"]["cavityDepth"]   # 3.2, 1.8
END_TIE = PROFILE["endTieWidth"]                     # 7.9
TIE_HALF = PROFILE["tieWidth"] / 2                   # 7.9
INNER = RAIL - PROFILE["baseStringerWidth"] / 2      # 16.1: stringer inner face
HEAD = PROFILE["railInterfaceWidth"] / 2             # 1.2: rail head half width
# Spine web, cross bar and rivets.
WEB_HALF, WEB_TOP = 1.2, CAVITY
BAR_HALF_X, BAR_HALF_Y = 1.2, 13.6
NECK, HEAD_R, LEDGE = .8, 1.4, 2.6
TIE_RIVETS = (-8., 0., 8.)
# End anchor plate behind each half tie, its rivets (station from the port) and the spine's end inside it.
PLATE = (END_TIE - .05, END_TIE + 6.)
PLATE_RIVETS = (9.9, 12.3)
SPINE_END = END_TIE + .5
# Lite anchor block round each gauge brace.
BLOCK_HALF = 4.
OVERLAP = .05
# 57878 train wheel: tread 16.6 mm, flange 23 mm (its element name "TRAIN WHEEL Ø16.6/Ø23").
WHEEL_TREAD = 16.6
GAP_LIMIT = 4.
# Design gate for the web's bending strain at RMIN (elastic working range of a 95A-class TPU).
STRAIN_LIMIT = .05
TOLERANCE = 1e-6


# ------------------------------------------------------------------ parameters
def validate(p: dict) -> composite.Spec:
    """A level strip with connectors at both ends, whole pitches long, no tighter than RMIN."""
    if any(key in p for key in composite.OPTIONS):
        raise ValueError("flexible track takes no composite_track options")
    spec = composite.validate(p)
    if not spec.level or spec.z0 or spec.vcurve:
        raise ValueError("flexible track must be level and uncanted")
    if spec.ends != 3:
        raise ValueError("flexible track needs brick track connectors at both ends")
    pitches = spec.length / PITCH
    if abs(pitches - round(pitches)) > TOLERANCE or round(pitches) < 1:
        raise ValueError(f"flexible track length must be a whole number of {PITCH:g} mm pitches")
    if max(max(abs(k0), abs(k1)) for _, k0, k1 in spec.segments) > 1 / RMIN + 1e-9:
        raise ValueError(f"flexible track bends no tighter than R{RMIN:g} mm")
    return spec


def request(p: dict) -> dict:
    """The composite straight the strip prints as."""
    return composite.straight(p, round(composite.validate(p).length / PITCH) * PITCH)


def hinges(length: float) -> list[float]:
    """Tie-gap centres: every 32 mm from 16 mm."""
    return [PITCH / 2 + PITCH * k for k in range(round(length / PITCH))]


def kerf_width(y: float) -> float:
    return max(KERF_MIN, abs(y) * PITCH / RMIN)


# ------------------------------------------------------------------ geometry
def _box(low, high) -> trimesh.Trimesh:
    return end._box(low, high)


def _cylinder(x, y, r, z0, z1) -> trimesh.Trimesh:
    solid = manifold3d.Manifold.cylinder(z1 - z0, r, r, 48).translate((x, y, z0))
    return composite._to_trimesh(solid)


def _rivet(x, y) -> list[trimesh.Trimesh]:
    return [_cylinder(x, y, NECK, WEB_TOP - .01, LEDGE + .01), _cylinder(x, y, HEAD_R, LEDGE, BASE)]


def _kerf(station: float) -> trimesh.Trimesh:
    """Bow-tie cutter across the whole body at a hinge."""
    reach = composite.WIDTH / 2 + 1
    knee = KERF_MIN * RMIN / PITCH
    half = kerf_width(reach) / 2
    outline = [(station - half, -reach), (station + half, -reach), (station + KERF_MIN / 2, -knee),
               (station + KERF_MIN / 2, knee), (station + half, reach), (station - half, reach),
               (station - KERF_MIN / 2, knee), (station - KERF_MIN / 2, -knee)]
    return composite._to_trimesh(manifold3d.CrossSection([np.array(outline)]).extrude(30).translate((0, 0, -5)))


class Builder(composite.Builder):
    """The composite straight plus the anchor plates (and lite anchor blocks) the spine keys into."""

    def options(self):
        floor = 0. if self.spec.lite else WEB_TOP
        extra = [_box((x0, -INNER - OVERLAP, floor), (x1, INNER + OVERLAP, BASE))
                 for x0, x1 in (PLATE, (self.length - PLATE[1], self.length - PLATE[0]))]
        if self.spec.lite:
            extra += [_box((c - BLOCK_HALF, -INNER - OVERLAP, 0), (c + BLOCK_HALF, INNER + OVERLAP, BASE))
                      for c in self.tie_centres()]
        return [*super().options(), *extra]


def spine_mesh(length: float) -> trimesh.Trimesh:
    pieces = [_box((SPINE_END, -WEB_HALF, 0), (length - SPINE_END, WEB_HALF, WEB_TOP))]
    for c in [PITCH * k for k in range(1, round(length / PITCH))]:
        pieces.append(_box((c - BAR_HALF_X, -BAR_HALF_Y, 0), (c + BAR_HALF_X, BAR_HALF_Y, WEB_TOP)))
        pieces += [part for y in TIE_RIVETS for part in _rivet(c, y)]
    for x in PLATE_RIVETS:
        pieces += _rivet(x, 0.) + _rivet(length - x, 0.)
    return trimesh.boolean.union(pieces, engine="manifold")


@lru_cache(maxsize=8)
def _parts(key: str) -> tuple[trimesh.Trimesh, trimesh.Trimesh, trimesh.Trimesh, trimesh.Trimesh]:
    """(rigid, spine, union, uncut composite body) for a canonical straight request."""
    straight = json.loads(key)
    spec = composite.validate(straight)
    body = Builder(spec).mesh()
    spine = spine_mesh(spec.length)
    cutters = [_kerf(station) for station in hinges(spec.length)]
    rigid = trimesh.boolean.difference([body, *cutters, spine], engine="manifold")
    union = trimesh.boolean.union([rigid, spine], engine="manifold")
    return rigid, spine, union, body


def parts(p: dict):
    validate(p)
    return _parts(json.dumps(request(p), sort_keys=True))


def materials(p: dict) -> list[tuple[str, int, trimesh.Trimesh]]:
    """(role, filament slot, mesh) in the part frame: rigid body in the project filament (1), spine in TPU (2)."""
    rigid, spine, _, _ = parts(p)
    return [("rigid", 1, rigid.copy()), ("spine", 2, spine.copy())]


class _Union:
    def __init__(self, mesh):
        self._mesh = mesh

    def mesh(self):
        return self._mesh.copy()


def mesh(p: dict) -> trimesh.Trimesh:
    return parts(p)[2].copy()


def build(p: dict) -> cq.Shape:
    """The whole printed strip (rigid and spine) as one closed solid."""
    union = parts(p)[2]
    return composite.build(request(p), lambda spec: _Union(union))


def ports(p: dict) -> list[dict]:
    """Installed (bent) ends, as fit places them; the printed mesh is the straight strip."""
    validate(p)
    return composite.ports(p)


def connector_ends(p: dict) -> list[dict]:
    """Brick connector faces of the STRAIGHT printed strip (support painting)."""
    validate(p)
    return composite.connector_ends(request(p))


# ------------------------------------------------------------------ checks and probes
def _components(mesh: trimesh.Trimesh) -> list[trimesh.Trimesh]:
    return sorted(mesh.split(only_watertight=False), key=lambda part: part.bounds[0, 0])


def probe_materials(p: dict) -> dict:
    """Spine one watertight solid; each rigid segment watertight; union one solid; no overlap; connector ends kept."""
    rigid, spine, union, body = parts(p)
    length = round(composite.validate(p).length / PITCH) * PITCH
    segments = _components(rigid)
    spines = spine.split(only_watertight=False)
    overlap = trimesh.boolean.intersection([rigid, spine], engine="manifold")
    ends = []
    for x0, x1 in ((-5, PROFILE["endLength"]), (length - PROFILE["endLength"], length + 5)):
        window = _box((x0, -40, -1), (x1, 40, 20))
        a = trimesh.boolean.intersection([body, window], engine="manifold")
        b = trimesh.boolean.intersection([rigid, window], engine="manifold")
        diff = trimesh.boolean.difference([a, b], engine="manifold")
        ends.append(float(diff.volume) if len(diff.faces) else 0.)
    report = {
        "segments": len(segments), "expectedSegments": len(hinges(length)) + 1,
        "segmentsWatertight": all(bool(part.is_watertight and part.volume > 0) for part in segments),
        "spineBodies": len(spines), "spineWatertight": bool(spine.is_watertight and spine.volume > 0),
        "unionBodies": len(union.split(only_watertight=False)), "unionWatertight": bool(union.is_watertight),
        "overlapMm3": float(overlap.volume) if len(overlap.faces) else 0.,
        "rigidMm3": float(rigid.volume), "spineMm3": float(spine.volume),
        "connectorEndChangeMm3": ends,
    }
    if not (report["segments"] == report["expectedSegments"] and report["segmentsWatertight"]
            and report["spineBodies"] == 1 and report["spineWatertight"] and report["unionBodies"] == 1
            and report["unionWatertight"] and report["overlapMm3"] <= .001 and max(ends) <= .001):
        raise ValueError(f"flexible track materials fail their checks: {report}")
    return report


def _crossings(mesh: trimesh.Trimesh, z: float, y: float) -> np.ndarray:
    """x where the section of ``mesh`` at height z crosses the line at lateral y."""
    lines = trimesh.intersections.mesh_plane(mesh, (0, 0, 1), (0, 0, z))
    a, b = lines[:, 0], lines[:, 1]
    hit = (a[:, 1] - y) * (b[:, 1] - y) < 0
    t = (y - a[hit, 1]) / (b[hit, 1] - a[hit, 1])
    return np.sort(a[hit, 0] + t * (b[hit, 0] - a[hit, 0]))


def _gap(mesh, z, y, station) -> float:
    xs = _crossings(mesh, z, y)
    below, above = xs[xs < station], xs[xs > station]
    return float(above.min() - below.max())


def probe_alignment(p: dict) -> dict:
    """Straight as printed: both rail heads on their lines in every segment (head centre offsets 0).

    The rigid source contacts (5.8 mm at each port) carry the connector's own head shape and are excluded."""
    rigid = parts(p)[0]
    length = round(composite.validate(p).length / PITCH) * PITCH
    z, contact = end.RAIL_TOP - .3, PROFILE["endLength"] + .5
    offsets = []
    for segment in _components(rigid):
        lines = trimesh.intersections.mesh_plane(segment, (0, 0, 1), (0, 0, z)).reshape(-1, 3)
        lines = lines[(lines[:, 0] > contact) & (lines[:, 0] < length - contact)]
        for side in (1, -1):
            ys = lines[np.abs(lines[:, 1] - side * RAIL) < 2, 1]
            offsets.append(float(abs((ys.min() + ys.max()) / 2 - side * RAIL)))
            if abs(ys.max() - ys.min() - 2 * HEAD) > .01:
                raise ValueError("rail head width changed in a segment")
    worst = max(offsets)
    if worst > .01:
        raise ValueError(f"rail head off its line by {worst:.3f} mm")
    return {"segments": len(offsets) // 2, "maximumHeadOffsetMm": worst}


def probe_kerfs(p: dict, radius: float = RMIN) -> dict:
    """Measured kerfs on the rigid mesh, then turned by each hinge's angle at ``radius`` (window one pitch).

    Inner gaps must stay >= 0 everywhere across the stringer and rail head; the outer rail-line gap must not
    exceed GAP_LIMIT."""
    rigid = parts(p)[0]
    length = round(composite.validate(p).length / PITCH) * PITCH
    theta = PITCH / radius
    rows = []
    for station in hinges(length):
        lateral = {}
        for y, z in ((INNER + .05, 2.), (RAIL + PROFILE["baseStringerWidth"] / 2 - .05, 2.),
                     (RAIL - HEAD + .01, end.RAIL_TOP - .3), (RAIL, end.RAIL_TOP - .3), (RAIL + HEAD - .01, end.RAIL_TOP - .3)):
            lateral[y] = min(_gap(rigid, z, y, station), _gap(rigid, z, -y, station))
        inner = min(width - y * theta for y, width in lateral.items())
        rows.append({"station": station, "straightRailMm": lateral[RAIL], "innerMinMm": inner,
                     "outerRailMm": lateral[RAIL] + RAIL * theta,
                     "outerHeadMaxMm": max(width + y * theta for y, width in lateral.items() if abs(y - RAIL) <= HEAD)})
    report = {"radiusMm": radius, "hingeTurnRad": theta, "hinges": len(rows),
              "innerMinMm": min(row["innerMinMm"] for row in rows),
              "outerRailMaxMm": max(row["outerRailMm"] for row in rows),
              "outerHeadMaxMm": max(row["outerHeadMaxMm"] for row in rows),
              "straightRailKerfMm": max(row["straightRailMm"] for row in rows)}
    if report["innerMinMm"] < -1e-3 or report["outerRailMaxMm"] > GAP_LIMIT + 1e-3:
        raise ValueError(f"kerfs at R{radius:g}: {report}")
    return report


def probe_wheel(p: dict) -> dict:
    """Dip of a 57878 wheel tread (16.6 mm) over the widest outer gap at RMIN."""
    kerfs = probe_kerfs(p)
    r = WHEEL_TREAD / 2

    def dip(gap):
        return r - math.sqrt(r * r - (gap / 2) ** 2)
    return {"wheelTreadMm": WHEEL_TREAD, "railLineGapMm": kerfs["outerRailMaxMm"], "railLineDipMm": dip(kerfs["outerRailMaxMm"]),
            "headEdgeGapMm": kerfs["outerHeadMaxMm"], "headEdgeDipMm": dip(kerfs["outerHeadMaxMm"]),
            "unsupportedGapLimitMm": GAP_LIMIT}


def probe_strain(p: dict) -> dict:
    """Peak bending strain of the web at RMIN: (web width / 2) * hinge turn / free web length."""
    _, spine, _, body = parts(p)
    length = round(composite.validate(p).length / PITCH) * PITCH
    theta = PITCH / RMIN
    # Free web: no PLA above it at the roof height (between ties, and between plate and first tie).
    roof = WEB_TOP + .1
    xs = _crossings(body, roof, 0.)
    free = []
    for station in hinges(length):
        below, above = xs[xs < station], xs[xs > station]
        free.append(float(above.min() - below.max()))
    shortest = min(free)
    strain = WEB_HALF * theta / shortest
    if strain > STRAIN_LIMIT:
        raise ValueError(f"spine strain {strain:.3f} exceeds {STRAIN_LIMIT}")
    return {"webWidthMm": 2 * WEB_HALF, "hingeTurnRad": theta, "freeLengthMm": [min(free), max(free)],
            "peakStrain": strain, "strainLimit": STRAIN_LIMIT}


def probe_keys(p: dict) -> dict:
    """Every rigid segment clamps a PLA ledge between a TPU rivet head and the web/bar below (no pull-out)."""
    rigid, spine, _, _ = parts(p)
    length = round(composite.validate(p).length / PITCH) * PITCH
    rivets = [(x, 0.) for x in PLATE_RIVETS] + [(c, y) for c in [PITCH * k for k in range(1, round(length / PITCH))]
                                              for y in TIE_RIVETS] + [(length - x, 0.) for x in PLATE_RIVETS]
    segments = _components(rigid)
    counts = [0] * len(segments)
    for x, y in rivets:
        ledge = trimesh.boolean.difference([_cylinder(x, y, HEAD_R - .05, WEB_TOP + .05, LEDGE - .05),
                                            _cylinder(x, y, NECK + .05, WEB_TOP, LEDGE)], engine="manifold")
        held = trimesh.boolean.intersection([rigid, ledge], engine="manifold")
        if not len(held.faces) or held.volume < .99 * ledge.volume:
            raise ValueError(f"rivet at ({x:g}, {y:g}) is not clamped by PLA")
        index = next(i for i, part in enumerate(segments) if part.bounds[0, 0] <= x <= part.bounds[1, 0])
        counts[index] += 1
    if min(counts) < 2:
        raise ValueError("a rigid segment is not keyed to the spine")
    return {"rivetsPerSegment": counts, "ledgeMm": LEDGE - WEB_TOP}


def probes(p: dict) -> dict:
    return {"materials": probe_materials(p), "alignment": probe_alignment(p), "kerfs": probe_kerfs(p),
            "wheel": probe_wheel(p), "strain": probe_strain(p), "keys": probe_keys(p)}


def hardware(p: dict) -> list[dict]:
    return []


def assembly_notes(p: dict) -> list[str]:
    return ["Print with the project PLA and TPU for AMS in slot 2; the spine fuses to the rigid segments.",
            f"Bend the strip by hand to the drawn curve, never tighter than R{RMIN:g} mm (inner rail gaps close).",
            "TPU springs back straight: clutch every sleeper to a baseplate or pin the strip to its board.",
            f"Outer rail gaps open to {2 * KERF:g} mm at R{RMIN:g}; run a train slowly over the bent strip first."]
