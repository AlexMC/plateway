"""Review renders of the catalogue: side and top views of every car with its measurements drawn on.

  uv run --with numpy --with moderngl --with pillow python scripts/trains/render.py [set ids...]

Writes /tmp/train-data/renders/<set>.png: per car a side view (from the left, +y) and a top view
at 2 px/mm, with railhead (z=0, green), bogie pivots (blue), couplers (red) and the outline (orange).
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
from glb import read_glb  # noqa: E402

DATA = Path(os.environ.get('TRAIN_DATA_DIR', '/tmp/train-data'))
PUBLIC = Path(__file__).resolve().parents[2] / 'public'
PX = 2.0  # px per mm

VERT = """
#version 330
uniform mat4 mvp;
in vec3 pos; in vec4 col; in vec3 nrm;
out vec4 c;
void main() {
  float l = 0.35 + 0.65 * abs(dot(normalize(nrm), normalize(vec3(0.3, 0.6, 0.75))));
  c = vec4(col.rgb * l, col.a);
  gl_Position = mvp * vec4(pos, 1.0);
}
"""
FRAG = """
#version 330
in vec4 c; out vec4 o;
void main() { o = vec4(pow(c.rgb, vec3(1.0/2.2)), 1.0); }
"""


def load(path: Path) -> tuple[np.ndarray, np.ndarray]:
    gltf, binary = read_glb(path)
    tris, cols = [], []
    for prim in gltf['meshes'][0]['primitives']:
        acc = gltf['accessors']
        views = gltf['bufferViews']

        def arr(i, dtype, n):
            a = acc[i]
            return np.frombuffer(binary, dtype, a['count'] * n, views[a['bufferView']]['byteOffset']).reshape(-1, n)
        pos = arr(prim['attributes']['POSITION'], np.float32, 3)
        col = arr(prim['attributes']['COLOR_0'], np.uint8, 4) / 255.0
        ia = acc[prim['indices']]
        idx = np.frombuffer(binary, np.uint16 if ia['componentType'] == 5123 else np.uint32, ia['count'],
                            views[ia['bufferView']]['byteOffset']).reshape(-1, 3)
        tris.append(pos[idx])
        cols.append(col[idx[:, 0]])
    return np.concatenate(tris), np.concatenate(cols)


def render(ctx, tris, cols, view: str, lo, hi):
    import moderngl
    n = np.cross(tris[:, 1] - tris[:, 0], tris[:, 2] - tris[:, 0])
    n /= np.linalg.norm(n, axis=1, keepdims=True) + 1e-12
    data = np.concatenate([tris, np.repeat(cols[:, None, :], 3, axis=1), np.repeat(n[:, None, :], 3, axis=1)], axis=2)
    if view == 'side':   # looking from +y (the car's left) toward -y: screen x = car x, screen y = z
        ax, ay = 0, 2
        w, h = (hi[0] - lo[0]), (hi[2] - lo[2])
    else:                # top: screen x = car x, screen y = car y
        ax, ay = 0, 1
        w, h = (hi[0] - lo[0]), (hi[1] - lo[1])
    W, H = int(w * PX) + 1, int(h * PX) + 1
    m = np.zeros((4, 4))
    m[0, ax] = 2 / w
    m[0, 3] = -1 - 2 * lo[ax] / w
    m[1, ay] = 2 / h
    m[1, 3] = -1 - 2 * lo[ay] / h
    depth_axis = 1 if view == 'side' else 2
    m[2, depth_axis] = -1 / 500.0 if view == 'top' else 1 / 500.0
    m[3, 3] = 1
    prog = ctx.program(vertex_shader=VERT, fragment_shader=FRAG)
    prog['mvp'].write(m.T.astype('f4').tobytes())
    vbo = ctx.buffer(data.astype('f4').tobytes())
    vao = ctx.vertex_array(prog, [(vbo, '3f 4f 3f', 'pos', 'col', 'nrm')])
    fbo = ctx.simple_framebuffer((W, H))
    fbo.use()
    fbo.clear(1, 1, 1, 1)
    ctx.enable(moderngl.DEPTH_TEST)
    vao.render(moderngl.TRIANGLES)
    img = np.frombuffer(fbo.read(components=3), np.uint8).reshape(H, W, 3)[::-1]
    for r in (vao, vbo, fbo, prog):
        r.release()
    return img


def main() -> None:
    import moderngl
    from PIL import Image, ImageDraw

    index = json.loads((PUBLIC / 'trains' / 'index.json').read_text())
    only = set(sys.argv[1:])
    ctx = moderngl.create_standalone_context(require=330)
    out_dir = DATA / 'renders'
    out_dir.mkdir(parents=True, exist_ok=True)
    for s in index['sets']:
        if only and s['id'] not in only:
            continue
        panels = []
        for car in s['cars']:
            tris, cols = load(PUBLIC / car['asset'])
            lo = tris.reshape(-1, 3).min(0) - 6
            hi = tris.reshape(-1, 3).max(0) + 6
            lo[0] = min(lo[0], car['couplers']['rear'] - 6)
            hi[0] = max(hi[0], car['couplers']['front'] + 6)
            lo[2] = min(lo[2], -6)
            side = Image.fromarray(render(ctx, tris, cols, 'side', lo, hi))
            top = Image.fromarray(render(ctx, tris, cols, 'top', lo, hi))
            for img, view in ((side, 'side'), (top, 'top')):
                d = ImageDraw.Draw(img)
                H = img.size[1]
                X = lambda x: (x - lo[0]) * PX  # noqa: E731
                Y = (lambda z: H - (z - lo[2]) * PX) if view == 'side' else (lambda y: H - (y - lo[1]) * PX)  # noqa: E731
                if view == 'side':
                    d.line([(0, Y(0)), (img.size[0], Y(0))], fill=(0, 170, 0))
                else:
                    d.line([(X(x), Y(y)) for x, y in car['outline'] + car['outline'][:1]], fill=(255, 140, 0), width=1)
                    d.line([(0, Y(0)), (img.size[0], Y(0))], fill=(0, 170, 0))
                for b in car['bogies']:
                    d.line([(X(b), 0), (X(b), H)], fill=(0, 0, 255))
                for c in car['couplers'].values():
                    d.line([(X(c), 0), (X(c), H)], fill=(255, 0, 0))
                d.text((X(car['couplers']['front']) - 14, 2), 'F', fill=(255, 0, 0))
            label = (f"{car['id']} [{car['kind']}{', motor' if car['motorised'] else ''}] L{car['length']} W{car['width']} "
                     f"H{car['height']} wb{car['wheelbase']} tris {car['triangles']}")
            panel = Image.new('RGB', (max(side.size[0], top.size[0], 520), side.size[1] + top.size[1] + 18), 'white')
            ImageDraw.Draw(panel).text((2, 2), label, fill=(0, 0, 0))
            panel.paste(side, (0, 16))
            panel.paste(top, (0, 18 + side.size[1]))
            panels.append(panel)
        W = max(p.size[0] for p in panels)
        sheet = Image.new('RGB', (W, sum(p.size[1] + 6 for p in panels) + 20), 'white')
        ImageDraw.Draw(sheet).text((2, 2), f"{s['id']} {s['name']} ({s['year']}, {s['theme']}, power {s['power']}, {s['gauge']})", fill=(0, 0, 0))
        y = 20
        for p in panels:
            sheet.paste(p, (0, y))
            y += p.size[1] + 6
        sheet.save(out_dir / f"{s['id']}.png")
        print(out_dir / f"{s['id']}.png")


if __name__ == '__main__':
    main()
