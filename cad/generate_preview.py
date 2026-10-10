"""Regenerate production end attachments while retaining the accepted rail contacts.

Run from the repository root: uv run python -m cad.generate_preview
Coordinates remain millimetres: port origin, inward +x, underside z=0.
Source credit: lev, Printables #466240, CC BY 4.0 (see the profile).
"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

import manifold3d
import trimesh
import numpy as np

from cad.models import brick_end


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "src/editor/brick-end-preview.json"


def source_digest() -> str:
    """Bind the preview to its generator, geometry, measured inputs and runtime lock."""
    paths = [Path(__file__), Path(brick_end.__file__), brick_end.PROFILE_PATH,
             brick_end.REFERENCE_STL, brick_end.RAIL_REFERENCE_STL, ROOT / "uv.lock"]
    digest = hashlib.sha256()
    for path in paths:
        content = path.read_bytes()
        digest.update(path.relative_to(ROOT).as_posix().encode() + b"\0")
        digest.update(len(content).to_bytes(8, "big"))
        digest.update(content)
    return digest.hexdigest()


def _geometry(*, opposite: bool = False, flex: bool = False) -> dict:
    shape = brick_end.track({"connector_version": 1, "fit_adjustment": 0,
                            "joint_length": 24}, "bridge_joint")
    mesh = brick_end._mesh(shape)
    if flex:
        # LDraw 64022 half ties carry fewer stud columns; the deck stays at z 3.2.
        attachment = brick_end.PROFILE["brickAttachment"]
        top = attachment["studBaseZ"] + attachment["studHeight"] + .5
        removed = sorted(set(attachment["studLateralOffsets"]) -
                         set(attachment["flexStudLateralOffsets"]))
        mesh = trimesh.boolean.difference(
            [mesh, *(brick_end._cylinder(attachment["studDiameter"] / 2 + .2, attachment["studBaseZ"],
                                        top, row, lateral)
                     for row in (attachment["studRowOffset"], 24 - attachment["studRowOffset"])
                     for lateral in removed)], engine="manifold")
    if opposite:
        mesh.apply_transform([[-1, 0, 0, 24], [0, -1, 0, 0],
                              [0, 0, 1, 0], [0, 0, 0, 1]])
    mesh = trimesh.boolean.intersection(
        [mesh, brick_end._box((-6, -33, -1),
                            (brick_end.PROFILE["endTieWidth"] + .05, 33, 11))],
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
    return {**_geometry(), "opposite": _geometry(opposite=True),
            "flex": {**_geometry(flex=True), "opposite": _geometry(opposite=True, flex=True)},
            "endLength": brick_end.PROFILE["endTieWidth"], "sourceDigest": source_digest()}


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
