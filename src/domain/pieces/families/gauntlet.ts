import type { RoutePiece } from '../../project';
import { paramValue } from '../composite';
import { arc, origin } from '../geometry';
import type { ParamSpec, PieceDefinition, PiecePath } from '../types';
import { studs } from './composite-piece';
import { CROSSING_WARN_ANGLE, SHALLOW_CROSSING, corridorProblem } from './diamond';
import type { TrackKind } from './kinds';

/**
 * Gauntlet (interlaced) track: two tracks `spacing` apart (signed, + = the parallel track on the left) S-bend over
 * `entry` to centres `offset` apart, share one narrow bed for `length` with their rails interlaced, and S-bend back.
 * No switches: each entry has one rail crossing. Only one train may be inside at a time.
 * Printed by cad/models/crossing_any.py.
 */
export const GAUNTLET_FAMILY = 'track_gauntlet';
/** Tightest entry S-bend arc (R24), as for plain S-bends. */
const MIN_RADIUS = 192;

export interface GauntletShape { spacing: number; offset: number; entry: number; length: number }

/** Radius and turn of each entry arc: two equal opposite arcs shifting (|spacing| − offset)/2 over `entry`. */
export function gauntletEntry({ spacing, offset, entry }: GauntletShape): { radius: number; turn: number } {
  const turn = 2 * Math.atan2((Math.abs(spacing) - offset) / 2, entry);
  return { radius: entry / (2 * Math.sin(turn)), turn };
}

/** Angle (degrees) at which the two tracks' rails cross in each entry: where the centres are one gauge apart. */
export function gauntletCrossingAngle(shape: GauntletShape): number {
  const { radius } = gauntletEntry(shape), shift = (Math.abs(shape.spacing) - shape.offset) / 2;
  const moved = (Math.abs(shape.spacing) - 40) / 2, rest = moved <= shift / 2 ? moved : shift - moved;
  return 2 * Math.acos(1 - rest / radius) / (Math.PI / 180);
}

export function gauntletPaths(shape: GauntletShape): PiecePath[] {
  const { radius, turn } = gauntletEntry(shape), side = Math.sign(shape.spacing) || 1;
  return ([['main', 'in', 'out', 0, side], ['parallel', 'parallel-in', 'parallel-out', shape.spacing, -side]] as const)
    .map(([id, from, to, y, sign]) => {
      const points = [origin(y)];
      arc(points, radius, sign * turn); arc(points, radius, -sign * turn);
      const last = points.at(-1)!;
      if (shape.length > 0) points.push({ x: last.x + shape.length, y: last.y, z: 0, heading: 0 });
      arc(points, radius, -sign * turn); arc(points, radius, sign * turn);
      return { id, from, to, points };
    });
}

const PARAMS: readonly ParamSpec[] = [
  { key: 'spacing', label: 'Track spacing', unit: 'mm', min: -256, max: 256, step: 8, default: 128 },
  { key: 'offset', label: 'Offset inside', unit: 'mm', min: 8, max: 24, step: 1, default: 16 },
  { key: 'entry', label: 'Entry', unit: 'mm', min: 128, max: 1024, step: 8, default: 320 },
  { key: 'length', label: 'Shared length', unit: 'mm', min: 0, max: 1024, step: 8, default: 128 }
];
const shapeOf = (piece: Pick<RoutePiece, 'params'>): GauntletShape =>
  Object.fromEntries(PARAMS.map(spec => [spec.key, paramValue({ params: PARAMS }, piece as RoutePiece, spec.key)])) as unknown as GauntletShape;

export const TRACK_GAUNTLET: PieceDefinition = {
  family: GAUNTLET_FAMILY, label: 'Gauntlet track', group: 'junction', source: 'printed', styles: ['detailed', 'fast'],
  params: PARAMS, gauge: 'standard', body: 'assembly', customJoiner: false, color: 0xc98a6a,
  notes: ['Both tracks are always open; only one train may be inside at a time.',
    'Each entry has a rail crossing with check rails; the shared middle has four interlaced rails.'],
  description: piece => {
    const { spacing, offset, length } = shapeOf(piece);
    return `${studs(Math.abs(spacing))}-stud tracks · ${offset} mm apart for ${studs(length)} studs`;
  },
  run: piece => 2 * shapeOf(piece).entry + shapeOf(piece).length,
  end: piece => ({ x: 2 * shapeOf(piece).entry + shapeOf(piece).length, y: 0, z: 0, heading: 0 }),
  paths: piece => gauntletPaths(shapeOf(piece)),
  cad: piece => [{ family: GAUNTLET_FAMILY, parameters: { ...shapeOf(piece) } }],
  flip: given => ({ ...given, spacing: -(given.spacing ?? 128) }),
  // Turned end for end the parallel track is on the other side.
  reverseParams: given => ({ ...given, spacing: -(given.spacing ?? 128) })
};

function problem(shape: GauntletShape): string | null {
  const { spacing, offset, entry, length } = shape;
  if (!(Math.abs(spacing) >= 64 && Math.abs(spacing) <= 256)) return 'Track spacing must be 64 to 256 mm (8 to 32 studs).';
  if (!(offset >= 8 && offset <= 24)) return 'Offset must be 8 to 24 mm.';
  if (!(entry >= 128 && entry <= 1024) || !(length >= 0 && length <= 1024)) return 'Entry must be 128 to 1024 mm and the shared length at most 1024 mm.';
  const { radius } = gauntletEntry(shape);
  if (radius < MIN_RADIUS) return `Entry too tight (R${studs(radius)}); make it longer.`;
  return corridorProblem(gauntletPaths(shape)) ? 'The tracks are too close at the ends; widen the spacing.' : null;
}

/** Palette tile and card: double track squeezing through one narrow bed. */
export const GAUNTLET_KIND: TrackKind = {
  id: 'gauntlet', label: 'Gauntlet track', group: 'junction', hand: 'spacing', families: [GAUNTLET_FAMILY],
  rows: [
    { label: 'Tracks', match: ['spacing'],
      choices: [{ label: '16 studs', values: { spacing: 128 }, title: 'Standard double-track spacing' },
        { label: '8 studs', values: { spacing: 64 }, title: 'Tracks side by side' }],
      custom: [{ key: 'spacing', label: 'Track spacing', unit: 'mm', min: 64, max: 256, step: 8, signed: true }] },
    { label: 'Inside', match: ['offset'],
      choices: [{ label: '16 mm', values: { offset: 16 } }, { label: '8 mm', values: { offset: 8 } }],
      custom: [{ key: 'offset', label: 'Offset inside', unit: 'mm', min: 8, max: 24, step: 1 }] }
  ],
  extra: () => [{ key: 'entry', label: 'Entry', unit: 'mm', min: 128, max: 1024, step: 8 },
    { key: 'length', label: 'Shared length', unit: 'mm', min: 0, max: 1024, step: 8 }],
  initial: { spacing: 128, offset: 16, entry: 320, length: 128 },
  values: piece => ({ ...shapeOf(piece) }),
  shape: (given, source, customJoiner = false) => source === 'owned' || customJoiner ? null :
    { family: GAUNTLET_FAMILY, params: { spacing: given.spacing, offset: given.offset, entry: given.entry, length: given.length } },
  problem: given => problem(given as unknown as GauntletShape),
  caution: given => gauntletCrossingAngle(given as unknown as GauntletShape) < CROSSING_WARN_ANGLE ? SHALLOW_CROSSING : null,
  describe: ({ spacing, offset, length }) => `${studs(Math.abs(spacing))} studs · ${offset} mm · ${studs(length)} shared`
};

