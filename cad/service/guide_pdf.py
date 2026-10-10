"""The printable assembly guide (assembly-guide.pdf), drawn from a package's own meshes and receipt.

Pure Python: matplotlib's PDF backend draws every page; meshes are simplified with manifold3d before drawing.
The markdown guide stays the source text; this adds a cover, a numbered layout overview, the shopping list, one page
per plate, an exploded drawing per multipart piece and the physical-trial reminder.
"""
from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import datetime
import io
import logging
import math
import re
import textwrap

import manifold3d
import matplotlib
from matplotlib.backends.backend_pdf import PdfPages
from matplotlib.figure import Figure
from matplotlib.patches import Circle, FancyArrowPatch, PathPatch, Rectangle
from matplotlib.path import Path as MplPath
import numpy as np
from PIL import Image
import trimesh

from cad.models import composite, flex_track, helix_column, rack, track_power
from cad.service.errors import UserError
from cad.service.hardware import CATEGORY_LABELS
from cad.service.thumbnails import INK, PART_COLOURS, RIGHT, UP, draw_iso

PAGE = (210., 297.)  # A4 portrait, mm
MARGIN = 15.
WIDTH = PAGE[0] - 2*MARGIN
TOP = PAGE[1] - 18.
BOTTOM = 16.
PT = .3528  # mm per point
MUTED, RULE, SHADE = '#5d6773', '#c9ced6', '#eef1f4'
OWNED, PRINTED, FAST = '#93a3b5', '#e07b2e', '#2f9e66'
BRICK_TRACK_WIDTH = 64.  # an owned brick track's sleepers, mm
# matplotlib subsets the embedded fonts through fontTools, which logs every table at INFO.
logging.getLogger('fontTools').setLevel(logging.WARNING)


def _duration(seconds: float) -> str:
    minutes = round(seconds/60)
    return f'{minutes // 60} h {minutes % 60:02d} min' if minutes >= 60 else f'{minutes} min'


def _layer(process: str) -> str:
    match = re.match(r'(\d+(?:\.\d+)?)mm', process or '')
    return f'{float(match.group(1)):.2f} mm layers' if match else process or ''


def _plate_grams(plate: dict) -> float:
    return sum(float(row.get('total_used_g') or 0) for row in plate.get('slice', {}).get('filaments', []))


def _plate_seconds(plate: dict) -> float:
    return float(plate.get('slice', {}).get('total_predication') or 0)


# ---------------------------------------------------------------------------------------------------------- meshes

# A package artefact's bytes by its path in the package, or None when it is missing.
Reader = Callable[[str], bytes | None]


class Meshes:
    """Package meshes, loaded once and simplified for drawing (vertices, faces) to a tolerance in mm."""

    def __init__(self, read: Reader):
        self.read, self.solids, self.cache = read, {}, {}

    def get(self, relative: str, tolerance: float) -> tuple[np.ndarray, np.ndarray]:
        key = (relative, tolerance)
        if key not in self.cache:
            if relative not in self.solids:
                data = self.read(relative)
                if data is None:
                    raise UserError('This package is missing part files the guide draws. Prepare the plates again.')
                mesh = trimesh.load_mesh(io.BytesIO(data), file_type='stl', force='mesh')
                vertices, faces = np.asarray(mesh.vertices, float), np.asarray(mesh.faces, np.int64)
                solid = manifold3d.Manifold(manifold3d.Mesh(vert_properties=vertices.astype(np.float32),
                                                            tri_verts=faces.astype(np.uint32)))
                self.solids[relative] = (vertices, faces, solid if solid.status() == manifold3d.Error.NoError else None)
            vertices, faces, solid = self.solids[relative]
            if solid is not None:
                simple = solid.simplify(tolerance).to_mesh()
                vertices, faces = np.asarray(simple.vert_properties, float)[:, :3], np.asarray(simple.tri_verts, np.int64)
            self.cache[key] = (vertices, faces)
        return self.cache[key]


def detail(parts: list[dict]) -> float:
    """Simplification tolerance for drawing parts together: about 1/450 of their size, never under 0.35 mm."""
    lo = np.min([part['bounds']['min'] for part in parts], axis=0)
    hi = np.max([part['bounds']['max'] for part in parts], axis=0)
    return max(.35, round(float(np.linalg.norm(hi-lo))/450, 2))


def _posed(vertices: np.ndarray, pose: dict | None) -> np.ndarray:
    """Local part vertices placed in the layout as the package's assembly pose places them (heading, then offset)."""
    if not pose:
        return vertices
    c, s = math.cos(pose['heading']), math.sin(pose['heading'])
    x, y = vertices[:, 0], vertices[:, 1]
    return np.column_stack((pose['x'] + c*x - s*y, pose['y'] + s*x + c*y, pose['z'] + vertices[:, 2]))


def _silhouette(vertices: np.ndarray, faces: np.ndarray) -> list[np.ndarray]:
    """Top-view outline polygons (outer contours counter-clockwise, holes clockwise) of a placed mesh."""
    tris = vertices[faces][:, :, :2]
    area = ((tris[:, 1, 0]-tris[:, 0, 0])*(tris[:, 2, 1]-tris[:, 0, 1]) -
            (tris[:, 2, 0]-tris[:, 0, 0])*(tris[:, 1, 1]-tris[:, 0, 1]))
    tris = tris[area > 1e-6]  # up-facing triangles cover the whole footprint of a closed mesh
    if not len(tris):
        return []
    section = manifold3d.CrossSection([tri for tri in tris], manifold3d.FillRule.Positive).simplify(.3)
    return [np.asarray(contour) for contour in section.to_polygons() if len(contour) >= 3]


def _compound(polygons: list[np.ndarray]) -> MplPath:
    vertices, codes = [], []
    for polygon in polygons:
        vertices += [*polygon, polygon[0]]
        codes += [MplPath.MOVETO] + [MplPath.LINETO]*(len(polygon)-1) + [MplPath.CLOSEPOLY]
    return MplPath(np.asarray(vertices), codes)


def exploded(parts: list[tuple[np.ndarray, np.ndarray]]) -> list[np.ndarray]:
    """Offsets that pull an assembly's parts apart: outwards from its centre and up by stacking level."""
    if len(parts) < 2:
        return [np.zeros(3) for _ in parts]
    boxes = [(vertices.min(axis=0), vertices.max(axis=0)) for vertices, _ in parts]
    lo = np.min([box[0] for box in boxes], axis=0)
    hi = np.max([box[1] for box in boxes], axis=0)
    centre = (lo+hi)/2
    span = float(np.linalg.norm((hi-lo)[:2]))
    levels = sorted({round(float(box[0][2])/3.) for box in boxes})
    lift = max(18., .22*span, 1.4*float(hi[2]-lo[2]))
    offsets = []
    for low, high in boxes:
        middle = (low+high)/2
        radial = (middle-centre)*np.array([.32, .32, 0.])
        offsets.append(radial + np.array([0., 0., lift*levels.index(round(float(low[2])/3.))]))
    return offsets


# ---------------------------------------------------------------------------------------------------------- pages

class Page:
    """One A4 page in millimetre coordinates (origin bottom left) with a flowing cursor."""

    def __init__(self, guide: 'Guide', heading: str | None):
        self.guide = guide
        self.figure = Figure(figsize=(PAGE[0]/25.4, PAGE[1]/25.4))
        self.ax = self.figure.add_axes((0, 0, 1, 1))
        self.ax.set_xlim(0, PAGE[0])
        self.ax.set_ylim(0, PAGE[1])
        self.ax.set_axis_off()
        self.y = TOP
        if heading:
            self.text(MARGIN, self.y, heading, 17, weight='bold')
            self.y -= 10.

    def text(self, x: float, y: float, value: str, size: float = 9.5, *, colour: str = INK, weight: str = 'normal',
             ha: str = 'left', va: str = 'top', **extra):
        return self.ax.text(x, y, value, fontsize=size, color=colour, fontweight=weight, ha=ha, va=va,
                            parse_math=False, **extra)

    def axes(self, x: float, y: float, width: float, height: float):
        """A drawing area at (x, y) bottom-left, in mm."""
        return self.figure.add_axes((x/PAGE[0], y/PAGE[1], width/PAGE[0], height/PAGE[1]))


def wrap(value: str, width_mm: float, size: float) -> list[str]:
    chars = max(6, int(width_mm/(size*PT*.56)))
    return textwrap.wrap(value, chars, break_long_words=True, break_on_hyphens=True) or ['']


@dataclass
class Guide:
    title: str
    pages: list[Page] = field(default_factory=list)
    contents: list[tuple[str, int]] = field(default_factory=list)
    heading: str = ''

    @property
    def page(self) -> Page:
        return self.pages[-1]

    def new_page(self, heading: str | None = None, *, section: str | None = None) -> Page:
        """A new page; `section` lists it in the cover's contents (once per title)."""
        page = Page(self, heading)
        self.pages.append(page)
        if heading:
            self.heading = heading
        if section and section not in (title for title, _ in self.contents):
            self.contents.append((section, len(self.pages)))
        return page

    def room(self, height: float) -> Page:
        """The current page if `height` mm still fit, else a continuation page."""
        if self.page.y - height < BOTTOM:
            self.new_page(f'{self.heading} (continued)' if self.heading else None)
            self.heading = self.heading.removesuffix(' (continued)')
        return self.page

    def subheading(self, value: str, size: float = 12.):
        page = self.room(size*PT*1.6 + 12)
        page.y -= 2
        page.text(MARGIN, page.y, value, size, weight='bold')
        page.y -= size*PT*1.5 + 2

    def paragraph(self, value: str, size: float = 9.5, *, colour: str = INK, indent: float = 0., weight: str = 'normal'):
        line = size*PT*1.4
        for row in wrap(value, WIDTH-indent, size):
            page = self.room(line)
            page.text(MARGIN+indent, page.y, row, size, colour=colour, weight=weight)
            page.y -= line
        self.page.y -= 1.5

    def steps(self, items: list[str], size: float = 9.5):
        line = size*PT*1.4
        for number, item in enumerate(items, 1):
            rows = wrap(item, WIDTH-8, size)
            for index, row in enumerate(rows):
                page = self.room(line*(len(rows) if index == 0 and len(rows) < 6 else 1))
                if index == 0:
                    page.text(MARGIN, page.y, f'{number}.', size, weight='bold')
                page.text(MARGIN+8, page.y, row, size)
                page.y -= line
            self.page.y -= 1.2

    def bullets(self, items: list[str], size: float = 9.5):
        line = size*PT*1.4
        for item in items:
            for index, row in enumerate(wrap(item, WIDTH-6, size)):
                page = self.room(line)
                if index == 0:
                    page.text(MARGIN+1, page.y, '•', size)
                page.text(MARGIN+6, page.y, row, size)
                page.y -= line
            self.page.y -= .8

    def table(self, columns: list[tuple[str, float]], rows: list[list[str]], size: float = 8.5):
        """Columns (header, width mm, summing to at most WIDTH); the header repeats on continuation pages."""
        line = size*PT*1.35

        def header():
            page = self.page
            height = line + 2.4
            page.ax.add_patch(Rectangle((MARGIN, page.y-height), WIDTH, height, color=SHADE, lw=0))
            x = MARGIN
            for name, width in columns:
                page.text(x+1.2, page.y-1.2, name, size, weight='bold')
                x += width
            page.y -= height

        self.room(2*line + 6)
        header()
        for row in rows:
            cells = [wrap(str(value), width-2.4, size) for value, (_, width) in zip(row, columns)]
            height = max(map(len, cells))*line + 2.2
            before = len(self.pages)
            page = self.room(height)
            if len(self.pages) != before:
                header()
            x = MARGIN
            for lines, (_, width) in zip(cells, columns):
                for index, value in enumerate(lines):
                    page.text(x+1.2, page.y-1.1-index*line, value, size)
                x += width
            page.y -= height
            page.ax.plot([MARGIN, MARGIN+WIDTH], [page.y, page.y], color=RULE, lw=.4)
        self.page.y -= 3

    def finish(self, front: Page) -> bytes:
        """Footers on every page, then the PDF with `front` (the cover) first."""
        pages = [front, *self.pages]
        for number, page in enumerate(pages, 1):
            page.text(MARGIN, 9, self.title, 7.5, colour=MUTED, va='baseline')
            page.text(PAGE[0]-MARGIN, 9, f'{number} / {len(pages)}', 7.5, colour=MUTED, ha='right', va='baseline')
        output = io.BytesIO()
        with PdfPages(output, metadata={'Title': f'Assembly guide · {self.title}', 'Creator': 'Plateway',
                                        'Author': 'Plateway'}) as pdf:
            for page in pages:
                pdf.savefig(page.figure)
        return output.getvalue()


# ---------------------------------------------------------------------------------------------------------- content

@dataclass
class Piece:
    """A layout piece (code "3") or a support (code "S3") and its printed parts, in code order."""
    code: str
    name: str
    parts: list[dict]

    @property
    def support(self) -> bool:
        return self.code.startswith('S')

    @property
    def plates(self) -> list[int]:
        return sorted({part['plate'] for part in self.parts})

    @property
    def fast(self) -> bool:
        return any((part.get('assemblyParameters') or part['parameters']).get('lite') == 1 for part in self.parts)

    @property
    def heights(self) -> tuple[float, float]:
        z = [float(part['assemblyPose']['z']) for part in self.parts if part.get('assemblyPose')] or [0.]
        return min(z), max(z)

    @property
    def codes(self) -> str:
        """Its parts' codes: "4", or "2A–2N"."""
        return self.parts[0]['code'] if len(self.parts) == 1 else f'{self.parts[0]["code"]}–{self.parts[-1]["code"]}'


def pieces(receipt: dict) -> list[Piece]:
    """Every printed piece by its code: layout pieces in number order, then supports."""
    grouped: dict[str, list[dict]] = {}
    for part in receipt['parts']:
        grouped.setdefault(part['piece'], []).append(part)
    order = lambda code: (code.startswith('S'), int(code.lstrip('S')))
    return [Piece(code, parts[0]['pieceName'], parts) for code, parts in sorted(grouped.items(), key=lambda item: order(item[0]))]


def part_title(part: dict) -> str:
    """A part's name within its piece ("base 2 of 5"), or the piece's name for a one-part piece."""
    prefix = f'{part["pieceName"]} · '
    return part['name'][len(prefix):] if part['name'].startswith(prefix) else part['name']


def _bezier(start: dict, end: dict, samples: int = 24) -> np.ndarray:
    """Centreline from one port pose to another: a quadratic curve tangent to both headings."""
    p0, p1 = np.array([start['x'], start['y']]), np.array([end['x'], end['y']])
    d0 = np.array([math.cos(start['heading']), math.sin(start['heading'])])
    d1 = np.array([math.cos(end['heading']), math.sin(end['heading'])])
    cross = d0[0]*d1[1] - d0[1]*d1[0]
    control = (p0+p1)/2
    if abs(cross) > 1e-3:
        t = ((p1-p0)[0]*d1[1] - (p1-p0)[1]*d1[0])/cross
        candidate = p0 + t*d0
        if np.linalg.norm(candidate-p0) < 2*np.linalg.norm(p1-p0):
            control = candidate
    t = np.linspace(0, 1, samples)[:, None]
    return (1-t)**2*p0 + 2*(1-t)*t*control + t**2*p1


def _band(points: np.ndarray, width: float) -> np.ndarray:
    tangent = np.gradient(points, axis=0)
    tangent /= np.maximum(np.linalg.norm(tangent, axis=1, keepdims=True), 1e-9)
    normal = np.column_stack((-tangent[:, 1], tangent[:, 0]))*width/2
    return np.concatenate((points+normal, (points-normal)[::-1]))


def _owned_lines(instance: dict) -> list[np.ndarray]:
    if instance['interfaceKind'] == 'rail':
        return [_bezier(instance['startPort']['pose'], instance['endPort']['pose'])]
    ports = instance.get('ports') or []
    if len(ports) < 2:
        return []
    first = ports[0]['pose']
    entry = {**first, 'heading': first['heading'] + math.pi}
    return [_bezier(entry, port['pose']) for port in ports[1:]]


def _height_colour(colour: str, z: float, top: float) -> tuple:
    mix = .55*min(max(z, 0)/top, 1) if top > 0 else 0
    rgb = np.asarray(matplotlib.colors.to_rgb(colour))
    return tuple(rgb*(1-mix) + np.array([.1, .1, .12])*mix)


def overview(guide: Guide, meshes: Meshes, manifest: dict, numbered: list[Piece]):
    page = guide.new_page('Layout overview', section='Layout overview')
    guide.paragraph('Top view, as in the app. Each printed piece’s number starts its parts’ codes on the plates and in '
                    'your slicer (piece 1: 1A, 1B, …); supports are the small squares.', 9, colour=MUTED)
    page.y -= 2
    room = manifest.get('room')
    shapes = []  # (z, kind, polygons, colour) drawn low to high
    centres, supports = {}, []
    tops = [0.]
    for instance in manifest['instances']:
        if instance['source'] == 'owned':
            z = float(instance['pose']['z'])
            tops.append(z)
            shapes += [(z, 'owned', [_band(line, BRICK_TRACK_WIDTH)], OWNED) for line in _owned_lines(instance)]
    for piece in numbered:
        shapes_of = []
        for part in piece.parts:
            vertices, faces = meshes.get(part['mesh'], 1.)
            shapes_of.append(_silhouette(_posed(vertices, part.get('assemblyPose')), faces))
        middles = [(np.concatenate(shape).min(axis=0)+np.concatenate(shape).max(axis=0))/2 for shape in shapes_of if shape]
        if not middles:
            continue
        outlines = [polygon for shape in shapes_of for polygon in shape]
        low, high = piece.heights
        tops.append(high)
        if piece.support:
            supports += middles
        else:
            # The number sits on the part nearest the piece's middle, so it lands on the track, even on a curve.
            every = np.concatenate(outlines)
            centre = (every.min(axis=0)+every.max(axis=0))/2
            centres[piece.code] = min(middles, key=lambda middle: float(np.linalg.norm(middle-centre)))
        # Supports sit under the track they hold up; track pieces draw over them.
        shapes.append((low - (1 if piece.support else 0), 'support' if piece.support else 'fast' if piece.fast else 'printed',
                       outlines, FAST if piece.fast else PRINTED))
    top = max(tops)
    points = [np.concatenate(polygons) for _, _, polygons, _ in shapes]
    if room:
        points.append(np.array([[0, 0], [room['width'], room['depth']]]))
        points += [np.array([[p['x'], p['y']] for p in item['outline']]) for item in room['furniture']]
    every = np.concatenate(points)
    lo, hi = every.min(axis=0) - 40, every.max(axis=0) + 40
    box_height = min(page.y - 62, WIDTH*(hi[1]-lo[1])/(hi[0]-lo[0]))
    box_width = box_height*(hi[0]-lo[0])/(hi[1]-lo[1])
    ax = page.axes(MARGIN + (WIDTH-box_width)/2, page.y-box_height, box_width, box_height)
    ax.set_xlim(lo[0], hi[0])
    ax.set_ylim(hi[1], lo[1])  # y runs down the page, like the app's plan
    ax.set_aspect('equal')
    ax.set_axis_off()
    if room:
        ax.add_patch(Rectangle((0, 0), room['width'], room['depth'], fill=False, ec=INK, lw=1.2))
        ax.text(0, -18, f'Room {room["width"]:g} × {room["depth"]:g} mm', fontsize=7, color=MUTED, va='bottom',
                parse_math=False)
        for item in room['furniture']:
            outline = np.array([[p['x'], p['y']] for p in item['outline']])
            ax.add_patch(PathPatch(_compound([outline]), fc='#e3ddd2', ec='#9c8f7a', lw=.6))
            centre = outline.mean(axis=0)
            ax.text(*centre, f'{item["label"]}\n{item["height"]:g} mm', fontsize=6, color='#6f6352', ha='center',
                    va='center', parse_math=False)
    for z, kind, polygons, colour in sorted(shapes, key=lambda shape: shape[0]):
        ax.add_patch(PathPatch(_compound(polygons), fc=_height_colour(colour, z, top), ec=INK if kind != 'owned' else 'none',
                               lw=.25))
    scale = box_width/(hi[0]-lo[0])  # mm of paper per mm of layout
    marker = .9/scale
    for centre in supports:
        ax.add_patch(Rectangle(centre - marker/2, marker, marker, fc=INK, ec='white', lw=.3, zorder=4))
    # Piece numbers, nudged apart so they never sit on one another.
    radius = (2.3 if len(centres) < 60 else 1.8)/scale
    placed: list[np.ndarray] = []
    for code, centre in centres.items():
        spot = centre
        for ring in range(0, 6):
            angles = [0.] if ring == 0 else np.linspace(0, 2*math.pi, 8*ring, endpoint=False)
            choices = [centre + ring*2.1*radius*np.array([math.cos(a), math.sin(a)]) for a in angles]
            free = [c for c in choices if all(np.linalg.norm(c-other) > 2.05*radius for other in placed)]
            if free:
                spot = free[0]
                break
        placed.append(spot)
        if spot is not centre:
            ax.plot([centre[0], spot[0]], [centre[1], spot[1]], color=INK, lw=.4)
        ax.add_patch(Circle(spot, radius, fc='white', ec=INK, lw=.5, zorder=5))
        ax.text(*spot, code, fontsize=5.6 if len(code) < 3 else 4.6, ha='center', va='center', zorder=6,
                color=INK, fontweight='bold', parse_math=False)
    page.y -= box_height + 5
    legend(page, top, bool(supports))
    track = [piece for piece in numbered if not piece.support]
    if track:
        guide.subheading('Printed pieces')
        guide.table([('No.', 12), ('Piece', 58), ('Parts', 24), ('Plates', 34), ('Height (mm)', 26), ('Style', 26)],
                    [[piece.code, piece.name, piece.codes, ', '.join(map(str, piece.plates)),
                      '–'.join(dict.fromkeys(f'{z:.0f}' for z in piece.heights)), 'fast' if piece.fast else 'detailed']
                     for piece in track])
    held = [piece for piece in numbered if piece.support]
    if held:
        guide.subheading('Supports')
        guide.paragraph('Columns, risers and brackets under the track, by code; each sits under its own square above.',
                        9, colour=MUTED)
        guide.table([('Code', 14), ('Support', 60), ('Height (mm)', 30), ('Plate', 20), ('File', WIDTH-124)],
                    [[piece.code, piece.name, f'{piece.parts[0]["bounds"]["size"][2]:.1f}', str(piece.parts[0]['plate']),
                      piece.parts[0]['plateLabel']] for piece in held], 8)


def legend(page: Page, top: float, supports: bool):
    x, y = MARGIN, page.y
    for label, colour in (('Your track', OWNED), ('Printed, detailed', PRINTED), ('Printed, fast', FAST)):
        page.ax.add_patch(Rectangle((x, y-3.2), 6, 3.2, fc=colour, ec=INK, lw=.3))
        page.text(x+8, y-.2, label, 8)
        x += 40
    page.ax.add_patch(Circle((x+1.8, y-1.6), 1.9, fc='white', ec=INK, lw=.4))
    page.text(x+1.8, y-1.6, '7', 5.5, ha='center', va='center', weight='bold')
    page.text(x+5.5, y-.2, 'piece', 8)
    if supports:
        page.ax.add_patch(Rectangle((x+16, y-2.4), 1.6, 1.6, fc=INK, lw=0))
        page.text(x+19.5, y-.2, 'support', 8)
    y -= 6.5
    page.text(MARGIN, y, 'Height:', 8)
    for index in range(6):
        z = top*index/5
        page.ax.add_patch(Rectangle((MARGIN+14+index*7, y-3.2), 7, 3.2, fc=_height_colour(PRINTED, z, top), lw=0))
    page.text(MARGIN+14+44, y-.2, f'floor or table (0 mm) → highest ({top:.0f} mm): darker is higher', 8)
    page.y = y - 7


def shopping(guide: Guide, result: dict):
    guide.new_page('Shopping list', section='Shopping list')
    guide.paragraph('Everything to buy besides the printed parts, for the whole layout. Each multipart piece lists '
                    'its own share on its assembly page.', colour=MUTED)
    for warning in result['warnings']:
        guide.paragraph(f'⚠ {warning}', weight='bold')
    if not result['lines'] and not result['control']:
        guide.paragraph('This layout needs no extra hardware.')
        return
    for category, label in CATEGORY_LABELS.items():
        lines = [line for line in result['lines'] if line['category'] == category]
        if lines:
            guide.subheading(label, 11)
            guide.table([('Qty', 14), ('Item', 92), ('For', WIDTH-106)],
                        [[str(line['quantity']), line['name'], ', '.join(line['pieces'])] for line in lines])
    if result['control']:
        guide.subheading('Control gear', 11)
        guide.table([('Qty', 14), ('Item', 92), ('Shared', WIDTH-106)],
                    [[str(item['quantity']), item['name'], '; '.join(filter(None, (item['scope'], item['note'])))]
                     for item in result['control']])
    if result['notes']:
        guide.subheading('Wiring and fixing', 11)
        guide.bullets(result['notes'])


def layout_parts(guide: Guide, receipt: dict):
    """A layout prepared in parts (`combine.py`): which plates and pieces each part holds."""
    parts = receipt['layoutParts']
    guide.new_page('Prepared in parts', section='Prepared in parts')
    guide.paragraph(f'This layout was prepared in {len(parts)} parts, one after another. Plate numbers run on across '
                    'them, and part codes are the whole layout’s: print every plate.', colour=MUTED)
    guide.table([('Part', 18), ('Plates', 40), ('Pieces', WIDTH-58)],
                [[f'{part["index"]} of {len(parts)}', ', '.join(map(str, part['plates'])), ', '.join(part['pieces'])]
                 for part in parts])


def plates(guide: Guide, receipt: dict, read: Reader):
    parts = {part['instanceId']: part for part in receipt['parts']}
    for plate in receipt['plates']:
        page = guide.new_page(f'Plate {plate["plate"]}', section='Plates')
        facts = [_layer(plate.get('process') or receipt['printer']['profile']), plate.get('process') or '',
                 _duration(_plate_seconds(plate)) if _plate_seconds(plate) else '',
                 f'{_plate_grams(plate):.0f} g filament' if _plate_grams(plate) else '',
                 f'{plate["filamentColour"]} filament' if plate.get('filamentColour') else '',
                 f'AMS: {", ".join(name.split(" @BBL ")[0] for name in plate["filaments"])}' if plate.get('filaments') else '',
                 'needs supports' if plate.get('supportsEnabled') else 'no supports']
        guide.paragraph(' · '.join(filter(None, facts)), 10, colour=MUTED)
        thumbnail = plate.get('thumbnail') and read(plate['thumbnail'])
        if thumbnail:
            with Image.open(io.BytesIO(thumbnail)) as source:
                image = Image.new('RGB', source.size, 'white')
                image.paste(source, mask=source.convert('RGBA'))
                image.thumbnail((400, 400))
                image = image.quantize(64).convert('RGB')  # flat slicer colours: a small palette compresses well
            # As large as fits above the parts list (about 10 mm a row), but never a postage stamp.
            side = min(118., max(60., page.y - BOTTOM - 16 - 10*len(plate['objects'])))
            ax = page.axes(MARGIN + (WIDTH-side)/2, page.y-side, side, side)
            ax.imshow(np.asarray(image), interpolation='none')  # embedded as is, not resampled to the figure dpi
            ax.set_axis_off()
            page.y -= side + 4
        rows = [[parts[item['instanceId']]['code'], parts[item['instanceId']]['name'], item['label']] for item in plate['objects']]
        guide.paragraph('In your slicer each part is named by its code.', 8.5, colour=MUTED)
        guide.table([('Code', 14), ('Part', 82), ('File', WIDTH-96)], rows, 8)


def _place(part: dict, transform: tuple[float, np.ndarray] | None, meshes: Meshes,
           tolerance: float) -> tuple[np.ndarray, np.ndarray]:
    vertices, faces = meshes.get(part['mesh'], tolerance)
    if transform:
        angle, offset = transform
        c, s = math.cos(angle), math.sin(angle)
        vertices = np.column_stack((c*vertices[:, 0]-s*vertices[:, 1], s*vertices[:, 0]+c*vertices[:, 1], vertices[:, 2])) + offset
    return vertices, faces


def illustration(guide: Guide, solids: list[tuple[np.ndarray, np.ndarray, str]], labels: list[str],
                 height: float = 105., arrow: tuple[np.ndarray, np.ndarray] | None = None):
    """An isometric drawing across the page; `arrow`: world points (from, to) of a push-together arrow."""
    page = guide.room(height + 4)
    height = min(height, page.y - BOTTOM - 40)
    ax = page.axes(MARGIN, page.y-height, WIDTH, height)
    screens = draw_iso(ax, solids)
    for label, screen in zip(labels, screens):
        if label:
            spot = screen.mean(axis=0)
            ax.annotate(label, spot, fontsize=8, ha='center', va='center', fontweight='bold', color=INK,
                        bbox={'boxstyle': 'circle,pad=0.25', 'fc': 'white', 'ec': INK, 'lw': .5}, zorder=10)
    if arrow:
        tail, head = ((float(point @ RIGHT), float(point @ UP)) for point in arrow)
        ax.add_patch(FancyArrowPatch(tail, head, arrowstyle='-|>', mutation_scale=16, color=INK, lw=1.4, zorder=11))
    page.y -= height + 4


def assembly_pages(guide: Guide, receipt: dict, meshes: Meshes):
    """An exploded drawing, its parts, hardware and steps for every multipart piece and mechanism."""
    def page(title: str):
        guide.new_page(title, section='Assembly')

    def facts(parts: list[dict]) -> str:
        plates = sorted({part['plate'] for part in parts})
        return (f'{len(parts)} printed {"part" if len(parts) == 1 else "parts"} · '
                f'{"plate" if len(plates) == 1 else "plates"} {", ".join(map(str, plates))}')

    for assembly in receipt.get('assemblies', []):
        components = [part for part in receipt['parts'] if part.get('assemblyInstanceId') == assembly['instanceId']]
        page(f'{components[0]["piece"]} · {components[0]["pieceName"]}')
        guide.paragraph(facts(components), 9, colour=MUTED)
        tolerance = detail(components)
        placed = [_place(part, None, meshes, tolerance) for part in components]
        illustration(guide, [(vertices + offset, faces, PART_COLOURS[index % len(PART_COLOURS)])
                             for index, ((vertices, faces), offset) in enumerate(zip(placed, exploded(placed)))],
                     [part['code'] for part in components])
        guide.table([('Code', 14), ('Part', 52), ('Plate', 14), ('File', WIDTH-80)],
                    [[part['code'], part_title(part), str(part['plate']), part['plateLabel']] for part in components], 8)
        _hardware_and_steps(guide, assembly['hardware'], assembly['instructions'])
    singles = [(part, track_power.hardware(part['parameters']), track_power.assembly_notes(part['parameters']))
               for part in receipt['parts'] if part['family'] == composite.FAMILY and
               (part['parameters'].get('metal') or part['parameters'].get('led'))]
    singles += [(part, flex_track.hardware(part['parameters']), flex_track.assembly_notes(part['parameters']))
                for part in receipt['parts'] if part['family'] == flex_track.FAMILY]
    for part, hardware, notes in singles:
        page(f'{part["code"]} · {part["name"]}')
        guide.paragraph(facts([part]), 9, colour=MUTED)
        illustration(guide, [(*_place(part, None, meshes, detail([part])), PRINTED)], [''], 80.)
        _hardware_and_steps(guide, hardware, notes)
    bogies = [part for part in receipt['parts'] if part['family'] == rack.FAMILY]
    if bogies:
        page('Cog bogies')
        shown = [part for kind in (0, 1) for part in bogies[:2] if part['parameters']['part'] == kind]
        placed = [_place(part, None, meshes, detail(shown)) for part in shown]
        illustration(guide, [(vertices + offset, faces, PART_COLOURS[index])
                             for index, ((vertices, faces), offset) in enumerate(zip(placed, exploded(placed)))],
                     [part['code'] for part in shown], 80.)
        guide.table([('Code', 14), ('Part', 52), ('Plate', 14), ('File', WIDTH-80)],
                    [[part['code'], 'frame' if part['parameters']['part'] == 0 else 'cog', str(part['plate']),
                      part['plateLabel']] for part in bogies], 8)
        _hardware_and_steps(guide, rack.HARDWARE, rack.NOTES, 'Hardware per bogie')
    columns: dict[str, list[dict]] = {}
    for part in sorted(receipt['parts'], key=lambda part: part['instanceId']):
        if part['family'] == helix_column.FAMILY:
            columns.setdefault(part['instanceId'].split(':')[-2], []).append(part)
    for index, tubes in enumerate(columns.values(), 1):
        page(f'Helix column {index} of {len(columns)}')
        guide.paragraph('Stand the footed tube on the table, thread the lowest lug of the helix onto its spigot, then '
                        'each next tube onto the spigot through the lug below it, in this order.')
        stack, z = [], 0.
        for slot, part in enumerate(tubes):
            vertices, faces = _place(part, None, meshes, detail(tubes))
            stack.append((vertices + np.array([0, 0, z - vertices[:, 2].min()]), faces, PART_COLOURS[slot % len(PART_COLOURS)]))
            z += float(np.ptp(vertices[:, 2])) + 14
        illustration(guide, stack, [part['code'] for part in tubes], 110.)
        guide.table([('Code', 14), ('Tube', 46), ('Height (mm)', 26), ('Plate', 14), ('File', WIDTH-100)],
                    [[part['code'], 'with foot' if part['parameters']['foot'] else 'plain',
                      f'{part["parameters"]["height"]:.1f}', str(part['plate']), part['plateLabel']] for part in tubes], 8)


PLAIN_EXCLUDED = {flex_track.FAMILY, rack.FAMILY, helix_column.FAMILY, composite.INSERT_FAMILY}


def joining_page(guide: Guide, receipt: dict, meshes: Meshes, steps: list[str]):
    """One generic page: two of the layout's own plain track pieces, pulled apart at their joint."""
    plain = next((part for part in receipt['parts'] if not part.get('componentRole') and not part['piece'].startswith('S')
                  and part['family'] not in PLAIN_EXCLUDED and len(part.get('ports') or []) == 2), None)
    if plain is None:
        return
    guide.new_page('Joining printed track', section='Assembly')
    guide.paragraph('Every plain printed piece joins its neighbours the same way: end to end, connector into '
                    'connector, rail tops level. Drawn: two of your pieces just before they meet.', colour=MUTED)
    start, end = plain['ports']
    angle = end['heading'] - start['heading']
    c, s = math.cos(angle), math.sin(angle)
    first = np.asarray(start['position'], float)
    target = np.asarray(end['position'], float)
    along = np.array([math.cos(end['heading']), math.sin(end['heading']), 0.])
    a = _place(plain, None, meshes, detail([plain]))
    gap = max(30., .45*float(np.ptp(a[0][:, 0])))
    offset = target - np.array([c*first[0]-s*first[1], s*first[0]+c*first[1], first[2]]) + along*gap
    b = _place(plain, (angle, offset), meshes, detail([plain]))
    above = np.array([0., 0., float(a[0][:, 2].max()) + 12.])
    illustration(guide, [(*a, PRINTED), (*b, '#f0a46a')], ['', ''], 90.,
                 arrow=(target + along*(gap-4) + above, target + along*4 + above))
    guide.subheading('Steps', 11)
    guide.steps(steps)


def _hardware_and_steps(guide: Guide, hardware: list[dict], steps: list[str], title: str = 'Hardware'):
    guide.subheading(title, 11)
    if hardware:
        guide.bullets([f'{row["quantity"]} × {row["name"]}' for row in hardware])
    else:
        guide.paragraph('No bought parts.')
    if steps:
        guide.subheading('Steps', 11)
        guide.steps(steps)


def cover(guide: Guide, receipt: dict, manifest: dict | None, numbered: list[Piece], when: datetime) -> Page:
    page = Page(guide, None)
    printer = receipt['printer']
    page.text(MARGIN, 262, 'ASSEMBLY GUIDE', 11, colour=PRINTED, weight='bold')
    name = manifest['project']['name'] if manifest else ('Calibration sample' if any(
        part['family'] in ('brick_end_coupon', 'connector_coupon') for part in receipt['parts']) else 'Trial parts')
    lines = wrap(name, WIDTH, 30)[:3]
    y = 252
    for line in lines:
        page.text(MARGIN, y, line, 30, weight='bold')
        y -= 13
    processes = sorted({plate.get('process') or printer['profile'] for plate in receipt['plates']})
    fast = any(piece.fast for piece in numbered)
    detailed = any(not piece.fast for piece in numbered)
    style = ('Detailed and fast' if fast and detailed else 'Fast' if fast else 'Detailed')
    seconds = sum(map(_plate_seconds, receipt['plates']))
    grams = sum(map(_plate_grams, receipt['plates']))
    facts = [('Printer', f'{printer["name"]} · {printer["nozzleMm"]:g} mm nozzle · {printer["material"]}'),
             ('Style', f'{style} · {", ".join(processes)}'),
             ('Prepared', when.strftime('%-d %B %Y, %H:%M')),
             ('Printed pieces', ' + '.join(filter(None, (
                 f'{sum(not piece.support for piece in numbered)} pieces',
                 f'{sum(piece.support for piece in numbered)} supports' if any(piece.support for piece in numbered) else '')))
              + f' ({len(receipt["parts"])} printed parts)'),
             ('Plates', str(len(receipt['plates']))),
             ('Print time', _duration(seconds) if seconds else 'not estimated'),
             ('Filament', f'{grams:.0f} g of {printer["material"]}' if grams else 'not estimated')]
    y -= 6
    for label, value in facts:
        page.text(MARGIN, y, label, 10, colour=MUTED)
        rows = wrap(value, WIDTH-45, 11)
        for row in rows:
            page.text(MARGIN+45, y, row, 11)
            y -= 6.2
        y -= 1.6
    y -= 6
    page.text(MARGIN, y, 'Contents', 12, weight='bold')
    y -= 8
    for title, number in guide.contents:
        page.text(MARGIN, y, title, 10.5)
        page.text(PAGE[0]-MARGIN, y, str(number + 1), 10.5, ha='right')
        page.ax.plot([MARGIN+len(title)*2.1+4, PAGE[0]-MARGIN-10], [y-2.6, y-2.6], color=RULE, lw=.5, ls=(0, (1, 2)))
        y -= 7
    for index, row in enumerate(wrap('Digitally prepared and sliced; nothing here has been printed or test-fitted yet. '
                                     'Start with the physical trial on the last page.', WIDTH, 8.5)):
        page.text(MARGIN, 32 - index*4.6, row, 8.5, colour=MUTED)
    return page


def community_items(parts: list[dict]) -> list[dict]:
    """The community library items these receipt parts print (R19), once each in part order: the item's library entry
    (`id`, `version`, `name`, `licence`, `credit`) and `pieces`, the codes of the pieces made from it."""
    items: dict[str, dict] = {}
    for part in parts:
        if part.get('library'):
            item = items.setdefault(part['library']['id'], {**part['library'], 'pieces': []})
            if part['piece'] not in item['pieces']:
                item['pieces'].append(part['piece'])
    return list(items.values())


def closing(guide: Guide, before: list[str], community: list[dict]):
    guide.new_page('Physical trial and credits', section='Physical trial and credits')
    guide.subheading('Before you build: print the calibration sample', 12)
    guide.paragraph('These plates are checked digitally only. Print the calibration sample first (Print → Connector '
                    'calibration → Generate calibration sample), let it cool, remove its supports and gently connect '
                    'each end to your own track. Report Too tight, Fits or Too loose in Print; if it is not a good fit, '
                    'pick a looser or tighter fit adjustment, test again and prepare the plates again.')
    guide.paragraph('A good fit on the sample is a good start, not a guarantee: still test-fit one printed joint and '
                    'run a wagon over every route before final assembly.')
    if before:
        guide.subheading('Before you run trains', 11)
        guide.steps(before)
    guide.subheading('Credits', 12)
    guide.bullets([
        'Prepared with Plateway. Plates were sliced on your computer with Bambu Studio and its bundled '
        'printer, filament and process profiles; drawings are rendered from this package’s own meshes.',
        'Track geometry adapted from a straight rerailer by lev (Printables #466240, '
        'https://www.printables.com/model/466240), CC BY 4.0 (creativecommons.org/licenses/by/4.0). '
        'Changes: its connector ends are cut, re-joined and given new rails, ties and brick studs.',
        'Text set in DejaVu Sans (Bitstream Vera licence); drawn with matplotlib.'])
    if community:
        guide.subheading('Community pieces', 11)
        guide.paragraph('From the Plateway community library, printed exactly as uploaded: print style and fit '
                        'adjustment don’t apply to them. Credit their makers when you share them.')
        guide.bullets([f'{item["name"]} (piece{"s" if len(item["pieces"]) > 1 else ""} {", ".join(item["pieces"])}): '
                       f'by {item["credit"]}, licensed {item["licence"]}. Library item {item["id"]}, version '
                       f'{item["version"]}.' for item in community])


def build(read: Reader, receipt: dict, manifest: dict | None, shopping_result: dict | None,
          before: list[str], guide_markdown: str, reference: str = '', when: datetime | None = None) -> bytes:
    """The whole assembly-guide PDF for a package whose artefacts `read` returns. `guide_markdown`: the package's
    print-and-build text (its numbered steps join plain track; its sections close the PDF as reference notes, after
    the markdown `reference` sections such as accessory tables and automation devices). A layout prepared in parts
    (`layoutParts` in its receipt) gets a page listing every part."""
    when = when or datetime.now().astimezone()
    with matplotlib.rc_context({'pdf.fonttype': 42, 'font.family': 'DejaVu Sans', 'pdf.compression': 9}):
        title = manifest['project']['name'] if manifest else 'Trial parts'
        guide = Guide(title)
        meshes = Meshes(read)
        numbered = pieces(receipt)
        if manifest is not None:
            overview(guide, meshes, manifest, numbered)
            shopping(guide, shopping_result)
        if receipt.get('layoutParts'):
            layout_parts(guide, receipt)
        plates(guide, receipt, read)
        assembly_pages(guide, receipt, meshes)
        sections = guide_markdown.split('\n## ', 1)
        if len(sections) == 2:
            joining_page(guide, receipt, meshes, numbered_steps(sections[0]))
        notes = '\n\n'.join(filter(None, (reference, '## ' + sections[1] if len(sections) == 2 else guide_markdown)))
        if notes.strip():
            guide.new_page('Reference notes', section='Reference notes')
            markdown(guide, notes)
        closing(guide, before, community_items(receipt['parts']))
        return guide.finish(cover(guide, receipt, manifest, numbered, when))


INLINE = re.compile(r'\*\*(.+?)\*\*|\*(.+?)\*|`(.+?)`')
TABLE_RULE = re.compile(r'\|?[\s:|-]+\|?')


def plain(value: str) -> str:
    """Markdown inline emphasis and code as plain text."""
    return INLINE.sub(lambda match: next(group for group in match.groups() if group is not None), value).strip()


def markdown(guide: Guide, text: str):
    """Headings, paragraphs, bullet and numbered lists, quotes and pipe tables of a markdown guide."""
    lines = text.splitlines()
    index = 0

    def run(pattern: str) -> list[str]:
        nonlocal index
        items = []
        while index < len(lines) and re.match(pattern, lines[index]):
            items.append(plain(re.sub(pattern, '', lines[index], count=1)))
            index += 1
        return items

    while index < len(lines):
        line = lines[index].rstrip()
        heading = re.match(r'(#{1,6})\s+(.*)', line)
        if not line.strip():
            index += 1
        elif heading:
            guide.subheading(plain(heading.group(2)), (13., 11.5, 10.5)[min(len(heading.group(1)), 3)-1])
            index += 1
        elif line.startswith('|'):
            block = []
            while index < len(lines) and lines[index].startswith('|'):
                block.append(lines[index].strip())
                index += 1
            rows = [[plain(cell) for cell in row.strip('|').split('|')] for row in block if not TABLE_RULE.fullmatch(row)]
            longest = [max(len(row[column]) if column < len(row) else 0 for row in rows) + 3 for column in range(len(rows[0]))]
            widths = [WIDTH*min(max(length, 6), 60)/sum(min(max(item, 6), 60) for item in longest) for length in longest]
            guide.table(list(zip(rows[0], widths)), [row + ['']*(len(widths)-len(row)) for row in rows[1:]], 8)
        elif re.match(r'[-*]\s+', line):
            guide.bullets(run(r'[-*]\s+'), 9)
        elif re.match(r'\d+\.\s+', line):
            guide.steps(run(r'\d+\.\s+'), 9)
        elif line.startswith('>'):
            guide.paragraph(' '.join(run(r'>\s*')), 9, weight='bold')
        else:
            paragraph = []
            while index < len(lines) and lines[index].strip() and not re.match(r'(#|\||[-*]\s|\d+\.\s|>)', lines[index]):
                paragraph.append(lines[index].strip())
                index += 1
            guide.paragraph(plain(' '.join(paragraph)), 9)


def numbered_steps(text: str) -> list[str]:
    """The first numbered list of a markdown guide, as plain text."""
    steps = []
    for line in text.splitlines():
        match = re.match(r'\d+\.\s+(.*)', line)
        if match:
            steps.append(plain(match.group(1)))
        elif steps and line.strip():
            break
    return steps
