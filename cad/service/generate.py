"""Strict, millimetre-only trial geometry generation from measured part parameters."""

from __future__ import annotations

from functools import lru_cache
import hashlib
import io
import json
import math
import re
import tempfile
from pathlib import Path

import cadquery as cq
import trimesh

from cad.library.check import LIBRARY_ID
from cad.models import (bridge, buffer, composite, connector, flex_track, gauge, helix_column, brick_end, lite, mating, rack, rail,
                        rerailer, riser, road, support, track_assembly, track_bracket, transition)
from cad.service.assemblies import COMPONENT_MODULES
from cad.service.errors import UserError
from cad.service.verify_mesh import bounds as source_bounds, verify


_CONNECTOR = {
    "body_length", "body_width", "base_thickness", "rail_gauge", "rail_width",
    "rail_height", "tongue_length", "tongue_width", "tongue_height",
    "socket_clearance", "socket_depth",
}
_MATING = {"joint_width", "joint_depth", "joint_height", "joint_clearance"}
_BRICK = {"connector_version", "fit_adjustment"}
_BRICK_FAMILIES = {"vertical_transition", "printed_straight", "printed_curve",
                  "bridge_deck", "bridge_joint", composite.FAMILY, buffer.FAMILY, rerailer.FAMILY,
                  flex_track.FAMILY}
# Scenic families built on a level composite straight: their own validation, lite from lite.py.
_SCENIC_TRACK = {buffer.FAMILY: buffer, rerailer.FAMILY: rerailer}
# Built from sewn meshes: a STEP would only be a faceted copy.
_MESH_FAMILIES = {road.FAMILY}
_TRANSITION = {
    "run", "rise", "start_grade", "end_grade", "body_width",
    "base_thickness", "rail_gauge", "rail_interface_width", "rail_height",
} | _MATING
_RAIL = {"run", "body_width", "base_thickness", "rail_gauge",
         "rail_interface_width", "rail_height"} | _MATING
_CURVE = (_RAIL - {"run"}) | {"radius", "sweep"}
_DECK = {"run", "deck_width", "deck_thickness", "rail_gauge",
         "rail_interface_width", "rail_height"} | _MATING
_JOINT = (_DECK - {"run"}) | {"joint_length"}
_REVERSIBLE = {"height", "foot_length", "foot_width", "foot_thickness",
               "stem_width", "stem_depth", "seat_width", "seat_depth",
               "seat_thickness"}
_ANCHORED = {"height", "reach", "plate_width", "plate_thickness",
             "arm_width", "arm_thickness", "hole_diameter", "hole_spacing",
             "seat_width", "seat_depth", "seat_thickness"}
_FAMILIES = {
    "connector_coupon": (_CONNECTOR, connector.build, connector),
    "brick_end_coupon": ({"body_length"} | _BRICK, brick_end.build, brick_end),
    "vertical_transition": (_TRANSITION, transition.build, transition),
    "printed_straight": (_RAIL, rail.straight, rail),
    "printed_curve": (_CURVE, rail.curve, rail),
    "bridge_deck": (_DECK, bridge.deck, bridge),
    "bridge_joint": (_JOINT, bridge.joint, bridge),
    "connector_joiner": (_MATING, mating.joiner, mating),
    "reversible_column": (_REVERSIBLE, support.reversible, support),
    "anchored_bracket": (_ANCHORED, support.anchored, support),
    "track_component": (track_assembly.COMPONENT_PARAMETERS, track_assembly.build_component, track_assembly),
    # Parameter names depend on the segment count: composite.parameter_keys.
    composite.FAMILY: (set(), composite.build, composite),
    # Composite parameters (installed shape); printed straight as rigid and spine materials.
    flex_track.FAMILY: (set(), flex_track.build, flex_track),
    composite.INSERT_FAMILY: ({"marker"}, composite.marker_insert, composite),
    buffer.FAMILY: (buffer.PARAMETERS, buffer.build, buffer),
    rerailer.FAMILY: (rerailer.PARAMETERS, rerailer.build, rerailer),
    road.FAMILY: (road.PARAMETERS, road.build, road),
    riser.FAMILY: (riser.PARAMETERS, riser.build, riser),
    helix_column.FAMILY: (helix_column.PARAMETERS, helix_column.build, helix_column),
    track_bracket.FAMILY: (track_bracket.PARAMETERS, track_bracket.build, track_bracket),
    rack.FAMILY: (rack.PARAMETERS, rack.build, rack),
}
# Junction components other than the original mechanisms: parameter names depend on the shape.
_FAMILIES.update({family: (set(), module.build_component, module)
                  for family, module in COMPONENT_MODULES.items() if family != "track_component"})
_KEYS = {"version", "units", "family", "parameters", "printer_envelope",
         "part_revision", "layout_revision"}
_REVISION = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,79}\Z")
# A community piece's request (KTD9, R20) names its uploaded mesh instead of CAD parameters: `mesh` is the library
# item's version and the sha256 of its STL. There is nothing to regenerate; its ports are its marked ends.
_MESH_KEYS = _KEYS | {"mesh"}
DIGEST = re.compile(r"[0-9a-f]{64}\Z")


def _fields(value: object, expected: set[str], label: str) -> dict:
    if not isinstance(value, dict) or set(value) != expected:
        raise ValueError(f"{label} requires exactly {sorted(expected)}")
    return value


def _numbers(value: dict, label: str) -> None:
    for key, number in value.items():
        if isinstance(number, bool) or not isinstance(number, (int, float)) or not math.isfinite(number):
            raise ValueError(f"{label}.{key} must be a finite number")


def _positive(parameters: dict, names: set[str]) -> None:
    for name in names:
        if parameters[name] <= 0:
            raise ValueError(f"parameters.{name} must be positive")


def _header(request: object, keys: set[str]) -> dict:
    """The fields every request shares: version, units and safe revision tokens."""
    request = _fields(request, keys, "request")
    if type(request["version"]) is not int or request["version"] != 1:
        raise ValueError("unsupported CAD request version; expected 1")
    if request["units"] != "mm":
        raise ValueError("CAD request units must be mm")
    for key in ("part_revision", "layout_revision"):
        token = request[key]
        if not isinstance(token, str) or not _REVISION.fullmatch(token) or ".." in token:
            raise ValueError(f"{key} must be a safe, nonempty revision token")
    return request


def is_mesh_request(request: object) -> bool:
    return isinstance(request, dict) and "mesh" in request


def _validate_mesh(request: object) -> dict:
    request = _header(request, _MESH_KEYS)
    mesh = _fields(request["mesh"], {"version", "digest"}, "mesh")
    if not isinstance(request["family"], str) or not LIBRARY_ID.fullmatch(request["family"]):
        raise ValueError("a community piece's family is its library id")
    if request["parameters"] != {}:
        raise ValueError("a community piece prints as uploaded: it takes no parameters")
    if type(mesh["version"]) is not int or mesh["version"] < 1 or not isinstance(mesh["digest"], str) or not DIGEST.fullmatch(mesh["digest"]):
        raise ValueError("mesh needs the library item's version and the sha256 of its file")
    envelope = _fields(request["printer_envelope"], {"x", "y", "z"}, "printer_envelope")
    _numbers(envelope, "printer_envelope")
    _positive(envelope, set(envelope))
    return request


def _validate(request: object) -> tuple[dict, object, object]:
    request = _header(request, _KEYS)
    family = request["family"]
    if not isinstance(family, str) or family not in _FAMILIES:
        raise ValueError(f"unsupported CAD family: {family!r}")
    required, builder, module = _FAMILIES[family]
    if family in (composite.FAMILY, flex_track.FAMILY):
        if not isinstance(request["parameters"], dict):
            raise ValueError("parameters must be an object")
        required = composite.parameter_keys(request["parameters"])
    elif family in COMPONENT_MODULES:
        if not isinstance(request["parameters"], dict):
            raise ValueError("parameters must be an object")
        required = COMPONENT_MODULES[family].component_keys(request["parameters"])
    uses_brick_ends = family == "brick_end_coupon" or (
        family in _BRICK_FAMILIES and isinstance(request["parameters"], dict)
        and "connector_version" in request["parameters"])
    if uses_brick_ends and family in _BRICK_FAMILIES:
        required = (required - _MATING) | _BRICK
    if family in (composite.FAMILY, flex_track.FAMILY) and not uses_brick_ends:
        raise ValueError(f"{family} exists only with the brick track connector")
    fast = isinstance(request["parameters"], dict) and "lite" in request["parameters"]
    if family == "reversible_column" and isinstance(request["parameters"], dict) and "seat_pitch" in request["parameters"]:
        # A column under sloped track tilts its seat to the track's pitch (support.py).
        required = required | {"seat_pitch"}
    if fast:
        # Fast-print geometry exists only for connector track and track mechanisms.
        if not (uses_brick_ends and family in lite.FAMILIES) and family not in (
                *COMPONENT_MODULES, composite.FAMILY, flex_track.FAMILY, *_SCENIC_TRACK):
            raise ValueError(f"{family} has no fast-print geometry")
        required = required | {"lite"}
    params = _fields(request["parameters"], required, "parameters")
    envelope = _fields(request["printer_envelope"], {"x", "y", "z"}, "printer_envelope")
    _numbers(params, "parameters")
    _numbers(envelope, "printer_envelope")
    _positive(envelope, set(envelope))
    if family == composite.FAMILY:
        # Signed curvature, heights, grades and cant; composite.validate checks every range.
        composite.validate(params)
    elif family == flex_track.FAMILY:
        flex_track.validate(params)
    elif family == composite.INSERT_FAMILY:
        composite.validate_insert(params)
    elif family in _SCENIC_TRACK:
        _SCENIC_TRACK[family].validate(params)
    elif family == road.FAMILY:
        road.validate(params)
    elif family == riser.FAMILY:
        riser.validate(params)
    elif family in (helix_column.FAMILY, track_bracket.FAMILY, rack.FAMILY):
        _FAMILIES[family][2].validate(params)
    elif family in COMPONENT_MODULES:
        COMPONENT_MODULES[family].validate_component(params)
    else:
        _positive(params, required - {"socket_clearance", "joint_clearance",
                                      "rise", "start_grade", "end_grade", "sweep", "fit_adjustment",
                                      "bend", "switch_state", "shape_code", "component_index", "seat_pitch"})
    if fast:
        lite.validate(params)
        if family in lite.FAMILIES:
            builder, module = (lambda p, family=family: lite.build(p, family)), lite
    if uses_brick_ends and family not in (composite.FAMILY, flex_track.FAMILY):
        brick_end.validate(params)
        available = params["radius"] * abs(params["sweep"]) if family == "printed_curve" else (
            params.get("run", params.get("joint_length", params.get("body_length", 0))))
        if available < brick_end.PROFILE["minimumLength"]:
            raise ValueError("shared connector rails require at least 24 mm between ports")
    if family in {"connector_coupon", "vertical_transition", "printed_straight",
                  "printed_curve", "bridge_deck", "bridge_joint"}:
        width = params["deck_width" if family.startswith("bridge_") else "body_width"]
        gauge, rail_width = params["rail_gauge"], params[
            "rail_width" if family == "connector_coupon" else "rail_interface_width"]
        if gauge <= rail_width or gauge + rail_width >= width:
            raise ValueError("rail profile overlaps itself or extends beyond measured body width")
    if family == "connector_coupon":
        clearance = params["socket_clearance"]
        if clearance < 0:
            raise ValueError("socket_clearance must not be negative")
        if params["tongue_width"] + 2 * clearance >= width:
            raise ValueError("socket needs a positive side wall")
        if params["tongue_height"] + 2 * clearance >= params["base_thickness"]:
            raise ValueError("socket needs a positive top wall")
        if params["socket_depth"] >= params["body_length"] or (
                params["tongue_length"] > params["socket_depth"] - clearance):
            raise ValueError("coupon tongue needs axial clearance inside a closed socket")
    if family == "brick_end_coupon":
        if params["body_length"] != brick_end.PROFILE["sampleLength"]:
            raise ValueError("connector sample has a fixed 24 mm body")
    if family == "printed_curve" and (abs(params["sweep"]) < 1e-5 or abs(params["sweep"]) > math.pi / 2):
        raise ValueError("curve sweep must be nonzero and at most a quarter turn")
    if not uses_brick_ends and family in {"vertical_transition", "printed_straight", "printed_curve",
                                   "bridge_deck", "bridge_joint", "connector_joiner"}:
        clearance, depth = params["joint_clearance"], params["joint_depth"]
        if clearance < 0 or depth <= clearance:
            raise ValueError("joiner must have positive insertion depth and nonnegative clearance")
        if family != "connector_joiner":
            base = params["deck_thickness" if family.startswith("bridge_") else "base_thickness"]
            rail_width = params["deck_width" if family.startswith("bridge_") else "body_width"]
            if (params["joint_width"] + 2 * clearance >= rail_width or
                    params["joint_height"] + 2 * clearance >= base):
                raise ValueError("joiner socket needs positive side and top walls")
            available = params["radius"] * abs(params["sweep"]) if family == "printed_curve" else (
                params.get("run", params.get("joint_length", 0)))
            if family != "bridge_joint" and 2 * depth >= available:
                raise ValueError("joiner sockets must leave a solid rail web")
    if family == "vertical_transition":
        rise = params["rise"]
        start, end, run = (params[k] for k in ("start_grade", "end_grade", "run"))
        # z'(t) is quadratic. Require it to keep the sign of the total rise;
        # a zero-rise transition must have zero grade throughout. Descents
        # retain their signed assembly-frame ports and need a plate translation.
        direction = -1 if rise < 0 else 1
        d0 = direction * start * run
        d1 = direction * (3 * rise - (start + end) * run)
        d2 = direction * end * run
        a, b = d0 - 2 * d1 + d2, 2 * (d1 - d0)
        derivatives = [d0, d2]
        if a > 0 and 0 < -b / (2 * a) < 1:
            t = -b / (2 * a)
            derivatives.append(a * t * t + b * t + d0)
        if min(derivatives) < -1e-9:
            raise ValueError("transition height must be monotone between its ports")
    elif family == "printed_curve":
        if params["radius"] <= params["body_width"] / 2:
            raise ValueError("curve inner edge must have positive radius")
    elif family == "reversible_column":
        pitch = params.get("seat_pitch", 0.)
        if (params["stem_depth"] > min(params["foot_length"], params["seat_depth"]) or
                params["stem_width"] > min(params["foot_width"], params["seat_width"])):
            raise ValueError("support stem must connect its foot to the seat footprint")
        # The seat follows the track's grade, at most rack track's 20 %.
        if abs(math.tan(pitch)) > .2:
            raise ValueError("support seat_pitch must be at most 20 % either way")
        if params["height"] - params["seat_depth"] / 2 * abs(math.tan(pitch)) < .4:
            raise ValueError("support seat must stay at least 0.4 mm above the bed")
    elif family == "anchored_bracket":
        if (params["reach"] <= params["plate_thickness"] + params["seat_depth"] / 2 or
                params["hole_diameter"] >= params["plate_width"] or
                params["hole_spacing"] <= params["hole_diameter"] or
                (params["height"] - params["hole_spacing"]) / 2 <= params["hole_diameter"] / 2 or
                (params["height"] + params["hole_spacing"]) / 2 + params["hole_diameter"] / 2 >=
                params["height"] - params["arm_thickness"] or
                params["seat_thickness"] > params["arm_thickness"] or
                params["seat_width"] < params["arm_width"]):
            raise ValueError("bracket requires two clear holes and a connected arm and seat")
    return request, builder, module


def validate_request(request: object) -> None:
    """The parameter checks `generate_part` (or `mesh_part`) runs before building, without building (the API's,
    before queueing)."""
    if is_mesh_request(request):
        _validate_mesh(request)
    else:
        _validate(request)


def _ports(request: dict) -> list[dict]:
    p, family = request["parameters"], request["family"]
    if family in {"reversible_column", "anchored_bracket", "connector_joiner", *COMPONENT_MODULES,
                  composite.INSERT_FAMILY, road.FAMILY, riser.FAMILY,
                  helix_column.FAMILY, track_bracket.FAMILY, rack.FAMILY}:
        return []
    if family == composite.FAMILY:
        return composite.ports(p)
    if family == flex_track.FAMILY:
        return flex_track.ports(p)
    if family in _SCENIC_TRACK:
        return _SCENIC_TRACK[family].ports(p)
    if family == "brick_end_coupon":
        # Calibration samples are not routable layout segments.
        return []
    run = (p["body_length"] if family == "connector_coupon" else
           p["joint_length"] if family == "bridge_joint" else
           p["radius"] * math.sin(abs(p["sweep"])) if family == "printed_curve" else p["run"])
    rise = p["rise"] if family == "vertical_transition" else 0
    start_grade = p["start_grade"] if family == "vertical_transition" else 0
    end_grade = p["end_grade"] if family == "vertical_transition" else 0
    width = p["rail_width"] if family == "connector_coupon" else p["rail_interface_width"]
    end_y = (math.copysign(p["radius"] * (1 - math.cos(p["sweep"])), p["sweep"])
             if family == "printed_curve" else 0)
    sweep = p["sweep"] if family == "printed_curve" else 0
    return [
        {"id": name, "position": [x, y, z],
         "tangent": [math.cos(yaw) / math.hypot(1, grade),
                     math.sin(yaw) / math.hypot(1, grade),
                     grade / math.hypot(1, grade)],
         "heading": yaw, "pitch": math.atan(grade),
         "rail_gauge": p["rail_gauge"], "rail_interface_width": width}
        for name, x, y, z, yaw, grade in (
            ("start", 0, 0, 0, 0, start_grade),
            ("end", run, end_y, rise, sweep, end_grade))
    ]


def source_dependencies(request: dict) -> list[Path]:
    """All transitive model inputs, in stable order, also bundled with exports."""
    family = request["family"]
    uses_brick_ends = family == "brick_end_coupon" or "connector_version" in request["parameters"]
    if uses_brick_ends:
        shared = [] if family == "brick_end_coupon" else [Path(brick_end.__file__)]
        mechanism = COMPONENT_MODULES[family].SOURCE_DEPENDENCIES if family in COMPONENT_MODULES else []
        # Fast-print mechanisms and composites take their braces from lite.py; lite track is itself the model.
        fast = [Path(lite.__file__)] if family in (*COMPONENT_MODULES, composite.FAMILY, flex_track.FAMILY, *_SCENIC_TRACK) and "lite" in request["parameters"] else []
        scenic = [Path(composite.__file__)] if family in (*_SCENIC_TRACK, flex_track.FAMILY) else []
        # Narrow and dual composites: gauge.py builds them (narrow on its own profile; dual's centred rails from it).
        gauges = [Path(gauge.__file__), gauge.NARROW_PROFILE_PATH] if family == composite.FAMILY and request["parameters"].get("gauge") else []
        return [*shared, *scenic, brick_end.PROFILE_PATH, brick_end.REFERENCE_STL, brick_end.RAIL_REFERENCE_STL, *mechanism, *fast, *gauges]
    if family == road.FAMILY:
        return [Path(brick_end.__file__), Path(composite.__file__), brick_end.PROFILE_PATH]
    if family == riser.FAMILY:
        return [brick_end.PROFILE_PATH]
    if family == track_bracket.FAMILY:
        return [Path(brick_end.__file__), brick_end.PROFILE_PATH]
    if family in {"connector_coupon", "vertical_transition", "printed_straight",
                  "printed_curve", "bridge_deck"}:
        return [Path(mating.__file__)]
    return []


@lru_cache(maxsize=32)
def _cached_bytes(path: str, _mtime_ns: int, _size: int) -> bytes:
    return Path(path).read_bytes()


def _read(path: Path) -> bytes:
    """Geometry inputs are re-read only when they change on disk."""
    info = path.stat()
    return _cached_bytes(str(path), info.st_mtime_ns, info.st_size)


def _fingerprint(canonical: bytes, source: bytes, dependencies: list[tuple[str, bytes]]) -> str:
    """Hash only geometry inputs: the request, model code, profiles and reference meshes."""
    digest = hashlib.sha256()
    for value in (canonical, source):
        digest.update(len(value).to_bytes(8, "big"))
        digest.update(value)
    for name, content in dependencies:
        digest.update(name.encode() + b"\0")
        digest.update(len(content).to_bytes(8, "big"))
        digest.update(content)
    return digest.hexdigest()


def current_request_digest(request: dict) -> str:
    """Bind a saved recipe to the model and its shared profile/reference meshes; a community piece's to its mesh."""
    if is_mesh_request(request):
        return _mesh_digest(_validate_mesh(request))
    request, _, model = _validate(request)
    canonical = json.dumps(request, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()
    dependencies = [(path.name, _read(path)) for path in source_dependencies(request)]
    return _fingerprint(canonical, _read(Path(model.__file__)), dependencies)


def _mesh_digest(request: dict) -> str:
    """A community piece's recipe is its request alone: the mesh digest in it pins the geometry."""
    return _fingerprint(json.dumps(request, sort_keys=True, separators=(",", ":"), allow_nan=False).encode(), b"", [])


def generate_part(request: dict, output_dir: Path) -> dict:
    """Write the source recipe and a checked STL (plus STEP for CadQuery-native parts).

    Axes: +x forward, +y left, +z up. Rail ports refer to the bottom-centre
    route datum. Meshes keep assembly coordinates. Brick parts are
    built from a sewn triangle mesh, so a STEP of them would only be a faceted copy.
    """
    request, build, model = _validate(request)
    canonical = json.dumps(request, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()
    source_bytes = _read(Path(model.__file__))
    dependencies = [(path.name, _read(path)) for path in source_dependencies(request)]
    request_digest = _fingerprint(canonical, source_bytes, dependencies)
    mesh_derived = "connector_version" in request["parameters"] or request["family"] in _MESH_FAMILIES
    shape = build(request["parameters"])
    if not shape.isValid() or len(shape.Solids()) != 1 or shape.Volume() <= 0:
        raise ValueError("CAD model must be one valid solid")
    # OCC enlarges cached bounding boxes after tessellation; capture analytic
    # extents before STL export and validate both exports against those extents.
    expected_bounds = source_bounds(shape)

    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    stem = f"{request['family']}-{request['part_revision']}-{request_digest[:16]}"
    suffixes = ("stl", "py", "json") if mesh_derived else ("stl", "step", "py", "json")
    targets = {suffix: output_dir / f"{stem}.{suffix}" for suffix in suffixes}
    for name, _ in dependencies:
        targets[name] = output_dir / f"{stem}.{name}"
    # Multi-material parts (flexible track): one STL per material, in the part frame, beside the whole-part STL.
    materials = model.materials(request["parameters"]) if hasattr(model, "materials") else []
    for role, _, _ in materials:
        targets[f"{role}.stl"] = output_dir / f"{stem}.{role}.stl"
    if any(path.exists() or path.is_symlink() for path in targets.values()):
        raise FileExistsError(f"CAD artifact already exists: {stem}")
    with tempfile.TemporaryDirectory(prefix=".cad-", dir=output_dir) as temp_name:
        temp = Path(temp_name)
        stl = temp / f"{stem}.stl"
        step = None if mesh_derived else temp / f"{stem}.step"
        cq.exporters.export(shape, str(stl), exportType="STL", tolerance=brick_end.STL_TOLERANCE,
                            angularTolerance=brick_end.STL_ANGULAR_TOLERANCE)
        if step is not None:
            cq.exporters.export(shape, str(step), exportType="STEP")
        bounds = verify(shape, stl, step, request["printer_envelope"], expected_bounds)
        (temp / f"{stem}.py").write_bytes(source_bytes)
        for name, content in dependencies:
            (temp / targets[name].name).write_bytes(content)
        (temp / f"{stem}.json").write_bytes(canonical + b"\n")
        for role, _, material in materials:
            path = temp / targets[f"{role}.stl"].name
            material.export(path)
            exported = trimesh.load_mesh(path, file_type="stl", process=True)
            if not exported.is_watertight or exported.volume <= 0:
                raise ValueError(f"{role} material mesh is not closed")
        mesh_digest = hashlib.sha256(stl.read_bytes()).hexdigest()
        for suffix, target in targets.items():
            (temp / target.name).rename(target)
    parameters = request["parameters"]
    return {
        "family": request["family"], "part_revision": request["part_revision"],
        "layout_revision": request["layout_revision"], "source": str(targets["py"]),
        "source_dependencies": [str(targets[name]) for name, _ in dependencies],
        "request": str(targets["json"]), "mesh": str(targets["stl"]),
        "step": str(targets["step"]) if "step" in targets else None, "digest": mesh_digest,
        "request_digest": request_digest, "bounds": bounds, "ports": _ports(request),
        "mounting_interface": ({"position": [0, 0, parameters["height"]]}
                               if request["family"] in ("reversible_column", riser.FAMILY) else
                               {"position": [parameters["reach"], 0, parameters["height"]]}
                               if request["family"] == "anchored_bracket" else None),
        **({"materials": [{"role": role, "filament": filament, "mesh": str(targets[f"{role}.stl"])}
                          for role, filament, _ in materials]} if materials else {}),
    }


def mesh_ports(ends: list[dict]) -> list[dict]:
    """A community piece's two rail ports from its marked ends (`MeshEnd`, src/domain/pieces/families/community.ts,
    whose heading points out of the piece), `ends[0]` the end it is laid from: in the mesh frame, at the mesh's
    underside (the route datum), level. The start port faces into the piece, the end port out of it."""
    ports = []
    for name, end, yaw in (("start", ends[0], ends[0]["heading"] + math.pi), ("end", ends[1], ends[1]["heading"])):
        yaw = math.atan2(math.sin(yaw), math.cos(yaw))
        ports.append({"id": name, "position": [float(end["x"]), float(end["y"]), 0.],
                      "tangent": [math.cos(yaw), math.sin(yaw), 0.], "heading": yaw, "pitch": 0.,
                      "rail_gauge": None, "rail_interface_width": None})
    return ports


def mesh_part(request: dict, data: bytes, entry: dict, output_dir: Path) -> dict:
    """A community piece's part (KTD9, R20): its uploaded STL written byte for byte, never regenerated, once it is
    checked to be the file `request` names (sha256) and one closed solid within the printer. `entry`, its library
    index entry, is kept beside it as its source. Its ports depend on which end it is laid from (`mesh_ports`)."""
    request = _validate_mesh(request)
    if hashlib.sha256(data).hexdigest() != request["mesh"]["digest"]:
        raise ValueError("community mesh does not match its digest")
    mesh = trimesh.load_mesh(io.BytesIO(data), file_type="stl", process=True)
    if not isinstance(mesh, trimesh.Trimesh) or not mesh.is_watertight or mesh.volume <= 0:
        raise ValueError("community mesh must be one closed solid")
    low, high = mesh.bounds.tolist()
    bounds = {"min": low, "max": high, "size": [b - a for a, b in zip(low, high)]}
    if any(size > request["printer_envelope"][axis] + 1e-5 for size, axis in zip(bounds["size"], "xyz")):
        raise UserError(f"The community piece “{entry['name']}” is too large for the printer bed.")
    request_digest = _mesh_digest(request)
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    stem = f"{request['family']}-{request['part_revision']}-{request_digest[:16]}"
    contents = {"stl": data,
                "library.json": json.dumps(entry, sort_keys=True, indent=2, ensure_ascii=False, allow_nan=False).encode() + b"\n",
                "json": json.dumps(request, sort_keys=True, separators=(",", ":"), allow_nan=False).encode() + b"\n"}
    targets = {suffix: output_dir / f"{stem}.{suffix}" for suffix in contents}
    if any(path.exists() or path.is_symlink() for path in targets.values()):
        raise FileExistsError(f"CAD artifact already exists: {stem}")
    with tempfile.TemporaryDirectory(prefix=".mesh-", dir=output_dir) as temp_name:
        for suffix, content in contents.items():
            staged = Path(temp_name) / targets[suffix].name
            staged.write_bytes(content)
            staged.rename(targets[suffix])
    return {
        "family": request["family"], "part_revision": request["part_revision"],
        "layout_revision": request["layout_revision"], "source": str(targets["library.json"]),
        "source_dependencies": [], "request": str(targets["json"]), "mesh": str(targets["stl"]), "step": None,
        "digest": request["mesh"]["digest"], "request_digest": request_digest, "bounds": bounds, "ports": [],
        "mounting_interface": None,
    }
