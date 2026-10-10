import { KALLAX_5X5, isObject, validNumber, type Furniture, type LibraryOrigin } from './project';

type Point = { x: number; y: number };
type QuarterTurns = Furniture['quarterTurns'];
/** Where track can come onto a surface: an edge `a`–`b` and the heading (radians) that crosses it into the surface. */
export interface SurfaceEntry { id: string; a: Point; b: Point; heading: number }
/**
 * A level surface of a furniture type that track can run on, in the furniture frame (floor-plan centre at the origin,
 * unturned; mm, +x right, +y towards the back): its height above the floor, its outline and its entry edges.
 * `cell` places a grid surface (a cubby) by row (from the bottom) and column (from the left as seen from the front).
 */
export interface FurnitureSurface { id: string; name: string; height: number; footprint: Point[]; entries: SurfaceEntry[]; cell?: { row: number; col: number } }
/** A solid board of a furniture type, as a box in the furniture frame: its centre (z up from the floor) and its size (mm). */
export interface FurniturePanel { x: number; y: number; z: number; width: number; depth: number; height: number }
/**
 * A furniture type, all data: its outline (a `width` × `depth` floor rectangle centred on the item, `height` tall), the
 * surfaces track can reach (cubby floors or tops) and the panels track must keep clear of, the quarter turns it may
 * stand at (in the order R steps through them), its colour in 3D, how the top view draws it, and its palette words.
 * `placeholder` marks the stand-in for a family this browser does not know: no surfaces, no panels.
 */
export interface FurnitureType {
  family: string;
  label: string;
  width: number;
  depth: number;
  height: number;
  surfaces: readonly FurnitureSurface[];
  panels: readonly FurniturePanel[];
  orientations: readonly QuarterTurns[];
  /** 0xRRGGBB. */
  colour: number;
  /** Top view: lines drawn inside the outline and the caption across it. */
  plan: { lines: readonly { a: Point; b: Point }[]; caption: string };
  /** Palette: more search words, and what its tile adds (its accessible name is "Add …"). */
  terms: string;
  description: string;
  /** Checks and plans name items of this type `${prefix}1`, `${prefix}2`… in project order; else `${label} 1`… */
  prefix?: string;
  placeholder?: true;
  /** A community preset: its library index entry and provenance (KTD9). A retired one still opens in layouts but has no tile. */
  community?: LibraryOrigin;
}

const rectangle = (x0: number, y0: number, x1: number, y1: number): Point[] => [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];

/** KALLAX 5×5: 25 cubby floors, entered through the front or back opening, and its top, entered from any side. */
function kallax(): FurnitureType {
  const { width, depth, height, opening, outer, inner } = KALLAX_5X5, front = -depth / 2, back = depth / 2;
  const cubbies = Array.from({ length: 25 }, (_, index): FurnitureSurface => {
    const row = Math.floor(index / 5) + 1, col = index % 5 + 1, x0 = -width / 2 + outer + (col - 1) * (opening + inner), x1 = x0 + opening;
    return { id: `cubby-${row}-${col}`, name: 'cubby floor', height: outer + (row - 1) * (opening + inner), cell: { row, col },
      footprint: rectangle(x0, front, x1, back),
      entries: [{ id: 'front', a: { x: x0, y: front }, b: { x: x1, y: front }, heading: Math.PI / 2 },
        { id: 'back', a: { x: x0, y: back }, b: { x: x1, y: back }, heading: -Math.PI / 2 }] };
  });
  const left = -width / 2, right = width / 2;
  // The shell, four shelves and twenty dividers form 25 open-through bays without intersecting boards.
  const panels: FurniturePanel[] = [];
  const panel = (x: number, z: number, w: number, h: number) => panels.push({ x, y: 0, z, width: w, depth, height: h });
  panel(-width / 2 + outer / 2, height / 2, outer, height); panel(width / 2 - outer / 2, height / 2, outer, height);
  panel(0, outer / 2, width - 2 * outer, outer); panel(0, height - outer / 2, width - 2 * outer, outer);
  const dividers: number[] = [];
  for (let bay = 1; bay < 5; bay++) {
    const offset = outer + bay * opening + (bay - 0.5) * inner;
    dividers.push(-width / 2 + offset);
    panel(0, offset, width - 2 * outer, inner);
    for (let row = 0; row < 5; row++) panel(-width / 2 + offset, outer + row * (opening + inner) + opening / 2, inner, opening);
  }
  return { family: 'kallax_5x5', label: 'KALLAX 5×5', width, depth, height, surfaces: [...cubbies, {
    id: 'top', name: 'top', height, footprint: rectangle(left, front, right, back),
    entries: [{ id: 'front', a: { x: left, y: front }, b: { x: right, y: front }, heading: Math.PI / 2 },
      { id: 'back', a: { x: left, y: back }, b: { x: right, y: back }, heading: -Math.PI / 2 },
      { id: 'left', a: { x: left, y: front }, b: { x: left, y: back }, heading: 0 },
      { id: 'right', a: { x: right, y: front }, b: { x: right, y: back }, heading: Math.PI }] }],
  panels, orientations: [0, 1, 2, 3], colour: 0xe4e3dc,
  plan: { lines: dividers.map(x => ({ a: { x, y: front + 18 }, b: { x, y: back - 18 } })), caption: 'KALLAX 5×5 · upright' },
  terms: 'kallax_5x5 shelf shelving ikea room', description: 'KALLAX 5 by 5 shelving unit', prefix: 'K' };
}

/** Every furniture type the room can hold, in palette order: the built-in presets, then any registered at run time. */
const TYPES = new Map<string, FurnitureType>([['kallax_5x5', kallax()]]);

/** Adds a furniture preset (or replaces one of the same family); its tile joins the Furniture group unless it is retired. */
export function registerFurnitureType(type: FurnitureType): void {
  TYPES.set(type.family, type);
}

/** Removes a preset registered at run time (a contribution's live preview). */
export function unregisterFurnitureType(family: string): void {
  TYPES.delete(family);
}

/** The registered furniture types, in palette order. */
export function furnitureTypes(): FurnitureType[] {
  return [...TYPES.values()];
}

/** Stand-in size for a family this browser does not know (mm). */
const PLACEHOLDER_SIZE = 400;
/**
 * The type of `family`; a family not registered here (a preset from a newer library, say) gets a placeholder: a plain
 * outline the user can see, move or delete, with no surfaces and no panels, so the item opens and saves unchanged.
 */
export function furnitureType(family: string): FurnitureType {
  return TYPES.get(family) ?? { family, label: 'Unknown furniture', width: PLACEHOLDER_SIZE, depth: PLACEHOLDER_SIZE,
    height: PLACEHOLDER_SIZE, surfaces: [], panels: [], orientations: [0, 1, 2, 3], colour: 0x9aa39f,
    plan: { lines: [], caption: 'Unknown furniture' }, terms: family, description: `unknown furniture ${family}`, placeholder: true };
}

/** A point `{ x, y }` (mm) in a furniture type's data. */
const validPoint = (value: unknown) => isObject(value) && validNumber(value.x) && validNumber(value.y);
/** A non-empty name or id in a furniture type's data. */
const validText = (value: unknown) => typeof value === 'string' && value.length > 0 && value.length <= 200;
/**
 * Whether `value` is a whole furniture type as data (a library preset, KTD9): every field the room, checks and drawings
 * read, of the right kind. It may not claim to be a placeholder or a community item; the library adds that.
 */
export function validFurnitureType(value: unknown): value is FurnitureType {
  if (!isObject(value) || 'placeholder' in value || 'community' in value) return false;
  const { family, label, width, depth, height, surfaces, panels, orientations, colour, plan, terms, description, prefix } = value;
  return validText(family) && validText(label) && [width, depth, height].every(size => validNumber(size) && size > 0) &&
    Array.isArray(surfaces) && surfaces.every(surface => isObject(surface) && validText(surface.id) && typeof surface.name === 'string' &&
      validNumber(surface.height) && Array.isArray(surface.footprint) && surface.footprint.length >= 3 && surface.footprint.every(validPoint) &&
      Array.isArray(surface.entries) && surface.entries.every(entry => isObject(entry) && validText(entry.id) && validPoint(entry.a) &&
        validPoint(entry.b) && validNumber(entry.heading)) &&
      (surface.cell === undefined || isObject(surface.cell) && Number.isInteger(surface.cell.row) && Number.isInteger(surface.cell.col))) &&
    Array.isArray(panels) && panels.every(panel => isObject(panel) && validNumber(panel.x) && validNumber(panel.y) && validNumber(panel.z) &&
      [panel.width, panel.depth, panel.height].every(size => validNumber(size) && size > 0)) &&
    Array.isArray(orientations) && orientations.length > 0 && new Set(orientations).size === orientations.length &&
    orientations.every(turns => [0, 1, 2, 3].includes(turns)) &&
    typeof colour === 'number' && Number.isInteger(colour) && colour >= 0 && colour <= 0xffffff &&
    isObject(plan) && Array.isArray(plan.lines) && plan.lines.every(line => isObject(line) && validPoint(line.a) && validPoint(line.b)) &&
    typeof plan.caption === 'string' && typeof terms === 'string' && validText(description) && (prefix === undefined || validText(prefix));
}

/** A surface entry of a placed piece of furniture, in the room frame. */
export interface PlacedEntry { furniture: Furniture; type: FurnitureType; surface: FurnitureSurface; entry: SurfaceEntry; a: Point; b: Point; heading: number }
/** Every surface entry of `furniture` (a room's), turned and placed. */
export function placedEntries(furniture: readonly Furniture[]): PlacedEntry[] {
  return furniture.flatMap(furniture => {
    const type = furnitureType(furniture.family), angle = furniture.quarterTurns * Math.PI / 2, c = Math.cos(angle), s = Math.sin(angle);
    const place = (point: Point) => ({ x: furniture.x + c * point.x - s * point.y, y: furniture.y + s * point.x + c * point.y });
    return type.surfaces.flatMap(surface => surface.entries.map(entry =>
      ({ furniture, type, surface, entry, a: place(entry.a), b: place(entry.b), heading: angle + entry.heading })));
  });
}

/** A point within this of a surface's outline is on it (mm): track ending at a cubby's opening rests on its floor. */
const EDGE = 0.5;
/** Whether `point` is inside `outline` or within EDGE of one of its edges. */
function onOutline(outline: readonly Point[], point: Point): boolean {
  let inside = false;
  for (let i = 0, j = outline.length - 1; i < outline.length; j = i++) {
    const a = outline[i], b = outline[j], dx = b.x - a.x, dy = b.y - a.y, length = dx * dx + dy * dy;
    const t = length ? Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / length)) : 0;
    if (Math.hypot(point.x - a.x - t * dx, point.y - a.y - t * dy) <= EDGE) return true;
    if ((a.y > point.y) !== (b.y > point.y) && point.x < a.x + (point.y - a.y) * dx / dy) inside = !inside;
  }
  return inside;
}

/**
 * The height of the highest surface of `furniture` (a room's) under `point` (room frame) at or below `z`, or null where
 * there is none: what track seated at `z` there rests on, and what a support under it stands on.
 */
export function surfaceBelow(furniture: readonly Furniture[], point: Point, z: number): number | null {
  let highest: number | null = null;
  for (const item of furniture) {
    const angle = item.quarterTurns * Math.PI / 2, c = Math.cos(angle), s = Math.sin(angle), dx = point.x - item.x, dy = point.y - item.y;
    const local = { x: c * dx + s * dy, y: c * dy - s * dx };
    for (const surface of furnitureType(item.family).surfaces) {
      if (surface.height <= z && (highest === null || surface.height > highest) && onOutline(surface.footprint, local)) highest = surface.height;
    }
  }
  return highest;
}

/**
 * The names Checks and plans give a project's furniture, in project order per family: `K1`, `K2`… for a type with a
 * prefix (KALLAX), else `Table 1`…
 */
export function furnitureNames(furniture: readonly Furniture[]): (item: Furniture) => string {
  return item => {
    const type = furnitureType(item.family), index = furniture.filter(other => other.family === item.family).indexOf(item) + 1;
    return type.prefix ? `${type.prefix}${index}` : `${type.label} ${index}`;
  };
}
