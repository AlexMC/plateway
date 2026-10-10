"""public/trains/index.json follows the TrainCatalogue contract and every car asset loads within budget."""
import json
import re
import struct
from pathlib import Path

import numpy as np
import pytest

TRAINS = Path(__file__).resolve().parents[1] / "public" / "trains"
INDEX = TRAINS / "index.json"
POWER = {"none", "4.5V", "12V", "9V", "RC", "IR", "BT", "monorail"}
KINDS = {"loco", "tender", "wagon", "coach", "caboose", "other"}
SOURCES = {"omr", "ldraw-unofficial", "procedural"}

pytestmark = pytest.mark.skipif(not INDEX.exists(), reason="train catalogue not built (scripts/trains/build.py)")


def catalogue():
    return json.loads(INDEX.read_text())


def cars():
    return [(s, c) for s in catalogue()["sets"] for c in s["cars"]]


def glb(path: Path):
    data = path.read_bytes()
    magic, version, length = struct.unpack("<III", data[:12])
    assert (magic, version, length) == (0x46546C67, 2, len(data))
    jlen, jtype = struct.unpack("<II", data[12:20])
    assert jtype == 0x4E4F534A
    gltf = json.loads(data[20:20 + jlen])
    blen, btype = struct.unpack("<II", data[20 + jlen:28 + jlen])
    assert btype == 0x004E4942
    binary = data[28 + jlen:28 + jlen + blen]
    assert len(gltf["nodes"]) == 1 and not {"matrix", "rotation", "scale", "translation"} & set(gltf["nodes"][0])
    tris = []
    for prim in gltf["meshes"][0]["primitives"]:
        assert {"POSITION", "COLOR_0"} <= set(prim["attributes"])
        pa = gltf["accessors"][prim["attributes"]["POSITION"]]
        pos = np.frombuffer(binary, np.float32, pa["count"] * 3, gltf["bufferViews"][pa["bufferView"]]["byteOffset"]).reshape(-1, 3)
        ia = gltf["accessors"][prim["indices"]]
        dtype = np.uint16 if ia["componentType"] == 5123 else np.uint32
        idx = np.frombuffer(binary, dtype, ia["count"], gltf["bufferViews"][ia["bufferView"]]["byteOffset"]).reshape(-1, 3)
        assert idx.max() < len(pos)
        tris.append(pos[idx])
    return np.concatenate(tris)


def test_catalogue_matches_contract():
    cat = catalogue()
    assert cat["version"] == 1
    ids = [s["id"] for s in cat["sets"]]
    assert len(ids) == len(set(ids))
    for s in cat["sets"]:
        assert re.fullmatch(r"\d+-\d+", s["id"]), s["id"]
        assert s["name"] and s["theme"] and isinstance(s["year"], int)
        assert s["power"] in POWER and s["gauge"] in {"standard", "monorail"}
        assert s["source"]["kind"] in SOURCES
        if s["source"]["kind"] == "omr":
            assert s["source"]["url"].startswith("https://library.ldraw.org/omr/sets/")
            assert s["source"]["authors"] and s["source"]["license"]
        else:
            assert s["source"]["evidence"]
        assert s["cars"]
        for c in s["cars"]:
            assert c["id"].startswith(s["id"] + "/")
            assert c["kind"] in KINDS and isinstance(c["motorised"], bool)
            assert c["asset"] == f"trains/{s['id']}/{c['id'].split('/', 1)[1]}.glb"
            assert c["length"] > 0 and c["width"] > 0 and c["height"] > 0
            assert c["bogies"] == sorted(c["bogies"]) and len(c["bogies"]) >= 2
            assert abs(c["wheelbase"] - (c["bogies"][-1] - c["bogies"][0])) < 0.11
            # Origin midway between the outer pivots.
            assert abs(c["bogies"][0] + c["bogies"][-1]) < 0.11
            assert c["couplers"]["front"] > 0 > c["couplers"]["rear"]
            assert 3 <= len(c["outline"]) <= 40
    assert any(s["id"] == "60052-1" for s in cat["sets"])


def test_every_asset_exists_and_loads_within_budget():
    for s, c in cars():
        path = TRAINS.parent / c["asset"]
        assert path.exists(), c["asset"]
        assert path.stat().st_size == c["bytes"] <= 250_000, c["id"]
        tris = glb(path)
        assert len(tris) == c["triangles"] <= 12_000, c["id"]
        lo, hi = tris.reshape(-1, 3).min(0), tris.reshape(-1, 3).max(0)
        # The mesh is in the car frame: it spans the recorded (full-resolution) width, height and
        # length to within the simplification grid, and only flanges dip below the railhead.
        assert abs((hi[1] - lo[1]) - c["width"]) < 3.0, c["id"]
        assert abs(max(c["couplers"]["front"], hi[0]) - min(c["couplers"]["rear"], lo[0]) - c["length"]) < 3.0, c["id"]
        assert abs(hi[2] - c["height"]) < 3.0, c["id"]
        assert lo[2] > -12.0, c["id"]
