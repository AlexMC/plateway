import { furnitureNames } from '../domain/furniture';
import { piecePaths, portsFromPaths } from '../domain/pieces';
import type { Furniture, RoutePiece, WorkshopProject } from '../domain/project';
import type { FitIssue } from '../domain/route';
import { area, furnitureFootprints, overlap, pieceFootprints, type Footprint } from '../domain/track-footprints';
import { MEASUREMENT_DEFAULTS } from '../editor/setup-defaults';
import type { Support } from './mounting';

/** Fit issue codes of the room check: track past a wall, track into a piece of furniture's panels. */
export const ROOM_CODES: readonly string[] = ['track-outside-room', 'track-into-shelf'];
/** Footprints may touch a wall within this, mm. */
const SLACK = 0.5;

export interface RoomSize { width: number; depth: number; measured: boolean }
/** Setup's room, else the default size the canvas draws; `measured` once the user has given both sides. */
export function roomSize(project: WorkshopProject): RoomSize {
  const { roomWidth, roomDepth } = project.measurements;
  return { width: roomWidth.value ?? MEASUREMENT_DEFAULTS.roomWidth!, depth: roomDepth.value ?? MEASUREMENT_DEFAULTS.roomDepth!,
    measured: [roomWidth, roomDepth].every(item => item.value !== null && item.status !== 'estimate') };
}

export interface Reach { minX: number; maxX: number; minY: number; maxY: number }
/** Track against one piece of furniture's panels: where it first hits (plan centre and the height band shared) and what runs in. */
export interface ShelfHit { furnitureId: string; families: string[]; pieceIds: string[]; x: number; y: number; bottom: number; top: number }
export interface RoomClashes {
  room: RoomSize;
  /** Pieces with a footprint past a wall, in the order checked. */
  outside: { pieceId: string; family: string }[];
  /** How far the checked track reaches: the room's rectangle grown to every footprint. */
  reach: Reach;
  /** Furniture name → its hit. */
  shelves: Map<string, ShelfHit>;
}

const piecePrints = (piece: RoutePiece, project: WorkshopProject): Footprint[] => {
  const paths = piecePaths(piece, project);
  return pieceFootprints(piece, project, paths, portsFromPaths(paths));
};
const past = (print: Pick<Reach, keyof Reach>, { width, depth }: RoomSize) =>
  print.minX < -SLACK || print.maxX > width + SLACK || print.minY < -SLACK || print.maxY > depth + SLACK;

/**
 * Track against the room (`roomSize`) and the furniture: footprints past a wall, or into a panel (a KALLAX's shell or
 * dividers, a table's legs or top). A track resting on a surface (a cubby floor, a top) stays clear of the panels, so
 * entering a cubby at its floor height passes. `pieceIds` limits the check (in that order) to those pieces; hits on
 * furniture of the same name merge.
 */
export function roomClashes(project: WorkshopProject, pieceIds?: readonly string[], shelfName: (shelf: Furniture) => string = furnitureNames(project.furniture)): RoomClashes {
  const room = roomSize(project), all = project.routes.flatMap(route => route.pieces);
  const byId = new Map(all.map(piece => [piece.id, piece]));
  const pieces = pieceIds ? pieceIds.map(id => byId.get(id)).filter((piece): piece is RoutePiece => !!piece) : all;
  const reach: Reach = { minX: 0, maxX: room.width, minY: 0, maxY: room.depth };
  const outside: RoomClashes['outside'] = [], shelves = new Map<string, ShelfHit>();
  const panels = project.furniture.map(shelf => ({ shelf, panels: furnitureFootprints(shelf) }));
  for (const piece of pieces) {
    let leaves = false;
    for (const print of piecePrints(piece, project)) {
      leaves ||= past(print, room);
      reach.minX = Math.min(reach.minX, print.minX); reach.maxX = Math.max(reach.maxX, print.maxX);
      reach.minY = Math.min(reach.minY, print.minY); reach.maxY = Math.max(reach.maxY, print.maxY);
      for (const { shelf, panels: footprints } of panels) for (const panel of footprints) {
        const shared = overlap(print, panel);
        if (!shared || area(shared) <= 0.1) continue;
        const name = shelfName(shelf);
        const hit = shelves.get(name) ?? { furnitureId: shelf.id, families: [], pieceIds: [], x: shared.reduce((sum, p) => sum + p.x, 0) / shared.length,
          y: shared.reduce((sum, p) => sum + p.y, 0) / shared.length, bottom: Math.max(print.bottom, panel.bottom), top: Math.min(print.top, panel.top) };
        if (!hit.families.includes(piece.family)) hit.families.push(piece.family);
        if (!hit.pieceIds.includes(piece.id)) hit.pieceIds.push(piece.id);
        shelves.set(name, hit);
      }
    }
    if (leaves) outside.push({ pieceId: piece.id, family: piece.family });
  }
  return { room, outside, reach, shelves };
}

/** Any of the piece's footprints past a wall of the room. */
export function pieceLeavesRoom(project: WorkshopProject, piece: RoutePiece): boolean {
  const room = roomSize(project);
  return piecePrints(piece, project).some(print => past(print, room));
}

/** `Track (families) leaves the W × D mm room: N mm past x = …`, naming every wall `reach` crosses. */
export function outsideMessage(families: readonly string[], reach: Reach, { width, depth }: RoomSize): string {
  const walls = [reach.minX < -SLACK && `${Math.round(-reach.minX)} mm past x = 0 (to x = ${Math.round(reach.minX)})`,
    reach.maxX > width + SLACK && `${Math.round(reach.maxX - width)} mm past x = ${width} (to x = ${Math.round(reach.maxX)})`,
    reach.minY < -SLACK && `${Math.round(-reach.minY)} mm past y = 0 (to y = ${Math.round(reach.minY)})`,
    reach.maxY > depth + SLACK && `${Math.round(reach.maxY - depth)} mm past y = ${depth} (to y = ${Math.round(reach.maxY)})`].filter(Boolean);
  return `Track (${[...new Set(families)].join(', ')}) leaves the ${width} × ${depth} mm room: ${walls.join(', ')}.`;
}

/** `Track (families) runs into K1's panels around (x, y) at z a–b mm.` */
export function shelfMessage(name: string, hit: ShelfHit): string {
  return `Track (${hit.families.join(', ')}) runs into ${name}'s panels around (${Math.round(hit.x)}, ${Math.round(hit.y)}) at z ${Math.round(hit.bottom)}–${Math.round(hit.top)} mm.`;
}

/**
 * The whole layout against the room, as fit issues: one `track-outside-room` over every piece (and support seat) past a
 * wall, and one `track-into-shelf` per shelf track runs into. The default room size counts too.
 */
export function roomIssues(project: WorkshopProject, supports: readonly Support[]): FitIssue[] {
  const { room, outside, reach, shelves } = roomClashes(project);
  const issues: FitIssue[] = [];
  const stray = supports.filter(support => past({ minX: support.pose.x, maxX: support.pose.x, minY: support.pose.y, maxY: support.pose.y }, room));
  for (const support of stray) {
    reach.minX = Math.min(reach.minX, support.pose.x); reach.maxX = Math.max(reach.maxX, support.pose.x);
    reach.minY = Math.min(reach.minY, support.pose.y); reach.maxY = Math.max(reach.maxY, support.pose.y);
  }
  if (outside.length || stray.length) issues.push({ code: 'track-outside-room', severity: 'error',
    message: outsideMessage([...outside.map(item => item.family), ...stray.map(support => support.family)], reach, room),
    pieceIds: outside.map(item => item.pieceId), ...(stray.length ? { supportIds: stray.map(support => support.id) } : {}) });
  for (const [name, hit] of shelves) issues.push({ code: 'track-into-shelf', severity: 'error', message: shelfMessage(name, hit),
    pieceIds: hit.pieceIds, points: [{ x: hit.x, y: hit.y, z: (hit.bottom + hit.top) / 2 }] });
  return issues;
}
