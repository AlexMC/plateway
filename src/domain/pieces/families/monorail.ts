import type { RoutePiece } from '../../project';
import { paramValue } from '../composite';
import { arc, origin } from '../geometry';
import type { ParamSpec, PieceDefinition, ShapePoint, StateSpec } from '../types';

/**
 * Brick monorail (cad/models/monorail.py): a 32 mm (4-stud) wide, 12.8 mm tall beam whose centre groove
 * holds a module-0.5 rack rod (163 teeth a side per 256 mm) for a brick monorail motor's gear. Its own gauge
 * network: every path is `monorail`, so it mates only monorail ports. Paths run along the beam's underside centre
 * line; ramps climb as one parabolic easing (37.5 % at the joint of the lower and upper parts), which only a
 * rack-driven monorail motor climbs. Elevated track stands on brick columns under the joint plates.
 */
type XY = { x: number; y: number };
const STUD = 8;
/** Centre-line radius of the quarter curve (28 studs; part 2672). */
export const MONORAIL_CURVE_RADIUS = 224;
/** Ramp part plan length and rise (parts 2677 lower / 2678 upper [INFERENCE from their bounding boxes]). */
export const MONORAIL_RAMP = { run: 256, rise: 48 } as const;
/** Steepest grade on a monorail path: each ramp part is one parabola, 2 · rise / run at its steep end. */
export const MONORAIL_MAX_GRADE = 2 * MONORAIL_RAMP.rise / MONORAIL_RAMP.run;
/** Switch: 256 mm straight route; diverging route 32 mm straight then R448 for 30°, ending (256, 60). */
export const MONORAIL_SWITCH = { length: 256, lead: 32, radius: 448, angle: Math.PI / 6 } as const;
const CAUTION = 'Needs a classic brick monorail motor; joints to original monorail track are untested.';
const COLOR = 0x9a9ea3;

const SLOT_PARAMS: readonly ParamSpec[] = [
  { key: 'slot_width', label: 'Slot width', unit: 'mm', min: 16.5, max: 22, step: .1, default: 17.5 },
  { key: 'slot_depth', label: 'Slot depth', unit: 'mm', min: 4, max: 7.2, step: .1, default: 6.4 }
];
const HAND: ParamSpec = { key: 'hand', label: 'Hand', unit: '', min: -1, max: 1, step: 2, default: 1,
  options: [{ value: 1, label: 'Left' }, { value: -1, label: 'Right' }] };
const LENGTH: ParamSpec = { key: 'length', label: 'Length', unit: 'studs', min: 4, max: 32, step: 4, default: 32 };
const ANGLE: ParamSpec = { key: 'angle', label: 'Angle', unit: 'deg', min: 30, max: 90, step: 15, default: 90,
  options: [{ value: 30, label: '30°' }, { value: 45, label: '45°' }, { value: 90, label: '90° (classic quarter)' }] };
const PART: ParamSpec = { key: 'part', label: 'Part', unit: '', min: 0, max: 1, step: 1, default: 0,
  options: [{ value: 0, label: 'Lower (level → 37.5 %)' }, { value: 1, label: 'Upper (37.5 % → level)' }] };
const CLIMB: ParamSpec = { key: 'climb', label: 'Direction', unit: '', min: -1, max: 1, step: 2, default: 1,
  options: [{ value: 1, label: 'Up' }, { value: -1, label: 'Down' }] };
const SWITCH_STATES: readonly StateSpec[] = [{ id: 'straight', label: 'Straight' }, { id: 'diverging', label: 'Diverging' }];

const value = (params: readonly ParamSpec[], piece: RoutePiece, key: string) => paramValue({ params }, piece, key);
const sign = (n: number) => n < 0 ? -1 : 1;
const slots = (params: readonly ParamSpec[], piece: RoutePiece) =>
  ({ slot_width: value(params, piece, 'slot_width'), slot_depth: value(params, piece, 'slot_depth') });
const NOTES = ['No supports needed: under each joint press a 2 x 4 brick plate into the sockets of both pieces; stack bricks under those plates to raise the track.',
  'The groove and rack are sized for a classic brick monorail motor [unverified]: print a 4-stud straight first and adjust Slot width / depth until the motor runs freely.'];

function common(family: string, label: string, params: readonly ParamSpec[]): Pick<PieceDefinition,
  'family' | 'label' | 'group' | 'source' | 'styles' | 'params' | 'gauge' | 'body' | 'customJoiner' | 'color' | 'caution'> {
  return { family, label, group: 'experimental', source: 'printed', styles: ['detailed', 'fast'], params: [...params, ...SLOT_PARAMS],
    gauge: 'monorail', body: 'assembly', customJoiner: false, color: COLOR, caution: CAUTION };
}

// ------------------------------------------------------------------ straight
const STRAIGHT_PARAMS = [LENGTH];
const straightLength = (piece: RoutePiece) => value([...STRAIGHT_PARAMS, ...SLOT_PARAMS], piece, 'length') * STUD;
export const MONORAIL_STRAIGHT: PieceDefinition = {
  ...common('monorail_straight', 'Monorail straight', STRAIGHT_PARAMS),
  description: piece => `${straightLength(piece) / STUD} studs · ${straightLength(piece)} mm beam`,
  paths: piece => [{ id: 'main', from: 'in', to: 'out', points: [origin(), { x: straightLength(piece), y: 0, z: 0, heading: 0 }] }],
  run: straightLength,
  notes: [...NOTES, 'The 4-stud straight is the calibration coupon for the slot and rack.'],
  cad: piece => [{ family: 'monorail_straight', parameters: { length: straightLength(piece), ...slots(MONORAIL_STRAIGHT.params, piece) } }]
};

// ------------------------------------------------------------------ curve
const CURVE_PARAMS = [ANGLE, HAND];
const curveValues = (piece: RoutePiece) => ({ angle: value([...CURVE_PARAMS, ...SLOT_PARAMS], piece, 'angle'),
  hand: sign(value([...CURVE_PARAMS, ...SLOT_PARAMS], piece, 'hand')) });
function curvePoints(piece: RoutePiece): ShapePoint[] {
  const { angle, hand } = curveValues(piece), points = [origin()];
  arc(points, MONORAIL_CURVE_RADIUS, hand * angle * Math.PI / 180);
  return points;
}
export const MONORAIL_CURVE: PieceDefinition = {
  ...common('monorail_curve', 'Monorail curve', CURVE_PARAMS),
  description: piece => { const { angle, hand } = curveValues(piece); return `R28 · ${angle}° ${hand > 0 ? 'left' : 'right'}`; },
  paths: piece => [{ id: 'main', from: 'in', to: 'out', points: curvePoints(piece) }],
  run: piece => MONORAIL_CURVE_RADIUS * curveValues(piece).angle * Math.PI / 180,
  notes: [...NOTES, 'Four 90° curves make a circle; the outer side of the rack carries 3 more teeth per quarter, as the classic curve does.'],
  flip: params => ({ ...params, hand: -sign(params.hand ?? 1) }),
  reverseParams: params => ({ ...params, hand: -sign(params.hand ?? 1) }),
  cad: piece => [{ family: 'monorail_curve', parameters: { ...curveValues(piece), ...slots(MONORAIL_CURVE.params, piece) } }]
};

// ------------------------------------------------------------------ ramp
const RAMP_PARAMS = [PART, CLIMB];
const rampValues = (piece: RoutePiece) => ({ part: value([...RAMP_PARAMS, ...SLOT_PARAMS], piece, 'part') === 1 ? 1 : 0,
  climb: sign(value([...RAMP_PARAMS, ...SLOT_PARAMS], piece, 'climb')) });
/** Height and grade along a ramp part, x in 0..256 (mirrors monorail.RampRoute). */
export function monorailRampProfile(part: number, climb: number, x: number): { z: number; grade: number } {
  const { run, rise } = MONORAIL_RAMP, u = x / run, easeIn = (part === 0) === (climb > 0);
  return easeIn ? { z: climb * rise * u * u, grade: climb * 2 * rise / run * u }
    : { z: climb * rise * (1 - (1 - u) ** 2), grade: climb * 2 * rise / run * (1 - u) };
}
function rampPoints(piece: RoutePiece): ShapePoint[] {
  const { part, climb } = rampValues(piece), steps = 32;
  return Array.from({ length: steps + 1 }, (_, i) => {
    const x = MONORAIL_RAMP.run * i / steps, { z, grade } = monorailRampProfile(part, climb, x);
    return { x, y: 0, z, heading: 0, pitch: Math.atan(grade) };
  });
}
export const MONORAIL_RAMP_PIECE: PieceDefinition = {
  ...common('monorail_ramp', 'Monorail ramp', RAMP_PARAMS),
  description: piece => { const { part, climb } = rampValues(piece);
    return `${part ? 'Upper' : 'Lower'} part · ${climb > 0 ? 'up' : 'down'} ${MONORAIL_RAMP.rise} mm · max ${MONORAIL_MAX_GRADE * 100} %`; },
  paths: piece => [{ id: 'main', from: 'in', to: 'out', points: rampPoints(piece) }],
  run: () => MONORAIL_RAMP.run,
  notes: [...NOTES, 'Lower then upper part lift the beam 96 mm over 512 mm; the joint between them is at 37.5 % and needs its own column.',
    'Prints on its side face.'],
  flip: params => ({ ...params, climb: -sign(params.climb ?? 1) }),
  reverseParams: params => ({ ...params, climb: -sign(params.climb ?? 1) }),
  cad: piece => [{ family: 'monorail_ramp', parameters: { ...rampValues(piece), ...slots(MONORAIL_RAMP_PIECE.params, piece) } }]
};

// ------------------------------------------------------------------ switch
const SWITCH_PARAMS = [HAND];
const switchHand = (piece: RoutePiece) => sign(value([...SWITCH_PARAMS, ...SLOT_PARAMS], piece, 'hand'));
function branchPoints(hand: number): ShapePoint[] {
  const points: ShapePoint[] = [origin(), { x: MONORAIL_SWITCH.lead, y: 0, z: 0, heading: 0 }];
  arc(points, MONORAIL_SWITCH.radius, hand * MONORAIL_SWITCH.angle);
  return points;
}
/** Plan zone of the slide's travel, its walls and end stop (mirrors monorail.SwitchLayout), piece frame. */
export function monorailSwitchEnvelope(slotWidth: number, hand: number): XY[] {
  const shift = slotWidth / 2 + 16, { lead, radius } = MONORAIL_SWITCH;
  const x1 = lead + Math.sqrt(radius ** 2 - (radius - shift) ** 2);
  const y0 = -16 - shift - .3 - 4, y1 = 2 * shift + 16 + .3 + 6 + 2;
  const rect = [{ x: lead - 6, y: y0 }, { x: x1 + 6, y: y0 }, { x: x1 + 6, y: y1 }, { x: lead - 6, y: y1 }];
  return hand > 0 ? rect : rect.map(point => ({ x: point.x, y: -point.y })).reverse();
}
export const MONORAIL_SWITCH_PIECE: PieceDefinition = {
  ...common('monorail_switch', 'Monorail switch', SWITCH_PARAMS),
  states: SWITCH_STATES, handed: true,
  description: piece => `256 mm · R56 30° ${switchHand(piece) > 0 ? 'left' : 'right'}`,
  paths: piece => [{ id: 'main', from: 'in', to: 'out', points: [origin(), { x: MONORAIL_SWITCH.length, y: 0, z: 0, heading: 0 }], states: ['straight'] },
    { id: 'branch', from: 'in', to: 'branch', points: branchPoints(switchHand(piece)), states: ['diverging'] }],
  run: () => MONORAIL_SWITCH.length,
  envelopes: piece => [monorailSwitchEnvelope(value(MONORAIL_SWITCH_PIECE.params, piece, 'slot_width'), switchHand(piece))],
  notes: [...NOTES, 'A slide carrying a straight and a curved groove moves across by hand (the classic switch\'s patent principle); magnets hold it at either end stop.'],
  flip: params => ({ ...params, hand: -sign(params.hand ?? 1) }),
  cad: piece => [{ family: 'monorail_switch', parameters: { hand: switchHand(piece), switch_state: piece.state === 'diverging' ? 1 : 0,
    ...slots(MONORAIL_SWITCH_PIECE.params, piece) } }]
};

export const MONORAIL_FAMILIES: readonly PieceDefinition[] = [MONORAIL_STRAIGHT, MONORAIL_CURVE, MONORAIL_RAMP_PIECE, MONORAIL_SWITCH_PIECE];
