"""Source-profile rails, preserved fitted contacts, and no integral print aids."""

import copy
import hashlib
import json
from pathlib import Path

import manifold3d
import numpy as np
import pytest
import trimesh

from cad.models import brick_end
from cad.generate_preview import OUTPUT as PREVIEW_PATH, source_digest
from cad.service.generate import current_request_digest, generate_part


@pytest.fixture
def brick_request():
    return {
        "version": 1, "units": "mm", "family": "brick_end_coupon",
        "parameters": {"body_length": 24, "connector_version": 1, "fit_adjustment": 0},
        "printer_envelope": {"x": 256, "y": 256, "z": 250},
        "part_revision": "connector-v1", "layout_revision": "calibration",
    }


def _box(low, high):
    low, high = np.array(low), np.array(high)
    box = trimesh.creation.box(extents=high - low)
    box.apply_translation((low + high) / 2)
    return box


def test_integral_print_aids_are_absent_without_reshaping_fitted_contacts(tmp_path, brick_request):
    original = trimesh.load_mesh(brick_end.REFERENCE_STL, process=True)
    result = generate_part(brick_request, tmp_path)
    actual = trimesh.load_mesh(result["mesh"], process=True)
    reliefs = [_box((-6, 16.45, -.2), (-.3, 26.65, 3.4)),
               _box((24.3, -26.65, -.2), (30, -16.45, 3.4)),
               _box((-6, -24.6, -.2), (-.3, -14.4, 2.1)),
               _box((24.3, 14.4, -.2), (30, 24.6, 2.1))]
    for relief in reliefs:
        assert trimesh.boolean.intersection([actual, relief], engine="manifold").volume < .001
    # Apart from removing the sacrificial feet, the entire mating ends must
    # retain their accepted shape. The centre latches/marks also stay intact.
    expected_contacts = trimesh.boolean.difference([original, *reliefs], engine="manifold")
    for region in (
        _box((-6, -32, -.2), (5.79, 32, 10)),
        _box((18.21, -32, -.2), (30, 32, 10)),
        _box((-6, -16.4, -.2), (30, 16.4, 10)),
        _box((5.8, -32, -.2), (18.2, 32, 3.19)),
    ):
        before = trimesh.boolean.intersection([expected_contacts, region], engine="manifold")
        after = trimesh.boolean.intersection([actual, region], engine="manifold")
        assert trimesh.boolean.difference([before, after], engine="manifold").volume < .001
        assert trimesh.boolean.difference([after, before], engine="manifold").volume < .001
    assert actual.is_watertight and actual.is_winding_consistent
    assert len(actual.split(only_watertight=False)) == 1
    assert np.allclose(actual.bounds, [[-3.7, -31.9, 0], [27.7, 31.9, 9.6]], atol=.001)
    assert result["ports"] == []
    dependency_hashes = {hashlib.sha256(Path(path).read_bytes()).hexdigest()
                         for path in result["source_dependencies"]}
    assert brick_end.PROFILE["provenance"]["connectorSourceSha256"] in dependency_hashes
    assert brick_end.PROFILE["provenance"]["railSourceSha256"] in dependency_hashes


def test_centre_running_rails_match_supplied_stl_profile(tmp_path, brick_request):
    actual = trimesh.load_mesh(generate_part(brick_request, tmp_path)["mesh"], process=True)
    reference = trimesh.load_mesh(brick_end.REFERENCE_STL.parent / "rerailer_straight_full.stl")
    # Source x=8 has the straight profile, before the rerailing ramp. Translate
    # it onto the coupon centre; compare both crowns, stems and sloped shoulders.
    reference.apply_transform([[0, -1, 0, 8], [1, 0, 0, 0],
                               [0, 0, 1, 0], [0, 0, 0, 1]])
    for lateral in (-20, 20):
        region = _box((11.9, lateral - 3, 3.3), (12.1, lateral + 3, 10))
        expected = trimesh.boolean.intersection([reference, region], engine="manifold")
        rail = trimesh.boolean.intersection([actual, region], engine="manifold")
        assert trimesh.boolean.difference([expected, rail], engine="manifold").volume < .001
        assert trimesh.boolean.difference([rail, expected], engine="manifold").volume < .001
        crown = trimesh.boolean.intersection(
            [actual, _box((11.9, lateral - 3, 9.3), (12.1, lateral + 3, 9.5))],
            engine="manifold")
        assert crown.bounds[1][1] - crown.bounds[0][1] == pytest.approx(2.4, abs=.001)


@pytest.mark.parametrize("adjustment", [-.15, .15])
def test_fit_offsets_only_contact_material_and_keeps_profile(tmp_path, brick_request, adjustment):
    request = copy.deepcopy(brick_request)
    request["parameters"]["fit_adjustment"] = adjustment
    result = generate_part(request, tmp_path)
    actual = trimesh.load_mesh(result["mesh"], process=True)
    nominal = brick_end.nominal_mesh()
    smaller, larger = (actual, nominal) if adjustment > 0 else (nominal, actual)
    assert trimesh.boolean.difference([smaller, larger], engine="manifold").volume < .001
    difference = trimesh.boolean.difference([larger, smaller], engine="manifold")
    assert 40 < difference.volume < 100
    masks = []
    for lateral in (-20, 20):
        mask = _box((-4, lateral - 3.2, 2.09), (4.121, lateral + 3.2, 9.61))
        opposite = mask.copy()
        opposite.apply_transform([[-1, 0, 0, 24], [0, -1, 0, 0],
                                  [0, 0, 1, 0], [0, 0, 0, 1]])
        masks.extend((mask, opposite))
    assert trimesh.boolean.difference([difference, *masks], engine="manifold").volume < .001
    assert actual.is_watertight and len(actual.split(only_watertight=False)) == 1
    assert np.allclose(actual.bounds, nominal.bounds, atol=.001)
    assert result["request_digest"] != current_request_digest(brick_request)


def test_changed_baseline_invalidates_saved_receipts(tmp_path, monkeypatch, brick_request):
    digest = current_request_digest(brick_request)
    replacement = tmp_path / "changed.stl"
    replacement.write_bytes(brick_end.REFERENCE_STL.read_bytes() + b"\n")
    monkeypatch.setattr(brick_end, "REFERENCE_STL", replacement)
    assert current_request_digest(brick_request) != digest


@pytest.mark.parametrize("parameters", [
    {"body_length": 32, "connector_version": 1, "fit_adjustment": 0},
    {"body_length": 24, "connector_version": 2, "fit_adjustment": 0},
    {"body_length": 24, "connector_version": 1, "fit_adjustment": -.151},
    {"body_length": 24, "connector_version": 1, "fit_adjustment": .151},
    {"body_length": 24, "under_rail_height": 3.4},
])
def test_rejects_unsupported_connector_geometry(tmp_path, brick_request, parameters):
    brick_request["parameters"] = parameters
    with pytest.raises(ValueError):
        generate_part(brick_request, tmp_path)
    assert not list(tmp_path.iterdir())


@pytest.mark.parametrize("opposite", [False, True])
def test_editor_preview_retains_production_contacts_and_projected_silhouette(opposite):
    data = json.loads(PREVIEW_PATH.read_text())
    geometry = data["opposite"] if opposite else data
    preview = trimesh.Trimesh(np.asarray(geometry["positions"]).reshape(-1, 3),
                             np.asarray(geometry["indices"]).reshape(-1, 3), process=True)
    source = brick_end._mesh(brick_end.track(
        {"connector_version": 1, "fit_adjustment": 0, "joint_length": 24}, "bridge_joint"))
    if opposite:
        source.apply_transform([[-1, 0, 0, 24], [0, -1, 0, 0],
                                [0, 0, 1, 0], [0, 0, 0, 1]])
    nominal = trimesh.boolean.intersection(
        [source, _box((-6, -33, -1), (7.95, 33, 11))], engine="manifold")
    assert preview.is_watertight and preview.is_winding_consistent
    assert len(preview.split(only_watertight=False)) == 1
    assert preview.bounds == pytest.approx(np.array([[-3.7, -31.9, 0], [7.95, 31.9, 9.6]]), abs=.001)
    for before, after in ((nominal, preview), (preview, nominal)):
        assert abs(trimesh.boolean.difference([before, after], engine="manifold").volume) < .001
    solid = manifold3d.Manifold(manifold3d.Mesh(np.float32(nominal.vertices), np.uint32(nominal.faces)))
    expected = manifold3d.CrossSection(solid.project().to_polygons(), manifold3d.FillRule.Positive)
    actual = manifold3d.CrossSection([np.asarray(loop) for loop in geometry["outlines"]],
                                    manifold3d.FillRule.EvenOdd)
    assert (expected - actual).area() + (actual - expected).area() < .001
    assert data["endLength"] == brick_end.PROFILE["endTieWidth"]
    assert data["sourceDigest"] == source_digest(), "regenerate the CAD-derived editor preview"
