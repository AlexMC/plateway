import { compositePiece, levelTrack, studs } from './composite-piece';

/** Tightest arc the composite CAD accepts (R22); the editor asks for R24 or wider. */
export const SBEND_MIN_RADIUS = 192;

/**
 * Two equal opposite arcs with an optional straight between them, shifting the track sideways by `offset`
 * over `length` (both measured between the ports). Returns the arc radius and turn; null when no S-bend of
 * at most 90° per arc fits.
 */
export function solveSBend(length: number, offset: number, middle = 0): { radius: number; angle: number } | null {
  const d = Math.abs(offset);
  if (!(d > 0) || !(length > middle) || middle < 0) return null;
  // Each half: arc R·θ then middle/2 of straight, ending at (length/2, d/2).
  const excess = (angle: number) => (length/2 - middle/2*Math.cos(angle)) * Math.tan(angle/2) + middle/2*Math.sin(angle) - d/2;
  let low = 0, high = Math.PI / 2;
  if (excess(high) < 0) return null;
  for (let i = 0; i < 100; i++) { const mid = (low + high) / 2; if (excess(mid) < 0) low = mid; else high = mid; }
  const angle = (low + high) / 2, radius = (length/2 - middle/2*Math.cos(angle)) / Math.sin(angle);
  return radius > 0 ? { radius, angle } : null;
}

export const TRACK_SBEND = compositePiece({
  family: 'track_sbend', label: 'S-bend', curved: true,
  params: [
    { key: 'offset', label: 'Offset', unit: 'mm', min: -512, max: 512, step: 8, default: 128 },
    { key: 'length', label: 'Length', unit: 'mm', min: 64, max: 2000, step: 8, default: 384 },
    { key: 'middle', label: 'Straight between', unit: 'mm', min: 0, max: 1000, step: 8, default: 0 }
  ],
  track: ({ offset, length, middle }) => {
    const solved = solveSBend(length, offset, middle);
    // Unsolvable values keep a straight of the requested length; the editor never offers them.
    if (!solved) return levelTrack([{ len: length, k0: 0, k1: 0 }]);
    const k = Math.sign(offset) / solved.radius, arc = solved.radius * solved.angle;
    return levelTrack([{ len: arc, k0: k, k1: k }, { len: middle, k0: 0, k1: 0 }, { len: arc, k0: -k, k1: -k }]);
  },
  description: ({ offset, length, middle }) => {
    const solved = solveSBend(length, offset, middle);
    return `${studs(Math.abs(offset))}-stud offset · ${studs(length)} long${solved ? ` · R${studs(solved.radius)}` : ''}`;
  },
  signed: 'offset',
  // Turned end for end, an S-bend still shifts the same way.
  reverseParams: values => values
});
