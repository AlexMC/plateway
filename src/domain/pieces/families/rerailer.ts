import type { RoutePiece } from '../../project';
import { paramValue } from '../composite';
import { origin } from '../geometry';
import type { ParamSpec, PieceDefinition } from '../types';

const PARAMS: readonly ParamSpec[] = [
  { key: 'length', label: 'Length', unit: 'mm', min: 64, max: 128, step: 64, default: 128,
    options: [{ value: 64, label: '64 mm' }, { value: 128, label: '128 mm' }] }
];
const length = (piece: RoutePiece) => paramValue({ params: PARAMS }, piece, 'length');

/** A straight with guide ramps that lift derailed wheels back onto the rails; works in both directions. */
export const RERAILER: PieceDefinition = {
  family: 'rerailer', label: 'Rerailer', group: 'scenic', source: 'printed', styles: ['detailed', 'fast'],
  params: PARAMS, gauge: 'standard', body: 'rail', customJoiner: false, color: 0xd9b44a,
  description: piece => `${length(piece)} mm`,
  notes: ['Push a derailed wagon slowly over it to put it back on.'],
  run: length,
  end: piece => ({ x: length(piece), y: 0, z: 0, heading: 0 }),
  paths: piece => [{ id: 'main', from: 'in', to: 'out', points: [origin(), { x: length(piece), y: 0, z: 0, heading: 0 }] }],
  cad: piece => [{ family: 'rerailer', parameters: { run: length(piece) } }]
};
