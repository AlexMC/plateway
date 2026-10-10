import type { RoutePiece } from '../../project';
import { paramValue } from '../composite';
import type { ParamSpec, PieceDefinition, PiecePath, ShapePoint, StateSpec } from '../types';
import { PRINTED_COLOR, studs } from './composite-piece';

/**
 * Moving spans and the train elevator (C4; cad/models/moving_bridge.py builds them with the same numbers). Every piece
 * runs straight from `in` (x = 0) to `out`: two fixed 48 mm landings flank a deck `span` long between the landing ends.
 * The deck's route is a `moving` path, open only while the deck is in place (lowered, closed, at its level); in any
 * other state the route ends at the landing with the piece's halt message. The elevator has a route per level, each
 * at its level's height, so every level's ports snap and only the level the car is at is open.
 */
type XY = { x: number; y: number };
const HALF = 31.9;
/** Mirrors moving_bridge.py: landing length, rail gap, and the deck's widest guides (saddles, hinge, posts, girders). */
export const BRIDGE = { landing: 48, gap: .6, saddle: 46.55, post: [36, 46] as const, shoe: 49.25, girder: 38.7,
  swingGap: .8, hingeZ: 12, trunnionZ: 36, counterweight: [35.6, 38.8] as const, tower: [39.2, 43.2] as const } as const;
const COLOR = PRINTED_COLOR;

const point = (x: number, z = 0): ShapePoint => ({ x, y: 0, z, heading: 0 });
const rect = (x0: number, x1: number, y0: number, y1: number): XY[] => [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];
/** Both sides' copies of a band `a`..`b` out from the centre line. */
const sides = (x0: number, x1: number, a: number, b: number): XY[][] => [rect(x0, x1, a, b), rect(x0, x1, -b, -a)];
const spanSpec = (min: number, max: number, fallback: number): ParamSpec =>
  ({ key: 'span', label: 'Span', unit: 'mm', min, max, step: 8, default: fallback });
const DRIVE: ParamSpec = { key: 'drive', label: 'Drive', unit: '', min: 0, max: 2, step: 1, default: 0,
  options: [{ value: 0, label: 'By hand' }, { value: 1, label: 'Bluetooth motor' }, { value: 2, label: 'Infrared L motor (88003)' }] };
/** The bascule description's suffix for each drive. */
const DRIVE_SUFFIX = ['', ' · Bluetooth motor', ' · infrared motor'] as const;
const SCREW: ParamSpec = { key: 'drive', label: 'Drive', unit: '', min: 0, max: 1, step: 1, default: 0,
  options: [{ value: 0, label: 'Lift by hand' }, { value: 1, label: 'M8 lead screw + crank' }] };
/** moving_bridge._screw: the rod beside the left posts at mid-span, the deck's nut boss round it, the crank on top. */
const SCREW_Y = HALF + 26.1;
function screwParts(length: number): { outline: XY[][]; envelopes: XY[][] } {
  const c = length / 2, posts = [BRIDGE.landing + 5.3, length - BRIDGE.landing - 5.3];
  const crank = Array.from({ length: 24 }, (_, i) => ({ x: c + 44.5 * Math.cos(Math.PI * i / 12), y: SCREW_Y + 44.5 * Math.sin(Math.PI * i / 12) }));
  return { outline: [rect(posts[0] - 8, posts[1] + 8, BRIDGE.post[0] - .5, SCREW_Y + 15)],
    envelopes: [rect(c - 10.5, c + 10.5, HALF - 1, SCREW_Y + 9.5), crank] };
}

interface BridgeSpec {
  family: string; label: string; params: readonly ParamSpec[]; states: readonly StateSpec[];
  description(values: Record<string, number>, length: number): string;
  halt: string; notes: readonly string[];
  /** Fixed parts beside the landings (piece frame), drawn under the deck. */
  outline(values: Record<string, number>, length: number): XY[][];
  envelopes(values: Record<string, number>, length: number): XY[][];
}
const valuesOf = (params: readonly ParamSpec[], piece: Pick<RoutePiece, 'params'>) =>
  Object.fromEntries(params.map(spec => [spec.key, paramValue({ params }, piece as RoutePiece, spec.key)]));
const lengthOf = (values: Record<string, number>) => 2 * BRIDGE.landing + values.span;
const landings = (length: number, z = 0): ShapePoint[][] =>
  [[point(0, z), point(BRIDGE.landing, z)], [point(length - BRIDGE.landing, z), point(length, z)]];
const landingBodies = (length: number): XY[][] => [rect(0, BRIDGE.landing, -HALF, HALF), rect(length - BRIDGE.landing, length, -HALF, HALF)];

/** A single-route moving span: open only in its first state. */
function span(spec: BridgeSpec): PieceDefinition {
  const values = (piece: Pick<RoutePiece, 'params'>) => valuesOf(spec.params, piece);
  const length = (piece: Pick<RoutePiece, 'params'>) => lengthOf(values(piece));
  return {
    family: spec.family, label: spec.label, group: 'mechanism', source: 'printed', styles: ['detailed', 'fast'],
    params: spec.params, states: spec.states, gauge: 'standard', body: 'assembly', customJoiner: false, color: COLOR,
    notes: spec.notes,
    description: piece => spec.description(values(piece), length(piece)),
    paths: piece => [{ id: 'main', from: 'in', to: 'out', moving: true, states: [spec.states[0].id],
      points: [point(0), point(length(piece))] }],
    end: piece => point(length(piece)),
    run: length,
    halt: () => spec.halt,
    fixedTrack: piece => landings(length(piece)),
    outline: piece => [...landingBodies(length(piece)), ...spec.outline(values(piece), length(piece))],
    envelopes: piece => spec.envelopes(values(piece), length(piece)),
    cad: piece => [{ family: spec.family, parameters: { ...values(piece),
      state: Math.max(0, spec.states.findIndex(state => state.id === piece.state)) } }]
  };
}

const IN_OUT: readonly StateSpec[] = [{ id: 'in', label: 'In place' }, { id: 'out', label: 'Lifted out' }];
const DOWN_UP: readonly StateSpec[] = [{ id: 'down', label: 'Down' }, { id: 'up', label: 'Raised' }];
const D0 = BRIDGE.landing + BRIDGE.gap;
/** Seat posts on both landings (moving_bridge.seat_post): 10 mm onto the landing, 14 mm under the deck. */
const seatPosts = (length: number): XY[][] => [BRIDGE.landing, length - BRIDGE.landing].flatMap((e, i) =>
  sides(i ? e - 14 : e - 10, i ? e + 10 : e + 14, HALF + 3, HALF + 12));
const deckEnvelope = (length: number, x0: number = D0, width: number = BRIDGE.saddle, x1 = length - D0) => rect(x0, x1, -width - .5, width + .5);
/** A leaf hinged at `z` over the in landing end: rising, its far underside first swings out past the closed position. */
const leafReach = (length: number, z: number) => BRIDGE.landing + BRIDGE.gap / 2 + Math.hypot(length - D0 - BRIDGE.landing - BRIDGE.gap / 2, z) + .5;

export const BRIDGE_LIFT_OUT = span({
  family: 'bridge_lift_out', label: 'Lift-out section', params: [spanSpec(64, 160, 128)], states: IN_OUT,
  description: ({ span: s }, length) => `${studs(s)}-stud lift-out · ${studs(length)} studs overall`,
  halt: 'The lift-out section is removed.',
  notes: ['A removable span for a doorway or walkway: lift it straight out; saddles over cone posts and magnets seat it lined up.'],
  outline: (_, length) => seatPosts(length),
  envelopes: (_, length) => [deckEnvelope(length)]
});

export const BRIDGE_DROP_LEAF = span({
  family: 'bridge_drop_leaf', label: 'Hinged section', params: [spanSpec(64, 160, 128)], states: DOWN_UP,
  description: ({ span: s }, length) => `${studs(s)}-stud hinged leaf · ${studs(length)} studs overall`,
  halt: 'The hinged section is raised.',
  notes: ['A drop-leaf: the leaf hinges up at its `in` end on two M3 screws and rests just past vertical; lowered, it seats on cone posts and magnets.'],
  outline: (_, length) => [...sides(BRIDGE.landing - 14, BRIDGE.landing + 5.3, HALF - .5, HALF + 7.9), ...seatPosts(length).slice(2)],
  envelopes: ({ span: s }, length) => {
    // Raised, the leaf leans back past vertical: its far rail tops (2.4 mm under the hinge) reach back over the landing.
    const leaf = s - 2 * BRIDGE.gap, up = Math.PI / 2 + Math.atan2(9, leaf / 2) + 4 * Math.PI / 180;
    return [deckEnvelope(length, BRIDGE.landing + BRIDGE.gap / 2 + leaf * Math.cos(up) + 2.4 * Math.sin(up) - .5, BRIDGE.saddle, leafReach(length, BRIDGE.hingeZ))];
  }
});

export const BRIDGE_BASCULE = span({
  family: 'bridge_bascule', label: 'Bascule bridge', params: [spanSpec(96, 160, 128), DRIVE], states: DOWN_UP,
  description: ({ span: s, drive }, length) => `${studs(s)}-stud bascule${DRIVE_SUFFIX[drive] ?? ''} · ${studs(length)} studs overall`,
  halt: 'The bascule bridge is raised.',
  notes: ['The leaf rises 80° on a cross-axle trunnion between two towers; counterweights balance it, magnets hold it down.'],
  outline: ({ drive }, length) => {
    const ax = BRIDGE.landing + BRIDGE.gap / 2;
    return [...sides(ax - 40, ax + 15, HALF - .5, BRIDGE.tower[1]), ...seatPosts(length).slice(2),
      ...(drive ? [rect(ax - 20.4, ax + 20.4, BRIDGE.tower[1], BRIDGE.tower[1] + 7.8)] : [])];
  },
  envelopes: (_, length) => {
    const ax = BRIDGE.landing + BRIDGE.gap / 2;
    return [deckEnvelope(length, ax - 7.5, BRIDGE.saddle, leafReach(length, BRIDGE.trunnionZ)), ...sides(ax - 28, ax + 10, BRIDGE.counterweight[0] - .5, BRIDGE.counterweight[1] + .5)];
  }
});

const swingRadius = (s: number) => s / 2 - BRIDGE.swingGap;
function circle(cx: number, radius: number, count = 48): XY[] {
  return Array.from({ length: count }, (_, i) => ({ x: cx + radius * Math.cos(2 * Math.PI * i / count), y: radius * Math.sin(2 * Math.PI * i / count) }));
}

export const BRIDGE_SWING = span({
  family: 'bridge_swing', label: 'Swing bridge', params: [spanSpec(144, 160, 160)], states: [{ id: 'closed', label: 'Closed' }, { id: 'open', label: 'Open' }],
  description: ({ span: s }, length) => `${studs(s)}-stud swing span · ${studs(length)} studs overall`,
  halt: 'The swing bridge is open.',
  notes: ['The deck turns 90° on a centre pivot; closing, its girders meet stop blocks with magnets, lining the rails up.'],
  outline: ({ span: s }, length) => {
    const corner = Math.sqrt(swingRadius(s) ** 2 - BRIDGE.girder ** 2), c = length / 2;
    return [rect(BRIDGE.landing - 4, length - BRIDGE.landing + 4, -BRIDGE.girder - .5, BRIDGE.girder + .5),
      rect(c - corner + 1, c - corner + 13, BRIDGE.girder, BRIDGE.girder + 5.8), rect(c + corner - 13, c + corner - 1, -BRIDGE.girder - 5.8, -BRIDGE.girder)];
  },
  envelopes: ({ span: s }, length) => [circle(length / 2, Math.hypot(swingRadius(s), BRIDGE.girder) + .5)]
});

/** Four posts at the deck corners (moving_bridge._vertical), 0.3 mm past each landing end. */
const posts = (length: number): XY[][] => [BRIDGE.landing + 5.3, length - BRIDGE.landing - 5.3]
  .flatMap(x => sides(x - 5, x + 5, BRIDGE.post[0], BRIDGE.post[1]));

export const BRIDGE_LIFT = span({
  family: 'bridge_lift', label: 'Lift bridge', params: [spanSpec(96, 160, 128),
    { key: 'lift', label: 'Lift', unit: 'mm', min: 64, max: 128, step: 8, default: 128 }, SCREW], states: DOWN_UP,
  description: ({ span: s, lift, drive }, length) => `${studs(s)}-stud lift span · rises ${lift} mm${drive ? ' · lead screw' : ''} · ${studs(length)} studs overall`,
  halt: 'The lift bridge is raised.',
  notes: ['The deck rises straight up between four posts; index pins hold it down (rails lined up) or raised. The lead screw raises it with a crank.'],
  outline: ({ drive }, length) => [...posts(length), ...(drive ? screwParts(length).outline : [])],
  envelopes: ({ drive }, length) => [deckEnvelope(length, D0, BRIDGE.shoe), ...(drive ? screwParts(length).envelopes : [])]
});

const LEVEL_STATES: readonly StateSpec[] = Array.from({ length: 4 }, (_, i) => ({ id: `level-${i + 1}`, label: `Level ${i + 1}` }));
const ELEVATOR_PARAMS: readonly ParamSpec[] = [spanSpec(128, 160, 128),
  { key: 'levels', label: 'Levels', unit: 'count', min: 2, max: 4, step: 1, default: 2 },
  { key: 'level_height', label: 'Level spacing', unit: 'mm', min: 96, max: 160, step: 8, default: 128 }, SCREW];
const elevatorValues = (piece: Pick<RoutePiece, 'params'>) => valuesOf(ELEVATOR_PARAMS, piece);
const levelIndex = (piece: RoutePiece) => Math.max(0, Math.min(elevatorValues(piece).levels - 1, LEVEL_STATES.findIndex(state => state.id === piece.state)));

/** Lifts a whole train between levels: the car's route at each level is `in-N`→`out-N` at that height. */
export const TRAIN_ELEVATOR: PieceDefinition = {
  family: 'train_elevator', label: 'Train elevator', group: 'mechanism', source: 'printed', styles: ['detailed', 'fast'],
  params: ELEVATOR_PARAMS, states: LEVEL_STATES, gauge: 'standard', body: 'assembly', customJoiner: false, color: COLOR,
  notes: ['The car carries a train between levels on four posts; index pins hold it at a level with its rails lined up.',
    'Support the track beyond each upper landing at that level (risers or a shelf).'],
  description: piece => {
    const { span: s, levels, level_height: height, drive } = elevatorValues(piece);
    return `${studs(s)}-stud car · ${levels} levels ${height} mm apart${drive ? ' · lead screw' : ''}`;
  },
  pieceStates: piece => LEVEL_STATES.slice(0, elevatorValues(piece).levels),
  paths: piece => {
    const v = elevatorValues(piece), length = lengthOf(v);
    return Array.from({ length: v.levels }, (_, level): PiecePath => ({ id: level ? `level-${level + 1}` : 'main',
      from: level ? `in-${level + 1}` : 'in', to: level ? `out-${level + 1}` : 'out', moving: true, states: [LEVEL_STATES[level].id],
      points: [point(0, level * v.level_height), point(length, level * v.level_height)] }));
  },
  end: piece => point(lengthOf(elevatorValues(piece))),
  run: piece => lengthOf(elevatorValues(piece)),
  halt: piece => `The elevator car is at level ${levelIndex(piece) + 1}.`,
  // Its four posts carry every landing and the car: generic supports stay out from under it.
  ownSupports: () => true,
  fixedTrack: piece => {
    const v = elevatorValues(piece);
    return Array.from({ length: v.levels }, (_, level) => landings(lengthOf(v), level * v.level_height)).flat();
  },
  outline: piece => {
    const v = elevatorValues(piece), length = lengthOf(v);
    return [...landingBodies(length), ...posts(length), ...(v.drive ? screwParts(length).outline : [])];
  },
  envelopes: piece => {
    const v = elevatorValues(piece), length = lengthOf(v);
    return [deckEnvelope(length, D0, BRIDGE.shoe), ...(v.drive ? screwParts(length).envelopes : [])];
  },
  cad: piece => [{ family: 'train_elevator', parameters: { ...elevatorValues(piece), state: levelIndex(piece) } }]
};

export const BRIDGE_FAMILIES: readonly PieceDefinition[] = [BRIDGE_LIFT_OUT, BRIDGE_DROP_LEAF, BRIDGE_BASCULE, BRIDGE_SWING, BRIDGE_LIFT, TRAIN_ELEVATOR];
