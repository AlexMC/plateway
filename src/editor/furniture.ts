import { furnitureType } from '../domain/furniture';
import { changeProject, type Furniture, type WorkshopProject } from '../domain/project';

type Point = { x: number; y: number };

/** Furniture stands on its floor-plan centre and turns about it: its type's outline at `quarterTurns`. */
export function furnitureFootprint(family: string, quarterTurns: Furniture['quarterTurns']) {
  const { width, depth } = furnitureType(family);
  return quarterTurns % 2 === 0 ? { width, depth } : { width: depth, depth: width };
}

/** The orientation after (`step` 1) or before (−1) `quarterTurns` among those the type offers. */
export function nextOrientation(family: string, quarterTurns: Furniture['quarterTurns'], step: 1 | -1 = 1): Furniture['quarterTurns'] {
  const { orientations } = furnitureType(family), index = orientations.indexOf(quarterTurns);
  return index < 0 ? orientations[0] : orientations[(index + step + orientations.length) % orientations.length];
}

/** Keep every corner on the planning floor; reject rooms that cannot hold the whole footprint. */
export function furniturePosition(project: WorkshopProject, point: Point, quarterTurns: Furniture['quarterTurns'], family = 'kallax_5x5'): Point {
  const roomWidth = project.measurements.roomWidth.value ?? 2400;
  const roomDepth = project.measurements.roomDepth.value ?? 2100;
  const { width, depth } = furnitureFootprint(family, quarterTurns);
  if (roomWidth < width || roomDepth < depth) {
    throw new Error(`${furnitureType(family).label} needs at least ${width} × ${depth} mm of room in this orientation.`);
  }
  return {
    x: Math.max(width / 2, Math.min(roomWidth - width / 2, point.x)),
    y: Math.max(depth / 2, Math.min(roomDepth - depth / 2, point.y))
  };
}

/** Places a `family` item (a KALLAX unless given) centred on `point`, kept inside the room. */
export function placeFurniture(project: WorkshopProject, point: Point, quarterTurns: Furniture['quarterTurns'], family = 'kallax_5x5'): [WorkshopProject, string] {
  const position = furniturePosition(project, point, quarterTurns, family);
  const id = crypto.randomUUID();
  return [changeProject(project, draft => {
    draft.furniture.push({ id, family, ...position, quarterTurns });
  }), id];
}

export function moveFurniture(project: WorkshopProject, id: string, point: Point): WorkshopProject {
  const item = project.furniture.find(candidate => candidate.id === id);
  if (!item) throw new Error('Selected furniture is no longer in this project.');
  const position = furniturePosition(project, point, item.quarterTurns, item.family);
  return changeProject(project, draft => {
    const target = draft.furniture.find(candidate => candidate.id === id)!;
    target.x = position.x;
    target.y = position.y;
  });
}

/** Turns the item to its type's next orientation, kept inside the room. */
export function rotateFurniture(project: WorkshopProject, id: string): WorkshopProject {
  const item = project.furniture.find(candidate => candidate.id === id);
  if (!item) throw new Error('Selected furniture is no longer in this project.');
  const quarterTurns = nextOrientation(item.family, item.quarterTurns);
  const position = furniturePosition(project, item, quarterTurns, item.family);
  return changeProject(project, draft => {
    const target = draft.furniture.find(candidate => candidate.id === id)!;
    Object.assign(target, position, { quarterTurns });
  });
}

export function removeFurniture(project: WorkshopProject, id: string): WorkshopProject {
  return changeProject(project, draft => {
    draft.furniture = draft.furniture.filter(item => item.id !== id);
  });
}
