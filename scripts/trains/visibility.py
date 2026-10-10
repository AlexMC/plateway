"""Drop triangles that cannot be seen from outside the model (brick internals: tubes, hidden walls).

Renders triangle ids with depth testing (offscreen OpenGL via moderngl) from directions spread
over the sphere and keeps every triangle that wins at least one pixel. Translucent triangles do
not occlude (cab interiors stay visible through windows); they are tested against the opaque
depth themselves.
"""
from __future__ import annotations

import numpy as np

VERT = """
#version 330
uniform mat4 mvp;
in vec3 pos;
void main() { gl_Position = mvp * vec4(pos, 1.0); }
"""
FRAG = """
#version 330
uniform uint base;
out uint id;
void main() { id = uint(gl_PrimitiveID) + base + 1u; }
"""

_ctx = None


def _context():
    global _ctx
    if _ctx is None:
        import moderngl
        _ctx = moderngl.create_standalone_context(require=330)
    return _ctx


def directions(n: int) -> np.ndarray:
    """n roughly uniform unit vectors (Fibonacci sphere)."""
    i = np.arange(n) + 0.5
    phi = np.arccos(1 - 2 * i / n)
    theta = np.pi * (1 + 5 ** 0.5) * i
    return np.stack([np.cos(theta) * np.sin(phi), np.sin(theta) * np.sin(phi), np.cos(phi)], axis=1)


def _ortho_view(d: np.ndarray, lo: np.ndarray, hi: np.ndarray) -> np.ndarray:
    centre = (lo + hi) / 2
    radius = np.linalg.norm(hi - lo) / 2 + 1.0
    z = d / np.linalg.norm(d)
    up = np.array([0.0, 0.0, 1.0]) if abs(z[2]) < 0.95 else np.array([1.0, 0.0, 0.0])
    x = np.cross(up, z)
    x /= np.linalg.norm(x)
    y = np.cross(z, x)
    view = np.eye(4)
    view[0, :3], view[1, :3], view[2, :3] = x, y, z
    view[:3, 3] = -view[:3, :3] @ centre
    proj = np.diag([1 / radius, 1 / radius, -1 / radius, 1.0])
    return proj @ view


def visible(tris: np.ndarray, translucent: np.ndarray, views: int = 48, size: int = 1400) -> np.ndarray:
    """Boolean mask of triangles visible from at least one of `views` directions."""
    ctx = _context()
    prog = ctx.program(vertex_shader=VERT, fragment_shader=FRAG)
    lo, hi = tris.reshape(-1, 3).min(0), tris.reshape(-1, 3).max(0)
    keep = np.zeros(len(tris), dtype=bool)
    opaque_idx = np.flatnonzero(~translucent)
    clear_idx = np.flatnonzero(translucent)
    vbo_o = ctx.buffer(tris[opaque_idx].astype('f4').tobytes())
    vbo_c = ctx.buffer(tris[clear_idx].astype('f4').tobytes()) if len(clear_idx) else None
    vao_o = ctx.vertex_array(prog, [(vbo_o, '3f', 'pos')])
    vao_c = ctx.vertex_array(prog, [(vbo_c, '3f', 'pos')]) if vbo_c else None
    colour = ctx.renderbuffer((size, size), components=1, dtype='u4')
    depth = ctx.depth_renderbuffer((size, size))
    fbo = ctx.framebuffer(color_attachments=[colour], depth_attachment=depth)
    fbo.use()
    import moderngl
    ctx.enable(moderngl.DEPTH_TEST)
    ctx.disable(moderngl.CULL_FACE)
    for d in directions(views):
        mvp = _ortho_view(d, lo, hi)
        prog['mvp'].write(mvp.T.astype('f4').tobytes())
        ctx.depth_mask = True
        fbo.clear(depth=1.0)
        prog['base'].value = 0
        vao_o.render(moderngl.TRIANGLES)
        ids = np.frombuffer(fbo.read(components=1, dtype='u4'), dtype=np.uint32)
        seen = np.unique(ids[ids > 0]) - 1
        keep[opaque_idx[seen]] = True
        if vao_c is not None:
            # Depth writes off: glClear then clears only the ids, keeping the opaque depth.
            ctx.depth_mask = False
            fbo.clear()
            vao_c.render(moderngl.TRIANGLES)
            ids = np.frombuffer(fbo.read(components=1, dtype='u4'), dtype=np.uint32)
            seen = np.unique(ids[ids > 0]) - 1
            keep[clear_idx[seen]] = True
    for r in (vao_o, vbo_o, fbo, colour, depth, prog):
        r.release()
    if vao_c is not None:
        vao_c.release()
        vbo_c.release()
    return keep
