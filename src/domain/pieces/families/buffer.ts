import type { RoutePiece } from '../../project';
import { paramValue } from '../composite';
import { origin } from '../geometry';
import type { ParamSpec, PieceDefinition } from '../types';

const PARAMS: readonly ParamSpec[] = [
  { key: 'length', label: 'Length', unit: 'mm', min: 32, max: 64, step: 32, default: 32,
    options: [{ value: 32, label: '32 mm' }, { value: 64, label: '64 mm' }] }
];
const length = (piece: RoutePiece) => paramValue({ params: PARAMS }, piece, 'length');

/**
 * End of track: a brick connector at `in`, a stop block at coupler height at the far end.
 * The far end stays the route's end for chaining, but its port mates nothing; handed, so it is never reversed.
 */
export const BUFFER_STOP: PieceDefinition = {
  family: 'buffer_stop', label: 'Buffer stop', group: 'scenic', source: 'printed', styles: ['detailed', 'fast'],
  params: PARAMS, gauge: 'standard', body: 'rail', handed: true, customJoiner: false, color: 0xc9463d,
  description: piece => `${length(piece)} mm`,
  notes: ['Ends the track: nothing joins its far end.'],
  run: length,
  end: piece => ({ x: length(piece), y: 0, z: 0, heading: 0 }),
  paths: piece => [{ id: 'main', from: 'in', to: 'out', stop: true, points: [origin(), { x: length(piece), y: 0, z: 0, heading: 0 }] }],
  cad: piece => [{ family: 'buffer_stop', parameters: { run: length(piece) } }]
};
