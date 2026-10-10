import type { RoutePiece } from '../../project';
import { NARROW_TRACK } from '../../gauges';
import { paramValue } from '../composite';
import { arc, origin } from '../geometry';
import type { ParamSpec, PieceDefinition, ShapePoint } from '../types';
import { DEG, PRINTED_COLOR, compositePiece, levelTrack, studs } from './composite-piece';
import type { TrackKind } from './kinds';
import { solveSBend } from './sbend';
import { sectorDeck, sectorGeometry, sectorTrack } from './tables';

/**
 * Experimental gauges (Wave 5). Narrow gauge is the official 2009 narrow system TrixBrix extended: 3 studs (24 mm)
 * between rail centres on 6-stud sleepers, radii R24–R96 (16 per circle up to R48, as TrixBrix) and 12-stud parallel
 * spacing. Dual gauge is standard track with the narrow rails centred inside it (4 rails); its ends are standard ends,
 * so it joins standard track and, through the shared central clip, narrow track.
 */
export const NARROW_CAUTION = 'Narrow gauge (24 mm): runs narrow-gauge cars only; its ends clip to narrow and dual track, not 85976 narrow track.';
export const DUAL_CAUTION = 'Dual gauge: standard and narrow cars both run on it; narrow rails stop where it meets standard track.';
const group = 'experimental' as const;

export const NARROW_STRAIGHT = compositePiece({
  family: 'narrow_straight', label: 'Narrow straight', curved: false, gauge: 'narrow', group,
  params: [{ key: 'length', label: 'Length', unit: 'mm', min: 24, max: 2000, step: 8, default: 128 }],
  track: ({ length }) => levelTrack([{ len: length, k0: 0, k1: 0 }]),
  description: ({ length }) => `${studs(length)} studs · 24 mm gauge`
});

export const NARROW_CURVE = compositePiece({
  family: 'narrow_curve', label: 'Narrow curve', curved: true, gauge: 'narrow', group,
  params: [
    { key: 'radius', label: 'Radius', unit: 'mm', min: 192, max: 768, step: 8, default: 192,
      options: [24, 36, 48, 72, 84, 96].map(radius => ({ value: radius * 8, label: `R${radius}` })) },
    // 22.5° matches TrixBrix narrow curves; 45° is the official 85976 piece's turn.
    { key: 'sweep', label: 'Angle', unit: 'deg', min: -90, max: 90, step: 0.125, default: 22.5 }
  ],
  track: ({ radius, sweep }) => {
    const curvature = Math.sign(sweep) / radius;
    return levelTrack([{ len: radius * Math.abs(sweep) * DEG, k0: curvature, k1: curvature }]);
  },
  description: ({ radius, sweep }) => `R${studs(radius)} · ${Math.abs(sweep)}° · narrow`,
  signed: 'sweep',
  reverseParams: values => ({ ...values, sweep: -values.sweep })
});

/** Default: one 12-stud parallel move over 36 studs, two R30 arcs (a 3-4-5 triple, grid exact). */
export const NARROW_SBEND = compositePiece({
  family: 'narrow_sbend', label: 'Narrow S-bend', curved: true, gauge: 'narrow', group,
  params: [
    { key: 'offset', label: 'Offset', unit: 'mm', min: -384, max: 384, step: 8, default: 96 },
    { key: 'length', label: 'Length', unit: 'mm', min: 64, max: 2000, step: 8, default: 288 }
  ],
  track: ({ offset, length }) => {
    const solved = solveSBend(length, offset);
    if (!solved || solved.radius < 192) return levelTrack([{ len: length, k0: 0, k1: 0 }]);
    const k = Math.sign(offset) / solved.radius, arc = solved.radius * solved.angle;
    return levelTrack([{ len: arc, k0: k, k1: k }, { len: arc, k0: -k, k1: -k }]);
  },
  description: ({ offset, length }) => {
    const solved = solveSBend(length, offset);
    return `${studs(Math.abs(offset))}-stud offset · ${studs(length)} long${solved ? ` · R${studs(solved.radius)}` : ''}`;
  },
  signed: 'offset',
  reverseParams: values => values
});

export const DUAL_STRAIGHT = compositePiece({
  family: 'dual_straight', label: 'Dual-gauge straight', curved: false, gauge: 'dual', group,
  params: [{ key: 'length', label: 'Length', unit: 'mm', min: 24, max: 2000, step: 8, default: 128 }],
  track: ({ length }) => levelTrack([{ len: length, k0: 0, k1: 0 }]),
  description: ({ length }) => `${studs(length)} studs · 4 rails`
});

export const DUAL_CURVE = compositePiece({
  family: 'dual_curve', label: 'Dual-gauge curve', curved: true, gauge: 'dual', group,
  params: [
    { key: 'radius', label: 'Radius', unit: 'mm', min: 320, max: 1472, step: 8, default: 320 },
    { key: 'sweep', label: 'Angle', unit: 'deg', min: -90, max: 90, step: 0.125, default: 22.5 }
  ],
  track: ({ radius, sweep }) => {
    const curvature = Math.sign(sweep) / radius;
    return levelTrack([{ len: radius * Math.abs(sweep) * DEG, k0: curvature, k1: curvature }]);
  },
  description: ({ radius, sweep }) => `R${studs(radius)} · ${Math.abs(sweep)}° · 4 rails`,
  signed: 'sweep',
  reverseParams: values => ({ ...values, sweep: -values.sweep })
});

// ------------------------------------------------------------------ junctions (cad/models/gauge_junctions.py)

/**
 * Narrow-gauge point blades do not fit 24 mm gauge (gauge_junctions.py), so the narrow switch is a stub switch: the
 * sector plate on the narrow profile with a 24-stud deck and two tracks 11.25° apart (5.625° kink at the pivot).
 */
const STUB = sectorGeometry(192, 2, NARROW_TRACK.bodyWidth / 2);
export const NARROW_STUB_SWITCH: PieceDefinition = {
  family: 'narrow_stub_switch', label: 'Narrow stub switch', group, source: 'printed', styles: ['detailed'],
  params: [], gauge: 'narrow', body: 'assembly', customJoiner: false, color: PRINTED_COLOR,
  description: () => `${studs(STUB.deck)}-stud deck · 2 tracks · ${(STUB.step / DEG).toFixed(2)}° apart`,
  ...sectorDeck(() => STUB, track => `The stub switch is set to track ${track}.`),
  notes: ['Swing the deck by hand to a track; magnets hold it there and a drop-in dowel pin locks it.',
    'The deck kinks 5.625° at its pivot; the far ends are off the stud grid, so join them with Close gap.'],
  cad: piece => [{ family: 'narrow_stub_switch', parameters: { deck: STUB.deck, switch_state: sectorTrack(piece, STUB.tracks) } }]
};

/** Mirrors gauge_junctions.py: standard main 152 mm (19 studs) straight; the narrow branch leaves on R24 through 45°. */
export const DIVERGENCE = { main: 152, radius: 192, turn: 45 } as const;
const HAND: ParamSpec = { key: 'hand', label: 'Narrow branch', unit: '', min: -1, max: 1, step: 2, default: 1,
  options: [{ value: 1, label: 'Left' }, { value: -1, label: 'Right' }] };
const divergenceHand = (piece: RoutePiece) => paramValue(DUAL_DIVERGENCE, piece, 'hand') < 0 ? -1 : 1;
export const DUAL_DIVERGENCE: PieceDefinition = {
  family: 'dual_divergence', label: 'Dual-gauge divergence', group, source: 'printed', styles: ['detailed', 'fast'],
  params: [HAND], gauge: 'dual', body: 'assembly', handed: true, customJoiner: false, color: PRINTED_COLOR,
  description: piece => `${studs(DIVERGENCE.main)} studs · narrow R${studs(DIVERGENCE.radius)} ${DIVERGENCE.turn}° ${divergenceHand(piece) > 0 ? 'left' : 'right'}`,
  // Fixed, no states: Test drive takes the path of the train's gauge (standard straight on, narrow off to the branch).
  paths: piece => {
    const branch: ShapePoint[] = [origin()];
    arc(branch, DIVERGENCE.radius, divergenceHand(piece) * DIVERGENCE.turn * DEG);
    return [{ id: 'main', from: 'in', to: 'out', gauge: 'standard', points: [origin(), { x: DIVERGENCE.main, y: 0, z: 0, heading: 0 }] },
      { id: 'branch', from: 'in', to: 'branch', gauge: 'narrow', points: branch }];
  },
  run: () => DIVERGENCE.main,
  flip: params => ({ ...params, hand: -(params.hand ?? 1) }),
  notes: ['Standard trains run straight through; narrow-gauge trains take the branch across the outer standard rail.',
    'One printed part, no moving parts: keep the frog gaps and flangeways free of support and stringing.'],
  cad: piece => [{ family: 'dual_divergence', parameters: { hand: divergenceHand(piece) } }]
};

export const GAUGE_TRACK_FAMILIES = [NARROW_STRAIGHT, NARROW_CURVE, NARROW_SBEND, DUAL_STRAIGHT, DUAL_CURVE, NARROW_STUB_SWITCH, DUAL_DIVERGENCE]
  .map(definition => ({ ...definition, caution: definition.gauge === 'narrow' ? NARROW_CAUTION : DUAL_CAUTION }));

/**
 * Dual ends mate standard and narrow ends alike, so the gauge adapter is a palette preset, not a new part: a 64 mm
 * dual-gauge straight. The chip only says which track it leads on to.
 */
export const GAUGE_ADAPTER_KIND: TrackKind = {
  id: 'gauge_adapter', label: 'Gauge adapter', group, families: [],
  rows: [{ label: 'Joins', match: ['to'], choices: [
    { label: 'Dual → narrow', values: { to: 1 }, title: 'Dual-gauge track on to narrow track' },
    { label: 'Dual → standard', values: { to: 0 }, title: 'Dual-gauge track on to standard track' }] }],
  initial: { to: 1 },
  values: () => ({ to: 1 }),
  shape: (_, source, customJoiner = false) => source === 'owned' || customJoiner ? null : { family: DUAL_STRAIGHT.family, params: { length: 64 } },
  problem: () => null,
  caution: () => DUAL_CAUTION,
  describe: ({ to }) => `64 mm dual-gauge straight → ${to ? 'narrow' : 'standard'}`
};
