import type { RoutePiece } from '../../project';
import { COMPOSITE_FAMILY, compositeCentreline, compositeLength, compositeParameters, paramValue } from '../composite';
import type { CompositeTrack, Gauge, ParamSpec, PieceDefinition, PieceGroup, TrackSegment } from '../types';
import { BRACKET_PARAMS, hasMetalRails, trackOptionParams, withTrackOptions } from './track-options';

export const PRINTED_COLOR = 0xe7a871;
export type Values = Record<string, number>;
export const DEG = Math.PI / 180;
/** `composite_track` gauge option codes (cad/models/composite.py); standard omits the option. */
export const COMPOSITE_GAUGE = { narrow: 1, dual: 2 } as const;
/** Millimetres as studs (8 mm), for labels. */
export const studs = (mm: number) => Number((mm / 8).toFixed(2));

/** A level, uncanted plain track of these segments (zero-length segments dropped). */
export function levelTrack(segments: readonly TrackSegment[]): CompositeTrack {
  return { segments: segments.filter(segment => segment.len > 1e-9), z0: 0, z1: 0, grade0: 0, grade1: 0, cant0: 0, cant1: 0, vcurve: 0 };
}

/**
 * A printed plain-track family built as one `composite_track` (C2); fit splits it to the bed (C3).
 * `track` receives the shape parameters, defaults filled in; `signed` is the key whose sign is the hand (Flip negates it).
 * Every piece also carries the plain-track options (ballast, street, marker; guard rail when `curved`) and wall/shelf
 * brackets. `cadOptions` adds family-specific `composite_track` options (a helix piece's column socket);
 * `ownSupports` says the piece carries its own supports for these values (brackets always do).
 * `gauge` narrow or dual builds the `composite_track` gauge option (cad/models/gauge.py); those pieces offer ballast and
 * marker only (guard rail and street flangeways are where the other gauge's rails run; brackets seat standard ties).
 */
export function compositePiece({ family, label, params, curved, track, description, signed, reverseParams, color = PRINTED_COLOR,
  group = 'track', cadOptions, ownSupports, notes, gauge = 'standard' }: {
  family: string; label: string; params: readonly ParamSpec[]; curved: boolean;
  track(values: Values): CompositeTrack; description(values: Values): string;
  signed?: string; reverseParams?(values: Values): Values; color?: number;
  group?: PieceGroup; cadOptions?(values: Values): Values; ownSupports?(values: Values): boolean; notes?: readonly string[];
  gauge?: Exclude<Gauge, 'monorail'>;
}): PieceDefinition {
  const values = (piece: Pick<RoutePiece, 'params'>): Values =>
    Object.fromEntries(params.map(spec => [spec.key, paramValue({ params }, piece as RoutePiece, spec.key)]));
  // Pieces re-derive their track on every render; a small cache keeps solved shapes cheap.
  const cache = new Map<string, CompositeTrack>();
  const build = (piece: Pick<RoutePiece, 'params'>): CompositeTrack => {
    const all = values(piece), key = JSON.stringify(all);
    let built = cache.get(key);
    if (!built) {
      built = track(all);
      if (cache.size > 256) cache.clear();
      cache.set(key, built);
    }
    return built;
  };
  const defaults = (given: Values): Values => ({ ...values({ params: given }), ...given });
  const options = trackOptionParams(curved, gauge), markerAt = options.find(spec => spec.key === 'marker_s')!.default;
  const gaugeOption: Values = gauge === 'standard' ? {} : { gauge: COMPOSITE_GAUGE[gauge] };
  return {
    family, label, group, source: 'printed', styles: ['detailed', 'fast'],
    params: [...params, ...options, ...(gauge === 'standard' ? BRACKET_PARAMS : [])], gauge, body: 'path',
    customJoiner: false, color, ...(notes ? { notes } : {}),
    description: piece => description(values(piece)),
    composite: build,
    run: piece => compositeLength(build(piece)),
    paths: piece => [{ id: 'main', from: 'in', to: 'out', ...(hasMetalRails(piece) ? { electrical: true } : {}),
      points: compositeCentreline(build(piece)).map(({ station: _, ...point }) => point) }],
    cad: piece => withTrackOptions(piece, [{ family: COMPOSITE_FAMILY,
      parameters: { ...compositeParameters(build(piece)), ...cadOptions?.(values(piece)), ...gaugeOption } }]),
    ownSupports: piece => Boolean(piece.params?.bracket) || Boolean(ownSupports?.(values(piece))),
    // Authored from the far end, a colour marker keeps its tie (its station is measured from the other end) and the wall changes side.
    reverseParams: given => ({ ...given, ...reverseParams?.(defaults(given)),
      ...(given.marker_s === undefined && !given.marker ? {} :
        { marker_s: Math.max(0, compositeLength(build({ params: given })) - (given.marker_s ?? markerAt)) }),
      ...(given.bracket || given.bracket_side !== undefined ? { bracket_side: -(given.bracket_side ?? 1) } : {}) }),
    ...(signed ? { flip: given => ({ ...given, [signed]: -defaults(given)[signed] }) } : {})
  };
}
