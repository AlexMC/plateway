"""Source contacts stay rigid across families; fit changes never change the gauge."""

import math
from pathlib import Path

import numpy as np
import pytest
import trimesh

from cad.models import brick_end
from cad.service.generate import current_request_digest, generate_part


def _box(low, high):
    low, high = np.array(low), np.array(high)
    box = trimesh.creation.box(extents=high - low)
    box.apply_translation((low + high) / 2)
    return box


def request_for(family, extra):
    p = {"body_width": 63.8, "base_thickness": 3.2, "rail_gauge": 40,
         "rail_interface_width": 2.4, "rail_height": 6.4,
         "connector_version": 1, "fit_adjustment": 0, **extra}
    if family.startswith("bridge_"):
        p["deck_width"] = p.pop("body_width")
        p["deck_thickness"] = p.pop("base_thickness")
    return {"version": 1, "units": "mm", "family": family, "parameters": p,
            "printer_envelope": {"x": 256, "y": 256, "z": 256},
            "part_revision": "shared-end", "layout_revision": "geometry"}


@pytest.mark.parametrize("family,extra", [
    ("printed_straight", {"run": 80}),
    ("printed_straight", {"run": 80, "fit_adjustment": .15}),
    ("printed_curve", {"radius": 320, "sweep": .3}),
    ("printed_curve", {"radius": 320, "sweep": -.3}),
    ("printed_curve", {"radius": 320, "sweep": math.pi / 8}),
    ("vertical_transition", {"run": 80, "rise": 8, "start_grade": .05, "end_grade": .15}),
    ("vertical_transition", {"run": 80, "rise": -8, "start_grade": -.05, "end_grade": -.15}),
    ("vertical_transition", {"run": 80, "rise": 8, "start_grade": 0, "end_grade": 0}),
    ("vertical_transition", {"run": 80, "rise": -8, "start_grade": 0, "end_grade": 0}),
    ("bridge_deck", {"run": 80}),
    ("bridge_joint", {"joint_length": 24}),
])
def test_families_preserve_rigid_source_contacts_and_running_profile(tmp_path, family, extra):
    request = request_for(family, extra)
    result = generate_part(request, tmp_path)
    mesh = trimesh.load_mesh(result["mesh"], process=True)
    source = brick_end._adjust_contacts(brick_end.nominal_mesh(), request["parameters"]["fit_adjustment"])
    region = _box((-6, -32, -.1), (5.79, 32, 10))
    # Only requested brick-attachment zones may change: outer seats and the
    # studs standing on the source deck. Central source cavities, latch
    # undersides and all rail mating contacts remain exact.
    attachment = brick_end.PROFILE["brickAttachment"]
    attachment_zones = trimesh.boolean.union([
        _box((.099, low, -.01), (5.8, high, 3.2))
        for low, high in ((-31.9, -23.95), (23.95, 31.9))
    ] + [
        _box((0, low, 3.2), (5.8, high, 6))
        for low, high in ((-31.9, -23.95), (23.95, 31.9))
    ] + [
        _box((4 - 2.45, y - 2.45, 3.2), (4 + 2.45, y + 2.45, 4.9))
        for y in attachment["studLateralOffsets"]
    ], engine="manifold")
    region = trimesh.boolean.difference([region, attachment_zones], engine="manifold")
    opposite = source.copy()
    opposite.apply_transform([[-1, 0, 0, 24], [0, -1, 0, 0],
                              [0, 0, 1, 0], [0, 0, 0, 1]])
    expected_ends = [trimesh.boolean.intersection([end, region], engine="manifold")
                     for end in (source, opposite)]
    p = request["parameters"]
    sweep = p.get("sweep", 0)
    run = (p["radius"] * math.sin(abs(sweep)) if family == "printed_curve"
           else p.get("run", p.get("joint_length")))
    end_y = math.copysign(p["radius"] * (1 - math.cos(sweep)), sweep) if sweep else 0
    positions = [(0, 0, 0), (run, end_y, p.get("rise", 0))]
    grades = [p.get("start_grade", 0), p.get("end_grade", 0)]
    assert len(result["ports"]) == 2
    for index, port in enumerate(result["ports"]):
        expected = expected_ends[index]
        heading, pitch = (sweep if index else 0), math.atan(grades[index])
        assert port["position"] == pytest.approx(positions[index])
        assert port["heading"] == pytest.approx(heading)
        assert port["pitch"] == pytest.approx(pitch)
        ch, sh, cp, sp = math.cos(heading), math.sin(heading), math.cos(pitch), math.sin(pitch)
        # Independent rigid frame checks the exported contacts against the
        # requested ports, rather than undoing the model's own frame helper.
        transform = np.array([[ch * cp, -sh, -ch * sp, positions[index][0]],
                              [sh * cp, ch, -sh * sp, positions[index][1]],
                              [sp, 0, cp, positions[index][2]], [0, 0, 0, 1]])
        assert port["tangent"] == pytest.approx(transform[:3, 0])
        if index:
            transform = transform @ np.diag([-1, -1, 1, 1])
        local = mesh.copy()
        local.apply_transform(np.linalg.inv(transform))
        contacts = trimesh.boolean.intersection([local, region], engine="manifold")
        assert trimesh.boolean.difference([expected, contacts], engine="manifold").volume < .002
        assert trimesh.boolean.difference([contacts, expected], engine="manifold").volume < .002
    assert mesh.is_watertight and len(mesh.split(only_watertight=False)) == 1

    heading, grade = 0, 0
    if family == "printed_curve":
        radius, heading = p["radius"], p["sweep"] / 2
        middle = (radius * math.sin(abs(heading)), math.copysign(radius * (1 - math.cos(heading)), heading), 0)
    elif family == "vertical_transition":
        run, rise, g0, g1 = (p[k] for k in ("run", "rise", "start_grade", "end_grade"))
        middle = (run / 2, 0, rise / 2 + run * (g0 - g1) / 8)
        grade = 1.5 * rise / run - .25 * (g0 + g1)
    else:
        middle = (p.get("run", p.get("joint_length")) / 2, 0, 0)
    central = mesh.copy()
    central.apply_transform(np.linalg.inv(brick_end._frame(middle, heading, grade)))
    section = trimesh.boolean.intersection(
        [central, _box((-.01, -33, -1), (.01, 33, 11))], engine="manifold")
    length = (p["radius"] * abs(p["sweep"]) if family == "printed_curve"
              else p.get("run", p.get("joint_length")))
    middle_is_tie = any(low < length / 2 < high for low, high in brick_end.tie_intervals(
        length, equal_pitch=brick_end.is_official_curve(p, family)))
    half_width = 31.9 if middle_is_tie else 23.9
    assert section.bounds[:, 1] == pytest.approx([-half_width, half_width], abs=.002)
    assert section.bounds[:, 2] == pytest.approx([0, 9.6], abs=.002)
    base = trimesh.boolean.intersection(
        [central, _box((-.01, 9, -1), (.01, 11, 3.1))], engine="manifold")
    if middle_is_tie:
        assert base.bounds[:, 2] == pytest.approx([attachment["cavityDepth"], 3.1], abs=.002)
    else:
        assert len(base.faces) == 0
    for lateral in (-20, 20):
        crown = trimesh.boolean.intersection(
            [central, _box((-.01, lateral - 3, 9.3), (.01, lateral + 3, 9.5))], engine="manifold")
        assert crown.bounds[:, 1] == pytest.approx([lateral - 1.2, lateral + 1.2], abs=.002)
        foot = trimesh.boolean.intersection(
            [central, _box((-.01, lateral - 4, 3.4), (.01, lateral + 4, 3.6))], engine="manifold")
        assert foot.bounds[:, 1] == pytest.approx([lateral - 3, lateral + 3], abs=.002)


@pytest.mark.parametrize("field,value", [
    ("run", 23.9), ("rail_gauge", 39.9), ("rail_interface_width", 2.5),
    ("body_width", 64), ("base_thickness", 3.4), ("rail_height", 6.5),
    ("connector_version", 2), ("fit_adjustment", .151),
])
def test_shared_profile_rejects_incompatible_dimensions(tmp_path, field, value):
    request = request_for("printed_straight", {"run": 80})
    request["parameters"][field] = value
    with pytest.raises(ValueError):
        generate_part(request, tmp_path)
    assert not list(tmp_path.iterdir())


@pytest.mark.parametrize("attribute", ["PROFILE_PATH", "REFERENCE_STL", "RAIL_REFERENCE_STL", "__file__"])
def test_production_receipt_binds_transitive_connector_inputs(tmp_path, monkeypatch, attribute):
    request = request_for("printed_straight", {"run": 80})
    before = current_request_digest(request)
    original = Path(getattr(brick_end, attribute))
    changed = tmp_path / original.name
    changed.write_bytes(original.read_bytes() + b"\n")
    monkeypatch.setattr(brick_end, attribute, changed)
    assert current_request_digest(request) != before


def test_local_blends_leave_exact_circular_and_hermite_centres():
    for family, extra in [
        ("printed_curve", {"radius": 320, "sweep": -.3}),
        ("vertical_transition", {"run": 80, "rise": -8, "start_grade": -.05, "end_grade": -.15}),
    ]:
        p = request_for(family, extra)["parameters"]
        if family == "printed_curve":
            radius, sweep = p["radius"], p["sweep"]
            length = radius * abs(sweep)
            endpoint = (radius * math.sin(abs(sweep)), math.copysign(radius * (1 - math.cos(sweep)), sweep), 0)
        else:
            length, sweep = p["run"], 0
            endpoint = (length, 0, p["rise"])
        start = brick_end._frame((0, 0, 0), 0, p.get("start_grade", 0))
        end = brick_end._frame(endpoint, sweep, p.get("end_grade", 0))
        wire, bound = brick_end._centre_path(p, family, start, end, length)
        assert 0 < bound < .4
        checked = 0
        for edge in wire.Edges():
            point = edge.positionAt(.5)
            if 24 < point.x < endpoint[0] - 24:
                checked += 1
                if family == "printed_curve":
                    assert math.hypot(point.x, point.y + radius) == pytest.approx(radius, abs=1e-6)
                else:
                    t = point.x / length
                    expected = ((t**3 - 2*t*t + t)*length*p["start_grade"]
                                + (-2*t**3 + 3*t*t)*p["rise"]
                                + (t**3 - t*t)*length*p["end_grade"])
                    assert point.z == pytest.approx(expected, abs=1e-6)
        assert checked == 1


def test_standard_straight_has_source_width_ties_and_through_openings(tmp_path):
    result = generate_part(request_for("printed_straight", {"run": 160}), tmp_path)
    mesh = trimesh.load_mesh(result["mesh"], process=True)
    # Longitudinal section away from rails and source underside stud cavities.
    segments = trimesh.intersections.mesh_plane(mesh, [0, 1, 0], [0, 10, 0])
    crossings = []
    for a, b in segments:
        if (a[2] < 3.1 < b[2]) or (b[2] < 3.1 < a[2]):
            crossings.append(a[0] + (b[0] - a[0]) * (3.1 - a[2]) / (b[2] - a[2]))
    crossings = np.unique(np.round(crossings, 3))
    # Exclude the rigid source contacts; their latches/cavities are checked
    # against the unchanged A/B meshes in the family regression above.
    inner = crossings[(crossings > brick_end.PROFILE["endLength"]) &
                      (crossings < 160 - brick_end.PROFILE["endLength"])]
    assert inner == pytest.approx([7.9, 24.1, 39.9, 56.1, 71.9,
                                   88.1, 103.9, 120.1, 135.9, 152.1], abs=.002)
    for low, high in [(7.9, 24.1), (39.9, 56.1), (71.9, 88.1),
                      (103.9, 120.1), (135.9, 152.1)]:
        for y in (-28, 0, 28):
            probe = _box((low + .01, y - 1, -.1), (high - .01, y + 1, 3.3))
            assert len(trimesh.boolean.intersection([mesh, probe], engine="manifold").faces) == 0
        for y in (-20, 20):
            # Hollow stringer: 1.2 mm walls, open to z=2.2 between them and
            # to the rail foot (z=3.2) over the central 4 mm.
            for wall in (y - 3.25, y + 3.25):
                probe = _box((low + .01, wall - .55, .01), (high - .01, wall + .55, 3.19))
                retained = trimesh.boolean.intersection([mesh, probe], engine="manifold")
                assert retained.volume == pytest.approx(probe.volume, abs=.002)
            for half, top in ((2.65, 2.19), (1.95, 3.19)):
                probe = _box((low + .01, y - half, -.1), (high - .01, y + half, top))
                assert len(trimesh.boolean.intersection([mesh, probe], engine="manifold").faces) == 0
    # One 1.2 mm cross-web per full tie closes the channel at its centre;
    # the end-tie inner wall closes it at each end.
    for centre in (32, 64, 96, 128):
        for y in (-20, 20):
            web = _box((centre - .55, y - 2.6, .01), (centre + .55, y + 2.6, 3.19))
            assert trimesh.boolean.intersection([mesh, web], engine="manifold").volume == pytest.approx(
                web.volume, abs=.002)
            open_side = _box((centre + .65, y - 2.6, -.1), (centre + 7.8, y + 2.6, 2.19))
            assert len(trimesh.boolean.intersection([mesh, open_side], engine="manifold").faces) == 0
    for low, high in ((6.41, 7.89), (152.11, 153.59)):
        wall = _box((low, 17.4, .01), (high, 22.6, 3.19))
        assert trimesh.boolean.intersection([mesh, wall], engine="manifold").volume == pytest.approx(
            wall.volume, abs=.002)
    assert mesh.is_watertight and len(mesh.split(only_watertight=False)) == 1


@pytest.mark.parametrize("family,extra,gap", [
    ("bridge_joint", {"joint_length": 24}, (7.9, 16.1)),
    ("printed_straight", {"run": 80}, (7.9, 32.1)),
])
def test_nonmodular_runs_keep_full_depth_openings_without_stretching_ties(
        tmp_path, family, extra, gap):
    result = generate_part(request_for(family, extra), tmp_path)
    mesh = trimesh.load_mesh(result["mesh"], process=True)
    opening = _box((gap[0] + .01, -10, -.1), (gap[1] - .01, 10, 3.3))
    assert len(trimesh.boolean.intersection([mesh, opening], engine="manifold").faces) == 0
    for edge, direction in ((gap[0], -1), (gap[1], 1)):
        point = edge + direction * .05
        probe = _box((point - .01, 9, 2.9), (point + .01, 11, 3.1))
        assert trimesh.boolean.intersection([mesh, probe], engine="manifold").volume == pytest.approx(
            probe.volume, abs=.0001)
    assert mesh.is_watertight and len(mesh.split(only_watertight=False)) == 1


@pytest.mark.parametrize("side", [-1, 1])
def test_r56_curve_has_radial_source_width_ties_and_half_ends(tmp_path, side):
    radius, angle = 448, math.pi / 8
    result = generate_part(request_for(
        "printed_curve", {"radius": radius, "sweep": side * angle}), tmp_path)
    mesh = trimesh.load_mesh(result["mesh"], process=True)
    segments = trimesh.intersections.mesh_plane(mesh, [0, 0, 1], [0, 0, 3.1])
    origin = np.array([0, side * radius])
    crossings = []
    for a, b in segments[:, :, :2]:
        vector, relative = b - a, a - origin
        for fraction in np.roots([vector @ vector, 2 * (relative @ vector),
                                  relative @ relative - radius * radius]):
            if abs(fraction.imag) < 1e-9 and 0 <= fraction.real <= 1:
                point = a + fraction.real * vector
                station = radius * math.atan2(point[0], radius - side * point[1])
                if 1 < station < radius * angle - 1:
                    crossings.append(station)
    crossings = np.unique(np.round(crossings, 3))
    assert crossings[0] == pytest.approx(7.9, abs=.002)
    assert crossings[-1] == pytest.approx(radius * angle - 7.9, abs=.002)
    assert len(crossings) == 10
    for low, high in zip(crossings[1:-1:2], crossings[2:-1:2]):
        assert high - low == pytest.approx(15.8, abs=.002)
    gaps = crossings[1::2] - crossings[::2]
    assert gaps == pytest.approx([16.2, 16.2, 32.1291886, 16.2, 16.2], abs=.002)
    assert mesh.is_watertight and len(mesh.split(only_watertight=False)) == 1


@pytest.mark.parametrize("side", [-1, 1])
def test_official_r40_curve_has_rigid_equal_angle_ties(tmp_path, side):
    """53400: three rigid 15.8 x 63.8 ties at 5.625 deg steps, not radial wedges."""
    radius, angle = 320, math.pi / 8
    mesh = trimesh.load_mesh(generate_part(request_for(
        "printed_curve", {"radius": radius, "sweep": side * angle}), tmp_path)["mesh"], process=True)
    assert mesh.is_watertight and len(mesh.split(only_watertight=False)) == 1
    for k in (1, 2, 3):
        theta = side * k * angle / 4
        local = mesh.copy()
        local.apply_transform(np.linalg.inv(brick_end._frame(
            (radius * math.sin(abs(theta)), side * radius * (1 - math.cos(theta)), 0), theta, 0)))
        for v in (-29.5, -10, 10, 29.5):
            # Straight tie edges at u=+/-7.9 at every lateral; a radial tie
            # would widen to +/-8.6 at the outer stud column.
            solid = _box((-7.85, v - .3, 2.3), (7.85, v + .3, 3.1))
            assert trimesh.boolean.intersection([local, solid], engine="manifold").volume == pytest.approx(
                solid.volume, abs=.002)
            for u in (-8.1, 8.1):
                gap = _box((u - .15, v - .3, -.1), (u + .15, v + .3, 3.3))
                assert len(trimesh.boolean.intersection([local, gap], engine="manifold").faces) == 0
        for u in (-4, 4):
            for v in brick_end.PROFILE["brickAttachment"]["studLateralOffsets"]:
                stud = trimesh.creation.cylinder(radius=2.39, height=1.49, sections=96)
                stud.apply_translation((u, v, 4.05))
                assert trimesh.boolean.intersection([local, stud], engine="manifold").volume == pytest.approx(
                    stud.volume, abs=.002)
    # End half ties are rigid 7.9 mm rectangles in their port frames (53400
    # s03/s04), not radial wedges spanning u 7.1..8.7.
    end = brick_end._frame((radius * math.sin(angle), side * radius * (1 - math.cos(angle)), 0),
                          side * angle, 0) @ np.diag([-1, -1, 1, 1])
    for frame in (brick_end._frame((0, 0, 0), 0, 0), end):
        local = mesh.copy()
        local.apply_transform(np.linalg.inv(frame))
        for v in (-31.5, -10, 10, 31.5):
            solid = _box((7.6, v - .3, 2.3), (7.85, v + .3, 3.1))
            assert trimesh.boolean.intersection([local, solid], engine="manifold").volume == pytest.approx(
                solid.volume, abs=.0005)
            gap = _box((7.95, v - .3, -.1), (8.2, v + .3, 3.3))
            assert len(trimesh.boolean.intersection([local, gap], engine="manifold").faces) == 0


def test_straight_seats_on_a_studded_baseplate(tmp_path):
    """Every baseplate stud under a grid-aligned straight clears solid material.

    Envelope: 1.8 mm tall (real studs are ~1.7 mm) and nominal 4.8 mm
    diameter less 0.005 mm facet tolerance. Designed clutch contacts (ribs,
    pins, bay walls) touch a real 4.9 mm stud by at most 0.055 mm.
    """
    mesh = trimesh.load_mesh(generate_part(request_for("printed_straight", {"run": 128}), tmp_path)["mesh"],
                             process=True)
    hits = []
    for x in range(4, 128, 8):
        for y in (-28, -20, -12, -4, 4, 12, 20, 28):
            stud = trimesh.creation.cylinder(radius=2.395, height=1.9, sections=192)
            stud.apply_translation((x, y, .85))
            hit = trimesh.boolean.intersection([mesh, stud], engine="manifold")
            if len(hit.faces) and hit.volume > 1e-5:
                hits.append((x, y, hit.volume))
    assert hits == []



@pytest.mark.parametrize("family,extra", [
    ("printed_straight", {"run": 80}),
    ("printed_curve", {"radius": 320, "sweep": .3}),
    ("printed_curve", {"radius": 320, "sweep": -.3}),
    ("vertical_transition", {"run": 80, "rise": 8, "start_grade": .05, "end_grade": .15}),
    ("vertical_transition", {"run": 80, "rise": -8, "start_grade": -.05, "end_grade": -.15}),
    ("vertical_transition", {"run": 80, "rise": 8, "start_grade": 0, "end_grade": 0}),
    ("vertical_transition", {"run": 80, "rise": -8, "start_grade": 0, "end_grade": 0}),
    ("bridge_deck", {"run": 80}),
    ("bridge_joint", {"joint_length": 24}),
])
def test_brick_clutch_has_clear_insertion_roofs_ribs_and_pins(tmp_path, family, extra):
    result = generate_part(request_for(family, extra), tmp_path)
    mesh = trimesh.load_mesh(result["mesh"], process=True)
    assert mesh.is_watertight and len(mesh.split(only_watertight=False)) == 1

    def cylinder(x, y, radius, low, high):
        shape = trimesh.creation.cylinder(radius=radius, height=high - low, sections=96)
        shape.apply_translation((x, y, (low + high) / 2))
        return shape

    def retained(local, probe):
        intersection = trimesh.boolean.intersection([local, probe], engine="manifold")
        assert intersection.volume == pytest.approx(probe.volume, abs=.002)

    # Independent port frame; a half tie seats a one-row brick/plate.
    first = mesh.copy()
    first.apply_transform(np.linalg.inv(brick_end._frame(
        (0, 0, 0), 0, extra.get("start_grade", 0))))
    frames = [(first, [4], False)]
    if family != "bridge_joint":
        if family == "printed_curve":
            angle = math.copysign(32 / extra["radius"], extra["sweep"])
            point = (extra["radius"] * math.sin(abs(angle)),
                     math.copysign(extra["radius"] * (1 - math.cos(angle)), angle), 0)
            frame = brick_end._frame(point, angle, 0)
        elif family == "vertical_transition":
            run, rise = extra["run"], extra["rise"]
            g0, g1 = extra["start_grade"], extra["end_grade"]
            frame = brick_end._frame((run / 2, 0, rise / 2 + run * (g0 - g1) / 8),
                                    0, 1.5 * rise / run - .25 * (g0 + g1))
        else:
            frame = brick_end._frame((extra["run"] / 2, 0, 0), 0, 0)
        local = mesh.copy()
        local.apply_transform(np.linalg.inv(frame))
        frames.append((local, [-4, 4], True))
    attachment = brick_end.PROFILE["brickAttachment"]
    columns, depth = attachment["studLateralOffsets"], attachment["cavityDepth"]
    assert sorted(columns) == [-28, -12, -4, 4, 12, 28]
    for local, rows, full in frames:
        # The mating plate's flat body must seat as well as its studs.
        body = _box((-7.9 if full else .1, -31.9, -3.2), (7.9, 31.9, 0))
        assert trimesh.boolean.intersection([local, body], engine="manifold").volume < .002
        for y in columns:
            # The accepted coupon keeps its centre tab (x 5.06..5.85,
            # |y| <= 1.02, up to z 6.2) beside the +/-4 half-tie studs; it is
            # checked unchanged with the source contacts above.
            low = (brick_end.PROFILE["endLength"] + .05 if abs(y) < 8 else .1) if not full else -7.9
            upper_body = _box((low, y - 3.9, 3.2), (7.9, y + 3.9, 4.8))
            upper_body = trimesh.boolean.difference(
                [upper_body, *(cylinder(x, y, 2.4, 3.1, 4.9) for x in rows)],
                engine="manifold")
            assert trimesh.boolean.intersection(
                [local, upper_body], engine="manifold").volume < .002
        for x in rows:
            for y in columns:
                # Full nominal stud envelope, not just a centre point. The
                # protected coupon's lobe/socket posts graze the half-tie
                # +/-4/+/-12 envelopes by 0.0034 mm radially.
                radius = 2.4 if full or abs(y) == 28 else 2.39
                insertion = cylinder(x, y, radius, .01, depth - .01)
                assert trimesh.boolean.intersection(
                    [local, insertion], engine="manifold").volume < .002
                retained(local, cylinder(x, y, 2.39, 3.3, 4.79))
                collar = trimesh.boolean.intersection([
                    local, _box((x - 2.9, y - 2.9, 3.4), (x + 2.9, y + 2.9, 4.7))
                ], engine="manifold")
                assert collar.bounds[:, :2] == pytest.approx(
                    np.array([[x - 2.4, y - 2.4], [x + 2.4, y + 2.4]]), abs=.002)
                if full or abs(y) == 28:
                    retained(local, _box((x - .3, y - .3, depth + .01), (x + .3, y + .3, 2.9)))
            for y in (-28, 28):
                rib_y = 24.8 if y > 0 else -24.8
                retained(local, _box((x - .7, rib_y - .7, .01),
                                     (x + .7, rib_y + .7, depth - .01)))
            if full:
                for y in (-15.2, 15.2):
                    retained(local, _box((x - .7, y - .7, .01), (x + .7, y + .7, depth - .01)))
        if full:
            for y in (-28, 28):
                retained(local, cylinder(0, y, 1.59, .01, depth - .01))
                # Both longitudinal walls and the outer side wall survive.
                for x in (-7, 7):
                    retained(local, _box((x - .1, y - .1, .5), (x + .1, y + .1, 1.5)))
                outside = 31 if y > 0 else -31
                retained(local, _box((-.1, outside - .1, .5), (.1, outside + .1, 1.5)))


def test_curves_reject_a_clutch_cavity_that_breaks_approved_tie_walls(tmp_path):
    with pytest.raises(ValueError, match="brick cavity would break"):
        generate_part(request_for("printed_curve", {"radius": 100, "sweep": 1}), tmp_path)
