import type { RoutePiece } from '../../project';
import { COMPOSITE_FAMILY, compositeCentreline, compositeParameters, paramValue } from '../composite';
import type { CadPart, CompositeTrack, ParamSpec, PieceDefinition } from '../types';
import { levelTrack } from './composite-piece';

export const ROAD_TILE_FAMILY = 'road_tile';
const SIDE = [{ value: 0, label: 'Road' }, { value: 1, label: 'Next track' }];
const PARAMS: readonly ParamSpec[] = [
  { key: 'angle', label: 'Road', unit: 'deg', min: 45, max: 135, step: 45, default: 90,
    options: [{ value: 90, label: 'Square' }, { value: 45, label: '45° left' }, { value: 135, label: '45° right' }] },
  { key: 'left', label: 'Left side', unit: '', min: 0, max: 1, step: 1, default: 0, options: SIDE },
  { key: 'right', label: 'Right side', unit: '', min: 0, max: 1, step: 1, default: 0, options: SIDE }
];
const value = (piece: Pick<RoutePiece, 'params'>, key: string) => paramValue({ params: PARAMS }, piece as RoutePiece, key);
/** Street track long enough for a 16-stud (60304) road: 128 mm square across, 256 mm at 45°. */
const length = (piece: Pick<RoutePiece, 'params'>) => value(piece, 'angle') === 90 ? 128 : 256;
const track = (piece: Pick<RoutePiece, 'params'>): CompositeTrack => levelTrack([{ len: length(piece), k0: 0, k1: 0 }]);

/** Road tiles beside the track: an apron down to the road plates, or half the filler to a parallel track 16 studs away. */
function tiles(piece: Pick<RoutePiece, 'params'>): CadPart[] {
  const angle = value(piece, 'angle'), run = length(piece);
  return ([['left', 1], ['right', -1]] as const).flatMap(([key, side]) =>
    (angle === 90 ? [0] : [1, -1]).map(half => ({ family: ROAD_TILE_FAMILY,
      parameters: { run, angle, side, kind: value(piece, key), half } })));
}

/**
 * A road crossing the track flush with the rail tops, for 60304 road plates: street track under the road
 * plus loose road tiles on the baseplate either side. Double track at 16-stud spacing: set the facing sides to
 * Next track on both pieces; their fillers meet halfway.
 */
export const LEVEL_CROSSING: PieceDefinition = {
  family: 'level_crossing', label: 'Level crossing', group: 'scenic', source: 'printed', styles: ['detailed', 'fast'],
  params: PARAMS, gauge: 'standard', body: 'path', customJoiner: false, color: 0x8e8b86,
  description: piece => `${length(piece)} mm · road ${value(piece, 'angle') === 90 ? 'square' : '45°'}`,
  notes: ['For 60304 road plates: they meet the tiles’ outer edge.'],
  composite: track,
  run: length,
  // Swapping ends keeps the road; the sides trade places.
  reverseParams: params => ({ ...params, left: params.right ?? 0, right: params.left ?? 0 }),
  paths: piece => [{ id: 'main', from: 'in', to: 'out', points: compositeCentreline(track(piece)).map(({ station: _, ...point }) => point) }],
  cad: piece => [{ family: COMPOSITE_FAMILY, parameters: { ...compositeParameters(track(piece)), street: 1 } }, ...tiles(piece)]
};
