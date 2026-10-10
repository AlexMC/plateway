"""Experimental gauge junctions (Wave 5); millimetres. Registered in assemblies.JUNCTION_MODULES.

narrow_stub_switch: the narrow-gauge switch. Official-style point blades do not fit 24 mm gauge: turnout.py's heel
keepers need the two routes' centre lines 17 mm apart, which narrow routes only reach past their frog (centres
19.4 mm apart), for every Pythagorean S-bend tried (R30..R78, flex 48..176 mm; see gauge.py tests). So the narrow
switch is a stub switch, the classic narrow-gauge and mine-railway switch: a short deck pivots at the toe and swings
its far end between two fixed narrow stubs. It is tables.py's sector plate, unchanged, loaded on the narrow profile
(gauge.narrow_package) with a 24-stud deck and two tracks 11.25 degrees apart: the deck kinks 5.625 degrees
at its pivot (the official flex-track joint limit), magnets hold it and a drop-in dowel pin locks it lined up.

dual_divergence: where narrow gauge leaves 4-rail dual track. Fixed, no moving parts (as TrixBrix's dual-gauge
turnout): the standard route runs straight 152 mm (19 studs); the centred narrow route curves away on R24 (192 mm,
official 85976's radius) through 45 degrees and crosses the outer standard rail. The body is a standard composite
straight and a narrow composite curve united; the narrow body starts behind the accepted standard 'in' end (its rails
continue on the end's deck), and its far end is a narrow end clear of the 'out' end. Frogs as crossing_any: every
route's wheel-flange corridor (2.2 mm inside each guiding face, 3.2 mm deep) is cut from every rail, leaving frog
gaps, noses and wing rails; where another gauge's corridor interrupts a guiding face for more than 4 mm, a check rail
inside the opposite rail of the same route holds the back of the other flange across the gap. One printed part on
the A1 mini bed; seats on a flat table or baseplate (the two bodies' clutch bays overlap where they cross).
Wheel acceptance through the frogs is a physical trial gate.
"""
from __future__ import annotations

from functools import lru_cache
import math
from pathlib import Path

import cadquery as cq
import numpy as np
import trimesh

from . import composite as standard
from . import crossing_any as ca
from . import gauge
from . import brick_end as end_
from . import lite
from . import track_assembly as ta

FAMILIES = ("narrow_stub_switch", "dual_divergence")
COMPONENT_FAMILY = "gauge_component"
CONNECTOR = frozenset({"connector_version", "fit_adjustment"})
SHAPES = {"narrow_stub_switch": ("deck", "switch_state"), "dual_divergence": ("hand",)}
STUB_DECKS = (192.,)   # 128 mm: the far stubs sit 0.84 mm / 2.1 deg off one deck rail (tables.probe_alignment)
STUB_TRACKS = 2
# Dual divergence: standard main, narrow R24 branch.
MAIN = 152.
BRANCH_RADIUS, BRANCH_TURN = 192., math.radians(45)
STANDARD_FACE = standard.RAIL - end_.PROFILE["railInterfaceWidth"] / 2           # 18.8
NARROW_FACE = gauge.NARROW_RAIL - end_.PROFILE["railInterfaceWidth"] / 2          # 10.8
FLANGE = ta.FLANGE_CLEARANCE                                                       # 2.2
CONTACT = 6.            # accepted source contacts: corridors and probes start this far inside each port
BED = 166.
SOURCE_DEPENDENCIES = [Path(gauge.__file__), gauge.NARROW_PROFILE_PATH, Path(standard.__file__), Path(ca.__file__),
                       Path(ta.__file__), Path(end_.__file__), Path(__file__).with_name("tables.py"),
                       Path(__file__).with_name("lite.py")]


def _number(value) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


# ------------------------------------------------------------------ narrow stub switch (tables.py sector plate)
@lru_cache(maxsize=1)
def _tables():
    """tables.py on the narrow profile: girders outside the narrow rails and the short stub-switch decks allowed."""
    gauge.narrow_package()
    module = gauge._load("tables")
    module.GIRDER = (gauge.NARROW_RAIL + 4., module.HALF)
    validate_sector = module.validate

    def validate(family, p):
        if family == "sector_plate" and p.get("deck") in STUB_DECKS:
            # Every other rule is the sector plate's; its long decks are only a size choice.
            validate_sector(family, {**p, "deck": 384.})
            if p["tracks"] != STUB_TRACKS:
                raise ValueError("a narrow stub switch has two tracks")
            return
        raise ValueError("narrow stub switches have a 192 mm deck")
    module.validate = validate
    return module


def _sector(p: dict) -> dict:
    return {"connector_version": p["connector_version"], "fit_adjustment": p["fit_adjustment"],
            "switch_state": p["switch_state"], "deck": p["deck"], "tracks": STUB_TRACKS}


# ------------------------------------------------------------------ dual divergence geometry
def _shared(adjustment: float) -> dict:
    profile = end_.PROFILE
    return {"connector_version": profile["version"], "fit_adjustment": adjustment, "body_width": profile["bodyWidth"],
            "base_thickness": profile["baseThickness"], "rail_gauge": profile["railGauge"],
            "rail_interface_width": profile["railInterfaceWidth"], "rail_height": profile["railHeight"]}


def divergence_paths(hand: float) -> dict[str, np.ndarray]:
    """Dense (x, y, heading) centre lines: the standard main and the narrow branch (piece frame)."""
    s = np.arange(0., MAIN + 1e-9, .25)
    main = np.column_stack([s, np.zeros_like(s), np.zeros_like(s)])
    turn = np.linspace(0., BRANCH_TURN, int(BRANCH_RADIUS*BRANCH_TURN / .25) + 1)
    branch = np.column_stack([BRANCH_RADIUS*np.sin(turn), hand*BRANCH_RADIUS*(1 - np.cos(turn)), hand*turn])
    return {"main": main, "branch": branch}


def _ports(hand: float) -> list[dict]:
    x, y, heading = divergence_paths(hand)["branch"][-1]
    rows = []
    for ident, px, py, h in (("in", 0., 0., math.pi), ("out", MAIN, 0., 0.), ("branch", x, y, heading)):
        rows.append({"id": ident, "position": [float(px), float(py), 0.], "heading": float(h), "pitch": 0.,
                     # Ports name the connector profile, as every brick-track part; the running gauge is the route's.
                     "rail_gauge": end_.PROFILE["railGauge"], "rail_interface_width": end_.PROFILE["railInterfaceWidth"]})
    return rows


def _station(path, low, high):
    lengths = np.r_[0., np.cumsum(np.linalg.norm(np.diff(path[:, :2], axis=0), axis=1))]
    return path[(lengths >= low) & (lengths <= high)]


def _corridors(path, face, length):
    """Wheel-flange corridors inside both rails of one route, clear of the source contacts at its ports."""
    # 1 mm more on curves: a corridor's square end is not square to the port.
    inner = _station(path, CONTACT + 1, length - CONTACT - 1)
    low, high = end_.RAIL_TOP - ta.FLANGE_DEPTH, end_.RAIL_TOP + .1
    return [ta._ribbon(inner, side*(face - FLANGE/2), FLANGE/2, low, high) for side in (-1, 1)]


def guide_gaps(hand: float) -> list[dict]:
    """Every stretch where the other route's flange corridor interrupts a guiding face (crossing_any.guide_gaps
    with each route's own gauge)."""
    paths, faces = divergence_paths(hand), {"main": STANDARD_FACE, "branch": NARROW_FACE}
    dense = {ident: (np.r_[0., np.cumsum(np.linalg.norm(np.diff(path[:, :2], axis=0), axis=1))], path)
             for ident, path in paths.items()}
    gaps = []
    for ident, (s, points) in dense.items():
        other = "branch" if ident == "main" else "main"
        back, face = faces[other] - FLANGE, faces[other]
        for rail in (-1, 1):
            line = points[:, :2] + ca._normals(points)*rail*faces[ident]
            lateral, beside = ca._project(line, dense[other][1])
            cut = beside & (np.abs(lateral) >= back - 1e-6) & (np.abs(lateral) <= face + 1e-6)
            gaps += [{"route": ident, "rail": rail, "s0": a, "s1": b, "length": b - a} for a, b in ca._runs(cut, s)]
    return gaps


def check_rails(hand: float) -> list[dict]:
    """Check rails opposite every guiding-face gap over crossing_any.GUIDE_LIMIT (route, rail, s0, s1)."""
    lengths = {"main": MAIN, "branch": BRANCH_RADIUS*BRANCH_TURN}
    specs = []
    for gap in guide_gaps(hand):
        # 1 mm under the limit: the measured gap also loses the guiding face's flared corners.
        if gap["length"] <= ca.GUIDE_LIMIT - 1.:
            continue
        length = lengths[gap["route"]]
        lo, hi = max(gap["s0"] - ca.CHECK_LEAD, ca.END_ZONE[1]), min(gap["s1"] + ca.CHECK_LEAD, length - ca.END_ZONE[1])
        spec = {"route": gap["route"], "rail": -gap["rail"], "s0": lo, "s1": hi}
        for other in specs:
            if (other["route"], other["rail"]) == (spec["route"], spec["rail"]) and lo <= other["s1"] and other["s0"] <= hi:
                other["s0"], other["s1"] = min(other["s0"], lo), max(other["s1"], hi)
                break
        else:
            specs.append(spec)
    return specs


@lru_cache(maxsize=8)
def divergence_mesh(hand: float, adjustment: float, lite: bool) -> trimesh.Trimesh:
    shared = _shared(adjustment)
    fast = {"lite": 1} if lite else {}
    main = standard.track_mesh({**standard.straight(shared, MAIN), **fast})
    length = BRANCH_RADIUS*BRANCH_TURN
    curvature = hand / BRANCH_RADIUS
    branch = gauge.narrow_track_mesh({**shared, "segments": 1, "s0_len": length, "s0_k0": curvature, "s0_k1": curvature,
                                      "z0": 0., "z1": 0., "grade0": 0., "grade1": 0., "vcurve": 0., "cant0": 0.,
                                      "cant1": 0., "ends": 2, "gauge": gauge.NARROW, **fast})
    # The accepted standard 'in' end stays whole: the narrow body starts behind its end tie, its rails on the end's deck.
    tie = end_.PROFILE["endTieWidth"]
    branch = trimesh.boolean.difference([branch, end_._box((-10, -40, -1), (tie, 40, 12))], engine="manifold")
    stubs = [gauge._rail_prism(side*gauge.NARROW_RAIL, .1, tie + .5) for side in (-1, 1)]
    body = trimesh.boolean.union([main, branch, *stubs], engine="manifold")
    paths = divergence_paths(hand)
    cutters = _corridors(paths["main"], STANDARD_FACE, MAIN) + _corridors(paths["branch"], NARROW_FACE, length)
    body = trimesh.boolean.difference([body, *cutters], engine="manifold")
    checks = []
    narrow_ca = gauge.narrow_package().turnout.ca
    for spec in check_rails(hand):
        module = ca if spec["route"] == "main" else narrow_ca
        checks += module.check_rail_mesh([(spec["route"], "", "", paths[spec["route"]])], [{**spec, "route": 0}])
    return trimesh.boolean.union([body, *checks], engine="manifold") if checks else body


def _footprint_problem(mesh: trimesh.Trimesh) -> str | None:
    tb = _tables()
    yaw = tb.best_yaw(mesh)
    size = tb.plan_size(mesh, yaw)
    return None if max(size) <= BED + 1e-3 else f"dual divergence is {max(size):.1f} mm across; the mini bed is {BED:g} mm"


# ------------------------------------------------------------------ registry interface (assemblies.py)
def validate(family: str, p: dict) -> None:
    if family not in FAMILIES:
        raise ValueError("unknown gauge junction family")
    required = CONNECTOR | set(SHAPES[family])
    allowed = {"lite"} if family == "dual_divergence" else set()
    if set(p) - allowed != required:
        raise ValueError(f"{family} requires exactly {sorted(required)}")
    if any(not _number(value) for value in p.values()):
        raise ValueError("gauge junction parameters must be finite numbers")
    end_.validate(p)
    if family == "narrow_stub_switch":
        if p["deck"] not in STUB_DECKS:
            raise ValueError("a narrow stub switch deck is 192 mm")
        _tables().validate("sector_plate", _sector(p))
    else:
        if p["hand"] not in (-1, 1):
            raise ValueError("hand must be 1 (left) or -1 (right)")
        if "lite" in p:
            lite.validate(p)


def ports(family: str, p: dict) -> list[dict]:
    validate(family, p)
    if family == "narrow_stub_switch":
        return [{**row, "rail_gauge": end_.PROFILE["railGauge"]} for row in _tables().ports("sector_plate", _sector(p))]
    return _ports(float(p["hand"]))


def route_pairs(family: str, p: dict) -> dict[frozenset, bool]:
    validate(family, p)
    if family == "narrow_stub_switch":
        return _tables().route_pairs("sector_plate", _sector(p))
    return {frozenset(("in", "out")): True, frozenset(("in", "branch")): True}


def parts(family: str, p: dict) -> list[tuple[str, trimesh.Trimesh, float]]:
    """(role, mesh in the piece frame, print yaw) of every printed part."""
    validate(family, p)
    if family == "narrow_stub_switch":
        return _tables().parts("sector_plate", _sector(p))
    mesh = divergence_mesh(float(p["hand"]), float(p["fit_adjustment"]), "lite" in p)
    return [("divergence", mesh, _tables().best_yaw(mesh))]


def components(family: str, p: dict) -> list[dict]:
    code = FAMILIES.index(family)
    return [{"role": role, "parameters": {**p, "shape_code": code, "component_index": index}}
            for index, (role, _, _) in enumerate(parts(family, p))]


def _family_of(p) -> str:
    code = p.get("shape_code")
    if not _number(code) or code != int(code) or not 0 <= code < len(FAMILIES):
        raise ValueError("invalid shape_code")
    return FAMILIES[int(code)]


def _logical(p):
    return {key: value for key, value in p.items() if key not in ("shape_code", "component_index")}


def component_keys(p: dict) -> set[str]:
    family = _family_of(p)
    return set(CONNECTOR | set(SHAPES[family]) | {"shape_code", "component_index"} |
               ({"lite"} & set(p) if family == "dual_divergence" else set()))


def validate_component(p: dict) -> None:
    family = _family_of(p)
    if set(p) != component_keys(p):
        raise ValueError("unexpected gauge junction component parameters")
    index = p["component_index"]
    if not _number(index) or index != int(index) or not 0 <= index < len(parts(family, _logical(p))):
        raise ValueError("component_index outside assembly")


def component_ports(p: dict) -> list[dict]:
    family = _family_of(p)
    return [row for row in ports(family, _logical(p)) if not row["id"].startswith("free-")]


def print_yaw(p: dict) -> float:
    validate_component(p)
    return parts(_family_of(p), _logical(p))[int(p["component_index"])][2]


def build_component(p: dict) -> cq.Shape:
    validate_component(p)
    family = _family_of(p)
    role, mesh, yaw = parts(family, _logical(p))[int(p["component_index"])]
    if family == "dual_divergence":
        problem = _footprint_problem(mesh)
        if problem:
            raise ValueError(problem)
    checked = _tables().check_mesh(role, mesh, yaw)
    return gauge.narrow_package().brick_end._solid(checked)


def hardware(family: str, p: dict) -> list[dict]:
    validate(family, p)
    return _tables().hardware("sector_plate", _sector(p)) if family == "narrow_stub_switch" else []


def assembly_notes(family: str, p: dict) -> list[str]:
    validate(family, p)
    if family == "narrow_stub_switch":
        return [*_tables().assembly_notes("sector_plate", _sector(p)),
                "Narrow gauge: the deck and stubs carry 24 mm rails; only narrow-gauge cars run through it."]
    return ["One printed part: no assembly. Seat it on a flat table or baseplate.",
            "Keep the frog gaps and flangeways free of support material and stringing.",
            "Standard trains run in to out; narrow-gauge trains run in to branch, across the outer standard rail."]


# ------------------------------------------------------------------ probes
def probe_running(p: dict) -> dict:
    """Dual divergence, both routes: flange corridors clear (source contacts excepted), running heads present within
    4 mm at every 0.5 mm station, and every wheelset guided (a guiding face or a check rail face) within 4 mm."""
    validate("dual_divergence", p)
    hand = float(p["hand"])
    mesh = divergence_mesh(hand, float(p["fit_adjustment"]), "lite" in p)
    solid = ca._Slices(mesh)
    paths, faces = divergence_paths(hand), {"main": (standard.RAIL, STANDARD_FACE), "branch": (gauge.NARROW_RAIL, NARROW_FACE)}
    report, corridor_hits = [], 0
    for ident, path in paths.items():
        rail_half, face = faces[ident]
        lengths = np.r_[0., np.cumsum(np.linalg.norm(np.diff(path[:, :2], axis=0), axis=1))]
        keep = (lengths >= CONTACT) & (lengths <= lengths[-1] - CONTACT)
        points, s = path[keep][::2], lengths[keep][::2]
        normal = ca._normals(points)
        for rail in (-1., 1.):
            for z in np.linspace(end_.RAIL_TOP - ta.FLANGE_DEPTH + .1, end_.RAIL_TOP - .1, 5):
                for offset in np.linspace(face - FLANGE + .1, face - .25, 4):
                    corridor_hits += int(solid.inside(points[:, :2] + normal*rail*offset, float(z)).sum())
            heads = np.any([solid.inside(points[:, :2] + normal*(rail*rail_half + d), 9.45) for d in np.linspace(-1.1, 1.1, 5)], axis=0)
            guided = np.any([solid.inside(points[:, :2] + normal*rail*(face + .15), z) for z in (7., 8.2, 9.4)], axis=0) | \
                np.any([solid.inside(points[:, :2] - normal*rail*(face - FLANGE - .15), z) for z in (7., 8.2, 9.4)], axis=0)
            head_gap = unguided = run_h = run_g = 0.
            for has_head, has_guide in zip(heads, guided):
                run_h = 0. if has_head else run_h + .5
                run_g = 0. if has_guide else run_g + .5
                head_gap, unguided = max(head_gap, run_h), max(unguided, run_g)
            report.append({"route": ident, "rail": "left" if rail > 0 else "right", "headGapMm": head_gap,
                           "unguidedMm": unguided})
    worst_head = max(row["headGapMm"] for row in report)
    worst_guide = max(row["unguidedMm"] for row in report)
    if corridor_hits:
        raise ValueError(f"wheel-flange corridor obstructed at {corridor_hits} samples")
    if worst_head > 4.:
        raise ValueError(f"unsupported running-head gap {worst_head:.1f} mm: {max(report, key=lambda row: row['headGapMm'])}")
    if worst_guide > ca.GUIDE_LIMIT:
        raise ValueError(f"wheelset unguided for {worst_guide:.1f} mm: {max(report, key=lambda row: row['unguidedMm'])}")
    return {"rails": report, "checkRails": check_rails(hand), "samplePitchMm": .5, "physicalWheelAcceptance": "not_checked"}


def probe_contacts(p: dict) -> list[dict]:
    """The accepted standard ends at 'in' and 'out' and the narrow end at 'branch' are unchanged in the built part."""
    validate("dual_divergence", p)
    hand, adjustment = float(p["hand"]), float(p["fit_adjustment"])
    mesh = divergence_mesh(hand, adjustment, "lite" in p)
    report = []
    for row in _ports(hand):
        x, y, heading = row["position"][0], row["position"][1], row["heading"] + math.pi
        frame = end_._frame((x, y, 0), heading, 0)
        local = mesh.copy()
        local.apply_transform(np.linalg.inv(frame))
        narrow = row["id"] == "branch"
        source = gauge._narrow_contact(adjustment, opposite=row["id"] != "in") if narrow else \
            end_._production_end(adjustment, opposite=row["id"] != "in")
        # As turnout.probe_source_contacts: the end region less its half-tie studs (added by the tie clutch) and, at
        # 'in', the narrow rail stubs standing on the standard end's deck.
        columns = (gauge.NARROW_PROFILE if narrow else end_.PROFILE)["brickAttachment"]["studLateralOffsets"]
        lands = [end_._box((4 - 2.45, c - 2.45, 3.2), (4 + 2.45, c + 2.45, 4.9)) for c in columns]
        stubs = [end_._box((-1, side*gauge.NARROW_RAIL - 3.05, 3.19), (6, side*gauge.NARROW_RAIL + 3.05, 10))
                 for side in (-1, 1)] if row["id"] == "in" else []
        region = ta._difference(end_._box((-5, -23.9, -.01), (5.79, 23.9, 10)), lands + stubs)
        expected = trimesh.boolean.intersection([source, region], engine="manifold")
        actual = trimesh.boolean.intersection([local, region], engine="manifold")
        lost = abs(ta._difference(expected, [actual]).volume)
        added = abs(ta._difference(actual, [expected]).volume)
        report.append({"port": row["id"], "lostMm3": lost, "addedMm3": added})
        if max(lost, added) > .005:
            raise ValueError(f"source interface changed at {row['id']}: lost={lost:.4f}, added={added:.4f} mm^3")
    return report


def probe_bed(p: dict) -> dict:
    validate("dual_divergence", p)
    mesh = divergence_mesh(float(p["hand"]), float(p["fit_adjustment"]), "lite" in p)
    yaw = _tables().best_yaw(mesh)
    return {"planSizeMm": [round(v, 2) for v in _tables().plan_size(mesh, yaw)], "yawDeg": math.degrees(yaw),
            "watertight": bool(mesh.is_watertight), "bodies": len(mesh.split(only_watertight=False)), "bed": BED}
