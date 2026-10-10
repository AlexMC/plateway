import { tieStations } from '../composite';
import { DEG, compositePiece, studs, type Values } from './composite-piece';
import type { TrackKind } from './kinds';

/** Steepest cant the CAD builds (composite.MAX_CANT), degrees. */
export const MAX_BANK = 4;
/** Outer rail raised 1, 1.6 and 2 mm over the 40 mm gauge (research presets). */
export const BANK_PRESETS: readonly { cant: number; label: string }[] = [
  { cant: 1.4, label: '1 mm' }, { cant: 2.3, label: '1.6 mm' }, { cant: 2.9, label: '2 mm' }];

/**
 * Where the cant transitions end: the full sleeper nearest the asked transition length from each end (brick connector
 * ends must stay level, and the CAD cuts the curve there into level-ended entry/exit parts and a canted body).
 * Null when the curve has no full sleeper to cut at.
 */
export function bankKnots(length: number, transition: number): [number, number] | null {
  const ties = tieStations(length).filter(tie => tie <= length / 2 + 1e-9);
  if (!ties.length) return null;
  const start = ties.reduce((best, tie) => Math.abs(tie - transition) < Math.abs(best - transition) ? tie : best);
  return [start, length - start];
}

const arcLength = ({ radius, sweep }: Values) => radius * Math.abs(sweep) * DEG;

/**
 * Banked curve (+ sweep turns left): the outer rail rises over the entry transition to `cant` degrees, stays there
 * through the body and falls back over the exit transition, so both brick connectors are level. The plan is the plain
 * arc. Print splits it at the transition sleepers (and further for the bed) into parts whose inner joints are plain
 * cut ends: the halves of a sleeper, held in line by the baseplate studs under it.
 */
export const TRACK_BANKED = compositePiece({
  family: 'track_banked', label: 'Banked curve', group: 'elevation', curved: true,
  params: [
    { key: 'radius', label: 'Radius', unit: 'mm', min: 320, max: 1472, step: 8, default: 448 },
    { key: 'sweep', label: 'Angle', unit: 'deg', min: -90, max: 90, step: 0.125, default: 45 },
    { key: 'cant', label: 'Cant', unit: 'deg', min: 0.5, max: MAX_BANK, step: 0.1, default: 2.3 },
    { key: 'transition', label: 'Transition', unit: 'mm', min: 32, max: 512, step: 32, default: 96 }
  ],
  track: values => {
    const length = arcLength(values), curvature = Math.sign(values.sweep) / values.radius;
    const knots = bankKnots(length, values.transition), cant = Math.sign(values.sweep) * values.cant;
    return { segments: [{ len: length, k0: curvature, k1: curvature }], z0: 0, z1: 0, grade0: 0, grade1: 0, cant0: 0, cant1: 0, vcurve: 0,
      cants: !knots ? [{ s: 0, cant: 0 }, { s: length, cant: 0 }] : knots[0] === knots[1] ?
        [{ s: 0, cant: 0 }, { s: knots[0], cant }, { s: length, cant: 0 }] :
        [{ s: 0, cant: 0 }, { s: knots[0], cant }, { s: knots[1], cant }, { s: length, cant: 0 }] };
  },
  description: ({ radius, sweep, cant }) => `R${studs(radius)} · ${Math.abs(sweep)}° · ${cant}° cant`,
  signed: 'sweep',
  reverseParams: values => ({ ...values, sweep: -values.sweep }),
  notes: ['Prints as a level-ended entry part, the canted body and a level-ended exit part.',
    'Lay it on a baseplate: the studs under each split sleeper hold the plain joints between its parts in line.']
});

export const BANKED_KIND: TrackKind = {
  id: 'banked', label: 'Banked curve', group: 'elevation', hand: 'sweep',
  families: [TRACK_BANKED.family],
  rows: [
    { label: 'Radius', match: ['radius'],
      choices: [40, 56, 72, 88, 104].map(r => ({ label: `R${r}`, values: { radius: r * 8 }, title: `${r * 8} mm radius` })),
      custom: [{ key: 'radius', label: 'Radius', unit: 'mm', min: 320, max: 1472, step: 8 }] },
    { label: 'Angle', match: ['sweep'],
      choices: [45, 67.5, 90].map(sweep => ({ label: `${sweep}°`, values: { sweep } })),
      custom: [{ key: 'sweep', label: 'Angle', unit: 'deg', min: 0.5, max: 90, step: 0.125, signed: true }] },
    { label: 'Cant', match: ['cant'],
      choices: BANK_PRESETS.map(({ cant, label }) => ({ label: `${cant}°`, values: { cant }, title: `Outer rail ${label} higher` })),
      custom: [{ key: 'cant', label: 'Cant', unit: 'deg', min: 0.5, max: MAX_BANK, step: 0.1 }] }
  ],
  extra: () => [{ key: 'transition', label: 'Transition', unit: 'mm', min: 32, max: 512, step: 32 }],
  initial: { radius: 448, sweep: 45, cant: 2.3, transition: 96 },
  values: piece => Object.fromEntries(['radius', 'sweep', 'cant', 'transition'].map(key =>
    [key, piece.params?.[key] ?? TRACK_BANKED.params.find(spec => spec.key === key)!.default])),
  shape: (values, source, customJoiner = false) => source === 'owned' || customJoiner ? null :
    { family: TRACK_BANKED.family, params: { radius: values.radius, sweep: values.sweep, cant: values.cant, transition: values.transition } },
  problem: values => {
    if (values.radius < 320 || values.radius > 1472) return 'Radius must be 320 to 1472 mm (R40 to R184).';
    if (!(Math.abs(values.sweep) >= 0.5 && Math.abs(values.sweep) <= 90)) return 'Angle must be 0.5° to 90°.';
    if (!(values.cant > 0 && values.cant <= MAX_BANK)) return `Cant must be up to ${MAX_BANK}°.`;
    return bankKnots(arcLength(values), values.transition) ? null : 'Too short to bank; pick a larger angle or radius.';
  },
  caution: values => {
    const knots = bankKnots(arcLength(values), values.transition);
    return knots && knots[0] === knots[1] ? 'No room for a full-cant body: it banks up and straight back down.' : null;
  },
  describe: values => TRACK_BANKED.description({ id: '', family: TRACK_BANKED.family, x: 0, y: 0, z: 0, heading: 0, params: values })
};
