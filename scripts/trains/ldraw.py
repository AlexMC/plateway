"""Minimal LDraw reader: MPD/LDR parsing, part flattening to coloured triangles.

LDraw units are LDU (1 LDU = 0.4 mm), -Y is up. Only line types 1 (sub-file), 3 and 4
(triangle, quad) are used; edge lines (2, 5) are not geometry. Colour 16 inherits the
parent colour. Low-resolution primitives (p/8) are preferred to keep meshes light, and
stud primitives are skipped (studs are the first detail dropped for the browser assets).
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

LDU = 0.4  # mm
MAIN_COLOUR = 16
EDGE_COLOUR = 24
# Stud, stud-tube and logo primitives: the details we drop first (contract: "drop studs").
# Studs, grouped studs and underside tubes (stud*, stug*, stu2*, ...) and logos: no visual value at
# layout scale and the bulk of a brick's triangles.
SKIP_PRIMITIVE = re.compile(r'^(stu|logo|8/stu|48/stu)[^\\/]*\.dat$', re.I)


@dataclass
class Colour:
    rgb: tuple[float, float, float]
    alpha: float = 1.0


def load_colours(lib: Path) -> dict[int, Colour]:
    colours: dict[int, Colour] = {}
    for line in (lib / 'LDConfig.ldr').read_text(errors='replace').splitlines():
        m = re.match(r'\s*0\s+!COLOUR\s+(\S+)\s+CODE\s+(\d+)\s+VALUE\s+#([0-9A-Fa-f]{6})(.*)', line)
        if not m:
            continue
        code = int(m.group(2))
        hexv = m.group(3)
        alpha = re.search(r'ALPHA\s+(\d+)', m.group(4))
        colours[code] = Colour(tuple(int(hexv[i:i + 2], 16) / 255 for i in (0, 2, 4)),
                               int(alpha.group(1)) / 255 if alpha else 1.0)
    return colours


@dataclass
class Ref:
    """A type-1 line: colour, 4x4 transform (LDU), referenced file name (normalised)."""
    colour: int
    matrix: np.ndarray
    name: str


@dataclass
class LFile:
    name: str
    header: list[str] = field(default_factory=list)
    refs: list[Ref] = field(default_factory=list)
    tris: np.ndarray = field(default_factory=lambda: np.zeros((0, 3, 3)))  # LDU
    tri_colours: np.ndarray = field(default_factory=lambda: np.zeros(0, dtype=np.int64))


def norm_name(name: str) -> str:
    return name.strip().replace('\\', '/').lower()


def parse_lines(name: str, lines: list[str]) -> LFile:
    f = LFile(norm_name(name))
    tris: list[list[list[float]]] = []
    cols: list[int] = []
    for raw in lines:
        parts = raw.split()
        if not parts:
            continue
        kind = parts[0]
        if kind == '0':
            f.header.append(raw.strip())
        elif kind == '1' and len(parts) >= 15:
            v = [float(x) for x in parts[2:14]]
            m = np.array([[v[3], v[4], v[5], v[0]], [v[6], v[7], v[8], v[1]], [v[9], v[10], v[11], v[2]], [0, 0, 0, 1]])
            # The file name may contain spaces (MPD submodels): it is everything after the 14th token.
            fname = raw.strip().split(None, 14)[14]
            f.refs.append(Ref(colour_code(parts[1]), m, norm_name(fname)))
        elif kind == '3' and len(parts) >= 11:
            p = [float(x) for x in parts[2:11]]
            tris.append([p[0:3], p[3:6], p[6:9]])
            cols.append(colour_code(parts[1]))
        elif kind == '4' and len(parts) >= 14:
            p = [float(x) for x in parts[2:14]]
            a, b, c, d = p[0:3], p[3:6], p[6:9], p[9:12]
            tris.append([a, b, c])
            tris.append([a, c, d])
            cols += [colour_code(parts[1])] * 2
    if tris:
        f.tris = np.array(tris, dtype=np.float64)
        f.tri_colours = np.array(cols, dtype=np.int64)
    return f


def colour_code(token: str) -> int:
    if token.lower().startswith('0x2'):
        return 0x2000000 + int(token[3:], 16)  # direct colour 0x2RRGGBB
    try:
        return int(token)
    except ValueError:
        return MAIN_COLOUR


def parse_mpd(path: Path) -> tuple[list[str], dict[str, LFile]]:
    """Return (ordered submodel names, files). A plain .ldr is a single-file MPD."""
    text = path.read_text(errors='replace').splitlines()
    order: list[str] = []
    files: dict[str, LFile] = {}
    current: str | None = None
    buf: list[str] = []

    def flush() -> None:
        if current is not None:
            files[norm_name(current)] = parse_lines(current, buf)
            order.append(norm_name(current))

    for line in text:
        s = line.strip()
        if s.startswith('0 FILE '):
            flush()
            current, buf = s[7:].strip(), []
        elif s.startswith('0 NOFILE'):
            flush()
            current, buf = None, []
        elif current is not None:
            buf.append(line)
        elif not files and current is None:
            current, buf = path.name, [line]
    flush()
    return order, files


class Library:
    def __init__(self, root: Path):
        self.root = root
        self.colours = load_colours(root)
        self.cache: dict[str, LFile | None] = {}
        self.flat_cache: dict[str, tuple[np.ndarray, np.ndarray]] = {}
        # Files embedded in the model being processed (MPD-local parts); reset per model.
        self.embedded: dict[str, LFile] = {}
        self.embedded_flat: dict[str, tuple[np.ndarray, np.ndarray]] = {}

    def use_model(self, files: dict[str, LFile]) -> None:
        self.embedded = files
        self.embedded_flat = {}

    def lookup(self, name: str) -> LFile | None:
        if name.endswith('#tris'):
            return self.embedded.get(name[:-5])
        if name in self.embedded:
            return self.embedded[name]
        if name in self.cache:
            return self.cache[name]
        candidates = [self.root / 'p' / '8' / name, self.root / 'parts' / name, self.root / 'p' / name,
                      self.root / 'models' / name]
        found = None
        for c in candidates:
            if c.is_file():
                found = parse_lines(name, c.read_text(errors='replace').splitlines())
                break
        self.cache[name] = found
        return found

    def description(self, name: str) -> str:
        f = self.lookup(name)
        if not f or not f.header:
            return ''
        return f.header[0][1:].strip()

    def flatten_part(self, name: str) -> tuple[np.ndarray, np.ndarray]:
        """All triangles of a library file in its own frame; colour 16 kept as placeholder."""
        local = name.endswith('#tris') or name in self.embedded
        cache = self.embedded_flat if local else self.flat_cache
        if name in cache:
            return cache[name]
        f = self.lookup(name)
        if f is None:
            out = (np.zeros((0, 3, 3)), np.zeros(0, dtype=np.int64))
            cache[name] = out
            return out
        tris = [f.tris]
        cols = [f.tri_colours]
        for r in ([] if name.endswith('#tris') else f.refs):
            if SKIP_PRIMITIVE.match(r.name):
                continue
            t, c = self.flatten_part(r.name)
            if len(t) == 0:
                continue
            tris.append(transform(t, r.matrix))
            cols.append(np.where(c == MAIN_COLOUR, r.colour, c))
        out = (np.concatenate(tris), np.concatenate(cols))
        cache[name] = out
        return out


def transform(tris: np.ndarray, m: np.ndarray) -> np.ndarray:
    return tris @ m[:3, :3].T + m[:3, 3]


@dataclass
class PartInstance:
    name: str            # library file name, e.g. '2878c01.dat'; '<submodel>#tris' for a submodel's own faces
    colour: int
    matrix: np.ndarray   # 4x4 to the root model frame, LDU
    path: tuple[str, ...]  # submodel chain from the root


def walk(files: dict[str, LFile], root: str, matrix: np.ndarray | None = None,
         colour: int = MAIN_COLOUR, path: tuple[str, ...] = (), _counter: list[int] | None = None) -> list[PartInstance]:
    """Expand submodels of an MPD into part instances in the root frame.

    `path` entries are '<submodel name>@<n>' with n unique per submodel instance, so two placements
    of the same submodel (e.g. a bogie used twice) stay distinguishable. Embedded .dat files
    (unofficial/MPD-local parts) are parts; other embedded files are submodels."""
    matrix = np.eye(4) if matrix is None else matrix
    counter = [0] if _counter is None else _counter
    out: list[PartInstance] = []
    f = files[root]
    if len(f.tris):
        out.append(PartInstance(root + '#tris', colour, matrix, path))
    for r in f.refs:
        m = matrix @ r.matrix
        c = colour if r.colour == MAIN_COLOUR else r.colour
        if r.name in files and not r.name.endswith('.dat'):
            counter[0] += 1
            out += walk(files, r.name, m, c, path + (f'{r.name}@{counter[0]}',), counter)
        else:
            out.append(PartInstance(r.name, c, m, path))
    return out
