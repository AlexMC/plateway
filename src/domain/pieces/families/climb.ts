import { ELEVATION, planRamp } from '../../elevation';
import { BRICK_LAYOUT } from '../../track';
import type { CompositeTrack, PieceDefinition } from '../types';
import { compositePiece, levelTrack, type Values } from './composite-piece';

export const CLIMB_FAMILY = 'track_climb';
/** Rise of a new climb (mm): 20 plates, risers level. */
export const CLIMB_RISE = 64;
/** Longest level lead-in or run-out a climb carries (mm). */
export const CLIMB_LEVEL_MAX = 512;
/** A level stretch as built: none, or at least the shortest printable part (24 mm). */
export const climbLevel = (mm: number) => mm > 1e-9 ? Math.max(24, mm) : 0;

const signed = (mm: number) => `${mm < 0 ? '−' : '+'}${Math.round(Math.abs(mm) * 10) / 10} mm`;

/**
 * The climb's vertical profile (planRamp): `lead` mm of level → easement onto the grade → constant grade → easement back
 * to level, landing exactly `rise` mm higher (lower when negative) → `trail` mm of level. Knots sit where the grade starts
 * and stops changing and where a level stretch ends, so every bed-sized part is one `composite_track` Hermite (the level
 * stretches print as parts of the climb). Without a height change it is a 128 mm level stub (see `problem`).
 */
export function climbTrack({ rise, grade, ease, lead, trail }: Values): CompositeTrack {
  const plan = planRamp(rise, grade / 100, ease);
  if (!plan) return levelTrack([{ len: BRICK_LAYOUT.straightLength, k0: 0, k1: 0 }]);
  const g = Math.sign(rise) * plan.grade, t = plan.transition, run = plan.run, before = climbLevel(lead), after = climbLevel(trail);
  const ramp = run - 2 * t > 1e-9 ?
    [{ s: 0, z: 0, grade: 0 }, { s: t, z: g * t / 2, grade: g }, { s: run - t, z: rise - g * t / 2, grade: g }, { s: run, z: rise, grade: 0 }] :
    [{ s: 0, z: 0, grade: 0 }, { s: t, z: rise / 2, grade: g }, { s: run, z: rise, grade: 0 }];
  const heights = [...(before ? [{ s: 0, z: 0, grade: 0 }] : []), ...ramp.map(knot => ({ ...knot, s: knot.s + before })),
    ...(after ? [{ s: before + run + after, z: rise, grade: 0 }] : [])];
  return { segments: [{ len: before + run + after, k0: 0, k1: 0 }], z0: 0, z1: rise, grade0: 0, grade1: 0, cant0: 0, cant1: 0,
    vcurve: ELEVATION.minVerticalRadius, heights };
}

/**
 * Go up or down: one straight piece that changes height by `rise` (signed mm, + climbs from `in` to `out`) at no more than
 * `grade` percent, easing on and off the grade over vertical curves of at least `ease` mm. Level at both ends, so it joins
 * level track anywhere; `lead` and `trail` add level track before and after the slope (points need 128 mm of level before
 * a slope). Fit cuts it at the easements and to the printer bed (wedges, held by risers or columns).
 */
export const TRACK_CLIMB: PieceDefinition = {
  ...compositePiece({
    family: CLIMB_FAMILY, label: 'Go up or down', curved: false, color: 0x7dc5d7, group: 'elevation', signed: 'rise',
    params: [
      { key: 'rise', label: 'Height change', unit: 'mm', min: -1000, max: 1000, step: ELEVATION.plate, default: CLIMB_RISE, hidden: true },
      { key: 'grade', label: 'Steepest grade', unit: '%', min: 0.5, max: ELEVATION.maxGrade * 100, step: 0.5, default: 4, hidden: true },
      { key: 'ease', label: 'Vertical curve', unit: 'mm', min: ELEVATION.minVerticalRadius, max: 20480, step: 8, default: ELEVATION.verticalRadius, hidden: true },
      { key: 'lead', label: 'Level first', unit: 'mm', min: 0, max: CLIMB_LEVEL_MAX, step: 8, default: 0, hidden: true },
      { key: 'trail', label: 'Level after', unit: 'mm', min: 0, max: CLIMB_LEVEL_MAX, step: 8, default: 0, hidden: true }
    ],
    track: climbTrack,
    description: values => {
      const plan = planRamp(values.rise, values.grade / 100, values.ease);
      if (!plan) return 'Level · no height change';
      const level = climbLevel(values.lead) + climbLevel(values.trail);
      return `${values.rise < 0 ? 'Descent' : 'Climb'} · ${signed(values.rise)} · ${((plan.run + level) / 1000).toFixed(1)} m${level ? ` incl. ${Math.round(level)} mm level` : ''}`;
    },
    // From the far end the same piece goes the other way, its run-out first.
    reverseParams: values => ({ ...values, rise: -values.rise, lead: values.trail, trail: values.lead }),
    notes: ['Prints as wedges cut at its easements and to the bed; risers or columns hold it at height.']
  }),
  fromJoint: true,
  levelEnds: { in: 'lead', out: 'trail' },
  problem: piece => {
    const rise = piece.params?.rise ?? CLIMB_RISE;
    return Math.abs(rise) < 0.5 ? 'No height change: set a height to reach above or below this end.' : null;
  }
};
