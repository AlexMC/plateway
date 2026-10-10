import type { RoutePiece } from '../../project';
import { paramValue } from '../composite';
import { arc, origin } from '../geometry';
import type { ParamSpec, PieceDefinition, PiecePath, ShapePoint, StateSpec } from '../types';
import { PRINTED_COLOR, studs } from './composite-piece';
import { solveSBend } from './sbend';
import { switchEnvelope, type SwitchSpec } from './turnout-geometry';

/**
 * Crossovers between parallel tracks, one assembly each: the diagonals are S-bends whose points sit at the track ends
 * (the 7996 layout), so any spacing from 16 studs works — two separate turnouts cannot cross over closer than their
 * branch offset (~26 studs for 53404), and a scissors needs its diamond between the turnouts. All points of one
 * crossover are set together (one state), and the whole crossover is one piece to place, move and print.
 */

/** Diagonal radius choices: the tightest arc of each S-bend (R40 up to R104). */
export const CROSSOVER_RADII: readonly number[] = [320, 448, 576, 832];
/** The diagonal leaves at most this steeply; wider spacings add a straight between the arcs. */
const MAX_DIAGONAL = Math.PI / 4;
const GRID = 8;

export interface CrossoverGeometry {
  /** Port-to-port length along the tracks (a whole number of 8 mm studs). */
  length: number;
  /** Solved S-bend: equal opposite arcs of `radius` turning `angle`, `middle` mm of straight between. */
  radius: number; angle: number; middle: number;
}
/** The shortest stud-grid crossover whose diagonal keeps every arc at least `minRadius`. */
export function crossoverGeometry(spacing: number, minRadius: number): CrossoverGeometry {
  const offset = Math.abs(spacing);
  const angle = Math.min(Math.acos(Math.max(-1, 1 - offset / (2 * minRadius))), MAX_DIAGONAL);
  const middle = Math.max(0, (offset - 2 * minRadius * (1 - Math.cos(angle))) / Math.sin(angle));
  const length = Math.ceil((2 * minRadius * Math.sin(angle) + middle * Math.cos(angle)) / GRID - 1e-9) * GRID;
  const solved = solveSBend(length, offset, middle)!;
  return { length, radius: solved.radius, angle: solved.angle, middle };
}

/** A diagonal from (0, y0) to (length, y1), both ends heading along the tracks. */
export function diagonalPoints(geometry: CrossoverGeometry, y0: number, y1: number): ShapePoint[] {
  const sign = Math.sign(y1 - y0), points = [origin(y0)];
  arc(points, geometry.radius, sign * geometry.angle);
  const last = points.at(-1)!;
  if (geometry.middle > 1e-9) points.push({ x: last.x + geometry.middle * Math.cos(last.heading), y: last.y + geometry.middle * Math.sin(last.heading), z: 0, heading: last.heading });
  arc(points, geometry.radius, -sign * geometry.angle);
  // The solver is exact to ~1e-12; pin the S-bend's end so the far port mates the parallel track exactly.
  points[points.length - 1] = { x: geometry.length, y: y1, z: 0, heading: 0 };
  return points;
}

/**
 * The scissors' spacings (mm) and, at each, the diagonal radii whose diamond splits into keyed, bed-sized tiles that pass
 * every probe and slice on both printers, in either hand (cad/models/crossover_slip.py). Wider tracks cross with two
 * single crossovers.
 */
export const SCISSORS_RADII: Readonly<Record<number, readonly number[]>> = {
  128: [320, 448], 136: [320, 448], 144: [320, 448, 576], 152: [448, 576], 160: [320, 448, 832], 168: [448],
  176: [320, 448, 576, 832], 184: [320], 192: [320, 448, 576, 832]
};
export const SCISSORS_SPACINGS: readonly number[] = Object.keys(SCISSORS_RADII).map(Number);
const spacingParam = (max: number, offered?: readonly number[]): ParamSpec => ({ key: 'spacing', label: 'Track spacing', unit: 'mm', min: 128, max, step: 8,
  default: 128, ...(offered ? { options: offered.map(value => ({ value, label: `${studs(value)} studs` })) } : {}) });
const PARAMS: readonly ParamSpec[] = [
  spacingParam(512),
  { key: 'radius', label: 'Diagonal radius', unit: 'mm', min: 320, max: 832, step: 1, default: 320,
    options: CROSSOVER_RADII.map(value => ({ value, label: `R${studs(value)}` })) },
  { key: 'hand', label: 'Parallel track', unit: '', min: -1, max: 1, step: 2, default: 1,
    options: [{ value: 1, label: 'Left' }, { value: -1, label: 'Right' }] }
];
const value = (piece: Pick<RoutePiece, 'params'>, key: string) => paramValue({ params: PARAMS }, piece as RoutePiece, key);
function geometryOf(piece: Pick<RoutePiece, 'params'>): CrossoverGeometry & { spacing: number; hand: number } {
  const spacing = value(piece, 'spacing'), hand = value(piece, 'hand') < 0 ? -1 : 1;
  return { ...crossoverGeometry(spacing, value(piece, 'radius')), spacing, hand };
}

/** Lane `index` (0 = the `in` track) and its port ids. */
const LANES = [
  { path: 'main', from: 'in', to: 'out' },
  { path: 'parallel', from: 'parallel-in', to: 'parallel-out' }
] as const;
/** A diagonal from lane `from` to lane `to`. */
interface Diagonal { id: string; from: number; to: number; states: readonly string[] }
interface Layout { family: string; label: string; lanes: number; diagonals: readonly Diagonal[];
  /** States each lane's straight route is open in. */
  laneStates: readonly (readonly string[])[]; states: readonly StateSpec[]; summary: string;
  /** Every set of points: the two paths that part at a shared port (the CAD's switches, same order). */
  switches: readonly SwitchSpec[];
  /** Spacings offered (mm) with the diagonal radii printable at each, and why, when narrower than the single crossover's. */
  printable?: { radii: Readonly<Record<number, readonly number[]>>; note: string } }

function crossover({ family, label, lanes, diagonals, laneStates, states, summary, switches, printable }: Layout): PieceDefinition {
  const offered = printable && Object.keys(printable.radii).map(Number);
  const params = offered ? [spacingParam(Math.max(...offered), offered), ...PARAMS.slice(1)] : PARAMS;
  const length = (piece: Pick<RoutePiece, 'params'>) => geometryOf(piece).length;
  const paths = (piece: RoutePiece): PiecePath[] => {
    const geometry = geometryOf(piece), y = (lane: number) => geometry.hand * geometry.spacing * lane;
    return [
      ...Array.from({ length: lanes }, (_, lane): PiecePath => ({ id: LANES[lane].path, from: LANES[lane].from, to: LANES[lane].to,
        points: [origin(y(lane)), { x: geometry.length, y: y(lane), z: 0, heading: 0 }], states: laneStates[lane] })),
      ...diagonals.map((diagonal): PiecePath => ({ id: diagonal.id, from: LANES[diagonal.from].from, to: LANES[diagonal.to].to,
        points: diagonalPoints(geometry, y(diagonal.from), y(diagonal.to)), states: diagonal.states }))
    ];
  };
  return {
    family, label, group: 'junction', source: 'printed', styles: ['detailed', 'fast'], params, states, gauge: 'standard',
    body: 'assembly', handed: true, customJoiner: false, color: PRINTED_COLOR,
    description: piece => {
      const geometry = geometryOf(piece);
      return `${summary} · ${studs(geometry.spacing)}-stud spacing · ${studs(length(piece))} studs long · R${studs(geometry.radius)}`;
    },
    notes: ['All points of the crossover are set together; leave room for their travel.',
      'Change the setting only with no train on the crossover.', ...(printable ? [printable.note] : [])],
    ...(printable ? { problem: (piece: RoutePiece) => {
      const { spacing, radius } = geometryOf(piece), radii = printable.radii[spacing] ?? [];
      if (radii.includes(value(piece, 'radius'))) return null;
      return radii.length ? `At ${studs(spacing)}-stud spacing this crossover prints only with R${radii.map(studs).join(' or R')} diagonals.`
        : `No ${studs(spacing)}-stud spacing: its diamond does not split into bed-sized keyed tiles (R${studs(radius)}).`;
    } } : {}),
    run: length,
    end: piece => ({ x: length(piece), y: 0, z: 0, heading: 0 }),
    paths,
    envelopes: piece => {
      const byId = new Map(paths(piece).map(path => [path.id, path]));
      return switches.map(sw => switchEnvelope(byId.get(sw.a)!, byId.get(sw.b)!, sw.port));
    },
    flip: params => ({ ...params, hand: -(params.hand ?? 1) }),
    cad: piece => {
      const geometry = geometryOf(piece), state = states.findIndex(item => item.id === (piece.state ?? states[0].id));
      return [{ family, parameters: { spacing: geometry.hand * geometry.spacing, length: length(piece), radius: geometry.radius,
        angle: geometry.angle, middle: geometry.middle, switch_state: Math.max(0, state) } }];
    }
  };
}

const CROSSED: readonly StateSpec[] = [{ id: 'straight', label: 'Straight' }, { id: 'diverging', label: 'Crossed' }];
const SCISSORS_SWITCHES: readonly SwitchSpec[] = [{ a: 'main', b: 'cross', port: 'in' }, { a: 'parallel', b: 'cross', port: 'parallel-out' },
  { a: 'parallel', b: 'cross-back', port: 'parallel-in' }, { a: 'main', b: 'cross-back', port: 'out' }];

/** One diagonal from the `in` track to the parallel track's far end. */
export const CROSSOVER_SINGLE = crossover({
  family: 'crossover_single', label: 'Crossover', lanes: 2, summary: 'Single',
  diagonals: [{ id: 'cross', from: 0, to: 1, states: ['diverging'] }],
  laneStates: [['straight'], ['straight']], states: CROSSED,
  switches: [{ a: 'main', b: 'cross', port: 'in' }, { a: 'parallel', b: 'cross', port: 'parallel-out' }]
});
/** Both diagonals and the diamond where they cross. */
export const CROSSOVER_SCISSORS = crossover({
  family: 'crossover_scissors', label: 'Scissors crossover', lanes: 2, summary: 'Scissors',
  diagonals: [{ id: 'cross', from: 0, to: 1, states: ['diverging'] }, { id: 'cross-back', from: 1, to: 0, states: ['diverging'] }],
  laneStates: [['straight'], ['straight']], states: CROSSED,
  switches: SCISSORS_SWITCHES,
  printable: { radii: SCISSORS_RADII, note: 'Offered only at spacing and radius pairs whose diamond splits into bed-sized keyed tiles; wider than 24 studs, use two single crossovers.' }
});
export const CROSSOVER_FAMILIES: readonly PieceDefinition[] = [CROSSOVER_SINGLE, CROSSOVER_SCISSORS];
