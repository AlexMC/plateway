"""Reject incompatible/unmeasured requests before publishing trial assets."""

import copy
import json
from pathlib import Path

import pytest

from cad.service.generate import generate_part


@pytest.mark.parametrize("change,error", [
    ({"version": 2}, "version"),
    ({"version": True}, "version"),
    ({"units": "in"}, "mm"),
    ({"family": "imaginary"}, "unsupported CAD family"),
    ({"part_revision": "../escape"}, "part_revision"),
    ({"layout_revision": ""}, "layout_revision"),
    ({"unexpected": 1}, "request requires exactly"),
])
def test_rejects_incompatible_request_schema(tmp_path, connector_request, change, error):
    connector_request.update(change)
    with pytest.raises(ValueError, match=error):
        generate_part(connector_request, tmp_path)
    assert not list(tmp_path.iterdir())


def test_missing_or_unknown_dimensions_are_not_inferred(tmp_path, connector_request):
    del connector_request["parameters"]["tongue_width"]
    with pytest.raises(ValueError, match="parameters requires exactly"):
        generate_part(connector_request, tmp_path)
    connector_request["parameters"]["tongue_width"] = 6
    connector_request["parameters"]["nominal_brick_size"] = 8
    with pytest.raises(ValueError, match="parameters requires exactly"):
        generate_part(connector_request, tmp_path)


@pytest.mark.parametrize("envelope", [{"x": 44, "y": 100, "z": 100},
                                      {"x": 100, "y": 23, "z": 100},
                                      {"x": 100, "y": 100, "z": 5}])
def test_rejects_unprintable_envelope_without_artifacts(tmp_path, connector_request, envelope):
    connector_request["printer_envelope"] = envelope
    with pytest.raises(ValueError, match="too large"):
        generate_part(connector_request, tmp_path)
    assert not list(tmp_path.iterdir())


def test_frozen_source_recipe_links_revision_identity_and_ports(tmp_path, transition_request):
    result = generate_part(transition_request, tmp_path)
    assert json.loads(Path(result["request"]).read_text()) == transition_request
    assert Path(result["source"]).is_file() and Path(result["step"]).is_file()
    assert result["part_revision"] == transition_request["part_revision"]
    assert result["layout_revision"] == transition_request["layout_revision"]
    assert result["ports"][0]["rail_gauge"] == transition_request["parameters"]["rail_gauge"]
    changed = copy.deepcopy(transition_request)
    changed["layout_revision"] = "synthetic-layout-2"
    second = generate_part(changed, tmp_path)
    assert second["request_digest"] != result["request_digest"]
    assert second["digest"] == result["digest"]  # same geometry, distinct request identity
    assert second["layout_revision"] == "synthetic-layout-2"
