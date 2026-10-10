import { DEG, compositePiece, levelTrack, studs } from './composite-piece';

/** Printed curve of any radius and sweep (+ turns left); R40 and R56 keep their own families. */
export const TRACK_CURVE = compositePiece({
  family: 'track_curve', label: 'Curve', curved: true,
  params: [
    { key: 'radius', label: 'Radius', unit: 'mm', min: 192, max: 1472, step: 8, default: 576 },
    { key: 'sweep', label: 'Angle', unit: 'deg', min: -90, max: 90, step: 0.125, default: 11.25 }
  ],
  track: ({ radius, sweep }) => {
    const curvature = Math.sign(sweep) / radius;
    return levelTrack([{ len: radius * Math.abs(sweep) * DEG, k0: curvature, k1: curvature }]);
  },
  description: ({ radius, sweep }) => `R${studs(radius)} · ${Math.abs(sweep)}°`,
  signed: 'sweep',
  reverseParams: values => ({ ...values, sweep: -values.sweep })
});
