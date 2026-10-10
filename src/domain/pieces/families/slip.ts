import type { RoutePiece } from '../../project';
import { paramValue } from '../composite';
import { arc, origin } from '../geometry';
import type { ParamSpec, PieceDefinition, PiecePath, StateSpec } from '../types';
import { DEG, PRINTED_COLOR, studs } from './composite-piece';
import { switchEnvelope, type SwitchSpec } from './turnout-geometry';

/**
 * Single and double slips: a diamond crossing whose slip curves leave and join the straight tracks at sets of points
 * at the ports. Track A runs `in`→`out` along +x; the crossing track B runs `cross-in`→`cross-out` through A's
 * midpoint at `angle` (left for hand +1). The slip curve `slip` turns from `in` onto `cross-out`; the double slip adds
 * `slip-back` from `cross-in` onto `out`. Each curve is one arc tangent to both tracks at their ports.
 */

/** Tightest slip curve: the official R40 radius. */
export const SLIP_MIN_RADIUS = 320;
/**
 * Flexing length of the point blades on a slip curve of `radius`: wide curves part slowly, so their blades need a
 * longer flex to reach full throw (the CAD's points use the same rule).
 */
export const slipFlex = (radius: number) => radius < 1200 ? 48 : radius < 2000 ? 64 : 80;
/** Points travel envelope past the flex (the framework's ENVELOPE_REACH), its half-width, the track body half-width (mm). */
const ENVELOPE_REACH = 32, POINTS_HALF = 32, BODY_HALF = 31.9;
const GRID = 8;

/**
 * The shortest stud-grid length of each track for a slip at `angle` (radians, magnitude): the slip curve is at least
 * R40, each set of points (reaching to the curve's 1 mm parting + flex + envelope) stays clear of the other track's
 * body, and each port clears the other track's corridor. A longer track widens the curve and lengthens its points,
 * so the length is grown until it holds.
 */
export function slipLength(angle: number): number {
  const a = Math.abs(angle), grid = (value: number) => Math.ceil(value / GRID - 1e-9) * GRID;
  let length = grid(Math.max(2 * SLIP_MIN_RADIUS * Math.tan(a / 2), 2 * BODY_HALF / Math.tan(a / 2)));
  for (;;) {
    const radius = slipRadius(length, a), reach = Math.sqrt(2 * radius) + slipFlex(radius) + ENVELOPE_REACH;
    const next = grid(Math.max(length, 2 * (reach + (POINTS_HALF + BODY_HALF / Math.cos(a)) / Math.tan(a))));
    if (next === length) return length;
    length = next;
  }
}
/** Radius of the slip curve for tracks `length` long crossing at `angle`: tangent to both tracks at their ports. */
export function slipRadius(length: number, angle: number): number {
  return length / 2 / Math.tan(Math.abs(angle) / 2);
}

const PARAMS: readonly ParamSpec[] = [
  { key: 'angle', label: 'Crossing angle', unit: 'deg', min: 15, max: 60, step: 0.5, default: 45 },
  { key: 'hand', label: 'Crossing track', unit: '', min: -1, max: 1, step: 2, default: 1,
    options: [{ value: 1, label: 'Heads left' }, { value: -1, label: 'Heads right' }] }
];
const value = (piece: Pick<RoutePiece, 'params'>, key: string) => paramValue({ params: PARAMS }, piece as RoutePiece, key);
function geometryOf(piece: Pick<RoutePiece, 'params'>) {
  const angle = (value(piece, 'hand') < 0 ? -1 : 1) * value(piece, 'angle') * DEG, length = slipLength(angle);
  return { angle, length, radius: slipRadius(length, angle) };
}

/** Every set of points (the CAD's switches, same order); a single slip has the first two. */
const DOUBLE_SWITCHES: readonly SwitchSpec[] = [{ a: 'main', b: 'slip', port: 'in' }, { a: 'crossing', b: 'slip', port: 'cross-out' },
  { a: 'crossing', b: 'slip-back', port: 'cross-in' }, { a: 'main', b: 'slip-back', port: 'out' }];

interface Layout { family: string; label: string; summary: string; double: boolean; states: readonly StateSpec[];
  /** States each route is open in. */
  open: Record<'main' | 'crossing' | 'slip' | 'slip-back', readonly string[]>; notes: readonly string[] }

function slip({ family, label, summary, double, states, open, notes }: Layout): PieceDefinition {
  const paths = (piece: RoutePiece): PiecePath[] => {
    const { angle, length } = geometryOf(piece), half = length / 2, c = Math.cos(angle), s = Math.sin(angle);
    const crossIn = { x: half - half * c, y: -half * s, z: 0, heading: angle };
    const crossOut = { x: half + half * c, y: half * s, z: 0, heading: angle };
    const radius = slipRadius(length, angle);
    const turn = [origin()];
    arc(turn, radius, angle);
    turn[turn.length - 1] = crossOut;
    const result: PiecePath[] = [
      { id: 'main', from: 'in', to: 'out', points: [origin(), { x: length, y: 0, z: 0, heading: 0 }], states: open.main },
      { id: 'crossing', from: 'cross-in', to: 'cross-out', points: [crossIn, crossOut], states: open.crossing },
      { id: 'slip', from: 'in', to: 'cross-out', points: turn, states: open.slip }
    ];
    if (double) {
      const back = [crossIn];
      arc(back, radius, -angle);
      back[back.length - 1] = { x: length, y: 0, z: 0, heading: 0 };
      result.push({ id: 'slip-back', from: 'cross-in', to: 'out', points: back, states: open['slip-back'] });
    }
    return result;
  };
  return {
    family, label, group: 'junction', source: 'printed', styles: ['detailed', 'fast'], params: PARAMS, states, gauge: 'standard',
    body: 'assembly', handed: true, customJoiner: false, color: PRINTED_COLOR, notes,
    description: piece => {
      const { angle, length, radius } = geometryOf(piece);
      return `${summary} · ${Number((Math.abs(angle) / DEG).toFixed(2))}° · ${studs(length)} studs · R${studs(radius)}`;
    },
    run: piece => geometryOf(piece).length,
    end: piece => ({ x: geometryOf(piece).length, y: 0, z: 0, heading: 0 }),
    paths,
    envelopes: piece => {
      const byId = new Map(paths(piece).map(path => [path.id, path])), flex = slipFlex(geometryOf(piece).radius);
      return (double ? DOUBLE_SWITCHES : DOUBLE_SWITCHES.slice(0, 2)).map(sw => switchEnvelope(byId.get(sw.a)!, byId.get(sw.b)!, sw.port, flex));
    },
    flip: params => ({ ...params, hand: -(params.hand ?? 1) }),
    cad: piece => {
      const { angle, length, radius } = geometryOf(piece), state = states.findIndex(item => item.id === (piece.state ?? states[0].id));
      return [{ family, parameters: { angle, length, radius, switch_state: Math.max(0, state) } }];
    }
  };
}

/** One slip curve: its two sets of points (at `in` and `cross-out`) are one throw. */
export const SLIP_SINGLE = slip({
  family: 'slip_single', label: 'Single slip', summary: 'Single slip', double: false,
  states: [{ id: 'straight', label: 'Straight (both tracks)' }, { id: 'slip', label: 'Turn main → crossing' }],
  open: { main: ['straight'], crossing: ['straight'], slip: ['slip'], 'slip-back': [] },
  notes: ['One throw: set the points at in and cross-out together; leave room for their travel.']
});
/**
 * Two independent throws, shown as four states: throw 1 sets the points at `in` and `cross-out` (main → crossing),
 * throw 2 those at `cross-in` and `out` (crossing → main). Straight opens both straight tracks.
 */
export const SLIP_DOUBLE = slip({
  family: 'slip_double', label: 'Double slip', summary: 'Double slip', double: true,
  states: [{ id: 'straight', label: 'Straight (both tracks)' }, { id: 'slip', label: 'Turn main → crossing' },
    { id: 'slip-back', label: 'Turn crossing → main' }, { id: 'slip-both', label: 'Both turns' }],
  open: { main: ['straight'], crossing: ['straight'], slip: ['slip', 'slip-both'], 'slip-back': ['slip-back', 'slip-both'] },
  notes: ['Two throws: one sets the points at in and cross-out, the other those at cross-in and out.',
    'Leave room for the travel of all four sets of points.']
});
export const SLIP_FAMILIES: readonly PieceDefinition[] = [SLIP_SINGLE, SLIP_DOUBLE];
