import { compositePiece, levelTrack } from './composite-piece';

/** Printed straight of any length; 128 mm (and the legacy 160 mm) keep their own families. */
export const TRACK_STRAIGHT = compositePiece({
  family: 'track_straight', label: 'Straight', curved: false,
  params: [{ key: 'length', label: 'Length', unit: 'mm', min: 24, max: 2000, step: 1, default: 64 }],
  track: ({ length }) => levelTrack([{ len: length, k0: 0, k1: 0 }]),
  description: ({ length }) => `${length} mm`
});
