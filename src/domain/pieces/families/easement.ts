import type { TrackSegment } from '../types';
import { DEG, compositePiece, levelTrack, studs, type Values } from './composite-piece';

/** Plan-view end of a clothoid whose curvature ramps from 0 to 1/`radius` over `length` (Simpson on the Fresnel integrals). */
function clothoidEnd(length: number, radius: number): { x: number; y: number; heading: number } {
  const steps = 400, h = length / steps;
  let x = 0, y = 0;
  for (let i = 0; i <= steps; i++) {
    const u = i * h, heading = u * u / (2 * radius * length), weight = i === 0 || i === steps ? 1 : i % 2 ? 4 : 2;
    x += weight * Math.cos(heading); y += weight * Math.sin(heading);
  }
  return { x: x * h / 3, y: y * h / 3, heading: length / (2 * radius) };
}

export interface Easement { lead: number; clothoid: number; radius: number; arc: number }

/**
 * Straight + clothoid + arc landing exactly on the end pose of `lead` mm of straight followed by an arc of `radius`
 * turning `sweep` radians (left). The clothoid is shortened to the longest that still fits; null only if none does.
 */
export function dropInEasement(lead: number, radius: number, sweep: number, clothoid: number): Easement | null {
  const targetX = lead + radius * Math.sin(sweep), targetY = radius * (1 - Math.cos(sweep));
  const solve = (length: number): Easement | null => {
    const lateral = (r: number) => { const end = clothoidEnd(length, r); return end.y + r * (Math.cos(end.heading) - Math.cos(sweep)); };
    // Tighter arcs sit further inside; the arc cannot be shorter than nothing.
    let low = length / (2 * sweep), high = radius;
    if (lateral(low) > targetY) return null;
    for (let i = 0; i < 80; i++) { const mid = (low + high) / 2; if (lateral(mid) > targetY) high = mid; else low = mid; }
    const r = (low + high) / 2, end = clothoidEnd(length, r);
    const straight = targetX - end.x - r * (Math.sin(sweep) - Math.sin(end.heading));
    return straight < 0 ? null : { lead: straight, clothoid: length, radius: r, arc: r * (sweep - end.heading) };
  };
  const exact = solve(clothoid);
  if (exact) return exact;
  let low = 0, high = clothoid;
  for (let i = 0; i < 40; i++) { const mid = (low + high) / 2; if (solve(mid)) low = mid; else high = mid; }
  return low > 0 ? solve(low) : null;
}

/** Custom easement: a clothoid into `radius`, then the arc for the rest of `sweep` radians (the clothoid alone if it turns that far). */
export function customEasement(radius: number, sweep: number, clothoid: number): Easement {
  const length = Math.min(clothoid, 2 * radius * sweep);
  return { lead: 0, clothoid: length, radius, arc: radius * sweep - length / 2 };
}

export function easementShape(values: Values): Easement {
  const sweep = Math.abs(values.sweep) * DEG;
  return values.dropin ? dropInEasement(values.lead, values.radius, sweep, values.clothoid) ?? { lead: values.lead, clothoid: 0, radius: values.radius, arc: values.radius * sweep } :
    customEasement(values.radius, sweep, values.clothoid);
}

/**
 * Clothoid easement (+ sweep turns left). Drop-in: replaces `lead` mm of straight + an R`radius` curve of `sweep`,
 * landing on the same end pose with a slightly tighter arc. Custom: a clothoid of `clothoid` mm into R`radius`.
 * `reverse` = 1 runs the other way: arc, clothoid, straight (a curve exit).
 */
export const TRACK_EASEMENT = compositePiece({
  family: 'track_easement', label: 'Easement', curved: true,
  params: [
    { key: 'dropin', label: 'Shape', unit: '', min: 0, max: 1, step: 1, default: 1,
      options: [{ value: 1, label: 'Replaces a straight + curve' }, { value: 0, label: 'Custom' }] },
    { key: 'lead', label: 'Straight replaced', unit: 'mm', min: 0, max: 512, step: 8, default: 128 },
    { key: 'radius', label: 'Radius', unit: 'mm', min: 192, max: 1472, step: 8, default: 320 },
    { key: 'sweep', label: 'Angle', unit: 'deg', min: -90, max: 90, step: 0.125, default: 22.5 },
    { key: 'clothoid', label: 'Transition', unit: 'mm', min: 8, max: 600, step: 1, default: 111 },
    { key: 'reverse', label: 'Direction', unit: '', min: 0, max: 1, step: 1, default: 0,
      options: [{ value: 0, label: 'Into the curve' }, { value: 1, label: 'Out of the curve' }] }
  ],
  track: values => {
    const shape = easementShape(values), k = Math.sign(values.sweep) / shape.radius;
    const segments: TrackSegment[] = [{ len: shape.lead, k0: 0, k1: 0 }, { len: shape.clothoid, k0: 0, k1: k }, { len: shape.arc, k0: k, k1: k }];
    return levelTrack(values.reverse ? segments.reverse().map(({ len, k0, k1 }) => ({ len, k0: k1, k1: k0 })) : segments);
  },
  description: values => {
    const shape = easementShape(values);
    return values.dropin ? `Replaces S${studs(values.lead)} + R${studs(values.radius)} · min R${studs(shape.radius)}` :
      `${shape.clothoid.toFixed(0)} mm into R${studs(values.radius)} · ${Math.abs(values.sweep)}°`;
  },
  signed: 'sweep',
  reverseParams: values => ({ ...values, sweep: -values.sweep, reverse: values.reverse ? 0 : 1 })
});
