import type { RoutePiece } from '../../project';
import { BRICK_TRACK } from '../../track';
import { compositeCentreline, compositeLength, compositeParameters, paramValue } from '../composite';
import type { CompositeTrack, ParamSpec, PieceDefinition } from '../types';
import { levelTrack } from './composite-piece';

export const FLEX_TPU_FAMILY = 'flex_tpu_track';
/** Rail kerf at each hinge, straight (cad/models/flex_track.py KERF). */
export const FLEX_TPU_KERF = 2;
/** Tightest bend: the inner rail kerf closes when each 32 mm segment turns by kerf / (gauge / 2). */
export const FLEX_TPU_MIN_RADIUS = BRICK_TRACK.railGauge / 2 * BRICK_TRACK.tiePitch / FLEX_TPU_KERF;
const SECTIONS = 4;

/** 1–4 sections, each a length (whole 32 mm pitches) and a signed radius (+ left, 0 straight); later sections show once chosen. */
const PARAMS: readonly ParamSpec[] = [
  { key: 'sections', label: 'Sections', unit: 'count', min: 1, max: SECTIONS, step: 1, default: 2,
    options: Array.from({ length: SECTIONS }, (_, index) => ({ value: index + 1, label: String(index + 1) })) },
  ...Array.from({ length: SECTIONS }, (_, index): ParamSpec[] => {
    const when = { key: 'sections', values: Array.from({ length: SECTIONS - index }, (_, k) => index + 1 + k) };
    return [
      { key: `len${index + 1}`, label: `Section ${index + 1} length`, unit: 'mm', min: BRICK_TRACK.tiePitch, max: 480,
        step: BRICK_TRACK.tiePitch, default: 192, ...(index ? { when } : {}) },
      { key: `r${index + 1}`, label: `Section ${index + 1} radius (+ left, 0 straight)`, unit: 'mm', min: -2400, max: 2400,
        step: 8, default: index === 1 ? -480 : 480, ...(index ? { when } : {}) }
    ];
  }).flat()
];

const value = (piece: Pick<RoutePiece, 'params'>, key: string) => paramValue({ params: PARAMS }, piece as RoutePiece, key);
function sections(piece: Pick<RoutePiece, 'params'>): { len: number; radius: number }[] {
  const count = Math.min(SECTIONS, Math.max(1, Math.round(value(piece, 'sections'))));
  return Array.from({ length: count }, (_, index) => ({ len: value(piece, `len${index + 1}`), radius: value(piece, `r${index + 1}`) }));
}
/** The drawn centreline: one arc (or straight) per section. */
export function flexTpuTrack(piece: Pick<RoutePiece, 'params'>): CompositeTrack {
  return levelTrack(sections(piece).map(({ len, radius }) => {
    const k = radius ? 1 / radius : 0;
    return { len, k0: k, k1: k };
  }));
}
function tightest(piece: Pick<RoutePiece, 'params'>): number {
  return Math.min(...sections(piece).map(({ radius }) => radius ? Math.abs(radius) : Infinity));
}

/**
 * Flexible track (experimental): rigid PLA segments on a TPU spine, printed straight as one two-material strip per
 * bed-sized part and bent on site to the drawn shape. Fit splits it at tie stations by its STRAIGHT length.
 */
export const FLEX_TPU_TRACK: PieceDefinition = {
  family: FLEX_TPU_FAMILY, label: 'Flexible track (TPU)', group: 'experimental', source: 'printed',
  caution: `TPU springs back straight: clutch every sleeper to a baseplate; outer rail gaps open to ${2 * FLEX_TPU_KERF} mm at R${FLEX_TPU_MIN_RADIUS}.`,
  description: piece => {
    const radius = tightest(piece);
    return `${compositeLength(flexTpuTrack(piece))} mm · ${Number.isFinite(radius) ? `tightest R${radius}` : 'straight'}`;
  },
  styles: ['detailed', 'fast'], params: PARAMS, gauge: 'standard', body: 'path', customJoiner: false, color: 0x5fa8d3,
  notes: [`Prints straight in PLA with a TPU spine (AMS: TPU for AMS); bends to R${FLEX_TPU_MIN_RADIUS} mm.`],
  composite: flexTpuTrack,
  problem: piece => {
    const lengths = sections(piece).map(section => section.len);
    if (lengths.some(len => !(len > 0) || Math.abs(len / BRICK_TRACK.tiePitch - Math.round(len / BRICK_TRACK.tiePitch)) > 1e-9))
      return `Flexible track sections are whole ${BRICK_TRACK.tiePitch} mm sleeper pitches long.`;
    const radius = tightest(piece);
    return radius < FLEX_TPU_MIN_RADIUS - 1e-9
      ? `R${radius} is tighter than flexible track bends: its rail kerfs close at R${FLEX_TPU_MIN_RADIUS}.` : null;
  },
  // From the far end: sections in reverse order, each turning the other way.
  reverseParams: params => {
    const count = Math.min(SECTIONS, Math.max(1, Math.round(params.sections ?? 2))), reversed: Record<string, number> = { ...params };
    for (let index = 0; index < count; index++) {
      const from = count - index;
      reversed[`len${index + 1}`] = value({ params }, `len${from}`);
      reversed[`r${index + 1}`] = -value({ params }, `r${from}`);
    }
    return reversed;
  },
  flip: params => ({ ...params, ...Object.fromEntries(Array.from({ length: SECTIONS }, (_, index) =>
    [`r${index + 1}`, -value({ params }, `r${index + 1}`)])) }),
  run: piece => compositeLength(flexTpuTrack(piece)),
  paths: piece => [{ id: 'main', from: 'in', to: 'out', points: compositeCentreline(flexTpuTrack(piece)).map(({ station: _, ...point }) => point) }],
  cad: piece => [{ family: FLEX_TPU_FAMILY, parameters: compositeParameters(flexTpuTrack(piece)) }]
};
