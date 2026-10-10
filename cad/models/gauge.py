"""Narrow and dual gauge plain track (composite_track option ``gauge``); experimental.

Narrow gauge (``gauge`` 1): 3 studs = 24 mm between rail centres on 6-stud
(47.8 mm) sleepers, the official 2009 narrow system that TrixBrix extended (radii
R24..R96 in studs, 12-stud parallel spacing). It is the composite track built
unchanged from brick-narrow-v1.json: composite.py and its helpers (brick_end,
lite) are loaded a second time into the private package ``cad.models._narrow``
whose brick_end carries the narrow profile, so every construction (ties, studs,
clutch, hollow rail channels, wedges, ballast, marker, fast print) is the
standard one with the rails at +/-12 mm and the outer stud column at +/-20 mm.

Narrow ends: no published narrow clip exists (official 85976 and TrixBrix narrow
ends are undocumented), so the end is the accepted brick end's central clip and
centre pin, unchanged, with the rail-end tongues removed (they sit outside the
narrow body); the narrow rails butt 0.1 mm inboard of the port face like the
accepted body. Any narrow end mates any narrow or centred dual end. It does not
mate official 85976 or TrixBrix narrow track. Retention without the rail tongues is
a physical trial gate.

Dual gauge (``gauge`` 2): standard track with two more rails centred at +/-12
mm (4-rail centred mixed gauge). The standard end is untouched, so a dual end
mates standard track (narrow rails stop at the joint) and narrow track (the
shared central clip lines the narrow rails up). The narrow rails stand on the
ties and on a widened stringer (8.1..23.9 mm, both rails) across the tie gaps,
with a hollow baseplate channel under each; the +/-12 stud columns, which the
narrow rails cover, are dropped. Level track only; no guard rail or street
(their flangeways are where the narrow rails run).
"""
from __future__ import annotations

import importlib.util
import json
import math
from pathlib import Path
import sys
import types

import numpy as np
import trimesh

from . import composite as standard
from . import brick_end as end_

MODELS = Path(__file__).resolve().parent
NARROW_PROFILE_PATH = MODELS.parent / "profiles/brick-narrow-v1.json"
NARROW_PROFILE = json.loads(NARROW_PROFILE_PATH.read_text())
NARROW, DUAL = 1, 2
NARROW_RAIL = NARROW_PROFILE["railGauge"] / 2                 # 12
# The accepted end's central clip and pin: everything inside the narrow outer half-tie blocks.
CLIP = NARROW_PROFILE["brickAttachment"]["endReplacementLateralIntervals"][1][0]   # 15.95
# Dual: one stringer under both rails of a side, and the narrow rails' stud column.
DUAL_STRINGER = NARROW_RAIL - NARROW_PROFILE["baseStringerWidth"] / 2    # 8.1
DUAL_DROPPED = NARROW_RAIL
FLANGE_CLEARANCE, FLANGE_DEPTH = 2.2, 3.2       # track_assembly's flangeway (track-assemblies-v1.json)
BLEND = .25        # running probe: allowed rail offset from the ideal path at blended connector ends
SHARED = {"connector_version", "fit_adjustment", "body_width", "base_thickness",
          "rail_gauge", "rail_interface_width", "rail_height"}
_PACKAGE = f"{__package__}._narrow"


def _rail_prism(lateral: float, x0: float, x1: float) -> trimesh.Trimesh:
    """The versioned rail section at ``lateral``, straight from x0 to x1 (port frame)."""
    import manifold3d
    section = np.asarray(end_.PROFILE["railSection"], float) + (lateral, 0)
    if np.sum(section[:, 0] * np.roll(section[:, 1], -1) - np.roll(section[:, 0], -1) * section[:, 1]) < 0:
        section = section[::-1]
    prism = manifold3d.CrossSection([section]).extrude(x1 - x0)
    # Extrusion runs along +z in (y, z) section coordinates: map to (x, y, z).
    mesh = standard._to_trimesh(prism)
    mesh.vertices = np.column_stack([mesh.vertices[:, 2] + x0, mesh.vertices[:, 0], mesh.vertices[:, 1]])
    if mesh.volume < 0:
        mesh.invert()
    return mesh


def _narrow_production_end(adjustment: float, *, opposite: bool = False) -> trimesh.Trimesh:
    """Accepted end, central clip and pin only, plus narrow outer half tie and rail stubs."""
    whole = end_._production_end(adjustment, opposite=opposite)
    depth = NARROW_PROFILE["endLength"] + .05
    core = trimesh.boolean.intersection([whole, end_._box((-6, -CLIP, -1), (depth, CLIP, 11))], engine="manifold")
    blocks = [end_._box((.1, low, 0), (depth, high, NARROW_PROFILE["baseThickness"]))
              for low, high in NARROW_PROFILE["brickAttachment"]["endReplacementLateralIntervals"]]
    rails = [_rail_prism(side * NARROW_RAIL, .1, depth) for side in (-1, 1)]
    return trimesh.boolean.union([core, *blocks, *rails], engine="manifold")


def _narrow_contact(adjustment: float, *, opposite: bool = False) -> trimesh.Trimesh:
    """The narrow end as every builder leaves it (brick_end.end_mesh's role): the production end with the outer half-tie
    clutch bays and ribs that the tie clutch cuts and adds under the outer stud column."""
    narrow = narrow_package().brick_end
    attachment = NARROW_PROFILE["brickAttachment"]
    outer = max(attachment["studLateralOffsets"])
    cuts, additions = narrow.tie_clutch([-outer, outer], half=True)
    depth = NARROW_PROFILE["endLength"] + .05
    keep = end_._box((-6, -30, -1), (depth, 30, 11))
    region = [trimesh.boolean.intersection([cut, keep], engine="manifold") for cut in cuts]
    ribs = [trimesh.boolean.intersection([shape, keep], engine="manifold") for shape in additions if shape.bounds[0, 2] < 2]
    opened = trimesh.boolean.difference([_narrow_production_end(adjustment, opposite=opposite), *region], engine="manifold")
    return trimesh.boolean.union([opened, *[rib for rib in ribs if len(rib.faces)]], engine="manifold")


def _load(name: str):
    full = f"{_PACKAGE}.{name}"
    spec = importlib.util.spec_from_file_location(full, MODELS / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules[full] = module
    spec.loader.exec_module(module)
    return module


def narrow_package() -> types.ModuleType:
    """``cad.models._narrow``: the standard CAD modules bound to the narrow profile (loaded once).

    brick_end gets the narrow profile and end (its accepted contact reference, ``end_mesh``, is the narrow end, which
    the junction source-contact probes compare against). track_assembly keeps two standard-only tables that the
    point-blade junctions use, so they are re-derived from the narrow profile here: CLUTCH_GROUPS (central and outer
    stud groups, each with its 0.8 mm footprint margin) and _flangeways (the flange corridor inside each guiding face).
    """
    if _PACKAGE in sys.modules:
        return sys.modules[_PACKAGE]
    package = types.ModuleType(_PACKAGE)
    package.__path__ = [str(MODELS)]
    package.__package__ = _PACKAGE
    sys.modules[_PACKAGE] = package
    try:
        narrow_end = _load("brick_end")
        narrow_end.PROFILE = NARROW_PROFILE
        narrow_end.PROFILE_PATH = NARROW_PROFILE_PATH
        narrow_end._production_end = _narrow_production_end
        narrow_end.end_mesh = _narrow_contact
        package.brick_end = narrow_end
        package.composite = _load("composite")
        assembly = _load("track_assembly")
        attachment, half = NARROW_PROFILE["brickAttachment"], NARROW_PROFILE["bodyWidth"] / 2
        central = max(abs(value) for bay in attachment["cavityLateralIntervals"] if bay[0] < 0 < bay[1] for value in bay) + .8
        outer = max(attachment["studLateralOffsets"])
        low = min(bay[0] for bay in attachment["cavityLateralIntervals"] if bay[0] > 0) - .8
        assembly.CLUTCH_GROUPS = ((-central, central, tuple(v for v in attachment["studLateralOffsets"] if abs(v) < outer)),
                                  (low, half, (outer,)), (-half, -low, (-outer,)))
        face = NARROW_RAIL - NARROW_PROFILE["railInterfaceWidth"] / 2

        def flangeways(paths):
            """track_assembly._flangeways at the narrow guiding face (no hinges in junction routes)."""
            low_z, high_z = end_.RAIL_TOP - assembly.FLANGE_DEPTH, end_.RAIL_TOP + .1
            width = assembly.FLANGE_CLEARANCE
            return [assembly._ribbon(path, sign * (face - width / 2), width / 2, low_z, high_z)
                    for path in paths for sign in (-1, 1)]
        assembly._flangeways = flangeways

        def rails(path, bottom=3.2):
            """track_assembly._rails at +/-12: each rail is the standard pair's rail of the path offset by 8 mm."""
            from . import track_assembly as standard_assembly
            path = np.asarray(path, float)
            normal = np.column_stack([-np.sin(path[:, 2]), np.cos(path[:, 2])])
            meshes = []
            for side in (-1, 1):
                moved = path.copy()
                moved[:, :2] += normal * side * (NARROW_RAIL - standard.RAIL)
                target = path[len(path) // 2, :2] + normal[len(path) // 2] * side * NARROW_RAIL
                pair = standard_assembly._rails(moved, bottom).split(only_watertight=False)
                meshes.append(min(pair, key=lambda body: np.linalg.norm(body.vertices[:, :2] - target, axis=1).min()))
            return assembly._union(meshes)
        assembly._rails = rails
        package.track_assembly = assembly
        package.turnout = _load("turnout")
    except BaseException:
        for key in [key for key in sys.modules if key == _PACKAGE or key.startswith(_PACKAGE + ".")]:
            del sys.modules[key]
        raise
    return package


# ------------------------------------------------------------------ narrow
def _narrow_request(p: dict) -> dict:
    """The narrow copy's request: the project's standard profile is checked, then swapped for the narrow one."""
    shared = {key: p[key] for key in SHARED}
    end_.validate(shared)
    request = {key: value for key, value in p.items() if key != "gauge"}
    request.update(body_width=NARROW_PROFILE["bodyWidth"], rail_gauge=NARROW_PROFILE["railGauge"])
    if request.get("guard_rail") or request.get("street"):
        raise ValueError("narrow gauge track has no guard rail or street option")
    if request.get("socket"):
        raise ValueError("narrow gauge track has no helix column lug")
    return request


def narrow_validate(p: dict):
    return narrow_package().composite.validate(_narrow_request(p))


def narrow_track_mesh(p: dict) -> trimesh.Trimesh:
    return narrow_package().composite.track_mesh(_narrow_request(p))


def narrow_build(p: dict):
    return narrow_package().composite.build(_narrow_request(p))


def narrow_ports(p: dict) -> list[dict]:
    """Ports as composite.ports. ``rail_gauge`` is the connector profile's (the request's), as on every
    brick-track part: ports describe the interface family, the running gauge is the ``gauge`` option."""
    return [{**row, "rail_gauge": p["rail_gauge"]} for row in narrow_package().composite.ports(_narrow_request(p))]


def narrow_connector_ends(p: dict) -> list[dict]:
    return narrow_package().composite.connector_ends(_narrow_request(p))


# ------------------------------------------------------------------ dual
class DualBuilder(standard.Builder):
    """Standard composite plus centred narrow rails on widened stringers (module docstring)."""

    def voids(self):
        """Tie gaps open only outside the stringers and between the narrow stringers."""
        half = standard.WIDTH / 2
        outer = standard.RAIL + standard.STRINGER
        bands = [(-half - 1, -outer), (-DUAL_STRINGER, DUAL_STRINGER), (outer, half + 1)]
        return [self._occ([(low, -1), (high, -1), (high, standard.BASE + .1), (low, standard.BASE + .1)])
                for low, high in bands]

    def tie_columns(self, tie, half):
        return [column for column in super().tie_columns(tie, half) if abs(column) != DUAL_DROPPED]

    def options(self):
        meshes = super().options()
        rails = []
        for side in (-1, 1):
            section = [(y + side * NARROW_RAIL, z) for y, z in end_.PROFILE["railSection"]]
            rails.append(self._occ(section))
        depth = standard.DEPTH + .05
        for frame in (self.route.start, self.route.end @ np.diag([-1, -1, 1, 1])):
            for side in (-1, 1):
                stub = _rail_prism(side * NARROW_RAIL, .1, depth)
                stub.apply_transform(frame)
                rails.append(stub)
        return [*meshes, *rails]

    def channel(self, webs, low_z, high_z):
        """Hollow baseplate channels under the standard and the narrow rails."""
        main = super().channel(webs, low_z, high_z)
        c = end_.PROFILE["brickAttachment"]["railChannel"]
        cutters = []
        for lateral in (-NARROW_RAIL, NARROW_RAIL):
            lower, upper = c["lowerHalfWidth"], c["upperHalfWidth"]
            bottom, ledge, ceiling = -1, c["lowerCeiling"], c["upperCeiling"]
            cutters.append(self._occ([(lateral - lower, bottom), (lateral + lower, bottom), (lateral + lower, ledge),
                                      (lateral + upper, ledge), (lateral + upper, ceiling),
                                      (lateral - upper, ceiling), (lateral - upper, ledge), (lateral - lower, ledge)]))
        narrow = trimesh.boolean.intersection([standard._union(cutters), self.interior(low_z, high_z)],
                                              engine="manifold")
        placed = []
        for frame in webs:
            web = end_.channel_web()
            web.apply_transform(frame)
            placed.append(web)
        if placed:
            narrow = trimesh.boolean.difference([narrow, *placed], engine="manifold")
        return trimesh.boolean.union([main, narrow], engine="manifold")


def validate_dual(spec) -> None:
    if not spec.level:
        raise ValueError("dual gauge track is level only")
    if spec.guard or spec.street:
        raise ValueError("dual gauge track has no guard rail or street option (the narrow rails run there)")


# ------------------------------------------------------------------ probes
def _rails_of(gauge: int) -> list[tuple[float, float]]:
    """(rail centre lateral, flange side) of every running rail; the flange runs inside its gauge."""
    standard_rails = [(-standard.RAIL, 1.), (standard.RAIL, -1.)]
    narrow_rails = [(-NARROW_RAIL, 1.), (NARROW_RAIL, -1.)]
    return narrow_rails if gauge == NARROW else standard_rails + (narrow_rails if gauge == DUAL else [])


def probe_running(p: dict) -> dict:
    """Digital running checks along the whole piece (port faces included).

    - Every gauge's wheel-flange corridor (2.2 mm inside each running rail's guiding
      face, 3.2 mm below the rail top) is clear of the solid: no stud, tie, other rail
      or end clip in it.
    - Rail heads are present at their nominal lateral (+/-0.2 mm) at rail-top height at
      every 0.5 mm station from 0.3 mm to the far port face: rails are continuous and aligned
      with the mating piece's.
    """
    gauge = int(p.get("gauge", 0))
    if gauge == NARROW:
        mesh = narrow_track_mesh(p)
        module = narrow_package().composite
        request = _narrow_request(p)
    else:
        mesh = standard.track_mesh(p)
        module, request = standard, p
    spec = module.validate(request)
    if not spec.level:
        raise ValueError("the running probe covers level track")
    plan = module.Plan(spec.segments)
    top = end_.RAIL_TOP + spec.z0
    face_half = end_.PROFILE["railInterfaceWidth"] / 2
    stations = np.arange(.3, spec.length - .3 + 1e-9, .5)
    states = np.array([plan.state(s) for s in stations])
    normal = np.column_stack([-np.sin(states[:, 2]), np.cos(states[:, 2])])
    from .crossing_any import _Slices
    solid = _Slices(mesh)
    obstruction, misaligned = 0., 0

    def inside(points, z):
        return solid.inside(points, z)

    rails = []
    for lateral, inward in _rails_of(gauge):
        # The standard rails' accepted source contacts (tongues, 6 mm at each port) are not flangeway track.
        keep = np.ones(len(stations), bool) if abs(lateral) == NARROW_RAIL else (
            (stations >= 6) & (stations <= spec.length - 6))
        at, across = states[keep, :2], normal[keep]
        face = lateral + inward * face_half
        # The rigid connector ends' blends bring a tight curve's rail up to ~0.15 mm off the ideal line.
        corridor = np.linspace(face + inward * BLEND, face + inward * (FLANGE_CLEARANCE - .1), 5)
        hit = 0
        for z in np.linspace(top - FLANGE_DEPTH + .1, top - .1, 6):
            for offset in corridor:
                hit += int(inside(at + across * offset, float(z)).sum())
        obstruction += hit
        head = inside(at + across * lateral, float(top - .1))
        edges = [inside(at + across * (lateral + sign * (face_half - .2)), float(top - .1)) for sign in (-1, 1)]
        present = head & edges[0] & edges[1]
        misaligned += int((~present).sum())
        rails.append({"lateralMm": lateral, "flangeSide": "left" if inward > 0 else "right", "samples": int(keep.sum()),
                      "corridorHits": hit, "headMissingSamples": int((~present).sum())})
    if obstruction:
        raise ValueError(f"wheel-flange corridor obstructed at {obstruction} samples")
    if misaligned:
        raise ValueError(f"rail head missing or off its lateral at {misaligned} samples")
    return {"gauge": {0: "standard", NARROW: "narrow", DUAL: "dual"}[gauge], "lengthMm": spec.length,
            "samplePitchMm": .5, "rails": rails, "physicalWheelAcceptance": "not_checked"}


def probe_mating(p: dict) -> dict:
    """Two copies of the piece's end joined face to face (as two pieces meet): no interference,
    and the rail heads of both gauges continue across the joint within 0.01 mm laterally."""
    gauge = int(p.get("gauge", 0))
    production = _narrow_production_end if gauge == NARROW else end_._production_end
    a = production(p["fit_adjustment"])
    b = production(p["fit_adjustment"], opposite=True)
    b.apply_transform(np.diag([-1, -1, 1, 1]))
    extra = []
    if gauge == DUAL:
        for mesh, flip in ((a, 1), (b, -1)):
            for side in (-1, 1):
                stub = _rail_prism(side * NARROW_RAIL, .1, standard.DEPTH + .05)
                if flip < 0:
                    stub.apply_transform(np.diag([-1, -1, 1, 1]))
                extra.append(stub)
    clash = abs(trimesh.boolean.intersection([a, b], engine="manifold").volume)
    if clash > .001:
        raise ValueError(f"mated ends interfere: {clash:.4f} mm^3")
    return {"gauge": {0: "standard", NARROW: "narrow", DUAL: "dual"}[gauge], "interferenceMm3": clash,
            "railGapMm": .2, "physicalFit": "not_checked"}
