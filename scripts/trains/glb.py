"""Mesh welding, simplification and a minimal binary glTF (GLB) writer for the train assets.

Each car asset is one mesh in the car frame (x forward, y left, z up, mm) with no node transform,
vertex colours in COLOR_0 (linear RGBA, normalised unsigned bytes) and no normals (three.js'
GLTFLoader then shades flat). Up to two primitives: opaque and translucent (alphaMode BLEND).
"""
from __future__ import annotations

import json
import struct

import numpy as np


def srgb_to_linear(c: np.ndarray) -> np.ndarray:
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def weld(tris: np.ndarray, grid: float = 0.02) -> tuple[np.ndarray, np.ndarray]:
    """(N,3,3) triangles -> (vertices, faces) with coincident vertices merged; drops degenerate faces."""
    pts = tris.reshape(-1, 3)
    keys = np.round(pts / grid).astype(np.int64)
    _, first, inverse = np.unique(keys, axis=0, return_index=True, return_inverse=True)
    verts = pts[first]
    faces = inverse.reshape(-1, 3)
    ok = (faces[:, 0] != faces[:, 1]) & (faces[:, 1] != faces[:, 2]) & (faces[:, 0] != faces[:, 2])
    faces = faces[ok]
    # Remove exact duplicate faces (LDraw parts often overlap coplanar duplicates).
    _, keep = np.unique(np.sort(faces, axis=1), axis=0, return_index=True)
    return verts, faces[np.sort(keep)]


def cluster(groups: list[tuple[np.ndarray, np.ndarray, tuple]], budget: int) -> list[tuple[np.ndarray, np.ndarray, tuple]]:
    """Vertex-clustering simplification per colour group until the face count fits the budget.

    Vertices sharing a grid cell merge to their mean; collapsed and duplicate faces go. Unlike
    quadric collapse on LDraw's non-manifold part soup, a vertex can only move within its cell,
    so there are no spikes or shards, and colours never mix (each group is its own mesh)."""
    def run(grid: float):
        out = []
        for v, f, colour in groups:
            keys = np.floor(v / grid).astype(np.int64)
            _, inverse, counts = np.unique(keys, axis=0, return_inverse=True, return_counts=True)
            inverse = inverse.ravel()
            verts = np.zeros((len(counts), 3))
            np.add.at(verts, inverse, v)
            verts /= counts[:, None]
            faces = inverse[f]
            ok = (faces[:, 0] != faces[:, 1]) & (faces[:, 1] != faces[:, 2]) & (faces[:, 0] != faces[:, 2])
            faces = faces[ok]
            if not len(faces):
                continue
            _, keep = np.unique(np.sort(faces, axis=1), axis=0, return_index=True)
            faces = faces[np.sort(keep)]
            used, remap = np.unique(faces, return_inverse=True)
            out.append((verts[used], remap.reshape(-1, 3), colour))
        return out

    if sum(len(f) for _, f, _ in groups) <= budget:
        return groups
    grid = 0.6
    while True:
        out = run(grid)
        if sum(len(f) for _, f, _ in out) <= budget:
            return out
        grid *= 1.15


def _pad(b: bytes, fill: bytes = b'\x00') -> bytes:
    return b + fill * ((4 - len(b) % 4) % 4)


def write_glb(path, groups: list[tuple[np.ndarray, np.ndarray, tuple]]) -> tuple[int, int]:
    """groups: (vertices mm, faces, (r, g, b, a) sRGB 0..1). Returns (triangles, bytes)."""
    prims: dict[str, list] = {'opaque': [], 'blend': []}
    for v, f, colour in groups:
        prims['blend' if colour[3] < 0.99 else 'opaque'].append((v, f, colour))
    buf = bytearray()
    views, accessors, primitives, materials = [], [], [], []
    tri_count = 0
    for mode, items in prims.items():
        if not items:
            continue
        verts, cols, faces, base = [], [], [], 0
        for v, f, colour in items:
            verts.append(v.astype(np.float32))
            rgb = srgb_to_linear(np.array(colour[:3]))
            rgba = np.round(np.array([*rgb, colour[3]]) * 255).astype(np.uint8)
            cols.append(np.tile(rgba, (len(v), 1)))
            faces.append(f + base)
            base += len(v)
        verts_a = np.concatenate(verts)
        cols_a = np.concatenate(cols)
        faces_a = np.concatenate(faces)
        tri_count += len(faces_a)
        index_type = np.uint16 if base < 65536 else np.uint32
        attrs = {}
        for name, data, comp, typ, extra in (
                ('POSITION', verts_a, 5126, 'VEC3', {'min': verts_a.min(0).tolist(), 'max': verts_a.max(0).tolist()}),
                ('COLOR_0', cols_a, 5121, 'VEC4', {'normalized': True})):
            off = len(buf)
            buf += _pad(data.tobytes())
            views.append({'buffer': 0, 'byteOffset': off, 'byteLength': data.nbytes, 'target': 34962})
            accessors.append({'bufferView': len(views) - 1, 'componentType': comp, 'count': len(data), 'type': typ, **extra})
            attrs[name] = len(accessors) - 1
        idx = faces_a.astype(index_type).ravel()
        off = len(buf)
        buf += _pad(idx.tobytes())
        views.append({'buffer': 0, 'byteOffset': off, 'byteLength': idx.nbytes, 'target': 34963})
        accessors.append({'bufferView': len(views) - 1, 'componentType': 5123 if index_type == np.uint16 else 5125,
                          'count': len(idx), 'type': 'SCALAR'})
        material = {'name': mode, 'doubleSided': True,
                    'pbrMetallicRoughness': {'baseColorFactor': [1, 1, 1, 1], 'metallicFactor': 0.0, 'roughnessFactor': 0.7}}
        if mode == 'blend':
            material['alphaMode'] = 'BLEND'
        materials.append(material)
        primitives.append({'attributes': attrs, 'indices': len(accessors) - 1, 'material': len(materials) - 1})
    gltf = {'asset': {'version': '2.0', 'generator': 'train-layout-workshop scripts/trains'},
            'scene': 0, 'scenes': [{'nodes': [0]}], 'nodes': [{'mesh': 0}],
            'meshes': [{'primitives': primitives}], 'materials': materials,
            'buffers': [{'byteLength': len(buf)}], 'bufferViews': views, 'accessors': accessors}
    js = _pad(json.dumps(gltf, separators=(',', ':')).encode(), b' ')
    out = struct.pack('<III', 0x46546C67, 2, 12 + 8 + len(js) + 8 + len(buf))
    out += struct.pack('<II', len(js), 0x4E4F534A) + js + struct.pack('<II', len(buf), 0x004E4942) + bytes(buf)
    with open(path, 'wb') as fh:
        fh.write(out)
    return tri_count, len(out)


def read_glb(path) -> tuple[dict, bytes]:
    data = open(path, 'rb').read()
    magic, version, length = struct.unpack('<III', data[:12])
    assert magic == 0x46546C67 and version == 2 and length == len(data)
    jlen, jtype = struct.unpack('<II', data[12:20])
    gltf = json.loads(data[20:20 + jlen])
    blen, btype = struct.unpack('<II', data[20 + jlen:28 + jlen])
    return gltf, data[28 + jlen:28 + jlen + blen]


def glb_triangles(path) -> np.ndarray:
    """All triangles of a GLB written by write_glb, (N,3,3) mm."""
    gltf, binary = read_glb(path)
    out = []
    for prim in gltf['meshes'][0]['primitives']:
        pa = gltf['accessors'][prim['attributes']['POSITION']]
        pv = gltf['bufferViews'][pa['bufferView']]
        pos = np.frombuffer(binary, np.float32, pa['count'] * 3, pv['byteOffset']).reshape(-1, 3)
        ia = gltf['accessors'][prim['indices']]
        iv = gltf['bufferViews'][ia['bufferView']]
        dtype = np.uint16 if ia['componentType'] == 5123 else np.uint32
        idx = np.frombuffer(binary, dtype, ia['count'], iv['byteOffset']).reshape(-1, 3)
        out.append(pos[idx])
    return np.concatenate(out)
