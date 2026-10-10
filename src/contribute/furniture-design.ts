import type { FurniturePanel, FurnitureSurface, FurnitureType, SurfaceEntry } from '../domain/furniture';

/**
 * The furniture form's inputs (R17): an outline, level surfaces each at a height, an optional cubby grid, a colour.
 * `furnitureFromDesign` turns them into the `FurnitureType` the library stores and cad/library/check.py validates.
 */
export interface FurnitureDesign {
  width: number;
  depth: number;
  surfaces: { name: string; height: number }[];
  /** No grid while rows or columns is 0. `opening`: each cubby's square opening (mm). */
  cubbies: { rows: number; cols: number; opening: number };
  /** `#rrggbb`. */
  colour: string;
}

/** Board thickness of every surface, shelf and cubby wall (mm). */
export const BOARD = 18;
const LEG = 50;
export const DESIGN_LIMITS = { size: [100, 10_000], height: [20, 3000], surfaces: 12, cells: 10, opening: [100, 1000] } as const;
export const DEFAULT_DESIGN: FurnitureDesign = {
  width: 1200, depth: 600, surfaces: [{ name: 'top', height: 740 }], cubbies: { rows: 0, cols: 0, opening: 335 }, colour: '#b89470'
};

type Point = { x: number; y: number };
const rectangle = (x0: number, y0: number, x1: number, y1: number): Point[] => [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];
/** The cubby grid's outer size (mm): openings and the boards around and between them. */
export const gridSize = ({ rows, cols, opening }: FurnitureDesign['cubbies']) =>
  rows > 0 && cols > 0 ? { width: cols * opening + (cols + 1) * BOARD, height: rows * opening + (rows + 1) * BOARD } : null;
const inRange = (value: number, [low, high]: readonly [number, number]) => Number.isFinite(value) && value >= low && value <= high;
const mm = (value: number) => `${value.toLocaleString('en-GB')} mm`;

/** Why the form can't make a furniture preset yet, or null. */
export function designProblem(design: FurnitureDesign): string | null {
  const { width, depth, surfaces, cubbies } = design;
  if (!inRange(width, DESIGN_LIMITS.size) || !inRange(depth, DESIGN_LIMITS.size)) return `The width and depth must be ${mm(DESIGN_LIMITS.size[0])} to ${mm(DESIGN_LIMITS.size[1])}.`;
  if (surfaces.length > DESIGN_LIMITS.surfaces) return `At most ${DESIGN_LIMITS.surfaces} surfaces.`;
  for (const surface of surfaces) {
    if (!inRange(surface.height, DESIGN_LIMITS.height)) return `Surface heights must be ${mm(DESIGN_LIMITS.height[0])} to ${mm(DESIGN_LIMITS.height[1])}.`;
  }
  if (![cubbies.rows, cubbies.cols].every(count => Number.isInteger(count) && count >= 0 && count <= DESIGN_LIMITS.cells))
    return `Cubby rows and columns are whole numbers up to ${DESIGN_LIMITS.cells} (0 for no grid).`;
  if (cubbies.rows > 0 !== cubbies.cols > 0) return 'A cubby grid needs both rows and columns.';
  const grid = gridSize(cubbies);
  if (grid && !inRange(cubbies.opening, DESIGN_LIMITS.opening)) return `Cubby openings are ${mm(DESIGN_LIMITS.opening[0])} to ${mm(DESIGN_LIMITS.opening[1])}.`;
  if (grid && grid.width > width) return `The cubby grid is ${mm(grid.width)} wide, wider than the ${mm(width)} outline.`;
  const below = grid && surfaces.find(surface => surface.height < grid.height);
  if (below) return `The surface “${below.name || 'surface'}” at ${mm(below.height)} cuts through the ${mm(grid!.height)} tall cubby grid.`;
  if (!surfaces.length && !grid) return 'Add a surface or a cubby grid for track to run on.';
  return null;
}

/** The preset the design describes, as data: each surface a full-outline board on four corner legs, the cubby grid a
 * shell of boards from the floor with a floor surface per cubby, entered through its front or back opening. */
export function furnitureFromDesign(design: FurnitureDesign, label: string, family: string): FurnitureType {
  const { width, depth, cubbies } = design, left = -width / 2, right = width / 2, front = -depth / 2, back = depth / 2;
  const surfaces: FurnitureSurface[] = [], panels: FurniturePanel[] = [], lines: { a: Point; b: Point }[] = [];
  const sides = (x0: number, x1: number): SurfaceEntry[] => [
    { id: 'front', a: { x: x0, y: front }, b: { x: x1, y: front }, heading: Math.PI / 2 },
    { id: 'back', a: { x: x0, y: back }, b: { x: x1, y: back }, heading: -Math.PI / 2 }];
  const grid = gridSize(cubbies);
  if (grid) {
    const { rows, cols, opening } = cubbies, x0 = -grid.width / 2, pitch = opening + BOARD;
    const board = (x: number, z: number, w: number, h: number) => panels.push({ x, y: 0, z, width: w, depth, height: h });
    board(x0 + BOARD / 2, grid.height / 2, BOARD, grid.height); board(-x0 - BOARD / 2, grid.height / 2, BOARD, grid.height);
    board(0, BOARD / 2, grid.width - 2 * BOARD, BOARD); board(0, grid.height - BOARD / 2, grid.width - 2 * BOARD, BOARD);
    for (let row = 1; row < rows; row++) board(0, row * pitch + BOARD / 2, grid.width - 2 * BOARD, BOARD);
    for (let col = 1; col < cols; col++) {
      const x = x0 + col * pitch + BOARD / 2;
      lines.push({ a: { x, y: front + BOARD }, b: { x, y: back - BOARD } });
      for (let row = 0; row < rows; row++) board(x, BOARD + row * pitch + opening / 2, BOARD, opening);
    }
    for (let row = 1; row <= rows; row++) for (let col = 1; col <= cols; col++) {
      const cx0 = x0 + BOARD + (col - 1) * pitch;
      surfaces.push({ id: `cubby-${row}-${col}`, name: 'cubby floor', height: BOARD + (row - 1) * pitch, cell: { row, col },
        footprint: rectangle(cx0, front, cx0 + opening, back), entries: sides(cx0, cx0 + opening) });
    }
  }
  design.surfaces.forEach((surface, index) => {
    surfaces.push({ id: `surface-${index + 1}`, name: surface.name.trim() || 'surface', height: surface.height,
      footprint: rectangle(left, front, right, back), entries: [...sides(left, right),
        { id: 'left', a: { x: left, y: front }, b: { x: left, y: back }, heading: 0 },
        { id: 'right', a: { x: right, y: front }, b: { x: right, y: back }, heading: Math.PI }] });
    panels.push({ x: 0, y: 0, z: surface.height - BOARD / 2, width, depth, height: BOARD });
  });
  const highest = Math.max(0, ...design.surfaces.map(surface => surface.height));
  if (highest > (grid?.height ?? 0)) {
    const legHeight = highest - BOARD;
    for (const x of [left + LEG / 2, right - LEG / 2]) for (const y of [front + LEG / 2, back - LEG / 2])
      panels.push({ x, y, z: legHeight / 2, width: LEG, depth: LEG, height: legHeight });
  }
  const height = Math.max(highest, grid?.height ?? 0);
  return { family, label, width, depth, height, surfaces, panels, orientations: [0, 1, 2, 3],
    colour: Number.parseInt(design.colour.slice(1), 16) || 0, plan: { lines, caption: label },
    terms: `${label.toLowerCase()} community furniture`, description: `${label} ${width} by ${depth}` };
}
