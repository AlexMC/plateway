import math

import manifold3d
import numpy as np
import pytest

from cad.models import composite, rack

SHARED = {"connector_version": 1, "fit_adjustment": 0., "body_width": 63.8, "base_thickness": 3.2, "rail_gauge": 40,
          "rail_interface_width": 2.4, "rail_height": 6.4}


def request(length=128., grade0=0., grade1=0., rise=0., vcurve=0., k=0., **extra):
    p = {**SHARED, "segments": 1, "s0_len": length, "s0_k0": k, "s0_k1": k, "z0": 0., "z1": rise, "grade0": grade0,
         "grade1": grade1, "vcurve": vcurve, "cant0": 0., "cant1": 0., "ends": 3}

    def z(s):
        t = np.asarray(s, float) / length
        return (t**3 - 2*t*t + t) * length * grade0 + (-2*t**3 + 3*t*t) * rise + (t**3 - t*t) * length * grade1
    run = float(rack.arc3d(z, length, [length])[0])
    pitch = run / round(run / rack.PITCH)
    return {**p, "rack": 1, "rack_pitch": pitch, "rack_phase": pitch / 2, "rack_in": 0., "rack_out": 0., **extra}


def _manifold(mesh):
    return manifold3d.Manifold(manifold3d.Mesh(np.float32(mesh.vertices), np.uint32(mesh.faces)))


def _teeth_at(mesh, z):
    """Tooth cross-sections (centroid x) cut at height z inside the rack band."""
    band = _manifold(mesh) ^ manifold3d.Manifold.cube((400, 2 * rack.TOOTH_HALF - .2, 40)).translate((-50, -rack.TOOTH_HALF + .1, 0))
    pieces = band.slice(z).decompose()
    return sorted(float(np.mean(np.vstack(piece.to_polygons())[:, 0])) for piece in pieces)


def test_level_rack_is_one_solid_with_whole_rack_pitch_teeth_below_the_rail_tops():
    mesh = composite.track_mesh(request())
    assert mesh.is_watertight and mesh.body_count == 1
    teeth = _teeth_at(mesh, rack.ROOT_Z + .5)
    assert len(teeth) == 40
    assert np.allclose(np.diff(teeth), 3.2, atol=.01)
    assert teeth[0] == pytest.approx(1.6, abs=.01) and teeth[-1] == pytest.approx(128 - 1.6, abs=.01)
    centre = mesh.vertices[np.abs(mesh.vertices[:, 1]) < rack.TOOTH_HALF + .01]
    assert centre[:, 2].max() == pytest.approx(rack.TIP_Z, abs=.01) and rack.TIP_Z < composite.end_.RAIL_TOP


def test_entry_taper_lowers_the_first_teeth_and_the_cut_parts_keep_spacing():
    tapered = composite.track_mesh(request(rack_in=rack.TAPER))
    assert len(_teeth_at(tapered, rack.TIP_Z - .2)) < len(_teeth_at(tapered, rack.ROOT_Z + .3)) == 40
    # A bed cut at 50 mm: the second part starts mid-spacing and carries the parent's phase.
    pitch = 3.2
    second = request(78., rack_phase=(1.6 - 50) % pitch, rack_pitch=pitch)
    teeth = _teeth_at(composite.track_mesh(second), rack.ROOT_Z + .5)
    assert np.allclose(np.array(teeth) + 50, 1.6 + pitch * np.round((np.array(teeth) + 50 - 1.6) / pitch), atol=.02)


def test_rack_climbs_to_twenty_percent_only_and_rejects_the_centre_options():
    slope = request(256., .2, .2, rise=51.2)
    mesh = composite.track_mesh(slope)
    assert mesh.is_watertight and mesh.body_count == 1
    with pytest.raises(ValueError, match="20 %"):
        composite.validate(request(256., .21, .21, rise=53.76))
    with pytest.raises(ValueError, match="6 %"):
        composite.validate({key: value for key, value in slope.items() if not key.startswith("rack")})
    for extra in ({"street": 1}, {"marker": 3, "marker_s": 64.}):
        with pytest.raises(ValueError, match="centre"):
            composite.validate(request(**extra))
    with pytest.raises(ValueError, match="rack = 1"):
        composite.validate({**request(), "rack": 0})


def test_cog_meshes_the_rack_without_interference_on_the_printed_part_and_on_vertical_curves():
    probe = rack.probe_mesh()
    assert probe["interference_mm2"] == 0 and probe["flank_clearance_mm"] >= .05
    assert probe["tip_clearance_mm"] == pytest.approx(.25 * rack.MODULE, abs=1e-6)
    for row in (rack.probe_vertical_curve(1280., False), rack.probe_vertical_curve(1280., True)):
        assert row["tip_clearance_mm"] > .05
    mesh = composite.track_mesh(request())
    for k in (4, 20, 30):
        assert rack.probe_bogie_on_rack(mesh, 1.6 + 3.2 * k) == {"frame_mm3": 0., "cog_mm3": 0.}


def test_cog_bogie_parts_are_single_bed_sized_solids_clear_of_plain_track():
    for part in (0, 1):
        mesh = rack.mesh({"part": part})
        assert mesh.is_watertight and mesh.body_count == 1 and mesh.bounds[0, 2] == pytest.approx(0, abs=1e-6)
        assert (mesh.bounds[1] - mesh.bounds[0]).max() < 170
    clear = rack.probe_clearances()
    assert clear["cog_tip_above_stud_tops_mm"] > 2 and clear["cheek_above_stud_tops_mm"] > 1.5
    assert clear["rack_tip_below_rail_top_mm"] >= .4 and clear["rack_to_flange_corridor_mm"] > 10
    with pytest.raises(ValueError):
        rack.validate({"part": 2})
