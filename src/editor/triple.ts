import type { RoutePiece, WorkshopProject } from '../domain/project';
import { piecePorts } from '../domain/pieces';
import { placePiece, previewPiece, type Placement } from './operations';

/**
 * Triple crossover kit: any-to-any across three parallel tracks, laid as two scissors crossovers in a row — tracks 1–2
 * first, then tracks 2–3 starting on the first one's parallel-out port — plus the plain straights that keep tracks 1
 * and 3 running alongside. A single assembly with both scissors overlapping cannot work with point blades: on the
 * middle track one scissors' arriving points would sit where the other's leave. Each scissors prints, splits and
 * switches on its own.
 */
export interface TripleOptions { spacing: number; radius: number; hand: 1 | -1; style?: 'fast' }

/** The kit's pieces laid from `start` (the first scissors' `in`), without changing the project. */
export function layTriple(project: WorkshopProject, start: { x: number; y: number; z: number; heading: number }, options: TripleOptions): RoutePiece[] {
  const params = { spacing: options.spacing, radius: options.radius, hand: options.hand }, style = options.style ? { style: options.style } : {};
  const first: RoutePiece = { id: 'triple-0', family: 'crossover_scissors', ...start, params, ...style };
  const ports = new Map(piecePorts(first, project).map(port => [port.id, port]));
  const out = ports.get('out')!, parallelOut = ports.get('parallel-out')!, parallelIn = ports.get('parallel-in')!;
  const second: RoutePiece = { id: 'triple-1', family: 'crossover_scissors', x: parallelOut.x, y: parallelOut.y, z: parallelOut.z, heading: parallelOut.heading, params, ...style };
  const length = Math.hypot(out.x - start.x, out.y - start.y);
  // Track 1 runs on past the second scissors; track 3 runs in beside the first, ending on the second's parallel-in.
  const across = { x: parallelIn.x - start.x, y: parallelIn.y - start.y };
  return [first, second,
    { id: 'triple-2', family: 'track_straight', x: out.x, y: out.y, z: out.z, heading: out.heading, params: { length }, ...style },
    { id: 'triple-3', family: 'track_straight', x: parallelIn.x + across.x, y: parallelIn.y + across.y, z: start.z, heading: start.heading, params: { length }, ...style }];
}
/** Where the kit lands for a drop: the first scissors snaps like any piece. */
export function previewTriple(project: WorkshopProject, placement: Placement, options: TripleOptions, snapRadius = 30): RoutePiece[] {
  const params = { spacing: options.spacing, radius: options.radius, hand: options.hand };
  return layTriple(project, previewPiece(project, 'crossover_scissors', { ...placement, params }, snapRadius).piece, options);
}
/** Lay the kit as one change; returns the new piece ids in kit order. */
export function placeTriple(project: WorkshopProject, placement: Placement, options: TripleOptions, snapRadius = 30): [WorkshopProject, string[]] {
  const ids: string[] = [];
  let next = project;
  for (const [index, piece] of previewTriple(project, placement, options, snapRadius).entries()) {
    const [after, id] = placePiece(next, piece.family, { x: piece.x, y: piece.y, z: piece.z, heading: piece.heading,
      ...(piece.params ? { params: piece.params } : {}), ...(piece.style ? { style: piece.style } : {}) }, index ? -1 : snapRadius);
    next = after; ids.push(id);
  }
  return [next, ids];
}
