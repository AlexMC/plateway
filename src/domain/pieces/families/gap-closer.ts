import type { RoutePiece } from '../../project';
import { levelTrack, minRadius } from '../../solver/gap';
import { COMPOSITE_FAMILY, compositeCentreline, compositeLength, compositeParameters, paramValue } from '../composite';
import type { CompositeTrack, ParamSpec, PieceDefinition, TrackSegment } from '../types';

export const GAP_CLOSER_FAMILY = 'gap_closer';
/** As many segments as `composite_track` takes. */
const MAX_SEGMENTS = 8, MAX_CURVATURE = 1 / 176;
/** The solved path, stored as hidden params: the piece is made to measure and never edited by hand. */
const PARAMS: readonly ParamSpec[] = [
  { key: 'segments', label: 'Segments', unit: 'count', min: 1, max: MAX_SEGMENTS, step: 1, default: 1, hidden: true },
  ...Array.from({ length: MAX_SEGMENTS }, (_, index): ParamSpec[] => [
    { key: `s${index}_len`, label: `Segment ${index + 1} length`, unit: 'mm', min: 0, max: 2000, step: 0.001, default: index ? 0 : 128, hidden: true },
    { key: `s${index}_k0`, label: `Segment ${index + 1} start curvature`, unit: '', min: -MAX_CURVATURE, max: MAX_CURVATURE, step: 1e-6, default: 0, hidden: true },
    { key: `s${index}_k1`, label: `Segment ${index + 1} end curvature`, unit: '', min: -MAX_CURVATURE, max: MAX_CURVATURE, step: 1e-6, default: 0, hidden: true }
  ]).flat()
];

/** Params for a gap closer laid along `segments`. */
export function gapCloserParams(segments: readonly TrackSegment[]): Record<string, number> {
  if (!segments.length || segments.length > MAX_SEGMENTS) throw new Error(`A gap closer has 1 to ${MAX_SEGMENTS} segments.`);
  return { segments: segments.length, ...Object.fromEntries(segments.flatMap((segment, index) =>
    [[`s${index}_len`, segment.len], [`s${index}_k0`, segment.k0], [`s${index}_k1`, segment.k1]])) };
}
function gapCloserTrack(piece: RoutePiece): CompositeTrack {
  const value = (key: string) => paramValue({ params: PARAMS }, piece, key);
  return levelTrack(Array.from({ length: value('segments') }, (_, index) =>
    ({ len: value(`s${index}_len`), k0: value(`s${index}_k0`), k1: value(`s${index}_k1`) })));
}

/** Printed track solved to join two open ends exactly (src/domain/solver/gap.ts); placed by Close gap, never from the palette. */
export const GAP_CLOSER: PieceDefinition = {
  family: GAP_CLOSER_FAMILY, label: 'Gap closer', group: 'track', source: 'printed',
  description: piece => {
    const track = gapCloserTrack(piece), radius = minRadius(track.segments);
    return `${Math.round(compositeLength(track))} mm${Number.isFinite(radius) ? ` · R${Math.round(radius)}` : ' straight'}`;
  },
  styles: ['detailed', 'fast'], params: PARAMS, gauge: 'standard', body: 'path', customJoiner: false, hidden: true, color: 0xe7a871,
  notes: ['Made to measure for this gap. Moving either end means closing the gap again.'],
  composite: gapCloserTrack,
  // The far end's view: segments in reverse order, each traversed backwards (curvature changes sign).
  reverseParams: params => {
    const count = params.segments ?? 1, reversed: Record<string, number> = { ...params };
    for (let index = 0; index < count; index++) {
      const from = count - 1 - index;
      reversed[`s${index}_len`] = params[`s${from}_len`] ?? (from ? 0 : 128);
      reversed[`s${index}_k0`] = -(params[`s${from}_k1`] ?? 0);
      reversed[`s${index}_k1`] = -(params[`s${from}_k0`] ?? 0);
    }
    return reversed;
  },
  run: piece => compositeLength(gapCloserTrack(piece)),
  paths: piece => [{ id: 'main', from: 'in', to: 'out', points: compositeCentreline(gapCloserTrack(piece)).map(({ station: _, ...point }) => point) }],
  cad: piece => [{ family: COMPOSITE_FAMILY, parameters: compositeParameters(gapCloserTrack(piece)) }]
};
