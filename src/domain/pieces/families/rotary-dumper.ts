import type { RoutePiece } from '../../project';
import { paramValue } from '../composite';
import type { ParamSpec, PieceDefinition, ShapePoint, StateSpec } from '../types';
import { PRINTED_COLOR, studs } from './composite-piece';

/**
 * Rotary dumper (experimental; cad/models/rotary_dumper.py builds it with the same numbers). A straight piece from `in`
 * (x = 0) to `out`: two fixed 48 mm landings carry the stands; between them a cradle `span` long (less a 0.6 mm rail gap
 * at each end) turns 150° about an axis along the track, 72 mm up, on end rings rolling on 608 bearings, to empty one
 * clamped 6-wide wagon. Upright, its rails line up with the landings and trains run through (a moving path, open only
 * in `upright`); tipped, the route ends at the landing with the halt message.
 */
type XY = { x: number; y: number };
const HALF = 31.9;
/** Mirrors rotary_dumper.py: landing, rail gap, ring radius, cheek and spacer, the out ring's stop lug, crank and pinion. */
export const DUMPER = { landing: 48, gap: .6, ring: 70, cheek: 6, spacer: 2.3, lug: 4, bracket: 71, post: 69,
  standIn: 66, standLeft: 80, pinionY: -72.4503, crankX: 26, crankReach: 34, motor: { x0: -34.8, y0: -92.8503, y1: -52.0503 } } as const;
const D0 = DUMPER.landing + DUMPER.gap;

const SPAN: ParamSpec = { key: 'span', label: 'Cradle', unit: 'mm', min: 128, max: 160, step: 8, default: 128 };
const DRIVE: ParamSpec = { key: 'drive', label: 'Drive', unit: '', min: 0, max: 2, step: 1, default: 0,
  options: [{ value: 0, label: 'Hand crank' }, { value: 1, label: 'Bluetooth motor' }, { value: 2, label: 'Infrared L motor (88003)' }] };
/** The description's word for each drive. */
const DRIVE_WORDS = ['hand crank', 'Bluetooth motor', 'infrared motor'] as const;
const PARAMS: readonly ParamSpec[] = [SPAN, DRIVE];
const STATES: readonly StateSpec[] = [{ id: 'upright', label: 'Upright' }, { id: 'tipped', label: 'Tipped' }];

const point = (x: number): ShapePoint => ({ x, y: 0, z: 0, heading: 0 });
const rect = (x0: number, x1: number, y0: number, y1: number): XY[] => [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];
const values = (piece: Pick<RoutePiece, 'params'>) =>
  Object.fromEntries(PARAMS.map(spec => [spec.key, paramValue({ params: PARAMS }, piece as RoutePiece, spec.key)]));
const lengthOf = (piece: Pick<RoutePiece, 'params'>) => 2 * DUMPER.landing + values(piece).span;

/** Fixed stands beside the landings (rotary_dumper.outline): roller towers, the pinion bracket, the motor and its plate
 * (one plan for both motors: their keep-outs are 66 mm long and no wider than the plate). */
export function dumperOutline(length: number, drive: number): XY[][] {
  const { landing: l, cheek, spacer, bracket, post, standIn, standLeft, pinionY, motor } = DUMPER;
  return [rect(0, l, -HALF, HALF), rect(length - l, length, -HALF, HALF),
    rect(l - cheek, l + spacer, HALF - .5, standIn), rect(l - cheek, l + spacer, -standLeft, -HALF + .5),
    rect(l - cheek, bracket, -standLeft, pinionY + 6),
    rect(length - l - spacer, length - l + cheek, HALF - .5, post), rect(length - l - spacer, length - l + cheek, -post, -HALF + .5),
    ...(drive ? [rect(motor.x0, l - cheek + .5, motor.y0, motor.y1)] : [])];
}

/** The cradle's plan through 0..150° (its end rings and the lug past the out ring), and the crank's circle. */
export function dumperEnvelopes(length: number, drive: number): XY[][] {
  const { ring, lug, landing: l, cheek, pinionY, crankX, crankReach } = DUMPER;
  return [rect(D0 - .5, length - D0 + lug + .5, -ring - .5, ring + .5),
    ...(drive ? [] : [rect(crankX - .5, l - cheek, pinionY - crankReach, pinionY + crankReach)])];
}

export const ROTARY_DUMPER: PieceDefinition = {
  family: 'rotary_dumper', label: 'Rotary dumper', group: 'experimental', source: 'printed', styles: ['detailed', 'fast'],
  params: PARAMS, states: STATES, gauge: 'standard', body: 'assembly', customJoiner: false, color: PRINTED_COLOR,
  caution: 'One uncoupled 6-wide wagon ≤ 80 mm tall; the load drops under the cradle — clear it before tipping back.',
  notes: ['The cradle rolls 150° on two end rings over 608 bearings; side walls and rim ledges hold the wagon, a lug on stop blocks and magnets set it upright with the rails lined up.',
    'Only 6-wide stock up to 80 mm over the rails runs through it.'],
  description: piece => {
    const { span, drive } = values(piece);
    return `${studs(span)}-stud cradle · ${DRIVE_WORDS[drive] ?? DRIVE_WORDS[0]} · ${studs(lengthOf(piece))} studs overall`;
  },
  paths: piece => [{ id: 'main', from: 'in', to: 'out', moving: true, states: [STATES[0].id], points: [point(0), point(lengthOf(piece))] }],
  end: piece => point(lengthOf(piece)),
  run: lengthOf,
  halt: () => 'The dumper is tipped.',
  fixedTrack: piece => [[point(0), point(DUMPER.landing)], [point(lengthOf(piece) - DUMPER.landing), point(lengthOf(piece))]],
  outline: piece => dumperOutline(lengthOf(piece), values(piece).drive),
  envelopes: piece => dumperEnvelopes(lengthOf(piece), values(piece).drive),
  cad: piece => [{ family: 'rotary_dumper', parameters: { ...values(piece),
    state: Math.max(0, STATES.findIndex(state => state.id === piece.state)) } }]
};
