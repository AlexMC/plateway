import narrowProfile from '../../cad/profiles/brick-narrow-v1.json';
import type { Gauge } from './pieces/types';
import { BRICK_TRACK } from './track';

/** Narrow gauge (3 studs = 24 mm rails on 6-stud sleepers): the CAD profile cad/profiles/brick-narrow-v1.json. */
export const NARROW_TRACK = narrowProfile;

/** What a gauge's printed plain track looks like across (piece frame, + left): drawn in 2D, 3D and Test drive. */
export interface GaugeLayout {
  bodyWidth: number;
  /** Running-rail centre laterals. */
  rails: readonly number[];
  /** Rail-support stringers [low, high] that bridge the tie gaps. */
  stringers: readonly (readonly [number, number])[];
  /** Tie-top stud columns, on full and half ties alike. */
  studs: readonly number[];
  /** Full-tie underside bays [low, high]. */
  cavities: readonly (readonly [number, number])[];
  /** Fast print: gauge-brace span between the solid rail supports. */
  braceSpan: number;
  /** Narrow ends: the accepted end's central clip only (cad/models/gauge.py), not the full standard end. */
  narrowEnds: boolean;
}

const band = (centre: number, width: number) => [centre - width / 2, centre + width / 2] as const;
const stringer = BRICK_TRACK.baseStringerWidth;
const STANDARD: GaugeLayout = {
  bodyWidth: BRICK_TRACK.bodyWidth, rails: [-BRICK_TRACK.railGauge / 2, BRICK_TRACK.railGauge / 2],
  stringers: [band(-BRICK_TRACK.railGauge / 2, stringer), band(BRICK_TRACK.railGauge / 2, stringer)],
  studs: BRICK_TRACK.brickAttachment.studLateralOffsets,
  cavities: BRICK_TRACK.brickAttachment.cavityLateralIntervals as unknown as readonly (readonly [number, number])[],
  braceSpan: BRICK_TRACK.railGauge - stringer, narrowEnds: false
};
const NARROW_RAIL = NARROW_TRACK.railGauge / 2;
const NARROW: GaugeLayout = {
  bodyWidth: NARROW_TRACK.bodyWidth, rails: [-NARROW_RAIL, NARROW_RAIL],
  stringers: [band(-NARROW_RAIL, stringer), band(NARROW_RAIL, stringer)],
  studs: NARROW_TRACK.brickAttachment.studLateralOffsets,
  cavities: NARROW_TRACK.brickAttachment.cavityLateralIntervals as unknown as readonly (readonly [number, number])[],
  braceSpan: NARROW_TRACK.railGauge - stringer, narrowEnds: true
};
/** Dual (4-rail centred): standard track plus the narrow rails on one stringer per side under both rails; no ±12 studs. */
const DUAL: GaugeLayout = {
  ...STANDARD, rails: [-BRICK_TRACK.railGauge / 2, -NARROW_RAIL, NARROW_RAIL, BRICK_TRACK.railGauge / 2],
  stringers: [[-STANDARD.stringers[1][1], -(NARROW_RAIL - stringer / 2)], [NARROW_RAIL - stringer / 2, STANDARD.stringers[1][1]]],
  studs: STANDARD.studs.filter(column => Math.abs(column) !== NARROW_RAIL)
};

/** Monorail draws its own beam (RackMono); its plain-track fallback is the standard layout. */
export function gaugeLayout(gauge: Gauge = 'standard'): GaugeLayout {
  return gauge === 'narrow' ? NARROW : gauge === 'dual' ? DUAL : STANDARD;
}

/** The track a car's wheels need. Narrow-gauge cars run 24 mm track; monorail cars a monorail beam. */
export type CarGauge = 'standard' | 'narrow' | 'monorail';
export const CAR_GAUGES: readonly { id: CarGauge; label: string }[] = [
  { id: 'standard', label: 'Standard (L-gauge)' }, { id: 'narrow', label: 'Narrow (3 studs)' }, { id: 'monorail', label: 'Monorail' }
];
export const GAUGE_LABEL: Record<Gauge, string> = { standard: 'standard', narrow: 'narrow-gauge', dual: 'dual-gauge', monorail: 'monorail' };

/** Track of `track` gauge carries a car of `car` gauge: equal gauges, or dual track under standard or narrow cars. */
export function gaugeCarries(track: Gauge, car: CarGauge): boolean {
  return track === car || (track === 'dual' && car !== 'monorail');
}

/** A port shared by paths of different gauges (a dual-gauge divergence's common end) is dual. */
export function portGauge(a: Gauge, b: Gauge): Gauge {
  return a === b ? a : a === 'monorail' || b === 'monorail' ? a : 'dual';
}
