import type { RoutePiece } from '../../project';
import { ELEVATION, RAMP_GRADES, transitionLength } from '../../elevation';
import { BRICK_LAYOUT } from '../../track';
import { paramValue } from '../composite';
import type { CompositeTrack, PieceDefinition } from '../types';
import { DEG, compositePiece, type Values } from './composite-piece';
import type { TrackKind } from './kinds';

/** Ramp parts: ease from level onto the grade, constant grade, ease from the grade back to level. */
export const RAMP_PARTS = [{ value: 0, label: 'Start' }, { value: 1, label: 'Slope' }, { value: 2, label: 'End' }] as const;
/** A slope piece with automatic length is one 16-stud track. */
const SLOPE_LENGTH = BRICK_LAYOUT.straightLength;

/** Plan length of a ramp piece: the arc on a curve, else the set length, else (0 = automatic) one eased transition or one track. */
export function rampLength({ part, grade, length, radius, sweep }: Values): number {
  if (sweep) return radius * Math.abs(sweep) * DEG;
  if (length) return length;
  return part === 1 ? SLOPE_LENGTH : transitionLength(grade / 100);
}
/** Vertical-curve radius of an easing part (mm); Infinity on a constant slope. */
export function rampVerticalRadius(values: Values): number {
  return values.part === 1 || !values.grade ? Infinity : rampLength(values) / Math.abs(values.grade / 100);
}

/**
 * Ramp set (C2 vertical profile): `part` 0 eases from level onto `grade` (signed percent, + climbs in the authored
 * direction), 1 holds it, 2 eases back to level. Each easement is one parabola, so its vertical-curve radius is
 * length / grade; on a curve (`sweep` ≠ 0) the length is the arc. Graded composites print flat as wedges.
 */
export const TRACK_RAMP: PieceDefinition = {
  ...compositePiece({
    family: 'track_ramp', label: 'Ramp set', curved: true, color: 0x7dc5d7,
    params: [
      { key: 'part', label: 'Part', unit: '', min: 0, max: 2, step: 1, default: 0, options: RAMP_PARTS.map(part => ({ ...part })) },
      { key: 'grade', label: 'Grade', unit: '%', min: -6, max: 6, step: 0.1, default: 4 },
      { key: 'length', label: 'Length', unit: 'mm', min: 0, max: 2000, step: 8, default: 0 },
      { key: 'radius', label: 'Radius', unit: 'mm', min: 192, max: 1472, step: 8, default: BRICK_LAYOUT.curveRadius },
      { key: 'sweep', label: 'Angle', unit: 'deg', min: -90, max: 90, step: 0.125, default: 0 }
    ],
    track: (values): CompositeTrack => {
      const length = rampLength(values), g = values.grade / 100, k = values.sweep ? Math.sign(values.sweep) / values.radius : 0;
      const [grade0, grade1] = values.part === 0 ? [0, g] : values.part === 1 ? [g, g] : [g, 0];
      return { segments: [{ len: length, k0: k, k1: k }], z0: 0, z1: (grade0 + grade1) / 2 * length, grade0, grade1, cant0: 0, cant1: 0,
        vcurve: grade0 === grade1 ? 0 : ELEVATION.minVerticalRadius };
    },
    description: values => {
      const part = RAMP_PARTS[values.part]?.label ?? 'Ramp', rise = values.grade / 100 * rampLength(values) * (values.part === 1 ? 1 : 0.5);
      return `${part} · ${Math.abs(values.grade)}% ${values.grade < 0 ? 'down' : 'up'} · ${Math.round(rampLength(values))} mm · ${rise >= 0 ? '+' : '−'}${Math.abs(rise).toFixed(1)} mm`;
    },
    // From the far end a start is an end on the opposite grade, and a curve turns the other way.
    reverseParams: values => ({ ...values, part: 2 - values.part, grade: -values.grade, sweep: -values.sweep })
  }),
  group: 'elevation' as const,
  notes: ['Prints flat as a wedge; columns or risers hold it at height.'],
  // Flip turns a curved ramp the other way, and a straight one from climbing to descending.
  flip: (given: Values) => {
    const sweep = given.sweep ?? 0;
    return sweep ? { ...given, sweep: -sweep } : { ...given, grade: -(given.grade ?? 4) };
  }
};

/** The kind's values for a piece: grade as a size plus `climb` (+1 up, −1 down). */
function kindValues(piece: RoutePiece): Values {
  const value = (key: string) => paramValue(TRACK_RAMP, piece, key), grade = value('grade');
  return { part: value('part'), grade: Math.abs(grade), climb: grade < 0 ? -1 : 1, length: value('length'), radius: value('radius'), sweep: value('sweep') };
}
const shapeParams = ({ part, grade, climb, length, radius, sweep }: Values): Values => ({ part, grade: climb * grade, length, radius, sweep });

export const RAMP_KIND: TrackKind = {
  id: 'ramp', group: 'elevation', label: 'Ramp set', hand: 'sweep',
  families: [TRACK_RAMP.family],
  rows: [
    { label: 'Part', match: ['part'], choices: [
      { label: 'Start', values: { part: 0 }, title: 'Eases from level track onto the grade' },
      { label: 'Slope', values: { part: 1 }, title: 'Constant grade' },
      { label: 'End', values: { part: 2 }, title: 'Eases from the grade back to level track' }] },
    { label: 'Grade', match: ['grade'],
      choices: RAMP_GRADES.map(grade => ({ label: `${grade}%`, values: { grade },
        title: `${(grade * 1.28).toFixed(2)} mm per 16-stud track · ${grade <= 4 ? 'easy for long trains' : 'the steepest brick trains manage'}` })),
      custom: [{ key: 'grade', label: 'Grade', unit: '%', min: 0.5, max: ELEVATION.maxGrade * 100, step: 0.1 }] },
    { label: 'Direction', match: ['climb'], choices: [{ label: 'Up ↗', values: { climb: 1 } }, { label: 'Down ↘', values: { climb: -1 } }] },
    { label: 'Plan', match: ['radius', 'sweep'],
      choices: [{ label: 'Straight', values: { sweep: 0 } },
        ...[[40, 22.5], [56, 22.5], [72, 22.5], [88, 11.25]].map(([r, sweep]) => ({ label: `R${r} ${sweep}°`, values: { radius: r * 8, sweep },
          title: `On a ${r * 8} mm radius curve` }))],
      custom: [{ key: 'radius', label: 'Radius', unit: 'mm', min: 192, max: 1472, step: 8 },
        { key: 'sweep', label: 'Angle', unit: 'deg', min: 0.5, max: 90, step: 0.125, signed: true }] },
    { label: 'Length', match: ['length'], choices: [{ label: 'Auto', values: { length: 0 }, title: 'Start/End: one 5.1 m vertical curve; Slope: one 16-stud track' }],
      custom: [{ key: 'length', label: 'Length', unit: 'mm', min: 24, max: 2000, step: 8 }] }
  ],
  initial: { part: 0, grade: 4, climb: 1, length: 0, radius: BRICK_LAYOUT.curveRadius, sweep: 0 },
  values: kindValues,
  shape: (values, source, customJoiner = false) => source === 'owned' || customJoiner ? null : { family: TRACK_RAMP.family, params: shapeParams(values) },
  problem: values => {
    if (!(values.grade >= 0.5 && values.grade <= ELEVATION.maxGrade * 100)) return 'Grade must be 0.5% to 5%.';
    if (values.sweep && (values.radius < 192 || values.radius > 1472)) return 'Radius must be 192 to 1472 mm (R24 to R184).';
    if (!values.sweep && values.length && (values.length < 24 || values.length > 2000)) return 'Length must be 24 to 2000 mm.';
    const vertical = rampVerticalRadius(shapeParams(values));
    return vertical < ELEVATION.minVerticalRadius ?
      `The grade changes too fast (vertical curve ${(vertical / 1000).toFixed(1)} m, at least ${ELEVATION.minVerticalRadius / 1000} m): make it longer or gentler.` : null;
  },
  caution: values => {
    const vertical = rampVerticalRadius(shapeParams(values));
    if (vertical < ELEVATION.verticalRadius) return `Vertical curve ${(vertical / 1000).toFixed(1)} m is under 5.1 m: long cars may uncouple. Make it longer.`;
    return values.grade > ELEVATION.cautionGrade * 100 ? 'Over 4%: long or heavy trains may stall.' : null;
  },
  describe: values => TRACK_RAMP.description({ id: '', family: TRACK_RAMP.family, x: 0, y: 0, z: 0, heading: 0, params: shapeParams(values) })
};
