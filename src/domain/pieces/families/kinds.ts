import type { RoutePiece } from '../../project';
import { BRICK_LAYOUT } from '../../track';
import { paramValue } from '../composite';
import type { ParamSpec, PieceDefinition, PieceGroup } from '../types';
import { BANKED_KIND, TRACK_BANKED } from './banked';
import { DEG, studs, type Values } from './composite-piece';
import { TRACK_CURVE } from './curve-family';
import { CURVE_CROSSING_KIND, DIAMOND_KIND } from './diamond';
import { TRACK_EASEMENT, easementShape } from './easement';
import { GAUGE_ADAPTER_KIND } from './gauges';
import { GAUNTLET_KIND } from './gauntlet';
import { RAMP_KIND, TRACK_RAMP } from './ramp';
import { SBEND_MIN_RADIUS, TRACK_SBEND, solveSBend } from './sbend';
import { TRACK_STRAIGHT } from './straight-any';

/** The family, legacy sweep (radians) and parameters that build a kind's values. */
export interface KindShape { family: string; sweep?: number; params?: Values }
/** A preset chip: the values it sets. It shows as chosen when the row's `match` keys agree (hand ignored). */
export interface KindChoice { label: string; values: Values; title?: string }
/** A number the user types; `signed` fields show the size and keep the piece's hand. */
export type KindField = Omit<ParamSpec, 'default' | 'options'> & { signed?: boolean };
export interface KindRow {
  label: string; choices: readonly KindChoice[]; match: readonly string[];
  /** Fields shown with the row's Custom chip; `customValues` are applied when Custom is picked. */
  custom?: readonly KindField[]; customValues?: Values;
}
/**
 * One palette tile and selected-piece editor over several families: the owned brick shape where an official piece has it,
 * the legacy printed families that keep their CAD, and a parametric composite family for everything else.
 */
export interface TrackKind {
  id: string;
  /** Palette group of the tile; absent = Track. */
  group?: PieceGroup;
  label: string;
  families: readonly string[];
  /** The value whose sign is the hand (+ = left); absent on unhanded kinds. */
  hand?: string;
  rows: readonly KindRow[];
  /** Always-shown fields for these values (after the rows). */
  extra?(values: Values): readonly KindField[];
  initial: Values;
  values(piece: RoutePiece): Values;
  /**
   * `owned`: the user's own brick piece, null where no official piece has the shape. `customJoiner`: only legacy custom-joiner families.
   * `options`: the piece carries track options (ballast, street, marker…), which only the composite family prints.
   */
  shape(values: Values, source: 'owned' | 'printed', customJoiner?: boolean, options?: boolean): KindShape | null;
  /** Why these values cannot be built, or null. */
  problem(values: Values): string | null;
  /** A non-blocking warning about these values (e.g. an experimental crossing angle), or null. */
  caution?(values: Values): string | null;
  describe(values: Values): string;
}

const R40 = BRICK_LAYOUT.curveRadius, R56 = BRICK_LAYOUT.wideCurveRadius, OFFICIAL_SWEEP = 22.5;
const same = (a: number, b: number) => Math.abs(a - b) < 1e-6;
/** The composite family's shape parameters from kind values (track options stay on the piece). */
const composite = (definition: PieceDefinition, values: Values): KindShape =>
  ({ family: definition.family, params: Object.fromEntries(definition.params.filter(spec => spec.key in values).map(spec => [spec.key, values[spec.key]])) });
const pick = (definition: PieceDefinition, piece: RoutePiece, keys: readonly string[]): Values =>
  Object.fromEntries(keys.map(key => [key, paramValue(definition, piece, key)]));

export const STRAIGHT_KIND: TrackKind = {
  id: 'straight', label: 'Straight',
  families: ['brick_straight_nominal', 'printed_brick_straight', 'printed_straight', TRACK_STRAIGHT.family],
  rows: [{ label: 'Length', match: ['length'],
    choices: [32, 64, 128, 160, 192, 256].map(length => ({ label: String(length), values: { length }, title: `${length} mm · ${studs(length)} studs` })),
    custom: [{ key: 'length', label: 'Length', unit: 'mm', min: 24, max: 2000, step: 1 }] }],
  initial: { length: 128 },
  values: piece => piece.family === TRACK_STRAIGHT.family ? { length: paramValue(TRACK_STRAIGHT, piece, 'length') } :
    { length: piece.family === 'printed_straight' ? BRICK_LAYOUT.printedStraightLength : BRICK_LAYOUT.straightLength },
  shape: ({ length }, source, customJoiner = false, options = false) => {
    const official = same(length, BRICK_LAYOUT.straightLength);
    if (source === 'owned') return official ? { family: 'brick_straight_nominal' } : null;
    if (customJoiner) return same(length, BRICK_LAYOUT.printedStraightLength) ? { family: 'printed_straight' } : null;
    return official && !options ? { family: 'printed_brick_straight' } : composite(TRACK_STRAIGHT, { length });
  },
  problem: ({ length }) => length >= 24 && length <= 2000 ? null : 'Length must be 24 to 2000 mm.',
  describe: ({ length }) => `${length} mm`
};

/** Degrees per curve piece at `radius` mm. Research convention (TrixBrix/OKB): 16 per circle up to R56, 32 from R72, 64 from R136. */
export const curveSector = (radius: number) => radius <= R56 ? 22.5 : radius < 136 * 8 ? 11.25 : 5.625;
export const CURVE_KIND: TrackKind = {
  id: 'curve', label: 'Curve', hand: 'sweep',
  families: ['brick_curve_r40', 'printed_curve_r40', 'printed_curve_r56', TRACK_CURVE.family],
  rows: [
    { label: 'Radius', match: ['radius'],
      choices: [24, 32, 40, 56, 72, 88, 104, 120, 136, 152, 168, 184].map(r => ({ label: `R${r}`, values: { radius: r * 8, sweep: curveSector(r * 8) }, title: `${r * 8} mm radius` })),
      custom: [{ key: 'radius', label: 'Radius', unit: 'mm', min: 192, max: 1472, step: 8 }] },
    { label: 'Angle', match: ['sweep'],
      choices: [22.5, 11.25, 5.625].map(sweep => ({ label: `${sweep}°`, values: { sweep } })),
      custom: [{ key: 'sweep', label: 'Angle', unit: 'deg', min: 0.5, max: 90, step: 0.125, signed: true }] }
  ],
  initial: { radius: R40, sweep: OFFICIAL_SWEEP },
  values: piece => piece.family === TRACK_CURVE.family ? pick(TRACK_CURVE, piece, ['radius', 'sweep']) :
    { radius: piece.family === 'printed_curve_r56' ? R56 : R40, sweep: Number((piece.sweep! / DEG).toFixed(9)) },
  shape: ({ radius, sweep }, source, customJoiner = false, options = false) => {
    const official = same(radius, R40) && same(Math.abs(sweep), OFFICIAL_SWEEP);
    // Legacy families keep radians exactly as BRICK_LAYOUT.curveSweep for the official angle.
    const legacySweep = same(Math.abs(sweep), OFFICIAL_SWEEP) ? Math.sign(sweep) * BRICK_LAYOUT.curveSweep : sweep * DEG;
    if (source === 'owned') return official ? { family: 'brick_curve_r40', sweep: legacySweep } : null;
    if (customJoiner) return same(radius, R56) ? { family: 'printed_curve_r56', sweep: legacySweep } : null;
    if (options) return composite(TRACK_CURVE, { radius, sweep });
    if (official) return { family: 'printed_curve_r40', sweep: legacySweep };
    if (same(radius, R56) && Math.abs(sweep) <= OFFICIAL_SWEEP + 1e-9) return { family: 'printed_curve_r56', sweep: legacySweep };
    return composite(TRACK_CURVE, { radius, sweep });
  },
  problem: ({ radius, sweep }) => radius < 192 || radius > 1472 ? 'Radius must be 192 to 1472 mm (R24 to R184).' :
    !(Math.abs(sweep) >= 0.5 && Math.abs(sweep) <= 90) ? 'Angle must be 0.5° to 90°.' : null,
  describe: ({ radius, sweep }) => `R${studs(radius)} · ${Math.abs(sweep)}°`
};

/** Grid-exact S-bends (Pythagorean triples): offset and length in studs, radius follows. */
const SBENDS: readonly [number, number][] = [[8, 32], [16, 48], [16, 80], [16, 112], [16, 144], [24, 72]];
export const SBEND_KIND: TrackKind = {
  id: 'sbend', label: 'S-bend', hand: 'offset',
  families: [TRACK_SBEND.family],
  rows: [{ label: 'Offset', match: ['offset', 'length', 'middle'],
    choices: SBENDS.map(([offset, length]) => {
      const radius = studs(solveSBend(length * 8, offset * 8)!.radius);
      return { label: `${offset} · R${radius}`, values: { offset: offset * 8, length: length * 8, middle: 0 },
        title: `${offset} studs sideways over ${length} studs, two R${radius} arcs` };
    }),
    custom: [
      { key: 'offset', label: 'Offset', unit: 'mm', min: 8, max: 512, step: 8, signed: true },
      { key: 'length', label: 'Length', unit: 'mm', min: 64, max: 2000, step: 8 },
      { key: 'middle', label: 'Straight between', unit: 'mm', min: 0, max: 1000, step: 8 }
    ] }],
  initial: { offset: 128, length: 384, middle: 0 },
  values: piece => pick(TRACK_SBEND, piece, ['offset', 'length', 'middle']),
  shape: (values, source, customJoiner = false) => source === 'owned' || customJoiner ? null : composite(TRACK_SBEND, values),
  problem: ({ offset, length, middle }) => {
    const solved = solveSBend(length, offset, middle);
    if (!solved) return 'That offset does not fit in that length.';
    return solved.radius < SBEND_MIN_RADIUS ? `Too tight (R${studs(solved.radius)}); make it longer.` : null;
  },
  describe: values => TRACK_SBEND.description({ id: '', family: TRACK_SBEND.family, x: 0, y: 0, z: 0, heading: 0, params: values })
};

/** Drop-in easements: the straight + curve they replace, and the default transition length. */
const DROP_INS: readonly [lead: number, radius: number, clothoid: number][] = [[128, R40, 111], [64, R40, 111], [128, R56, 140], [64, R56, 140]];
export const EASEMENT_KIND: TrackKind = {
  id: 'easement', label: 'Easement', hand: 'sweep',
  families: [TRACK_EASEMENT.family],
  rows: [
    { label: 'Replaces', match: ['dropin', 'lead', 'radius', 'sweep'],
      choices: DROP_INS.map(([lead, radius, clothoid]) => ({ label: `S${studs(lead)}+R${studs(radius)}`,
        values: { dropin: 1, lead, radius, sweep: OFFICIAL_SWEEP, clothoid },
        title: `Same ends as a ${lead} mm straight and an R${studs(radius)} 22.5° curve` })),
      customValues: { dropin: 0 },
      custom: [
        { key: 'radius', label: 'Radius', unit: 'mm', min: 192, max: 1472, step: 8 },
        { key: 'sweep', label: 'Angle', unit: 'deg', min: 0.5, max: 90, step: 0.125, signed: true }
      ] },
    { label: 'Direction', match: ['reverse'], choices: [{ label: 'Into curve', values: { reverse: 0 } }, { label: 'Out of curve', values: { reverse: 1 } }] }
  ],
  extra: () => [{ key: 'clothoid', label: 'Transition', unit: 'mm', min: 8, max: 600, step: 1 }],
  initial: { dropin: 1, lead: 128, radius: R40, sweep: OFFICIAL_SWEEP, clothoid: 111, reverse: 0 },
  values: piece => pick(TRACK_EASEMENT, piece, ['dropin', 'lead', 'radius', 'sweep', 'clothoid', 'reverse']),
  shape: (values, source, customJoiner = false) => source === 'owned' || customJoiner ? null : composite(TRACK_EASEMENT, values),
  problem: values => {
    const shape = easementShape(values);
    if (shape.clothoid < 1) return 'No transition fits; pick a longer straight or a wider curve.';
    return shape.radius < SBEND_MIN_RADIUS ? `Too tight (R${studs(shape.radius)}); use a shorter transition.` : null;
  },
  describe: values => TRACK_EASEMENT.description({ id: '', family: TRACK_EASEMENT.family, x: 0, y: 0, z: 0, heading: 0, params: values })
};

export const TRACK_KINDS: readonly TrackKind[] = [STRAIGHT_KIND, CURVE_KIND, SBEND_KIND, EASEMENT_KIND, DIAMOND_KIND, CURVE_CROSSING_KIND, GAUNTLET_KIND, RAMP_KIND, BANKED_KIND, GAUGE_ADAPTER_KIND];
export const KIND_FAMILIES: readonly PieceDefinition[] = [TRACK_STRAIGHT, TRACK_CURVE, TRACK_SBEND, TRACK_EASEMENT, TRACK_RAMP, TRACK_BANKED];

export function kindOfFamily(family: string): TrackKind | undefined {
  return TRACK_KINDS.find(kind => kind.families.includes(family));
}
/** A chip is chosen when its row's match keys agree with the values (the hand's sign ignored). */
export function choiceChosen(kind: TrackKind, row: KindRow, choice: KindChoice, values: Values): boolean {
  return row.match.every(key => !(key in choice.values) ||
    same(key === kind.hand ? Math.abs(values[key]) : values[key], key === kind.hand ? Math.abs(choice.values[key]) : choice.values[key]));
}
/** Apply a chip's values, keeping the current hand. */
export function applyChoice(kind: TrackKind, values: Values, update: Values): Values {
  const next = { ...values, ...update };
  if (kind.hand && kind.hand in update) next[kind.hand] = Math.sign(values[kind.hand] || 1) * Math.abs(update[kind.hand]);
  return next;
}
