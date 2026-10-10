"""Reject broken, disconnected, wrongly scaled or out-of-envelope exports before publication."""

from __future__ import annotations

import math
from pathlib import Path

import cadquery as cq
import numpy as np
import trimesh

from cad.service.errors import UserError


def bounds(shape: cq.Shape) -> dict:
    box = shape.BoundingBox()
    return {"min": [box.xmin, box.ymin, box.zmin],
            "max": [box.xmax, box.ymax, box.zmax],
            "size": [box.xlen, box.ylen, box.zlen]}


def verify(shape: cq.Shape, stl: Path, step: Path | None, envelope: dict[str, float],
           expected: dict) -> dict:
    """Check source solid, optional STEP roundtrip, STL topology, dimensions and bed extent.

    The source remains in assembly axes; orientation is not silently rotated
    to make a part fit the bed.
    """
    if not shape.isValid() or len(shape.Solids()) != 1 or shape.Volume() <= 0:
        raise ValueError("CAD model must be one valid positive-volume solid")
    if any(not math.isfinite(v) for side in ("min", "max", "size") for v in expected[side]):
        raise ValueError("CAD model bounds must be finite")
    if any(expected["size"][i] > envelope[axis] + 1e-5
           for i, axis in enumerate(("x", "y", "z"))):
        raise UserError("A printed part is too large for the printer bed.")

    if step is not None:
        imported = cq.importers.importStep(str(step)).val()
        if not imported.isValid() or len(imported.Solids()) != 1 or imported.Volume() <= 0:
            raise ValueError("STEP must round-trip as one positive-volume solid")
        actual = bounds(imported)
        if (not np.allclose(actual["min"], expected["min"], atol=0.001, rtol=0) or
                not np.allclose(actual["max"], expected["max"], atol=0.001, rtol=0) or
                not math.isclose(imported.Volume(), shape.Volume(), abs_tol=0.001)):
            raise ValueError("STEP dimensions or volume differ from source solid")

    mesh = trimesh.load_mesh(stl, file_type="stl", process=True)
    if not isinstance(mesh, trimesh.Trimesh) or not mesh.is_watertight or not mesh.is_winding_consistent or mesh.volume <= 0:
        raise ValueError("STL must be closed, consistently wound and positive-volume")
    # A hollow CAD solid can have several closed surface components: one
    # outward exterior and inward-wound negative cavity shells. Reject a
    # second positive component (a truly disconnected printable part).
    components = mesh.split(only_watertight=False)
    if sum(part.volume > 0 for part in components) != 1 or any(part.volume == 0 for part in components):
        raise ValueError("STL must contain one exterior and only inward cavity shells")
    if not np.allclose(mesh.bounds, [expected["min"], expected["max"]], atol=0.03, rtol=0):
        raise ValueError("STL bounds do not match source solid")
    return expected
