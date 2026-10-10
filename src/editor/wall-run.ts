import { primaryEnd } from '../domain/pieces';
import type { RoutePiece, WorkshopProject } from '../domain/project';
import { previewPiece, type Placement } from './operations';

/**
 * Wall/shelf run kit: straight track at a set height held by printed brackets, laid as `track_straight` pieces (at most
 * 2000 mm each; fit splits them to the bed) whose bracket settings place a bracket under a full sleeper about every
 * `spacing` mm. Wall brackets screw to the wall at `reach` from the track centre; shelf brackets screw down on a shelf
 * and hold the track `shelf` mm above it.
 */
export interface WallRunOptions {
  length: number;
  /** Track underside above the table where the run starts unsnapped, mm. */
  height: number;
  mount: 1 | 2;
  /** +1: the wall is on the left of the run's direction, -1 on the right. */
  side: 1 | -1;
  reach: number;
  spacing: number;
  shelf: number;
  style?: 'fast';
}
const LONGEST = 2000;

export function layWallRun(project: WorkshopProject, start: { x: number; y: number; z: number; heading: number }, options: WallRunOptions): RoutePiece[] {
  const count = Math.ceil(options.length / LONGEST - 1e-9), length = options.length / count, pieces: RoutePiece[] = [];
  let at = start;
  for (let index = 0; index < count; index++) {
    const piece: RoutePiece = { id: `wall-${index}`, family: 'track_straight', ...at, params: { length, bracket: options.mount,
      bracket_side: options.side, bracket_reach: options.reach, bracket_spacing: options.spacing,
      ...(options.mount === 2 ? { bracket_height: options.shelf } : {}) }, ...(options.style ? { style: options.style } : {}) };
    pieces.push(piece);
    const end = primaryEnd(piece, project);
    at = { x: end.x, y: end.y, z: end.z, heading: end.heading };
  }
  return pieces;
}
/** The run snaps to an open end like any straight; unsnapped it starts at the kit's height. */
export function previewWallRun(project: WorkshopProject, placement: Placement, options: WallRunOptions, snapRadius = 30): RoutePiece[] {
  const first = previewPiece(project, 'track_straight', { ...placement, z: options.height, params: { length: Math.min(options.length, LONGEST) } }, snapRadius);
  return layWallRun(project, first.piece, options);
}
