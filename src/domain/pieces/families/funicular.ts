import type { RoutePiece } from '../../project';
import { paramValue } from '../composite';
import type { ParamSpec, PieceDefinition, ShapePoint } from '../types';
import { PRINTED_COLOR, studs } from './composite-piece';

/**
 * Funicular (Experimental; cad/models/funicular.py builds it with the same numbers). One car is hauled up a steep
 * straight by a string winch: a purchased plank lies at the grade on two printed wedge feet; on it, from the bottom,
 * a 64 mm buffer stop, `climb`/16 printed 16-stud tracks (each with a cable-guide saddle between the rails) and the
 * top station (a 64 mm buffer stop plus the winch deck, motor beside it). Its single path is a `cable` path: both
 * ports are stops, so it never joins the network, and the car may climb any grade.
 * Piece frame: `in` is the track underside at the bottom buffer's low end, raised by the foot and the plank.
 */
type XY = { x: number; y: number };
export const FUNICULAR_FAMILY = 'funicular';
/** Mirrors funicular.py: track piece, buffer, top station part, plank, wedge feet, winch axle and motor plate. */
export const FUNICULAR = { segment: 128, buffer: 64, face: 44, station: 112, plankT: 12, plankW: 70,
  footMin: 4, seat: 48, lip: 4, lipH: 6, footHalf: 35, drumU: 89, axleW: 29, plateBack: 9.5 + 7.8 } as const;
/** drives.MOTORS keep-out boxes: length along the axle, width, height. */
export const FUNICULAR_MOTOR_BOX = [{ length: 66, width: 40, height: 44 }, { length: 50, width: 48, height: 48 }] as const;

const CLIMBS = [32, 48, 64, 80, 96, 112, 128];
const PARAMS: readonly ParamSpec[] = [
  { key: 'climb', label: 'Climb', unit: 'studs', min: 32, max: 128, step: 16, default: 64,
    options: CLIMBS.map(value => ({ value, label: `${value} studs (${value * 8} mm)` })) },
  { key: 'grade', label: 'Grade', unit: '%', min: 20, max: 60, step: 5, default: 35 },
  { key: 'motor', label: 'Motor', unit: '', min: 0, max: 1, step: 1, default: 0,
    options: [{ value: 0, label: 'Bluetooth L motor (88013)' }, { value: 1, label: 'Bluetooth M motor (88008)' }] },
  { key: 'side', label: 'Motor side', unit: '', min: -1, max: 1, step: 2, default: 1,
    options: [{ value: 1, label: 'Right' }, { value: -1, label: 'Left' }] }
];

export interface FunicularShape { climb: number; grade: number; motor: number; side: number; theta: number; zIn: number; run: number; plank: number }
/** The buildable shape of a piece's settings (climb snapped to whole tracks, grade to whole percent). */
export function funicularShape(piece: Pick<RoutePiece, 'params'>): FunicularShape {
  const value = (key: string) => paramValue({ params: PARAMS }, piece as RoutePiece, key);
  const segments = Math.min(8, Math.max(2, Math.round(value('climb') / 16)));
  const grade = Math.min(60, Math.max(20, Math.round(value('grade'))));
  const theta = Math.atan(grade / 100), climb = segments * FUNICULAR.segment;
  return { climb, grade, motor: value('motor') === 1 ? 1 : 0, side: value('side') === -1 ? -1 : 1, theta,
    zIn: FUNICULAR.footMin + FUNICULAR.plankT * Math.cos(theta), run: 2 * FUNICULAR.buffer + climb,
    plank: FUNICULAR.buffer + climb + FUNICULAR.station };
}
/** Piece-frame (x, z) of slope-frame (u along the plank top from its lower end, w up from it). */
export function funicularSlope(s: FunicularShape, u: number, w = 0): { x: number; z: number } {
  const c = Math.cos(s.theta), n = Math.sin(s.theta);
  return { x: u * c - w * n, z: s.zIn + u * n + w * c };
}
const rect = (x0: number, x1: number, y0: number, y1: number): XY[] =>
  [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];

/** Height of the level surface the top foot stands on (funicular.support_height). */
export function funicularSupportHeight(piece: Pick<RoutePiece, 'params'>): number {
  const s = funicularShape(piece);
  return (s.plank - FUNICULAR.seat) * Math.sin(s.theta);
}
/**
 * Plan polygons: `floor` is what stands on the table (the bottom foot and the top foot's support); `footprint` is
 * everything the piece occupies (the plank, and the motor's keep-out box, funicular.motor_box), for collision checks.
 */
function plan(s: FunicularShape): { floor: XY[][]; footprint: XY[][] } {
  const { plankT: t, seat, lip, lipH, footHalf, plankW } = FUNICULAR;
  const c = Math.cos(s.theta), n = Math.sin(s.theta), back = s.plank * c + t * n;
  const box = FUNICULAR_MOTOR_BOX[s.motor], u = FUNICULAR.buffer + s.climb + FUNICULAR.drumU;
  const [u0, u1, w0, w1] = [u - box.width / 2, u + box.width / 2, FUNICULAR.axleW - box.height / 2, FUNICULAR.axleW + box.height / 2];
  const y = [-s.side * FUNICULAR.plateBack, -s.side * (FUNICULAR.plateBack + box.length)].sort((a, b) => a - b);
  const motor = rect(u0 * c - w1 * n, u1 * c - w0 * n, y[0], y[1]);
  return { floor: [rect(-lip * c + (t - lipH) * n, seat * c + t * n, -footHalf, footHalf),
    rect((s.plank - seat) * c + t * n, back, -footHalf, footHalf)],
  footprint: [rect(-lip * c + (t - lipH) * n, back, -plankW / 2, plankW / 2), motor] };
}

export const FUNICULAR_PIECE: PieceDefinition = {
  family: FUNICULAR_FAMILY, label: 'Funicular', group: 'experimental', source: 'printed', styles: ['detailed', 'fast'],
  params: PARAMS, gauge: 'standard', body: 'assembly', customJoiner: false, color: PRINTED_COLOR,
  caution: 'Cable-hauled: one car on a string winch; needs a Bluetooth motor, a straight plank and a support at the top.',
  description: piece => {
    const s = funicularShape(piece);
    return `${studs(s.climb)} studs at ${s.grade}% · rises ${Math.round(s.run * Math.sin(s.theta))} mm · ${s.motor ? 'M' : 'L'} motor`;
  },
  notes: ['One car is wound up and let down on a string by a Bluetooth motor; it never joins other track.',
    'The plank lies on the two printed feet: the top foot stands on a level support (its height is in the assembly notes).',
    'Hitch the car with the printed clip: a magnet on its coupler, or a brick plate bridged onto the clip\'s studs.'],
  paths: piece => {
    const s = funicularShape(piece);
    const stations = [0, ...Array.from({ length: s.climb / FUNICULAR.segment + 1 }, (_, k) => FUNICULAR.buffer + k * FUNICULAR.segment), s.run];
    return [{ id: 'main', from: 'in', to: 'out', cable: true,
      points: stations.map((u): ShapePoint => ({ ...funicularSlope(s, u), y: 0, heading: 0, pitch: s.theta })) }];
  },
  run: piece => { const s = funicularShape(piece); return s.run * Math.cos(s.theta); },
  // Its feet carry it: generic supports and risers stay out from under the plank.
  ownSupports: () => true,
  outline: piece => plan(funicularShape(piece)).floor,
  envelopes: piece => plan(funicularShape(piece)).footprint,
  flip: params => ({ ...params, side: params.side === -1 ? 1 : -1 }),
  cad: piece => {
    const s = funicularShape(piece);
    return [{ family: FUNICULAR_FAMILY, parameters: { length: s.climb, grade: s.grade, motor: s.motor, side: s.side } }];
  }
};
