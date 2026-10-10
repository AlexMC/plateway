import type { RoutePiece } from '../../project';
import { paramValue } from '../composite';
import type { ParamSpec, PieceDefinition, PiecePath, ShapePoint, StateSpec } from '../types';
import { DEG, PRINTED_COLOR, studs } from './composite-piece';

/**
 * Moving tables (C4; cad/models/tables.py builds them with the same numbers): a turntable bridge turning in a pit,
 * a transfer-table deck sliding across a well, and a sector plate swinging about its pivot. Each deck position is a
 * `moving` path between fixed stub ports; the deck's rail ends meet the stubs' across a 1 mm gap.
 */
type XY = { x: number; y: number };
const HALF = 31.9, RAIL = 20, HEAD = 1.2;
/** Mirrors tables.py: rail-end gap, pit wall band, shortest stub, sweep clearance, and the clear space between neighbouring stub rail heads (two brick wheel treads overhang 2.4 mm each). */
export const TABLE = { gap: 1, wall: 8, stubMin: 24, clear: .4, railClear: 5, laneStub: 24, sectorStub: 24 } as const;
const STALL_COLOR = PRINTED_COLOR;

const option = (key: string, label: string, unit: ParamSpec['unit'], values: readonly (readonly [number, string])[], fallback: number): ParamSpec =>
  ({ key, label, unit, min: Math.min(...values.map(([value]) => value)), max: Math.max(...values.map(([value]) => value)), step: 0.125,
    default: fallback, options: values.map(([value, text]) => ({ value, label: text })) });
const ceil8 = (mm: number) => Math.ceil(mm / 8 - 1e-9) * 8;
const point = (x: number, y: number, heading: number, z = 0): ShapePoint => ({ x, y, z, heading });
function circle(cx: number, cy: number, radius: number, count = 64): XY[] {
  return Array.from({ length: count }, (_, i) => ({ x: cx + radius*Math.cos(2*Math.PI*i/count), y: cy + radius*Math.sin(2*Math.PI*i/count) }));
}
/** A stub's body rectangle (`half` either side: 31.9 mm standard) from `r0` to `r1` along `angle` about `c`. */
function radialBody(c: XY, angle: number, r0: number, r1: number, half = HALF): XY[] {
  const u = { x: Math.cos(angle), y: Math.sin(angle) }, n = { x: -u.y, y: u.x };
  return [[r0, -half], [r1, -half], [r1, half], [r0, half]].map(([r, l]) => ({ x: c.x + u.x*r + n.x*l, y: c.y + u.y*r + n.y*l }));
}

// ------------------------------------------------------------------ turntable

const TURNTABLE_PARAMS: readonly ParamSpec[] = [
  option('bridge', 'Bridge', 'mm', [[256, '32 studs'], [384, '48 studs'], [512, '64 studs']], 256),
  option('index', 'Stall spacing', 'deg', [[22.5, '22.5°'], [15, '15°'], [11.25, '11.25°']], 22.5),
  { key: 'left', label: 'Stalls left', unit: 'count', min: 0, max: 15, step: 1, default: 3 },
  { key: 'right', label: 'Stalls right', unit: 'count', min: 0, max: 15, step: 1, default: 0 },
  option('drive', 'Drive', '', [[0, 'By hand'], [1, 'Bluetooth motor'], [2, 'Infrared L motor (88003)']], 0)
];
/** Every state id a turntable can have: one per bridge axis (k × spacing), up to 16 axes at 11.25°. */
const AXIS_STATES: readonly StateSpec[] = Array.from({ length: 16 }, (_, k) => ({ id: `a${k}`, label: `Axis ${k + 1}` }));

export interface TurntableShape {
  bridge: number; index: number; left: number; right: number;
  /** Bridge half-length, pit wall (stub rail ends) and port radius, all about the pit centre (port, 0). */
  half: number; wall: number; port: number;
  /** Stall ports: id, label and angle (radians, 0 = straight ahead, + left). */
  ports: { id: string; label: string; angle: number }[];
  /** Bridge axes that line up with at least one port, in state order. */
  axes: { k: number; id: string; label: string; a?: string; b?: string }[];
}
const values = (piece: RoutePiece, params: readonly ParamSpec[]) =>
  Object.fromEntries(params.map(spec => [spec.key, paramValue({ params }, piece, spec.key)]));

export function turntableShape(piece: Pick<RoutePiece, 'params'>): TurntableShape {
  const { bridge, index, left: wantLeft, right: wantRight } = values(piece as RoutePiece, TURNTABLE_PARAMS);
  const positions = Math.round(360 / index), axes = positions / 2;
  const left = Math.min(wantLeft, axes - 1), right = Math.min(wantRight, axes - 1);
  const half = bridge / 2, wall = half + TABLE.gap, theta = index * DEG;
  const crowded = left + right > 0;
  const port = ceil8(Math.max(wall + TABLE.stubMin, crowded ? (HALF + .5) / Math.tan(theta / 2) : 0));
  const ports = [{ id: 'in', label: 'In', angle: Math.PI }, { id: 'out', label: 'Out', angle: 0 },
    ...Array.from({ length: left }, (_, j) => ({ id: `l${j + 1}`, label: `Left ${j + 1}`, angle: (j + 1) * theta })),
    ...Array.from({ length: right }, (_, j) => ({ id: `r${j + 1}`, label: `Right ${j + 1}`, angle: -(j + 1) * theta }))];
  const at = (k: number) => ports.find(item => Math.abs(Math.atan2(Math.sin(item.angle - k*theta), Math.cos(item.angle - k*theta))) < 1e-6);
  const list: TurntableShape['axes'] = [];
  for (let k = 0; k < axes; k++) {
    const a = at(k), b = at(k + axes);
    if (!a && !b) continue;
    list.push({ k, id: `a${k}`, label: a && b ? (k === 0 ? 'In ↔ Out' : `${b.label} ↔ ${a.label}`) : (a ?? b)!.label, a: a?.id, b: b?.id });
  }
  return { bridge, index, left, right, half, wall, port, ports, axes: list };
}
function turntableProblem(shape: TurntableShape, piece: RoutePiece): string | null {
  const { wantLeft, wantRight } = { wantLeft: paramValue({ params: TURNTABLE_PARAMS }, piece, 'left'), wantRight: paramValue({ params: TURNTABLE_PARAMS }, piece, 'right') };
  const axes = Math.round(180 / shape.index);
  if (wantLeft > axes - 1 || wantRight > axes - 1) return `At ${shape.index}° a side holds at most ${axes - 1} stalls.`;
  if (shape.left + shape.right > 0 && shape.wall * Math.sin(shape.index * DEG) - 2*RAIL - 2*HEAD < TABLE.railClear) {
    const need = (2*RAIL + 2*HEAD + TABLE.railClear) / Math.sin(shape.index * DEG) - TABLE.gap;
    return `Neighbouring stall rails touch at the pit edge: ${shape.index}° stalls need a bridge of at least ${Math.ceil(need * 2 / 128) * 16} studs.`;
  }
  return null;
}
function turntablePaths(shape: TurntableShape): PiecePath[] {
  const c = { x: shape.port, y: 0 };
  const angleOf = (id: string) => shape.ports.find(item => item.id === id)!.angle;
  return shape.axes.map(axis => {
    // Both ends lined up: from the far side (b) to a; one end: from that port to the bridge's free end.
    const from = axis.b ?? axis.a!, to = axis.b ? axis.a : undefined;
    const start = angleOf(from), end = start + Math.PI, reach = to ? shape.port : shape.half, heading = Math.atan2(Math.sin(end), Math.cos(end));
    return { id: `bridge-${axis.k}`, from, to: to ?? `free-${axis.k}`, moving: true, states: [axis.id], ...(to ? {} : { stop: true }),
      points: [point(c.x + shape.port*Math.cos(start), c.y + shape.port*Math.sin(start), heading),
        point(c.x, c.y, heading), point(c.x + reach*Math.cos(end), c.y + reach*Math.sin(end), heading)] };
  });
}

export const TURNTABLE: PieceDefinition = {
  family: 'turntable', label: 'Turntable', group: 'mechanism', source: 'printed', styles: ['detailed'],
  params: TURNTABLE_PARAMS, states: AXIS_STATES, gauge: 'standard', body: 'assembly', customJoiner: false, color: STALL_COLOR,
  description: piece => {
    const shape = turntableShape(piece);
    return `${studs(shape.bridge)}-stud bridge · ${shape.left + shape.right} stalls at ${shape.index}° · ⌀${Math.round(2*shape.port)} mm`;
  },
  pieceStates: piece => turntableShape(piece).axes.map(({ id, label }) => ({ id, label })),
  problem: piece => turntableProblem(turntableShape(piece), piece),
  paths: piece => turntablePaths(turntableShape(piece)),
  end: piece => point(2 * turntableShape(piece).port, 0, 0),
  run: piece => 2 * turntableShape(piece).port,
  halt: piece => {
    const shape = turntableShape(piece), state = piece.state && shape.axes.some(axis => axis.id === piece.state) ? piece.state : shape.axes[0].id;
    return `The turntable bridge is turned to ${shape.axes.find(axis => axis.id === state)!.label}.`;
  },
  outline: piece => {
    const shape = turntableShape(piece), c = { x: shape.port, y: 0 };
    return [circle(c.x, c.y, shape.wall + TABLE.wall), ...shape.ports.map(item => radialBody(c, item.angle, shape.wall, shape.port))];
  },
  fixedTrack: piece => {
    const shape = turntableShape(piece), c = { x: shape.port, y: 0 };
    return shape.ports.map(({ angle }) => [point(c.x + shape.wall*Math.cos(angle), c.y + shape.wall*Math.sin(angle), angle),
      point(c.x + shape.port*Math.cos(angle), c.y + shape.port*Math.sin(angle), angle)]);
  },
  envelopes: piece => {
    const shape = turntableShape(piece);
    // A 48-gon circumscribing the bridge's sweep circle.
    return [circle(shape.port, 0, (shape.half + TABLE.clear) / Math.cos(Math.PI / 48), 48)];
  },
  notes: ['Turn the bridge to a stall; magnets in the bridge ends and the pit rim hold it lined up, and a drop-in pin locks it.',
    'Stall tracks attach at the pit\'s connector ends; trains cross only the stall the bridge is turned to.'],
  cad: piece => {
    const shape = turntableShape(piece), state = Math.max(0, shape.axes.findIndex(axis => axis.id === (piece.state ?? shape.axes[0].id)));
    return [{ family: 'turntable', parameters: { bridge: shape.bridge, index: shape.index, left: shape.left, right: shape.right,
      drive: paramValue({ params: TURNTABLE_PARAMS }, piece, 'drive'), switch_state: state } }];
  }
};

// ------------------------------------------------------------------ transfer table

const TRANSFER_PARAMS: readonly ParamSpec[] = [
  option('deck', 'Deck', 'mm', [[256, '32 studs'], [384, '48 studs']], 256),
  { key: 'lanes', label: 'Lanes', unit: 'count', min: 2, max: 6, step: 1, default: 3 },
  option('hand', 'Lanes go', '', [[1, 'Left'], [-1, 'Right']], 1)
];
/** Lanes 16 studs apart (research: transfer table lanes and magnet detents every 128 mm). */
export const LANE_SPACING = 128;
const LANE_STATES: readonly StateSpec[] = Array.from({ length: 6 }, (_, i) => ({ id: `lane${i + 1}`, label: `Lane ${i + 1}` }));
const laneIn = (i: number) => i ? `in${i + 1}` : 'in', laneOut = (i: number) => i ? `out${i + 1}` : 'out';
export function transferShape(piece: Pick<RoutePiece, 'params'>) {
  const { deck, lanes, hand } = values(piece as RoutePiece, TRANSFER_PARAMS);
  const well = deck + 2*TABLE.gap, length = well + 2*TABLE.laneStub;
  return { deck, lanes, hand: hand < 0 ? -1 : 1, well, length, y: (i: number) => (hand < 0 ? -1 : 1) * i * LANE_SPACING };
}

export const TRANSFER_TABLE: PieceDefinition = {
  family: 'transfer_table', label: 'Transfer table', group: 'mechanism', source: 'printed', styles: ['detailed'],
  params: TRANSFER_PARAMS, states: LANE_STATES, gauge: 'standard', body: 'assembly', customJoiner: false, color: STALL_COLOR,
  description: piece => { const shape = transferShape(piece); return `${studs(shape.deck)}-stud deck · ${shape.lanes} lanes 16 studs apart`; },
  pieceStates: piece => LANE_STATES.slice(0, transferShape(piece).lanes),
  paths: piece => {
    const shape = transferShape(piece);
    return Array.from({ length: shape.lanes }, (_, i) => ({ id: `lane-${i + 1}`, from: laneIn(i), to: laneOut(i), moving: true,
      states: [LANE_STATES[i].id], points: [point(0, shape.y(i), 0), point(shape.length, shape.y(i), 0)] }));
  },
  end: piece => point(transferShape(piece).length, 0, 0),
  run: piece => transferShape(piece).length,
  halt: piece => {
    const lane = Math.max(0, LANE_STATES.findIndex(state => state.id === piece.state));
    return `The transfer table deck is at lane ${Math.min(lane, transferShape(piece).lanes - 1) + 1}.`;
  },
  outline: piece => {
    const shape = transferShape(piece), y0 = Math.min(0, shape.y(shape.lanes - 1)) - HALF - TABLE.wall, y1 = Math.max(0, shape.y(shape.lanes - 1)) + HALF + TABLE.wall;
    return [[{ x: TABLE.laneStub, y: y0 }, { x: TABLE.laneStub + shape.well, y: y0 }, { x: TABLE.laneStub + shape.well, y: y1 }, { x: TABLE.laneStub, y: y1 }]];
  },
  fixedTrack: piece => {
    const shape = transferShape(piece);
    return Array.from({ length: shape.lanes }, (_, i) => [[0, TABLE.laneStub], [shape.length - TABLE.laneStub, shape.length]]
      .map(([x0, x1]) => [point(x0, shape.y(i), 0), point(x1, shape.y(i), 0)])).flat();
  },
  envelopes: piece => {
    const shape = transferShape(piece), y0 = Math.min(0, shape.y(shape.lanes - 1)) - HALF - TABLE.clear, y1 = Math.max(0, shape.y(shape.lanes - 1)) + HALF + TABLE.clear;
    return [[{ x: TABLE.laneStub + TABLE.gap, y: y0 }, { x: TABLE.laneStub + TABLE.gap + shape.deck, y: y0 },
      { x: TABLE.laneStub + TABLE.gap + shape.deck, y: y1 }, { x: TABLE.laneStub + TABLE.gap, y: y1 }]];
  },
  flip: given => ({ ...given, hand: -(given.hand ?? 1) }),
  notes: ['Slide the deck to a lane; magnets every 128 mm hold it lined up, and a drop-in pin locks it.'],
  cad: piece => {
    const shape = transferShape(piece);
    return [{ family: 'transfer_table', parameters: { deck: shape.deck, lanes: shape.lanes, hand: shape.hand, switch_state: Math.max(0, Math.min(shape.lanes - 1, LANE_STATES.findIndex(state => state.id === piece.state))) } }];
  }
};

// ------------------------------------------------------------------ sector plate

const SECTOR_PARAMS: readonly ParamSpec[] = [
  option('deck', 'Deck', 'mm', [[384, '48 studs'], [512, '64 studs'], [640, '80 studs']], 512),
  { key: 'tracks', label: 'Tracks', unit: 'count', min: 2, max: 3, step: 1, default: 3 }
];
/**
 * The deck turns about the pivot at its `in` end, so a train meets a kink there equal to the deck's angle: the outer
 * tracks sit at the official flex-track joint limit (5.625°) either side of straight. The far ends fan out until
 * neighbouring track bodies (`half` either side of each centre line) clear.
 */
export const SECTOR_KINK = 5.625;
export interface SectorShape { deck: number; tracks: number; step: number; pivot: number; angles: number[]; reach: number; half: number }
export function sectorGeometry(deck: number, tracks: number, half = HALF): SectorShape {
  const step = (tracks === 2 ? 2 : 1) * SECTOR_KINK * DEG, pivot = TABLE.sectorStub;
  /** Lane angles, symmetric about straight ahead, numbered from the right. */
  const angles = Array.from({ length: tracks }, (_, i) => (i - (tracks - 1) / 2) * step);
  const reach = ceil8(Math.max(deck + TABLE.gap + TABLE.stubMin, (half + .5) / Math.sin(step / 2)));
  return { deck, tracks, step, pivot, angles, reach, half };
}
export function sectorShape(piece: Pick<RoutePiece, 'params'>): SectorShape {
  const { deck, tracks } = values(piece as RoutePiece, SECTOR_PARAMS);
  return sectorGeometry(deck, tracks);
}
const SECTOR_STATES: readonly StateSpec[] = Array.from({ length: 3 }, (_, i) => ({ id: `track${i + 1}`, label: `Track ${i + 1}` }));
/** The set track's index (0 = rightmost); CAD `switch_state`. */
export const sectorTrack = (piece: RoutePiece, tracks: number) => Math.max(0, Math.min(tracks - 1, SECTOR_STATES.findIndex(state => state.id === piece.state)));

/** Everything a swinging deck does in the editor and Test drive, for a shape and the words `halt` says it with. */
export function sectorDeck(shapeOf: (piece: RoutePiece) => SectorShape, swung: (track: number) => string):
  Pick<PieceDefinition, 'states' | 'pieceStates' | 'paths' | 'end' | 'run' | 'halt' | 'outline' | 'fixedTrack' | 'envelopes'> {
  return {
    states: SECTOR_STATES,
    pieceStates: piece => SECTOR_STATES.slice(0, shapeOf(piece).tracks).map((state, i, all) =>
      ({ ...state, label: all.length % 2 && i === (all.length - 1) / 2 ? `${state.label} (straight)` : state.label })),
    // The far port of the middle track (the left one of two) is `out`, so a chain continues from it.
    paths: piece => {
      const shape = shapeOf(piece), out = Math.floor(shape.tracks / 2);
      return shape.angles.map((angle, i) => ({ id: `track-${i + 1}`, from: 'in', to: i === out ? 'out' : `out${i + 1}`, moving: true,
        states: [SECTOR_STATES[i].id], points: [point(0, 0, 0), point(shape.pivot, 0, angle),
          point(shape.pivot + shape.reach*Math.cos(angle), shape.reach*Math.sin(angle), angle)] }));
    },
    end: piece => {
      const shape = shapeOf(piece), angle = shape.angles[Math.floor(shape.tracks / 2)];
      return point(shape.pivot + shape.reach*Math.cos(angle), shape.reach*Math.sin(angle), angle);
    },
    run: piece => shapeOf(piece).pivot + shapeOf(piece).reach,
    halt: piece => swung(sectorTrack(piece, shapeOf(piece).tracks) + 1),
    outline: piece => {
      const shape = shapeOf(piece), { half } = shape, spread = shape.angles.at(-1)! + Math.atan2(half + TABLE.wall, shape.deck);
      const arc = Array.from({ length: 17 }, (_, i) => -spread + 2*spread*i/16)
        .map(angle => ({ x: shape.pivot + (shape.deck + TABLE.gap + TABLE.wall)*Math.cos(angle), y: (shape.deck + TABLE.gap + TABLE.wall)*Math.sin(angle) }));
      return [[{ x: shape.pivot, y: -half - TABLE.wall }, ...arc, { x: shape.pivot, y: half + TABLE.wall }],
        ...shape.angles.map(angle => radialBody({ x: shape.pivot, y: 0 }, angle, shape.deck + TABLE.gap, shape.reach, half))];
    },
    fixedTrack: piece => {
      const shape = shapeOf(piece);
      return [[point(0, 0, 0), point(shape.pivot, 0, 0)], ...shape.angles.map(angle => [
        point(shape.pivot + (shape.deck + TABLE.gap)*Math.cos(angle), (shape.deck + TABLE.gap)*Math.sin(angle), angle),
        point(shape.pivot + shape.reach*Math.cos(angle), shape.reach*Math.sin(angle), angle)])];
    },
    envelopes: piece => {
      const shape = shapeOf(piece), { half } = shape;
      const spread = shape.angles.at(-1)! + Math.atan2(half, shape.deck), far = Math.hypot(shape.deck, half) + TABLE.clear;
      // Behind the pivot: the deck's hub (8.3 mm bore + 4.5 mm wall) and the sweep clearance.
      const back = 8.3 / 2 + 4.5 + TABLE.clear;
      return [[{ x: shape.pivot - back, y: -half - TABLE.clear }, ...Array.from({ length: 13 }, (_, i) => -spread + 2*spread*i/12)
        .map(angle => ({ x: shape.pivot + far*Math.cos(angle), y: far*Math.sin(angle) })), { x: shape.pivot - back, y: half + TABLE.clear }]];
    }
  };
}

export const SECTOR_PLATE: PieceDefinition = {
  family: 'sector_plate', label: 'Sector plate', group: 'mechanism', source: 'printed', styles: ['detailed'],
  params: SECTOR_PARAMS, gauge: 'standard', body: 'assembly', customJoiner: false, color: STALL_COLOR,
  description: piece => { const shape = sectorShape(piece); return `${studs(shape.deck)}-stud deck · ${shape.tracks} tracks · ${(shape.step / DEG).toFixed(2)}° apart`; },
  ...sectorDeck(sectorShape, track => `The sector plate is swung to track ${track}.`),
  notes: ['Swing the deck to a track; magnets at each track hold it, and a drop-in pin locks it.',
    'The deck turns at most 5.625° at its pivot (a flexible-track joint); the far ends are off the stud grid, so join them with Close gap.'],
  cad: piece => {
    const shape = sectorShape(piece);
    return [{ family: 'sector_plate', parameters: { deck: shape.deck, tracks: shape.tracks, switch_state: sectorTrack(piece, shape.tracks) } }];
  }
};

export const TABLE_FAMILIES: readonly PieceDefinition[] = [TURNTABLE, TRANSFER_TABLE, SECTOR_PLATE];
