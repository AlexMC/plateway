import type { RoutePiece } from '../../project';
import { ELEVATION } from '../../elevation';
import { BRICK_LAYOUT } from '../../track';
import { paramValue } from '../composite';
import { RACK, rackOptions } from '../rack-teeth';
import type { CompositeTrack, PieceDefinition } from '../types';
import { DEG, compositePiece, type Values } from './composite-piece';

/** Rack parts: Entry eases level track onto the grade (teeth taper in), Slope holds it, Exit eases back (teeth taper out). */
export const RACK_PARTS = [{ value: 0, label: 'Entry' }, { value: 1, label: 'Slope' }, { value: 2, label: 'Exit' }] as const;
/** The printed accessory: `part` 0 the bogie frame, 1 its cog (cad/models/rack.py). */
export const COG_BOGIE_FAMILY = 'cog_bogie';
const SLOPE_LENGTH = BRICK_LAYOUT.straightLength;
const studUp = (mm: number) => Math.ceil(mm / 8 - 1e-9) * 8;
/** Options that use the track centre (street, marker) or are untested with the rack bar (9V rails, LED channel). */
const EXCLUDED = new Set(['street', 'marker', 'marker_s', 'metal', 'metal_base', 'led']);

/** Plan length: the arc on a curve, else the set length, else (0 = automatic) one eased transition or one 16-stud track. */
export function rackLength({ part, grade, length, radius, sweep }: Values): number {
  if (sweep) return radius * Math.abs(sweep) * DEG;
  if (length) return length;
  return part === 1 || !grade ? SLOPE_LENGTH : Math.max(64, studUp(RACK.autoVerticalRadius * Math.abs(grade) / 100));
}
/** Vertical-curve radius of an Entry/Exit (mm); Infinity on a constant grade. */
export function rackVerticalRadius(values: Values): number {
  return values.part === 1 || !values.grade ? Infinity : rackLength(values) / Math.abs(values.grade / 100);
}
function rackTrack(values: Values): CompositeTrack {
  const length = rackLength(values), g = values.grade / 100, k = values.sweep ? Math.sign(values.sweep) / values.radius : 0;
  const [grade0, grade1] = values.part === 0 ? [0, g] : values.part === 1 ? [g, g] : [g, 0];
  return { segments: [{ len: length, k0: k, k1: k }], z0: 0, z1: (grade0 + grade1) / 2 * length, grade0, grade1, cant0: 0, cant1: 0,
    vcurve: grade0 === grade1 ? 0 : RACK.minVerticalRadius };
}

const base = compositePiece({
  family: 'track_rack', label: 'Rack railway', curved: true, color: 0xb98ad6, group: 'experimental',
  params: [
    { key: 'part', label: 'Part', unit: '', min: 0, max: 2, step: 1, default: 0, options: RACK_PARTS.map(part => ({ ...part })) },
    { key: 'grade', label: 'Grade', unit: '%', min: -RACK.maxGrade * 100, max: RACK.maxGrade * 100, step: 0.5, default: 10 },
    { key: 'length', label: 'Length', unit: 'mm', min: 0, max: 2000, step: 8, default: 0 },
    { key: 'radius', label: 'Radius', unit: 'mm', min: 192, max: 1472, step: 8, default: BRICK_LAYOUT.curveRadius },
    { key: 'sweep', label: 'Angle', unit: 'deg', min: -90, max: 90, step: 0.125, default: 0 },
    { key: 'bogies', label: 'Cog bogies to print', unit: 'count', min: 0, max: 4, step: 1, default: 0 }
  ],
  track: rackTrack,
  cadOptions: values => rackOptions(rackTrack(values), values.part === 0, values.part === 2),
  description: values => {
    const part = RACK_PARTS[values.part]?.label ?? 'Rack', rise = values.grade / 100 * rackLength(values) * (values.part === 1 ? 1 : 0.5);
    return `${part} · ${Math.abs(values.grade)}% ${values.grade < 0 ? 'down' : 'up'} · ${Math.round(rackLength(values))} mm · ${rise >= 0 ? '+' : '−'}${Math.abs(rise).toFixed(1)} mm`;
  },
  // From the far end an Entry is an Exit on the opposite grade, and a curve turns the other way.
  reverseParams: values => ({ ...values, part: 2 - values.part, grade: -values.grade, sweep: -values.sweep })
});
const values = (piece: RoutePiece): Values => Object.fromEntries(base.params.map(spec => [spec.key, paramValue(base, piece, spec.key)]));

/**
 * Rack (cog) railway (C2 + cad/models/rack.py): plain printed track with a brick-pitch rack between the rails, up to 20 %.
 * Entry eases from level onto the grade with the teeth tapering in, Slope holds the grade, Exit eases back with the teeth
 * tapering out. Above the 5 % adhesion limit only trains with a cog car climb (Setup → cars → Cog drive); the cog bogie
 * prints as an accessory of any rack piece (`bogies`).
 */
export const TRACK_RACK: PieceDefinition = {
  ...base,
  params: base.params.filter(spec => !EXCLUDED.has(spec.key)),
  caution: 'Cog trains only above 5% — cog cars cannot run through turnouts or crossings.',
  notes: ['Teeth: brick gear-rack pitch (10 per 32 mm), tips 0.4 mm below the rail tops, so every train runs over the rack.',
    'Prints flat as a wedge; columns or risers hold it at height. The cog bogie (frame + cog) needs four 55423 wheels.'],
  paths: (piece, project) => base.paths(piece, project).map(path => ({ ...path, rack: true })),
  cad: (piece, project) => {
    const count = values(piece).bogies;
    return [...base.cad(piece, project), ...Array.from({ length: count }, () => [0, 1]).flat()
      .map(part => ({ family: COG_BOGIE_FAMILY, parameters: { part } }))];
  },
  problem: piece => {
    const given = values(piece);
    if (Math.abs(given.grade) > RACK.maxGrade * 100 + 1e-9) return `Rack climbs at most ${RACK.maxGrade * 100}%.`;
    const vertical = rackVerticalRadius(given);
    if (vertical < RACK.minVerticalRadius - 1e-6)
      return `The grade changes too fast (vertical curve ${(vertical / 1000).toFixed(2)} m, at least ${RACK.minVerticalRadius / 1000} m for the cog): make it longer or gentler.`;
    return null;
  },
  // Flip turns a curved rack the other way, and a straight one from climbing to descending.
  flip: given => {
    const sweep = given.sweep ?? 0;
    return sweep ? { ...given, sweep: -sweep } : { ...given, grade: -(given.grade ?? 10) };
  }
};
/** Above this a rack grade needs a cog train (the adhesion limit). */
export const RACK_COG_GRADE = ELEVATION.maxGrade;
