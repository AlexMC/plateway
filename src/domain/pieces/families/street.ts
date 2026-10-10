import type { PieceDefinition } from '../types';
import { DEG, compositePiece, levelTrack, studs } from './composite-piece';

/** Radii of the street track choices, studs (0 = straight). */
const RADII = [0, 40, 56, 72, 88, 104, 120];
/** Street-only options: the road already fills the flangeways, and ballast would sit under it. */
const DROPPED: Record<string, true> = { ballast: true, street: true, guard_rail: true };

const piece = compositePiece({
  family: 'street_track', label: 'Street track', curved: false,
  params: [
    { key: 'radius', label: 'Shape', unit: 'mm', min: 0, max: 960, step: 8, default: 0,
      options: RADII.map(r => ({ value: r * 8, label: r ? `R${r} curve` : 'Straight' })) },
    { key: 'length', label: 'Length (straight)', unit: 'mm', min: 32, max: 2000, step: 8, default: 128 },
    { key: 'sweep', label: 'Angle (curve)', unit: 'deg', min: -90, max: 90, step: 0.125, default: 22.5 }
  ],
  track: ({ radius, length, sweep }) => {
    if (!radius) return levelTrack([{ len: length, k0: 0, k1: 0 }]);
    const curvature = Math.sign(sweep) / radius;
    return levelTrack([{ len: radius * Math.abs(sweep) * DEG, k0: curvature, k1: curvature }]);
  },
  description: ({ radius, length, sweep }) => radius ? `R${studs(radius)} · ${Math.abs(sweep)}°` : `${length} mm`,
  signed: 'sweep',
  reverseParams: values => ({ ...values, sweep: -values.sweep })
});

/**
 * Tram and street running: rails flush in a road surface with 4 mm flangeway grooves (composite `street`).
 * Straight or curved; the colour marker option stays available.
 */
export const STREET_TRACK: PieceDefinition = {
  ...piece, group: 'scenic', color: 0x8e8b86,
  params: piece.params.filter(spec => !DROPPED[spec.key]),
  cad: (given, project) => piece.cad({ ...given, params: { ...given.params, street: 1 } }, project)
};
