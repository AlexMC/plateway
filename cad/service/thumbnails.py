"""Isometric drawings of meshes, shared by the assembly guide's illustrations and each plate's preview thumbnail.

Plateway draws plate thumbnails itself: the Bambu Studio CLI cannot render one headless.
"""
from __future__ import annotations

import math
from pathlib import Path

import manifold3d
import matplotlib
from matplotlib.collections import PolyCollection
from matplotlib.figure import Figure
import numpy as np
import trimesh

INK = '#1d232b'
PART_COLOURS = ('#e07b2e', '#3c7fc4', '#2f9e66', '#c4469b', '#8f6bd0', '#c9a227', '#3fa9a9', '#d0533f',
                '#6b8e23', '#7a5c3e', '#e58fb1', '#4d5f7a')
THUMBNAIL_PIXELS = 512


# Isometric camera: looking from front-right-above; screen right/up and the depth towards the viewer.
EYE = np.array([1., -1., 1.])/math.sqrt(3)
RIGHT = np.array([1., 1., 0.])/math.sqrt(2)
UP = np.cross(EYE, RIGHT)
LIGHT = np.array([.35, -.55, 1.])/np.linalg.norm([.35, -.55, 1.])


def _shade(colour: str, factor: np.ndarray) -> np.ndarray:
    rgb = np.asarray(matplotlib.colors.to_rgb(colour))
    return np.clip(rgb[None, :]*factor[:, None] + (1-factor[:, None])*.08, 0, 1)


def draw_iso(ax, solids: list[tuple[np.ndarray, np.ndarray, str]], crease_degrees: float = 32.) -> list[np.ndarray]:
    """Flat-shaded isometric drawing with silhouette and crease outlines, painter-sorted; returns each solid's screen
    points (for labels). `solids`: (vertices, faces, colour) already exploded into place."""
    polygons, colours, edges, widths, depths, screens = [], [], [], [], [], []
    for vertices, faces, colour in solids:
        screen = np.column_stack((vertices @ RIGHT, vertices @ UP))
        depth = vertices @ EYE
        screens.append(screen)
        tri = vertices[faces]
        normals = np.cross(tri[:, 1]-tri[:, 0], tri[:, 2]-tri[:, 0])
        length = np.linalg.norm(normals, axis=1)
        keep = length > 1e-9
        normals[keep] /= length[keep, None]
        front = (normals @ EYE > 1e-6) & keep
        face_depth = depth[faces].mean(axis=1)
        light = .42 + .58*np.clip(normals @ LIGHT, 0, 1)
        shaded = _shade(colour, light)
        for index in np.flatnonzero(front):
            polygons.append(screen[faces[index]])
            colours.append((*shaded[index], 1.))
            edges.append((*shaded[index], 1.))
            widths.append(.25)
            depths.append(face_depth[index])
        # Outline edges: silhouettes (front next to back), creases between front faces, open boundaries.
        pairs = np.sort(np.stack((faces[:, [0, 1]], faces[:, [1, 2]], faces[:, [2, 0]]), axis=1).reshape(-1, 2), axis=1)
        owner = np.repeat(np.arange(len(faces)), 3)
        unique, inverse, counts = np.unique(pairs, axis=0, return_inverse=True, return_counts=True)
        inverse = inverse.reshape(-1)
        order = np.argsort(inverse, kind='stable')
        starts = np.concatenate(([0], np.cumsum(counts)[:-1]))
        cos_crease = math.cos(math.radians(crease_degrees))
        for edge_index, (start, count) in enumerate(zip(starts, counts)):
            adjacent = owner[order[start:start+count]]
            facing = front[adjacent]
            if not facing.any():
                continue
            if count == 2 and facing.all() and normals[adjacent[0]] @ normals[adjacent[1]] > cos_crease:
                continue
            a, b = unique[edge_index]
            polygons.append(screen[[a, b]])
            colours.append((0, 0, 0, 0))
            edges.append(matplotlib.colors.to_rgba(INK, .9))
            widths.append(.45)
            depths.append(face_depth[adjacent[facing]].max() + 1e-3)
    order = np.argsort(depths, kind='stable')
    ax.add_collection(PolyCollection([polygons[i] for i in order], closed=True, facecolors=[colours[i] for i in order],
                                     edgecolors=[edges[i] for i in order], linewidths=[widths[i] for i in order],
                                     joinstyle='round', antialiaseds=True))
    every = np.concatenate(screens) if screens else np.zeros((1, 2))
    lo, hi = every.min(axis=0), every.max(axis=0)
    pad = .04*max(hi-lo)
    ax.set_xlim(lo[0]-pad, hi[0]+pad)
    ax.set_ylim(lo[1]-pad, hi[1]+pad)
    ax.set_aspect('equal')
    ax.set_axis_off()
    return screens


def _drawable(mesh: trimesh.Trimesh, tolerance: float) -> tuple[np.ndarray, np.ndarray]:
    """A mesh's (vertices, faces), simplified with manifold3d to `tolerance` mm when it is a closed solid."""
    vertices, faces = np.asarray(mesh.vertices, float), np.asarray(mesh.faces, np.int64)
    solid = manifold3d.Manifold(manifold3d.Mesh(vert_properties=vertices.astype(np.float32), tri_verts=faces.astype(np.uint32)))
    if solid.status() != manifold3d.Error.NoError:
        return vertices, faces
    simple = solid.simplify(tolerance).to_mesh()
    return np.asarray(simple.vert_properties, float)[:, :3], np.asarray(simple.tri_verts, np.int64)


def plate_thumbnail(target: Path, parts: list[list[trimesh.Trimesh]]) -> None:
    """Write a square PNG of a plate: each part (its meshes placed on the bed) in its own colour, transparent around."""
    meshes = [mesh for part in parts for mesh in part]
    low = np.min([mesh.bounds[0] for mesh in meshes], axis=0)
    high = np.max([mesh.bounds[1] for mesh in meshes], axis=0)
    tolerance = max(.35, float(np.linalg.norm(high - low)) / 450)
    figure = Figure(figsize=(THUMBNAIL_PIXELS / 100, THUMBNAIL_PIXELS / 100), dpi=100)
    draw_iso(figure.add_axes((0, 0, 1, 1)), [(*_drawable(mesh, tolerance), PART_COLOURS[index % len(PART_COLOURS)])
                                             for index, part in enumerate(parts) for mesh in part])
    figure.savefig(target, format='png', transparent=True)
