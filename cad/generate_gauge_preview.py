"""Regenerate the narrow-gauge end attachment drawn by the 2D/3D builder and Test drive.

Run from the repository root: env PYTHONPATH=. uv run python -m cad.generate_gauge_preview
Same structure as cad/generate_preview.py (port origin, inward +x, underside z=0, millimetres):
the ends of a 24 mm narrow straight (cad/models/gauge.py), cropped to the end tie.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

import manifold3d
import numpy as np
import trimesh

from cad.models import composite, gauge, brick_end


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "src/editor/narrow-end-preview.json"
LENGTH = 24
PARAMETERS = {"rail_gauge": 40, "rail_interface_width": 2.4, "body_width": 63.8, "base_thickness": 3.2,
              "rail_height": 6.4, "connector_version": 1, "fit_adjustment": 0,
              "segments": 1, "s0_len": LENGTH, "s0_k0": 0, "s0_k1": 0, "z0": 0, "z1": 0, "grade0": 0,
              "grade1": 0, "vcurve": 0, "cant0": 0, "cant1": 0, "ends": 3, "gauge": gauge.NARROW}


def source_digest() -> str:
    """Bind the preview to its generator, geometry, measured inputs and runtime lock."""
    paths = [Path(__file__), Path(gauge.__file__), Path(composite.__file__), Path(brick_end.__file__),
             brick_end.PROFILE_PATH, gauge.NARROW_PROFILE_PATH,
             brick_end.REFERENCE_STL, brick_end.RAIL_REFERENCE_STL, ROOT / "uv.lock"]
    digest = hashlib.sha256()
    for path in paths:
        content = path.read_bytes()
        digest.update(path.relative_to(ROOT).as_posix().encode() + b"\0")
        digest.update(len(content).to_bytes(8, "big"))
        digest.update(content)
    return digest.hexdigest()


def _geometry(mesh: trimesh.Trimesh, *, opposite: bool = False) -> dict:
    mesh = mesh.copy()
    if opposite:
        mesh.apply_transform([[-1, 0, 0, LENGTH], [0, -1, 0, 0],
                              [0, 0, 1, 0], [0, 0, 0, 1]])
    mesh = trimesh.boolean.intersection(
        [mesh, brick_end._box((-6, -33, -1),
                            (gauge.NARROW_PROFILE["endTieWidth"] + .05, 33, 11))],
        engine="manifold")
    if not mesh.is_watertight or not mesh.is_winding_consistent or mesh.volume <= 0:
        raise ValueError("nominal preview must be an oriented watertight solid")
    if len(mesh.split(only_watertight=False)) != 1:
        raise ValueError("nominal preview must have one connected component")
    solid = manifold3d.Manifold(manifold3d.Mesh(np.float32(mesh.vertices), np.uint32(mesh.faces)))
    if solid.status() != manifold3d.Error.NoError:
        raise ValueError("nominal preview cannot be projected as a manifold")
    # Positive fill resolves projected overlapping triangles, retaining holes.
    silhouette = manifold3d.CrossSection(solid.project().to_polygons(), manifold3d.FillRule.Positive)
    return {"positions": mesh.vertices.reshape(-1).tolist(),
            "indices": mesh.faces.reshape(-1).tolist(),
            "outlines": [loop.tolist() for loop in silhouette.to_polygons()]}


def preview() -> dict:
    mesh = gauge.narrow_track_mesh(PARAMETERS)
    return {**_geometry(mesh), "opposite": _geometry(mesh, opposite=True),
            "endLength": gauge.NARROW_PROFILE["endTieWidth"], "sourceDigest": source_digest()}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=OUTPUT)
    args = parser.parse_args()
    data = preview()
    args.output.write_text(json.dumps(data, separators=(",", ":"), allow_nan=False) + "\n")
    print(f"{args.output}: {len(data['positions']) // 3} vertices, "
          f"{len(data['indices']) // 3} triangles, {len(data['outlines'])} silhouette loops; "
          f"source {data['sourceDigest']}")


if __name__ == "__main__":
    main()
